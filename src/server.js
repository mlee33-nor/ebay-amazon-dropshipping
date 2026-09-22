import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDb, dbKind, q, one, getSetting, setSetting } from './db.js';
import { syncEbay, ebayStatus, ebayConfigured, ebayCanConnect, ebayConsentUrl, ebayConnectWithCode, loadEbayConnection } from './ebay.js';
import { importAmazonCsv } from './amazon.js';
import { runMatcher, getSuggestions } from './matcher.js';
import { buildDataset, buildBooks } from './dataset.js';
import { isLedgerCsv, importLedgerCsv, matchLedger } from './ledger.js';
import { syncEmail, emailStatus, emailConfigured, ingestMessage } from './email.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
app.use(express.json({ limit: '10mb' }));

// ---------- auth (single shared password) ----------
const PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update(`dd:${PASSWORD}`).digest('hex');
const sessionValue = () => crypto.createHmac('sha256', SECRET).update('ok').digest('hex');
const readCookie = (req, name) =>
  (req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).find(([k]) => k === name)?.[1];

app.post('/api/login', (req, res) => {
  const given = String(req.body?.password || '');
  const ok = PASSWORD && given.length === PASSWORD.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(PASSWORD));
  if (!ok) return res.status(401).json({ error: 'Wrong password' });
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `dd_session=${sessionValue()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 60}${secure}`);
  res.json({ ok: true });
});
// Inbound email webhook (Zapier / Make / Google Apps Script): POST JSON {subject, text, html, date, messageId}
// or an array of them, with header "x-inbound-token: <INBOUND_TOKEN>". Uses the same parser + dedupe as IMAP.
app.post('/api/email/inbound', async (req, res) => {
  const token = process.env.INBOUND_TOKEN;
  const given = String(req.headers['x-inbound-token'] || req.query.token || '');
  if (!token || given.length !== token.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token)))
    return res.status(401).json({ error: 'Bad or missing inbound token' });
  try {
    const items = Array.isArray(req.body) ? req.body : [req.body];
    const results = [];
    for (const m of items) results.push(await ingestMessage(m || {}));
    const match = await runMatcher();
    res.json({ ok: true, results, newLinks: match.linked });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});
app.get('/login', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'login.html')));
app.use((req, res, next) => {
  if (!PASSWORD) return next();
  if (req.path === '/login' || req.path.startsWith('/css/') || req.path === '/favicon.svg') return next();
  if (readCookie(req, 'dd_session') === sessionValue()) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not logged in' });
  res.redirect('/login');
});

app.use(express.static(path.join(__dirname, '..', 'public')));

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    console.error(e);
    res.status(e.status || 500).json({ error: e.message });
  });

// ---------- data ----------
app.get('/api/data', wrap(async (_req, res) => {
  const [orders, status, amazonStats, settings, suggestions, email, books] = await Promise.all([
    buildDataset(),
    ebayStatus(),
    one(`select count(distinct amazon_order_id)::int as orders,
                count(distinct amazon_order_id) filter (where amazon_order_id in (select amazon_order_id from order_links))::int as linked,
                count(*)::int as lines, max(order_date) as latest
         from amazon_lines`),
    getAllSettings(),
    runMatcherSuggestionsCount(),
    emailStatus(),
    buildBooks(),
  ]);
  res.json({ orders, ebay: status, email, amazon: { ...amazonStats, suggestions }, settings, books, db: dbKind() });
}));

async function runMatcherSuggestionsCount() {
  try { return (await getSuggestions(1000)).length; } catch { return 0; }
}

async function getAllSettings() {
  return {
    home_zips: (await getSetting('home_zips')) || [],
    monthly_goal: (await getSetting('monthly_goal')) || 0,
    partner_amazon: (await getSetting('partner_amazon')) || 'Myles',
    partner_ebay: (await getSetting('partner_ebay')) || 'Drew',
    split_amazon: (await getSetting('split_amazon')) ?? 50,
  };
}

