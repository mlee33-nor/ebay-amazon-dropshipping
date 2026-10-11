// Core money rules from the audit backlog: a paid (closed) payment never changes, whatever turns up later; late
// money lands once on the next open payment. Throwaway database; never touches real data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-core-'));
process.env.LOCAL_PG_DIR = dir;
process.env.LOCAL_PG_PORT = String(5460 + Number(process.env.TEST_PG_OFFSET || 0)); // TEST_PG_OFFSET lets parallel runs use their own ports
delete process.env.DATABASE_URL;
const { initDb, q, closeDb, setSetting } = await import('../src/db.js');
const { normalizeOrder, upsertOrder } = await import('../src/ebay.js');
const { buildDataset, buildBooks, rowCents } = await import('../src/dataset.js');
const { settleMonth } = await import('../public/js/settlement.js');
const { matchLedger, importLedgerCsv } = await import('../src/ledger.js');
await initDb();

let failed = false;
const check = async (label, fn) => { try { await fn(); console.log(`  PASS  ${label}`); } catch (e) { failed = true; console.log(`  FAIL  ${label}\n        ${e.message}`); } };
const order = (id, at, title, price, { fee = +(price * 0.136).toFixed(2), city = 'Mesa', st = 'AZ', name = 'Test Buyer', tracking } = {}) =>
  upsertOrder(normalizeOrder({
    orderId: id, creationDate: at, orderFulfillmentStatus: 'FULFILLED', cancelStatus: { cancelState: 'NONE_REQUESTED' },
    pricingSummary: { priceSubtotal: { value: String(price) }, total: { value: String(price) } },
    totalMarketplaceFee: { value: String(fee) }, paymentSummary: { refunds: [] },
    fulfillmentStartInstructions: [{ shippingStep: { shipTo: { fullName: name, contactAddress: { city, stateOrProvince: st } } } }],
    lineItems: [{ lineItemId: `${id}-1`, title, quantity: 1, lineItemCost: { value: String(price) }, total: { value: String(price) } }],
  }));
const tx = (id, orderId, type, amount, fee, at, extra = {}) => q(
  `insert into ebay_transactions (transaction_id, order_id, type, fee_type, booking_entry, amount, fee_amount, transaction_at)
   values ($1,$2,$3,$4,$5,$6,$7,$8)`, [id, orderId, type, extra.feeType || null, extra.booking || (type === 'CREDIT' ? 'CREDIT' : 'DEBIT'), amount, fee, at]);
const settle = async (month) => {
  const data = await buildDataset();
  const books = await buildBooks();
  return { data, books, s: settleMonth({ month, orders: data, expenses: books.expenses, settlements: books.settlements, splitAmazon: 50 }) };
};
// What the payments endpoint does: record the payment and close the period with every row's amounts
async function pay(month, amount, paidAt) {
  const data = await buildDataset();
  const books = await buildBooks();
  const rows = data.filter((o) => o.counted && o.settle_month === month);
  const s = settleMonth({ month, orders: data, expenses: books.expenses, settlements: books.settlements, splitAmazon: 50 });
  await q('insert into settlement_payments (month, amount, paid_at) values ($1, $2, $3)', [month, amount ?? s.sellerSends, paidAt]);
  await q('insert into settlements (month, paid, paid_at) values ($1, $2, $3) on conflict (month) do update set paid = excluded.paid, paid_at = excluded.paid_at', [month, amount ?? s.sellerSends, paidAt]);
  await q("insert into settlement_freeze (month, row_keys, row_values, totals, source) values ($1, $2::jsonb, $3::jsonb, $4::jsonb, 'test')",
    [month, JSON.stringify(rows.map((o) => o.order_id)), JSON.stringify(Object.fromEntries(rows.map((o) => [o.order_id, { ...rowCents(o), title: o.title }]))),
      JSON.stringify({ opex: s.opex, opexSeller: s.opexSeller, opexAmazon: s.opexAmazon, split: 50, sellerSends: s.sellerSends })]);
  return s;
}
await setSetting('business_start', '2026-01');

