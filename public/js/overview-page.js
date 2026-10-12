// The Overview: the profit hero (a running-profit chart you can drag across), the partner payment card, then a few
// plain cards (Settings -> Customize dashboard turns each one on or off). A pay period here shows exactly the numbers
// on its statement (Statements) and the Payments page: the same settleMonth() figures, the period's own activity.
import { $, $$, esc, money, moneyShort, pct, count, fmtDate, ICONS, DAY, countUp, settlementDueDate, dueStatus, monthLabel, settleView, azDay } from './util.js';
import { buckets, byProduct, isSale, opexFor, previousRange } from './metrics.js';
import { mount, colors, tooltipBase, axisBase, ttRow, ttHead, sparkline, areaFade } from './charts.js';
import { settleMonth, settlePeriodRange, allMonths } from './settlement.js';
import { showCard } from './dash-prefs.js';
import { state, currentRange, currentPeriod, setupBanner, statusPill, viewStatus, openOrder, switchAccount } from './app.js';
import { reviewItems } from './review-page.js';
import { flowMoney, setMoney } from './flow.js';

const cents = (n) => Math.round((Number(n) || 0) * 100);
// A cost line: minus sign only when there is something to take off
const minus = (v) => (Math.abs(v) >= 0.005 ? `${v > 0 ? '−' : '+'}${money(Math.abs(v), 2)}` : money(0, 2));
const store = (k, v) => { try { if (v === undefined) return JSON.parse(localStorage.getItem(k)); localStorage.setItem(k, JSON.stringify(v)); } catch { return null; } };

// The settlement's money for any set of rows (in dollars), summed in cents like settleMonth()
export function moneyOf(rows) {
  let collected = 0, cogs = 0, ads = 0, other = 0, revenue = 0;
  for (const o of rows) {
    if (!o.counted) continue;
    collected += cents(o.revenue) - cents(o.fees) - cents(o.refunds);
    revenue += cents(o.revenue);
    cogs += cents(o.cost) - cents(o.amazon_refund);
    ads += cents(o.ad_fees);
    other += cents(o.extra_cost);
  }
  return { collected: collected / 100, revenue: revenue / 100, cogs: cogs / 100, ads: ads / 100, other: other / 100, itemProfit: (collected - cogs - ads - other) / 100 };
}

// Rows and money for a time: a pay period is its own activity (corrections for an earlier, already-paid period are
// shown apart); any other time is the rows dated in it, with each pay period's monthly costs by its share of days
function figuresFor(r, d, settleArgs, dueDay, today = false) {
  if (r.month) {
    const st = settleMonth({ month: r.month, ...settleArgs });
    const so = st.own ? { ...st, ...st.own } : st;
    const rows = d.orders.filter((o) => o.counted && o.settle_month === r.month && !o.correction_for);
    const m = moneyOf(rows);
    return { st, rows, fig: { collected: so.collected, revenue: m.revenue, cogs: so.cogs, ads: so.adFees, other: so.otherCosts, itemProfit: so.orderProfit, opex: st.opex, profit: so.businessProfit } };
  }
  const rows = (r.start ? d.orders.filter((o) => { const t = Date.parse(o.created_at); return t >= r.start.getTime() && t <= r.end.getTime(); }) : d.orders).filter((o) => o.counted);
  const m = moneyOf(rows);
  // A single day carries no share of the monthly costs (they come off each pay period as a whole)
  const opex = today ? 0 : opexFor(r, d.books.expenses, { dueDay }).total;
  return { st: null, rows, fig: { ...m, opex, profit: Math.round((m.itemProfit - opex) * 100) / 100 } };
}