app.get('/api/amazon', wrap(async (req, res) => {
  const rows = await q(
    `select l.line_key, l.amazon_order_id, l.order_date, l.asin, l.title, l.quantity, l.line_total, l.cost_override,
            l.ignored, l.ship_name, l.ship_zip, l.ship_state, l.order_status, l.tracking, l.first_import, l.last_import,
            k.ebay_order_id, k.method as link_method, k.reasons as link_reasons
     from amazon_lines l left join order_links k on k.amazon_order_id = l.amazon_order_id
     order by l.order_date desc nulls last, l.amazon_order_id`
  );
  res.json(rows);
}));

app.get('/api/suggestions', wrap(async (_req, res) => res.json(await getSuggestions())));

app.get('/api/imports', wrap(async (_req, res) => res.json(await q('select * from amazon_imports order by id desc limit 100'))));

// ---------- amazon csv ----------
app.post('/api/amazon/import', upload.array('files', 20), wrap(async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'No file uploaded' });
  const results = [];
  for (const f of req.files) {
    const r = isLedgerCsv(f.buffer) ? await importLedgerCsv(f.buffer, f.originalname) : { kind: 'amazon', ...(await importAmazonCsv(f.buffer, f.originalname)) };
    results.push({ filename: f.originalname, ...r });
  }
  res.json(results);
}));

// ---------- editor saves ----------
const OVERRIDE_FIELDS = ['cost_override', 'extra_cost', 'amazon_refund', 'fee_override', 'refund_override', 'notes', 'excluded'];

app.post('/api/overrides', wrap(async (req, res) => {
  const changes = req.body?.changes || [];
  for (const c of changes) {
    const fields = Object.keys(c).filter((k) => OVERRIDE_FIELDS.includes(k));
    if (!c.order_id || !fields.length) continue;
    const vals = fields.map((f) => (c[f] === '' ? null : c[f]));
    await q(
      `insert into order_overrides (order_id, ${fields.join(', ')}, updated_at)
       values ($1, ${fields.map((_, i) => `$${i + 2}`).join(', ')}, now())
       on conflict (order_id) do update set ${fields.map((f) => `${f} = excluded.${f}`).join(', ')}, updated_at = now()`,
      [c.order_id, ...vals]
    );
  }
  res.json({ ok: true, saved: changes.length });
}));

app.post('/api/amazon/lines', wrap(async (req, res) => {
  const changes = req.body?.changes || [];
  for (const c of changes) {
    if (!c.line_key) continue;
    if ('cost_override' in c)
      await q('update amazon_lines set cost_override = $2, updated_at = now() where line_key = $1', [c.line_key, c.cost_override === '' ? null : c.cost_override]);
    if ('ignored' in c) await q('update amazon_lines set ignored = $2, updated_at = now() where line_key = $1', [c.line_key, Boolean(c.ignored)]);
  }
  res.json({ ok: true });
}));

app.post('/api/links', wrap(async (req, res) => {
  const { amazon_order_id, ebay_order_id } = req.body || {};
  if (!amazon_order_id) return res.status(400).json({ error: 'amazon_order_id required' });
  if (!ebay_order_id) {
    const prev = await one('select ebay_order_id from order_links where amazon_order_id = $1', [amazon_order_id]);
    if (prev)
      await q('insert into link_rejections (amazon_order_id, ebay_order_id) values ($1,$2) on conflict do nothing', [amazon_order_id, prev.ebay_order_id]);
    await q('delete from order_links where amazon_order_id = $1', [amazon_order_id]);
    return res.json({ ok: true, unlinked: true });
  }
  const eb = await one('select order_id from ebay_orders where order_id = $1', [ebay_order_id]);
  if (!eb) return res.status(404).json({ error: `No eBay order ${ebay_order_id}` });
  const az = await one('select 1 from amazon_lines where amazon_order_id = $1 limit 1', [amazon_order_id]);
  if (!az) return res.status(404).json({ error: `No Amazon order ${amazon_order_id}` });
  await q(
    `insert into order_links (amazon_order_id, ebay_order_id, method, score, reasons) values ($1,$2,'manual',null,'linked by hand')
     on conflict (amazon_order_id) do update set ebay_order_id = excluded.ebay_order_id, method = 'manual', reasons = 'linked by hand'`,
    [amazon_order_id, ebay_order_id]
  );
  await q('delete from link_rejections where amazon_order_id = $1 and ebay_order_id = $2', [amazon_order_id, ebay_order_id]);
  res.json({ ok: true });
}));

