// Watchlist: money to chase and things to fix.
//   1. Amazon refunds to chase: eBay refunded the buyer, but Amazon hasn't refunded what was paid for the item
//   2. Amazon purchases with no eBay sale: missed matches, or purchases that aren't for the business
//   3. Products to reconsider: losing money, refunded often, or too thin to be worth listing
import { esc, money, pct, count, fmtDate, api, toast, ICONS, DAY } from './util.js';
import { byProduct, productKey } from './metrics.js';
import { state, loadData, renderPage, openOrder, skeletonRows } from './app.js';

const CHASE_AFTER_DAYS = 14;
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
  // byProduct's summary replaces the order list with a count, so keep each product's orders here
  const lists = new Map();
  for (const o of counted) { const k = productKey(o); if (!lists.has(k)) lists.set(k, []); lists.get(k).push(o); }
  return byProduct(counted)
    .map((p) => {
      const refunds = (lists.get(p.key) || []).filter((o) => (o.refunds || 0) > 0 || o.status === 'returned').length;
      const n = p.countedOrders;
      const margin = p.revenue ? p.net / p.revenue : null;
      let verdict = null;
      if (n >= 2 && p.net < 0) verdict = { cls: 'bad', t: 'Stop listing', why: `lost ${money(-p.net, 2)} over ${n} sales` };
      else if (refunds >= 2 && refunds / n >= 0.3) verdict = { cls: 'warn', t: 'Check quality', why: `${refunds} of ${n} sales refunded` };
      else if (n >= 3 && margin !== null && margin < 0.05) verdict = { cls: 'warn', t: 'Raise price', why: `only ${pct(margin)} margin` };
      else if (n === 1 && p.net < -5) verdict = { cls: 'warn', t: 'Watch', why: `one sale lost ${money(-p.net, 2)}` };
      return verdict ? { ...p, n, refunds, margin, verdict } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.net - b.net);
}