// ---- a closed payment keeps its amounts: a late ad fee, an edited cost and a late operating cost
await order('LATE-AD', '2027-01-05T19:00:00Z', 'Late Ad Fee Widget', 40, { fee: 5.44 });
await q("insert into order_overrides (order_id, cost_override) values ('LATE-AD', 20)");
await q("insert into expenses (month, category, amount, paid_by) values ('2027-01', 'Software', 30, 'seller')");
const jan = await pay('2027-01', null, '2027-01-26');
await check('closing January records it as paid in full', async () => {
  const { s } = await settle('2027-01');
  assert.equal(s.balance, 0);
  assert.equal(s.sellerSends, jan.sellerSends);
});
await q("update ebay_orders set ad_fees = 2.10 where order_id = 'LATE-AD'"); // eBay charges the ad fee after the payment
await q("update order_overrides set cost_override = 21.50 where order_id = 'LATE-AD'"); // and the cost is corrected
await q("insert into expenses (month, category, amount, paid_by) values ('2027-01', 'Proxy', 4, 'seller')"); // a cost entered late
await check('a late ad fee, a corrected cost and a late operating cost leave paid January exactly as paid', async () => {
  const { s } = await settle('2027-01');
  assert.equal(s.sellerSends, jan.sellerSends);
  assert.equal(s.balance, 0);
  assert.equal(s.businessProfit, jan.businessProfit);
});
await check('...and land once on February as an adjustment: ad fee -2.10, cost +1.50 (Myles is owed it), opex +4', async () => {
  const { data, s } = await settle('2027-02');
  const adj = data.find((o) => o.order_id === 'ADJ:LATE-AD:2027-01');
  assert.ok(adj, 'adjustment line on February');
  assert.equal(adj.ad_fees, 2.1);
  assert.equal(adj.cost, 1.5);
  assert.equal(s.opex, 4);
  assert.equal(s.orders, 0, 'an adjustment is not a sale');
  // Profit: -2.10 ad -1.50 cost -4 opex = -7.60; Myles: +1.50 reimbursement -3.80 half the loss = -2.30
  assert.equal(s.businessProfit, -7.6);
  assert.equal(s.sellerSends, -2.3);
});

// ---- changing the split later only affects open payments
await setSetting('split_amazon', 60);
await check('changing the split in Settings leaves the closed January split alone', async () => {
  const books = await buildBooks();
  const data = await buildDataset();
  const s = settleMonth({ month: '2027-01', orders: data, expenses: books.expenses, settlements: books.settlements, splitAmazon: 60 });
  assert.equal(s.sellerSends, jan.sellerSends);
});
await setSetting('split_amazon', 50);

// ---- cancelled after the purchase: Amazon's refund weeks later still comes back to the business
await upsertOrder(normalizeOrder({
  orderId: 'CXL-LATE', creationDate: '2027-03-03T19:00:00Z', orderFulfillmentStatus: 'NOT_STARTED', cancelStatus: { cancelState: 'CANCELED' },
  pricingSummary: { priceSubtotal: { value: '50' }, total: { value: '50' } }, totalMarketplaceFee: { value: '6.8' },
  fulfillmentStartInstructions: [{ shippingStep: { shipTo: { fullName: 'Late Cancel', contactAddress: { city: 'Mesa', stateOrProvince: 'AZ' } } } }],
  lineItems: [{ lineItemId: 'CXL-LATE-1', title: 'Late Cancel Lamp', quantity: 1, lineItemCost: { value: '50' }, total: { value: '50' } }],
}));
await q("insert into order_overrides (order_id, cost_override) values ('CXL-LATE', 30)");
await q("insert into amazon_refunds (message_id, amazon_order_id, amount, received_at, title) values ('m-cxl-late', '114-5555555-0000001', 30, '2027-04-02T19:00:00Z', 'Late Cancel Lamp')");
await check('a cancelled sale whose purchase was refunded in a later period gets that refund back (no half-cost leak)', async () => {
  const data = await buildDataset();
  const sale = data.find((o) => o.order_id === 'CXL-LATE');
  assert.equal(sale.status, 'cancelled_after_purchase');
  assert.equal(sale.net, -30);
  const ev = data.find((o) => o.refund_of === 'CXL-LATE');
  assert.ok(ev, 'refund line booked');
  assert.equal(ev.settle_month, '2027-04');
  assert.equal(ev.amazon_refund, 30);
  assert.equal(ev.net, 30);
});

