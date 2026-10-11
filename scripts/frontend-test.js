// Regression tests for the dashboard's own math (public/js): statements, the tax panel and order exports; the Editor's
// live net and cell parsing; refund lines in analytics; Arizona-time dates and due labels; the pay-period Overview;
// operating-cost defaults and credits; sync banners and the Settle page's check before a payment; a payment that has
// been made never changing (its costs, Editor overrides, Pay the remaining). The dataset is built by the real server code on a throwaway database seeded with real cases from the October 2026 audit, then handed to
// the same pure modules the pages use. Runs in Manila time on purpose, so anything that reads the viewer's own clock
// instead of Arizona's shows up.
process.env.TZ = 'Asia/Manila';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import net from 'node:net';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-frontend-'));
process.env.LOCAL_PG_DIR = dir;
// TEST_PG_500 (or TEST_PG_OFFSET) lets parallel runs use their own ports. On Windows a stopped database can leave its
// port held for a while, so the first free port from there on is used: this test always starts its own fresh database.
const free = (port) => new Promise((resolve) => {
  const s = net.createServer().once('error', () => resolve(false)).once('listening', () => s.close(() => resolve(true)));
  s.listen(port, '127.0.0.1');
});
let pgPort = 5600 + Number(process.env.TEST_PG_500 || process.env.TEST_PG_OFFSET || 0);
for (let i = 0; i < 40 && !(await free(pgPort)); i++) pgPort++;
process.env.LOCAL_PG_PORT = String(pgPort);
delete process.env.DATABASE_URL;
const { initDb, q, closeDb } = await import('../src/db.js');
const { normalizeOrder, upsertOrder } = await import('../src/ebay.js');
const { importLedgerCsv, matchLedger } = await import('../src/ledger.js');
const { ingestMessage } = await import('../src/email.js');
const { buildDataset, buildBooks } = await import('../src/dataset.js');
const { settleMonth } = await import('../public/js/settlement.js');
const U = await import('../public/js/util.js');
const M = await import('../public/js/metrics.js');
const RM = await import('../public/js/report-math.js');
const E = await import('../public/js/editor-math.js');
const H = await import('../public/js/health.js');
const W = await import('../public/js/watch-math.js');
const P = await import('../public/js/promo-months.js');
const OX = await import('../public/js/opex-math.js');
await initDb();

let failed = false;
const check = async (label, fn) => { try { await fn(); console.log(`  PASS  ${label}`); } catch (e) { failed = true; console.log(`  FAIL  ${label}\n        ${e.message}`); } };
const order = (id, at, title, price, { fee = +(price * 0.136).toFixed(2), city = 'Mesa', st = 'AZ', name = 'Test Buyer', tracking = [] } = {}) =>
  upsertOrder(normalizeOrder({
    orderId: id, creationDate: at, orderFulfillmentStatus: 'FULFILLED', cancelStatus: { cancelState: 'NONE_REQUESTED' },
    pricingSummary: { priceSubtotal: { value: String(price) }, total: { value: String(price) } },
    totalMarketplaceFee: { value: String(fee) },
    paymentSummary: { refunds: [] },
    fulfillmentStartInstructions: [{ shippingStep: { shipTo: { fullName: name, contactAddress: { city, stateOrProvince: st } } } }],
    lineItems: [{ lineItemId: `${id}-1`, title, quantity: 1, lineItemCost: { value: String(price) }, total: { value: String(price) } }],
  })).then(() => (tracking.length ? q('update ebay_orders set tracking_numbers = $2 where order_id = $1', [id, tracking]) : null));
const tx = (id, orderId, type, amount, fee, at, extra = {}) => q(
  `insert into ebay_transactions (transaction_id, order_id, type, fee_type, booking_entry, amount, fee_amount, transaction_at)
   values ($1,$2,$3,$4,$5,$6,$7,$8)`, [id, orderId, type, extra.feeType || null, extra.booking || null, amount, fee, at]);
const settings = { split_amazon: 50, partner_amazon: 'Myles', partner_ebay: 'Drew', settlement_day: 26 };
const load = async () => { const orders = await buildDataset(); const books = await buildBooks(); return { orders, books, settings }; };
const settle = (data, month) => settleMonth({ month, orders: data.orders, expenses: data.books.expenses, settlements: data.books.settlements, splitAmazon: 50 });
const cents = (n) => Math.round(n * 100);
const az = (s) => Date.parse(`${s}-07:00`); // an Arizona wall-clock time as an instant

// ---- the real sheets (Jul-Sep 2026) and the payments made on them
const sheetDir = process.env.LEDGER_SHEETS_DIR || path.resolve('private');
for (const m of ['JUL', 'AUG', 'SEP']) await importLedgerCsv(fs.readFileSync(path.join(sheetDir, `sheet-${m}-26.csv`)), `sheet ${m} 26.csv`);
await q("insert into settlements (month, paid, paid_at, note) values ('2026-07', 217.63, null, 'Paid in full (per July sheet)'), ('2026-08', 1304.76, '2026-09-01', null), ('2026-09', 704.40, '2026-09-27', null) on conflict (month) do update set paid = excluded.paid, paid_at = excluded.paid_at");

