// The Overview, kept simple: how much profit, what Drew owes Myles, anything that needs a look, then a few optional
// cards (Settings -> Customize dashboard turns each one on or off). A pay period here shows exactly the numbers on its
// statement (Reports) and the Payments page: the same settleMonth() figures, the period's own activity.
import { $, $$, esc, money, count, fmtDate, ICONS, settlementDueDate, dueStatus, monthLabel, settleView, azDay, api, toast } from './util.js';
import { summarize, buckets, byProduct, isSale, opexFor } from './metrics.js';
import { mount, colors, tooltipBase, axisBase, ttRow, ttHead } from './charts.js';
import { settleMonth, settlePeriodRange } from './settlement.js';
import { emailFailures, emailFailureText } from './health.js';
import { showCard } from './dash-prefs.js';
import { state, loadData, renderPage, currentRange, currentPeriod, setupBanner, statusPill, viewStatus, openOrder } from './app.js';

const cents = (n) => Math.round((Number(n) || 0) * 100);
// A cost line: minus sign only when there is something to take off
const minus = (v) => (Math.abs(v) >= 0.005 ? `${v > 0 ? '−' : '+'}${money(Math.abs(v), 2)}` : money(0, 2));
// The settlement's money for any set of rows (in dollars), summed in cents like settleMonth()
function moneyOf(rows) {
  let collected = 0, cogs = 0, ads = 0, other = 0;
  for (const o of rows) {
    if (!o.counted) continue;
    collected += cents(o.revenue) - cents(o.fees) - cents(o.refunds);
    cogs += cents(o.cost) - cents(o.amazon_refund);
    ads += cents(o.ad_fees);
    other += cents(o.extra_cost);
  }
  return { collected: collected / 100, cogs: cogs / 100, ads: ads / 100, other: other / 100, itemProfit: (collected - cogs - ads - other) / 100 };
}

