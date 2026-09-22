// End-to-end check of the full pipeline against the real database, then removes every trace.
//   1. A mock eBay API serves one sale; the real syncEbay() pulls it (OAuth refresh, Fulfillment,
//      tracking, Finances fees/ad fees, Post-Order returns).
//   2. A raw MIME Amazon order-confirmation email (current Amazon template) goes through the same
//      simpleParser + ingestMessage path the IMAP poller uses. Two decoy Amazon orders ride along:
//      a personal purchase to the home address and a same-first-name buyer in another city.
//   3. The matcher must link only the right Amazon order; profit must equal the hand calculation.
//   4. Re-ingesting the email must not duplicate; a CSV containing the same order must replace the
//      email row without double-counting.
//   5. All E2E rows and touched settings are deleted/restored, and the DB is verified clean.
// Stop the dev server first when using the local embedded database (one process at a time).
import http from 'node:http';
import assert from 'node:assert/strict';

const E = 'E2E-';
const now = Date.now();
const saleAt = new Date(now - 26 * 3600_000); // yesterday
const orderId = `${E}27-14203-55891`;
// Real-format Amazon order numbers (the parser only accepts ###-#######-#######); 999- never occurs in practice
const amazonId = '999-9990001-0000001';
const DECOY1 = '999-9990002-0000002';
const DECOY2 = '999-9990003-0000003';
const AZ_IDS = [amazonId, DECOY1, DECOY2];

// ---------------- mock eBay ----------------
const ebayOrder = {
  orderId,
  creationDate: saleAt.toISOString(),
  orderFulfillmentStatus: 'FULFILLED',
  orderPaymentStatus: 'PAID',
  cancelStatus: { cancelState: 'NONE_REQUESTED' },
  buyer: { username: 'casey_w_e2e' },
  pricingSummary: {
    priceSubtotal: { value: '59.99', currency: 'USD' },
    deliveryCost: { value: '0.00', currency: 'USD' },
    total: { value: '59.99', currency: 'USD' },
  },
  totalMarketplaceFee: { value: '8.35', currency: 'USD' },
  paymentSummary: { refunds: [] },
  fulfillmentStartInstructions: [{ shippingStep: { shipTo: { fullName: 'Casey Whitfield', contactAddress: { addressLine1: '1 Test St', city: 'Houston', stateOrProvince: 'TX', postalCode: '77002', countryCode: 'US' } } } }],
  lineItems: [{
    lineItemId: `${orderId}-L1`, legacyItemId: '999000111222', sku: 'E2E-SKU', title: 'Hydro Flask Wide Mouth Water Bottle 32 oz Pacific',
    quantity: 1, lineItemCost: { value: '59.99' }, total: { value: '59.99' }, ebayCollectAndRemitTaxes: [{ amount: { value: '4.95' } }],
  }],
};
const hits = [];
const mock = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  hits.push(`${req.method} ${url.pathname}`);
  const send = (body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (url.pathname === '/identity/v1/oauth2/token') return send({ access_token: 'mock-access', expires_in: 7200, token_type: 'User Access Token' });
  if (req.headers.authorization !== 'Bearer mock-access' && req.headers.authorization !== 'IAF mock-access') return send({ errors: [{ message: 'bad token' }] }, 401);
  if (url.pathname === '/sell/fulfillment/v1/order') return send({ orders: [ebayOrder], total: 1 });
  if (url.pathname.endsWith('/shipping_fulfillment')) return send({ fulfillments: [{ shipmentTrackingNumber: 'TBA000E2E0001' }] });
  if (url.pathname === '/sell/finances/v1/transaction') return send({ total: 2, transactions: [
    { transactionType: 'SALE', orderId, totalFeeAmount: { value: '8.52' }, amount: { value: '51.47' } },
    { transactionType: 'NON_SALE_CHARGE', feeType: 'AD_FEE', bookingEntry: 'DEBIT', references: [{ referenceId: orderId, referenceType: 'ORDER_ID' }], amount: { value: '1.80' } },
  ] });
  if (url.pathname === '/post-order/v2/return/search') return send({ members: [], total: 0 });
  send({ errors: [{ message: `mock: no route ${url.pathname}` }] }, 404);
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${mock.address().port}`;

// Point the real eBay module at the mock (must happen before it is imported)
try { process.loadEnvFile?.(new URL('../.env', import.meta.url)); } catch {}
Object.assign(process.env, {
  EBAY_API_BASE: base, EBAY_APIZ_BASE: base,
  EBAY_CLIENT_ID: 'e2e-client', EBAY_CLIENT_SECRET: 'e2e-secret', EBAY_REFRESH_TOKEN: 'e2e-refresh',
});
const { initDb, q, closeDb, getSetting, setSetting } = await import('../src/db.js');
const { syncEbay } = await import('../src/ebay.js');
const { ingestMessage } = await import('../src/email.js');
const { importAmazonCsv } = await import('../src/amazon.js');
const { buildDataset } = await import('../src/dataset.js');
const { simpleParser } = await import('mailparser');
const kind = await initDb();
console.log(`DB: ${kind}  mock eBay: ${base}\n`);

const SETTING_KEYS = ['ebay_last_order_sync', 'ebay_last_finance_sync', 'ebay_last_return_sync'];
const snapshot = {};
for (const k of SETTING_KEYS) snapshot[k] = await getSetting(k);
const [{ n: syncLogBefore }] = await q('select coalesce(max(id),0)::int as n from sync_log');
const countAll = async () => Object.fromEntries(await Promise.all(
  ['ebay_orders', 'ebay_line_items', 'ebay_returns', 'amazon_lines', 'order_links', 'amazon_emails', 'amazon_refunds', 'link_rejections', 'order_overrides', 'amazon_imports']
    .map(async (t) => [t, (await q(`select count(*)::int as n from ${t}`))[0].n])));
const before = await countAll();

const mime = ({ id, subject, text, html, date }) => Buffer.from([
  'From: "Amazon.com" <auto-confirm@amazon.com>', 'To: someone@example.com', `Subject: ${subject}`, `Message-ID: <${id}@e2e.test>`,
  `Date: ${new Date(date).toUTCString()}`, 'MIME-Version: 1.0', 'Content-Type: multipart/alternative; boundary="b1"', '',
  '--b1', 'Content-Type: text/plain; charset=UTF-8', '', text, '', '--b1', 'Content-Type: text/html; charset=UTF-8', '', html, '', '--b1--', '',
].join('\r\n'));
const amazonEmail = (orderNo, shipLine, total, subject, date) => mime({
  id: `e2e-${orderNo}`, subject, date,
  text: `Your Orders\n\n    Thanks for your order!\nOrdered\n\nArriving Thursday\n\n${shipLine}\n\nOrder #\n‫${orderNo}\n\nView or edit order\n\nGrand Total:\n${total} USD\n\n©2026 Amazon.com`,
  html: `<html><body><td>${shipLine}</td><td>Order #</td><td>${orderNo}</td><td>Grand Total:</td><td>$${Number(total).toFixed(2)}</td></body></html>`,
});

