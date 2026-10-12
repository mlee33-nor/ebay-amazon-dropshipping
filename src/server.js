import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDb, dbKind, q, one, getSetting, setSetting, withTransaction, MAIN, withAccount, currentAccount, hasAccount, accountIds, listAccounts, createAccount, renameAccount } from './db.js';
import { syncEbay, ebayStatus, ebayConfigured, ebayCanConnect, ebayConsentUrl, ebayConnectWithCode, loadEbayConnection } from './ebay.js';
import { importAmazonCsv } from './amazon.js';
import { runMatcher, getSuggestions, candidatesForSale } from './matcher.js';
import { buildDataset, buildBooks, rowCents } from './dataset.js';
import { isLedgerCsv, importLedgerCsv, matchLedger, parseLedgerCsv } from './ledger.js';
import { checkSheet } from './sheetcheck.js';
import { businessDay } from './time.js';
import { settleMonth, CYCLE_START } from '../public/js/settlement.js';
import { syncEmail, emailStatus, emailConfigured, ingestMessage, reprocessEmail, dismissFailedEmail } from './email.js';
import { ask } from './ask.js';
import { routeQuestion, writeAnswer, llmConfigured, checkModel } from './llm.js';
import { syncListings, listingAnalytics, zeroViewListings } from './listings.js';
import { promotionAnalytics, unpromotedListings } from './promotions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
app.use(express.json({ limit: '10mb' }));

// ---------- auth (single shared password) ----------
const PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update(`dd:${PASSWORD}`).digest('hex');
// Equal-length digests, so comparing never throws (timingSafeEqual throws on different byte lengths)
const sameSecret = (a, b) => crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a)).digest(), crypto.createHash('sha256').update(String(b)).digest());
const SESSION_DAYS = 30;
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('hex');
// A session is '<expiry ms>.<signature>': it ends after SESSION_DAYS, and can't be forged without SESSION_SECRET
const newSession = () => { const exp = String(Date.now() + SESSION_DAYS * 86400_000); return `${exp}.${sign(exp)}`; };
const validSession = (v) => { const [exp, sig] = String(v || '').split('.'); return Boolean(exp && sig && Number(exp) > Date.now() && sameSecret(sig, sign(exp))); };
// Wrong-password attempts per address: 10 per 15 minutes, then locked out until the window passes
const attempts = new Map();
const tooMany = (ip) => { const a = attempts.get(ip); return Boolean(a && a.until > Date.now() && a.n >= 10); };
const failed = (ip) => { const a = attempts.get(ip); if (!a || a.until < Date.now()) attempts.set(ip, { n: 1, until: Date.now() + 15 * 60_000 }); else a.n++; };
const readCookie = (req, name) =>
  (req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).find(([k]) => k === name)?.[1];

