// Amazon purchases from email: reads Amazon order-confirmation, cancellation and refund emails over
// IMAP (Gmail/Outlook/Yahoo/iCloud, app password) and writes them into amazon_lines keyed by the
// Amazon order number, exactly like the CSV importer. A CSV row for the same order always wins,
// so an order is never counted twice no matter which source saw it first.
import crypto from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { q, one, getSetting, setSetting } from './db.js';
import { runMatcher, sharedOrderSuggestions } from './matcher.js';
import { extractZip } from './amazon.js';
import { businessDay } from './time.js';

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
// Forwarded Amazon emails ("Fwd: Ordered 1 item: ...") are read like the original
const unfwd = (s) => clean(s).replace(/^\s*((fwd?|fw)\s*:\s*)+/i, '');

// Bump when the parser changes: every email that failed to read is tried once more with the new parser
export const PARSER_VERSION = 2;
// A failed email is fetched and read again on the next syncs, up to this many tries (then once per parser change)
const MAX_TRIES = 5;
// Failed emails older than this no longer raise a warning (and are no longer retried)
const FAILED_WINDOW_DAYS = 60;

// Product titles in quotes ("Wireless Noise Cancelling Earbuds") never decide what kind of email it is
const unquote = (s) => String(s || '').replace(/"[^"]*"|“[^”]*”/g, '""');
// "cancel", "canceled", "cancelled", "cancellation", but not "Cancelling"/"Canceling" (a product feature)
const CANCEL_WORD = /\bcancel(?:l?ed|lation|)\b/i;

export function classify(subject, body = '') {
  const s = unfwd(subject);
  // Amazon's own status prefix decides first
  if (/^\s*ordered\b/i.test(s)) return 'order';
  if (/^\s*(shipped|delivered|arriving|out for delivery|delayed?)\b/i.test(s)) return 'shipment';
  const bare = unquote(s);
  if (/refund/i.test(bare)) return 'refund';
  if (CANCEL_WORD.test(bare)) return 'cancel';
  // A legacy "Your Amazon.com order #… has shipped" is a shipment, never an order (it has no Grand Total)
  if (/shipped|delivered|out for delivery|arriving|delay|cannot be shipped|could not be shipped|on (its|the) way/i.test(bare)) return 'shipment';
  if (/^\s*(your amazon(\.com)? order|order confirmation|thanks for your order)/i.test(bare)) return 'order';
  if (/thanks for your order|order confirmation/i.test(String(body).slice(0, 2000)) && /grand total/i.test(body)) return 'order';
  return 'other';
}

