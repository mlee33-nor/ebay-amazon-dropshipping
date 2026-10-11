// The Watchlist's lists, kept pure (no DOM) so the tests can check them: Amazon refunds still to chase, and products
// worth reconsidering. A refund line ("Refund · …") counts under the product it refunds, never as a product of its own.
import { money, pct, DAY } from './util.js';
import { byProduct, productKeyer, isSale, saleIdOf } from './metrics.js';

const cents = (n) => Math.round((Number(n) || 0) * 100);

export function refundsToChase(orders) {
  return orders
    .filter((o) => o.source === 'ebay' && !o.cancelled && o.status !== 'not_dropship' && (o.raw_refunds || 0) > 0 && o.amazon_orders.length && (o.cost_source === 'amazon' || o.cost_source === 'override') && o.cost > 0)
    .map((o) => {
      const got = Math.max(o.email_refund || 0, o.amazon_refund || 0, o.overrides?.amazon_refund || 0);
      const missing = Math.round((cents(o.cost) - cents(got))) / 100;
      const since = o.last_refund_at || o.created_at;
      return { o, got, missing, days: Math.floor((Date.now() - new Date(since)) / DAY), since };
    })
    .filter((x) => x.missing > 0.009)
    .sort((a, b) => b.days - a.days);
}

export function productsToReconsider(orders) {
  const counted = orders.filter((o) => o.counted);
  // A refund line belongs to the product it refunds (never a product of its own), keyed the same way as byProduct
  const keyOf = productKeyer(orders);
  const lists = new Map();
  for (const o of counted) { const k = keyOf(o); if (!lists.has(k)) lists.set(k, []); lists.get(k).push(o); }
  return byProduct(counted, orders)
    .map((p) => {
      const mine = lists.get(p.key) || [];
      // Refunded sales, each once: a sale and its later refund line are one refund
      const refunds = new Set(mine.filter((o) => (o.refunds || 0) > 0 || o.status === 'returned' || !isSale(o)).map(saleIdOf)).size;
      const n = p.countedOrders;
      const margin = p.revenue ? p.net / p.revenue : null;
      let verdict = null;
      if (n >= 2 && p.net < 0) verdict = { cls: 'bad', t: 'Stop listing', why: `lost ${money(-p.net, 2)} over ${n} sales` };
      else if (refunds >= 2 && n && refunds / n >= 0.3) verdict = { cls: 'warn', t: 'Check quality', why: `${refunds} of ${n} sales refunded` };
      else if (n >= 3 && margin !== null && margin < 0.05) verdict = { cls: 'warn', t: 'Raise price', why: `only ${pct(margin)} margin` };
      else if (n === 1 && p.net < -5) verdict = { cls: 'warn', t: 'Watch', why: `one sale lost ${money(-p.net, 2)}` };
      // Display only: the product's most recent counted sale, where "Review in Editor" lands
      const last = mine.filter(isSale).reduce((a, o) => (!a || String(o.created_at) > String(a.created_at) ? o : a), null);
      return verdict ? { ...p, n, refunds, margin, verdict, lastOrderId: last?.order_id || null } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.net - b.net);
}