// ---- HHLPRO (Sep sheet sale): eBay refunded Oct 7 with the $13.72 fees and the $4.27 ad fee given back; Amazon gave
// Myles $104.79 of the $107.89 on Oct 9 (the email names the item; the purchase predates the inbox)
await order('08-15199-12018', '2026-09-21T14:47:48Z', 'HHLPRO UHF Wireless XLR Transmitter Receiver F20', 142.41, { fee: 13.72, city: 'Hoover', st: 'AL', tracking: ['AQUAA5304580926YQ'] });
await tx('HHL-SALE', '08-15199-12018', 'SALE', 128.69, 13.72, '2026-09-21T14:47:48Z');
await tx('HHL-AD', '08-15199-12018', 'NON_SALE_CHARGE', 4.27, 0, '2026-09-21T14:50:44Z', { feeType: 'AD_FEE', booking: 'DEBIT' });
await tx('HHL-REF', '08-15199-12018', 'REFUND', 128.69, 13.72, '2026-10-07T23:24:06Z');
await tx('HHL-AD-BACK', '08-15199-12018', 'NON_SALE_CHARGE', 4.27, 0, '2026-10-07T23:25:13Z', { feeType: 'AD_FEE', booking: 'CREDIT' });
await q("update ebay_orders set ad_fees = 0, fee_credit = 13.72 where order_id = '08-15199-12018'");
await q("insert into amazon_refunds (message_id, amazon_order_id, amount, received_at, title) values ('m-hhl', '111-9229079-9782641', 104.79, '2026-10-09T17:52:11Z', 'HHLPRO UHF Wireless XLR')");
// ---- Govee (Aug sheet sale): Amazon refunded $42.89 on Sep 24 (Sep was then paid on Sep 27), eBay refunded the buyer Oct 4
await order('09-15092-16683', '2026-08-28T04:03:27Z', 'Govee Control Box for Govee Permanent Outdoor Lights 2,White Version', 64.99, { fee: 9.25, city: 'Simi Valley', st: 'CA', tracking: ['AQUAA9161230826YQ'] });
await tx('GOV-REF', '09-15092-16683', 'REFUND', 55.74, 9.25, '2026-10-04T23:47:18Z');
await q("insert into amazon_refunds (message_id, amazon_order_id, amount, received_at, title) values ('m-gov', '111-8776178-7476264', 42.89, '2026-09-24T03:23:59Z', null)");
// ---- the four Sep 27-30 sales: sold in September, paid in the October payment ($35.92 profit, $74.89 COGS)
const late = [
  ['21-15205-89610', '2026-09-28T18:55:45Z', 'VIVAGLORY Dog Winter Coat Softjoy Warm Dog Jacket, XS, Sky Blue', 47.99, 7.04, 2.61, 26.12, 'Brooklyn', 'NY'],
  ['26-15202-82285', '2026-09-30T01:48:38Z', 'QTCTZKA PEX Fittings Combo, 3/4 Inch, 15 Pcs', 20.0, 3.15, 0, 10.61, 'Trinity', 'TX'],
  ['05-15246-08828', '2026-09-30T20:31:43Z', 'MEYAGO Needlepoint Key Fob Kit, 5PCS PU Leather', 19.99, 3.16, 1.09, 10.73, 'San Francisco', 'CA'],
  ['26-15207-83680', '2026-10-01T05:11:27Z', 'Smeyta Car Snow Winshield Cover,Magnetic Windshield Cover for Snow', 49.99, 7.37, 2.74, 27.43, 'Canoga Park', 'CA'],
];
for (const [id, at, title, price, fee, ad, cost, city, st] of late) {
  await order(id, at, title, price, { fee, city, st });
  await q('update ebay_orders set ad_fees = $2 where order_id = $1', [id, ad]);
  await q('insert into order_overrides (order_id, cost_override) values ($1, $2)', [id, cost]);
}
// ---- SEALIGHT, refunded inside its own pay period: the Editor's live net must equal the server's ($0.00)
await order('15-15253-44046', '2026-10-06T00:39:00Z', 'SEALIGHT H10 9145 LED Fog Light Bulbs', 19, { fee: 3.01, name: 'Dominick DeRosa', city: 'Eatonton', st: 'GA' });
await ingestMessage({ messageId: 'fe-seal@test', subject: 'Ordered: 1 Automotive item', date: '2026-10-06T01:00:00Z',
  text: 'Thanks for your order!\nDominick - EATONTON, GA\nOrder # 112-2746814-8118619\nGrand Total: $10.79\n' });
await q("insert into order_links (amazon_order_id, ebay_order_id, method) values ('112-2746814-8118619', '15-15253-44046', 'manual')");
await tx('SEAL-REF', '15-15253-44046', 'REFUND', 15.99, 3.01, '2026-10-08T18:00:00Z');
await ingestMessage({ messageId: 'fe-seal-ref@test', subject: 'Your refund for SEALIGHT H10 9145', date: '2026-10-09T10:00:00Z',
  text: 'Refund issued\nOrder # 112-2746814-8118619\nRefund total: $10.79\n' });
// ---- Graphique: sold but its Amazon cost isn't known yet (awaiting cost, not in the October total)
await order('17-15263-09121', '2026-10-09T20:00:00Z', 'Graphique Magnetic Notepad', 23.99, { tracking: ['AQUAA0000000000YQ'] });
await matchLedger();

const data = await load();
const row = (id) => data.orders.find((o) => o.order_id === id);
const refundLine = (of) => data.orders.find((o) => o.source === 'refund' && o.refund_of === of);

