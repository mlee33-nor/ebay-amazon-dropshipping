// Regression tests for the eBay sync (audit items: sync failures reported per step, every Finances record stored,
// open returns rechecked after day 30). A mock eBay API serves each scenario to the real syncEbay(); throwaway
// database, never touches real data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-ebay-'));
process.env.LOCAL_PG_DIR = dir;
process.env.LOCAL_PG_PORT = String(5600 + Number(process.env.TEST_PG_300 || 0)); // TEST_PG_300 lets parallel runs use their own ports
delete process.env.DATABASE_URL;

const DAY = 86400_000;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

// ---------------- mock eBay: each scenario edits `mock` ----------------
const mock = {
  orders: [], ordersStatus: null,
  finances: [], financesStatus: null,
  returns: [], returnsStatus: null,
  byId: {}, byIdStatus: {},
  noFinancesScope: false,
};
const hits = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  hits.push(url.pathname);
  const send = (body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const fail = (status) => send({ errors: [{ message: `mock ${status}` }] }, status);
  if (url.pathname === '/identity/v1/oauth2/token') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const scope = new URLSearchParams(body).get('scope') || '';
      if (mock.noFinancesScope && scope.includes('sell.finances')) return send({ error: 'invalid_scope', error_description: 'mock: not granted' }, 400);
      send({ access_token: 'mock-access', expires_in: 7200 });
    });
    return;
  }
  if (url.pathname === '/sell/fulfillment/v1/order') return mock.ordersStatus ? fail(mock.ordersStatus) : send({ orders: mock.orders, total: mock.orders.length });
  if (url.pathname.endsWith('/shipping_fulfillment')) return send({ fulfillments: [] });
  if (url.pathname === '/sell/finances/v1/transaction') return mock.financesStatus ? fail(mock.financesStatus) : send({ transactions: mock.finances, total: mock.finances.length });
  if (url.pathname === '/post-order/v2/return/search') {
    if (mock.returnsStatus) return fail(mock.returnsStatus);
    const from = new Date(url.searchParams.get('creation_date_range_from')).getTime();
    const members = mock.returns.filter((r) => new Date(r.creationInfo.creationDate.value).getTime() >= from);
    return send({ members, total: members.length });
  }
  const m = url.pathname.match(/^\/post-order\/v2\/return\/([^/]+)$/);
  if (m) {
    if (mock.byIdStatus[m[1]]) return fail(mock.byIdStatus[m[1]]);
    return mock.byId[m[1]] ? send({ summary: mock.byId[m[1]], detail: {} }) : fail(404);
  }
  fail(404);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
Object.assign(process.env, {
  EBAY_API_BASE: base, EBAY_APIZ_BASE: base, EBAY_RETRY_MS: '1',
  EBAY_CLIENT_ID: 'test-client', EBAY_CLIENT_SECRET: 'test-secret', EBAY_REFRESH_TOKEN: 'test-refresh',
});

const { initDb, q, one, closeDb, getSetting, setSetting } = await import('../src/db.js');
const { syncEbay, ebayStatus, loadEbayConnection, normalizeTransaction } = await import('../src/ebay.js');
const { syncFailed } = await import('../public/js/util.js');
await initDb();

let failed = false;
const check = async (label, fn) => { try { await fn(); console.log(`  PASS  ${label}`); } catch (e) { failed = true; console.log(`  FAIL  ${label}\n        ${e.message}`); } };

// ================= 0. records stored before the new columns get them filled from their raw record =================
const legacyRaw = { buyer: { username: 'obidiah11' }, amount: { value: '26.59', currency: 'USD' }, orderId: '03-15158-63035', payoutId: '7746686178',
  references: [{ referenceId: '5328902493', referenceType: 'RETURN_ID' }], bookingEntry: 'CREDIT', transactionId: 'DISPUTE_HOLD_REVERSE-6755036627-6640371936',
  transactionDate: '2026-09-17T21:56:06.171Z', transactionType: 'CREDIT', transactionStatus: 'PAYOUT' };
await q(`insert into ebay_transactions (transaction_id, order_id, type, booking_entry, amount, transaction_at, raw, refs, hold_id, transaction_status, payout_id)
         values ($1, '03-15158-63035', 'CREDIT', 'CREDIT', 26.59, '2026-09-17T21:56:06.171Z', $2::jsonb, '[]'::jsonb, null, null, null)`,
  [legacyRaw.transactionId, JSON.stringify(legacyRaw)]);
