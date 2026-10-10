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
// eBay's REFUND amount is what it took from the seller: the buyer's refund minus the fees it gave back
await tx('T2', 'C1-REF', 'REFUND', 86.8, 13.2, '2026-10-14T18:00:00Z');
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
await tx('T5', 'C3A-SEP', 'REFUND', 101.8, 15.2, '2026-10-05T18:00:00Z'); // sheet-covered Sep sale refunded in October
await order('H1-OCT', '2026-10-06T18:00:00Z', 'October thing', 50, { fee: 6.8 });
await q("insert into order_overrides (order_id, cost_override) values ('H1-OCT', 30)");
await tx('T6', 'H1-OCT', 'SALE', 43.2, 6.8, '2026-10-06T18:00:00Z');
await tx('T7', 'H1-OCT', 'REFUND', 43.6, 6.4, '2026-11-03T18:00:00Z');
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

// 26th-to-26th pay cycles: a Nov 20 sale (Nov 26 payment) refunded Nov 28 (Dec 26 payment), same calendar month
await order('CYC-NOV', '2026-11-20T18:00:00Z', 'Cycle Test Widget', 40);
await q("insert into order_overrides (order_id, cost_override) values ('CYC-NOV', 20)");
await tx('T8', 'CYC-NOV', 'REFUND', 34.56, 5.44, '2026-11-28T18:00:00Z');
await check('a refund after the 26th cutoff goes on the next payment; the paid one never changes', async () => {
  const { data, s } = await settle('2026-11');
  const sale = data.find((o) => o.order_id === 'CYC-NOV');
  assert.equal(sale.refunds, 0, 'the November payment keeps the full sale');
  assert.equal(s.orders >= 1 && data.filter((o) => o.counted && o.settle_month === '2026-11').some((o) => o.order_id === 'CYC-NOV'), true);
  const ev = data.find((o) => o.order_id === 'REFUND:CYC-NOV:2026-12');
  assert.ok(ev, 'a refund line in the December payment');
  assert.equal(ev.settle_month, '2026-12');
  assert.equal(ev.business_month, '2026-11', 'analytics show it in November, when it happened');
  assert.equal(ev.net, -34.56); // -$40 refund + $5.44 fee credit
});

// Amazon refunds for purchases the inbox never saw (e.g. the Govee Control Box, bought before the emails began)
await order('ORPH-1', '2026-11-03T18:00:00Z', 'Govee Control Box for Govee Permanent Outdoor Lights', 64.99);
await q("insert into order_overrides (order_id, cost_override) values ('ORPH-1', 42.89)");
await q("insert into amazon_refunds (message_id, amazon_order_id, amount, received_at, title) values ('m-orph-1', '114-9999999-0000001', 42.89, '2026-11-29T03:23:00Z', 'Govee Control Box for Govee')");
await order('ORPH-2', '2026-11-04T18:00:00Z', 'Blue Widget', 60);
await order('ORPH-3', '2026-11-05T18:00:00Z', 'Red Gadget', 60);
await q("insert into order_overrides (order_id, cost_override) values ('ORPH-2', 44.44), ('ORPH-3', 44.44)");
await q("insert into amazon_refunds (message_id, amazon_order_id, amount, received_at) values ('m-orph-2', '114-9999999-0000002', 44.44, '2026-11-20T18:00:00Z')");
await check('an Amazon refund for a purchase the inbox never saw is matched by exact cost + item name, on the next payment', async () => {
  const data = await buildDataset();
  const ev = data.find((o) => o.order_id === 'REFUND:ORPH-1:2026-12');
  assert.ok(ev, 'refund line on the Dec 26 payment (refund came Nov 28 Arizona time)');
  assert.equal(ev.amazon_refund, 42.89);
  assert.equal(data.find((o) => o.order_id === 'ORPH-1').amazon_refund, 0, 'the November sale itself is unchanged');
});
await check('a refund that fits two sales is listed for review, never guessed', async () => {
  const data = await buildDataset();
  const u = data.unmatchedRefunds.find((r) => r.amazon_order_id === '114-9999999-0000002');
  assert.ok(u, 'listed as unmatched');
  assert.deepEqual(u.candidates.sort(), ['ORPH-2', 'ORPH-3']);
  assert.ok(!data.some((o) => /^REFUND:ORPH-[23]:/.test(o.order_id)), 'not booked on either sale');
});