console.log('Statements, tax panel and exports (plan item 18)');
await check('the refund lines the reports are checked against carry the real numbers (HHLPRO -19.63, Govee -12.85)', () => {
  const h = refundLine('08-15199-12018');
  assert.equal(h.settle_month, '2026-10');
  assert.deepEqual([h.fees, h.refunds, h.amazon_refund, h.ad_fees, h.net], [-13.72, 142.41, 104.79, -4.27, -19.63]);
  const g = refundLine('09-15092-16683');
  assert.equal(g.settle_month, '2026-10');
  assert.deepEqual([g.fees, g.refunds, g.amazon_refund, g.net], [-9.25, 64.99, 42.89, -12.85]);
});
await check('a statement lists exactly the lines its payment is made of: the Sep 27-30 sales are on October, not September', () => {
  const sep = RM.statementFor(data, '2026-09');
  const oct = RM.statementFor(data, '2026-10');
  for (const [id] of late) {
    assert.ok(!sep.lines.some((l) => l.o.order_id === id), `${id} not on the September statement`);
    assert.ok(oct.lines.some((l) => l.o.order_id === id), `${id} on the October statement`);
  }
  const lateLines = oct.lines.filter((l) => late.some(([id]) => id === l.o.order_id));
  assert.equal(lateLines.reduce((t, l) => t + l.net, 0), 3592, 'their $35.92 profit');
  assert.equal(lateLines.reduce((t, l) => t + l.cogs, 0), 7489, 'their $74.89 COGS');
  for (const [m, st] of [['2026-09', sep], ['2026-10', oct]]) {
    assert.equal(st.matches, true, `${m} line items add up to the settlement`);
    assert.equal(st.lines.length, settle(data, m).orders);
    assert.equal(st.tot.net, cents(settle(data, m).orderProfit));
  }
  assert.ok(oct.lines.some((l) => l.o.refund_of === '08-15199-12018') && oct.refundLines >= 2, 'refund lines are on the payment they are booked on');
});
await check('tax panel: refunds are taken off once and the fee credits are kept (gross - fees - refunds + payout-only = payouts)', () => {
  const rows = RM.taxRows(data.orders, '2026');
  const T = RM.taxTotals(rows);
  assert.equal(T.gross - T.fees - T.refunds + T.noGrossPayout, T.payout);
  const h = rows.find((r) => r.o.refund_of === '08-15199-12018');
  assert.deepEqual([h.gross, h.fees, h.refunds, h.payout], [0, -1372, 14241, -12869], 'a refund line: no gross, the fee credit, the buyer refund');
  assert.ok(!rows.some((r) => r.gross === null && r.o.source !== 'ledger'), 'only monthly-sheet sales can be payout-only');
  const sheetRefunds = rows.filter((r) => r.o.ledger?.is_refund);
  assert.equal(sheetRefunds.length, 4, 'the September sheet has four refund rows (Mozi Wash, Leg Straps, Vitaliq, Areliaa)');
  assert.ok(sheetRefunds.every((r) => r.gross === 0 && r.fees === 40 && r.refunds === 0 && r.payout === -40), 'a sheet refund row is eBay\'s 40-cent refund fee, not a buyer refund');
  assert.equal(T.sales, rows.filter((r) => r.o.source !== 'refund' && !r.o.ledger?.is_refund).length, 'refund lines are not sales');
  // Fixed numbers: buyers got back HHLPRO 142.41 + Govee 64.99 + SEALIGHT 19.00 (refunded inside its own period) and
  // nothing else; the HHLPRO and Govee fee credits (13.72 + 9.25) come off the eBay fees, the sheet refund fees go on
  assert.equal(T.refunds, 14241 + 6499 + 1900, 'refunds to buyers: 226.40, with no sheet refund fees in it');
  const credits = rows.filter((r) => r.o.source === 'refund').reduce((t, r) => t + r.fees, 0);
  assert.equal(credits, -1372 - 925, 'the HHLPRO and Govee fee credits are kept as negative fees');
  // eBay fees 26.59: the counted sales' fees, less those two credits (22.97), plus the four sheet refund fees (1.60)
  assert.deepEqual([T.fees, T.payout], [2659, 269070]);
});
await check('order export: money only on counted rows, so adding up a column gives the books (no sheet/eBay copies)', () => {
  const col = (t) => RM.ORDER_EXPORT.find((c) => c.title === t).get;
  const sep = data.orders.filter((o) => o.business_month === '2026-09');
  const inSheet = sep.filter((o) => o.status === 'in_sheet');
  assert.ok(inSheet.length > 0, 'September has eBay copies of sheet rows');
  for (const o of inSheet) for (const t of ['Revenue', 'Amazon cost', 'eBay fees', 'Net profit']) assert.equal(col(t)(o), '', `${t} blank for ${o.order_id}`);
  const net = sep.reduce((t, o) => t + (col('Net profit')(o) === '' ? 0 : cents(col('Net profit')(o))), 0);
  assert.equal(net, sep.filter((o) => o.counted).reduce((t, o) => t + cents(o.net), 0));
  assert.equal(col('Counted')(row('21-15205-89610')), 'yes');
  assert.equal(col('Settles in')(row('21-15205-89610')), '2026-10');
  assert.equal(col('Date')(row('26-15207-83680')), '2026-09-30', 'the Arizona day (Oct 1 05:11 UTC is Sep 30 in Arizona)');
  assert.equal(col('eBay order')(refundLine('08-15199-12018')), '08-15199-12018');
});

console.log('Editor (plan items 17 and 19)');
await check('with nothing staged the Editor shows exactly the server net for every row (fee credits, email Amazon refunds)', () => {
  for (const o of data.orders) {
    const r = E.recompute(E.editorRow(o));
    if (o.has_cost && !o.excluded) assert.equal(r.net, o.net, `${o.order_id}: editor ${r.net} vs server ${o.net}`);
  }
  const seal = row('15-15253-44046');
  assert.equal(seal.net, 0, 'SEALIGHT refunded in its own period nets to $0.00 on the server');
  assert.equal(E.recompute(E.editorRow(seal)).net, 0, 'and in the Editor (it used to show -$13.80)');
});
await check('refund lines are shown as refund lines: read-only, the server net and status, never "Awaiting email"', () => {
  const r = E.recompute(E.editorRow(refundLine('08-15199-12018')));
  assert.equal(r.read_only, true);
  assert.equal(r.net, -19.63);
  assert.equal(r.view_status, 'returned');
  assert.equal(E.isReadOnlyRow({ order_id: 'REFUND:08-15199-12018:2026-10' }), true);
  // A staged value on a refund line changes nothing (the page also puts the cell back and never sends it)
  assert.equal(E.recompute({ ...E.editorRow(refundLine('08-15199-12018')), amazon_refund: 50 }).net, -19.63);
});
await check('staged edits change only what they touch, starting from the server numbers', () => {
  const d = E.editorRow(row('21-15205-89610'));
  assert.equal(E.recompute({ ...d, cost_override: 30 }).net, Math.round((row('21-15205-89610').net - (30 - 26.12)) * 100) / 100);
  const seal = E.editorRow(row('15-15253-44046'));
  assert.equal(E.recompute({ ...seal, amazon_refund: 0 }).net, -10.79, 'zeroing the emailed Amazon refund takes it off');
});
await check('pasted amounts read the way people write them; junk and negative costs are refused, never saved as blank', () => {
  assert.equal(E.normVal('cost_override', '$16.19'), 16.19);
  assert.equal(E.normVal('cost_override', '1,234'), 1234);
  assert.equal(E.normVal('cost_override', '1,234.50'), 1234.5);
  assert.equal(E.normVal('amount', '(12.50)'), -12.5);
  assert.equal(E.normVal('cost_override', ' 16.19 USD '), 16.19);
  assert.equal(E.normVal('cost_override', ''), null, 'a cleared cell removes the override on purpose');
  assert.ok(Number.isNaN(E.normVal('cost_override', 'sixteen')));
  assert.ok(Number.isNaN(E.normVal('cost_override', '1,23')), 'an ambiguous comma is not guessed');
  assert.match(E.moneyError('cost_override', E.normVal('cost_override', 'sixteen')), /isn’t an amount/);
  assert.match(E.moneyError('cost_override', -42.89), /negative/);
  assert.match(E.moneyError('amazon_refund', -1), /negative/);
  assert.equal(E.moneyError('amount', -8), null, 'an operating-cost credit may be negative');
  assert.equal(E.moneyError('cost_override', 16.19), null);
});