await closeDb();
await initDb(); // a restart runs the schema again
await check('a restart fills refs, hold_id, status and payout on records stored before those columns', async () => {
  const row = await one('select refs, hold_id, transaction_status, payout_id from ebay_transactions where transaction_id = $1', [legacyRaw.transactionId]);
  assert.deepEqual(row.refs, legacyRaw.references);
  assert.equal(row.hold_id, '6755036627');
  assert.equal(row.transaction_status, 'PAYOUT');
  assert.equal(row.payout_id, '7746686178');
});
await q('delete from ebay_transactions');
await setSetting('listings_last_sync', { at: iso(now + 365 * DAY) }); // listing analytics are not under test
const reset = () => Object.assign(mock, { ordersStatus: null, financesStatus: null, returnsStatus: null, byIdStatus: {}, noFinancesScope: false });
const sync = async () => { hits.length = 0; return syncEbay(); };

const ebayOrder = (orderId, at, price, fee) => ({
  orderId, creationDate: at, orderFulfillmentStatus: 'FULFILLED', cancelStatus: { cancelState: 'NONE_REQUESTED' },
  pricingSummary: { priceSubtotal: { value: String(price) }, total: { value: String(price) } },
  totalMarketplaceFee: { value: String(fee) },
  lineItems: [{ lineItemId: `${orderId}-1`, title: 'Kala Bamboo Soprano Ukulele Satin', quantity: 1, lineItemCost: { value: String(price) }, total: { value: String(price) } }],
});
const money = (v) => ({ value: String(v), currency: 'USD' });
const KALA = '22-15174-90160';
const HELD = '03-15158-63035';
const CASE = '22-14846-46758';
mock.orders = [ebayOrder(KALA, iso(now - 2 * DAY), 114.0, 13.22), ebayOrder(HELD, iso(now - 3 * DAY), 26.59, 3.9), ebayOrder(CASE, iso(now - 4 * DAY), 100, 13)];
// Every kind of Finances record (shapes copied from production records)
mock.finances = [
  { transactionId: KALA, orderId: KALA, transactionType: 'SALE', bookingEntry: 'CREDIT', amount: money(100.78), totalFeeAmount: money(13.22), transactionDate: iso(now - 2 * DAY), transactionStatus: 'FUNDS_AVAILABLE_FOR_PAYOUT' },
  { transactionId: 'FEE-7822416951916_11', transactionType: 'NON_SALE_CHARGE', feeType: 'AD_FEE', bookingEntry: 'DEBIT', amount: money(2.85), references: [{ referenceId: KALA, referenceType: 'ORDER_ID' }], transactionDate: iso(now - 2 * DAY) },
  // Return hold and its release, paired by the id after DISPUTE_HOLD-
  { transactionId: 'DISPUTE_HOLD-6755036627', orderId: HELD, transactionType: 'DISPUTE', bookingEntry: 'DEBIT', amount: money(26.59), payoutId: '7732791186', references: [{ referenceId: '5328902493', referenceType: 'RETURN_ID' }], transactionDate: iso(now - 3 * DAY), transactionStatus: 'PAYOUT' },
  { transactionId: 'DISPUTE_HOLD_REVERSE-6755036627-6640371936', orderId: HELD, transactionType: 'CREDIT', bookingEntry: 'CREDIT', amount: money(26.59), payoutId: '7746686178', references: [{ referenceId: '5328902493', referenceType: 'RETURN_ID' }], transactionDate: iso(now - 1 * DAY), transactionStatus: 'PAYOUT' },
  // A case hold (CASE_ID) and a payment dispute debit with no hold id
  { transactionId: 'DISPUTE_HOLD-6728705848', orderId: CASE, transactionType: 'DISPUTE', bookingEntry: 'DEBIT', amount: money(100), references: [{ referenceId: '5091234567', referenceType: 'CASE_ID' }], transactionDate: iso(now - 2 * DAY) },
  { transactionId: 'PD-5000123456', transactionType: 'DISPUTE', bookingEntry: 'DEBIT', amount: money(100), references: [{ referenceId: CASE, referenceType: 'ORDER_ID' }, { referenceId: '5000123456', referenceType: 'PAYMENT_DISPUTE_ID' }], transactionDate: iso(now - 1 * DAY) },
  // Seller return label; its id happens to equal the Kala sale's id (eBay ids are only unique per type)
  { transactionId: KALA, orderId: KALA, transactionType: 'SHIPPING_LABEL', bookingEntry: 'DEBIT', amount: money(9.69), transactionMemo: 'Shipping label purchased', transactionDate: iso(now - 1 * DAY) },
  // Account-level records with no order at all
  { transactionId: 'FEE-SUB-2026-10', transactionType: 'NON_SALE_CHARGE', feeType: 'SUBSCRIPTION_FEE', bookingEntry: 'DEBIT', amount: money(74.95), transactionDate: iso(now - 1 * DAY) },
  { transactionType: 'NON_SALE_CHARGE', feeType: 'INSERTION_FEE', bookingEntry: 'DEBIT', amount: money(0.35), transactionDate: iso(now - 1 * DAY) },
  { transactionId: 'TR-881', transactionType: 'TRANSFER', bookingEntry: 'DEBIT', amount: money(50), transactionDate: iso(now - 1 * DAY) },
  { transactionId: 'ADJ-42', transactionType: 'ADJUSTMENT', bookingEntry: 'CREDIT', amount: money(5), transactionDate: iso(now - 1 * DAY) },
  { transactionId: 'MYST-1', transactionType: 'MYSTERY_TYPE', bookingEntry: 'DEBIT', amount: money(1.23), transactionDate: iso(now - 1 * DAY) },
];
const ret = (returnId, orderId, createdMs, state) => ({
  returnId, orderId, state, status: state, currentType: 'MONEY_BACK',
  creationInfo: { item: { itemId: '1' }, reason: 'NOT_AS_DESCRIBED', creationDate: { value: iso(createdMs) } },
  buyerTotalRefund: { estimatedRefundAmount: money(26.59) },
});
// An old return still open (created 60 days ago), a recent one, and an old closed one
mock.returns = [ret('5330357099', HELD, now - 60 * DAY, 'ITEM_SHIPPED'), ret('5328902493', HELD, now - 3 * DAY, 'ITEM_SHIPPED'), ret('5305964694', KALA, now - 90 * DAY, 'CLOSED')];
mock.byId['5330357099'] = mock.returns[0]; // still open when first rechecked