app.post('/api/login', (req, res) => {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (tooMany(ip)) return res.status(429).json({ error: 'Too many wrong passwords. Try again in 15 minutes.' });
  const given = String(req.body?.password || '');
  const ok = Boolean(PASSWORD) && sameSecret(given, PASSWORD);
  if (!ok) { failed(ip); return res.status(401).json({ error: 'Wrong password' }); }
  attempts.delete(ip);
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `dd_session=${newSession()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * SESSION_DAYS}${secure}`);
  res.json({ ok: true });
});
// Inbound email webhook (Zapier / Make / Google Apps Script): POST JSON {subject, text, html, date, messageId}
// or an array of them, with header "x-inbound-token: <INBOUND_TOKEN>". Uses the same parser + dedupe as IMAP.
app.post('/api/email/inbound', async (req, res) => {
  const token = process.env.INBOUND_TOKEN;
  const given = String(req.headers['x-inbound-token'] || req.query.token || '');
  if (!token || !sameSecret(given, token))
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
// Accounting data must never be open on the internet: in production, no password means no access
const PRODUCTION = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === 'production');
app.use((req, res, next) => {
  if (req.path === '/api/health') return next(); // Railway's health check, no data in it
  if (!PASSWORD && PRODUCTION) return res.status(503).send('DASHBOARD_PASSWORD is not set. Add it in Railway -> Variables.');
  if (!PASSWORD) return next();
  if (req.path === '/login' || req.path.startsWith('/css/') || req.path === '/favicon.svg') return next();
  if (validSession(readCookie(req, 'dd_session'))) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not logged in' });
  res.redirect('/login');
});

// Browsers check for a newer copy every time (a quick 304 when nothing changed), so a deploy shows up on the next load
app.use(express.static(path.join(__dirname, '..', 'public'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

// Which account (eBay store) a request is about: the X-Account header the pages send, or ?account= on a link (Connect
// eBay). "all" (ENTIRE BUSINESS) is read-only: it only loads the combined data; anything that changes money or
// connections is done on one account.
app.use('/api', (req, res, next) => {
  const id = String(req.headers['x-account'] || req.query.account || MAIN);
  if (id === 'all') {
    if (req.method === 'GET' && (req.path === '/data' || req.path === '/accounts')) { req.allAccounts = true; req.account = MAIN; return withAccount(MAIN, next); }
    return res.status(400).json({ error: 'ENTIRE BUSINESS is a combined view. Pick one account at the top left to do this.' });
  }
  if (!hasAccount(id)) return res.status(400).json({ error: `Unknown account: ${id}` });
  req.account = id;
  withAccount(id, next);
});

// Every manual change to money is logged: what, when, before and after, and from where
async function logMoney(req, action, subject, before, after, run = q) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
  await run('insert into money_log (action, subject, before, after, ip, agent) values ($1, $2, $3::jsonb, $4::jsonb, $5, $6)',
    [action, subject == null ? null : String(subject), before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after), ip.slice(0, 80), String(req.headers['user-agent'] || '').slice(0, 200)]);
}
// A money amount typed or pasted by a person: "$16.19", "1,234.50", "(12.50)" = -12.50. Blank = null; junk = NaN.
const parseAmount = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  let t = String(v).trim();
  if (!t) return null;
  const neg = /^\(.*\)$/.test(t) || t.startsWith('-');
  t = t.replace(/[()$,\s-]/g, '');
  if (!/^\d*\.?\d+$/.test(t)) return NaN;
  return (neg ? -1 : 1) * Number(t);
};

// Each handler runs in its request's account again (an upload's stream callbacks can lose the request context)
const wrap = (fn) => (req, res) =>
  withAccount(req.account || MAIN, () => fn(req, res)).catch((e) => {
    console.error(e);
    res.status(e.status || 500).json({ error: e.message });
  });

// ---------- data ----------
app.get('/api/data', wrap(async (req, res) => {
  const accounts = await listAccounts();
  if (!req.allAccounts) return res.json({ ...(await accountData()), account: accounts.find((a) => a.id === currentAccount()), accounts });
  // ENTIRE BUSINESS: every account's data, each row tagged with its account. Payments stay per account (books.byAccount).
  const parts = [];
  for (const a of accounts) parts.push({ a, d: await withAccount(a.id, accountData) });
  const tag = (list, a) => (list || []).map((x) => ({ ...x, account: a.id, account_name: a.name }));
  const main = parts[0].d;
  res.json({
    combined: true, account: { id: 'all', name: 'ENTIRE BUSINESS' }, accounts,
    orders: parts.flatMap(({ a, d }) => tag(d.orders, a)),
    flags: { unassignedCharges: parts.flatMap(({ a, d }) => tag(d.flags.unassignedCharges, a)), openHolds: parts.flatMap(({ a, d }) => tag(d.flags.openHolds, a)) },
    amazon: { orders: parts.reduce((t, p) => t + (p.d.amazon.orders || 0), 0), linked: parts.reduce((t, p) => t + (p.d.amazon.linked || 0), 0), suggestions: parts.reduce((t, p) => t + (p.d.amazon.suggestions || 0), 0), unmatchedRefunds: parts.flatMap(({ a, d }) => tag(d.amazon.unmatchedRefunds, a)) },
    email: { ...main.email, failed: parts.flatMap(({ a, d }) => tag(d.email.failed, a)) },
    ebay: main.ebay,
    byAccount: parts.map(({ a, d }) => ({ id: a.id, name: a.name, ebay: d.ebay, email: { configured: d.email.configured, running: d.email.running, last: d.email.last, user: d.email.user }, books: d.books, settings: d.settings })),
    settings: main.settings,
    books: { expenses: parts.flatMap(({ a, d }) => tag(d.books.expenses, a)), settlements: [], payments: [], closed: [] },
    db: main.db, ai: main.ai,
  });
}));

// Everything the pages need for the current account
async function accountData() {
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
  // eBay charges someone already looked at on the Review page are marked, not dropped
  const reviewed = new Set((await getSetting('reviewed_charges')) || []);
  return { orders, flags: { unassignedCharges: (orders.unassignedCharges || []).map((c) => ({ ...c, reviewed: reviewed.has(c.id) })), openHolds: orders.openHolds || [] }, ebay: status, email, amazon: { ...amazonStats, suggestions, unmatchedRefunds: orders.unmatchedRefunds || [] }, settings, books, db: dbKind(), ai: { configured: llmConfigured() } };
}

// ---------- accounts (eBay stores) ----------
app.get('/api/accounts', wrap(async (_req, res) => res.json(await listAccounts())));
app.post('/api/accounts', wrap(async (req, res) => {
  const a = await createAccount(req.body?.name);
  await withAccount(a.id, () => loadEbayConnection());
  await logMoney(req, 'account added', a.id, null, a);
  res.json({ ok: true, account: a, accounts: await listAccounts() });
}));
app.post('/api/accounts/:id/rename', wrap(async (req, res) => {
  if (!hasAccount(req.params.id)) return res.status(404).json({ error: 'No such account' });
  const a = await renameAccount(req.params.id, req.body?.name);
  res.json({ ok: true, account: a, accounts: await listAccounts() });
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
    settlement_day: (await getSetting('settlement_day')) ?? 26,
    business_start: (await getSetting('business_start')) || null,
    dashboard: (await getSetting('dashboard')) || {},
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
    if (isLedgerCsv(f.buffer)) {
      // From October 2026 a hand sheet is a check on the site, never an input; a paid month is never rewritten
      const month = parseLedgerCsv(f.buffer, f.originalname).month;
      const paid = await one('select 1 from settlement_payments where month = $1', [month]);
      if (month > CYCLE_START || paid) { results.push({ filename: f.originalname, kind: 'sheet_check', month, ...(await checkSheet(f.buffer, f.originalname)) }); continue; }
      results.push({ filename: f.originalname, ...(await importLedgerCsv(f.buffer, f.originalname)) });
    } else results.push({ filename: f.originalname, kind: 'amazon', ...(await importAmazonCsv(f.buffer, f.originalname)) });
  }
  res.json(results);
}));