// An open return (eBay holding the money, no refund yet) is flagged but still counted where it was settled
await order('RET-OPEN', '2026-11-10T18:00:00Z', 'Open Return Widget', 142.41, { fee: 13.72 });
await q("insert into order_overrides (order_id, cost_override) values ('RET-OPEN', 107.89)");
await q(`insert into ebay_returns (return_id, order_id, item_id, state, status, reason, return_type, created_at, refund_amount, raw, synced_at)
         values ('R-OPEN-1', 'RET-OPEN', null, 'ITEM_SHIPPED', 'ITEM_SHIPPED', 'ORDERED_WRONG_ITEM', 'MONEY_BACK', '2026-11-18T18:00:00Z', 142.41, '{}', now())`);
await check('an open return is flagged "return open", still counted, with what a refund would take off', async () => {
  const o = (await buildDataset()).find((x) => x.order_id === 'RET-OPEN');
  assert.equal(o.status, 'return_open');
  assert.equal(o.counted, true);
  assert.equal(o.net, 20.8);
  assert.equal(o.return_open.amount, 142.41);
  assert.equal(o.return_open.profit_hit, 129.09); // $142.41 refund minus the $13.32 fee eBay gives back
});
await tx('T9', 'RET-OPEN', 'REFUND', 129.09, 13.32, '2026-11-30T18:00:00Z');
await check('once the refund posts it is an ordinary refund on the payment for that day, and the flag goes away', async () => {
  const data = await buildDataset();
  const o = data.find((x) => x.order_id === 'RET-OPEN');
  assert.equal(o.return_open, null);
  assert.equal(o.status, 'returned');
  const ev = data.find((x) => x.order_id === 'REFUND:RET-OPEN:2026-12');
  assert.ok(ev, 'refund line on the December payment');
  assert.equal(ev.net, -129.09);
});

// eBay's own records, copied: the Govee Control Box (all fees returned) and the Leg Straps (eBay kept $0.40)
await order('REAL-GOVEE', '2026-11-02T18:00:00Z', 'Govee Control Box Real', 64.99, { fee: 9.25 });
await q("insert into order_overrides (order_id, cost_override) values ('REAL-GOVEE', 42.89)");
await tx('T10', 'REAL-GOVEE', 'REFUND', 55.74, 9.25, '2026-12-04T18:00:00Z');
await order('REAL-STRAPS', '2026-11-09T18:00:00Z', 'Leg Straps Real', 26.59, { fee: 3.99 });
await q("insert into order_overrides (order_id, cost_override) values ('REAL-STRAPS', 0)");
await tx('T11', 'REAL-STRAPS', 'REFUND', 23.0, 3.59, '2026-11-10T18:00:00Z');
await check('a later refund takes exactly what eBay took back (Govee: -$55.74, the whole payout)', async () => {
  const ev = (await buildDataset()).find((o) => o.order_id === 'REFUND:REAL-GOVEE:2026-12');
  assert.equal(ev.net, -55.74);
  assert.equal(ev.refunds, 64.99, 'the buyer got the whole $64.99 back');
});
await check('a same-period refund nets to what eBay kept (Leg Straps: -$0.40)', async () => {
  const o = (await buildDataset()).find((x) => x.order_id === 'REAL-STRAPS');
  assert.equal(o.net, -0.4); // $22.60 paid out, $23.00 taken back
});

// The Govee case: Amazon's refund lands on a payment Drew already made, the buyer's refund on the next one. Both go
// on the next unpaid payment as one line (= the sale's profit coming back), and the paid payment never changes.
await order('PAID-SKIP', '2027-02-05T19:00:00Z', 'Paid Skip Control Box', 64.99, { fee: 9.25 });
await q("insert into order_overrides (order_id, cost_override) values ('PAID-SKIP', 42.89)");
await q("insert into amazon_refunds (message_id, amazon_order_id, amount, received_at, title) values ('m-skip', '114-8888888-0000001', 42.89, '2027-03-10T03:00:00Z', 'Paid Skip Control Box')");
// March was paid (and closed: what it covered is recorded, as the payments endpoint does) before the refunds came in
await q("insert into settlements (month, paid) values ('2027-03', 500)");
await q("insert into settlement_freeze (month, row_keys, source) values ('2027-03', '[]', 'test')");
await tx('T12', 'PAID-SKIP', 'REFUND', 55.74, 9.25, '2027-04-02T19:00:00Z');
await check('a refund for a payment already made goes on the next unpaid one, merged with the rest of that sale\'s refunds', async () => {
  const data = await buildDataset();
  assert.ok(!data.some((o) => o.refund_of === 'PAID-SKIP' && o.settle_month === '2027-03'), 'nothing added to the paid March payment');
  const ev = data.filter((o) => o.refund_of === 'PAID-SKIP');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].settle_month, '2027-04');
  assert.equal(ev[0].net, -12.85); // +$42.89 back from Amazon, -$55.74 to the buyer = the sale's $12.85 profit reversed
});