app.post('/api/links/reject', wrap(async (req, res) => {
  const { amazon_order_id, ebay_order_id, ignore_amazon } = req.body || {};
  if (ignore_amazon) await q('update amazon_lines set ignored = true where amazon_order_id = $1', [amazon_order_id]);
  else await q('insert into link_rejections (amazon_order_id, ebay_order_id) values ($1,$2) on conflict do nothing', [amazon_order_id, ebay_order_id]);
  res.json({ ok: true });
}));

// ---------- settings / sync ----------
app.post('/api/settings', wrap(async (req, res) => {
  const b = req.body || {};
  if ('home_zips' in b) await setSetting('home_zips', (b.home_zips || []).map((z) => String(z).trim().slice(0, 5)).filter(Boolean));
  if ('monthly_goal' in b) await setSetting('monthly_goal', Number(b.monthly_goal) || 0);
  if ('partner_amazon' in b) await setSetting('partner_amazon', String(b.partner_amazon || 'Partner A').slice(0, 40));
  if ('partner_ebay' in b) await setSetting('partner_ebay', String(b.partner_ebay || 'Partner B').slice(0, 40));
  if ('split_amazon' in b) await setSetting('split_amazon', Math.min(100, Math.max(0, Number(b.split_amazon) || 0)));
  await runMatcher();
  res.json({ ok: true, settings: await getAllSettings() });
}));

app.post('/api/sync', wrap(async (_req, res) => res.json(await syncEbay())));

// ---------- Connect eBay (OAuth authorization-code flow) ----------
// eBay Developer portal -> User Tokens -> "Get a Token from eBay via Your Application" -> add a RuName whose
// "Your auth accepted URL" is https://<this app>/api/ebay/callback, then set EBAY_RUNAME to that RuName.
app.get('/api/ebay/connect', wrap(async (_req, res) => {
  if (!ebayCanConnect()) return res.status(400).send('Set EBAY_CLIENT_ID, EBAY_CLIENT_SECRET and EBAY_RUNAME first.');
  const state = crypto.randomBytes(16).toString('hex');
  await setSetting('ebay_oauth_state', { state, at: Date.now() });
  res.redirect(ebayConsentUrl(state));
}));
app.get('/api/ebay/callback', wrap(async (req, res) => {
  const saved = await getSetting('ebay_oauth_state');
  if (req.query.error) return res.redirect(`/#/settings?ebay=${encodeURIComponent(String(req.query.error_description || req.query.error))}`);
  if (!saved || saved.state !== req.query.state || Date.now() - saved.at > 15 * 60_000)
    return res.redirect('/#/settings?ebay=Connection+link+expired%2C+click+Connect+eBay+again');
  await ebayConnectWithCode(String(req.query.code || ''));
  await setSetting('ebay_oauth_state', null);
  syncEbay().catch((err) => console.error('first eBay sync failed', err));
  res.redirect('/#/settings?ebay=connected');
}));

