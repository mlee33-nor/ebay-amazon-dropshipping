// Regression tests for the accounting audit's confirmed bugs. Each scenario reproduces the audit's case and
// asserts the corrected result. Throwaway database; never touches real data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-audit-'));
process.env.LOCAL_PG_DIR = dir;
process.env.LOCAL_PG_PORT = '5449';
delete process.env.DATABASE_URL;
const { initDb, q, closeDb } = await import('../src/db.js');
const { normalizeOrder, upsertOrder, applyFinanceTotals } = await import('../src/ebay.js');
const { importLedgerCsv, matchLedger, parseLedgerCsv } = await import('../src/ledger.js');
const { ingestMessage } = await import('../src/email.js');
const { runMatcher } = await import('../src/matcher.js');
const { buildDataset, buildBooks } = await import('../src/dataset.js');
const { settleMonth } = await import('../public/js/settlement.js');
await initDb();

let failed = false;
const check = async (label, fn) => { try { await fn(); console.log(`  PASS  ${label}`); } catch (e) { failed = true; console.log(`  FAIL  ${label}\n        ${e.message}`); } };
const order = (id, at, title, price, { fee = +(price * 0.136).toFixed(2), city = 'Mesa', st = 'AZ', name = 'Test Buyer', refund = 0 } = {}) =>
  upsertOrder(normalizeOrder({
    orderId: id, creationDate: at, orderFulfillmentStatus: 'FULFILLED', cancelStatus: { cancelState: 'NONE_REQUESTED' },
    pricingSummary: { priceSubtotal: { value: String(price) }, total: { value: String(price) } },
    totalMarketplaceFee: { value: String(fee) },
    paymentSummary: { refunds: refund ? [{ refundStatus: 'REFUNDED', amount: { value: String(refund) } }] : [] },
    fulfillmentStartInstructions: [{ shippingStep: { shipTo: { fullName: name, contactAddress: { city, stateOrProvince: st } } } }],
    lineItems: [{ lineItemId: `${id}-1`, title, quantity: 1, lineItemCost: { value: String(price) }, total: { value: String(price) } }],
  }));
const tx = (id, orderId, type, amount, fee, at, extra = {}) => q(
  `insert into ebay_transactions (transaction_id, order_id, type, fee_type, booking_entry, amount, fee_amount, transaction_at)
   values ($1,$2,$3,$4,$5,$6,$7,$8)`, [id, orderId, type, extra.feeType || null, extra.booking || null, amount, fee, at]);
const settle = async (month) => {
  const data = await buildDataset();
  const { expenses, settlements } = await buildBooks();
  return { data, s: settleMonth({ month, orders: data, expenses, settlements, splitAmazon: 50 }) };
};

// ---- sheets present for Jul–Sep (real files), plus eBay orders around them
const sheetDir = process.env.LEDGER_SHEETS_DIR || path.resolve('private');
for (const m of ['JUL', 'AUG', 'SEP']) await importLedgerCsv(fs.readFileSync(path.join(sheetDir, `sheet-${m}-26.csv`)), `sheet ${m} 26.csv`);

await check('H2: a sheet without the month in its file name is rejected and changes nothing', async () => {
  const before = (await q("select count(*)::int n from ledger_entries where month = '2026-07'"))[0].n;
  assert.throws(() => parseLedgerCsv(fs.readFileSync(path.join(sheetDir, 'sheet-SEP-26.csv')), 'settlement.csv'), /month/i);
  await assert.rejects(importLedgerCsv(fs.readFileSync(path.join(sheetDir, 'sheet-SEP-26.csv')), 'Partnership Settlement - Sheet1.csv'));
  assert.equal((await q("select count(*)::int n from ledger_entries where month = '2026-07'"))[0].n, before);
});