// Drew paid May early (May 20); a May 24 refund of a May sale must not change what he already paid
await order('EARLY-PAY', '2027-05-03T19:00:00Z', 'Early Pay Gadget', 40, { fee: 5.44 });
await q("insert into order_overrides (order_id, cost_override) values ('EARLY-PAY', 20)");
await q("insert into settlements (month, paid, paid_at) values ('2027-05', 300, '2027-05-20')");
await tx('T13', 'EARLY-PAY', 'REFUND', 34.56, 5.44, '2027-05-24T19:00:00Z');
await check('a refund after a payment was made (even inside its own period) goes on the next payment', async () => {
  const data = await buildDataset();
  assert.equal(data.find((o) => o.order_id === 'EARLY-PAY').refunds, 0, 'the paid May sale is unchanged');
  const ev = data.find((o) => o.refund_of === 'EARLY-PAY');
  assert.equal(ev?.settle_month, '2027-06');
  assert.equal(ev.net, -34.56);
});

// SEALIGHT (Oct 2026): the first Amazon order is cancelled, a replacement is placed the next day. The cancelled
// order must not make the one-unit sale look "full" so the replacement never links.
await order('SEAL-1', '2027-07-06T00:39:00Z', 'SEALIGHT H10 9145 LED Fog Light Bulbs', 19, { fee: 3.01, name: 'Dominick DeRosa', city: 'Eatonton', st: 'GA' });
await ingestMessage({ messageId: 'seal-a@test', subject: 'Ordered: 1 Automotive item', date: '2027-07-06T01:00:00Z',
  text: 'Thanks for your order!\nDominick - EATONTON, GA\nOrder # 111-7777777-0000001\nGrand Total: $10.79\n' });
await runMatcher();
await ingestMessage({ messageId: 'seal-a-cxl@test', subject: 'Item cancelled successfully: "SEALIGHT H10..."', date: '2027-07-06T02:00:00Z',
  text: 'We have cancelled the item you asked us to.\nOrder # 111-7777777-0000001\n' });
await ingestMessage({ messageId: 'seal-b@test', subject: 'Ordered: 1 Automotive item', date: '2027-07-07T01:00:00Z',
  text: 'Thanks for your order!\nDominick - EATONTON, GA\nOrder # 112-7777777-0000002\nGrand Total: $10.79\n' });
await runMatcher();
await check('a replacement Amazon order links after the first one was cancelled (SEALIGHT)', async () => {
  const links = (await q("select amazon_order_id from order_links where ebay_order_id = 'SEAL-1'")).map((r) => r.amazon_order_id).sort();
  assert.deepEqual(links, ['111-7777777-0000001', '112-7777777-0000002']);
  const o = (await buildDataset()).find((x) => x.order_id === 'SEAL-1');
  assert.equal(o.cost, 10.79);
  assert.equal(o.counted, true);
});

// HHLPRO (Oct 2026): sheet-covered Sep sale. eBay refunds the buyer ($128.69 back, all fees returned) and the $4.27
// ad fee; Amazon refunds Myles $104.79 of the $107.89 (email names the item). One line on the next payment.
await order('HHL-1', '2027-08-03T19:00:00Z', 'HHLPRO UHF Wireless XLR Transmitter Receiver F20', 142.41, { fee: 13.72 });
await q("insert into order_overrides (order_id, cost_override) values ('HHL-1', 107.89)");
await q("insert into ebay_transactions (transaction_id, order_id, type, fee_type, booking_entry, amount, fee_amount, transaction_at) values ('HHL-AD', 'HHL-1', 'NON_SALE_CHARGE', 'AD_FEE', 'DEBIT', 4.27, 0, '2027-08-03T19:05:00Z'), ('HHL-AD-BACK', 'HHL-1', 'NON_SALE_CHARGE', 'AD_FEE', 'CREDIT', 4.27, 0, '2027-09-07T19:00:00Z')");
await q("update ebay_orders set ad_fees = 0 where order_id = 'HHL-1'"); // what applyFinanceTotals stores: charges minus credits
await tx('T14', 'HHL-1', 'REFUND', 128.69, 13.72, '2027-09-07T19:00:00Z');
await q("insert into amazon_refunds (message_id, amazon_order_id, amount, received_at, title) values ('m-hhl', '114-6666666-0000001', 104.79, '2027-09-09T17:52:00Z', 'HHLPRO UHF Wireless XLR')");
await check('HHLPRO: the sale keeps its ad fee; the refund line has the buyer refund, the ad fee back and Amazon\'s partial refund', async () => {
  const data = await buildDataset();
  const sale = data.find((x) => x.order_id === 'HHL-1');
  assert.equal(sale.ad_fees, 4.27, 'the August sale still shows the ad fee it paid');
  assert.equal(sale.net, 16.53);
  const ev = data.find((x) => x.refund_of === 'HHL-1');
  assert.equal(ev.settle_month, '2027-09');
  assert.equal(ev.amazon_refund, 104.79, 'matched by the item name even though it is less than the cost');
  assert.equal(ev.net, -19.63); // -128.69 to the buyer + 4.27 ad fee back + 104.79 from Amazon
});

