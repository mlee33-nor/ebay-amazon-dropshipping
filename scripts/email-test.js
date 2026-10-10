// Regression tests for the Amazon email side of the accounting audit: refund copies booked twice, parser bugs
// (accents, "cancel" in a subject, legacy shipped emails, gift cards, quantity), failed emails retried and surfaced,
// one Amazon order for two sales, cancelled orders as rivals, and a safe "reprocess emails".
// Part 1 loads the read-only production snapshot (Sep 719.55 / Oct 240.87); part 2 uses small fixtures.
// Throwaway database on its own port; never touches real data or a real mailbox.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-email-'));
process.env.LOCAL_PG_DIR = dir;
process.env.LOCAL_PG_PORT = String(5600 + Number(process.env.TEST_PG_OFFSET || 0)); // TEST_PG_OFFSET lets parallel runs use their own ports
delete process.env.DATABASE_URL;
// A fake mailbox account: every mailbox call goes to the stub below, never to a real IMAP server
process.env.EMAIL_USER = 'partner@example.com';
process.env.EMAIL_PASSWORD = 'not-a-real-password';
const { initDb, q, closeDb } = await import('../src/db.js');
const { normalizeOrder, upsertOrder } = await import('../src/ebay.js');
const email = await import('../src/email.js');
const { ingestMessage, parseAmazonEmail, classify, emailStatus, syncEmail, reprocessEmail, useMailboxForTests, dismissFailedEmail } = email;
const { runMatcher, sharedOrderSuggestions } = await import('../src/matcher.js');
const { buildDataset, buildBooks } = await import('../src/dataset.js');
const { settleMonth } = await import('../public/js/settlement.js');
await initDb();

let failed = false;
const check = async (label, fn) => { try { await fn(); console.log(`  PASS  ${label}`); } catch (e) { failed = true; console.log(`  FAIL  ${label}\n        ${e.message}`); } };
const sends = async (month) => {
  const data = await buildDataset();
  const { expenses, settlements } = await buildBooks();
  return settleMonth({ month, orders: data, expenses, settlements, splitAmazon: 50 }).sellerSends;
};
// A stub mailbox: `mails` are full messages ({messageId, subject, text, date, from}); list() returns their headers
const mailbox = (mails, { fail } = {}) => async () => {
  if (fail) throw new Error(fail);
  const head = (m, i) => ({ uid: i + 1, messageId: m.messageId, subject: m.subject, from: m.from || 'auto-confirm@amazon.com' });
  return {
    list: async () => mails.map(head),
    byIds: async (ids) => mails.map(head).filter((h) => ids.includes(h.messageId)),
    read: async (h) => ({ from: 'auto-confirm@amazon.com', ...mails[h.uid - 1] }),
    close: async () => {},
  };
};

