import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promoMonth, promoMonths } from '../public/js/promo-months.js';

// Two of August's real promoted sales (sheet rows: revenue is the payout), one ordinary sale, one sale still
// waiting for its Amazon cost (never counted), and a July sale
const orders = [
  { title: 'Beach Chair', business_month: '2026-08', counted: true, revenue: 53.32, fees: 0, refunds: 0, cost: 44.15, ad_fees: 2.03, net: 7.14, created_at: '2026-08-05T19:00:00Z' },
  { title: 'Reel Holder', business_month: '2026-08', counted: true, revenue: 22.5, fees: 0, refunds: 0, cost: 14.21, ad_fees: 0.87, net: 7.42, created_at: '2026-08-02T19:00:00Z' },
  { title: 'Lamp', business_month: '2026-08', counted: true, revenue: 30, fees: 0, refunds: 0, cost: 20, ad_fees: 0, net: 10, created_at: '2026-08-10T19:00:00Z' },
  { title: 'Waiting', business_month: '2026-08', counted: false, revenue: 40, fees: 5, refunds: 0, cost: 0, ad_fees: 1, net: 0, created_at: '2026-08-20T19:00:00Z' },
  { title: 'July thing', business_month: '2026-07', counted: true, revenue: 25, fees: 3, refunds: 0, cost: 15, ad_fees: 0, net: 7, created_at: '2026-07-20T19:00:00Z' },
];

test('promoted sales are the counted sales eBay charged an ad fee on', () => {
  const m = promoMonth(orders, '2026-08');
  assert.equal(m.sales, 3);
  assert.equal(m.adSales, 2);
  assert.equal(m.otherSales, 1);
  assert.equal(m.adFees, 2.9);
  assert.equal(m.adProfit, 14.56);
  assert.equal(m.otherProfit, 10);
  assert.equal(m.profit, 24.56);
  assert.equal(m.payout, 105.82);
  assert.equal(m.adPayout, 75.82);
  assert.equal(m.adProfitPerSale, 7.28);
});

test('break-even: how many ad sales had to be because of the ad for the fees to pay off', () => {
  // profit before fees averages (14.56 + 2.90) / 2 = 8.73 a sale, and one of those covers the 2.90 in fees
  const m = promoMonth(orders, '2026-08');
  assert.equal(m.breakEven, 1);
  assert.equal(m.worst, -2.9); // nobody needed the ad
  assert.equal(m.best, 14.56); // everybody came through the ad
});

test('the ad sales list is in date order', () => {
  assert.deepEqual(promoMonth(orders, '2026-08').list.map((x) => x.title), ['Reel Holder', 'Beach Chair']);
});

test('a month without promoted sales: nothing gained, nothing spent', () => {
  const m = promoMonth(orders, '2026-07');
  assert.equal(m.adSales, 0);
  assert.equal(m.adFees, 0);
  assert.equal(m.breakEven, 0);
  assert.equal(m.worst, 0);
  assert.equal(m.best, 0);
  assert.equal(m.share, 0);
});

test('every month with counted sales, oldest first', () => {
  assert.deepEqual(promoMonths(orders).map((m) => m.month), ['2026-07', '2026-08']);
});

test('real August: 7 promoted sales, $9.74 fees, $67.51 profit after fees; pays off if 1 of 7 was because of the ad', () => {
  const rows = [
    [53.32, 44.15, 2.03, 7.14], [22.5, 14.21, 0.87, 7.42], [17.54, 10.97, 0.66, 5.91], [16.79, 8.85, 0.66, 7.28],
    [62.71, 50.95, 2.33, 9.43], [48.81, 38.69, 1.84, 8.28], [38.88, 15.48, 1.35, 22.05],
  ].map(([revenue, cost, ad, net], i) => ({ title: `S${i}`, business_month: '2026-08', counted: true, revenue, fees: 0, refunds: 0, cost, ad_fees: ad, net, created_at: `2026-08-${10 + i}T19:00:00Z` }));
  const m = promoMonth(rows, '2026-08');
  assert.equal(m.adSales, 7);
  assert.equal(m.adFees, 9.74);
  assert.equal(m.adProfit, 67.51);
  assert.equal(m.breakEven, 1);
  assert.equal(m.worst, -9.74);
});