// P0 from the audit: paying a period must NOT push that period's own refund lines onto the next one (October would
// have shown $163.92 still owed the moment Drew paid it). A refund that arrives after the payment does move on.
await order('CLOSE-SALE', '2027-09-02T19:00:00Z', 'Close Test Item', 50, { fee: 6.8 });
await q("insert into order_overrides (order_id, cost_override) values ('CLOSE-SALE', 25)");
await order('CLOSE-OLD', '2027-08-02T19:00:00Z', 'Close Old Item', 30, { fee: 4.08 });
await q("insert into order_overrides (order_id, cost_override) values ('CLOSE-OLD', 15)");
await tx('T15', 'CLOSE-OLD', 'REFUND', 25.92, 4.08, '2027-09-10T19:00:00Z'); // an August sale refunded during September
const { closePeriodForTest } = await import('../src/dataset.js').then((m) => ({ closePeriodForTest: async (month, paidAt, amount) => {
  const data = await m.buildDataset();
  const keys = data.filter((o) => o.counted && o.settle_month === month).map((o) => o.order_id);
  await q('insert into settlement_payments (month, amount, paid_at) values ($1, $2, $3)', [month, amount, paidAt]);
  await q('insert into settlements (month, paid, paid_at) values ($1, $2, $3) on conflict (month) do update set paid = excluded.paid, paid_at = excluded.paid_at', [month, amount, paidAt]);
  await q("insert into settlement_freeze (month, row_keys, source) values ($1, $2::jsonb, 'test')", [month, JSON.stringify(keys)]);
} }));
await check('paying a period keeps its own refund lines on it (they never jump to the next payment)', async () => {
  const before = await settle('2027-09');
  assert.ok(before.data.some((o) => o.refund_of === 'CLOSE-OLD' && o.settle_month === '2027-09'), 'the refund line is on September before paying');
  await closePeriodForTest('2027-09', '2027-09-26', before.s.sellerSends);
  const after = await settle('2027-09');
  assert.equal(after.s.sellerSends, before.s.sellerSends, 'September unchanged by being paid');
  assert.equal(after.s.balance, 0);
  assert.ok(after.data.some((o) => o.refund_of === 'CLOSE-OLD' && o.settle_month === '2027-09'), 'still on September');
  assert.ok(!after.data.some((o) => o.settle_month === '2027-10' && /CLOSE-/.test(o.order_id + (o.refund_of || ''))), 'nothing moved to October');
});
await tx('T16', 'CLOSE-SALE', 'REFUND', 43.2, 6.8, '2027-09-28T19:00:00Z'); // refund after September was paid
await check('a refund that arrives after a period was paid goes on the next payment; the paid one stays put', async () => {
  const { data, s } = await settle('2027-09');
  assert.equal(s.balance, 0, 'September still settled');
  const ev = data.find((o) => o.refund_of === 'CLOSE-SALE');
  assert.equal(ev.settle_month, '2027-10');
  assert.equal(ev.net, -43.2);
});
// A sale only costed after its period was paid (e.g. Vtopmart) lands on the next payment, not the paid one
await order('LATE-COST', '2027-09-05T19:00:00Z', 'Late Cost Vtopmart Organizer', 34.99, { fee: 5.19 });
await check('a sale costed after its period was paid goes on the next payment', async () => {
  await q("insert into order_overrides (order_id, cost_override) values ('LATE-COST', 20)");
  const { data, s } = await settle('2027-09');
  assert.equal(s.balance, 0, 'September still settled');
  assert.equal(data.find((o) => o.order_id === 'LATE-COST').settle_month, '2027-10');
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