export function renderOverview(el) {
  const d = state.data;
  const A = d.settings.partner_amazon;
  const B = d.settings.partner_ebay;
  const split = Number(d.settings.split_amazon ?? 50);
  const dueDay = Number(d.settings.settlement_day) || 26;
  const r = currentRange();
  const settleArgs = { orders: d.orders, expenses: d.books.expenses, settlements: d.books.settlements, splitAmazon: split };
  const show = (id) => showCard(d.settings, id);

  // ---- the numbers for the time picked
  let rows; // this time's own rows (a pay period leaves out corrections for an earlier, already-paid period)
  let fig; // { collected, cogs, ads, other, opex, profit }
  let when; // "Sep 27 – Oct 26" etc.
  let opexNote = '';
  let periodSettle = null;
  if (r.month) {
    periodSettle = settleMonth({ month: r.month, ...settleArgs });
    const so = periodSettle.own ? { ...periodSettle, ...periodSettle.own } : periodSettle;
    rows = d.orders.filter((o) => o.counted && (o.settle_month === r.month) && !o.correction_for);
    fig = { collected: so.collected, cogs: so.cogs, ads: so.adFees, other: so.otherCosts, opex: periodSettle.opex, profit: so.businessProfit };
    const p = settlePeriodRange(r.month, dueDay);
    when = `${fmtDate(p.from)} – ${fmtDate(p.to)}`;
  } else {
    rows = (r.start ? d.orders.filter((o) => { const t = Date.parse(o.created_at); return t >= r.start.getTime() && t <= r.end.getTime(); }) : d.orders).filter((o) => o.counted);
    const m = moneyOf(rows);
    const today = state.range === 'today';
    // A day carries no share of the monthly costs (they come off each pay period as a whole); other ranges take each
    // month's costs by the share of its days in the range, like the old Overview
    const opex = today ? 0 : opexFor(r, d.books.expenses, { dueDay }).total;
    fig = { ...m, opex, profit: Math.round((m.itemProfit - opex) * 100) / 100 };
    when = today ? `Today, ${fmtDate(azDay())}` : r.start ? `${fmtDate(r.start)} – ${fmtDate(r.end)}` : 'All time';
    if (today) opexNote = 'Monthly costs aren’t taken off a single day. They come off each pay period as a whole.';
    else if (r.start) opexNote = 'Monthly costs are counted by the share of each pay period these dates cover.';
  }
  const sales = rows.filter(isSale);
  const refundLines = rows.length - sales.length;
  const waiting = (r.month ? d.orders.filter((o) => o.settle_month === r.month) : (r.start ? d.orders.filter((o) => { const t = Date.parse(o.created_at); return t >= r.start.getTime() && t <= r.end.getTime(); }) : d.orders))
    .filter((o) => ['awaiting_cost', 'needs_review', 'check_sheet'].includes(o.status));
  const isNow = !r.month || r.month === currentPeriod();
  const up = fig.profit >= 0;
  const sentence = `${up ? 'The business made' : 'The business is down'} <b class="num">${money(Math.abs(fig.profit), 2)}</b> ${r.month ? `${isNow ? 'so far this pay period' : 'that pay period'}` : state.range === 'today' ? 'from today’s sales' : 'in this time'}.`;
  const half = (v) => Math.round((v * split) / 100 * 100) / 100;

  const profitCard = `<div class="card ov-profit c-8 ${up ? '' : 'loss'}">
    <div class="ov-eyebrow">${ICONS.trends} Profit <span class="muted">· ${esc(when)}</span></div>
    <div class="ov-big num ${up ? 'pos' : 'neg'}">${up ? '' : '−'}${money(Math.abs(fig.profit), 2)}</div>
    <p class="ov-sentence">${sentence} ${count(sales.length)} sale${sales.length === 1 ? '' : 's'}${refundLines ? ` and ${count(refundLines)} refund${refundLines === 1 ? '' : 's'}` : ''}.${waiting.length ? ` <span class="warn-text">${count(waiting.length)} more sale${waiting.length === 1 ? ' isn’t' : 's aren’t'} counted yet (waiting for the Amazon cost).</span>` : ''}</p>
    <div class="ov-sum">
      <div class="ov-line"><span>Money from eBay sales <span class="muted">(after eBay’s fees and refunds)</span></span><b class="num">${money(fig.collected, 2)}</b></div>
      <div class="ov-line"><span>Amazon costs <span class="muted">(what ${esc(A)} paid for the items)</span></span><b class="num">${minus(fig.cogs)}</b></div>
      <div class="ov-line"><span>eBay ad fees <span class="muted">(promoted listings)</span></span><b class="num">${minus(fig.ads)}</b></div>
      ${fig.other ? `<div class="ov-line"><span>Other costs on orders</span><b class="num">${minus(fig.other)}</b></div>` : ''}
      <div class="ov-line"><span>Monthly costs <span class="muted">(subscriptions, tools)</span></span><b class="num">${fig.opex ? minus(fig.opex) : '—'}</b></div>
      <div class="ov-line total"><span>Profit</span><b class="num ${up ? 'pos' : 'neg'}">${up ? '' : '−'}${money(Math.abs(fig.profit), 2)}</b></div>
      <div class="ov-line split"><span>Split ${split}/${100 - split}</span><span class="num">${esc(A)} ${money(half(fig.profit), 2)} · ${esc(B)} ${money(Math.round((fig.profit - half(fig.profit)) * 100) / 100, 2)}</span></div>
    </div>
    ${opexNote ? `<div class="ov-note">${esc(opexNote)}</div>` : ''}
    ${periodSettle?.corrections ? `<div class="ov-note">Not in this profit: ${money(periodSettle.corrections.profit, 2)} for the ${[...new Set(periodSettle.corrections.rows.map((x) => monthLabel(x.correction_for, 'long')))].join(' and ')} payment, which missed it (${periodSettle.corrections.rows.map((x) => esc(String(x.title || '').replace(/^Refund · /, '').slice(0, 40))).join(', ')}). It’s settled on this payment, see Payments.</div>` : ''}
    ${(() => { const later = r.month ? d.orders.filter((o) => o.counted && o.correction_for === r.month) : []; return later.length ? `<div class="ov-note">Found after this payment was made: ${later.map((o) => `${esc(String(o.title || '').replace(/^Refund · /, '').slice(0, 40))} (${money(o.net, 2)})`).join(', ')}. This payment stays as paid; the correction is on the ${[...new Set(later.map((o) => monthLabel(o.settle_month, 'long')))].join(' and ')} payment.</div>` : ''; })()}
  </div>`;

  // ---- what Drew owes Myles: the payment picked, or the one being built now
  const payMonth = r.month || currentPeriod();
  const st = r.month ? periodSettle : settleMonth({ month: payMonth, ...settleArgs });
  const v = settleView(st, A, B);
  const dueDate = settlementDueDate(payMonth, dueDay);
  const due = dueStatus(dueDate, { paid: v.fullyPaid });
  const so = st.own ? { ...st, ...st.own } : st;
  const status = v.nothingDue ? ['', 'Nothing to send'] : v.fullyPaid ? ['good', `Paid in full${st.paidAt ? ` on ${fmtDate(st.paidAt)}` : ''}`]
    : v.paid !== null && v.outstanding > 0 ? [due.kind === 'overdue' ? 'bad' : 'warn', `${money(v.outstanding, 2)} still to send`]
    : v.paid !== null ? ['info', `Overpaid by ${money(-v.outstanding, 2)}`]
    : due.kind === 'overdue' ? ['bad', due.text] : ['warn', `Not paid yet · ${due.text.toLowerCase()}`];
  const owedCard = `<div class="card ov-owed c-4">
    <div class="ov-eyebrow">${ICONS.wallet} ${esc(v.from)} sends ${esc(v.to)}</div>
    <div class="ov-big num">${money(v.amount, 2)}</div>
    <div class="muted" style="font-size:13px">${monthLabel(payMonth, 'long')} payment · due ${fmtDate(dueDate, { weekday: 'short', month: 'short', day: 'numeric' })}</div>
    <div class="ov-status ${status[0]}">${status[0] === 'good' ? ICONS.check : status[0] === 'bad' ? ICONS.alert : ICONS.clock}<span>${status[1]}</span></div>
    <div class="ov-sum">
      <div class="ov-line"><span>${esc(A)}’s Amazon costs back</span><b class="num">${money(so.cogs + (st.opexAmazon || 0), 2)}</b></div>
      <div class="ov-line"><span>${so.shareAmazon < 0 ? 'Less' : 'Plus'} ${esc(A)}’s ${split}% of the profit</span><b class="num">${so.shareAmazon < 0 ? '−' : '+'}${money(Math.abs(so.shareAmazon), 2)}</b></div>
      ${st.corrections ? `<div class="ov-line"><span>Correction for an earlier payment <span class="muted">(${st.corrections.rows.map((x) => esc(String(x.title || '').replace(/^Refund · /, '').slice(0, 28))).join(', ')})</span></span><b class="num">${st.corrections.sellerSends < 0 ? '−' : '+'}${money(Math.abs(st.corrections.sellerSends), 2)}</b></div>` : ''}
      <div class="ov-line total"><span>${esc(v.from)} sends ${esc(v.to)}</span><b class="num">${money(v.amount, 2)}</b></div>
    </div>
    <a class="btn sm" href="#/settlement" style="margin-top:12px">Open Payments ${ICONS.arrow}</a>
  </div>`;

  // ---- needs attention: only what actually needs a look
  const unread = emailFailures(d.email);
  const unmatched = d.amazon?.unmatchedRefunds || [];
  const allWaiting = d.orders.filter((o) => o.status === 'awaiting_cost');
  const review = d.orders.filter((o) => o.status === 'needs_review');
  const openReturns = d.orders.filter((o) => o.counted && o.return_open);
  const items = [
    allWaiting.length && { kind: 'warn', icon: ICONS.mail, t: `${count(allWaiting.length)} sale${allWaiting.length === 1 ? ' is' : 's are'} waiting for the Amazon cost`, s: 'Not counted in profit until the Amazon order is found', href: '#/orders?f=awaiting_cost' },
    review.length && { kind: 'bad', icon: ICONS.alert, t: `${count(review.length)} sale${review.length === 1 ? '' : 's'} held for a check`, s: 'An Amazon email that may have the cost couldn’t be read', href: '#/orders?f=needs_review' },
    unread.length && { kind: 'warn', icon: ICONS.mail, t: `${count(unread.length)} Amazon email${unread.length === 1 ? '' : 's'} couldn’t be read`, s: 'Usually a multi-item or gift-card order. If it isn’t for an eBay sale, dismiss it.', action: 'emails' },
    unmatched.length && { kind: 'bad', icon: ICONS.alert, t: `${count(unmatched.length)} Amazon refund${unmatched.length === 1 ? '' : 's'} not matched to a sale`, s: 'Set it on the right sale in the Editor', href: '#/editor' },
    (d.amazon?.suggestions || 0) && { kind: 'info', icon: ICONS.link, t: `${count(d.amazon.suggestions)} possible match${d.amazon.suggestions === 1 ? '' : 'es'} to confirm`, s: 'Amazon orders that might belong to a sale', href: '#/editor?tab=matches' },
    openReturns.length && { kind: 'info', icon: ICONS.return, t: `${count(openReturns.length)} return${openReturns.length === 1 ? '' : 's'} still open`, s: 'A refund would come off the next payment', href: '#/returns' },
  ].filter(Boolean);
  const attentionCard = `<div class="card ov-attn c-4">
    <div class="card-h"><div><h3>Needs attention</h3></div></div>
    <div class="card-b">${items.length ? `<div class="alert-list">${items.map((x) => `<div class="alert" ${x.href ? `data-href="${x.href}" role="link" tabindex="0"` : ''}><div class="alert-ic ${x.kind}">${x.icon}</div><div style="flex:1"><div class="alert-t">${x.t}</div><div class="alert-s">${x.s}</div>${x.action === 'emails' ? `<div class="ov-mails">${unread.slice(0, 5).map((f) => `<div class="ov-mail"><span>${esc(emailFailureText(f).slice(0, 90))}</span>${f.message_id ? `<button class="btn sm" data-dismiss="${esc(f.message_id)}">Dismiss</button>` : ''}</div>`).join('')}</div>` : ''}</div>${x.href ? ICONS.chevron.replace('<svg', '<svg class="chev"') : ''}</div>`).join('')}</div>`
      : `<div class="ov-allgood">${ICONS.circleCheck}<div><b>All good</b><div class="muted">Every sale has its cost and nothing needs a look.</div></div></div>`}</div>
  </div>`;

  // ---- profit by day (by hour for a single day)
  const gran = state.range === 'today' ? 'hour' : r.start && r.end - r.start > 120 * 86400_000 ? 'month' : !r.start ? 'month' : 'day';
  const chartCard = `<div class="card c-8"><div class="card-h"><div><h3>Profit by ${gran}</h3><div class="sub">From each sale, before monthly costs</div></div></div><div class="card-b"><div class="chart" id="ov-chart"></div></div></div>`;

  // ---- latest sales
  const latest = [...d.orders].filter((o) => isSale(o) && o.source === 'ebay' && !['cancelled', 'before_start'].includes(o.status)).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, 8);
  const recentCard = `<div class="card c-7"><div class="card-h"><div><h3>Latest sales</h3><div class="sub">Click one to see how its profit adds up</div></div><div class="right"><a class="btn sm" href="#/orders">All orders</a></div></div><div class="card-b">
    <table class="simple ov-sales"><tbody>${latest.map((o) => `<tr data-id="${esc(o.order_id)}" style="cursor:pointer"><td style="white-space:nowrap" class="muted">${fmtDate(o.created_at)}</td><td>${esc(String(o.title || '').slice(0, 60))}</td><td>${statusPill(viewStatus(o))}</td><td class="r num ${o.counted && o.net < 0 ? 'neg' : ''}">${o.counted ? money(o.net, 2) : '—'}</td></tr>`).join('')}</tbody></table>
  </div></div>`;

  // ---- promotions: promoted sales (an ad fee) in this time
  const promoted = sales.filter((o) => o.ad_fees > 0);
  const promoProfit = promoted.reduce((t, o) => t + (Number(o.net) || 0), 0);
  const promoCard = `<div class="card c-5"><div class="card-h"><div><h3>Promotions</h3><div class="sub">${esc(when)}</div></div><div class="right"><a class="btn sm" href="#/promotions">Details</a></div></div><div class="card-b">
    <div class="stat-row"><span class="k">Sales from promoted listings</span><span class="v">${count(promoted.length)} of ${count(sales.length)}</span></div>
    <div class="stat-row"><span class="k">Ad fees paid</span><span class="v">${money(fig.ads, 2)}</span></div>
    <div class="stat-row"><span class="k">Profit from promoted sales <span class="muted">(after ad fees)</span></span><span class="v ${promoProfit < 0 ? 'neg' : ''}">${money(promoProfit, 2)}</span></div>
    <div class="stat-row"><span class="k">Ad fees as a share of sales money</span><span class="v">${fig.collected > 0 ? `${((fig.ads / fig.collected) * 100).toFixed(1)}%` : '—'}</span></div>
  </div></div>`;

  // ---- best sellers
  const top = byProduct(rows, d.orders).filter((p) => p.countedRows > 0).sort((a, b) => b.net - a.net).slice(0, 5);
  const topCard = `<div class="card c-5"><div class="card-h"><div><h3>Best sellers</h3><div class="sub">Most profit · ${esc(when)}</div></div></div><div class="card-b">
    ${top.length ? `<table class="simple"><tbody>${top.map((p) => `<tr><td>${esc(String(p.title || '').slice(0, 55))}</td><td class="r muted">${count(p.orders)} sold</td><td class="r num ${p.net < 0 ? 'neg' : ''}">${money(p.net, 2)}</td></tr>`).join('')}</tbody></table>` : '<div class="muted">No sales in this time.</div>'}
  </div></div>`;

  const row1 = [show('profit') && profitCard, show('owed') && owedCard].filter(Boolean);
  const row2 = [show('attention') && attentionCard, show('chart') && chartCard].filter(Boolean);
  const row3 = [show('recent') && recentCard, show('promo') && promoCard, show('top') && topCard].filter(Boolean);
  // Cards switched off leave no gaps: a row with one card takes the full width
  const rowHtml = (cards) => (cards.length ? `<div class="grid g-12 ${cards === row1 ? '' : 'mt'}">${cards.length === 1 ? cards[0].replace(/\bc-(4|5|7|8)\b/, 'c-12') : cards.join('')}</div>` : '');
  el.innerHTML = `${setupBanner()}${rowHtml(row1)}${rowHtml(row2)}${rowHtml(row3)}${!row1.length && !row2.length && !row3.length ? '<div class="card"><div class="empty">Every Overview card is switched off. Turn some back on in <a href="#/settings?focus=dashboard">Settings → Customize dashboard</a>.</div></div>' : ''}`;

  // chart
  const chartEl = $('#ov-chart');
  if (chartEl) {
    const c = colors();
    const bs = buckets(r.month ? { ...r, month: undefined } : r, rows, gran);
    const label = (k) => (gran === 'hour' ? (() => { const h = Number(k.slice(11, 13)); return h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`; })() : gran === 'month' ? monthLabel(k) : fmtDate(k.slice(0, 10), { month: 'short', day: 'numeric' }));
    mount(chartEl, {
      grid: { left: 8, right: 12, top: 16, bottom: 4, containLabel: true },
      tooltip: { ...tooltipBase(), trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(127,127,127,.08)' } },
        formatter: (ps) => { const b = bs[ps[0].dataIndex]; return ttHead(label(b.key)) + ttRow(b.net < 0 ? c.bad : c.profit, 'Profit', money(b.net, 2), true) + `<div style="opacity:.6;margin-top:4px">${count(b.orders)} sale${b.orders === 1 ? '' : 's'}</div>`; } },
      xAxis: { type: 'category', data: bs.map((b) => label(b.key)), ...axisBase({ splitLine: { show: false } }) },
      yAxis: { type: 'value', ...axisBase(), axisLine: { show: false }, axisLabel: { ...axisBase().axisLabel, formatter: (v) => money(v, 0) } },
      series: [{ type: 'bar', barMaxWidth: 26, data: bs.map((b) => ({ value: +b.net.toFixed(2), itemStyle: { color: b.net < 0 ? c.bad : c.profit, borderRadius: b.net < 0 ? [0, 0, 4, 4] : [4, 4, 0, 0] } })) }],
    });
  }
  $$('.ov-sales tr[data-id]', el).forEach((tr) => tr.addEventListener('click', () => openOrder(tr.dataset.id)));
  $$('.alert[data-href]', el).forEach((a) => {
    a.addEventListener('click', (e) => { if (!e.target.closest('button')) location.hash = a.dataset.href; });
    a.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); location.hash = a.dataset.href; } });
  });
  $$('[data-dismiss]', el).forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm('Dismiss this email? Only do this if it isn’t for an eBay sale (a personal order, or one already costed). It stays in the email log.')) return;
    try { await api('/api/email/failed/dismiss', { method: 'POST', body: { message_id: b.dataset.dismiss } }); toast('Dismissed', 'good'); await loadData(); renderPage(); } catch (err) { toast(err.message, 'bad'); }
  }));
}

// Re-exported for the tests: the money of any rows, the way the Overview adds it up
export { moneyOf };