// ---------------------------------------------------------------- parser (no database)
console.log('parser');
await check('accented / curly-apostrophe first name and city are read ("José - MIAMI, FL", "Wayné - O’FALLON, MO")', async () => {
  const p = parseAmazonEmail({ subject: 'Ordered: 1 Toy item', text: 'Thanks for your order!\nJosé - MIAMI, FL\nOrder #\n111-0000001-0000009\nGrand Total:\n$12.00' });
  assert.equal(p.shipName, 'José');
  assert.equal(p.shipCity, 'MIAMI');
  assert.equal(p.state, 'FL');
  const p2 = parseAmazonEmail({ subject: 'Ordered: 1 Toy item', text: 'Wayné - O’FALLON, MO\nOrder #\n111-0000001-0000008\nGrand Total:\n$12.00' });
  assert.equal(p2.shipName, 'Wayné');
  assert.equal(p2.shipCity, 'O’FALLON');
});
await check('"cancel" in a product title or a cancellation REQUEST never makes a confirmed cancellation', async () => {
  assert.equal(classify('Ordered: "Wireless Noise Cancelling Earbuds"', ''), 'order');
  assert.equal(classify('Your Amazon.com order of Noise Canceling Headphones has shipped', ''), 'shipment');
  const req = parseAmazonEmail({ subject: 'Your cancellation request for order #111-0000010-0000001', text: "We've received your request to cancel. We're attempting to cancel the items." });
  assert.equal(req.kind, 'cancel');
  assert.equal(req.confirmed, false);
  const done = parseAmazonEmail({ subject: 'Item canceled successfully', text: 'We have canceled 1 item from your order.\nOrder #111-0000004-0000001\nYou have not been charged for this item.' });
  assert.equal(done.confirmed, true);
  const unable = parseAmazonEmail({ subject: 'Update on your cancellation', text: 'We were unable to cancel order #111-0000010-0000001 because it has already shipped.' });
  assert.equal(unable.confirmed, false);
});
await check('a legacy "Your Amazon.com order … has shipped" email is a shipment, not an order', async () => {
  assert.equal(classify('Your Amazon.com order #111-0000005-0000001 has shipped', ''), 'shipment');
  assert.equal(classify('Your Amazon.com order #111-0000005-0000001', ''), 'order');
});
await check('a partial gift-card payment is seen ("Gift Card Amount: -$10.00", Grand Total 16.74)', async () => {
  const p = parseAmazonEmail({ subject: 'Ordered: 1 Camera item', text: 'Ezra - ATLANTA, GA\nOrder #\n111-0000006-0000001\nItem Subtotal: $24.99\nGift Card Amount: -$10.00\nGrand Total:\n$16.74' });
  assert.equal(p.giftCard, 10);
  assert.equal(p.total, 16.74);
  const plain = parseAmazonEmail({ subject: 'Ordered: 1 Camera item', text: 'Ezra - ATLANTA, GA\nOrder #\n111-0000006-0000002\nGrand Total:\n$16.74\nShop Amazon Gift Cards' });
  assert.equal(plain.giftCard, null);
});
await check('quantity: the body quantity of the subject item counts once; "and 2 more items" is at least 3 units', async () => {
  const text = 'Kim - OMAHA, NE\nOrder #\n111-0000007-0000001\nPEHUAP Weed Eater Spool Cover Replacement for Ryobi\nQuantity: 2\nGrand Total:\n$23.90';
  const p = parseAmazonEmail({ subject: 'Ordered: "PEHUAP Weed Eater Spool Cover..."', text, html: `<p>${text.replace(/\n/g, '<br>')}</p>` });
  assert.equal(p.quantity, 2);
  const more = parseAmazonEmail({ subject: 'Ordered: "Geelin Hero Skyscraper Centerpieces" and 2 more items', text: 'Kim - OMAHA, NE\nOrder #\n111-0000007-0000002\nGrand Total:\n$40.00' });
  assert.equal(more.quantity, 3);
});
await check('"refund is being processed" is a note; "Refund issued" is booked', async () => {
  assert.equal(parseAmazonEmail({ subject: 'Your refund is being processed', text: 'Order # 111-0000008-0000001\nRefund total: $26.12' }).pending, true);
  assert.equal(parseAmazonEmail({ subject: 'Refund issued for Pet Hair Remover', text: 'Your refund was issued.\nOrder # 111-0000008-0000001\nTotal refund $26.12' }).pending, false);
});

