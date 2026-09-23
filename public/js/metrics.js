// Pure aggregation over the per-order dataset served by /api/data.
import { DAY, startOfDay, ymd } from './util.js';

export function rangeFor(key, custom, month) {
  const now = new Date();
  const end = new Date(startOfDay(now).getTime() + DAY - 1);
  const back = (days) => ({ start: startOfDay(new Date(now.getTime() - (days - 1) * DAY)), end });
  switch (key) {
    case '1d': return back(1);
    case '7d': return back(7);
    case '30d': return back(30);
    case '90d': return back(90);
    case 'mtd': return { start: new Date(now.getFullYear(), now.getMonth(), 1), end };
    case 'ytd': return { start: new Date(now.getFullYear(), 0, 1), end };
    case '12m': return back(365);
    case 'month': {
      const [y, mo] = String(month || '').split('-').map(Number);
      if (!y || !mo) return { start: new Date(now.getFullYear(), now.getMonth(), 1), end };
      const mEnd = new Date(y, mo, 0, 23, 59, 59, 999);
      return { start: new Date(y, mo - 1, 1), end: mEnd < end ? mEnd : end };
    }
    case 'custom':
      if (custom?.from && custom?.to) {
        const [fy, fm, fd] = custom.from.split('-').map(Number);
        const [ty, tm, td] = custom.to.split('-').map(Number);
        return { start: new Date(fy, fm - 1, fd), end: new Date(new Date(ty, tm - 1, td).getTime() + DAY - 1) };
      }
      return back(30);
    default: return { start: null, end };
  }
}

export function previousRange(r) {
  if (!r.start) return null;
  const len = r.end.getTime() - r.start.getTime();
  return { start: new Date(r.start.getTime() - len - 1), end: new Date(r.start.getTime() - 1) };
}

export const inRange = (orders, r) =>
  !r ? [] : orders.filter((o) => {
    const t = new Date(o.created_at).getTime();
    return (!r.start || t >= r.start.getTime()) && t <= r.end.getTime();
  });

export function summarize(orders) {
  const live = orders.filter((o) => !o.excluded && !o.cancelled);
  const counted = orders.filter((o) => o.counted);
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
  const units = sum(live, (o) => o.units);
  const returned = live.filter((o) => o.returns.length || o.refunds > 0);
  const awaiting = orders.filter((o) => o.status === 'awaiting_cost');
  const losses = counted.filter((o) => o.net < 0);
  const lags = counted.map((o) => o.lag_days).filter((x) => x !== null && x >= 0);
  const buyers = new Map();
  for (const o of live) if (o.buyer) buyers.set(o.buyer, (buyers.get(o.buyer) || 0) + 1);
  return {
    orders: live.length,
    countedOrders: counted.length,
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
    aov: live.length ? revenueAll / live.length : null,
    profitPerOrder: counted.length ? net / counted.length : null,
    feeRate: revenue > 0 ? (fees + adFees) / revenue : null,
    returnCount: returned.length,
    returnRate: live.length ? returned.length / live.length : null,
    awaitingCount: awaiting.length,
    awaitingRevenue: sum(awaiting, (o) => o.revenue),
    lossCount: losses.length,
    lossTotal: sum(losses, (o) => o.net),
    cancelled: orders.filter((o) => o.cancelled).length,
    avgLag: lags.length ? lags.reduce((a, b) => a + b, 0) / lags.length : null,
    avgCost: counted.length ? cost / counted.length : null,
    repeatBuyers: [...buyers.values()].filter((n) => n > 1).length,
    uniqueBuyers: buyers.size,
    unitsPerOrder: live.length ? units / live.length : null,
  };
}

export function bucketKey(date, gran) {
  const d = new Date(date);
  if (gran === 'month') return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  if (gran === 'hour') return `${ymd(d)}T${String(d.getHours()).padStart(2, '0')}`;
  if (gran === 'week') {
    const s = startOfDay(d);
    s.setDate(s.getDate() - ((s.getDay() + 6) % 7)); // Monday
    return ymd(s);
  }
  return ymd(d);
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
    const k = bucketKey(o.created_at, gran);
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
  return (o.items[0]?.sku || o.title || '').toLowerCase().trim() || o.title;
}

export function byProduct(orders) {
  const m = new Map();
  for (const o of orders) {
    if (o.excluded || o.cancelled) continue;
    const k = productKey(o);
    if (!m.has(k)) m.set(k, { key: k, title: o.title, sku: o.items[0]?.sku || '', orders: [] });
    m.get(k).orders.push(o);
  }
  return [...m.values()].map((p) => {
    const s = summarize(p.orders);
    const last = p.orders.reduce((a, o) => (o.created_at > a ? o.created_at : a), '');
    const counted = p.orders.filter((o) => o.counted);
    return {
      ...p,
      ...s,
      lastSold: last,
      avgSale: s.orders ? s.revenueAll / s.orders : null,
      avgCostPer: counted.length ? s.cost / counted.length : null,
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
  awaiting_cost: { label: 'Awaiting cost', cls: 'info' },
  cancelled: { label: 'Cancelled', cls: '' },
  cancelled_after_purchase: { label: 'Cancelled (bought)', cls: 'bad' },
  excluded: { label: 'Excluded', cls: '' },
  in_sheet: { label: 'In monthly sheet', cls: '' },
};

// Monthly operating costs that fall in a date range. A month fully inside the range counts in full;
// a partly covered month counts pro rata by days (for the current month, by days elapsed so far).
export function opexFor(r, expenses) {
  const today = new Date();
  const byCategory = new Map();
  const byMonth = new Map();
  let total = 0;
  for (const e of expenses) {
    const [y, mo] = e.month.split('-').map(Number);
    const mStart = new Date(y, mo - 1, 1);
    const mEndFull = new Date(y, mo, 0, 23, 59, 59, 999);
    const mEnd = mEndFull > today ? new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59, 999) : mEndFull;
    if (mEnd < mStart) continue;
    const from = r.start && r.start > mStart ? r.start : mStart;
    const to = r.end < mEnd ? r.end : mEnd;
    if (to < from) continue;
    const days = (x, y2) => Math.round((startOfDay(y2) - startOfDay(x)) / DAY) + 1;
    const share = Math.min(1, days(from, to) / days(mStart, mEnd));
    const amt = (Number(e.amount) || 0) * share;
    total += amt;
    byCategory.set(e.category, (byCategory.get(e.category) || 0) + amt);
    byMonth.set(e.month, (byMonth.get(e.month) || 0) + amt);
  }
  return { total, byCategory, byMonth };
}