console.log('Refund lines in analytics (plan item 25)');
await check('a refund line counts under the product it refunds: HHLPRO -3.10, Govee 0.00, no "Refund ·" products', () => {
  const prods = M.byProduct(data.orders.filter((o) => o.counted), data.orders);
  assert.ok(!prods.some((p) => p.key.startsWith('refund ·')), 'no refund-line products');
  const hhl = prods.find((p) => /hhlpro/i.test(p.title));
  assert.equal(Math.round(hhl.net * 100), -310);
  assert.equal(hhl.orders, 1, 'one sale, not two');
  assert.equal(hhl.returnCount, 1, 'returned once');
  assert.equal(Math.round(prods.find((p) => /govee/i.test(p.title)).net * 100), 0);
  // Even when only the refund line is in range (an October range), it lands on the product, keyed through the whole dataset
  const octOnly = M.byProduct(M.inRange(data.orders, M.rangeFor('month', null, '2026-10')), data.orders);
  assert.ok(octOnly.some((p) => p.key === hhl.key && Math.round(p.net * 100) === -1963 && p.orders === 0));
});
await check('refund lines are not sales: order counts, AOV, units, buyers and return rate leave them out (money stays)', () => {
  const rows = data.orders.filter((o) => o.business_month === '2026-10');
  const s = M.summarize(rows);
  const sales = rows.filter((o) => o.source !== 'refund' && !o.excluded && !o.cancelled);
  assert.equal(s.orders, sales.length);
  assert.equal(s.countedOrders, rows.filter((o) => o.counted && o.source !== 'refund').length);
  assert.equal(Math.round(s.net * 100), rows.filter((o) => o.counted).reduce((t, o) => t + cents(o.net), 0), 'refund money stays in the totals');
  assert.equal(Math.round(s.aov * 100), Math.round((s.revenueAll / sales.length) * 100));
  assert.ok(s.returnCount <= s.orders + 2 && s.returnRate <= 1);
});
await check('Watchlist: no phantom refund-line products, and a refunded sale is one refund', () => {
  const recon = W.productsToReconsider(data.orders);
  assert.ok(!recon.some((p) => /^refund ·/i.test(p.title) || p.key.startsWith('refund ·')));
  for (const p of recon) assert.ok(p.refunds <= p.n || p.n === 0, `${p.title}: ${p.refunds} refunds of ${p.n} sales`);
});
await check('promotions: a refund line is never an extra (non-ad) sale; its money goes with its sale', () => {
  const m = P.promoMonth(data.orders, '2026-10');
  const sales = data.orders.filter((o) => o.counted && o.business_month === '2026-10' && o.source !== 'refund');
  assert.equal(m.sales, sales.length);
  assert.equal(m.adSales + m.otherSales, m.sales);
  assert.equal(cents(m.profit), data.orders.filter((o) => o.counted && o.business_month === '2026-10').reduce((t, o) => t + cents(o.net), 0));
});
await check('Overview: a payment picked as Month shows that payment, to the cent of the Settlement page', () => {
  for (const m of ['2026-09', '2026-10']) {
    const r = M.rangeFor('month', null, m, { now: az('2026-10-10T12:00:00') });
    const s = M.summarize(M.inRange(data.orders, r));
    const st = settle(data, m);
    assert.equal(Math.round((s.net - M.opexFor(r, data.books.expenses).total) * 100), cents(st.businessProfit), `${m} hero = business profit`);
  }
  const oct = M.rangeFor('month', null, '2026-10', { now: az('2026-10-30T12:00:00') });
  assert.deepEqual([U.azDay(oct.start), U.azDay(oct.end)], ['2026-09-27', '2026-10-26'], 'October = Sep 27 - Oct 26');
  // The comparison for a payment is the payment before it, row for row
  const prev = M.previousRange(oct);
  assert.equal(prev.month, '2026-09');
  assert.equal(cents(M.summarize(M.inRange(data.orders, prev)).net - M.opexFor(prev, data.books.expenses).total), cents(settle(data, '2026-09').businessProfit));
});

console.log('Arizona time (plan item 27), viewer in Manila');
await check('Oct 26 4:30pm in Arizona (Oct 27 in Manila): October is "Due today" and the CSV due date is 2026-10-26', () => {
  const now = az('2026-10-26T16:30:00');
  assert.equal(new Date(now).getDate(), 27, 'the viewer is already on the 27th');
  assert.equal(U.dueStatus(U.settlementDueDate('2026-10', 26), { now }).text, 'Due today');
  assert.equal(U.settlementDueDay('2026-10', 26), '2026-10-26');
  assert.equal(U.fmtDate(U.settlementDueDate('2026-10', 26), { month: 'short', day: 'numeric' }), 'Oct 26');
  assert.equal(U.dueStatus(U.settlementDueDate('2026-10', 26), { now: az('2026-10-27T00:30:00') }).text, 'Overdue by 1 day');
});
await check('quick ranges, buckets and dates follow Arizona days', () => {
  const now = az('2026-10-26T16:30:00');
  assert.equal(U.azDay(M.rangeFor('1d', null, null, { now }).start), '2026-10-26');
  assert.equal(M.rangeFor('1d', null, null, { now }).start.toISOString(), '2026-10-26T07:00:00.000Z');
  assert.equal(U.azDay(M.rangeFor('mtd', null, null, { now }).start), '2026-10-01');
  assert.equal(M.rangeFor('month', null, undefined, { now: az('2026-10-28T09:00:00') }).month, '2026-11', 'from the 27th the current payment is next month');
  assert.equal(M.bucketKey('2026-10-01T05:11:27Z', 'day'), '2026-09-30');
  assert.equal(M.bucketKey('2026-10-01T05:11:27Z', 'month'), '2026-09');
  assert.equal(M.bucketKey('2026-10-01T05:11:27Z', 'hour'), '2026-09-30T22');
  assert.equal(M.bucketKey('2026-10-01T05:11:27Z', 'week'), '2026-09-28');
  assert.equal(U.fmtDate('2026-09-27'), 'Sep 27', 'a plain date is that day for every viewer');
  assert.equal(U.fmtDate('2026-10-01T05:11:27Z'), 'Sep 30');
  assert.equal(U.monthLabel('2026-10', 'long'), 'October 2026');
});

