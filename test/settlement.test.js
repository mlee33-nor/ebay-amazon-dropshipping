// The three real monthly sheets must reproduce the sheet's "Drew sends Myles" line exactly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseLedgerCsv } from '../src/ledger.js';
import { settleMonth } from '../public/js/settlement.js';

const SHEETS = [
  ['JUL', -27.56, -13.78, 217.63],
  ['AUG', 129.49, 64.75, 1304.76],
  ['SEP', 104.88, 52.44, 625.65],
];
// Real monthly sheets live in ./private (gitignored) or LEDGER_SHEETS_DIR; the test skips when they're absent
const dir = process.env.LEDGER_SHEETS_DIR || fileURLToPath(new URL('../private', import.meta.url));
const file = (m) => `${dir}/sheet-${m}-26.csv`;

for (const [m, profit, share, sends] of SHEETS) {
  test(`${m} 2026 settlement matches the sheet`, { skip: !fs.existsSync(file(m)) && 'sheet not present' }, () => {
    const p = parseLedgerCsv(fs.readFileSync(file(m)), `${m} 26.csv`);
    // Ledger rows as the dataset presents them: revenue = eBay payout, refund rows carry the refund fee
    const orders = p.entries.map((e, i) => ({
      counted: true, created_at: `${p.month}-${String(Math.min(28, i + 1)).padStart(2, '0')}T12:00:00`,
      revenue: e.is_refund ? 0 : e.sale_price, fees: 0, refunds: e.is_refund ? -e.sale_price : 0,
      cost: e.amazon_cost, amazon_refund: 0, ad_fees: e.ad_fees, extra_cost: 0,
    }));
    const expenses = p.expenses.map((x) => ({ ...x, month: p.month, paid_by: 'seller' }));
    const s = settleMonth({ month: p.month, orders, expenses, splitAmazon: 50 });
    assert.equal(s.businessProfit, profit);
    assert.equal(s.shareAmazon, share);
    assert.equal(s.sellerSends, sends);
  });
}

test('expenses paid by the Amazon partner are reimbursed on top', () => {
  const s = settleMonth({
    month: '2026-10', splitAmazon: 50,
    orders: [{ counted: true, created_at: '2026-10-05T12:00:00', revenue: 100, fees: 13, refunds: 0, cost: 60, amazon_refund: 0, ad_fees: 2, extra_cost: 0 }],
    expenses: [{ month: '2026-10', amount: 10, paid_by: 'amazon' }, { month: '2026-10', amount: 5, paid_by: 'seller' }],
  });
  // collected 87, profit 87-60-2-15 = 10, share 5 -> sends 60 + 10 + 5
  assert.equal(s.businessProfit, 10);
  assert.equal(s.sellerSends, 75);
});
