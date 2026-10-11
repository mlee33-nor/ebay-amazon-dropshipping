// Pure aggregation over the per-order dataset served by /api/data. Days, ranges and buckets are Arizona days
// (see util.js), the same days the server settles on.
import { DAY, startOfDay, azDay, azHour, azWeekday, azStart, addDays } from './util.js';
import { settlePeriodOf, settlePeriodRange, monthKey } from './settlement.js';

// Which payment a row is on: the server decides it (settle_month); older data falls back to the month
export const rowMonth = (o) => o.settle_month || o.business_month || monthKey(o.created_at);
// The pay period whose own activity a row is: its payment, except a correction for an earlier, already-paid period
// (o.correction_for), which is money on a later payment but neither period's own activity (null). A pay period picked
// in the range bar shows its own rows, so its numbers match a sheet kept for that period; the Overview and the
// Settlement page show the corrections separately. Date ranges (last 7 days, ...) still include every row by its date.
export const periodMonth = (o) => (o.correction_for ? null : rowMonth(o));
// A refund line ("Refund · …", a refund booked on a later payment) or a monthly-sheet refund row is money, not a
// sale: it keeps its money in every total but is never counted as an order, a unit, a buyer or a product of its own
// Refund lines and adjustment lines (money moved between payments after one was paid) are never sales
export const isSale = (o) => o.source !== 'refund' && o.source !== 'adjustment' && !o.ledger?.is_refund;
// The sale a row belongs to: a refund line points at its sale, a sheet row at its eBay order when it has one
export const saleIdOf = (o) => (o.source === 'refund' ? o.refund_of : o.source === 'adjustment' ? o.adjustment_of || o.order_id : o.ebay_order_id || o.order_id);

// `month` picks a payment (pay period): from September 2026 that is the 27th of the month before through the 26th
// (see settlement.js), so a month's numbers here are exactly that payment's numbers. `calendar` marks the one preset
// that is a calendar month, so pages can say so.
export function rangeFor(key, custom, month, { now = Date.now(), dueDay = 26 } = {}) {
  const today = azDay(now);
  const end = new Date(azStart(addDays(today, 1)).getTime() - 1);
  const back = (days) => ({ start: azStart(addDays(today, -(days - 1))), end });
  switch (key) {
    case '1d': return back(1);
    case '7d': return back(7);
    case '30d': return back(30);
    case '90d': return back(90);
    case 'mtd': return { start: azStart(`${today.slice(0, 7)}-01`), end, calendar: true };
    case 'ytd': return { start: azStart(`${today.slice(0, 4)}-01-01`), end };
    case '12m': return back(365);
    case 'month': {
      const m = /^\d{4}-\d{2}$/.test(month || '') ? month : settlePeriodOf(today, dueDay);
      const period = settlePeriodRange(m, dueDay);
      const pEnd = new Date(azStart(addDays(period.to, 1)).getTime() - 1);
      return { start: azStart(period.from), end: pEnd < end ? pEnd : end, month: m, period, dueDay };
    }
    case 'custom':
      if (custom?.from && custom?.to) return { start: azStart(custom.from), end: new Date(azStart(addDays(custom.to, 1)).getTime() - 1) };
      return back(30);
    default: return { start: null, end };
  }
}

export function previousRange(r) {
  if (!r.start) return null;
  // A payment compares with the payment before it (its own rows, like the Settlement page)
  if (r.month) {
    const [y, mo] = r.month.split('-').map(Number);
    const prev = mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
    const period = settlePeriodRange(prev, r.dueDay ?? 26);
    return { start: azStart(period.from), end: new Date(azStart(addDays(period.to, 1)).getTime() - 1), month: prev, period, dueDay: r.dueDay };
  }
  const len = r.end.getTime() - r.start.getTime();
  return { start: new Date(r.start.getTime() - len - 1), end: new Date(r.start.getTime() - 1) };
}

export const inRange = (orders, r) =>
  !r ? [] : r.month ? orders.filter((o) => periodMonth(o) === r.month) : orders.filter((o) => {
    const t = new Date(o.created_at).getTime();
    return (!r.start || t >= r.start.getTime()) && t <= r.end.getTime();
  });

