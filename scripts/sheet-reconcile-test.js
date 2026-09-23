// Proves that once real eBay orders exist alongside uploaded monthly sheets, every sheet month still
// settles exactly like the sheet (no double counting of sales or refunds), sheet rows pick up real
// eBay dates when matched, and months without a sheet are driven by eBay data. Throwaway database.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-reconcile-'));
process.env.LOCAL_PG_DIR = dir;
process.env.LOCAL_PG_PORT = '5448';
delete process.env.DATABASE_URL;
const { initDb, q, closeDb } = await import('../src/db.js');
const { normalizeOrder, upsertOrder } = await import('../src/ebay.js');
const { importLedgerCsv, matchLedger } = await import('../src/ledger.js');
const { buildDataset, buildBooks } = await import('../src/dataset.js');
const { settleMonth } = await import('../public/js/settlement.js');
await initDb();

const SHEETS = { JUL: ['2026-07', -27.56, 217.63], AUG: ['2026-08', 129.49, 1304.76], SEP: ['2026-09', 104.88, 625.65] };
const sheetDir = process.env.LEDGER_SHEETS_DIR || path.resolve('private');
let failed = false;
const check = (label, fn) => { try { fn(); console.log(`  PASS  ${label}`); } catch (e) { failed = true; console.log(`  FAIL  ${label}\n        ${e.message}`); } };

// Real eBay orders for items that are in the sheets (payout ~ 86% of price), plus one refunded sale
// and one October sale (no sheet) with a known Amazon cost override.
const ebay = [
  ['11-00001-00001', '2026-09-20T18:00:00Z', 'Kala Bamboo Soprano Ukulele Satin', 117.0, 0],
  ['11-00001-00002', '2026-09-19T18:00:00Z', 'HHLPRO UHF Wireless XLR Transmitter Receiver F20', 144.5, 0],
  ['11-00001-00003', '2026-08-12T18:00:00Z', 'Temptations Chicken Salmon Kitten Treats 48 Pouches', 45.2, 0],
  ['11-00001-00004', '2026-09-03T18:00:00Z', 'Areliaa Lipstick Color Changing Lip Balm', 19.6, 19.6], // refunded
  ['11-00001-00005', '2026-07-10T18:00:00Z', 'Something not in any sheet', 30.0, 0],
  ['11-00001-00006', '2026-10-02T18:00:00Z', 'October sale, no sheet yet', 50.0, 0],
  ['11-00001-00007', '2026-06-10T18:00:00Z', 'Old sale before the partnership', 25.0, 0],
  ['11-00001-00008', '2026-08-11T18:00:00Z', 'Replacement for Kubota 7J612-66323 K2581-66220 Hydraulic Filter', 27.99, 0],
  ['11-00001-00009', '2026-10-05T18:00:00Z', 'October sale refunded before we bought it', 40.0, 40.0],
  ['11-00001-00010', '2026-09-05T18:00:00Z', 'Vitaliq Korean Silk Peptide Serum Deep Collagen', 34.99, 30.2], // refunded
  ['11-00001-00011', '2026-09-17T18:00:00Z', 'Vitaliq Korean Silk Peptide Serum Deep Collagen', 34.99, 0],
  ['11-00001-00013', '2026-09-03T18:00:00Z', 'USR 92-95 Toyota Pickup Clear Corner Lights Pair', 71.95, 65.0], // refunded, not in the sheet
  ['11-00001-00012', '2026-09-08T18:00:00Z', 'Vitaliq Korean Silk Peptide Serum Deep Collagen 2 Pack', 69.98, 0],
];
for (const [id, at, title, price, refund] of ebay) {
  await upsertOrder(normalizeOrder({
    orderId: id, creationDate: at, orderFulfillmentStatus: 'FULFILLED', cancelStatus: { cancelState: 'NONE_REQUESTED' },
    pricingSummary: { priceSubtotal: { value: String(price) }, total: { value: String(price) } },
    totalMarketplaceFee: { value: String(Math.round(price * 0.136 * 100) / 100) },
    paymentSummary: { refunds: refund ? [{ refundStatus: 'REFUNDED', amount: { value: String(refund) } }] : [] },
    fulfillmentStartInstructions: [{ shippingStep: { shipTo: { fullName: 'Test Buyer', contactAddress: { city: 'Mesa', stateOrProvince: 'AZ' } } } }],
    lineItems: [{ lineItemId: `${id}-1`, title, quantity: 1, lineItemCost: { value: String(price) }, total: { value: String(price) } }],
  }));
}
await q("insert into order_overrides (order_id, cost_override) values ('11-00001-00006', 30)");