// ================= 1. a healthy sync stores every Finances record =================
let r = await sync();
await check('healthy sync: ok, status ok, every step ok', async () => {
  assert.equal(r.ok, true, r.log.join(' | '));
  assert.equal(r.status, 'ok');
  for (const s of ['orders', 'finances', 'returns']) assert.equal(r.steps[s].status, 'ok', s);
  const st = await ebayStatus();
  assert.equal(st.status, 'ok');
  assert.equal(st.partial, false);
  assert.equal(st.financesFailed, false);
  assert.equal(st.financesStale, false);
  assert.equal(st.returnsStale, false);
  assert.deepEqual(st.warnings, []);
  assert.equal(syncFailed(st), false);
});
await check('every Finances record is stored, whatever its type, with or without an order', async () => {
  const rows = await q('select * from ebay_transactions order by transaction_id');
  assert.equal(rows.length, mock.finances.length);
  const types = rows.map((x) => x.type).sort();
  assert.deepEqual(types, mock.finances.map((t) => t.transactionType).sort());
  const orderless = rows.filter((x) => x.order_id === null).map((x) => x.type).sort();
  assert.deepEqual(orderless, ['ADJUSTMENT', 'MYSTERY_TYPE', 'NON_SALE_CHARGE', 'NON_SALE_CHARGE', 'TRANSFER']);
  const sub = rows.find((x) => x.transaction_id === 'FEE-SUB-2026-10');
  assert.equal(Number(sub.amount), 74.95);
  assert.equal(sub.fee_type, 'SUBSCRIPTION_FEE');
  const noId = rows.find((x) => x.fee_type === 'INSERTION_FEE');
  assert.match(noId.transaction_id, /^NOID-/);
  assert.equal(Number(noId.amount), 0.35);
});
await check('references, hold pairing, status, payout and memo are kept', async () => {
  const held = await q("select transaction_id, type, booking_entry, refs, payout_id, transaction_status from ebay_transactions where hold_id = '6755036627' order by type");
  assert.deepEqual(held.map((x) => [x.type, x.booking_entry]), [['CREDIT', 'CREDIT'], ['DISPUTE', 'DEBIT']]);
  assert.deepEqual(held[0].refs, [{ referenceId: '5328902493', referenceType: 'RETURN_ID' }]);
  assert.equal(held[1].payout_id, '7732791186');
  assert.equal(held[1].transaction_status, 'PAYOUT');
  const pd = await one("select order_id, hold_id, refs from ebay_transactions where transaction_id = 'PD-5000123456'");
  assert.equal(pd.order_id, CASE, 'order taken from the ORDER_ID reference');
  assert.equal(pd.hold_id, null, 'a payment dispute is not a hold');
  assert.ok(pd.refs.some((x) => x.referenceType === 'PAYMENT_DISPUTE_ID' && x.referenceId === '5000123456'));
  const caseHold = await one("select refs, hold_id from ebay_transactions where transaction_id = 'DISPUTE_HOLD-6728705848'");
  assert.equal(caseHold.hold_id, '6728705848');
  assert.equal(caseHold.refs[0].referenceType, 'CASE_ID');
  const label = await one("select order_id, amount, memo from ebay_transactions where transaction_id = $1", [`SHIPPING_LABEL:${KALA}`]);
  assert.equal(label.memo, 'Shipping label purchased');
  assert.equal(Number(label.amount), 9.69);
});
await check('a record sharing a SALE id never overwrites the sale: Kala fees stay 13.22 + 2.85 ad', async () => {
  const sale = await one('select type, fee_amount from ebay_transactions where transaction_id = $1', [KALA]);
  assert.equal(sale.type, 'SALE');
  assert.equal(Number(sale.fee_amount), 13.22);
  const o = await one('select ebay_fees, ad_fees, fee_credit from ebay_orders where order_id = $1', [KALA]);
  assert.equal(Number(o.ebay_fees), 13.22);
  assert.equal(Number(o.ad_fees), 2.85);
  assert.equal(Number(o.fee_credit), 0);
  // Holds, disputes and labels don't change what the books read today (core books them separately)
  const h = await one('select ebay_fees, ad_fees, refund_total from ebay_orders where order_id = $1', [HELD]);
  assert.equal(Number(h.ebay_fees), 3.9);
  assert.equal(Number(h.ad_fees), 0);
  assert.equal(Number(h.refund_total), 0);
});
await check('the sync log names order-less records, what is not yet in the books, and unknown types', async () => {
  const msg = r.log.find((l) => l.startsWith('finances:'));
  assert.match(msg, /12 records on 3 orders, 5 with no order/);
  assert.match(msg, /not yet in the books: .*DISPUTE 3.*SHIPPING_LABEL 1/);
  assert.match(msg, /NON_SALE_CHARGE\/SUBSCRIPTION_FEE 1/);
  assert.match(msg, /WARNING unknown Finances type MYSTERY_TYPE/);
});
await check('re-syncing the same window stores nothing twice (records without an id get a stable one)', async () => {
  const before = (await one('select count(*)::int n from ebay_transactions')).n;
  const again = await sync();
  assert.equal(again.ok, true, again.log.join(' | '));
  assert.equal((await one('select count(*)::int n from ebay_transactions')).n, before);
  assert.equal(normalizeTransaction(mock.finances[8]).transaction_id, normalizeTransaction(structuredClone(mock.finances[8])).transaction_id);
});