// The change log: every manual change to money, newest first
app.get('/api/log', wrap(async (req, res) => res.json(await q('select id, at, action, subject, before, after, ip from money_log order by id desc limit $1', [Math.min(1000, Number(req.query.limit) || 300)]))));
// Everything in one file: the books can be restored or audited from it (keep one after each payment)
app.get('/api/export/backup', wrap(async (_req, res) => {
  const tables = ['ebay_orders', 'ebay_line_items', 'ebay_transactions', 'ebay_returns', 'amazon_lines', 'order_links', 'link_rejections', 'order_overrides', 'amazon_refunds', 'amazon_emails', 'ledger_entries', 'expenses', 'settlements', 'settlement_payments', 'settlement_freeze', 'money_log'];
  const out = { exported_at: new Date().toISOString(), tables: {} };
  for (const t of tables) out.tables[t] = await q(`select * from ${t}`).catch((e) => ({ error: e.message }));
  // Secrets are left out by name and, as a backstop, by what the value looks like
  out.settings = (await q('select key, value from settings')).filter((r) => !/oauth|token|secret|password|key/i.test(r.key) && !/token|secret|password|v^1.1#/i.test(JSON.stringify(r.value ?? '')));
  res.setHeader('Content-Disposition', `attachment; filename="dropship-ledger-backup-${businessDay(new Date())}.json"`);
  res.json(out);
}));

// Check a hand-kept sheet against the site without changing anything
app.post('/api/sheets/check', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (!isLedgerCsv(req.file.buffer)) return res.status(400).json({ error: "That doesn't look like a monthly settlement sheet" });
  res.json(await checkSheet(req.file.buffer, req.file.originalname));
}));

// ---------- editor saves ----------
const OVERRIDE_FIELDS = ['cost_override', 'extra_cost', 'amazon_refund', 'fee_override', 'refund_override', 'notes', 'excluded', 'confirmed_separate'];

const MONEY_FIELDS = ['cost_override', 'extra_cost', 'amazon_refund', 'fee_override', 'refund_override'];
app.post('/api/overrides', wrap(async (req, res) => {
  const changes = req.body?.changes || [];
  // Check everything first: nothing is saved unless every change is valid
  const clean = [];
  for (const c of changes) {
    const fields = Object.keys(c).filter((k) => OVERRIDE_FIELDS.includes(k));
    if (!c.order_id || !fields.length) continue;
    if (/^(REFUND|ADJ|HOLD):/.test(c.order_id)) return res.status(400).json({ error: 'Refund and adjustment lines are worked out from eBay and Amazon. Edit the sale itself instead.' });
    const vals = [];
    for (const k of fields) {
      if (!MONEY_FIELDS.includes(k)) { vals.push(k === 'notes' ? (c[k] == null ? null : String(c[k]).slice(0, 1000)) : Boolean(c[k])); continue; }
      const v = parseAmount(c[k]);
      if (v !== null && !Number.isFinite(v)) return res.status(400).json({ error: `${k.replace(/_/g, ' ')} for ${c.order_id}: "${c[k]}" isn't an amount` });
      if (v !== null && v < 0) return res.status(400).json({ error: `${k.replace(/_/g, ' ')} for ${c.order_id} can't be negative` });
      vals.push(v === null ? null : Math.round(v * 100) / 100);
    }
    clean.push({ id: c.order_id, fields, vals });
  }
  await withTransaction(async (tq) => {
    for (const c of clean) {
      const before = (await tq('select * from order_overrides where order_id = $1', [c.id]))[0] || null;
      await tq(
        `insert into order_overrides (order_id, ${c.fields.join(', ')}, updated_at)
         values ($1, ${c.fields.map((_, i) => `${i + 2}`).join(', ')}, now())
         on conflict (order_id) do update set ${c.fields.map((f) => `${f} = excluded.${f}`).join(', ')}, updated_at = now()`,
        [c.id, ...c.vals]
      );
      await logMoney(req, 'override', c.id, before, Object.fromEntries(c.fields.map((f, i) => [f, c.vals[i]])), tq);
    }
  });
  res.json({ ok: true, saved: clean.length });
}));