console.log('Operating costs (plan item 24)');
await check('a cost entered on Oct 28 (Arizona) goes on the November payment; a paid payment is skipped', () => {
  assert.equal(OX.defaultCostMonth({ books: {}, now: az('2026-10-28T10:00:00') }), '2026-11');
  assert.equal(OX.defaultCostMonth({ books: {}, now: az('2026-10-26T23:30:00') }), '2026-10');
  assert.equal(OX.defaultCostMonth({ books: { payments: [{ month: '2026-10' }] }, now: az('2026-10-26T10:00:00') }), '2026-11');
  assert.equal(OX.defaultCostMonth({ books: data.books, now: az('2026-09-20T10:00:00') }), '2026-10', 'September is paid, so its costs go on October');
});
await check('a credit is a negative amount with a note, on an open payment: a -8 Proxy credit raises November by $4', () => {
  assert.equal(OX.parseAmount('-8'), -8);
  assert.equal(OX.parseAmount('$16.19'), 16.19);
  assert.equal(OX.parseAmount('(8.00)'), -8);
  assert.equal(OX.parseAmount('abc'), null);
  const paid = OX.paidMonthsOf(data.books);
  assert.equal(OX.costProblem({ month: '2026-11', amount: -8, note: '', paidBy: 'seller' }, paid), 'note');
  assert.equal(OX.costProblem({ month: '2026-11', amount: 5, note: '', paidBy: '' }, paid), 'paid_by', 'who paid is a required choice');
  assert.equal(OX.costProblem({ month: '2026-09', amount: 5, note: '', paidBy: 'seller' }, paid), 'paid', 'September is already paid');
  assert.equal(OX.costProblem({ month: '2026-11', amount: -8, note: 'Proxy credit', paidBy: 'seller' }, paid), null);
  const base = settleMonth({ month: '2026-11', orders: data.orders, expenses: data.books.expenses, settlements: data.books.settlements, splitAmazon: 50 });
  const withCredit = settleMonth({ month: '2026-11', orders: data.orders, expenses: [...data.books.expenses, { month: '2026-11', category: 'Proxy', amount: -8, paid_by: 'seller' }], settlements: data.books.settlements, splitAmazon: 50 });
  assert.equal(cents(withCredit.sellerSends) - cents(base.sellerSends), 400);
});

console.log('Sync banners and the check before a payment (plan items 6, 12, 14)');
const failingEbay = { configured: true, last: { ok: true, finished_at: '2026-10-10T18:59:00Z' }, lastSuccess: '2026-10-10T18:59:00Z',
  steps: { orders: { ok: true, at: '2026-10-10T18:59:29Z' }, finances: { ok: false, at: '2026-10-10T18:59:31Z', message: 'HTTP 500 from Finances (4 tries)' }, returns: { ok: false, at: '2026-10-10T18:59:33Z', message: 'HTTP 403 insufficient scope' } } };
await check('a failed Finances or Returns step is named in the banner; an old server without steps shows none', () => {
  const issues = H.ebayStepIssues(failingEbay, az('2026-10-10T12:00:00'));
  assert.deepEqual(issues.map((i) => i.step), ['finances', 'returns']);
  assert.match(H.ebayIssueText(issues), /Finances.*failed.*HTTP 500.*Returns failed.*403/);
  assert.deepEqual(H.ebayStepIssues({ configured: true, last: { ok: true } }), []);
  assert.deepEqual(H.ebayStepIssues(undefined), []);
  const stale = H.ebayStepIssues({ configured: true, steps: { finances: { ok: true, at: '2026-10-10T08:00:00Z' } } }, az('2026-10-10T12:00:00'));
  assert.equal(stale[0]?.problem, 'stale', 'a step that hasn\'t run in over 3 hours');
  assert.equal(H.ebayStepIssues({ configured: true, steps: { returns: { ok: 'skipped', message: 'scope missing' } } })[0].problem, 'skipped');
});
await check('unread Amazon emails are listed; a missing field is no emails', () => {
  assert.deepEqual(H.emailFailures({ configured: true }), []);
  const f = H.emailFailures({ failed: [{ subject: 'Ordered: 2 items', order_ids: ['111-0000001-0000001'], note: 'two orders under one total' }] });
  assert.equal(f.length, 1);
  assert.match(H.emailFailureText(f[0]), /Ordered: 2 items · 111-0000001-0000001 · two orders under one total/);
});
await check('before paying October: the sale awaiting its cost, fresh sales that may get ad fees, a failed sync and the period not being over', () => {
  const now = az('2026-10-10T14:00:00');
  const w = H.paymentWarnings({ month: '2026-10', orders: data.orders, ebay: failingEbay, email: { configured: true, last: { ok: true, at: '2026-10-10T18:59:39Z' }, failed: ['Refund issued (no order number)'] }, now });
  const by = Object.fromEntries(w.map((x) => [x.key, x]));
  assert.ok(by.waiting?.items.some((i) => /17-15263-09121/.test(i) && /\$23\.99/.test(i)), 'Graphique awaiting its cost');
  assert.ok(by.sync?.items.some((i) => /Finances/.test(i)) && by.sync.items.some((i) => /Returns/.test(i)) && by.sync.items.some((i) => /not read/.test(i)));
  assert.ok(by.early, 'October runs through the 26th');
  const after = H.paymentWarnings({ month: '2026-10', orders: data.orders.filter((o) => o.status !== 'awaiting_cost'), ebay: { configured: true, last: { ok: true, finished_at: '2026-10-27T15:00:00Z' }, lastSuccess: '2026-10-27T15:00:00Z' }, email: { configured: true, last: { ok: true, at: '2026-10-27T15:00:00Z' } }, now: az('2026-10-27T08:30:00') });
  assert.deepEqual(after.map((x) => x.key).filter((k) => k !== 'returns'), [], 'nothing to warn about after 7am on the 27th with every sync current');
});
await check('a sale less than 48 hours old with no ad fee yet is flagged; one with its ad fee is not', () => {
  const fresh = { order_id: 'FRESH-1', source: 'ebay', counted: true, status: 'profitable', title: 'Veemoon Thing', created_at: '2026-10-26T16:55:00Z', settle_month: '2026-10', ad_fees: 0, revenue: 27.99 };
  const charged = { ...fresh, order_id: 'FRESH-2', ad_fees: 1.5 };
  const w = H.paymentWarnings({ month: '2026-10', orders: [fresh, charged], now: az('2026-10-26T20:00:00') });
  const ad = w.find((x) => x.key === 'ad_fees');
  assert.equal(ad.items.length, 1);
  assert.match(ad.items[0], /FRESH-1/);
});