// ================= 2. returns: open ones are rechecked by id however old =================
await check('first sync stored all three returns; the old open one is still open', async () => {
  const rows = await q('select return_id, state from ebay_returns order by return_id');
  assert.deepEqual(rows.map((x) => [x.return_id, x.state]), [['5305964694', 'CLOSED'], ['5328902493', 'ITEM_SHIPPED'], ['5330357099', 'ITEM_SHIPPED']]);
});
mock.byId['5330357099'] = { ...ret('5330357099', HELD, now - 60 * DAY, 'CLOSED'), buyerTotalRefund: { actualRefundAmount: money(0) } };
r = await sync();
await check('a return opened 60 days ago (outside the search window) is rechecked by id and closes', async () => {
  assert.equal(r.ok, true, r.log.join(' | '));
  assert.ok(hits.includes('/post-order/v2/return/5330357099'), 'fetched by id');
  assert.equal((await one("select state from ebay_returns where return_id = '5330357099'")).state, 'CLOSED');
});
await check('closed returns and returns the search already returned are not fetched again', async () => {
  assert.ok(!hits.includes('/post-order/v2/return/5305964694'), 'closed one skipped');
  assert.ok(!hits.includes('/post-order/v2/return/5328902493'), 'in the search window');
  const again = await sync();
  assert.equal(again.ok, true);
  assert.ok(!hits.some((h) => /^\/post-order\/v2\/return\/\d+$/.test(h)), 'nothing left open outside the window');
});
// An old open return whose recheck fails: the step fails, the stored state stays, and it's tried again next sync
await q(`insert into ebay_returns (return_id, order_id, state, status, created_at) values ('5323444687', $1, 'RETURN_REQUESTED', 'RETURN_REQUESTED', $2)`, [HELD, iso(now - 45 * DAY)]);
mock.byIdStatus['5323444687'] = 500;
const lastReturnSync = await getSetting('ebay_last_return_sync');
r = await sync();
await check('a failed recheck of an open return fails the returns step (partial), keeps the return open', async () => {
  assert.equal(r.ok, false);
  assert.equal(r.status, 'partial');
  assert.equal(r.steps.returns.status, 'failed');
  assert.match(r.steps.returns.message, /5323444687/);
  assert.equal((await one("select state from ebay_returns where return_id = '5323444687'")).state, 'RETURN_REQUESTED');
  assert.equal(await getSetting('ebay_last_return_sync'), lastReturnSync, 'last good returns sync not moved');
});
reset();
mock.byId['5323444687'] = ret('5323444687', HELD, now - 45 * DAY, 'CLOSED');
r = await sync();
await check('next sync rechecks it again and closes it', async () => {
  assert.equal(r.ok, true, r.log.join(' | '));
  assert.equal((await one("select state from ebay_returns where return_id = '5323444687'")).state, 'CLOSED');
});