// C3a: Kala sheet row (Sep, payout $100.78) must pair with the Sep 20 sale, not the Oct 2 one
await order('C3A-SEP', '2026-09-20T18:00:00Z', 'Kala Bamboo Soprano Ukulele Satin', 117.0);
await order('C3A-OCT', '2026-10-02T18:00:00Z', 'Kala Bamboo Soprano Ukulele Satin', 115.84);
await q("insert into order_overrides (order_id, cost_override) values ('C3A-OCT', 85.78)");
// C3b: reworded title in September with an Amazon cost must not be counted on top of the sheet row
await order('C3B-SEP', '2026-09-12T18:00:00Z', 'Precut Tennis Balls for Walker Glides 4pk', 19.99);
await q("insert into order_overrides (order_id, cost_override) values ('C3B-SEP', 9.99)");
await matchLedger();

await check('C3a: sheet row pairs with the same-month sale; the October sale is counted in October', async () => {
  const { data } = await settle('2026-10');
  const kala = data.find((o) => o.source === 'ledger' && /Kala/.test(o.title));
  assert.equal(kala.ebay_order_id, 'C3A-SEP');
  const oct = data.find((o) => o.order_id === 'C3A-OCT');
  assert.equal(oct.counted, true);
  assert.equal(oct.business_month, '2026-10');
});
await check('C3b: reworded sheet sale is flagged "check_sheet", September still equals the sheet', async () => {
  const { data, s } = await settle('2026-09');
  assert.equal(data.find((o) => o.order_id === 'C3B-SEP').status, 'check_sheet');
  assert.equal(s.businessProfit, 104.88);
  assert.equal(s.sellerSends, 625.65);
});

// Late-July sale logged on the August sheet still pairs (no same-month candidate)
await order('EDGE-JUL31', '2026-07-31T18:00:00Z', 'Temptations Chicken Salmon Kitten Treats 48 Pouches', 44.99);
await matchLedger();
await check('a Jul 31 sale recorded on the August sheet pairs with that August row', async () => {
  const data = await buildDataset();
  assert.equal(data.find((o) => o.order_id === 'EDGE-JUL31').status, 'in_sheet');
  const { s } = await settle('2026-08');
  assert.equal(s.businessProfit, 129.49);
});

// A brand-new sale with no Amazon purchase yet waits for its cost, even in a month that has a sheet
await order('NEW-TODAY', new Date(Date.now() - 3600_000).toISOString(), '8 Packs 16 Grit Blue Zirconia Cloth Flap Discs', 90.24);
await check('a sale from an hour ago with no Amazon order yet is "awaiting cost", never hidden as not-dropship', async () => {
  const data = await buildDataset();
  const o = data.find((x) => x.order_id === 'NEW-TODAY');
  assert.equal(o.status, 'awaiting_cost');
  assert.equal(o.counted, false);
});

// Cancelled on eBay, and Amazon's "Item cancelled successfully" email for the one-item purchase: not a loss
await upsertOrder(normalizeOrder({
  orderId: 'CXL-1', creationDate: '2026-10-20T12:43:00Z', orderFulfillmentStatus: 'NOT_STARTED', cancelStatus: { cancelState: 'CANCELED' },
  pricingSummary: { priceSubtotal: { value: '90.24' }, total: { value: '90.24' } }, totalMarketplaceFee: { value: '12.81' },
  fulfillmentStartInstructions: [{ shippingStep: { shipTo: { fullName: 'Bart Clark', contactAddress: { city: 'Grandview', stateOrProvince: 'TX' } } } }],
  lineItems: [{ lineItemId: 'CXL-1-1', title: '8 Packs 16 Grit Blue Zirconia Cloth Flap Discs', quantity: 1, lineItemCost: { value: '90.24' }, total: { value: '90.24' } }],
}));
await ingestMessage({ messageId: 'cxl-order@test', subject: 'Ordered: 1 Automotive item', date: '2026-10-20T18:49:00Z',
  text: 'Thanks for your order!\nBart - GRANDVIEW, TX\nOrder # 111-3484881-0000001\nGrand Total: $64.94\n' });
