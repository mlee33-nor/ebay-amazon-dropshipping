// 26th-to-26th settlement periods from Sep 2026; calendar months before (as already paid)
import test from 'node:test';
import assert from 'node:assert/strict';
import { settlePeriodOf, settlePeriodRange, settleMonth } from '../public/js/settlement.js';

test('a sale settles in the payment due on or after its day', () => {
  assert.equal(settlePeriodOf('2026-08-28'), '2026-08'); // before the switch: calendar month (Aug paid in full)
  assert.equal(settlePeriodOf('2026-09-01'), '2026-09');
  assert.equal(settlePeriodOf('2026-09-26'), '2026-09'); // the due day itself is in that payment
  assert.equal(settlePeriodOf('2026-09-27'), '2026-10');
  assert.equal(settlePeriodOf('2026-12-30'), '2027-01');
  assert.equal(settlePeriodOf('2026-10-27', 25), '2026-11');
});

test('each payment covers the 27th through the 26th; September starts on the 1st', () => {
  assert.deepEqual(settlePeriodRange('2026-08'), { from: '2026-08-01', to: '2026-08-31' });
  assert.deepEqual(settlePeriodRange('2026-09'), { from: '2026-09-01', to: '2026-09-26' });
  assert.deepEqual(settlePeriodRange('2026-10'), { from: '2026-09-27', to: '2026-10-26' });
  assert.deepEqual(settlePeriodRange('2027-01'), { from: '2026-12-27', to: '2027-01-26' });
});

test('settlement groups by settle_month, so a Sep 28 sale is in the October payment', () => {
  const sale = (id, day, rev, cost) => ({ order_id: id, counted: true, created_at: `${day}T19:00:00Z`, business_month: day.slice(0, 7), settle_month: settlePeriodOf(day), revenue: rev, fees: 0, refunds: 0, cost, amazon_refund: 0, ad_fees: 0, extra_cost: 0 });
  const orders = [sale('a', '2026-09-23', 20, 10), sale('b', '2026-09-28', 40, 20)];
  assert.equal(settleMonth({ month: '2026-09', orders, expenses: [] }).orders, 1);
  const oct = settleMonth({ month: '2026-10', orders, expenses: [] });
  assert.equal(oct.orders, 1);
  assert.equal(oct.sellerSends, 30); // cost 20 + half of the 20 profit
});