await check('a step is not "behind" while a sync is running, and a step that runs less often is judged by its own interval', () => {
  const now = az('2026-10-10T12:00:00');
  const old = { ok: true, at: '2026-10-10T08:00:00Z' }; // 11 hours before
  assert.equal(H.ebayStepIssues({ configured: true, running: true, steps: { finances: old } }, now).length, 0, 'sync running');
  assert.equal(H.ebayStepIssues({ configured: true, last: { finished_at: null }, steps: { finances: old } }, now).length, 0, 'sync log row not finished');
  assert.equal(H.ebayStepIssues({ configured: true, steps: { returns: { ...old, interval_minutes: 360 } } }, now).length, 0, 'returns every 6 hours: 11 hours is fine');
  assert.equal(H.ebayStepIssues({ configured: true, steps: { returns: { ...old, stale_after_minutes: 600 } } }, now)[0]?.problem, 'stale', '11 hours is past a 10-hour limit');
  assert.equal(H.staleAfterMs({}), 3 * 3600_000);
  // A failure still shows during a sync
  assert.equal(H.ebayStepIssues({ configured: true, running: true, steps: { finances: { ok: false, message: 'HTTP 500' } } }, now)[0]?.problem, 'failed');
});

console.log('Payments that have been made never change (review of the audit fixes)');
const paid = OX.paidMonthsOf(data.books);
await check('"Pay the remaining" sends what is left signed like the server (sellerSends - paid), so a month where Myles pays Drew isn\'t refused', () => {
  const sep = settle(data, '2026-09');
  assert.equal(RM.remainingFor(sep), Math.round((sep.sellerSends - 704.4) * 100) / 100);
  assert.equal(RM.remainingFor({ sellerSends: 719.55, paid: 704.4 }), 15.15);
  assert.equal(RM.remainingFor({ sellerSends: -50, paid: null }), -50, 'reverse month, nothing paid: -50, not 50');
  assert.equal(RM.remainingFor({ sellerSends: -50, paid: -20 }), -30, 'reverse month, part paid (stored negative)');
  assert.equal(RM.remainingFor({ sellerSends: 240.87, paid: 250 }), -9.13, 'overpaid');
});
await check('a payment dated after today in Arizona is refused, even when it is already tomorrow for the viewer', () => {
  const now = az('2026-10-26T20:00:00'); // Oct 27 in Manila
  assert.equal(H.paymentDateProblem('2026-10-27', now), 'future');
  assert.equal(H.paymentDateProblem('2026-10-26', now), null);
  assert.equal(H.paymentDateProblem('', now), 'missing');
  assert.equal(H.paymentDateProblem('10/26/2026', now), 'format');
});
await check('a cost on the paid September payment can\'t be edited, deleted or moved, and nothing can be added or moved onto it', () => {
  assert.ok(paid.has('2026-09') && !paid.has('2026-10'));
  const sepCost = { id: 1, month: '2026-09', category: 'eBay Sub Cost Total', amount: 16.19 };
  assert.equal(OX.closedCostMonth({ was: sepCost, now: { ...sepCost, amount: 20 } }, paid), '2026-09', 'amount edit');
  assert.equal(OX.closedCostMonth({ was: sepCost, now: { ...sepCost, amount: -16.19 } }, paid), '2026-09', 'turned into a credit');
  assert.equal(OX.closedCostMonth({ was: sepCost, now: null }, paid), '2026-09', 'delete');
  assert.equal(OX.closedCostMonth({ was: sepCost, now: { ...sepCost, month: '2026-10' } }, paid), '2026-09', 'moved off September');
  assert.equal(OX.closedCostMonth({ was: { ...sepCost, month: '2026-10' }, now: sepCost }, paid), '2026-09', 'moved onto September');
  assert.equal(OX.closedCostMonth({ now: sepCost }, paid), '2026-09', 'new row on September');
  assert.equal(OX.closedCostMonth({ was: { ...sepCost, month: '2026-10' }, now: { ...sepCost, month: '2026-10', amount: 20 } }, paid), null, 'October is open');
  // The real books: September's costs are on a paid payment, so each is locked
  const sepCosts = data.books.expenses.filter((e) => e.month === '2026-09');
  assert.ok(sepCosts.length > 0 && sepCosts.every((e) => OX.closedCostMonth({ was: e }, paid) === '2026-09'));
});
await check('Copy last month, when October was paid early: copies October onto November and skips names already on November', () => {
  const ex = [
    { month: '2026-09', category: 'Old', amount: 1, paid_by: 'seller' },
    { month: '2026-10', category: 'Proxies', amount: 9.5, paid_by: 'seller' },
    { month: '2026-10', category: 'eBay Sub Cost Total', amount: 16.19, paid_by: 'seller' },
    { month: '2026-11', category: ' proxies ', amount: 9.5, paid_by: 'seller' },
  ];
  const into = OX.nextOpenMonth('2026-10', new Set(['2026-10']));
  const plan = OX.copyPlan(ex, into);
  assert.deepEqual([plan.into, plan.last], ['2026-11', '2026-10']);
  assert.deepEqual(plan.toCopy.map((e) => e.category), ['eBay Sub Cost Total']);
  assert.deepEqual(plan.skipped.map((e) => e.category), ['Proxies']);
  assert.equal(plan.total, 16.19);
});
await check('an Editor edit that would change the paid September payment is refused, with the before and after amounts', () => {
  const staged = (id, ch) => new Map([[id, ch]]);
  const sepRow = data.orders.find((o) => o.source === 'ledger' && o.counted && M.rowMonth(o) === '2026-09' && !o.ledger?.is_refund);
  const sendsSep = settle(data, '2026-09').sellerSends;
  const hit = E.paidPaymentChanges({ orders: data.orders, books: data.books, staged: staged(sepRow.order_id, { cost_override: Math.round((sepRow.cost + 10) * 100) / 100 }), splitAmazon: 50 });
  assert.equal(hit.length, 1);
  assert.equal(hit[0].month, '2026-09');
  assert.equal(hit[0].before, sendsSep);
  assert.equal(cents(hit[0].after) - cents(hit[0].before), 500, '$10 more cost: Myles is reimbursed $10 and his half of the profit is $5 less');
  assert.deepEqual(hit[0].rows, [sepRow.order_id]);
  assert.equal(E.paidPaymentChanges({ orders: data.orders, books: data.books, staged: staged(sepRow.order_id, { excluded: true }), splitAmazon: 50 })[0]?.month, '2026-09', 'excluding a row it covered');
  assert.deepEqual(E.paidPaymentChanges({ orders: data.orders, books: data.books, staged: staged(sepRow.order_id, { notes: 'checked' }), splitAmazon: 50 }), [], 'a note changes no money');
  assert.deepEqual(E.paidPaymentChanges({ orders: data.orders, books: data.books, staged: staged('21-15205-89610', { cost_override: 30 }), splitAmazon: 50 }), [], 'October is still open');
});