app.post('/api/amazon/lines', wrap(async (req, res) => {
  const changes = req.body?.changes || [];
  for (const c of changes) {
    const v = 'cost_override' in c ? parseAmount(c.cost_override) : null;
    if (v !== null && (!Number.isFinite(v) || v < 0)) return res.status(400).json({ error: `Amazon cost "${c.cost_override}" isn't a valid amount` });
  }
  await withTransaction(async (tq) => {
    for (const c of changes) {
      if (!c.line_key) continue;
      const before = (await tq('select cost_override, ignored from amazon_lines where line_key = $1', [c.line_key]))[0] || null;
      if ('cost_override' in c) await tq('update amazon_lines set cost_override = $2, updated_at = now() where line_key = $1', [c.line_key, parseAmount(c.cost_override)]);
      if ('ignored' in c) await tq('update amazon_lines set ignored = $2, updated_at = now() where line_key = $1', [c.line_key, Boolean(c.ignored)]);
      await logMoney(req, 'amazon line', c.line_key, before, { cost_override: 'cost_override' in c ? parseAmount(c.cost_override) : undefined, ignored: 'ignored' in c ? Boolean(c.ignored) : undefined }, tq);
    }
  });
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
    await logMoney(req, 'unlink', amazon_order_id, prev, null);
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
  await logMoney(req, 'link', amazon_order_id, null, { ebay_order_id });
  res.json({ ok: true });
}));

app.post('/api/links/reject', wrap(async (req, res) => {
  const { amazon_order_id, ebay_order_id, ignore_amazon } = req.body || {};
  if (ignore_amazon) await q('update amazon_lines set ignored = true where amazon_order_id = $1', [amazon_order_id]);
  else await q('insert into link_rejections (amazon_order_id, ebay_order_id) values ($1,$2) on conflict do nothing', [amazon_order_id, ebay_order_id]);
  await logMoney(req, ignore_amazon ? 'ignore amazon order' : 'reject match', amazon_order_id, null, { ebay_order_id });
  res.json({ ok: true });
}));

// ---------- settings / sync ----------
app.post('/api/settings', wrap(async (req, res) => {
  const b = req.body || {};
  const before = await getAllSettings();
  const money = ['split_amazon', 'settlement_day', 'business_start', 'partner_amazon', 'partner_ebay'].filter((k) => k in b);
  if ('home_zips' in b) await setSetting('home_zips', (b.home_zips || []).map((z) => String(z).trim().slice(0, 5)).filter(Boolean));
  if ('monthly_goal' in b) await setSetting('monthly_goal', Number(b.monthly_goal) || 0);
  if ('partner_amazon' in b) await setSetting('partner_amazon', String(b.partner_amazon || 'Partner A').slice(0, 40));
  if ('partner_ebay' in b) await setSetting('partner_ebay', String(b.partner_ebay || 'Partner B').slice(0, 40));
  if ('split_amazon' in b) await setSetting('split_amazon', Math.min(100, Math.max(0, Number(b.split_amazon) || 0)));
  if ('business_start' in b) await setSetting('business_start', /^\d{4}-\d{2}$/.test(b.business_start || '') ? b.business_start : null);
  if ('settlement_day' in b) await setSetting('settlement_day', Math.min(28, Math.max(1, Math.round(Number(b.settlement_day) || 26))));
  if (money.length) { const after = await getAllSettings(); await logMoney(req, 'settings', money.join(','), Object.fromEntries(money.map((k) => [k, before[k]])), Object.fromEntries(money.map((k) => [k, after[k]]))); }
  await runMatcher();
  res.json({ ok: true, settings: await getAllSettings() });
}));

// What the dashboard shows (pages in the menu, Overview cards, alerts): shared by everyone who signs in.
// Only known on/off switches are kept.
app.post('/api/settings/dashboard', wrap(async (req, res) => {
  const b = req.body || {};
  const clean = {};
  for (const group of ['pages', 'cards', 'alerts']) {
    if (!b[group] || typeof b[group] !== 'object') continue;
    clean[group] = {};
    for (const [k, v] of Object.entries(b[group])) if (/^[a-z][a-z0-9_-]{0,40}$/.test(k)) clean[group][k] = Boolean(v);
  }
  await setSetting('dashboard', clean);
  res.json({ ok: true, settings: await getAllSettings() });
}));

// Review page: mark an eBay charge with no order as looked at (or not)
app.post('/api/review/charge', wrap(async (req, res) => {
  const id = String(req.body?.id || '').slice(0, 200);
  if (!id) return res.status(400).json({ error: 'id required' });
  const list = new Set((await getSetting('reviewed_charges')) || []);
  if (req.body?.reviewed === false) list.delete(id); else list.add(id);
  await setSetting('reviewed_charges', [...list]);
  await logMoney(req, req.body?.reviewed === false ? 'charge un-reviewed' : 'charge reviewed', id, null, null);
  res.json({ ok: true });
}));

// A correction for an earlier, already-paid period that the partners settled between themselves: it stops counting
// on the open payment it was going on (and counts again if un-marked). Never for a payment already made.
app.post('/api/corrections/settle', wrap(async (req, res) => {
  const id = String(req.body?.id || '').slice(0, 200);
  const settled = req.body?.settled !== false;
  if (!id) return res.status(400).json({ error: 'id required' });
  const list = (await getSetting('settled_corrections')) || {};
  if (settled) {
    const row = (await buildDataset()).find((o) => o.order_id === id);
    if (!row || !row.correction_for) return res.status(400).json({ error: 'That line is not a correction for an earlier payment' });
    const books = await buildBooks();
    if ((books.closed || []).some((c) => c.month === row.settle_month)) return res.status(409).json({ error: 'That payment has been made, so it can no longer change' });
    list[id] = { at: new Date().toISOString(), note: String(req.body?.note || '').slice(0, 300), profit: row.net, month: row.settle_month };
  } else delete list[id];
  await setSetting('settled_corrections', list);
  await logMoney(req, settled ? 'correction settled between partners' : 'correction counted again', id, null, list[id] || null);
  res.json({ ok: true, ...(await buildBooks()) });
}));