export function summarize(orders) {
  const live = orders.filter((o) => !o.excluded && !o.cancelled);
  const counted = orders.filter((o) => o.counted);
  const sales = live.filter(isSale); // refund lines and sheet refund rows keep their money but are not orders
  const countedSales = counted.filter(isSale);
  const sum = (arr, f) => arr.reduce((s, o) => s + (f(o) || 0), 0);
  const revenueAll = sum(live, (o) => o.revenue);
  const revenue = sum(counted, (o) => o.revenue);
  const cost = sum(counted, (o) => o.cost);
  const fees = sum(counted, (o) => o.fees);
  const adFees = sum(counted, (o) => o.ad_fees);
  const refunds = sum(counted, (o) => o.refunds);
  const amazonRefund = sum(counted, (o) => o.amazon_refund);
  const extra = sum(counted, (o) => o.extra_cost);
  const net = sum(counted, (o) => o.net);
  const units = sum(sales, (o) => o.units);
  // A returned sale counts once, whether its refund is on the sale itself, on a later refund line or on a sheet row
  const returned = new Set(live.filter((o) => o.returns.length || o.refunds > 0 || !isSale(o)).map(saleIdOf));
  const awaiting = orders.filter((o) => o.status === 'awaiting_cost');
  const losses = counted.filter((o) => o.net < 0);
  const lags = countedSales.map((o) => o.lag_days).filter((x) => x !== null && x !== undefined && x >= 0);
  const buyers = new Map();
  for (const o of sales) if (o.buyer) buyers.set(o.buyer, (buyers.get(o.buyer) || 0) + 1);
  return {
    orders: sales.length,
    countedOrders: countedSales.length,
    countedRows: counted.length, // counted lines with money, refund lines included
    units,
    revenueAll,
    revenue,
    cost,
    fees,
    adFees,
    refunds,
    amazonRefund,
    extra,
    net,
    margin: revenue > 0 ? net / revenue : null,
    roi: cost > 0 ? net / cost : null,
    aov: sales.length ? revenueAll / sales.length : null,
    profitPerOrder: countedSales.length ? net / countedSales.length : null,
    feeRate: revenue > 0 ? (fees + adFees) / revenue : null,
    returnCount: returned.size,
    returnRate: sales.length ? Math.min(1, returned.size / sales.length) : null,
    awaitingCount: awaiting.length,
    awaitingRevenue: sum(awaiting, (o) => o.revenue),
    lossCount: losses.length,
    lossTotal: sum(losses, (o) => o.net),
    cancelled: orders.filter((o) => o.cancelled).length,
    avgLag: lags.length ? lags.reduce((a, b) => a + b, 0) / lags.length : null,
    avgCost: countedSales.length ? cost / countedSales.length : null,
    repeatBuyers: [...buyers.values()].filter((n) => n > 1).length,
    uniqueBuyers: buyers.size,
    unitsPerOrder: sales.length ? units / sales.length : null,
  };
}

export function bucketKey(date, gran) {
  const day = azDay(date);
  if (gran === 'month') return day.slice(0, 7);
  if (gran === 'hour') return `${day}T${String(azHour(date)).padStart(2, '0')}`;
  if (gran === 'week') return addDays(day, -((azWeekday(date) + 6) % 7)); // Monday
  return day;
}

export function buckets(r, orders, gran) {
  // Build an unbroken list of bucket keys across the range so gaps show as zero
  let start = r.start;
  if (!start) {
    const first = orders.reduce((m, o) => Math.min(m, new Date(o.created_at).getTime()), Date.now());
    start = startOfDay(new Date(first));
  }
  const keys = [];
  const seen = new Set();
  if (gran === 'hour' && r.end.getTime() - start.getTime() > 8 * DAY) gran = 'day'; // hourly only makes sense for short ranges
  const step = gran === 'hour' ? 3600_000 : DAY;
  for (let t = start.getTime(); t <= r.end.getTime(); t += step) {
    const k = bucketKey(t, gran);
    if (!seen.has(k)) { seen.add(k); keys.push(k); }
  }
  const map = new Map(keys.map((k) => [k, []]));
  for (const o of orders) {
    // A payment can carry a row from before its period (a sale costed after its own payment was made, a refund after
    // an early payment): it is on this payment, so it goes in the first bucket rather than falling off the chart
    const t = Date.parse(o.created_at);
    const k = bucketKey(r.month && r.start ? Math.min(Math.max(t, r.start.getTime()), r.end.getTime()) : o.created_at, gran);
    if (map.has(k)) map.get(k).push(o);
  }
  return keys.map((k) => ({ key: k, orders: map.get(k), ...summarize(map.get(k)) }));
}

export function autoGran(r, orders) {
  let days;
  if (r.start) days = (r.end - r.start) / DAY;
  else {
    const first = orders.reduce((m, o) => Math.min(m, new Date(o.created_at).getTime()), Date.now());
    days = (Date.now() - first) / DAY;
  }
  if (days <= 1.5) return 'hour';
  if (days <= 45) return 'day';
  if (days <= 240) return 'week';
  return 'month';
}

export function productKey(o) {
  if (o.source === 'refund') return String(o.title || '').replace(/^Refund · /, '').toLowerCase().trim() || o.title;
  return (o.items[0]?.sku || o.title || '').toLowerCase().trim() || o.title;
}