// ---- October is paid early (Oct 20): it closes with the rows it covered. Graphique, still waiting for its cost, is not one.
const octKeys = data.orders.filter((o) => o.counted && o.settle_month === '2026-10').map((o) => o.order_id).sort();
const octSends = settle(data, '2026-10').sellerSends;
await q("insert into settlement_payments (month, amount, paid_at, note) values ('2026-10', $1, '2026-10-20', 'paid early')", [octSends]);
await q("insert into settlement_freeze (month, row_keys, totals, source) values ('2026-10', $1::jsonb, '{}'::jsonb, 'test')", [JSON.stringify(octKeys)]);
const paidOct = await load();
await check('after October is paid: costing Graphique isn\'t refused (it goes on November); excluding VIVAGLORY (on October) is', () => {
  assert.ok(OX.paidMonthsOf(paidOct.books).has('2026-10'));
  const g = paidOct.orders.find((o) => o.order_id === '17-15263-09121');
  assert.equal(g.counted, false);
  assert.deepEqual(E.paidPaymentChanges({ orders: paidOct.orders, books: paidOct.books, staged: new Map([[g.order_id, { cost_override: 12.5 }]]), splitAmazon: 50 }), []);
  const v = paidOct.orders.find((o) => o.order_id === '21-15205-89610');
  const hit = E.paidPaymentChanges({ orders: paidOct.orders, books: paidOct.books, staged: new Map([[v.order_id, { excluded: true }]]), splitAmazon: 50 });
  assert.equal(hit[0]?.month, '2026-10');
  assert.equal(hit[0].before, octSends);
  // Its $26.12 cost is no longer reimbursed and its $12.22 profit leaves the split: Drew sends $26.12 + $6.11 less
  assert.equal(cents(hit[0].before) - cents(hit[0].after), cents(v.cost) + Math.round(cents(v.net) / 2));
});
await q("insert into order_overrides (order_id, cost_override) values ('17-15263-09121', 12.5)");
const carried = await load();
await check('a sale carried onto a later payment (Graphique, sold Oct 9, costed after October was paid) is a correction for October: paid on November, not November’s own numbers', () => {
  const g = carried.orders.find((o) => o.order_id === '17-15263-09121');
  assert.deepEqual([g.counted, g.settle_month, g.correction_for, U.azDay(g.created_at)], [true, '2026-11', '2026-10', '2026-10-09']);
  const r = M.rangeFor('month', null, '2026-11', { now: az('2026-11-10T12:00:00') });
  const rows = M.inRange(carried.orders, r);
  assert.ok(!rows.includes(g), 'not in November’s own view');
  const bs = M.buckets(r, rows, 'day');
  assert.equal(bs.reduce((t, b) => t + cents(b.net), 0), cents(M.summarize(rows).net), 'the buckets add up to the hero');
  const nov = settle(carried, '2026-11');
  assert.equal(cents(M.summarize(rows).net), cents((nov.own || nov).orderProfit), 'November’s own view is its payment less the correction');
  assert.deepEqual(nov.corrections.rows.map((x) => x.order_id), [g.order_id]);
  assert.equal(cents(nov.corrections.profit), cents(g.net), 'the correction is the sale’s profit');
  assert.equal(settle(carried, '2026-10').sellerSends, octSends, 'October is unchanged');
});

// ---- The production snapshot the audit was run on (Oct 10 2026, /api/data's orders and books). It holds buyer data, so
// it is never in the repo: point DD_SNAPSHOT at the file to check the audit's own numbers against the pages' math.
const snapPath = process.env.DD_SNAPSHOT;
if (snapPath && fs.existsSync(snapPath)) {
  console.log('Production snapshot (the audit\'s own numbers)');
  const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
  const sd = { orders: snap.orders, books: snap.books, settings };
  await check('statements: Sep 32 lines $248.02, Oct 20 lines $193.88, both add up to the payment', () => {
    const sep = RM.statementFor(sd, '2026-09');
    const oct = RM.statementFor(sd, '2026-10');
    assert.deepEqual([sep.lines.length, sep.tot.net, sep.matches], [32, 24802, true]);
    assert.deepEqual([oct.lines.length, oct.tot.net, oct.matches], [20, 19388, true]);
    assert.deepEqual([cents(sep.s.sellerSends), cents(oct.s.sellerSends)], [71955, 24087]);
  });
  await check('tax 2026: gross - fees - refunds + payout-only = eBay payouts 3,317.77; buyer refunds 207.40; eBay fees 554.63 (553.03 + 1.60 sheet refund fees)', () => {
    const T = RM.taxTotals(RM.taxRows(snap.orders, '2026'));
    assert.equal(T.payout, 331777);
    // Buyers got back HHLPRO 142.41 + Govee 64.99; the four sheet refund rows are 40-cent eBay fees, not refunds
    assert.equal(T.refunds, 20740);
    assert.equal(T.fees, 55303 + 160);
    assert.equal(T.gross - T.fees - T.refunds + T.noGrossPayout, T.payout);
  });
  await check('Sep Orders CSV: Net over counted rows is 283.94', () => {
    const net = RM.ORDER_EXPORT.find((c) => c.title === 'Net profit').get;
    assert.equal(snap.orders.filter((o) => o.business_month === '2026-09').reduce((t, o) => t + (net(o) === '' ? 0 : cents(net(o))), 0), 28394);
  });
  await check('products: HHLPRO -3.10, Govee 0.00, no refund-line products; calendar October has 14 counted sales', () => {
    const prods = M.byProduct(snap.orders.filter((o) => o.counted), snap.orders);
    assert.equal(cents(prods.find((p) => /hhlpro/i.test(p.title)).net), -310);
    assert.equal(cents(prods.find((p) => /govee control box/i.test(p.title)).net), 0);
    assert.ok(!prods.some((p) => p.key.startsWith('refund')));
    assert.equal(M.summarize(snap.orders.filter((o) => o.business_month === '2026-10')).countedOrders, 14);
  });
  await check('Overview Month = Sep hero is the payment\'s 131.95; the Editor matches the server on every row', () => {
    const r = M.rangeFor('month', null, '2026-09');
    assert.equal(cents(M.summarize(M.inRange(snap.orders, r)).net - M.opexFor(r, snap.books.expenses).total), 13195);
    for (const o of snap.orders) if (o.has_cost && !o.excluded) assert.equal(E.recompute(E.editorRow(o)).net, o.net, o.order_id);
    const rl = E.recompute(E.editorRow(snap.orders.find((o) => o.order_id === 'REFUND:08-15199-12018:2026-10')));
    assert.deepEqual([rl.net, rl.read_only, rl.view_status], [-19.63, true, 'returned']);
  });
  await check('September (704.40 paid) can not be changed: a $10 cost edit on one of its rows is refused (719.55 -> 724.55), and so is any edit of its costs', () => {
    const r = snap.orders.find((o) => o.counted && o.source === 'ledger' && M.rowMonth(o) === '2026-09' && !o.ledger?.is_refund);
    const hit = E.paidPaymentChanges({ orders: snap.orders, books: snap.books, staged: new Map([[r.order_id, { cost_override: Math.round((r.cost + 10) * 100) / 100 }]]), splitAmazon: 50 });
    assert.deepEqual(hit.map((h) => [h.month, h.before, h.after]), [['2026-09', 719.55, 724.55]]);
    const paidSnap = OX.paidMonthsOf(snap.books);
    for (const e of snap.books.expenses.filter((x) => x.month === '2026-09')) assert.equal(OX.closedCostMonth({ was: e, now: null }, paidSnap), '2026-09', e.category);
  });
} else console.log('(production snapshot checks skipped: set DD_SNAPSHOT to the audit\'s dataset.json to run them)');