// Only wording that says the cancellation HAPPENED cancels a purchase. "Your cancellation request…", "we're
// attempting to cancel", "we were unable to cancel" are review-only: the seller may still ship and charge.
const CANCEL_DONE = /\b(has been|have been|was|were|we['’]ve|we have|is now)\s+cancell?ed\b|\bcancell?ed successfully\b|\bsuccessfully cancell?ed\b|you (have not|haven['’]t) been charged|cancellation (is |was )?complete/i;
const CANCEL_NOT_DONE = /\b(unable to|could not|couldn['’]t|cannot|can['’]t|not able to|weren['’]t able to)\b[^.\n]{0,40}cancel|attempt(ing)? to cancel|request(ed)? (to|a) cancel|cancell?ation request|we['’]ll (try|attempt)/i;
export function cancelConfirmed(text) {
  const t = unquote(text);
  return CANCEL_DONE.test(t) && !CANCEL_NOT_DONE.test(t);
}

// Amazon writes totals as "$12.60" in HTML and "12.6 USD" in the text part
function moneyNear(text, labels) {
  for (const label of labels) {
    const re = new RegExp(`${label}\\s*:?\\s*(?:USD\\s*)?(?:\\$\\s*(\\d[\\d,]*(?:\\.\\d{1,2})?)|(\\d[\\d,]*(?:\\.\\d{1,2})?)\\s*USD)`, 'gi');
    for (const m of text.matchAll(re)) {
      const v = Number((m[1] || m[2]).replace(/,/g, ''));
      if (v > 0) return v;
    }
  }
  return null;
}

// Part of the order paid with gift card balance, reward points or Amazon points ("Gift Card Amount: -$10.00"). The
// Grand Total is then only what the card was charged, not what the item cost.
function otherPayment(text) {
  const re = /(?:^|\n|\s{2})\s*(gift\s*card(?:\s*(?:amount|balance|applied|used))?|(?:amazon\s+)?rewards?(?:\s*points)?(?:\s*(?:applied|used|redeemed))?|points\s*(?:applied|used|redeemed)?)\s*:?\s*\n?\s*-\s*(?:USD\s*)?(?:\$\s*)?(\d[\d,]*(?:\.\d{1,2})?)/gi;
  let best = 0;
  for (const m of text.matchAll(re)) best = Math.max(best, Number(m[2].replace(/,/g, '')) || 0);
  return best > 0 ? best : null;
}

// A name or city as Amazon prints it, accents and curly apostrophes included (José, O’FALLON, Zoë)
const NAME = String.raw`[\p{L}][\p{L} .'’-]`;
const samePrefix = (a, b) => {
  const n = Math.min(a.length, b.length, 30);
  return n >= 8 && a.slice(0, n).toLowerCase() === b.slice(0, n).toLowerCase();
};

export function parseAmazonEmail({ subject = '', text = '', html = '', date }) {
  const excerptSource = `${text || ''}\n---html---\n${htmlToText(html || '')}`;
  const forwarded = /^\s*(fwd?|fw)\s*:/i.test(clean(subject));
  subject = unfwd(subject);
  const htmlText = clean(htmlToText(html));
  const plain = clean(text);
  const body = `${plain}\n${htmlText}`.replace(/\r/g, '')
    .replace(/<https?:\/\/[^>\s]*>/g, ' ')
    .replace(/[*_]+(?=[\d$\p{L}])|(?<=[\d.\p{L}:])[*_]+/gu, '');
  const kind = classify(subject, body);
  const orderIds = [...new Set([...(subject.match(ORDER_RE) || []), ...(body.match(ORDER_RE) || [])])];
  const out = { kind, orderIds, date: date ? new Date(date).toISOString() : null };
  if (forwarded) {
    // Use the original Amazon send date from the forwarded header, not the forwarding date
    out.forwarded = true;
    out.fromAmazon = /amazon\.com/i.test(body.slice(0, 3000));
    const fd = body.match(/Forwarded message[\s\S]{0,600}?Date:\s*([^\n]+)/i);
    if (fd) {
      const t = Date.parse(fd[1].replace(/\s+at\s+/i, ' ').replace(/[  ]/g, ' ').trim());
      if (!Number.isNaN(t)) out.originalDate = new Date(t).toISOString();
    }
  }

  if (kind === 'order') {
    out.total = moneyNear(body, ['Grand Total', 'Order Total', 'Total for this order', 'Order total']);
    out.tax = moneyNear(body, ['Estimated tax to be collected', 'Estimated Tax']);
    out.giftCard = otherPayment(body);
    // Current template: "Sam - SPRINGFIELD, IL" (first name - CITY, ST). Older: "Ship to: Full Name ... City, ST 12345"
    const dash = body.match(new RegExp(String.raw`^\s*(${NAME}{0,40}?)\s+-\s+(${NAME}{1,40}),\s*([A-Z]{2})\b`, 'mu'));
    const shipTo = body.match(/(?:Ship(?:ping)? to|Deliver(?:ing|y)? to)\s*:?\s*\n?\s*([^\n]{3,160})(?:\n([^\n]{3,160}))?/i);
    if (dash) {
      out.shipName = dash[1].trim();
      out.shipCity = dash[2].trim();
      out.state = dash[3];
      out.shipText = `${out.shipName} ${out.shipCity}, ${out.state}`;
    } else if (shipTo) {
      out.shipText = [shipTo[1], shipTo[2]].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      out.shipName = shipTo[1].split(/[-,–]| {2,}/)[0].trim();
      const st = out.shipText.match(new RegExp(String.raw`(${NAME}{1,39}),\s*([A-Z]{2})\b`, 'u'));
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
    // The body lists each item with its quantity. The HTML and text parts list the same items twice, and the subject's
    // title is often a cut-off copy of the body's, so an item already known takes the body's quantity instead of
    // being added again.
    for (const q of body.matchAll(/^\s*([^\n$]{12,220}?)\s*\n\s*(?:Quantity|Qty)\s*:?\s*(\d+)/gim)) {
      const title = q[1].replace(/^[*•-]\s*/, '').trim();
      if (/^(order|ship|deliver|total|arriving)/i.test(title)) continue;
      const known = out.items.find((i) => samePrefix(i.title, title));
      if (known) known.quantity = Number(q[2]);
      else out.items.push({ title, quantity: Number(q[2]) });
    }
    // Units bought: the listed quantities, unless the subject counts more items than the body listed
    const listed = out.items.reduce((s, i) => s + (i.quantity || 1), 0);
    out.quantity = out.items.length >= (out.itemCount || 1) ? listed : Math.max(listed, out.itemCount || 1);
  } else if (kind === 'refund') {
    out.refund = moneyNear(body, ['Total refund', 'Refund total', 'Refund subtotal', 'Refund amount']);
    const t = subject.match(/Refund issued for (.+)$/i);
    if (t) out.itemTitle = t[1].replace(/\.{3,}$/, '').trim();
    // "Your refund is being processed" comes before the "Refund issued" email for the same money: a note, never booked
    const head = `${subject}\n${body.slice(0, 2000)}`;
    out.pending = /being processed|processing your (return|refund)|will (be )?(issue|process)|refund (is )?(pending|initiated)/i.test(head)
      && !/refund (was |has been )?issued|issued (a |your )?refund|refund (was|has been) (processed|completed)/i.test(head);
  } else if (kind === 'cancel') {
    const head = `${subject}\n${body.slice(0, 1500)}`;
    out.confirmed = cancelConfirmed(head);
    out.fullOrder = /order[^.\n]{0,60}(has been|was|is) cancel/i.test(unquote(head)) && !/\bitem/i.test(subject);
  }
  out.excerpt = clean(excerptSource).replace(/<?https?:\/\/\S+>?/g, '').replace(/[ \t]{2,}/g, ' ').replace(/\n\s*\n+/g, '\n').slice(0, 6000);
  return out;
}

const r2 = (n) => Math.round(n * 100) / 100;
const words = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// What Myles paid Amazon for one order, when every line's cost is known (null otherwise, e.g. a gift-card order)
async function orderCost(amazonOrderId) {
  const lines = await q('select line_total, cost_override from amazon_lines where amazon_order_id = $1 and not coalesce(ignored, false)', [amazonOrderId]);
  if (!lines.length || lines.some((l) => l.cost_override === null && l.line_total === null)) return null;
  return r2(lines.reduce((s, l) => s + Number(l.cost_override ?? l.line_total), 0));
}

async function ingestRefund(messageId, receivedAt, p) {
  const id = p.orderIds[0];
  const item = p.itemTitle || null;
  if (p.pending) return { ok: true, note: 'refund being processed: booked when the "Refund issued" email arrives' };
  // The same refund seen twice: a forward, a Sent copy in All Mail, a webhook copy, or two differently worded emails.
  // Same order and same amount to the cent, on the same Arizona day of the original send (or a forward whose original
  // date can't be read, or when booking it would take the order's refunds past its cost) = the same money, unless the
  // two emails name different items.
  const day = businessDay(receivedAt || new Date());
  const others = await q('select message_id, amount, received_at, title from amazon_refunds where amazon_order_id = $1 and message_id <> $2', [id, messageId]);
  const cost = await orderCost(id);
  const before = r2(others.reduce((s, t) => s + Number(t.amount), 0));
  const overCost = cost !== null && before + p.refund > cost + 0.005;
  const twin = others.find((t) => Math.abs(Number(t.amount) - p.refund) < 0.005
    && ((p.forwarded && !p.originalDate) || overCost || (t.received_at && businessDay(t.received_at) === day))
    && !(t.title && item && !samePrefix(words(t.title), words(item)) && words(t.title) !== words(item)));
  if (twin) return { ok: true, note: `duplicate copy of a refund already booked (${twin.message_id}), not counted again` };
  // Refunds can never add up to more than the order cost (when the cost is known)
  let amount = p.refund;
  if (overCost) {
    amount = r2(Math.max(0, cost - before));
    if (amount <= 0) return { ok: false, note: `refunds for this order already add up to its $${cost.toFixed(2)} cost: this $${p.refund.toFixed(2)} refund was not booked. Check it` };
  }
  await q(`insert into amazon_refunds (message_id, amazon_order_id, amount, received_at, title, email_amount) values ($1,$2,$3,$4,$5,$6)
           on conflict (message_id, amazon_order_id) do update set amount = excluded.amount, email_amount = excluded.email_amount,
             title = coalesce(amazon_refunds.title, excluded.title)`,
    [messageId, id, amount, receivedAt, item, p.refund]);
  if (amount < p.refund) return { ok: false, note: `refund capped at the order cost: $${p.refund.toFixed(2)} in the email, $${amount.toFixed(2)} counted. Check it` };
  return { ok: true, note: '' };
}

async function ingestOrder(subject, receivedAt, p) {
  if (!p.orderIds.length) return { ok: false, note: 'no order number found' };
  if (p.orderIds.length > 1 && p.total !== null) return { ok: false, note: `one email, ${p.orderIds.length} orders, only one total. Add costs in Editor` };
  const id = p.orderIds[0];
  if (await one("select 1 from amazon_lines where amazon_order_id = $1 and coalesce(source,'csv') = 'csv' limit 1", [id]))
    return { ok: true, note: 'already imported from CSV' };
  let ok = true;
  let note = '';
  let total = p.total;
  // Cost known to be unknown: the email's total must not stand (and must replace an older, wrong reading)
  let totalUnknown = false;
  if (p.giftCard) {
    // Part paid by gift card / points: the Grand Total is only the card charge. Unknown cost, never half a cost.
    total = null;
    totalUnknown = true;
    ok = false;
    note = `paid partly with gift card / points ($${p.giftCard.toFixed(2)}): the Grand Total is not the full cost. Enter the Amazon cost for this sale`;
  } else if (total === null) {
    // A $0.00 / missing Grand Total (paid with gift card balance or points) is stored as UNKNOWN cost: the order can
    // still be linked to its sale, and the sale waits for the cost to be entered - never $0
    ok = false;
    note = 'Grand Total missing or $0.00 (gift card / points?) - enter the Amazon cost for this sale';
  } else if (!p.shipName && !p.shipText) {
    // Without the ship-to it can't link by itself: kept, and flagged so it is linked by hand
    ok = false;
    note = 'ship-to not read: link this Amazon order to its sale in Match review';
  }
  const titleParsed = p.items.length > 0;
  const title = p.items.map((i) => i.title).join(' | ')
    || (p.category ? `${p.category} (${p.itemCount} item${p.itemCount > 1 ? 's' : ''}, title not in email)` : subject);
  const qty = p.quantity || p.items.reduce((s, i) => s + (i.quantity || 1), 0) || p.itemCount || 1;
  // A second reading of the same order (retry, reprocess, a copy) only fills in what it read: it never blanks a
  // known cost, tax or address, and never touches cost_override / ignored
  await q(
    `insert into amazon_lines (line_key, amazon_order_id, order_date, title, quantity, tax, line_total, ship_name, ship_address,
       ship_zip, ship_state, order_status, source, raw)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'Ordered','email',$12::jsonb)
     on conflict (line_key) do update set
       title = case when $13 or amazon_lines.title is null then excluded.title else amazon_lines.title end,
       quantity = excluded.quantity,
       line_total = case when $14 then null else coalesce(excluded.line_total, amazon_lines.line_total) end,
       tax = coalesce(excluded.tax, amazon_lines.tax), ship_name = coalesce(excluded.ship_name, amazon_lines.ship_name),
       ship_address = coalesce(excluded.ship_address, amazon_lines.ship_address), ship_zip = coalesce(excluded.ship_zip, amazon_lines.ship_zip),
       ship_state = coalesce(excluded.ship_state, amazon_lines.ship_state), raw = excluded.raw, updated_at = now()`,
    [`${id}|email|1`, id, businessDay(receivedAt || new Date()), title.slice(0, 500), qty, p.tax, total,
      p.shipName || null, p.shipText || null, p.zip || null, p.state || null, JSON.stringify({ subject, parsed: p }), titleParsed, totalUnknown]
  );
  return { ok, note };
}

// Reads one parsed email into the books. An email read before is skipped, unless it failed (it is read again: the
// order email may have arrived since, or the parser was fixed) or `force` is set (reprocess).
async function ingest(messageId, receivedAt, subject, p, { force = false } = {}) {
  const prev = await one('select ok from amazon_emails where message_id = $1', [messageId]);
  if (prev && prev.ok && !force) return 'seen';
  // Read again from scratch: whatever this email booked before is replaced by what it says now
  if (prev) await q('delete from amazon_refunds where message_id = $1', [messageId]);
  let res = { ok: true, note: '' };
  if (p.kind === 'order') res = await ingestOrder(subject, receivedAt, p);
  else if (p.kind === 'refund') {
    res = p.orderIds.length === 1 && p.refund ? await ingestRefund(messageId, receivedAt, p)
      : { ok: false, note: 'refund email without a single order number + amount' };
  } else if (p.kind === 'cancel') {
    // applyCancellations (run right after) acts on it; only a confirmed cancellation of one order ever cancels anything
    res.note = !p.confirmed ? 'cancellation not confirmed (request / attempt): nothing cancelled. Check the order on Amazon'
      : p.orderIds.length !== 1 ? 'cancellation email without a single order number: review the order in Editor'
      : 'cancellation read';
  }
  await q(
    `insert into amazon_emails (message_id, received_at, subject, kind, order_ids, ok, note, parsed, attempts, parser_version)
     values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,1,$9)
     on conflict (message_id) do update set received_at = excluded.received_at, subject = excluded.subject, kind = excluded.kind,
       order_ids = excluded.order_ids, ok = excluded.ok, note = excluded.note, parsed = excluded.parsed,
       attempts = coalesce(amazon_emails.attempts, 1) + 1, parser_version = excluded.parser_version`,
    [messageId, receivedAt, subject, p.kind, p.orderIds, res.ok, res.note, JSON.stringify(p), PARSER_VERSION]
  );
  return res.ok ? 'ok' : 'failed';
}

// A confirmed cancellation email cancels the whole Amazon purchase when it says the order was cancelled, or when the
// order had a single unit ("Item cancelled successfully" on a one-item order). One item cancelled from a multi-unit
// order leaves the cost unknown (Amazon only charges for what ships), so the sale waits for its real cost. Runs after
// every email sync, so a cancellation read before its order email, or before this rule existed, still gets applied.
export async function applyCancellations() {
  const rows = await q("select message_id, subject, order_ids, parsed, note from amazon_emails where kind = 'cancel' and array_length(order_ids, 1) = 1");
  const done = [];
  for (const r of rows) {
    const id = r.order_ids[0];
    // Emails stored before 'confirmed' existed are judged by their stored subject and text
    const confirmed = r.parsed?.confirmed ?? cancelConfirmed(`${r.subject || ''}\n${String(r.parsed?.excerpt || '').slice(0, 1500)}`);
    if (!confirmed) continue;
    const lines = await q('select line_key, quantity, order_status, line_total, source from amazon_lines where amazon_order_id = $1 and not ignored', [id]);
    if (!lines.length) continue; // the order email isn't in yet
    if (lines.every((l) => /cancel/i.test(l.order_status || ''))) continue;
    const units = lines.reduce((t, l) => t + (Number(l.quantity) || 1), 0);
    if (r.parsed?.fullOrder || units === 1) {
      await q("update amazon_lines set order_status = 'Cancelled', updated_at = now() where amazon_order_id = $1", [id]);
      await q('update amazon_emails set ok = true, note = $2 where message_id = $1', [r.message_id, r.parsed?.fullOrder ? 'order marked cancelled' : 'its only item was cancelled, so the order is marked cancelled']);
      done.push(id);
      continue;
    }
    // Part of a multi-unit email order: its Grand Total no longer is the cost. A CSV line has its own per-item status.
    const emailLines = lines.filter((l) => l.source === 'email' && l.line_total !== null);
    if (emailLines.length) await q("update amazon_lines set line_total = null, updated_at = now() where amazon_order_id = $1 and source = 'email'", [id]);
    await q('update amazon_emails set ok = false, note = $2 where message_id = $1', [r.message_id,
      `one item of this ${units}-unit order was cancelled: its Grand Total is no longer the cost. Enter the Amazon cost for this sale`]);
  }
  return done;
}

const hashId = (parts) => `sha1:${crypto.createHash('sha1').update(parts.map((x) => String(x ?? '')).join('\u0000')).digest('hex')}`;
const selfAddress = (from) => {
  const me = String(process.env.EMAIL_USER || '').toLowerCase();
  return Boolean(me) && String(from || '').toLowerCase().split(/[\s,;<>]+/).includes(me);
};

export async function ingestMessage({ messageId, subject = '', text = '', html = '', date, from = '' }, opts = {}) {
  const parsed = parseAmazonEmail({ subject, text, html, date });
  if (parsed.kind === 'other' || parsed.kind === 'shipment') return 'seen';
  if (parsed.forwarded && !parsed.fromAmazon) return 'seen'; // a forward that isn't an Amazon email
  // A forward sent FROM this account (its Sent copy shows up in Gmail's All Mail) is a copy of an email already read
  if (parsed.forwarded && selfAddress(from)) return 'seen';
  if (parsed.originalDate) date = parsed.originalDate;
  // No Message-ID (a webhook post): the email's own content is its id, so posting it twice never books it twice
  const id = messageId || hashId([subject, date, text, html]);
  const result = await ingest(id, date ? new Date(date) : null, clean(subject), parsed, opts);
  if (parsed.kind === 'cancel' || parsed.kind === 'order') await applyCancellations();
  return result;
}

// ---- mailbox access (IMAP). Tests swap in their own mailbox with useMailboxForTests().
function imapSettings() {
  const user = process.env.EMAIL_USER;
  const host = process.env.EMAIL_IMAP_HOST || (/@(gmail|googlemail)\./i.test(user) ? 'imap.gmail.com'
    : /@(outlook|hotmail|live|msn)\./i.test(user) ? 'outlook.office365.com'
    : /@yahoo\./i.test(user) ? 'imap.mail.yahoo.com'
    : /@(icloud|me|mac)\./i.test(user) ? 'imap.mail.me.com' : null);
  const mailbox = process.env.EMAIL_MAILBOX || (host === 'imap.gmail.com' ? '[Gmail]/All Mail' : 'INBOX');
  return { user, host, mailbox };
}

async function openImap() {
  const { user, host, mailbox } = imapSettings();
  if (!host) throw Object.assign(new Error('Set EMAIL_IMAP_HOST for this email provider'), { config: true });
  const client = new ImapFlow({
    host, port: Number(process.env.EMAIL_IMAP_PORT || 993), secure: true,
    auth: { user, pass: process.env.EMAIL_PASSWORD }, logger: false,
  });
  await client.connect();
  let lock;
  try { lock = await client.getMailboxLock(mailbox); } catch (e) { await client.logout().catch(() => {}); throw e; }
  const headers = async (uids) => {
    const out = [];
    for await (const msg of client.fetch(uids || [], { envelope: true }, { uid: true })) {
      out.push({
        uid: msg.uid, messageId: msg.envelope?.messageId || `${msg.uid}@${mailbox}`, subject: msg.envelope?.subject || '',
        from: (msg.envelope?.from || []).map((a) => a.address || '').join(' '),
      });
    }
    return out;
  };
  return {
    // Amazon's own emails, plus Amazon emails forwarded into this inbox (e.g. from the old address)
    list: async (since) => headers(await client.search({ since, or: [{ from: 'amazon.com' }, { subject: 'Ordered' }, { subject: 'Refund' }, { subject: 'cancel' }] }, { uid: true })),
    // Particular emails by Message-ID (failed ones being read again, however old)
    byIds: async (ids) => {
      const uids = [];
      for (const id of ids) uids.push(...((await client.search({ header: { 'message-id': id } }, { uid: true })) || []));
      return uids.length ? headers(uids) : [];
    },
    read: async (h) => {
      const msg = await client.fetchOne(String(h.uid), { source: true }, { uid: true });
      const mail = await simpleParser(msg.source);
      return { messageId: mail.messageId || h.messageId, subject: mail.subject, text: mail.text, html: mail.html, date: mail.date, from: h.from || mail.from?.text || '' };
    },
    close: async () => { try { lock.release(); } finally { await client.logout(); } },
  };
}
let openMailbox = openImap;
export function useMailboxForTests(factory) { openMailbox = factory || openImap; }

// Whether a header is worth downloading: an Amazon order / refund / cancellation email, or a forward of one
function wantedHeader(h) {
  if (['other', 'shipment'].includes(classify(h.subject || '', ''))) return false;
  const isForward = /^\s*(fwd?|fw)\s*:/i.test(h.subject || '');
  if (isForward && selfAddress(h.from)) return false; // our own Sent copy of a forward
  return /amazon\.com/i.test(h.from || '') || isForward;
}

// Failed emails that are read again on the next sync: recent ones, a few times, and once more after a parser change
async function retryableFailed() {
  return (await q(
    `select message_id from amazon_emails where not ok and not coalesce(dismissed, false)
       and coalesce(received_at, created_at) > now() - make_interval(days => $1)
       and (coalesce(attempts, 1) < $2 or coalesce(parser_version, 1) <> $3)
     order by received_at desc nulls last limit 50`, [FAILED_WINDOW_DAYS, MAX_TRIES, PARSER_VERSION])).map((r) => r.message_id);
}

const fmtFailed = (failed) => `${failed.length} Amazon email${failed.length > 1 ? 's' : ''} could not be read and need${failed.length > 1 ? '' : 's'} a look: ${failed.slice(0, 3).map((f) => `"${String(f.subject || '').slice(0, 60)}" (${f.reason})`).join('; ')}`;

let running = null;
export async function syncEmail() {
  if (!emailConfigured()) return { ok: false, log: ['Email not configured: set EMAIL_USER and EMAIL_PASSWORD'] };
  if (running) return running;
  running = (async () => {
    const last = await getSetting('email_last_sync');
    const since = last
      ? new Date(new Date(last).getTime() - 3 * 86400_000)
      : new Date(Date.now() - Number(process.env.EMAIL_BACKFILL_DAYS || 120) * 86400_000);
    const startedAt = new Date().toISOString();
    const counts = { ok: 0, failed: 0, seen: 0 };
    let box = null;
    try {
      box = await openMailbox();
      const errors = [];
      try {
        // Headers first (cheap), then download only order / refund / cancellation emails not read yet, plus the ones
        // that failed before (they are read again until they work, however old)
        const headers = (await box.list(since)).filter(wantedHeader);
        const retry = new Set(await retryableFailed());
        const listed = new Set(headers.map((h) => h.messageId));
        const missing = [...retry].filter((id) => !listed.has(id));
        if (missing.length) headers.push(...(await box.byIds(missing)).filter((h) => !listed.has(h.messageId)));
        const wanted = [];
        for (const h of headers) {
          if (!retry.has(h.messageId) && (await one('select 1 from amazon_emails where message_id = $1', [h.messageId]))) { counts.seen++; continue; }
          wanted.push(h);
        }
        for (const h of wanted) {
          try {
            counts[await ingestMessage(await box.read(h))]++;
          } catch (e) {
            // One bad email never stops the rest; it is stored as failed so it is read again next time
            counts.failed++;
            errors.push(e.message);
            await q(`insert into amazon_emails (message_id, received_at, subject, kind, order_ids, ok, note, attempts, parser_version)
                     values ($1, now(), $2, $3, '{}', false, $4, 1, $5)
                     on conflict (message_id) do update set ok = false, note = excluded.note, attempts = coalesce(amazon_emails.attempts, 1) + 1`,
            [h.messageId, h.subject, classify(h.subject || ''), `could not be read: ${e.message}`.slice(0, 300), PARSER_VERSION]).catch(() => {});
          }
        }
      } finally {
        await box.close().catch(() => {});
      }
      await setSetting('email_last_sync', startedAt);
      const cancelled = await applyCancellations();
      const m = await runMatcher();
      const log = [`emails: ${counts.ok} imported, ${counts.failed} need review, ${counts.seen} already seen`, `matcher: ${m.linked} new links`];
      if (cancelled.length) log.push(`cancelled Amazon orders: ${cancelled.join(', ')}`);
      if (errors.length) log.push(`errors: ${errors.slice(0, 3).join('; ')}`);
      // Emails that could not be read (no order number, a gift card, several orders under one total...) leave a sale
      // without its cost, so the sync is not "ok" until they are sorted out or dismissed
      const failed = await failedEmails();
      if (failed.length) log.push(fmtFailed(failed));
      await setSetting('email_last_result', { ok: failed.length === 0, connected: true, failed: failed.length, at: startedAt, log });
      return { ok: failed.length === 0, log };
    } catch (e) {
      const msg = e.config ? e.message
        : /auth/i.test(e.message + (e.responseText || '')) ? `Login failed: ${e.responseText || e.message}. Use an app password.` : e.message;
      await setSetting('email_last_result', { ok: false, connected: false, at: startedAt, log: [msg] });
      return { ok: false, log: [msg] };
    } finally {
      running = null;
    }
  })();
  return running;
}

// Read every Amazon email again with the current parser, WITHOUT clearing anything first: costs, refunds and links
// stay as they are until each email's new reading replaces its own old one. If the mailbox can't be read, nothing
// changes. Never overlaps a sync (it waits for one in flight). Links, cost overrides and ignored flags are kept.
export async function reprocessEmail() {
  if (!emailConfigured()) return { ok: false, log: ['Email not configured: set EMAIL_USER and EMAIL_PASSWORD'] };
  while (running) await running.catch(() => {});
  running = (async () => {
    const startedAt = new Date().toISOString();
    const counts = { ok: 0, failed: 0, seen: 0 };
    const staged = [];
    try {
      // 1. Stage: download everything first. Any mailbox failure stops here, before a single row changes.
      try {
        const oldest = await one('select min(received_at) as at from amazon_emails');
        const backfill = Date.now() - Number(process.env.EMAIL_BACKFILL_DAYS || 120) * 86400_000;
        const since = new Date(Math.min(backfill, oldest?.at ? new Date(oldest.at).getTime() - 2 * 86400_000 : backfill));
        const box = await openMailbox();
        try {
          for (const h of (await box.list(since)).filter(wantedHeader)) staged.push(await box.read(h));
        } finally {
          await box.close().catch(() => {});
        }
      } catch (e) {
        return { ok: false, log: [`Reprocess stopped before changing anything: ${e.message}`] };
      }
      // 2. Apply: each email replaces only what it booked before
      const wasCancelling = new Map((await q(
        "select message_id, order_ids from amazon_emails where kind = 'cancel' and array_length(order_ids, 1) = 1")).map((r) => [r.message_id, r.order_ids[0]]));
      const reread = new Set();
      try {
        for (const mail of staged) {
          try { counts[await ingestMessage(mail, { force: true })]++; reread.add(mail.messageId); } catch { counts.failed++; }
        }
        // A cancellation an email used to make (a "Noise Cancelling" title, a cancellation REQUEST) is undone when, read
        // again, no confirmed cancellation remains for that order
        for (const [mid, orderId] of wasCancelling) {
          if (!reread.has(mid)) continue;
          const still = await q("select subject, parsed from amazon_emails where kind = 'cancel' and order_ids = array[$1]::text[]", [orderId]);
          if (still.some((r) => r.parsed?.confirmed ?? cancelConfirmed(`${r.subject || ''}
${String(r.parsed?.excerpt || '').slice(0, 1500)}`))) continue;
          await q("update amazon_lines set order_status = 'Ordered', updated_at = now() where amazon_order_id = $1 and source = 'email' and order_status ~* 'cancel'", [orderId]);
        }
        await applyCancellations();
      } finally {
        await runMatcher().catch(() => {});
      }
      const failed = await failedEmails();
      const log = [`reprocessed ${staged.length} emails: ${counts.ok} read, ${counts.failed} need review, ${counts.seen} skipped`];
      if (failed.length) log.push(fmtFailed(failed));
      await setSetting('email_last_result', { ok: failed.length === 0, connected: true, failed: failed.length, at: startedAt, log });
      return { ok: failed.length === 0, log };
    } finally {
      running = null;
    }
  })();
  return running;
}

// Emails from the last 60 days that could not be fully read and still leave something unsorted. An order email is
// sorted once its Amazon order has a known cost (or a typed-in cost on its sale) and is linked; a refund or other
// email stays until it is dismissed.
export async function failedEmails() {
  const rows = await q(
    `select message_id, subject, received_at, kind, order_ids, note from amazon_emails
     where not ok and not coalesce(dismissed, false) and coalesce(received_at, created_at) > now() - make_interval(days => $1)
     order by received_at desc nulls last`, [FAILED_WINDOW_DAYS]);
  const out = [];
  for (const r of rows) {
    let sorted = false;
    if (['order', 'cancel'].includes(r.kind) && r.order_ids?.length) {
      sorted = true;
      for (const id of r.order_ids) {
        const s = await one(
          `select count(*)::int as n, bool_and(l.cost_override is not null or l.line_total is not null) as costed,
                  bool_or(k.ebay_order_id is not null) as linked, bool_or(o.cost_override is not null) as sale_costed
           from amazon_lines l left join order_links k on k.amazon_order_id = l.amazon_order_id
           left join order_overrides o on o.order_id = k.ebay_order_id
           where l.amazon_order_id = $1`, [id]);
        if (!(s?.n > 0 && s.linked && (s.costed || s.sale_costed))) sorted = false;
      }
    }
    if (!sorted) out.push({ message_id: r.message_id, subject: r.subject, received_at: r.received_at ? new Date(r.received_at).toISOString() : null, kind: r.kind, order_ids: r.order_ids || [], reason: r.note || 'could not be read' });
  }
  return out;
}

// "I've dealt with this one": a failed email stops warning (and is no longer retried)
export async function dismissFailedEmail(messageId) {
  const rows = await q('update amazon_emails set dismissed = true where message_id = $1 returning message_id', [messageId]);
  return { ok: rows.length > 0 };
}

export async function emailStatus() {
  const [last, failed, sharedOrders] = await Promise.all([getSetting('email_last_result'), failedEmails(), sharedOrderSuggestions().catch(() => [])]);
  return {
    configured: emailConfigured(),
    user: process.env.EMAIL_USER ? process.env.EMAIL_USER.replace(/^(.{2}).*(@.*)$/, '$1•••$2') : null,
    running: Boolean(running),
    last,
    // Emails that couldn't be read: each one may be a sale without its Amazon cost
    failed,
    // One Amazon order that looks like the purchase for two (or more) eBay sales: needs a hand split of the cost
    sharedOrders,
  };
}
