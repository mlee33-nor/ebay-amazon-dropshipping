// Amazon purchases from email: reads Amazon order-confirmation, cancellation and refund emails over
// IMAP (Gmail/Outlook/Yahoo/iCloud, app password) and writes them into amazon_lines keyed by the
// Amazon order number, exactly like the CSV importer. A CSV row for the same order always wins,
// so an order is never counted twice no matter which source saw it first.
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { q, one, getSetting, setSetting } from './db.js';
import { runMatcher } from './matcher.js';
import { extractZip } from './amazon.js';

export function emailConfigured() {
  return Boolean(process.env.EMAIL_USER && process.env.EMAIL_PASSWORD);
}

const ORDER_RE = /\b(?:D\d{2}|\d{3})-\d{7}-\d{7}\b/g;
function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|td|li|h\d|table)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n');
}

// Invisible characters Amazon sprinkles into subjects/bodies (bidi isolates, CGJ, ZWNJ, figure spaces, soft hyphens)
const INVISIBLE = /[͏­​-‏‪-‮⁠-⁩  ﻿]/g;
const clean = (s) => String(s || '').replace(INVISIBLE, '').replace(/&#847;|&zwnj;|&#8199;|&shy;|&#8202;/g, '');

export function classify(subject, body) {
  const s = clean(subject);
  if (/refund/i.test(s)) return 'refund';
  if (/cancel/i.test(s)) return 'cancel';
  if (/^\s*(ordered\b|your amazon(\.com)? order|order confirmation|thanks for your order)/i.test(s)) return 'order';
  if (/thanks for your order|order confirmation/i.test(body.slice(0, 2000)) && /grand total/i.test(body)) return 'order';
  if (/shipped|delivered|out for delivery|arriving|delay/i.test(s)) return 'shipment';
  return 'other';
}

// Amazon writes totals as "$12.60" in HTML and "12.6 USD" in the text part
function moneyNear(text, labels) {
  for (const label of labels) {
    const re = new RegExp(`${label}\\s*:?\\s*(?:\\$\\s*([\\d,]+(?:\\.\\d{1,2})?)|([\\d,]+(?:\\.\\d{1,2})?)\\s*USD)`, 'i');
    const m = text.match(re);
    if (m) return Number((m[1] || m[2]).replace(/,/g, ''));
  }
  return null;
}

export function parseAmazonEmail({ subject = '', text = '', html = '', date }) {
  subject = clean(subject);
  const htmlText = clean(htmlToText(html));
  const plain = clean(text);
  const body = `${plain}\n${htmlText}`.replace(/\r/g, '');
  const kind = classify(subject, body);
  const orderIds = [...new Set([...(subject.match(ORDER_RE) || []), ...(body.match(ORDER_RE) || [])])];
  const out = { kind, orderIds, date: date ? new Date(date).toISOString() : null };

  if (kind === 'order') {
    out.total = moneyNear(body, ['Grand Total', 'Order Total', 'Total for this order', 'Order total']);
    out.tax = moneyNear(body, ['Estimated tax to be collected', 'Estimated Tax']);
    // Current template: "Sam - SPRINGFIELD, IL" (first name - CITY, ST). Older: "Ship to: Full Name ... City, ST 12345"
    const dash = body.match(/^\s*([A-Za-z][A-Za-z .'-]{0,40}?)\s+-\s+([A-Za-z][A-Za-z .'-]{1,40}),\s*([A-Z]{2})\b/m);
    const shipTo = body.match(/(?:Ship(?:ping)? to|Deliver(?:ing|y)? to)\s*:?\s*\n?\s*([^\n]{3,160})(?:\n([^\n]{3,160}))?/i);
    if (dash) {
      out.shipName = dash[1].trim();
      out.shipCity = dash[2].trim();
      out.state = dash[3];
      out.shipText = `${out.shipName} ${out.shipCity}, ${out.state}`;
    } else if (shipTo) {
      out.shipText = [shipTo[1], shipTo[2]].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      out.shipName = shipTo[1].split(/[-,–]| {2,}/)[0].trim();
      const st = out.shipText.match(/([A-Za-z .'-]{2,40}),\s*([A-Z]{2})\b/);
      if (st) { out.shipCity = st[1].trim().split(/\s{2,}/).pop(); out.state = st[2]; }
    }
    if (out.shipText) out.zip = extractZip(out.shipText);
    // Subject: "Ordered 1 item: Crafts" / "Ordered: 1 Exercise & Fitness item" / "Ordered: "Full Title" and 2 more items"
    let m;
    if ((m = subject.match(/Ordered:?\s*"([^"]+)"(?:\s+and (\d+) more items?)?/i))) {
      out.items = [{ title: m[1].replace(/\.\.\.$/, '').trim(), quantity: 1 }];
      out.itemCount = 1 + Number(m[2] || 0);
    } else if ((m = subject.match(/Ordered:?\s*(\d+)\s+items?:\s*(.+)$/i)) || (m = subject.match(/Ordered:?\s*(\d+)\s+(.+?)\s+items?$/i))) {
      out.itemCount = Number(m[1]);
      out.category = m[2].trim();
      out.items = [];
    } else {
      out.items = [];
      out.itemCount = 1;
    }
    for (const q of body.matchAll(/^\s*([^\n$]{12,220}?)\s*\n\s*(?:Quantity|Qty)\s*:?\s*(\d+)/gim)) {
      const title = q[1].replace(/^[*•-]\s*/, '').trim();
      if (!/^(order|ship|deliver|total|arriving)/i.test(title) && !out.items.some((i) => i.title.startsWith(title.slice(0, 30))))
        out.items.push({ title, quantity: Number(q[2]) });
    }
  } else if (kind === 'refund') {
    out.refund = moneyNear(body, ['Total refund', 'Refund total', 'Refund subtotal', 'Refund amount']);
    const t = subject.match(/Refund issued for (.+)$/i);
    if (t) out.itemTitle = t[1].replace(/\.{3,}$/, '').trim();
  } else if (kind === 'cancel') {
    out.fullOrder = /order[^.\n]{0,60}(has been|was|is) cancel/i.test(`${subject}\n${body.slice(0, 800)}`) && !/\bitem/i.test(subject);
  }
  return out;
}

async function ingest(messageId, receivedAt, subject, p) {
  const done = await one('select 1 from amazon_emails where message_id = $1', [messageId]);
  if (done) return 'seen';
  let ok = true;
  let note = '';
  if (p.kind === 'order') {
    if (!p.orderIds.length) { ok = false; note = 'no order number found'; }
    else if (p.orderIds.length > 1 && p.total !== null) { ok = false; note = `one email, ${p.orderIds.length} orders, only one total. Add costs in Editor`; }
    else if (p.total === null) { ok = false; note = 'no order total found'; }
    else {
      const id = p.orderIds[0];
      const hasCsv = await one("select 1 from amazon_lines where amazon_order_id = $1 and coalesce(source,'csv') = 'csv' limit 1", [id]);
      if (hasCsv) note = 'already imported from CSV';
      else {
        const title = p.items.map((i) => i.title).join(' | ')
          || (p.category ? `${p.category} (${p.itemCount} item${p.itemCount > 1 ? 's' : ''}, title not in email)` : subject);
        const qty = p.items.reduce((s, i) => s + (i.quantity || 1), 0) || p.itemCount || 1;
        await q(
          `insert into amazon_lines (line_key, amazon_order_id, order_date, title, quantity, tax, line_total, ship_name, ship_address,
             ship_zip, ship_state, order_status, source, raw)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'Ordered','email',$12::jsonb)
           on conflict (line_key) do update set title = excluded.title, quantity = excluded.quantity, line_total = excluded.line_total,
             tax = excluded.tax, ship_name = excluded.ship_name, ship_address = excluded.ship_address, ship_zip = excluded.ship_zip,
             ship_state = excluded.ship_state, updated_at = now()`,
          [`${id}|email|1`, id, (receivedAt || new Date()).toISOString().slice(0, 10), title.slice(0, 500), qty, p.tax, p.total,
            p.shipName || null, p.shipText || null, p.zip || null, p.state || null, JSON.stringify({ subject, parsed: p })]
        );
      }
    }
  } else if (p.kind === 'refund') {
    if (p.orderIds.length === 1 && p.refund) {
      await q('insert into amazon_refunds (message_id, amazon_order_id, amount, received_at) values ($1,$2,$3,$4) on conflict do nothing',
        [messageId, p.orderIds[0], p.refund, receivedAt]);
    } else { ok = false; note = 'refund email without a single order number + amount'; }
  } else if (p.kind === 'cancel') {
    if (p.fullOrder && p.orderIds.length === 1) {
      await q("update amazon_lines set order_status = 'Cancelled', updated_at = now() where amazon_order_id = $1", [p.orderIds[0]]);
      note = 'order marked cancelled';
    } else note = 'partial cancellation, review the order in Editor';
  }
  await q(
    `insert into amazon_emails (message_id, received_at, subject, kind, order_ids, ok, note, parsed)
     values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) on conflict do nothing`,
    [messageId, receivedAt, subject, p.kind, p.orderIds, ok, note, JSON.stringify(p)]
  );
  return ok ? 'ok' : 'failed';
}

export async function ingestMessage({ messageId, subject = '', text = '', html = '', date }) {
  const parsed = parseAmazonEmail({ subject, text, html, date });
  if (parsed.kind === 'other' || parsed.kind === 'shipment') return 'seen';
  const id = messageId || `${parsed.orderIds[0] || 'unknown'}|${parsed.kind}|${date}`;
  return ingest(id, date ? new Date(date) : null, clean(subject), parsed);
}

let running = null;
export async function syncEmail() {
  if (!emailConfigured()) return { ok: false, log: ['Email not configured: set EMAIL_USER and EMAIL_PASSWORD'] };
  if (running) return running;
  running = (async () => {
    const user = process.env.EMAIL_USER;
    const host = process.env.EMAIL_IMAP_HOST || (/@(gmail|googlemail)\./i.test(user) ? 'imap.gmail.com'
      : /@(outlook|hotmail|live|msn)\./i.test(user) ? 'outlook.office365.com'
      : /@yahoo\./i.test(user) ? 'imap.mail.yahoo.com'
      : /@(icloud|me|mac)\./i.test(user) ? 'imap.mail.me.com' : null);
    if (!host) return { ok: false, log: ['Set EMAIL_IMAP_HOST for this email provider'] };
    const mailbox = process.env.EMAIL_MAILBOX || (host === 'imap.gmail.com' ? '[Gmail]/All Mail' : 'INBOX');
    const client = new ImapFlow({
      host, port: Number(process.env.EMAIL_IMAP_PORT || 993), secure: true,
      auth: { user, pass: process.env.EMAIL_PASSWORD }, logger: false,
    });
    const last = await getSetting('email_last_sync');
    const since = last
      ? new Date(new Date(last).getTime() - 3 * 86400_000)
      : new Date(Date.now() - Number(process.env.EMAIL_BACKFILL_DAYS || 120) * 86400_000);
    const startedAt = new Date().toISOString();
    const counts = { ok: 0, failed: 0, seen: 0 };
    try {
      await client.connect();
      const lock = await client.getMailboxLock(mailbox);
      try {
        const uids = await client.search({ since, from: 'amazon.com' }, { uid: true });
        // Headers first (cheap), then download only order / refund / cancellation emails not seen before
        const wanted = [];
        for await (const msg of client.fetch(uids || [], { envelope: true }, { uid: true })) {
          if (['other', 'shipment'].includes(classify(msg.envelope?.subject || '', ''))) continue;
          const id = msg.envelope?.messageId || `${msg.uid}@${mailbox}`;
          if (await one('select 1 from amazon_emails where message_id = $1', [id])) { counts.seen++; continue; }
          wanted.push(msg.uid);
        }
        for (const uid of wanted) {
          const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
          const mail = await simpleParser(msg.source);
          counts[await ingestMessage({
            messageId: mail.messageId || `${uid}@${mailbox}`, subject: mail.subject, text: mail.text, html: mail.html, date: mail.date,
          })]++;
        }
      } finally {
        lock.release();
      }
      await client.logout();
      await setSetting('email_last_sync', startedAt);
      const m = await runMatcher();
      const log = [`emails: ${counts.ok} imported, ${counts.failed} need review, ${counts.seen} already seen`, `matcher: ${m.linked} new links`];
      await setSetting('email_last_result', { ok: true, at: startedAt, log });
      return { ok: true, log };
    } catch (e) {
      const msg = /auth/i.test(e.message + (e.responseText || '')) ? `Login failed: ${e.responseText || e.message}. Use an app password.` : e.message;
      await setSetting('email_last_result', { ok: false, at: startedAt, log: [msg] });
      try { await client.logout(); } catch {}
      return { ok: false, log: [msg] };
    } finally {
      running = null;
    }
  })();
  return running;
}

export async function emailStatus() {
  return {
    configured: emailConfigured(),
    user: process.env.EMAIL_USER ? process.env.EMAIL_USER.replace(/^(.{2}).*(@.*)$/, '$1•••$2') : null,
    running: Boolean(running),
    last: await getSetting('email_last_result'),
  };
}