// Product keys that put a refund line under the product it refunds. The refunded sale is looked up in `all` (the
// whole dataset), even when it was sold outside the range shown: an eBay sale by its order id, a sale a monthly sheet
// covers through the sheet row paired with it. Without the sale, the title (minus "Refund · ") is the fallback.
const keyerCache = new WeakMap();
export function productKeyer(all = []) {
  if (keyerCache.has(all)) return keyerCache.get(all);
  const saleKey = new Map();
  for (const o of all) if (o.source === 'ebay' && !o.in_sheet) saleKey.set(o.order_id, productKey(o));
  for (const o of all) if (o.source === 'ledger' && o.ebay_order_id && !o.ledger?.is_refund && !saleKey.has(o.ebay_order_id)) saleKey.set(o.ebay_order_id, productKey(o));
  const fn = (o) => (o.source === 'refund' && saleKey.has(o.refund_of) ? saleKey.get(o.refund_of) : productKey(o));
  keyerCache.set(all, fn);
  return fn;
}

// `all` is the whole dataset, used to find the sale a refund line belongs to; it defaults to the rows given
export function byProduct(orders, all = orders) {
  const keyOf = productKeyer(all);
  const m = new Map();
  for (const o of orders) {
    // An adjustment line only moves a sale's money between payments; the sale itself already shows its real numbers
    if (o.excluded || o.cancelled || o.source === 'adjustment') continue;
    const k = keyOf(o);
    if (!m.has(k)) m.set(k, { key: k, title: String(o.title || '').replace(/^Refund · /, ''), sku: o.items[0]?.sku || '', orders: [] });
    const p = m.get(k);
    // Named after a sale, not after a refund line
    if (isSale(o) && !p.orders.some(isSale)) { p.title = o.title; p.sku = o.items[0]?.sku || ''; }
    p.orders.push(o);
  }
  return [...m.values()].map((p) => {
    const s = summarize(p.orders);
    const last = p.orders.filter(isSale).reduce((a, o) => (o.created_at > a ? o.created_at : a), '');
    return {
      ...p,
      ...s,
      lastSold: last || null,
      avgSale: s.orders ? s.revenueAll / s.orders : null,
      avgCostPer: s.countedOrders ? s.cost / s.countedOrders : null,
    };
  });
}

export function groupBy(orders, fn) {
  const m = new Map();
  for (const o of orders) {
    const k = fn(o);
    if (k === null || k === undefined) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(o);
  }
  return m;
}

export const STATUS_META = {
  profitable: { label: 'Profitable', cls: 'good' },
  loss: { label: 'Loss', cls: 'bad' },
  returned: { label: 'Returned', cls: 'warn' },
  return_open: { label: 'Return open', cls: 'warn' },
  awaiting_email: { label: 'Awaiting email', cls: 'info' },
  awaiting_cost: { label: 'Needs cost', cls: 'warn' },
  cancelled: { label: 'Cancelled', cls: '' },
  cancelled_after_purchase: { label: 'Cancelled (bought)', cls: 'bad' },
  excluded: { label: 'Excluded', cls: '' },
  not_dropship: { label: 'Not dropship', cls: '' },
  in_sheet: { label: 'In monthly sheet', cls: '' },
  before_start: { label: 'Before partnership', cls: '' },
  check_sheet: { label: 'Check: maybe in sheet', cls: 'warn' },
  // Held back because an Amazon email couldn't be read (sent by servers that have it; older ones never do)
  needs_review: { label: 'Needs review', cls: 'bad' },
  adjustment: { label: 'Payment adjustment', cls: 'info' },
};

// Operating costs that fall in a range. A payment's range (Month) takes that payment's costs in full, exactly like the
// settlement. Any other range spreads each month's costs over the days its payment covers (the 27th through the 26th
// from September 2026): a month covered in full (or the current one through today) counts in full, a partly covered
// month by its share of the days.
export function opexFor(r, expenses, { now = Date.now(), dueDay = 26 } = {}) {
  const byCategory = new Map();
  const byMonth = new Map();
  let total = 0;
  const add = (e, amt) => {
    total += amt;
    byCategory.set(e.category, (byCategory.get(e.category) || 0) + amt);
    byMonth.set(e.month, (byMonth.get(e.month) || 0) + amt);
  };
  if (r?.month) {
    for (const e of expenses) if (e.month === r.month) add(e, Number(e.amount) || 0);
    return { total, byCategory, byMonth };
  }
  const endOfToday = new Date(azStart(addDays(azDay(now), 1)).getTime() - 1);
  for (const e of expenses) {
    const span = settlePeriodRange(e.month, dueDay);
    const mStart = azStart(span.from);
    const mEndFull = new Date(azStart(addDays(span.to, 1)).getTime() - 1);
    const mEnd = mEndFull > endOfToday ? endOfToday : mEndFull;
    if (mEnd < mStart) continue;
    const from = r.start && r.start > mStart ? r.start : mStart;
    const to = r.end < mEnd ? r.end : mEnd;
    if (to < from) continue;
    const days = (x, y2) => Math.round((startOfDay(y2) - startOfDay(x)) / DAY) + 1;
    const fullCover = from <= mStart && to >= mEnd;
    const share = fullCover ? 1 : Math.min(1, days(from, to) / days(mStart, mEndFull));
    add(e, (Number(e.amount) || 0) * share);
  }
  return { total, byCategory, byMonth };
}