// ================= 3. failures are reported, never logged as a successful sync =================
const financeSyncBefore = await getSetting('ebay_last_finance_sync');
mock.orders.push(ebayOrder('04-15200-00001', iso(now - DAY), 34.99, 5.19));
mock.financesStatus = 500;
mock.returnsStatus = 403;
r = await sync();
await check('Finances 500 four times + returns 403: sync not ok, status partial, both steps failed', async () => {
  assert.equal(hits.filter((h) => h === '/sell/finances/v1/transaction').length, 4, 'four tries');
  assert.equal(r.ok, false);
  assert.equal(r.status, 'partial');
  assert.equal(r.steps.orders.status, 'ok');
  assert.equal(r.steps.finances.status, 'failed');
  assert.match(r.steps.finances.message, /500/);
  assert.equal(r.steps.returns.status, 'failed');
  assert.match(r.steps.returns.message, /403/);
  assert.ok(await one("select 1 from ebay_orders where order_id = '04-15200-00001'"), 'orders still came in');
  assert.ok(r.log.some((l) => l.startsWith('matcher:')), 'matcher still ran');
  assert.equal(await getSetting('ebay_last_finance_sync'), financeSyncBefore, 'last good Finances sync not moved');
});
await check('ebayStatus reports partial, the UI\'s syncFailed is true, and the message names finances and returns', async () => {
  const st = await ebayStatus();
  assert.equal(st.status, 'partial');
  assert.equal(st.partial, true);
  assert.equal(st.last.ok, false);
  assert.equal(syncFailed(st), true);
  assert.equal(st.financesFailed, true);
  assert.equal(st.returnsFailed, true);
  assert.equal(st.steps.orders.ok, true);
  assert.equal(st.steps.finances.ok, false);
  assert.match(st.last.message, /^partial: finances failed, returns failed/);
  assert.ok(st.warnings.some((w) => /Finances .* failed/.test(w)) && st.warnings.some((w) => /returns failed/.test(w)), st.warnings.join(' / '));
  assert.notEqual(st.lastSuccess, null, 'last fully good sync is still the earlier one');
  assert.ok(new Date(st.lastSuccess) < new Date(st.last.finished_at));
});
reset();
r = await sync();
await check('when both recover, the next sync is ok again and the flags clear', async () => {
  assert.equal(r.ok, true, r.log.join(' | '));
  const st = await ebayStatus();
  assert.equal(st.status, 'ok');
  assert.equal(st.financesFailed || st.returnsFailed || st.financesStale || st.returnsStale, false);
});