let failed = false;
const check = (label, fn) => {
  try { fn(); console.log(`  PASS  ${label}`); } catch (e) { failed = true; console.log(`  FAIL  ${label}\n        ${e.message}`); }
};

try {
  // ---- 1. eBay pull ----
  const r = await syncEbay();
  console.log('eBay sync log:', r.log.join(' | '));
  const [o] = await q('select * from ebay_orders where order_id = $1', [orderId]);
  check('eBay sale pulled through the real sync', () => assert.ok(o));
  check('revenue excludes eBay-collected sales tax ($59.99)', () => assert.equal(Number(o.revenue), 59.99));
  check('Finances API fee overrides order fee ($8.52)', () => assert.equal(Number(o.ebay_fees), 8.52));
  check('promoted listing ad fee captured ($1.80)', () => assert.equal(Number(o.ad_fees), 1.8));
  check('tracking number fetched', () => assert.deepEqual(o.tracking_numbers, ['TBA000E2E0001']));

  // ---- 2. Amazon emails (real MIME -> simpleParser -> ingestMessage, same as IMAP) ----
  const azAt = new Date(saleAt.getTime() + 2 * 3600_000);
  const emails = [
    amazonEmail(amazonId, 'Casey - HOUSTON, TX', '44.87', 'Ordered 1 item: Kitchen', azAt),
    amazonEmail(DECOY1, 'Sam - SPRINGFIELD, IL', '47.12', 'Ordered 1 item: Kitchen', azAt), // personal, similar price
    amazonEmail(DECOY2, 'Casey - MESA, AZ', '45.10', 'Ordered 1 item: Sports', azAt),     // same first name, other city
  ];
  for (const raw of emails) {
    const mail = await simpleParser(raw);
    const res = await ingestMessage({ messageId: mail.messageId, subject: mail.subject, text: mail.text, html: mail.html, date: mail.date });
    check(`email ingested: ${mail.subject} / ${mail.text.match(/\n([^\n]+ - [^\n]+)\n/)[1]}`, () => assert.equal(res, 'ok'));
  }
  const { runMatcher } = await import('../src/matcher.js');
  const m = await runMatcher();
  console.log(`matcher: ${m.linked} new link(s), ${m.suggestions} suggestion(s)`);
  const links = await q(`select * from order_links where ebay_order_id = $1`, [orderId]);
  check('exactly one Amazon order linked to the sale', () => assert.equal(links.length, 1));
  check('linked the RIGHT Amazon order (Casey - HOUSTON)', () => assert.equal(links[0]?.amazon_order_id, amazonId));
  const decoyLinks = await q(`select * from order_links where amazon_order_id in ($1, $2)`, [DECOY1, DECOY2]);
  check('decoys are not linked to anything', () => assert.equal(decoyLinks.length, 0));
  console.log(`  link reasons: ${links[0]?.reasons}  (score ${links[0]?.score})`);

  // ---- 3. Profit ----
  let d = (await buildDataset()).find((x) => x.order_id === orderId);
  const expected = Math.round((59.99 - 8.52 - 1.8 - 44.87) * 100) / 100;
  check('counted as a sale with cost from Amazon', () => { assert.equal(d.counted, true); assert.equal(d.cost_source, 'amazon'); assert.equal(d.cost, 44.87); });
  check(`net profit = 59.99 - 8.52 - 1.80 - 44.87 = $${expected}`, () => assert.equal(d.net, expected));
  check('status profitable, margin + ROI computed', () => { assert.equal(d.status, 'profitable'); assert.ok(Math.abs(d.margin - expected / 59.99) < 1e-9); assert.ok(Math.abs(d.roi - expected / 44.87) < 1e-9); });
  check('purchase lag 0 days', () => assert.equal(d.lag_days, 0));

  // ---- 4. Dedupe ----
  const again = await simpleParser(emails[0]);
  const res2 = await ingestMessage({ messageId: again.messageId, subject: again.subject, text: again.text, html: again.html, date: again.date });
  check('same email twice is skipped', () => assert.equal(res2, 'seen'));
  const csv = `Order ID,Order Date,Product Name,ASIN,Quantity,Total Owed,Shipping Address\n${amazonId},${azAt.toISOString()},Hydro Flask Wide Mouth Water Bottle 32 oz,B083GBK1C1,1,44.87,"Casey Whitfield 1 Test St HOUSTON, TX 77002-1234 United States"`;
  const imp = await importAmazonCsv(Buffer.from(csv), 'e2e-test.csv');
  const lines = await q('select * from amazon_lines where amazon_order_id = $1', [amazonId]);
  check('CSV with the same order replaces the email row (1 line, source csv)', () => { assert.equal(lines.length, 1); assert.equal(lines[0].source, 'csv'); });
  d = (await buildDataset()).find((x) => x.order_id === orderId);
  check('profit unchanged after CSV (no double count)', () => { assert.equal(d.cost, 44.87); assert.equal(d.net, expected); });
  const links2 = await q(`select * from order_links where ebay_order_id = $1`, [orderId]);
  check('link survives the CSV replace', () => assert.equal(links2.length, 1));
  await q('delete from amazon_imports where id = $1', [imp.importId]);
} finally {
  // ---- 5. Clean up ----
  await q(`delete from order_links where ebay_order_id like '${E}%' or amazon_order_id = any($1)`, [AZ_IDS]);
  await q('delete from amazon_lines where amazon_order_id = any($1)', [AZ_IDS]);
  await q('delete from amazon_refunds where amazon_order_id = any($1)', [AZ_IDS]);
  await q('delete from link_rejections where amazon_order_id = any($1)', [AZ_IDS]);
  await q(`delete from link_rejections where ebay_order_id like '${E}%' or amazon_order_id like '${E}%'`);
  await q(`delete from order_overrides where order_id like '${E}%'`);
  await q(`delete from ebay_returns where order_id like '${E}%'`);
  await q(`delete from ebay_orders where order_id like '${E}%'`);
  await q(`delete from amazon_lines where amazon_order_id like '${E}%'`);
  await q(`delete from amazon_refunds where amazon_order_id like '${E}%'`);
  await q(`delete from amazon_emails where message_id like '%@e2e.test%'`);
  await q(`delete from amazon_imports where filename = 'e2e-test.csv'`);
  await q('delete from sync_log where id > $1', [syncLogBefore]);
  await q("update ledger_entries set ebay_order_id = null, match_method = null where ebay_order_id like 'E2E-%'");
  for (const k of SETTING_KEYS) {
    if (snapshot[k] === null) await q('delete from settings where key = $1', [k]);
    else await setSetting(k, snapshot[k]);
  }
  const after = await countAll();
  const leftovers = (await q(`select (select count(*) from ebay_orders where order_id like '${E}%') + (select count(*) from amazon_lines where amazon_order_id = any($1)) + (select count(*) from order_links where amazon_order_id = any($1)) as n`, [AZ_IDS]))[0].n;
  check('cleanup: no E2E rows left', () => assert.equal(Number(leftovers), 0));
  check('cleanup: every table back to its original row count', () => assert.deepEqual(after, before));
  console.log(`\nmock eBay endpoints hit: ${[...new Set(hits)].join(', ')}`);
  await closeDb();
  mock.close();
  console.log(failed ? '\nE2E: FAILED' : '\nE2E: ALL CHECKS PASSED');
  process.exitCode = failed ? 1 : 0;
}