// ---------------------------------------------------------------- part 1: the production snapshot
console.log('production snapshot');
const AUDIT = process.env.AUDIT_SNAPSHOT || 'C:/Users/mleet/AppData/Local/Temp/claude/C--Users-mleet-Desktop-house/5b0fc352-7427-40e2-af9e-d8b4696b7af9/scratchpad/audit/raw.json';
const SNAP_TIME = Date.parse('2026-10-10T19:00:00Z');
const realNow = Date.now;
if (fs.existsSync(AUDIT)) {
  const raw = JSON.parse(fs.readFileSync(AUDIT, 'utf8'));
  const JSONB = new Set(['raw', 'value', 'parsed', 'row_keys', 'totals']);
  const DATES = new Set(['order_date', 'paid_at']);
  for (const table of ['ebay_orders', 'ebay_line_items', 'ebay_transactions', 'ebay_returns', 'amazon_lines', 'order_links', 'order_overrides',
    'amazon_refunds', 'ledger_entries', 'settlements', 'expenses', 'settings']) {
    for (const row of raw[table] || []) {
      const cols = Object.keys(row);
      const vals = cols.map((c) => (row[c] === null ? null : JSONB.has(c) ? JSON.stringify(row[c]) : DATES.has(c) ? String(row[c]).slice(0, 10) : row[c]));
      await q(`insert into ${table} (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, vals);
    }
  }
  // What initDb does for payments recorded before the payments table existed
  await q(`insert into settlement_payments (month, amount, paid_at, note) select s.month, s.paid, s.paid_at, coalesce(s.note, '') from settlements s
    where s.paid is not null and not exists (select 1 from settlement_payments p where p.month = s.month)`);
  Date.now = () => SNAP_TIME; // the snapshot's own day, so no sale ages out while the books are compared
  const base = { sep: await sends('2026-09'), oct: await sends('2026-10') };
  // The audit read Oct as 240.87 on the version deployed when the snapshot was taken; this code base also books the
  // Mozi Wash refund line on Oct (213.08). Every check below compares against this baseline: email work must not move it.
  await check(`snapshot baseline: Sep sends ${base.sep} (audit 719.55), Oct sends ${base.oct}`, async () => {
    assert.equal(base.sep, 719.55);
    assert.ok(Number.isFinite(base.oct));
  });
  const unchanged = async (what) => {
    assert.equal(await sends('2026-09'), base.sep, `Sep after ${what}`);
    assert.equal(await sends('2026-10'), base.oct, `Oct after ${what}`);
  };

  await check('SEALIGHT: with its links removed, the cancelled first order is no rival and the replacement relinks; Oct stays', async () => {
    await q("delete from order_links where ebay_order_id = '15-15253-44046'");
    await runMatcher();
    const links = (await q("select amazon_order_id from order_links where ebay_order_id = '15-15253-44046'")).map((r) => r.amazon_order_id);
    assert.deepEqual(links, ['112-2746814-8118619']);
    await unchanged('relinking SEALIGHT');
  });

  await check('HHLPRO: a forwarded copy of "Refund issued" (new Message-ID, $104.79) is not booked again; Oct stays', async () => {
    await ingestMessage({ messageId: '<fwd-hhlpro@example.com>', subject: 'Fwd: Refund issued for HHLPRO UHF Wireless XLR...', date: '2026-10-10T16:00:00Z',
      text: '---------- Forwarded message ---------\nFrom: Amazon.com <return@amazon.com>\nDate: Fri, Oct 9, 2026 at 10:52 AM\nSubject: Refund issued for HHLPRO UHF Wireless XLR...\n\nYour refund was issued.\nOrder # 111-9229079-9782641\nTotal refund $104.79\n' });
    const rows = await q("select amount from amazon_refunds where amazon_order_id = '111-9229079-9782641'");
    assert.equal(rows.length, 1);
    const note = await q("select ok, note from amazon_emails where message_id = '<fwd-hhlpro@example.com>'");
    assert.match(note[0].note, /duplicate copy/);
    await unchanged('the forwarded copy');
  });
  await check('HHLPRO: our own Sent copy of a forward ("Fwd:" from this account) is skipped outright', async () => {
    const r = await ingestMessage({ messageId: '<sent-copy@example.com>', from: 'partner@example.com', subject: 'Fwd: Refund issued for HHLPRO UHF Wireless XLR...', date: '2026-10-10T16:05:00Z',
      text: '---------- Forwarded message ---------\nFrom: Amazon.com <return@amazon.com>\nSubject: Refund issued\n\nOrder # 111-9229079-9782641\nTotal refund $104.79\n' });
    assert.equal(r, 'seen');
    assert.equal((await q("select 1 from amazon_refunds where amazon_order_id = '111-9229079-9782641'")).length, 1);
    await unchanged('the Sent copy');
  });
  await check('Govee: a webhook post without a Message-ID, sent twice, books nothing new', async () => {
    const m = { subject: 'Your refund for Govee Control Box', date: '2026-09-24T03:23:59Z', text: 'Refund issued\nOrder # 111-8776178-7476264\nRefund total: $42.89\n' };
    await ingestMessage(m);
    await ingestMessage(m);
    assert.equal((await q("select 1 from amazon_refunds where amazon_order_id = '111-8776178-7476264'")).length, 1);
    await unchanged('the webhook copies');
  });

  // Every email-sourced line and refund in the snapshot, as the emails that made them
  const snapMails = [];
  const fmt = (n) => Number(n).toFixed(2);
  for (const l of raw.amazon_lines.filter((x) => x.source === 'email')) {
    const [first, ...rest] = String(l.ship_address).split(' ');
    const cityState = rest.join(' ');
    const cat = String(l.title).replace(/ \(.*$/, '');
    snapMails.push({ messageId: `<order-${l.amazon_order_id}@amazon.com>`, subject: `Ordered: ${l.quantity} ${cat} item${l.quantity > 1 ? 's' : ''}`, date: `${String(l.order_date).slice(0, 10)}T19:00:00Z`,
      text: `Thanks for your order!\n${first} - ${cityState}\nOrder #\n${l.amazon_order_id}\n${l.line_total === null ? '' : `Grand Total:\n$${fmt(l.line_total)}`}\n` });
    if (/cancel/i.test(l.order_status)) snapMails.push({ messageId: `<cancel-${l.amazon_order_id}@amazon.com>`, subject: `Your Amazon.com order #${l.amazon_order_id} has been canceled`, date: `${String(l.order_date).slice(0, 10)}T20:00:00Z`,
      text: `Your order #${l.amazon_order_id} has been canceled. You have not been charged.` });
  }
  for (const r of raw.amazon_refunds) snapMails.push({ messageId: r.message_id, subject: r.title ? `Refund issued for ${r.title}...` : 'Your refund', date: r.received_at,
    text: `Your refund was issued.\nOrder # ${r.amazon_order_id}\nTotal refund $${fmt(r.amount)}\n` });
  const counts = async () => (await q(`select (select count(*) from amazon_lines)::int as lines, (select count(*) from order_links)::int as links,
    (select count(*) from amazon_refunds)::int as refunds, (select coalesce(sum(line_total), 0) from amazon_lines)::text as cost`))[0];

  await check('Reprocess with the mailbox failing changes nothing: Sep and Oct, lines, links and refunds all stay', async () => {
    const before = await counts();
    useMailboxForTests(mailbox([], { fail: 'IMAP connection refused' }));
    const r = await reprocessEmail();
    assert.equal(r.ok, false);
    assert.match(r.log[0], /before changing anything/);
    assert.deepEqual(await counts(), before);
    await unchanged('a failed reprocess');
  });
  await check('Reprocess re-reads every email in place: nothing is deleted first and Sep / Oct come out the same', async () => {
    const before = await counts();
    useMailboxForTests(mailbox(snapMails));
    const r = await reprocessEmail();
    assert.match(r.log[0], new RegExp(`reprocessed ${snapMails.length} emails`));
    const after = await counts();
    assert.equal(after.lines, before.lines);
    assert.equal(after.refunds, before.refunds);
    assert.equal(after.cost, before.cost);
    assert.ok(after.links >= before.links, 'no link lost');
    await unchanged('a full reprocess');
  });
  await check('Reprocess never overlaps a sync in flight (it waits for it)', async () => {
    useMailboxForTests(mailbox(snapMails));
    const order = [];
    const a = syncEmail().then(() => order.push('sync'));
    const b = reprocessEmail().then(() => order.push('reprocess'));
    await Promise.all([a, b]);
    assert.deepEqual(order, ['sync', 'reprocess']);
    await unchanged('sync + reprocess');
  });
  Date.now = realNow;
} else console.log(`  SKIP  snapshot checks (no ${AUDIT})`);
useMailboxForTests(null);

// ---------------------------------------------------------------- part 2: fixtures
console.log('fixtures');
for (const t of ['ebay_orders', 'ebay_line_items', 'ebay_transactions', 'ebay_returns', 'amazon_lines', 'order_links', 'order_overrides', 'amazon_refunds',
  'amazon_emails', 'ledger_entries', 'settlements', 'settlement_payments', 'settlement_freeze', 'expenses', 'link_rejections', 'settings']) await q(`delete from ${t}`);

const day = (d, h = 18) => new Date(Date.now() - d * 86400_000 + (h - 12) * 3600_000).toISOString(); // d days ago
const order = (id, at, title, price, { name, city, st, qty = 1, fee = +(price * 0.136).toFixed(2) } = {}) =>
  upsertOrder(normalizeOrder({
    orderId: id, creationDate: at, orderFulfillmentStatus: 'FULFILLED', cancelStatus: { cancelState: 'NONE_REQUESTED' },
    pricingSummary: { priceSubtotal: { value: String(price) }, total: { value: String(price) } }, totalMarketplaceFee: { value: String(fee) },
    fulfillmentStartInstructions: [{ shippingStep: { shipTo: { fullName: name, contactAddress: { city, stateOrProvince: st } } } }],
    lineItems: [{ lineItemId: `${id}-1`, title, quantity: qty, lineItemCost: { value: String(price) }, total: { value: String(price) } }],
  }));
let n = 0;
const orderMail = ({ id, ship, total, subject = 'Ordered: 1 Home item', at, extra = '', messageId }) => ingestMessage({
  messageId: messageId || `<fx${++n}@amazon.com>`, subject, date: at,
  text: `Thanks for your order!\n${ship}\nOrder #\n${id}\n${extra}${total === undefined ? '' : `Grand Total:\n$${total}\n`}`,
});
const mail = (subject, text, at, messageId) => ingestMessage({ messageId: messageId || `<fx${++n}@amazon.com>`, subject, text, date: at });
const sale = async (id) => (await buildDataset()).find((o) => o.order_id === id);
const lineTotal = async (id) => (await q('select line_total from amazon_lines where amazon_order_id = $1', [id]))[0]?.line_total;

await check('accents: "José - MIAMI, FL" links to the eBay sale of José (or Jose) Garcia in Miami', async () => {
  await order('ACC-1', day(3), 'Bamboo Cutting Board Set', 40, { name: 'José Garcia', city: 'Miami', st: 'FL' });
  await order('ACC-2', day(3, 10), 'Oak Wall Shelf Floating', 45, { name: 'Wayne Price', city: "O'Fallon", st: 'MO' });
  await orderMail({ id: '111-0000020-0000001', ship: 'José - MIAMI, FL', total: '22.10', at: day(3, 19) });
  await orderMail({ id: '111-0000020-0000002', ship: 'Wayne - O’FALLON, MO', total: '25.10', at: day(3, 11) });
  await runMatcher();
  assert.deepEqual((await q("select amazon_order_id from order_links where ebay_order_id = 'ACC-1'")).map((r) => r.amazon_order_id), ['111-0000020-0000001']);
  assert.deepEqual((await q("select amazon_order_id from order_links where ebay_order_id = 'ACC-2'")).map((r) => r.amazon_order_id), ['111-0000020-0000002']);
  assert.equal((await sale('ACC-1')).cost, 22.1);
});

await check('"Your cancellation request" does not cancel a 1-unit $52.08 purchase: the sale stays profitable', async () => {
  await order('REQ-1', day(4), 'Heavy Duty Shelf Brackets 12 Pack', 89.99, { name: 'Jennifer Hale', city: 'Tulsa', st: 'OK' });
  await orderMail({ id: '111-0000010-0000001', ship: 'Jennifer - TULSA, OK', total: '52.08', at: day(4, 19) });
  await runMatcher();
  await mail('Your cancellation request for order #111-0000010-0000001', "We've received your request to cancel. We'll attempt to cancel the items.", day(4, 20));
  const lines = await q("select order_status, line_total from amazon_lines where amazon_order_id = '111-0000010-0000001'");
  assert.equal(lines[0].order_status, 'Ordered');
  const o = await sale('REQ-1');
  assert.equal(o.cost, 52.08);
  assert.equal(o.status, 'profitable');
});

await check('"Ordered: "Wireless Noise Cancelling Earbuds"" ($28.40) is stored as an order', async () => {
  const r = await orderMail({ id: '111-0000011-0000001', ship: 'Tom - BOISE, ID', total: '28.40', subject: 'Ordered: "Wireless Noise Cancelling Earbuds"', at: day(2) });
  assert.equal(r, 'ok');
  assert.equal(await lineTotal('111-0000011-0000001'), '28.40');
  assert.equal((await q("select kind from amazon_emails where order_ids = array['111-0000011-0000001']"))[0].kind, 'order');
});

await check('a legacy "has shipped" email after the order never blanks its $27.43 cost or address', async () => {
  await orderMail({ id: '111-0000005-0000001', ship: 'darwin - CANOGA PARK, CA', total: '27.43', at: day(5) });
  await mail('Your Amazon.com order #111-0000005-0000001 has shipped', 'Your package is on the way.\nOrder #111-0000005-0000001\n', day(4));
  const l = (await q("select line_total, ship_name, ship_state from amazon_lines where amazon_order_id = '111-0000005-0000001'"))[0];
  assert.equal(l.line_total, '27.43');
  assert.equal(l.ship_name, 'darwin');
  // A second reading with no total (or a copy) never blanks it either
  await orderMail({ id: '111-0000005-0000001', ship: 'darwin - CANOGA PARK, CA', at: day(5), messageId: '<copy-no-total@amazon.com>' });
  assert.equal(await lineTotal('111-0000005-0000001'), '27.43');
});

await check('gift card: "Gift Card Amount: -$10.00" with Grand Total 16.74 stores an unknown cost and flags the email', async () => {
  const r = await orderMail({ id: '111-0000006-0000001', ship: 'Ezra - ATLANTA, GA', total: '16.74', subject: 'Ordered: 1 Camera item', at: day(2), extra: 'Item Subtotal: $26.74\nGift Card Amount: -$10.00\n' });
  assert.equal(r, 'failed');
  assert.equal(await lineTotal('111-0000006-0000001'), null);
  const e = (await q("select ok, note from amazon_emails where order_ids = array['111-0000006-0000001']"))[0];
  assert.equal(e.ok, false);
  assert.match(e.note, /gift card/);
});

await check('refunds: "being processed" + "Refund issued" for a $26.12 order book $26.12 once', async () => {
  await orderMail({ id: '111-0000012-0000001', ship: 'Roberto - BROOKLYN, NY', total: '26.12', at: day(6) });
  await mail('Your refund is being processed', 'We are processing your return.\nOrder # 111-0000012-0000001\nRefund total: $26.12', day(3, 9));
  await mail('Refund issued for Pet Hair Remover Roller...', 'Your refund was issued.\nOrder # 111-0000012-0000001\nTotal refund $26.12', day(3, 15));
  const rows = await q("select amount from amazon_refunds where amazon_order_id = '111-0000012-0000001'");
  assert.deepEqual(rows.map((r) => r.amount), ['26.12']);
});
await check('refunds: two differently worded emails for one refund (same order, amount, day) book it once', async () => {
  await mail('Your refund for Pet Hair Remover Roller', 'Refund issued\nOrder # 111-0000012-0000001\nRefund total: $26.12', day(3, 17));
  assert.equal((await q("select 1 from amazon_refunds where amazon_order_id = '111-0000012-0000001'")).length, 1);
});
await check('refunds: never more than the order cost ($26.12): the same $26.12 again on another day is not booked', async () => {
  await mail('Refund issued for Pet Hair Remover Roller...', 'Your refund was issued.\nOrder # 111-0000012-0000001\nTotal refund $26.12', day(1), '<late-copy@amazon.com>');
  assert.equal((await q("select sum(amount)::text s from amazon_refunds where amazon_order_id = '111-0000012-0000001'"))[0].s, '26.12');
  assert.match((await q("select note from amazon_emails where message_id = '<late-copy@amazon.com>'"))[0].note, /duplicate/);
});
await check('refunds: a different amount that would pass the cost is not booked and is flagged for a look', async () => {
  const r = await mail('Refund issued for Pet Hair Remover Roller...', 'Your refund was issued.\nOrder # 111-0000012-0000001\nTotal refund $5.00', day(1));
  assert.equal(r, 'failed');
  assert.equal((await q("select sum(amount)::text s from amazon_refunds where amazon_order_id = '111-0000012-0000001'"))[0].s, '26.12');
});
await check('refunds: a partial second refund is capped at what is left of the cost', async () => {
  await orderMail({ id: '111-0000013-0000001', ship: 'Ann - RENO, NV', total: '30.00', at: day(6) });
  await mail('Refund issued for Lamp...', 'Your refund was issued.\nOrder # 111-0000013-0000001\nTotal refund $20.00', day(4));
  const r = await mail('Refund issued for Lamp Shade...', 'Your refund was issued.\nOrder # 111-0000013-0000001\nTotal refund $15.00', day(2));
  assert.equal(r, 'failed');
  const rows = await q("select amount, email_amount from amazon_refunds where amazon_order_id = '111-0000013-0000001' order by received_at");
  assert.deepEqual(rows.map((x) => [x.amount, x.email_amount]), [['20.00', '20.00'], ['10.00', '15.00']]);
});

await check('partial cancel: 1 of 2 units cancelled on a $81.30 order leaves the 2-unit sale needing its cost', async () => {
  await order('S4', day(5), 'Thyle 12 Sets Weaving Loom Kit', 151.98, { name: 'george rice', city: 'Nashville', st: 'IN', qty: 2 });
  await orderMail({ id: '111-0000004-0000001', ship: 'george - NASHVILLE, IN', total: '81.30', subject: 'Ordered: 2 Arts & Crafts items', at: day(5, 19) });
  await runMatcher();
  assert.equal((await sale('S4')).cost, 81.3);
  await mail('Item canceled successfully', 'Hello george,\nWe have canceled 1 item from your order as you requested.\nOrder #111-0000004-0000001\nQuantity: 1\nYou have not been charged for this item.', day(5, 20));
  const l = (await q("select line_total, order_status from amazon_lines where amazon_order_id = '111-0000004-0000001'"))[0];
  assert.equal(l.line_total, null);
  assert.equal(l.order_status, 'Ordered');
  const o = await sale('S4');
  assert.equal(o.has_cost, false);
  assert.equal(o.counted, false);
  assert.equal(o.status, 'awaiting_cost');
});

await check('units: a 2-unit sale bought as one 2-unit Amazon order is full; a second order from that buyer is not linked to it', async () => {
  await order('U2', day(6), 'Veemoon 10-Inch Brass Splash Cymbal', 55.98, { name: 'Ronald Schmitt', city: 'Cranston', st: 'RI', qty: 2 });
  await orderMail({ id: '111-0000014-0000001', ship: 'Ronald - CRANSTON, RI', total: '29.94', subject: 'Ordered: 2 Musical Instruments items', at: day(6, 19) });
  await runMatcher();
  await orderMail({ id: '111-0000014-0000002', ship: 'Ronald - CRANSTON, RI', total: '14.97', subject: 'Ordered: 1 Musical Instruments item', at: day(5, 19) });
  await runMatcher();
  assert.deepEqual((await q("select amazon_order_id from order_links where ebay_order_id = 'U2'")).map((r) => r.amazon_order_id), ['111-0000014-0000001']);
});

await check('SEALIGHT pattern: cancel + rebuy read before the matcher runs, the replacement still links', async () => {
  await order('SEAL-2', day(4), 'SEALIGHT H10 9145 LED Fog Light Bulbs', 19, { fee: 3.01, name: 'Dominick DeRosa', city: 'Eatonton', st: 'GA' });
  await orderMail({ id: '111-0000015-0000001', ship: 'Dominick - EATONTON, GA', total: '10.79', subject: 'Ordered: 1 Automotive item', at: day(4, 19) });
  await mail('Item cancelled successfully: "SEALIGHT H10..."', 'We have cancelled the item you asked us to.\nOrder # 111-0000015-0000001\n', day(4, 20));
  await orderMail({ id: '112-0000015-0000002', ship: 'Dominick - EATONTON, GA', total: '10.79', subject: 'Ordered: 1 Automotive item', at: day(3, 19) });
  await runMatcher();
  assert.deepEqual((await q("select amazon_order_id from order_links where ebay_order_id = 'SEAL-2'")).map((r) => r.amazon_order_id), ['112-0000015-0000002']);
  assert.equal((await sale('SEAL-2')).cost, 10.79);
});

await check('one Amazon order (2 units, $23.90) for two sales by Kim Lee is listed as a shared-order suggestion, split by revenue', async () => {
  await order('S3-A', day(3, 15), 'PEHUAP Weed Eater Spool Cover', 20, { name: 'Kim Lee', city: 'Omaha', st: 'NE' });
  await order('S3-B', day(3, 16), 'Geelin Hero Skyscraper Centerpieces', 24, { name: 'Kim Lee', city: 'Omaha', st: 'NE' });
  await orderMail({ id: '111-0000003-0000001', ship: 'Kim - OMAHA, NE', total: '23.90', subject: 'Ordered: 2 Lawn & Garden and other items', at: day(3, 17) });
  await runMatcher();
  const s = (await sharedOrderSuggestions()).find((x) => x.amazon_order_id === '111-0000003-0000001');
  assert.ok(s, 'suggested');
  assert.deepEqual(s.sales.map((x) => x.ebay_order_id).sort(), ['S3-A', 'S3-B']);
  assert.equal(s.sales.reduce((t, x) => t + x.cost_share, 0).toFixed(2), '23.90');
  assert.ok((await emailStatus()).sharedOrders.some((x) => x.amazon_order_id === '111-0000003-0000001'), 'exposed in emailStatus');
});
await check('...and once that order is linked to one of them, the other sale is still suggested on its spare unit', async () => {
  await q("insert into order_links (amazon_order_id, ebay_order_id, method) values ('111-0000003-0000001', 'S3-A', 'manual') on conflict do nothing");
  const s = (await sharedOrderSuggestions()).find((x) => x.amazon_order_id === '111-0000003-0000001');
  assert.equal(s?.linked_to, 'S3-A');
  assert.deepEqual(s.sales.map((x) => x.ebay_order_id), ['S3-A', 'S3-B']);
});

await check('failed emails are listed by emailStatus() with message id, subject, date and reason', async () => {
  await mail('Ordered: 1 Toy item', 'Thanks for your order!\nGrand Total:\n$12.00\n', day(1), '<no-order-number@amazon.com>');
  const st = await emailStatus();
  const f = st.failed.find((x) => x.message_id === '<no-order-number@amazon.com>');
  assert.ok(f, 'listed');
  assert.equal(f.subject, 'Ordered: 1 Toy item');
  assert.match(f.reason, /no order number/);
  assert.ok(f.received_at);
  // The gift-card order is listed until its sale gets a cost
  assert.ok(st.failed.some((x) => x.order_ids.includes('111-0000006-0000001')));
});

await check('a failed email is read again on the next sync (not marked seen forever): an old-parser failure now links', async () => {
  // "Zoë - SAINT-LOUIS…" failed under the old parser (accent): stored as failed by parser version 1, outside the sync window
  await order('RETRY-1', day(20), 'Ceramic Plant Pot Set of 3', 39.99, { name: 'Zoë Martin', city: 'Saint Louis', st: 'MO' });
  const msg = { messageId: '<old-failure@amazon.com>', subject: 'Ordered: 1 Garden item', date: day(20, 19), text: 'Thanks for your order!\nZoë - SAINT LOUIS, MO\nOrder #\n111-0000016-0000001\nGrand Total:\n$18.20\n' };
  await q(`insert into amazon_emails (message_id, received_at, subject, kind, order_ids, ok, note, parsed, attempts, parser_version)
           values ($1, $2, $3, 'order', '{}', false, 'no order number found', '{}', 1, 1)`, [msg.messageId, msg.date, msg.subject]);
  let asked = null;
  const box = await mailbox([msg])();
  useMailboxForTests(async () => ({ ...box, list: async () => [], byIds: async (ids) => { asked = ids; return box.byIds(ids); } }));
  const r = await syncEmail();
  assert.ok(asked?.includes('<old-failure@amazon.com>'), 'fetched by Message-ID');
  const e = (await q("select ok, attempts, parser_version from amazon_emails where message_id = '<old-failure@amazon.com>'"))[0];
  assert.equal(e.ok, true);
  assert.equal(e.attempts, 2);
  assert.equal((await sale('RETRY-1')).cost, 18.2);
  assert.ok(r.log.some((l) => /1 imported/.test(l)));
});
await check('a sync with unsorted failed emails is not "ok", and names them; a dismissed one stops warning', async () => {
  useMailboxForTests(mailbox([]));
  const r = await syncEmail();
  assert.equal(r.ok, false);
  assert.ok(r.log.some((l) => /could not be read/.test(l)));
  const last = (await emailStatus()).last;
  assert.equal(last.ok, false);
  assert.equal(last.connected, true);
  for (const f of (await emailStatus()).failed) await dismissFailedEmail(f.message_id);
  assert.equal((await emailStatus()).failed.length, 0);
  assert.equal((await syncEmail()).ok, true);
});
await check('one email that throws while being read never stops the sync; it is stored as failed and retried', async () => {
  const good = { messageId: '<good@amazon.com>', subject: 'Ordered: 1 Toy item', date: day(1), text: 'Thanks for your order!\nAl - MESA, AZ\nOrder #\n111-0000017-0000001\nGrand Total:\n$9.99\n' };
  const bad = { messageId: '<bad@amazon.com>', subject: 'Ordered: 1 Toy item', date: day(1) };
  const box = await mailbox([bad, good])();
  useMailboxForTests(async () => ({ ...box, read: async (h) => { if (h.messageId === '<bad@amazon.com>') throw new Error('broken MIME'); return box.read(h); } }));
  await syncEmail();
  assert.equal(await lineTotal('111-0000017-0000001'), '9.99');
  const e = (await q("select ok, note from amazon_emails where message_id = '<bad@amazon.com>'"))[0];
  assert.equal(e.ok, false);
  assert.match(e.note, /broken MIME/);
});

await check('reprocess undoes a cancellation that a "Noise Cancelling" subject made under the old parser', async () => {
  await order('NC-1', day(3), 'Wireless Noise Cancelling Earbuds Bluetooth', 59, { name: 'Lena Ford', city: 'Fresno', st: 'CA' });
  const msg = { messageId: '<nc-order@amazon.com>', subject: 'Ordered: "Wireless Noise Cancelling Earbuds"', date: day(3, 19), text: 'Thanks for your order!\nLena - FRESNO, CA\nOrder #\n111-0000018-0000001\nGrand Total:\n$28.40\n' };
  await ingestMessage(msg);
  await runMatcher();
  // What the old parser did: stored it as a cancellation and cancelled the order
  await q("update amazon_emails set kind = 'cancel', order_ids = array['111-0000018-0000001'] where message_id = '<nc-order@amazon.com>'");
  await q("update amazon_lines set order_status = 'Cancelled' where amazon_order_id = '111-0000018-0000001'");
  assert.equal((await sale('NC-1')).cost, 0);
  useMailboxForTests(mailbox([msg]));
  await reprocessEmail();
  assert.equal((await q("select order_status from amazon_lines where amazon_order_id = '111-0000018-0000001'"))[0].order_status, 'Ordered');
  assert.equal((await sale('NC-1')).cost, 28.4);
});

useMailboxForTests(null);
await closeDb();
fs.rmSync(dir, { recursive: true, force: true });
console.log(failed ? '\nEMAIL TEST: FAILED' : '\nEMAIL TEST: ALL CHECKS PASSED');
process.exitCode = failed ? 1 : 0;