// ---- a typed refund override keeps eBay's fee credit and later Amazon refunds
await order('OVR-1', '2027-05-03T19:00:00Z', 'Override Gadget', 100, { fee: 13.6 });
await q("insert into order_overrides (order_id, cost_override, refund_override) values ('OVR-1', 70, 100)");
await tx('T-OVR', 'OVR-1', 'REFUND', 86.8, 13.2, '2027-05-10T19:00:00Z');
await q("insert into amazon_refunds (message_id, amazon_order_id, amount, received_at, title) values ('m-ovr', '114-5555555-0000002', 70, '2027-06-01T19:00:00Z', 'Override Gadget')");
await check('a refund override of the whole $100 still gets eBay\'s $13.20 fee credit (net -$0.40 - cost), and Amazon\'s refund later', async () => {
  const data = await buildDataset();
  const sale = data.find((o) => o.order_id === 'OVR-1');
  assert.equal(sale.fees, 0.4);
  assert.equal(sale.net, -70.4);
  const ev = data.find((o) => o.refund_of === 'OVR-1');
  assert.equal(ev.amazon_refund, 70);
  assert.equal(ev.refunds, 0, 'the eBay refund is not booked twice');
});

// ---- a duplicate refund email can never refund more than the order cost
await order('DUP-REF', '2027-05-04T19:00:00Z', 'Duplicate Refund Kettle', 60, { fee: 8.16 });
await q("insert into amazon_lines (line_key, amazon_order_id, order_date, title, quantity, line_total, order_status, source) values ('114-4444444-0000001|email|1', '114-4444444-0000001', '2027-05-04', 'Kettle', 1, 40, 'Ordered', 'email')");
await q("insert into order_links (amazon_order_id, ebay_order_id, method) values ('114-4444444-0000001', 'DUP-REF', 'manual')");
await q("insert into amazon_refunds (message_id, amazon_order_id, amount, received_at) values ('m-dup-a', '114-4444444-0000001', 40, '2027-06-02T19:00:00Z'), ('m-dup-b', '114-4444444-0000001', 40, '2027-06-02T20:00:00Z')");
await check('two copies of a $40 Amazon refund email on a $40 order book $40 once', async () => {
  const ev = (await buildDataset()).find((o) => o.refund_of === 'DUP-REF');
  assert.equal(ev.amazon_refund, 40);
});

// ---- a return label eBay charged on a dropship sale is booked as a cost on the payment for that day
await order('LABEL-1', '2027-05-06T19:00:00Z', 'Return Label Tent', 80, { fee: 10.88 });
await q("insert into order_overrides (order_id, cost_override) values ('LABEL-1', 50)");
await tx('T-LBL', 'LABEL-1', 'SHIPPING_LABEL', 9.61, 0, '2027-06-03T19:00:00Z');
await check('a $9.61 return label on a dropship sale is booked once, on the payment for when it was charged', async () => {
  const data = await buildDataset();
  assert.equal(data.find((o) => o.order_id === 'LABEL-1').net, 19.12, 'the May sale itself is unchanged');
  const ev = data.find((o) => o.refund_of === 'LABEL-1');
  assert.equal(ev.settle_month, '2027-06');
  assert.equal(ev.net, -9.61);
});

// ---- an Amazon-shipped sale is never written off; nor is a sale near an Amazon email that couldn't be read
await order('NEAR-FAIL', '2027-07-01T19:00:00Z', 'Unread Email Lantern', 25, { fee: 3.4 });
await q("update ebay_orders set created_at = '2026-01-01T19:00:00Z' where order_id = 'NEAR-FAIL'"); // long past the 10-day window
await q("insert into amazon_emails (message_id, received_at, subject, kind, ok, note) values ('bad-1', '2026-01-03T19:00:00Z', 'Ordered: 1 item', 'order', false, 'no total')");
await check('a sale with an unreadable Amazon email two days later waits for its cost instead of becoming "not dropship"', async () => {
  const o = (await buildDataset()).find((x) => x.order_id === 'NEAR-FAIL');
  assert.equal(o.status, 'awaiting_cost');
});