// ---------- books: operating expenses, settlements, ledger links ----------
app.post('/api/expenses', wrap(async (req, res) => {
  for (const c of req.body?.changes || []) {
    if (c._delete && c.id) { await q('delete from expenses where id = $1', [c.id]); continue; }
    if (!/^\d{4}-\d{2}$/.test(c.month || '') || !String(c.category || '').trim()) continue;
    const vals = [c.month, String(c.category).trim(), Number(c.amount) || 0, c.note || null, c.paid_by === 'amazon' ? 'amazon' : 'seller'];
    if (c.id) await q('update expenses set month=$2, category=$3, amount=$4, note=$5, paid_by=$6, updated_at=now() where id=$1', [c.id, ...vals]);
    else await q(`insert into expenses (month, category, amount, note, paid_by) values ($1,$2,$3,$4,$5)
                  on conflict (month, category) do update set amount=excluded.amount, note=excluded.note, paid_by=excluded.paid_by, updated_at=now()`, vals);
  }
  res.json({ ok: true, ...(await buildBooks()) });
}));
app.post('/api/settlements', wrap(async (req, res) => {
  const { month, paid, paid_at, note } = req.body || {};
  if (!/^\d{4}-\d{2}$/.test(month || '')) return res.status(400).json({ error: 'month must be YYYY-MM' });
  await q(`insert into settlements (month, paid, paid_at, note) values ($1,$2,$3,$4)
           on conflict (month) do update set paid=excluded.paid, paid_at=excluded.paid_at, note=excluded.note, updated_at=now()`,
    [month, paid === '' || paid === null || paid === undefined ? null : Number(paid), paid_at || null, note || null]);
  res.json({ ok: true, ...(await buildBooks()) });
}));
app.post('/api/ledger/link', wrap(async (req, res) => {
  const { entry_key, ebay_order_id } = req.body || {};
  if (ebay_order_id && !(await one('select 1 from ebay_orders where order_id = $1', [ebay_order_id])))
    return res.status(404).json({ error: `No eBay order ${ebay_order_id}` });
  await q('update ledger_entries set ebay_order_id = $2, match_method = $3 where entry_key = $1', [entry_key, ebay_order_id || null, ebay_order_id ? 'manual' : null]);
  res.json({ ok: true });
}));
app.post('/api/email/sync', wrap(async (_req, res) => res.json(await syncEmail())));
app.get('/api/email/log', wrap(async (_req, res) =>
  res.json(await q('select message_id, received_at, subject, kind, order_ids, ok, note from amazon_emails order by received_at desc nulls last limit 60'))));
app.post('/api/rematch', wrap(async (_req, res) => res.json(await runMatcher())));
app.get('/api/sync-log', wrap(async (_req, res) => res.json(await q('select * from sync_log order by id desc limit 30'))));

app.post('/api/demo/clear', wrap(async (_req, res) => {
  await q("delete from order_links where ebay_order_id like 'DEMO-%' or amazon_order_id like 'DEMO-%'");
  await q("delete from link_rejections where ebay_order_id like 'DEMO-%' or amazon_order_id like 'DEMO-%'");
  await q("delete from order_overrides where order_id like 'DEMO-%'");
  await q("delete from ebay_returns where order_id like 'DEMO-%'");
  await q("delete from ebay_orders where order_id like 'DEMO-%'");
  await q("delete from amazon_lines where amazon_order_id like 'DEMO-%'");
  await q("delete from amazon_imports where filename like 'demo-%'");
  res.json({ ok: true });
}));

app.get('/api/health', (_req, res) => res.json({ ok: true }));

const port = Number(process.env.PORT || 3000);
const kind = await initDb();
await loadEbayConnection();
app.listen(port, () => {
  console.log(`Dropship dashboard on http://localhost:${port}  (db: ${kind}${PASSWORD ? ', password on' : ', NO PASSWORD'})`);
});

// Background eBay sync
const every = Number(process.env.SYNC_INTERVAL_MINUTES || 30);
// Always scheduled; each tick checks whether eBay is connected, so connecting in the UI starts syncing without a restart
if (every > 0) {
  const tick = () => {
    if (!ebayConfigured()) return;
    syncEbay().then((r) => console.log('eBay sync:', r.log.join(' | '))).catch((e) => console.error('eBay sync error', e));
  };
  setTimeout(tick, 5_000);
  setInterval(tick, every * 60_000);
}
if (!ebayConfigured()) console.log('eBay not connected yet: set EBAY_CLIENT_ID / EBAY_CLIENT_SECRET / EBAY_RUNAME, then Settings -> Connect eBay');
if (emailConfigured() && every > 0) {
  const tickMail = () => syncEmail().then((r) => console.log('Email sync:', r.log.join(' | '))).catch((e) => console.error('Email sync error', e));
  setTimeout(tickMail, 15_000);
  setInterval(tickMail, every * 60_000);
}

const shutdown = async () => {
  const { closeDb } = await import('./db.js');
  await closeDb().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