await q("insert into order_links (amazon_order_id, ebay_order_id, method) values ('111-3484881-0000001', 'CXL-1', 'auto')");
await check('before the cancellation email: a cancelled sale with an Amazon purchase is a loss', async () => {
  const o = (await buildDataset()).find((x) => x.order_id === 'CXL-1');
  assert.equal(o.status, 'cancelled_after_purchase');
  assert.equal(o.net, -64.94);
});
await ingestMessage({ messageId: 'cxl-cancel@test', subject: 'Item cancelled successfully: "8 Packs 8 x 19 inch 16 Grit..."', date: '2026-10-20T19:37:00Z',
  text: 'We have cancelled the item you asked us to.\nOrder # 111-3484881-0000001\n' });
await check('"Item cancelled successfully" on a one-item order cancels the purchase: no cost, no loss, not counted', async () => {
  const o = (await buildDataset()).find((x) => x.order_id === 'CXL-1');
  assert.equal(o.cost, 0);
  assert.equal(o.counted, false);
  assert.equal(o.status, 'cancelled');
});
await ingestMessage({ messageId: 'cxl-refund@test', subject: 'Your refund for 8 Packs 8 x 19 inch 16 Grit', date: '2026-10-21T10:00:00Z',
  text: 'Refund issued\nOrder # 111-3484881-0000001\nRefund total: $64.94\n' });
await check('a refund email for the cancelled purchase is the same money: no phantom profit', async () => {
  const o = (await buildDataset()).find((x) => x.order_id === 'CXL-1');
  assert.equal(o.amazon_refund, 0);
  assert.equal(o.counted, false);
  const { s } = await settle('2026-10');
  assert.ok(!s.orders || s.businessProfit < 1000, 'October unaffected');
});
// A two-item order where one item is cancelled stays for review (can't tell which item's cost to drop)
await ingestMessage({ messageId: 'two-order@test', subject: 'Ordered: 2 Home items', date: '2026-10-22T18:00:00Z',
  text: 'Thanks for your order!\nPat - MESA, AZ\nOrder # 111-0000000-0000002\nGrand Total: $40.00\n' });
await ingestMessage({ messageId: 'two-cancel@test', subject: 'Item cancelled successfully: "Lamp..."', date: '2026-10-22T19:00:00Z',
  text: 'We have cancelled the item.\nOrder # 111-0000000-0000002\n' });
await check('an item cancelled from a 2-item order is left for review, not cancelled wholesale', async () => {
  const lines = await q("select order_status from amazon_lines where amazon_order_id = '111-0000000-0000002'");
  assert.ok(lines.every((l) => l.order_status === 'Ordered'));
});

// C2: business month is decided in Arizona time on the server
await order('C2-EDGE', '2026-11-01T05:30:00Z', 'Edge of month widget', 40);
await check('C2: a sale at 10:30pm Oct 31 Arizona time belongs to October for every viewer', async () => {
  const data = await buildDataset();
  assert.equal(data.find((o) => o.order_id === 'C2-EDGE').business_month, '2026-10');
});

// C1 + H4: fee credit on refund, ad fee net of credits, all from stored Finances records
await order('C1-REF', '2026-10-10T18:00:00Z', 'Full refund gadget', 100, { fee: 13.6 });
await q("insert into order_overrides (order_id, cost_override, amazon_refund) values ('C1-REF', 70, 70)");
await tx('T1', 'C1-REF', 'SALE', 86.4, 13.6, '2026-10-10T18:00:00Z');
await tx('T2', 'C1-REF', 'REFUND', 100, 13.2, '2026-10-14T18:00:00Z');
await tx('T3', 'C1-REF', 'NON_SALE_CHARGE', 5, 0, '2026-10-11T18:00:00Z', { feeType: 'AD_FEE', booking: 'DEBIT' });
await tx('T4', 'C1-REF', 'NON_SALE_CHARGE', 2, 0, '2026-10-20T18:00:00Z', { feeType: 'AD_FEE', booking: 'CREDIT' });
await applyFinanceTotals(['C1-REF']);
await check('C1: full refund gets eBay\'s fee credit back (net = -$0.40 - net ad fees), not -$13.60', async () => {
  const data = await buildDataset();
  const o = data.find((x) => x.order_id === 'C1-REF');
  // 100 - (13.60 - 13.20) - 3 ad - 70 cost - 100 refund + 70 amazon refund = -3.40
  assert.equal(o.fees, 0.4);
  assert.equal(o.ad_fees, 3);
  assert.equal(o.net, -3.4);
});
await check('H4: ad fee = all charges minus all credits across syncs ($5 - $2 = $3)', async () => {
  const r = (await q("select ad_fees from ebay_orders where order_id = 'C1-REF'"))[0];
  assert.equal(Number(r.ad_fees), 3);
});