for (const m of Object.keys(SHEETS)) {
  const f = path.join(sheetDir, `sheet-${m}-26.csv`);
  if (!fs.existsSync(f)) { console.log(`missing ${f}; set LEDGER_SHEETS_DIR`); process.exit(1); }
  await importLedgerCsv(fs.readFileSync(f), `sheet ${m} 26.csv`);
}
const matched = await matchLedger();
const data = await buildDataset();
const { expenses, settlements } = await buildBooks();

console.log(`sheet rows matched to eBay orders: ${matched}`);
for (const [m, [month, profit, sends]] of Object.entries(SHEETS)) {
  const s = settleMonth({ month, orders: data, expenses, settlements, splitAmazon: 50 });
  check(`${m}: business profit ${s.businessProfit} = sheet ${profit}`, () => assert.equal(s.businessProfit, profit));
  check(`${m}: Drew sends Myles ${s.sellerSends} = sheet ${sends}`, () => assert.equal(s.sellerSends, sends));
}
const byId = (id) => data.find((o) => o.order_id === id);
check('eBay orders matched to a sheet row are shown but not counted again', () => {
  for (const id of ['11-00001-00001', '11-00001-00002', '11-00001-00003']) {
    assert.equal(byId(id).counted, false);
    assert.equal(byId(id).status, 'in_sheet');
  }
});
check('short sheet title "Replacement for Kubota" matches the long eBay title', () => assert.equal(byId('11-00001-00008').status, 'in_sheet'));
check('refund sheet row links to the refunded eBay sale', () => assert.equal(byId('11-00001-00004').status, 'in_sheet'));
check('a sale missing from the sheet stays visible as needing a cost (not hidden, not counted)', () => {
  assert.equal(byId('11-00001-00005').status, 'awaiting_cost');
  assert.equal(byId('11-00001-00005').counted, false);
});
check('same-item sales: refunded one goes to the refund row, the normal row gets the un-refunded sale', () => {
  assert.equal(byId('11-00001-00011').status, 'in_sheet');
  const refundRow = data.find((o) => o.source === 'ledger' && /Vitaliq/.test(o.title) && o.ledger.note && /REFUND/i.test(o.ledger.note));
  assert.equal(refundRow.ebay_order_id, '11-00001-00010');
});
check('refunded on eBay with no Amazon purchase: cost $0, only the $0.40 fee lost, counted', () => {
  const o = byId('11-00001-00009');
  assert.equal(o.counted, true);
  assert.equal(o.cost, 0);
  assert.equal(o.cost_source, 'refunded');
  assert.equal(o.net, -0.4);
});
check('refunded sale missing from a sheet month is not counted (sheet total unchanged)', () => {
  assert.equal(byId('11-00001-00013').counted, false);
  assert.equal(byId('11-00001-00013').status, 'returned');
});
check('sales before the partnership are set aside', () => {
  assert.equal(byId('11-00001-00007').status, 'before_start');
  assert.equal(byId('11-00001-00007').counted, false);
});
check('matched sheet rows take the real eBay sale date', () => {
  const uke = data.find((o) => o.source === 'ledger' && /Kala Bamboo/.test(o.title));
  assert.equal(uke.approx_date, false);
  assert.equal(uke.created_at.slice(0, 10), '2026-09-20');
  assert.equal(uke.ebay_order_id, '11-00001-00001');
});
check('October (no sheet) is driven by eBay: counted with its cost', () => {
  const o = byId('11-00001-00006');
  assert.equal(o.counted, true);
  assert.equal(o.cost, 30);
  const s = settleMonth({ month: '2026-10', orders: data, expenses, settlements, splitAmazon: 50 });
  assert.equal(s.orders, 2);
});
const totalProfit = Object.values(SHEETS).reduce((t, [month]) => t + settleMonth({ month, orders: data, expenses, settlements, splitAmazon: 50 }).businessProfit, 0);
check(`Jul–Sep business profit $${totalProfit.toFixed(2)} = sheets $206.81`, () => assert.equal(Math.round(totalProfit * 100), 20681));

await closeDb();
fs.rmSync(dir, { recursive: true, force: true });
console.log(failed ? '\nRECONCILE: FAILED' : '\nRECONCILE: ALL CHECKS PASSED');
process.exitCode = failed ? 1 : 0;