// ---- sheet pairing settles ties by the exact payout, and a second run changes nothing
fs.writeFileSync(path.join(dir, 'pair.csv'), 'Item Name,Amazon Cost (Myles COGS),eBay Sale Price (Drew),AD Fees,,Net Item Profit\nTwin Mug,$10.00,$17.06,,,$7.06\nTwin Mug,$10.00,$16.85,,,$6.85\n');
await order('MUG-A', '2026-11-05T19:00:00Z', 'Twin Mug', 20, { fee: 3.15 }); // payout 16.85
await order('MUG-B', '2026-11-06T19:00:00Z', 'Twin Mug', 20, { fee: 2.94 }); // payout 17.06
await importLedgerCsv(fs.readFileSync(path.join(dir, 'pair.csv')), 'infinity business - NOV 26.csv');
await check('two sheet rows for the same item pair with the sale whose payout they show', async () => {
  const rows = await q("select sale_price, ebay_order_id from ledger_entries where month = '2026-11' order by sale_price");
  assert.deepEqual(rows.map((r) => [Number(r.sale_price), r.ebay_order_id]), [[16.85, 'MUG-A'], [17.06, 'MUG-B']]);
  await matchLedger();
  const again = await q("select sale_price, ebay_order_id from ledger_entries where month = '2026-11' order by sale_price");
  assert.deepEqual(again, rows);
});

// ---- a refund dated inside a paid period that its payment missed (Mozi Wash): money on the next payment, but a
// correction for the paid period, not the next period's own activity
await order('MISSED-REF', '2027-04-05T19:00:00Z', 'Missed Refund Mug', 30, { fee: 4.08 });
await q("insert into order_overrides (order_id, cost_override) values ('MISSED-REF', 18)");
const apr = await pay('2027-04', null, '2027-04-26');
await tx('R-MISSED', 'MISSED-REF', 'REFUND', 25.92, 4.08, '2027-04-20T19:00:00Z'); // synced after April was paid
await order('MAY-SALE', '2027-05-10T19:00:00Z', 'May Sale Bowl', 50, { fee: 6.8 });
await q("insert into order_overrides (order_id, cost_override) values ('MAY-SALE', 30)");
await check('a refund dated in paid April lands on May as a correction for April; May shows its own profit apart', async () => {
  const { data, s } = await settle('2027-05');
  // the sale was on April, so the refund changes April's row: held as paid there, the difference on May
  const fix = data.find((o) => o.order_id === 'ADJ:MISSED-REF:2027-04');
  assert.ok(fix, 'adjustment line on May');
  assert.equal(fix.settle_month, '2027-05');
  assert.equal(fix.correction_for, '2027-04');
  assert.equal(data.find((o) => o.order_id === 'MAY-SALE').correction_for, undefined);
  assert.deepEqual(s.corrections.rows.map((x) => x.order_id), [fix.order_id], 'only the April correction is set apart');
  assert.equal(Math.round(s.own.businessProfit * 100), Math.round((s.businessProfit - fix.net) * 100), 'May on its own leaves the correction out');
  assert.equal(s.corrections.profit, fix.net);
  assert.equal(Math.round((s.own.sellerSends + s.corrections.sellerSends) * 100), Math.round(s.sellerSends * 100), 'own + corrections = the payment');
  const { s: a } = await settle('2027-04');
  assert.equal(a.sellerSends, apr.sellerSends, 'April stays as paid');
});

await closeDb();
fs.rmSync(dir, { recursive: true, force: true });
console.log(failed ? '\nCORE: FAILED' : '\nCORE: ALL CHECKS PASSED');
process.exitCode = failed ? 1 : 0;