app.post('/api/sync', wrap(async (_req, res) => res.json(await syncEbay())));

// ---------- eBay listing analytics (Products page) ----------
app.get('/api/listings', wrap(async (_req, res) => res.json(await listingAnalytics())));
app.post('/api/listings/sync', wrap(async (_req, res) => res.json(await syncListings())));
app.get('/api/promotions', wrap(async (_req, res) => res.json(await promotionAnalytics())));
// Every active listing that isn't promoted, as a CSV to add them to a campaign in Seller Hub
app.get('/api/promotions/not-promoted.csv', wrap(async (_req, res) => {
  const cell = (v) => { const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const rows = await unpromotedListings();
  const head = ['Item ID', 'Title', 'Price', 'Listed', 'Sold', 'Views (30 days)', 'Times shown (30 days)', 'Link'];
  const body = rows.map((r) => [r.item_id, r.title, r.price, r.started, r.quantity_sold, r.views_30d, r.shown_30d, r.listing_url].map(cell).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="not-promoted-listings.csv"');
  res.send([head.join(','), ...body].join('\n'));
}));

// Products -> Listings: every active listing with 0 views in the last 30 days, as a spreadsheet
app.get('/api/listings/zero-views.csv', wrap(async (_req, res) => {
  // A cell a spreadsheet would read as a formula (=, +, -, @) is kept as text
  const cell = (v) => { let s = v === null || v === undefined ? '' : String(v); if (/^[=+\-@]/.test(s)) s = `'${s}`; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const { rows, period } = await zeroViewListings();
  if (!rows) return res.status(409).type('text/plain').send('30-day listing views have not synced from eBay yet (Products -> Listings -> Check listings now). Without them there is no way to tell which listings had no views in the last 30 days.');
  const head = ['Item ID', 'Title', 'SKU', 'Price', 'Listed on', 'Days live', 'Views (last 30 days)', 'Times shown in search (last 30 days)', 'Watchers', 'Sold', 'Quantity available', 'Link'];
  const body = rows.map((r) => [r.itemId, r.title, r.sku, r.price, r.started, r.daysLive, 0, r.impressions, r.watchers, r.sold, r.available, r.url].map(cell).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="zero-views-${period?.to_day || 'last-30-days'}.csv"`);
  res.send([head.join(','), ...body].join('\n'));
}));

// ---------- Connect eBay (OAuth authorization-code flow) ----------
// eBay Developer portal -> User Tokens -> "Get a Token from eBay via Your Application" -> add a RuName whose
// "Your auth accepted URL" is https://<this app>/api/ebay/callback, then set EBAY_RUNAME to that RuName.
app.get('/api/ebay/connect', wrap(async (_req, res) => {
  if (!ebayCanConnect()) return res.status(400).send('Set EBAY_CLIENT_ID, EBAY_CLIENT_SECRET and EBAY_RUNAME first.');
  const state = `${currentAccount()}.${crypto.randomBytes(16).toString('hex')}`;
  await setSetting('ebay_oauth_state', { state, at: Date.now() });
  res.redirect(ebayConsentUrl(state));
}));
// Fallback when the RuName still uses eBay's default "Authorization successfully completed" page:
// paste that page's address (it carries ?code=...) at /ebay-code.html. Codes expire after ~5 minutes.
app.post('/api/ebay/code', wrap(async (req, res) => {
  const raw = String(req.body?.url || '').trim();
  let code = null;
  try { code = new URL(raw).searchParams.get('code'); } catch { code = raw || null; }
  if (!code) return res.status(400).json({ error: 'No code found in that address. Copy the full address from the eBay success page.' });
  await ebayConnectWithCode(code);
  syncEbay().catch((err) => console.error('first eBay sync failed', err));
  res.json({ ok: true });
}));
app.get('/api/ebay/callback', wrap(async (req, res) => {
  // The account this connection is for is the part of the state before the dot
  const acct = String(req.query.state || '').split('.')[0];
  if (acct && acct !== currentAccount() && hasAccount(acct)) return withAccount(acct, () => ebayCallback(req, res));
  return ebayCallback(req, res);
}));
async function ebayCallback(req, res) {
  const saved = await getSetting('ebay_oauth_state');
  if (req.query.error) return res.redirect(`/#/settings?ebay=${encodeURIComponent(String(req.query.error_description || req.query.error))}`);
  if (!saved || saved.state !== req.query.state || Date.now() - saved.at > 15 * 60_000)
    return res.redirect('/#/settings?ebay=Connection+link+expired%2C+click+Connect+eBay+again');
  await ebayConnectWithCode(String(req.query.code || ''));
  await setSetting('ebay_oauth_state', null);
  syncEbay().catch((err) => console.error('first eBay sync failed', err));
  res.redirect(`/#/settings?ebay=connected&account=${encodeURIComponent(currentAccount())}`);
}

// ---------- books: operating expenses, settlements, ledger links ----------
app.post('/api/expenses', wrap(async (req, res) => {
  const changes = req.body?.changes || [];
  // Check every change first, then save them all together (or none)
  for (const c of changes) {
    if (c._delete) continue;
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(c.month || '') || !String(c.category || '').trim()) return res.status(400).json({ error: 'Each cost needs a month and a name' });
    // A cost is a positive amount; a refund or credit on a cost (e.g. a subscription refunded) is a negative one
    const a = parseAmount(c.amount);
    if (a === null || !Number.isFinite(a) || Math.abs(a) < 0.005) return res.status(400).json({ error: `Amount for "${c.category}" must be a number other than $0 (negative for a credit)` });
  }
  await withTransaction(async (tq) => {
    for (const c of changes) {
      if (c._delete && c.id) {
        const before = (await tq('select * from expenses where id = $1', [c.id]))[0] || null;
        await tq('delete from expenses where id = $1', [c.id]);
        await logMoney(req, 'expense removed', before ? `${before.month} ${before.category}` : c.id, before, null, tq);
        continue;
      }
      if (c._delete) continue;
      if (!c.id) {
        const dup = (await tq('select id from expenses where month = $1 and lower(trim(category)) = lower(trim($2))', [c.month, c.category]))[0];
        if (dup) throw Object.assign(new Error(`"${c.category}" already exists in ${c.month}. Edit its amount instead.`), { status: 409 });
      }
      const vals = [c.month, String(c.category).trim(), Math.round(parseAmount(c.amount) * 100) / 100, c.note || null, c.paid_by === 'amazon' ? 'amazon' : 'seller'];
      const before = c.id ? (await tq('select * from expenses where id = $1', [c.id]))[0] || null : null;
      if (c.id) await tq('update expenses set month=$2, category=$3, amount=$4, note=$5, paid_by=$6, updated_at=now() where id=$1', [c.id, ...vals]);
      else await tq('insert into expenses (month, category, amount, note, paid_by) values ($1,$2,$3,$4,$5)', vals);
      await logMoney(req, c.id ? 'expense edited' : 'expense added', `${vals[0]} ${vals[1]}`, before, { month: vals[0], category: vals[1], amount: vals[2], paid_by: vals[4] }, tq);
    }
  });
  res.json({ ok: true, ...(await buildBooks()) });
}));
// Payments. Each payment is its own row (a correction is a negative amount); settlements.paid is their sum and
// paid_at the latest date. The first payment for a month closes it: what it covered is recorded, and anything that
// turns up later for that period goes on the next open payment (see settlement_freeze in dataset.js).
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
async function syncPaid(month) {
  const [t] = await q('select sum(amount) as paid, max(paid_at) as paid_at, count(*)::int as n from settlement_payments where month = $1', [month]);
  await q(`insert into settlements (month, paid, paid_at) values ($1, $2, $3)
           on conflict (month) do update set paid = excluded.paid, paid_at = excluded.paid_at, updated_at = now()`,
    [month, t.n ? Number(t.paid) : null, t.paid_at || null]);
  if (!t.n) await q('delete from settlement_freeze where month = $1', [month]); // every payment removed: reopen it
}
async function closePeriod(month) {
  if (await one('select 1 from settlement_freeze where month = $1', [month])) return;
  const [orders, books] = await Promise.all([buildDataset(), buildBooks()]);
  const split = Number((await getSetting('split_amazon')) ?? 50);
  const rows = orders.filter((o) => o.counted && o.settle_month === month);
  const keys = rows.map((o) => o.order_id).sort();
  const values = Object.fromEntries(rows.map((o) => [o.order_id, { ...rowCents(o), title: String(o.title || '').slice(0, 120) }]));
  const s = settleMonth({ month, orders, expenses: books.expenses, settlements: books.settlements, splitAmazon: split });
  const totals = { orders: s.orders, collected: s.collected, cogs: s.cogs, adFees: s.adFees, opex: s.opex, opexSeller: s.opexSeller, opexAmazon: s.opexAmazon, split, dueDay: Number((await getSetting('settlement_day')) ?? 26), businessProfit: s.businessProfit, sellerSends: s.sellerSends, paid: s.paid };
  await q('insert into settlement_freeze (month, row_keys, row_values, totals, source) values ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5) on conflict (month) do nothing',
    [month, JSON.stringify(keys), JSON.stringify(values), JSON.stringify(totals), 'first payment recorded']);
}
app.post('/api/settlements/payments', wrap(async (req, res) => {
  const { month, amount, paid_at, note } = req.body || {};
  if (!MONTH_RE.test(month || '')) return res.status(400).json({ error: 'month must be YYYY-MM' });
  const amt = Math.round(Number(amount) * 100) / 100;
  if (!Number.isFinite(amt) || Math.abs(amt) < 0.01) return res.status(400).json({ error: 'Enter the amount paid (a correction can be negative)' });
  const day = paid_at ? String(paid_at) : businessDay(new Date());
  if (!DAY_RE.test(day)) return res.status(400).json({ error: 'paid_at must be YYYY-MM-DD' });
  if (day > businessDay(new Date())) return res.status(400).json({ error: "A payment can't be dated in the future (Arizona time)" });
  await q('insert into settlement_payments (month, amount, paid_at, note) values ($1, $2, $3, $4)', [month, amt, day, note ? String(note).slice(0, 500) : null]);
  await logMoney(req, 'payment added', month, null, { amount: amt, paid_at: day, note: note || null });
  await syncPaid(month);
  await closePeriod(month);
  res.json({ ok: true, ...(await buildBooks()) });
}));
// "Paid in full": the server works out what's left from fresh numbers, so a stale page can't record the wrong amount
app.post('/api/settlements/pay-remaining', wrap(async (req, res) => {
  const { month, note, expected } = req.body || {};
  if (!MONTH_RE.test(month || '')) return res.status(400).json({ error: 'month must be YYYY-MM' });
  const [orders, books] = await Promise.all([buildDataset(), buildBooks()]);
  const split = Number((await getSetting('split_amazon')) ?? 50);
  const s = settleMonth({ month, orders, expenses: books.expenses, settlements: books.settlements, splitAmazon: split });
  const left = Math.round((s.sellerSends - (s.paid || 0)) * 100) / 100;
  if (Math.abs(left) < 0.01) return res.json({ ok: true, nothing: true, ...books });
  // The page shows what it thinks is left (signed: negative = Myles owes Drew); if the numbers moved since, say so
  // instead of recording an amount nobody saw
  if (expected !== undefined && expected !== null && Math.abs(Number(expected) - left) >= 0.005)
    return res.status(409).json({ error: `The amount left changed to ${left.toFixed(2)} since the page loaded. Reload and check it.`, left });
  await q('insert into settlement_payments (month, amount, paid_at, note) values ($1, $2, $3, $4)', [month, left, businessDay(new Date()), note ? String(note).slice(0, 500) : 'remaining balance']);
  await logMoney(req, 'payment added (remaining balance)', month, null, { amount: left, paid_at: businessDay(new Date()) });
  await syncPaid(month);
  await closePeriod(month);
  res.json({ ok: true, amount: left, ...(await buildBooks()) });
}));
app.delete('/api/settlements/payments/:id', wrap(async (req, res) => {
  const row = await one('select * from settlement_payments where id = $1', [Number(req.params.id)]);
  if (!row) return res.status(404).json({ error: 'No such payment' });
  await q('delete from settlement_payments where id = $1', [Number(req.params.id)]);
  await logMoney(req, 'payment removed', row.month, row, null);
  await syncPaid(row.month);
  res.json({ ok: true, ...(await buildBooks()) });
}));
// The month's note only; amounts are recorded as payments above (an overwrite here used to wipe earlier payments)
app.post('/api/settlements', wrap(async (req, res) => {
  const { month, note } = req.body || {};
  if (!MONTH_RE.test(month || '')) return res.status(400).json({ error: 'month must be YYYY-MM' });
  if ('paid' in (req.body || {}) || 'paid_at' in (req.body || {})) return res.status(400).json({ error: 'Record payments with "Add a payment"' });
  await q(`insert into settlements (month, note) values ($1, $2) on conflict (month) do update set note = excluded.note, updated_at = now()`, [month, note || null]);
  res.json({ ok: true, ...(await buildBooks()) });
}));
app.post('/api/ledger/link', wrap(async (req, res) => {
  const { entry_key, ebay_order_id } = req.body || {};
  if (ebay_order_id && !(await one('select 1 from ebay_orders where order_id = $1', [ebay_order_id])))
    return res.status(404).json({ error: `No eBay order ${ebay_order_id}` });
  await q('update ledger_entries set ebay_order_id = $2, match_method = $3 where entry_key = $1', [entry_key, ebay_order_id || null, ebay_order_id ? 'manual' : null]);
  await logMoney(req, 'sheet row link', entry_key, null, { ebay_order_id: ebay_order_id || null });
  res.json({ ok: true });
}));
app.post('/api/email/sync', wrap(async (_req, res) => res.json(await syncEmail())));
// Re-read every Amazon email in place: nothing is deleted first, links and typed costs are kept, and if the mailbox
// can't be read nothing changes (see reprocessEmail in email.js)
app.post('/api/email/reprocess', wrap(async (req, res) => {
  const out = await reprocessEmail();
  await logMoney(req, 'reprocess emails', null, null, { ok: out?.ok ?? null });
  res.json(out);
}));
// An unreadable Amazon email someone has checked by hand: stop warning about it
app.post('/api/email/failed/dismiss', wrap(async (req, res) => {
  const id = String(req.body?.message_id || '');
  if (!id) return res.status(400).json({ error: 'message_id required' });
  await dismissFailedEmail(id);
  await logMoney(req, 'dismiss unreadable email', id, null, null);
  res.json({ ok: true, ...(await emailStatus()) });
}));
app.get('/api/email/debug', wrap(async (_req, res) =>
  res.json(await q("select subject, kind, order_ids, ok, note, parsed->>'total' as total, parsed->>'shipText' as ship, parsed->>'excerpt' as excerpt from amazon_emails order by created_at desc limit 5"))));
app.get('/api/email/log', wrap(async (_req, res) =>
  res.json(await q('select message_id, received_at, subject, kind, order_ids, ok, note from amazon_emails order by received_at desc nulls last limit 60'))));
app.post('/api/rematch', wrap(async (_req, res) => res.json(await runMatcher())));
// "Check email now" on one sale: pull new Amazon emails, run the matcher, then report whether this sale matched,
// and if not, the closest Amazon orders (below the auto-link bar) so they can be linked by hand
app.post('/api/orders/:id/check-email', wrap(async (req, res) => {
  const id = String(req.params.id);
  if (!(await one('select 1 from ebay_orders where order_id = $1', [id]))) return res.status(404).json({ error: `No eBay order ${id}` });
  const sync = emailConfigured() ? await syncEmail() : { ok: false, log: ['The Amazon email import is not set up (Settings)'] };
  await runMatcher();
  const links = await q(
    `select k.amazon_order_id, k.method, k.reasons, sum(l.line_total) as total
     from order_links k left join amazon_lines l on l.amazon_order_id = k.amazon_order_id
     where k.ebay_order_id = $1 group by k.amazon_order_id, k.method, k.reasons`, [id]);
  res.json({ ok: sync.ok, log: sync.log, matched: links.length > 0, links, candidates: links.length ? [] : await candidatesForSale(id) });
}));
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

// ---------- Ask AI: the AI model (FreeLLMAPI) reads every question, the dashboard works the answer out from the books,
// and the model writes it in its own words from those facts (any number not in the facts and the reply is dropped).
// Progress streams as one JSON object per line so the page can show each step while it waits. If the model is off or
// can't be reached, the built-in reader and the dashboard's own wording answer instead. ----------
app.post('/api/ask', async (req, res) => {
  const question = String(req.body?.question || '').slice(0, 1000);
  if (!question.trim()) return res.status(400).json({ error: 'Ask a question' });
  const context = req.body?.context || null;
  res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('x-accel-buffering', 'no');
  const step = (o) => res.write(`${JSON.stringify(o)}\n`);
  try {
    const ai = llmConfigured();
    let a = null;
    if (ai) {
      step({ stage: 'reading' });
      const route = await routeQuestion(question, { prev: context });
      if (route && route.topic !== 'other') { const b = await ask(question, context, route, { modelFirst: true }); if (b.understood) a = b; }
      if (!a) step({ stage: 'reading', note: 'The AI model couldn’t place that question, so the built-in reader is answering.' });
    }
    if (!a) a = await ask(question, context, null);
    step({ stage: 'numbers', understood: a.understood || null });
    if (ai && a.understood) {
      step({ stage: 'writing' });
      const text = await writeAnswer(question, a);
      a = text ? { ...a, facts: { text: a.text, bullets: a.bullets || [], table: a.table || null }, text, bullets: [], table: null, writtenBy: 'model' } : { ...a, writtenBy: 'dashboard' };
    }
    step({ done: true, answer: a });
  } catch (e) {
    console.error(e);
    step({ error: e.message });
  }
  res.end();
});

app.get('/api/health', wrap(async (_req, res) => { await q('select 1'); res.json({ ok: true }); }));

const port = Number(process.env.PORT || 3000);
const kind = await initDb();
for (const id of accountIds()) await withAccount(id, () => loadEbayConnection());
app.listen(port, () => {
  console.log(`Dropship dashboard on http://localhost:${port}  (db: ${kind}${PASSWORD ? ', password on' : ', NO PASSWORD'})`);
});

// Background eBay sync
const every = Number(process.env.SYNC_INTERVAL_MINUTES || 30);
// Always scheduled; each tick checks whether eBay is connected, so connecting in the UI starts syncing without a restart
if (every > 0) {
  // Every account in turn (one at a time, so two stores never hit eBay's limits together)
  const tick = async () => {
    for (const id of accountIds()) {
      await withAccount(id, async () => {
        if (!ebayConfigured()) return;
        const r = await syncEbay().catch((e) => ({ log: [`error: ${e.message}`] }));
        console.log(`eBay sync [${id}]:`, r.log.join(' | '));
      });
    }
  };
  setTimeout(tick, 5_000);
  setInterval(tick, every * 60_000);
}
// Ask AI model: check it can be reached once Tailscale (if used) has had time to connect, and again later if not
if (llmConfigured()) setTimeout(() => checkModel().then((ok) => { if (!ok) setTimeout(checkModel, 90_000); }), 20_000);
if (!ebayConfigured()) console.log('eBay not connected yet: set EBAY_CLIENT_ID / EBAY_CLIENT_SECRET / EBAY_RUNAME, then Settings -> Connect eBay');
if (every > 0) {
  // Each account's own inbox (an account without one is skipped)
  const tickMail = async () => {
    for (const id of accountIds()) {
      await withAccount(id, async () => {
        if (!emailConfigured()) return;
        const r = await syncEmail().catch((e) => ({ log: [`error: ${e.message}`] }));
        console.log(`Email sync [${id}]:`, r.log.join(' | '));
      });
    }
  };
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