const bucketLabel = (k, gran) => {
  if (k.includes('T')) { const h = Number(k.slice(11, 13)); return h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`; }
  if (gran === 'month') return monthLabel(k);
  return fmtDate(k.slice(0, 10), { month: 'short', day: 'numeric' });
};
const granFor = (r, today) => (today || (r.start && r.end - r.start <= 1.5 * DAY) ? 'hour' : !r.start || r.end - r.start > 120 * DAY ? 'month' : 'day');
const plain = (r) => (r.month ? { ...r, month: undefined } : r); // buckets by date across the period's days

function delta(cur, prev) {
  if (prev === null || prev === undefined || !Number.isFinite(prev) || prev === 0) return '';
  const dd = (cur - prev) / Math.abs(prev);
  if (Math.abs(dd) < 0.0005) return '<span class="delta flat">0%</span>';
  return `<span class="delta ${dd > 0 ? 'up' : 'down'}" title="vs the period before">${dd >= 0 ? ICONS.arrowUp : ICONS.arrowDown}${dd >= 0 ? '+' : ''}${(dd * 100).toFixed(1)}%</span>`;
}

export function renderOverview(el) {
  const d = state.data;
  const A = d.settings.partner_amazon;
  const B = d.settings.partner_ebay;
  const split = Number(d.settings.split_amazon ?? 50);
  const dueDay = Number(d.settings.settlement_day) || 26;
  const r = currentRange();
  const today = state.range === 'today';
  const settleArgs = { orders: d.orders, expenses: d.books.expenses, settlements: d.books.settlements, splitAmazon: split };
  const show = (id) => showCard(d.settings, id);

  // ---- this time, and the time before it (to compare)
  const { st: periodSettle, rows, fig } = figuresFor(r, d, settleArgs, dueDay, today);
  const pr = r.start ? previousRange(r) : null;
  const prev = pr ? figuresFor(pr, d, settleArgs, dueDay, today) : null;
  const when = r.month ? (() => { const p = settlePeriodRange(r.month, dueDay); return `${monthLabel(r.month, 'long')} pay period · ${fmtDate(p.from)} – ${fmtDate(p.to)}`; })()
    : today ? `Today, ${fmtDate(azDay())}` : r.start ? `${fmtDate(r.start)} – ${fmtDate(r.end)}` : 'All time';
  const sales = rows.filter(isSale);
  const refundLines = rows.length - sales.length;
  const inTime = (o) => (r.month ? o.settle_month === r.month : !r.start || (Date.parse(o.created_at) >= r.start.getTime() && Date.parse(o.created_at) <= r.end.getTime()));
  const waiting = d.orders.filter((o) => inTime(o) && ['awaiting_cost', 'needs_review', 'check_sheet'].includes(o.status));
  const biz = fig.profit;
  const margin = fig.revenue ? biz / fig.revenue : null;
  const hasPrev = Boolean(prev && prev.rows.length);

  // ---- hero: profit, the running-profit chart, four stats
  const hstat = ({ label, sw, value, foot = '', id = '', deltaHtml = '' }) => `<div class="hstat"><div class="k">${sw ? `<span class="sw" style="background:var(${sw})"></span>` : ''}${esc(label)}</div><div class="v num">${value}</div><div class="f">${deltaHtml}<span>${foot}</span></div>${id ? `<div class="mini" id="${id}"></div>` : ''}</div>`;
  const notes = [
    today ? 'Monthly costs aren’t taken off a single day; they come off each pay period as a whole.' : '',
    !r.month && r.start && !today ? 'Monthly costs are counted by the share of each pay period these dates cover.' : '',
    periodSettle?.corrections ? `Not in this profit: ${money(periodSettle.corrections.profit, 2)} for the ${[...new Set(periodSettle.corrections.rows.map((x) => monthLabel(x.correction_for, 'long')))].join(' and ')} payment, which missed it (${periodSettle.corrections.rows.map((x) => esc(String(x.title || '').replace(/^Refund · /, '').slice(0, 40))).join(', ')}). It’s settled on this payment.` : '',
    (() => { const later = r.month ? d.orders.filter((o) => o.counted && o.correction_for === r.month) : []; return later.length ? `Found after this payment was made: ${later.map((o) => `${esc(String(o.title || '').replace(/^Refund · /, '').slice(0, 40))} (${money(o.net, 2)})`).join(', ')}. This payment stays as paid; the correction is on the ${[...new Set(later.map((o) => monthLabel(o.settle_month, 'long')))].join(' and ')} payment.` : ''; })(),
    waiting.length ? `<span class="warn-text">${count(waiting.length)} sale${waiting.length === 1 ? ' isn’t' : 's aren’t'} counted yet (waiting for the Amazon cost).</span> <a href="#/review">Review</a>` : '',
  ].filter(Boolean);
  const hero = `<div class="card hero c-8 ${biz < 0 ? 'loss' : ''}">
    <div class="hero-top">
      <span class="hero-eyebrow"><span class="sw" style="background:var(${biz < 0 ? '--bad' : '--s-profit'})"></span>Profit</span>
      <span class="muted" style="font-size:12px">${esc(when)}</span>
      ${hasPrev ? delta(biz, prev.fig.profit) : ''}
      ${r.start ? `<button class="chip-toggle ${state.compare ? 'on' : ''}" id="hero-compare" type="button" aria-pressed="${Boolean(state.compare)}" title="Show the period before as a dashed line">${ICONS.history} Compare</button>` : ''}
    </div>
    <div class="hero-value num ${biz < 0 ? 'neg' : ''}" id="hero-value">${money(biz, 2)}</div>
    <div class="hero-meta">
      <span>Profit from sales <b>${money(fig.itemProfit, 2)}</b></span>
      <span>− monthly costs <b>${money(fig.opex, 2)}</b></span>
      <span><b>${count(sales.length)}</b> sale${sales.length === 1 ? '' : 's'}${refundLines ? ` + ${count(refundLines)} refund${refundLines === 1 ? '' : 's'}` : ''}</span>
    </div>
    ${notes.map((n) => `<div class="ov-note">${n}</div>`).join('')}
    <div class="scrub-at" id="hero-at" aria-live="polite">Drag across the chart to see the running profit</div>
    <div class="spark scrub" id="hero-spark"></div>
    <div class="hero-stats">
      ${hstat({ label: 'Sales money', sw: '--s-revenue', value: moneyShort(fig.revenue), foot: 'buyers paid, before fees', id: 'k-rev', deltaHtml: hasPrev ? delta(fig.revenue, prev.fig.revenue) : '' })}
      ${hstat({ label: 'Sales', value: count(sales.length), foot: refundLines ? `${count(refundLines)} refund${refundLines === 1 ? '' : 's'}` : 'orders', id: 'k-ord', deltaHtml: hasPrev ? delta(sales.length, prev.rows.filter(isSale).length) : '' })}
      ${hstat({ label: 'Amazon costs', sw: '--s-cost', value: moneyShort(fig.cogs), foot: `${esc(A)} paid` })}
      ${hstat({ label: 'Profit margin', value: pct(margin), foot: 'profit ÷ sales money' })}
    </div>
  </div>`;

  // ---- partner payment: the one picked, or the one being built now
  const payMonth = r.month || currentPeriod();
  const cardSettle = r.month ? periodSettle : settleMonth({ month: payMonth, ...settleArgs });
  const view = (x) => settleView(x, A, B);
  const cv = view(cardSettle);
  const cardDue = dueStatus(settlementDueDate(payMonth, dueDay), { paid: cv.fullyPaid });
  const so = cardSettle.own ? { ...cardSettle, ...cardSettle.own } : cardSettle;
  const settleStatus = (() => {
    if (cv.paid === null) {
      if (cv.nothingDue) return { cls: '', icon: ICONS.info, t: 'Nothing to send', s: 'No amount due for this payment yet' };
      if (cardDue.kind === 'overdue') return { cls: 'bad', icon: ICONS.alert, t: cardDue.text, s: `${esc(cv.from)} sends ${esc(cv.to)} · was due ${cardDue.label}` };
      return { cls: 'warn', icon: ICONS.clock, t: cardDue.kind === 'soon' ? cardDue.text : 'Not paid yet', s: `${esc(cv.from)} sends by ${cardDue.label}` };
    }
    if (cv.fullyPaid) return { cls: 'good', icon: ICONS.check, t: 'Paid in full', s: cardSettle.paidAt ? `on ${fmtDate(cardSettle.paidAt)}` : '' };
    if (cv.outstanding > 0) return { cls: cardDue.kind === 'overdue' ? 'bad' : 'warn', icon: ICONS.clock, t: `${money(cv.outstanding, 2)} still owed`, s: `${money(cv.paid, 2)} paid so far · ${cardDue.text.toLowerCase()}` };
    return { cls: 'info', icon: ICONS.info, t: `Overpaid by ${money(-cv.outstanding, 2)}`, s: `${money(cv.paid, 2)} paid by ${esc(cv.from)}` };
  })();
  const stateLabel = settleStatus.cls === 'good' ? 'Settled' : settleStatus.cls === 'bad' ? 'Overdue' : settleStatus.cls === 'warn' ? (cv.paid !== null ? 'Partly paid' : 'Due') : settleStatus.cls === 'info' ? 'Overpaid' : 'Nothing due';
  const stateIcon = settleStatus.cls === 'good' ? ICONS.circleCheck : settleStatus.cls === 'bad' ? ICONS.alert : settleStatus.cls === 'warn' ? ICONS.clock : settleStatus.cls === 'info' ? ICONS.info : ICONS.minus;
  const stateSide = (() => {
    if (cv.nothingDue || cv.settled || cardDue.kind === 'paid') return '';
    const n = cardDue.days;
    if (n < 0) return `<div class="side"><div class="big num">${-n}</div><div class="sm">${-n === 1 ? 'day' : 'days'} overdue</div></div>`;
    if (n === 0) return '<div class="side"><div class="big">Today</div><div class="sm">due date</div></div>';
    return `<div class="side"><div class="big num">${n}</div><div class="sm">${n === 1 ? 'day' : 'days'} left</div></div>`;
  })();
  const avatar = (name) => `<span class="avatar ${name === A ? '' : 'b'}" aria-hidden="true">${esc(String(name || '?').trim().charAt(0).toUpperCase())}</span>`;
  const allSettled = allMonths(d.orders, d.books.expenses).map((m) => settleMonth({ month: m, ...settleArgs }));
  const owedAll = Math.round(allSettled.reduce((t, x) => t + view(x).signedOwed, 0) * 100) / 100;
  const settleCard = `<div class="card settle-card c-4">
    <div class="settle-head"><span class="eyebrow">${ICONS.wallet} Partner settlement</span><span class="pill">${ICONS.calendar} ${monthLabel(payMonth, 'long')}</span></div>
    <div class="settle-who">${avatar(cv.from)}<b>${esc(cv.from)}</b><span class="muted">sends</span>${ICONS.arrowRight.replace('<svg', '<svg class="arrow"')}${avatar(cv.to)}<b>${esc(cv.to)}</b></div>
    <div class="settle-amt num" id="settle-value">${money(cv.amount, 2)}</div>
    <div class="settle-math"><span>Amazon costs back <b>${money(so.cogs + (cardSettle.opexAmazon || 0), 2)}</b></span><span>${so.shareAmazon < 0 ? '−' : '+'} ${esc(A)}’s half <b>${money(Math.abs(so.shareAmazon), 2)}</b></span>${cardSettle.corrections ? `<span>${cardSettle.corrections.sellerSends < 0 ? '−' : '+'} correction <b>${money(Math.abs(cardSettle.corrections.sellerSends), 2)}</b></span>` : ''}</div>
    <div class="settle-hint">${r.month ? 'The pay period picked above' : `This pay period so far (${(() => { const p = settlePeriodRange(payMonth, dueDay); return `${fmtDate(p.from)} – ${fmtDate(p.to)}`; })()})`}</div>
    <div class="state ${settleStatus.cls}" role="status">
      <div class="ic">${stateIcon}</div>
      <div><div class="lbl"><span class="live"></span>${stateLabel}</div><div class="t">${settleStatus.t}</div><div class="s">${settleStatus.s}</div></div>
      ${stateSide}
    </div>
    <div class="settle-track-h"><span>Pay period by pay period</span><span>${allSettled.length > 6 ? `latest 6 of ${allSettled.length}` : ''}</span></div>
    <div class="settle-track" role="list">${[...allSettled].reverse().slice(0, 6).map((x) => {
      const xv = view(x);
      const dd = dueStatus(settlementDueDate(x.month, dueDay));
      const badge = xv.settled ? `<span class="pill good">${ICONS.check} Settled</span>` : dd.kind === 'overdue' ? `<span class="pill bad">${ICONS.alert} Overdue</span>` : `<span class="pill warn">${ICONS.clock} Due ${fmtDate(settlementDueDate(x.month, dueDay))}</span>`;
      return `<a class="settle-row ${xv.settled ? 'ok' : dd.kind}${x.month === payMonth ? ' sel' : ''}" role="listitem" href="#/settlement"><span class="m">${monthLabel(x.month)}</span><span class="amt num">${xv.reverse ? `<span class="dir">${esc(xv.from)} → ${esc(xv.to)}</span>` : ''}${money(xv.amount, 2)}</span>${badge}</a>`;
    }).join('')}</div>
    <div class="stat-row" style="margin-top:10px"><span class="k">Owed across all payments</span><span class="v ${Math.abs(owedAll) > 0.009 ? 'neg' : 'pos'}">${owedAll > 0.009 ? `${esc(B)} owes ${esc(A)} ${money(owedAll, 2)}` : owedAll < -0.009 ? `${esc(A)} owes ${esc(B)} ${money(-owedAll, 2)}` : 'All settled'}</span></div>
    <div style="margin-top:12px"><a class="btn sm" href="#/settlement">Open settlement ${ICONS.arrow}</a></div>
  </div>`;

  // ENTIRE BUSINESS: each account settles on its own, so the card lists each account's payment and adds them up
  const combinedCard = d.combined ? (() => {
    const per = d.byAccount.map((a) => {
      const st = settleMonth({ month: payMonth, orders: d.orders.filter((o) => o.account === a.id), expenses: a.books.expenses, settlements: a.books.settlements, splitAmazon: Number(a.settings.split_amazon ?? 50) });
      const v = view(st);
      const due = dueStatus(settlementDueDate(payMonth, dueDay), { paid: v.fullyPaid });
      const pill = v.nothingDue ? '<span class="pill">Nothing due</span>' : v.fullyPaid ? `<span class="pill good">${ICONS.check} Paid</span>` : due.kind === 'overdue' ? `<span class="pill bad">${ICONS.alert} Overdue</span>` : `<span class="pill warn">${ICONS.clock} ${esc(due.text)}</span>`;
      return { a, v, pill, signed: v.reverse ? -v.amount : v.amount };
    });
    const total = Math.round(per.reduce((t, x) => t + x.signed, 0) * 100) / 100;
    return `<div class="card settle-card c-4">
      <div class="settle-head"><span class="eyebrow">${ICONS.wallet} Partner settlement</span><span class="pill">${ICONS.calendar} ${monthLabel(payMonth, 'long')}</span></div>
      <div class="settle-amt num" id="settle-value">${money(Math.abs(total), 2)}</div>
      <div class="settle-hint">${total < 0 ? `${esc(A)} sends ${esc(B)}` : `${esc(B)} sends ${esc(A)}`} across every account · each account is paid on its own</div>
      <div class="settle-track" role="list">${per.map((x) => `<a class="settle-row" role="listitem" href="#/settlement" data-acct-go="${esc(x.a.id)}"><span class="m">${esc(x.a.name)}</span><span class="amt num">${x.v.reverse ? `<span class="dir">${esc(x.v.from)} → ${esc(x.v.to)}</span>` : ''}${money(x.v.amount, 2)}</span>${x.pill}</a>`).join('')}</div>
    </div>`;
  })() : null;

  // ---- how the profit adds up, in plain words
  const half = Math.round(((biz * split) / 100) * 100) / 100;
  const addsUp = `<div class="card c-4"><div class="card-h"><div><h3>How the profit adds up</h3><div class="sub">${esc(when)}</div></div></div><div class="card-b"><div class="ov-sum" style="border-top:0;margin-top:0">
    <div class="ov-line"><span>Money from eBay sales <span class="muted">(after eBay fees and refunds)</span></span><b class="num">${money(fig.collected, 2)}</b></div>
    <div class="ov-line"><span>Amazon costs</span><b class="num">${minus(fig.cogs)}</b></div>
    <div class="ov-line"><span>eBay ad fees</span><b class="num">${minus(fig.ads)}</b></div>
    ${fig.other ? `<div class="ov-line"><span>Other costs on orders</span><b class="num">${minus(fig.other)}</b></div>` : ''}
    <div class="ov-line"><span>Monthly costs</span><b class="num">${fig.opex ? minus(fig.opex) : '—'}</b></div>
    <div class="ov-line total"><span>Profit</span><b class="num ${biz < 0 ? 'neg' : 'pos'}">${money(biz, 2)}</b></div>
    <div class="ov-line split"><span>Split ${split}/${100 - split}</span><span class="num">${esc(A)} ${money(half, 2)} · ${esc(B)} ${money(Math.round((biz - half) * 100) / 100, 2)}</span></div>
  </div></div></div>`;

  // ---- needs attention: a short summary of the Review page
  const X = reviewItems(d).sections;
  const chargesTodo = X.charges.filter((c) => !c.reviewed && !c.cost).length;
  const lines = [
    X.waiting.length && `${count(X.waiting.length)} sale${X.waiting.length === 1 ? '' : 's'} waiting for the Amazon cost`,
    X.held.length && `${count(X.held.length)} sale${X.held.length === 1 ? '' : 's'} held for a check`,
    X.emails.length && `${count(X.emails.length)} Amazon email${X.emails.length === 1 ? '' : 's'} to look at`,
    X.refunds.length && `${count(X.refunds.length)} Amazon refund${X.refunds.length === 1 ? '' : 's'} not matched`,
    X.holds.length && `${count(X.holds.length)} return hold${X.holds.length === 1 ? '' : 's'} over 30 days`,
    chargesTodo && `${count(chargesTodo)} eBay charge${chargesTodo === 1 ? '' : 's'} with no order`,
  ].filter(Boolean);
  const attention = `<div class="card ov-attn c-4"><div class="card-h"><div><h3>Needs attention</h3></div></div><div class="card-b">${lines.length
    ? `<ul class="ov-todo">${lines.map((l) => `<li>${l}</li>`).join('')}</ul><a class="btn sm primary" href="#/review" style="margin-top:12px">Open Review ${ICONS.arrow}</a>`
    : `<div class="ov-allgood">${ICONS.circleCheck}<div><b>All good</b><div class="muted">Every sale has its cost and nothing needs a look.</div></div></div>`}</div></div>`;

  // ---- promotions: promoted sales (an ad fee) in this time
  const promoted = sales.filter((o) => o.ad_fees > 0);
  const promoProfit = promoted.reduce((t, o) => t + (Number(o.net) || 0), 0);
  const promo = `<div class="card c-4"><div class="card-h"><div><h3>Promotions</h3><div class="sub">${esc(when)}</div></div><div class="right"><a class="btn sm" href="#/promotions">Details</a></div></div><div class="card-b">
    <div class="stat-row"><span class="k">Sales from promoted listings</span><span class="v">${count(promoted.length)} of ${count(sales.length)}</span></div>
    <div class="stat-row"><span class="k">Ad fees paid</span><span class="v">${money(fig.ads, 2)}</span></div>
    <div class="stat-row"><span class="k">Profit from promoted sales</span><span class="v ${promoProfit < 0 ? 'neg' : ''}">${money(promoProfit, 2)}</span></div>
    <div class="stat-row"><span class="k">Ad fees ÷ sales money</span><span class="v">${fig.revenue > 0 ? pct(fig.ads / fig.revenue) : '—'}</span></div>
  </div></div>`;

  // ---- profit by day (by hour for today, by month for long times)
  const gran = granFor(r, today);
  const chartCard = `<div class="card c-7"><div class="card-h"><div><h3>Profit by ${gran}</h3><div class="sub">From each sale, before monthly costs</div></div></div><div class="card-b"><div class="chart" id="ov-chart"></div></div></div>`;

  // ---- latest sales
  const latest = [...d.orders].filter((o) => isSale(o) && o.source === 'ebay' && !['cancelled', 'before_start'].includes(o.status)).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, 8);
  const recent = `<div class="card c-5"><div class="card-h"><div><h3>Latest sales</h3><div class="sub">Click one to see how it adds up</div></div><div class="right"><a class="btn sm" href="#/orders">All orders</a></div></div><div class="card-b">
    <table class="simple ov-sales"><tbody>${latest.map((o) => `<tr data-id="${esc(o.order_id)}"><td style="white-space:nowrap" class="muted">${fmtDate(o.created_at)}</td><td>${esc(String(o.title || '').slice(0, 46))}${o.units > 1 ? ` <span class="muted">×${count(o.units)}</span>` : ''}</td><td class="r num ${o.counted && o.net < 0 ? 'neg' : ''}">${o.counted ? money(o.net, 2) : statusPill(viewStatus(o))}</td></tr>`).join('')}</tbody></table>
  </div></div>`;

  // ---- best sellers
  const top = byProduct(rows, d.orders).filter((p) => p.countedRows > 0).sort((a, b) => b.net - a.net).slice(0, 5);
  const topCard = `<div class="card c-12"><div class="card-h"><div><h3>Best sellers</h3><div class="sub">Most profit · ${esc(when)}</div></div></div><div class="card-b">
    ${top.length ? `<table class="simple"><tbody>${top.map((p) => `<tr><td>${esc(String(p.title || '').slice(0, 70))}</td><td class="r muted">${count(p.orders)} sold</td><td class="r num ${p.net < 0 ? 'neg' : ''}">${money(p.net, 2)}</td></tr>`).join('')}</tbody></table>` : '<div class="muted">No sales in this time.</div>'}
  </div></div>`;

  // Cards switched off leave no gaps: a lone card takes the full width, two cards in a row of three share it
  const rowHtml = (cards, first) => {
    if (!cards.length) return '';
    let list = cards;
    if (cards.length === 1) list = [cards[0].replace(/\bc-(4|5|7|8)\b/, 'c-12')];
    else if (cards.length === 2 && cards.every((x) => /\bc-4\b/.test(x))) list = cards.map((x) => x.replace(/\bc-4\b/, 'c-6'));
    return `<div class="grid g-12 ${first ? '' : 'mt'}">${list.join('')}</div>`;
  };
  const row1 = [show('profit') && hero, show('owed') && (combinedCard || settleCard)].filter(Boolean);
  const row2 = [show('attention') && attention, show('breakdown') && addsUp, show('promo') && promo].filter(Boolean);
  const row3 = [show('chart') && chartCard, show('recent') && recent].filter(Boolean);
  const row4 = [show('top') && topCard].filter(Boolean);
  const any = row1.length + row2.length + row3.length + row4.length;
  el.innerHTML = `${setupBanner()}${rowHtml(row1, true)}${rowHtml(row2, !row1.length)}${rowHtml(row3)}${rowHtml(row4)}${any ? '' : '<div class="card"><div class="empty">Every Overview card is switched off. Turn some back on in <a href="#/settings?focus=dashboard">Settings → Customize dashboard</a>.</div></div>'}`;

  const c = colors();
  if ($('#hero-value')) {
    flowMoney($('#hero-value'), biz);
    heroScrub({ r, rows, fig, prev, today, c });
    $('#hero-compare')?.addEventListener('click', () => { state.compare = !state.compare; store('dd_compare', state.compare); $('#hero-compare').classList.toggle('on', state.compare); heroScrub({ r, rows, fig, prev, today, c }); });
    const bsSpark = buckets(plain(r), rows, granFor(r, today));
    sparkline($('#k-rev'), bsSpark.map((b) => b.revenueAll), c.revenue);
    sparkline($('#k-ord'), bsSpark.map((b) => b.orders), c.accent);
  }
  if ($('#settle-value')) flowMoney($('#settle-value'), d.combined ? Number(String($('#settle-value').textContent).replace(/[^0-9.-]/g, '')) || 0 : cv.amount);

  const chartEl = $('#ov-chart');
  if (chartEl) {
    const bs = buckets(plain(r), rows, gran);
    mount(chartEl, {
      grid: { left: 8, right: 12, top: 16, bottom: 4, containLabel: true },
      tooltip: { ...tooltipBase(), trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(127,127,127,.08)' } },
        formatter: (ps) => { const b = bs[ps[0].dataIndex]; return ttHead(bucketLabel(b.key, gran)) + ttRow(b.net < 0 ? c.bad : c.profit, 'Profit', money(b.net, 2), true) + `<div style="opacity:.6;margin-top:4px">${count(b.orders)} sale${b.orders === 1 ? '' : 's'}</div>`; } },
      xAxis: { type: 'category', data: bs.map((b) => bucketLabel(b.key, gran)), ...axisBase({ splitLine: { show: false } }) },
      yAxis: { type: 'value', ...axisBase(), axisLine: { show: false }, axisLabel: { ...axisBase().axisLabel, formatter: (v) => money(v, 0) } },
      series: [{ type: 'bar', barMaxWidth: 26, data: bs.map((b) => ({ value: +b.net.toFixed(2), itemStyle: { color: b.net < 0 ? c.bad : c.profit, borderRadius: b.net < 0 ? [0, 0, 4, 4] : [4, 4, 0, 0] } })) }],
    });
  }
  $$('.ov-sales tr[data-id]', el).forEach((tr) => tr.addEventListener('click', () => openOrder(tr.dataset.id)));
  $$('[data-acct-go]', el).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); location.hash = '#/settlement'; switchAccount(a.dataset.acctGo); }));
}

// Robinhood-style running profit: the line is the running total over the time picked; drag or hover across it and the
// headline shows the total up to that point. Monthly costs are spread evenly across the time, so the last point always
// equals the headline. With Compare on, a dashed line shows the time before.
function heroScrub({ r, rows, fig, prev, today, c }) {
  const el = $('#hero-spark');
  if (!el) return;
  const g = granFor(r, today);
  const run = (bs, total, opex) => {
    let acc = 0;
    const out = bs.map((b, i) => { acc += b.net; return Math.round((acc - (opex * (i + 1)) / bs.length) * 100) / 100; });
    if (out.length) out[out.length - 1] = Math.round((total - opex) * 100) / 100; // the last point is the headline
    return out;
  };
  const bs = buckets(plain(r), rows, g);
  const cur = run(bs, fig.itemProfit, fig.opex);
  const labels = bs.map((b) => (g === 'hour' ? `${fmtDate(r.start)} · ${bucketLabel(b.key, g)}` : bucketLabel(b.key, g)));
  const pr = r.start ? previousRange(r) : null;
  const cmp = state.compare && prev && pr ? { run: run(buckets(plain(pr), prev.rows, g).slice(-bs.length), prev.fig.itemProfit, prev.fig.opex) } : null;
  const biz = fig.profit;
  const col = biz >= 0 ? c.profit : c.bad;
  const chart = mount(el, {
    grid: { left: 0, right: 0, top: 10, bottom: 2 },
    xAxis: { type: 'category', show: false, boundaryGap: false, data: labels },
    yAxis: { type: 'value', show: false, scale: true },
    tooltip: { trigger: 'axis', showContent: false, triggerOn: 'mousemove|click', axisPointer: { type: 'line', snap: true, lineStyle: { color: c.ink3, width: 1 }, label: { show: false } } },
    series: [
      ...(cmp ? [{ type: 'line', data: cmp.run, smooth: 0.25, symbol: 'none', silent: true, z: 1, lineStyle: { width: 1.25, type: [4, 4], color: c.ink4 } }] : []),
      { type: 'line', data: cur, smooth: 0.25, symbol: 'circle', symbolSize: 8, showSymbol: false, z: 3,
        lineStyle: { width: 2, color: col, cap: 'round', join: 'round' }, itemStyle: { color: col, borderColor: c.surface, borderWidth: 2 },
        emphasis: { scale: 1.4 }, areaStyle: { color: areaFade(col, 0.22) },
        markLine: { silent: true, symbol: 'none', label: { show: false }, lineStyle: { color: c.ink4, type: [2, 4], width: 1 }, data: [{ yAxis: 0 }] } },
    ],
  });
  const val = $('#hero-value');
  const at = $('#hero-at');
  const idle = () => {
    setMoney(val, biz);
    val.classList.toggle('neg', biz < 0);
    at.innerHTML = cmp ? `<span class="k-dash"></span>The time before ended at <b>${money(cmp.run.at(-1) ?? 0, 2)}</b> · drag to compare` : 'Drag across the chart to see the running profit';
    at.classList.remove('on');
  };
  idle();
  if (!chart) return;
  chart.on('updateAxisPointer', (e) => {
    const i = e.axesInfo?.[0]?.value;
    if (i === undefined || i === null || cur[i] === undefined) return;
    const v = cur[i];
    const day = bs[i].net;
    setMoney(val, v);
    val.classList.toggle('neg', v < 0);
    const vs = cmp && cmp.run[i] !== undefined ? ` · <span class="k-dash"></span>same point before ${money(cmp.run[i], 2)}` : '';
    at.innerHTML = `<b>${esc(labels[i])}</b> · ${day >= 0 ? '+' : '−'}${money(Math.abs(day), 2)} from sales ${g === 'hour' ? 'that hour' : g === 'month' ? 'that month' : 'that day'} · ${count(bs[i].countedOrders)} sales${vs}`;
    at.classList.add('on');
  });
  chart.getZr().on('globalout', idle);
  el.addEventListener('touchend', () => setTimeout(idle, 1200), { passive: true });
}