// Adjustment lines (HOLD:/ADJ:, money moved between payments after one was paid) are never sales, products, tax lines or
// editable rows
await check('adjustment lines are not sales, products, tax lines or editable', () => {
  const sale = { order_id: '01-1', source: 'ebay', counted: true, title: 'Widget', items: [{ sku: 'W' }], returns: [], amazon_orders: [], tracking_numbers: [], business_month: '2026-10', revenue: 20, fees: 2, refunds: 0, cost: 10, amazon_refund: 0, ad_fees: 0, extra_cost: 0, net: 8 };
  const hold = { order_id: 'HOLD:01-1', source: 'adjustment', adjustment: true, adjustment_of: '01-1', counted: true, title: 'Held as paid · Widget', items: [], returns: [], amazon_orders: [], tracking_numbers: [], business_month: '2026-10', revenue: 5, fees: 0, refunds: 0, cost: 0, amazon_refund: 0, ad_fees: 0, extra_cost: 0, net: 5 };
  const adj = { ...hold, order_id: 'ADJ:01-1:2026-09', title: 'Change after the 2026-09 payment · Widget', revenue: -5, net: -5 };
  assert.equal(M.isSale(hold), false);
  assert.equal(M.saleIdOf(adj), '01-1');
  assert.deepEqual(M.byProduct([sale, hold, adj]).map((p) => [p.key, p.countedRows]), [['w', 1]]);
  assert.equal(RM.taxRows([sale, hold, adj], '2026').length, 1);
  assert.equal(E.isReadOnlyRow(adj), true);
  assert.equal(E.isReadOnlyRow({ order_id: 'HOLD:x' }), true);
  assert.equal(M.STATUS_META.adjustment.label, 'Payment adjustment');
});

// A correction for an earlier paid period (Mozi Wash) is money on the later payment but not that period's own numbers
await check('a pay period shows its own profit; a correction for an earlier paid period is set apart and still paid', () => {
  const mk = (id, extra) => ({ order_id: id, source: 'ebay', counted: true, title: id, items: [], returns: [], amazon_orders: [], tracking_numbers: [], settle_month: '2026-10', business_month: '2026-10', created_at: '2026-10-05T19:00:00Z', revenue: 0, fees: 0, refunds: 0, cost: 0, amazon_refund: 0, ad_fees: 0, extra_cost: 0, net: 0, ...extra });
  const sale = mk('S1', { revenue: 100, fees: 10, cost: 50, net: 40 });
  const mozi = mk('REFUND:M:2026-10', { source: 'refund', refund_of: 'M', correction_for: '2026-09', business_month: '2026-09', created_at: '2026-09-11T05:22:00Z', refunds: 55.58, net: -55.58 });
  const s = settleMonth({ month: '2026-10', orders: [sale, mozi], expenses: [{ month: '2026-10', amount: 20, paid_by: 'seller' }], splitAmazon: 50 });
  assert.deepEqual([s.own.businessProfit, s.own.sellerSends], [20, 60]);
  assert.deepEqual([s.corrections.profit, s.corrections.sellerSends], [-55.58, -27.79]);
  assert.deepEqual([s.businessProfit, s.sellerSends], [-35.58, 32.21]);
  const r = { month: '2026-10', start: new Date('2026-09-27T07:00:00Z'), end: new Date('2026-10-27T06:59:59Z') };
  assert.deepEqual(M.inRange([sale, mozi], r).map((o) => o.order_id), ['S1'], 'the pay-period view is the period alone');
  assert.deepEqual(M.inRange([sale, mozi], { start: new Date('2026-09-01T07:00:00Z'), end: new Date('2026-10-27T06:59:59Z') }).length, 2, 'a date range has both');
  const st = RM.statementFor({ orders: [sale, mozi], books: { expenses: [{ month: '2026-10', amount: 20, paid_by: 'seller' }], settlements: [] }, settings: { split_amazon: 50 } }, '2026-10');
  assert.deepEqual([st.lines.map((l) => l.o.order_id), st.fixLines.map((l) => l.o.order_id), st.matches], [['S1'], ['REFUND:M:2026-10'], true], 'the statement lists the correction apart and still adds up');
});

await closeDb();
fs.rmSync(dir, { recursive: true, force: true });
console.log(failed ? '\nFRONTEND: FAILED' : '\nFRONTEND: ALL CHECKS PASSED');
process.exitCode = failed ? 1 : 0;