export async function renderWatch(el) {
  const d = state.data;
  const chase = refundsToChase(d.orders);
  const chaseTotal = chase.reduce((t, x) => t + cents(x.missing), 0) / 100;
  const late = chase.filter((x) => x.days >= CHASE_AFTER_DAYS);
  const recon = productsToReconsider(d.orders);

  el.innerHTML = `
  <div class="grid g-3 watch-kpis">
    <div class="card kpi"><div class="kpi-top">${ICONS.return} Amazon refunds to chase</div><div class="kpi-val num ${chaseTotal ? 'neg' : ''}">${money(chaseTotal, 2)}</div><div class="kpi-foot"><span>${count(chase.length)} order${chase.length === 1 ? '' : 's'}${late.length ? ` · <b class="neg">${late.length} over ${CHASE_AFTER_DAYS} days</b>` : ''}</span></div></div>
    <div class="card kpi"><div class="kpi-top">${ICONS.package} Amazon purchases with no eBay sale</div><div class="kpi-val num" id="w-unm-n">…</div><div class="kpi-foot"><span id="w-unm-f">checking</span></div></div>
    <div class="card kpi"><div class="kpi-top">${ICONS.trendDown} Products to reconsider</div><div class="kpi-val num">${count(recon.length)}</div><div class="kpi-foot"><span>${recon.filter((r) => r.verdict.cls === 'bad').length} losing money overall</span></div></div>
  </div>

  <div class="card mt">
    <div class="card-h"><div><h3>Amazon refunds to chase</h3><div class="sub">eBay refunded the buyer, but Amazon hasn't refunded what ${esc(d.settings.partner_amazon)} paid (no Amazon refund email yet). Red after ${CHASE_AFTER_DAYS} days.</div></div></div>
    <div class="card-b table-wrap">${chase.length ? `<table class="simple"><thead><tr><th>Sold</th><th>Item</th><th class="r">Refunded to buyer</th><th class="r">Amazon cost</th><th class="r">Amazon refunded</th><th class="r">Still to recover</th><th class="r">Waiting</th><th></th></tr></thead><tbody>
      ${chase.map((x) => `<tr class="${x.days >= CHASE_AFTER_DAYS ? 'row-bad' : ''}"><td style="white-space:nowrap">${fmtDate(x.o.created_at)}</td><td>${esc(x.o.title.slice(0, 70))}<div class="muted mono" style="font-size:11px">${esc(x.o.amazon_orders.map((a) => a.amazon_order_id).join(', '))}</div></td><td class="r">${money(x.o.raw_refunds, 2)}</td><td class="r">${money(x.o.cost, 2)}</td><td class="r">${money(x.got, 2)}</td><td class="r"><b class="neg">${money(x.missing, 2)}</b></td><td class="r" style="white-space:nowrap">${x.days >= CHASE_AFTER_DAYS ? `<span class="pill bad">${ICONS.alert} ${x.days} days</span>` : `<span class="pill">${ICONS.clock} ${x.days} day${x.days === 1 ? '' : 's'}</span>`}</td><td class="r"><button class="btn sm ghost" data-open="${esc(x.o.order_id)}">Open</button></td></tr>`).join('')}
      </tbody></table><div class="muted" style="font-size:12px;padding:10px 14px">Once Amazon refunds, the refund email is picked up automatically and the row disappears. If Amazon won't refund, enter what was recovered in the Editor's “Amazon refund” column.</div>` : `<div class="empty"><div class="ic">${ICONS.circleCheck}</div><div class="t">Nothing to chase</div><p>Every refunded eBay sale with an Amazon purchase has its Amazon refund recorded.</p></div>`}</div>
  </div>

  <div class="card mt">
    <div class="card-h"><div><h3>Amazon purchases with no eBay sale</h3><div class="sub">Usually a match the matcher wasn't sure about, or a purchase that isn't for the business. Unmatched purchases never count toward profit.</div></div><div class="right"><a class="btn sm" href="#/editor?tab=matches">${ICONS.link} Review matches</a></div></div>
    <div class="card-b table-wrap" id="w-unm">${skeletonRows(4)}</div>
  </div>

  <div class="card mt">
    <div class="card-h"><div><h3>Products to reconsider</h3><div class="sub">All time, counted sales only: losing money, refunded often, or margin under 5%</div></div></div>
    <div class="card-b table-wrap">${recon.length ? `<table class="simple"><thead><tr><th>Product</th><th class="r">Sold</th><th class="r">Profit</th><th class="r">Margin</th><th class="r">Refunds</th><th>Suggestion</th></tr></thead><tbody>
      ${recon.map((p) => `<tr><td>${esc(p.title.slice(0, 80))}</td><td class="r">${count(p.n)}</td><td class="r ${p.net < 0 ? 'neg' : ''}">${money(p.net, 2)}</td><td class="r">${pct(p.margin)}</td><td class="r">${count(p.refunds)}</td><td><span class="pill ${p.verdict.cls}">${p.verdict.cls === 'bad' ? ICONS.alert : ICONS.info} ${p.verdict.t}</span> <span class="muted" style="font-size:12px">${esc(p.verdict.why)}</span></td></tr>`).join('')}
      </tbody></table>` : `<div class="empty"><div class="ic">${ICONS.circleCheck}</div><div class="t">No problem products</div><p>Nothing is losing money, getting refunded often or selling on a razor-thin margin.</p></div>`}</div>
  </div>`;

  el.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openOrder(b.dataset.open)));

  // Unmatched Amazon purchases (fetched separately: the list of Amazon lines isn't in the main data)
  try {
    const lines = await api('/api/amazon');
    const byOrder = new Map();
    for (const l of lines) {
      if (l.ebay_order_id || l.ignored || /cancel/i.test(l.order_status || '')) continue;
      if (!byOrder.has(l.amazon_order_id)) byOrder.set(l.amazon_order_id, { id: l.amazon_order_id, date: l.order_date, total: 0, known: true, who: [l.ship_name, l.ship_state].filter(Boolean).join(', '), title: l.title });
      const x = byOrder.get(l.amazon_order_id);
      if (l.line_total === null) x.known = false; else x.total += Number(l.line_total) || 0;
    }
    const list = [...byOrder.values()].sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const n = el.querySelector('#w-unm-n');
    if (!n) return; // navigated away
    n.textContent = count(list.length);
    el.querySelector('#w-unm-f').textContent = list.length ? `${money(list.filter((x) => x.known).reduce((t, x) => t + x.total, 0), 2)} spent, not tied to a sale` : 'all matched';
    el.querySelector('#w-unm').innerHTML = list.length ? `<table class="simple"><thead><tr><th>Ordered</th><th>Amazon order</th><th>Ship to</th><th>What</th><th class="r">Total</th><th class="r">Age</th><th></th></tr></thead><tbody>
      ${list.map((x) => { const age = x.date ? Math.floor((Date.now() - new Date(x.date)) / DAY) : null; return `<tr><td style="white-space:nowrap">${x.date ? fmtDate(x.date) : '—'}</td><td class="mono" style="font-size:12px">${esc(x.id)}</td><td>${esc(x.who || '—')}</td><td class="muted" style="font-size:12.5px">${esc((x.title || '').slice(0, 60))}</td><td class="r">${x.known ? money(x.total, 2) : '<span class="muted">unknown</span>'}</td><td class="r">${age === null ? '—' : `${age}d`}</td><td class="r" style="white-space:nowrap"><button class="btn sm ghost" data-ignore="${esc(x.id)}" title="Mark as not for the business">${ICONS.eyeOff} Not business</button></td></tr>`; }).join('')}
      </tbody></table>` : `<div class="empty"><div class="ic">${ICONS.circleCheck}</div><div class="t">Every Amazon purchase is matched</div><p>Each Amazon order from the email import is tied to an eBay sale.</p></div>`;
    el.querySelectorAll('[data-ignore]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm(`Mark Amazon order ${b.dataset.ignore} as not for the business? It will stay out of the numbers and off this list.`)) return;
      await api('/api/links/reject', { method: 'POST', body: { amazon_order_id: b.dataset.ignore, ignore_amazon: true } });
      toast('Marked as not for the business', 'good');
      await loadData();
      renderPage();
    }));
  } catch (e) {
    const box = el.querySelector('#w-unm');
    if (box) box.innerHTML = `<div class="muted" style="padding:14px">Couldn't load Amazon purchases: ${esc(e.message)}</div>`;
  }
}