// H1: refunds land in the month they happen
await tx('T5', 'C3A-SEP', 'REFUND', 117, 15.2, '2026-10-05T18:00:00Z'); // sheet-covered Sep sale refunded in October
await order('H1-OCT', '2026-10-06T18:00:00Z', 'October thing', 50, { fee: 6.8 });
await q("insert into order_overrides (order_id, cost_override) values ('H1-OCT', 30)");
await tx('T6', 'H1-OCT', 'SALE', 43.2, 6.8, '2026-10-06T18:00:00Z');
await tx('T7', 'H1-OCT', 'REFUND', 50, 6.4, '2026-11-03T18:00:00Z');
await check('H1: an October refund of a September sheet sale is booked in October (September unchanged)', async () => {
  const { data, s } = await settle('2026-09');
  assert.equal(s.businessProfit, 104.88);
  const ev = data.find((o) => o.order_id === 'REFUND:C3A-SEP:2026-10');
  assert.ok(ev, 'refund event exists');
  assert.equal(ev.net, -101.8); // -117 refund + 15.20 fee credit
});
await check('H1: a November refund of an October sale leaves October as it was and is booked in November', async () => {
  const data = await buildDataset();
  const o = data.find((x) => x.order_id === 'H1-OCT');
  assert.equal(o.refunds, 0);
  assert.equal(o.net, 13.2);
  const ev = data.find((x) => x.order_id === 'REFUND:H1-OCT:2026-11');
  assert.equal(ev.business_month, '2026-11');
  assert.equal(ev.net, -43.6); // -50 + 6.40 credit
});

// Gift card: Amazon email with $0.00 Grand Total links but leaves the cost unknown (never $0)
await order('GC-1', '2026-10-15T19:14:00Z', 'Light Bulb Security Camera', 27.99, { name: 'Ezra Solomon', city: 'Atlanta', st: 'GA' });
await ingestMessage({ messageId: 'gc@test', subject: 'Ordered: 1 Camera item', date: '2026-10-15T22:00:00Z',
  text: 'Thanks for your order!\nEzra - ATLANTA, GA\nOrder # 111-6656473-0336252\nGrand Total: $0.00\n' });
await q("insert into order_links (amazon_order_id, ebay_order_id, method) values ('111-6656473-0336252', 'GC-1', 'manual')");
await check('Gift card: $0.00 Grand Total never becomes a $0 cost; the sale waits for the cost', async () => {
  const data = await buildDataset();
  const o = data.find((x) => x.order_id === 'GC-1');
  assert.equal(o.amazon_cost_unknown, true);
  assert.equal(o.has_cost, false);
  assert.equal(o.counted, false);
  assert.equal(o.status, 'awaiting_cost');
});

await check('Sheet months still equal the sheets after all of the above', async () => {
  for (const [m, p, sends] of [['2026-07', -27.56, 217.63], ['2026-08', 129.49, 1304.76], ['2026-09', 104.88, 625.65]]) {
    const { s } = await settle(m);
    assert.equal(s.businessProfit, p, `${m} profit`);
    assert.equal(s.sellerSends, sends, `${m} sends`);
  }
});

await closeDb();
fs.rmSync(dir, { recursive: true, force: true });
console.log(failed ? '\nAUDIT REGRESSION: FAILED' : '\nAUDIT REGRESSION: ALL CHECKS PASSED');
process.exitCode = failed ? 1 : 0;