// ================= 4. stale Finances =================
await setSetting('ebay_last_finance_sync', iso(now - 5 * 3600_000));
await check('Finances not synced for 5 hours: financesStale with a warning, even though the last run said ok', async () => {
  const st = await ebayStatus();
  assert.equal(st.financesStale, true);
  assert.equal(st.steps.finances.stale, true);
  assert.equal(st.returnsStale, false);
  assert.ok(st.warnings.some((w) => /Finances .* last synced/.test(w)), st.warnings.join(' / '));
});
r = await sync();
await check('a good sync clears the stale flag', async () => {
  assert.equal((await ebayStatus()).financesStale, false);
});

// ================= 5. a skipped Finances step (token without the finances scope) =================
mock.noFinancesScope = true;
await loadEbayConnection(); // drop the cached token so the next one is fetched without the scope
r = await sync();
await check('Finances skipped for a missing scope: sync not ok (partial), reason recorded', async () => {
  assert.equal(r.ok, false);
  assert.equal(r.status, 'partial');
  assert.equal(r.steps.finances.status, 'skipped');
  assert.match(r.steps.finances.message, /sell\.finances/);
  const st = await ebayStatus();
  assert.equal(st.financesFailed, true);
  assert.equal(syncFailed(st), true);
  assert.match(st.last.message, /^partial: finances skipped/);
});
reset();
await loadEbayConnection();

// ================= 6. orders down while Finances works; the records still reach the order later =================
const LATE = '07-15210-55555';
mock.orders.push(ebayOrder(LATE, iso(now - DAY), 34.99, 5.0));
mock.finances.push(
  { transactionId: LATE, orderId: LATE, transactionType: 'SALE', bookingEntry: 'CREDIT', amount: money(29.8), totalFeeAmount: money(5.19), transactionDate: iso(now - DAY) },
  { transactionId: 'FEE-LATE_11', transactionType: 'NON_SALE_CHARGE', feeType: 'AD_FEE', bookingEntry: 'DEBIT', amount: money(1.4), references: [{ referenceId: LATE, referenceType: 'ORDER_ID' }], transactionDate: iso(now - DAY) },
);
mock.ordersStatus = 500;
r = await sync();
await check('orders failing makes the sync failed, but Finances and returns still run', async () => {
  assert.equal(r.ok, false);
  assert.equal(r.status, 'failed');
  assert.equal(r.steps.orders.status, 'failed');
  assert.equal(r.steps.finances.status, 'ok');
  assert.equal(r.steps.returns.status, 'ok');
  assert.equal((await ebayStatus()).status, 'failed');
  assert.equal(await one('select 1 from ebay_orders where order_id = $1', [LATE]), null);
});
reset();
mock.financesStatus = 500;
r = await sync();
await check('the order arrives while Finances is down: its fees and ad fees come from the stored records', async () => {
  assert.equal(r.status, 'partial');
  const o = await one('select ebay_fees, ad_fees from ebay_orders where order_id = $1', [LATE]);
  assert.equal(Number(o.ebay_fees), 5.19);
  assert.equal(Number(o.ad_fees), 1.4);
});
reset();

// ================= 7. history from before per-step tracking =================
await q("insert into sync_log (started_at, finished_at, ok, message) values (now(), now(), true, 'orders: 1 new/updated')");
await check('a sync_log row without steps reads as ok with unknown steps (no crash)', async () => {
  const st = await ebayStatus();
  assert.equal(st.status, 'ok');
  assert.equal(st.steps.finances.status, 'unknown');
  assert.equal(st.steps.finances.ok, null);
  assert.equal(st.financesFailed, false);
});
await check('a run in progress reads as running', async () => {
  await q('insert into sync_log (started_at) values (now())');
  assert.equal((await ebayStatus()).status, 'running');
});

await closeDb();
server.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(failed ? '\nEBAY SYNC: FAILED' : '\nEBAY SYNC: ALL CHECKS PASSED');
process.exitCode = failed ? 1 : 0;
