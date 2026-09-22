import { $, $$, esc, money, moneyShort, pct, count, signed, fmtDate, fmtDateTime, ago, api, toast, downloadCsv, ICONS, DAY, ymd } from './util.js';
import { rangeFor, previousRange, inRange, summarize, buckets, autoGran, byProduct, groupBy, STATUS_META, bucketKey, opexFor } from './metrics.js';
import { mount, disposeAll, colors, tooltipBase, axisBase, ttRow, ttHead, sparkline } from './charts.js';
import { renderEditor } from './editor.js';
import { renderSettlement } from './settle-page.js';
import { settleMonth, monthKey } from './settlement.js';

// ---------------------------------------------------------------- state
const store = (k, v) => { try { if (v === undefined) return JSON.parse(localStorage.getItem(k)); localStorage.setItem(k, JSON.stringify(v)); } catch { return null; } };
export const state = {
  data: null,
  range: store('dd_range') || '30d',
  custom: store('dd_custom') || { from: ymd(Date.now() - 29 * DAY), to: ymd(Date.now()) },
  gran: null,
  page: 'overview',
  ordersFilter: 'all',
};
const tables = new Set();
export const trackTable = (t) => { tables.add(t); return t; };

const PAGES = [
  { id: 'overview', label: 'Overview', icon: 'overview', sub: 'Profit at a glance' },
  { id: 'trends', label: 'Analytics', icon: 'trends', sub: 'Patterns, timing, pricing and geography' },
  { id: 'products', label: 'Products', icon: 'products', sub: 'What sells, what earns, what bleeds' },
  { id: 'orders', label: 'Orders', icon: 'orders', sub: 'Every eBay sale with its full profit math' },
  { id: 'returns', label: 'Returns', icon: 'returns', sub: 'Refunds, reasons and recovery' },
  { id: 'settlement', label: 'Settlement', icon: 'settle', sub: 'Monthly partner settlement', noRange: true },
  { id: 'editor', label: 'Editor', icon: 'editor', sub: 'Spreadsheet mode: manual adjustments and matching', noRange: true },
  { id: 'import', label: 'Amazon import', icon: 'import', sub: 'Weekly CSV upload', noRange: true },
  { id: 'settings', label: 'Settings', icon: 'settings', sub: 'eBay connection, matching rules, goals', noRange: true },
];

// ---------------------------------------------------------------- data
export async function loadData() {
  state.data = await api('/api/data');
  renderSidebarFoot();
  renderNav();
  return state.data;
}

const range = () => rangeFor(state.range, state.custom);
const scoped = () => inRange(state.data.orders, range());
const prevScoped = () => inRange(state.data.orders, previousRange(range()));

// ---------------------------------------------------------------- shell
function renderNav() {
  const d = state.data;
  const badges = {
    editor: d?.amazon?.suggestions || 0,
    orders: d ? d.orders.filter((o) => o.status === 'awaiting_cost').length : 0,
  };
  $('#nav').innerHTML =
    `<div class="nav-label">Dashboard</div>` +
    PAGES.slice(0, 6).map(navLink).join('') +
    `<div class="nav-label">Data</div>` +
    PAGES.slice(6).map(navLink).join('');
  function navLink(p) {
    const b = p.id === 'editor' && badges.editor ? `<span class="badge" title="Suggested matches to review">${badges.editor}</span>` : '';
    return `<a href="#/${p.id}" class="${state.page === p.id ? 'active' : ''}">${ICONS[p.icon]}<span>${p.label}</span>${b}</a>`;
  }
}

function renderSidebarFoot() {
  const e = state.data?.ebay;
  if (!e) return;
  let dot = 'warn';
  let line = 'eBay not connected';
  if (e.running) { dot = 'spin'; line = 'Syncing eBay…'; }
  else if (e.configured && e.last?.ok) { dot = 'ok'; line = `eBay synced ${ago(e.lastSuccess)}`; }
  else if (e.configured && e.last && !e.last.ok) { dot = 'bad'; line = 'eBay sync failed'; }
  else if (e.configured) { dot = 'warn'; line = 'eBay: waiting for first sync'; }
  const az = state.data.amazon;
  $('#sidebar-foot').innerHTML = `
    <div class="sync-row"><span class="dot ${dot}"></span><b style="font-weight:600">${line}</b></div>
    <div class="sync-row" style="margin-top:6px"><span class="dot ${emailDot()}"></span><span>${emailLine()}</span></div>
    <div class="muted" style="margin-top:6px">Amazon: ${count(az.linked)} of ${count(az.orders)} orders linked${az.latest ? ` · latest ${fmtDate(az.latest)}` : ''}</div>
    <div class="muted" style="margin-top:2px">${state.data.db === 'local-postgres' ? 'Local database' : 'Supabase Postgres'}</div>`;
}

function emailDot() {
  const m = state.data.email;
  if (!m.configured) return 'warn';
  if (m.running) return 'spin';
  return m.last?.ok ? 'ok' : m.last ? 'bad' : 'warn';
}
function emailLine() {
  const m = state.data.email;
  if (!m.configured) return 'Email not connected';
  if (m.running) return 'Checking email…';
  return m.last?.ok ? `Email checked ${ago(m.last.at)}` : m.last ? 'Email check failed' : 'Email: not checked yet';
}

const RANGES = [['7d', '7D'], ['30d', '30D'], ['90d', '90D'], ['mtd', 'MTD'], ['ytd', 'YTD'], ['12m', '12M'], ['all', 'All'], ['custom', 'Custom']];
function renderRangeSeg() {
  $('#range-seg').innerHTML = RANGES.map(([k, l]) => `<button data-r="${k}" class="${state.range === k ? 'on' : ''}">${l}</button>`).join('');
  $('#custom-range').classList.toggle('hidden', state.range !== 'custom');
  $('#from-date').value = state.custom.from;
  $('#to-date').value = state.custom.to;
}
$('#range-seg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.range = b.dataset.r;
  store('dd_range', state.range);
  renderRangeSeg();
  renderPage();
});
for (const id of ['#from-date', '#to-date'])
  $(id).addEventListener('change', () => {
    state.custom = { from: $('#from-date').value, to: $('#to-date').value };
    store('dd_custom', state.custom);
    renderPage();
  });

function setThemeIcon() {
  const dark = (document.documentElement.dataset.theme || 'dark') === 'dark';
  $('#theme-btn').innerHTML = dark ? ICONS.sun : ICONS.moon;
}
$('#theme-btn').addEventListener('click', () => {
  const next = (document.documentElement.dataset.theme || 'dark') === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('dd_theme', next); } catch {}
  setThemeIcon();
  renderPage();
});
if (!document.documentElement.dataset.theme) document.documentElement.dataset.theme = 'dark';
setThemeIcon();

$('#sync-btn').addEventListener('click', async () => {
  const btn = $('#sync-btn');
  const d = state.data;
  if (!d?.ebay?.configured && !d?.email?.configured) {
    toast('Nothing to sync yet. Connect eBay and your email in Settings.', 'bad');
    location.hash = '#/settings';
    return;
  }
  btn.disabled = true;
  btn.querySelector('span').textContent = 'Syncing…';
  try {
    if (d.ebay.configured) {
      const r = await api('/api/sync', { method: 'POST' });
      toast(r.ok ? `eBay: ${r.log.join(' · ')}` : `eBay sync failed: ${r.log.at(-1)}`, r.ok ? 'good' : 'bad');
    }
    if (d.email.configured) {
      const r = await api('/api/email/sync', { method: 'POST' });
      toast(r.ok ? `Email: ${r.log.join(' · ')}` : `Email sync failed: ${r.log.at(-1)}`, r.ok ? 'good' : 'bad');
    }
    await loadData();
    renderPage();
  } catch (e) { toast(e.message, 'bad'); }
  btn.disabled = false;
  btn.querySelector('span').textContent = 'Sync';
});

$('#menu-btn').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
$('#nav').addEventListener('click', () => $('#sidebar').classList.remove('open'));

window.addEventListener('hashchange', route);
function route() {
  const id = (location.hash.replace('#/', '') || 'overview').split('?')[0];
  state.page = PAGES.some((p) => p.id === id) ? id : 'overview';
  renderNav();
  renderPage();
}

export function renderPage() {
  disposeAll();
  for (const t of tables) { try { t.destroy(); } catch {} }
  tables.clear();
  const p = PAGES.find((x) => x.id === state.page);
  $('#page-title').textContent = p.label;
  const r = range();
  $('#page-sub').textContent = p.noRange ? p.sub : `${p.sub} · ${r.start ? `${fmtDate(r.start)} – ${fmtDate(r.end)}` : 'All time'}`;
  $('#range-seg').parentElement.querySelector('.seg').classList.toggle('hidden', Boolean(p.noRange));
  $('#custom-range').classList.toggle('hidden', Boolean(p.noRange) || state.range !== 'custom');
  const el = $('#content');
  el.scrollTop = 0;
  if (!state.data) { el.innerHTML = skeleton(); return; }
  const fn = { overview, trends, products, orders, returns, settlement: renderSettlement, editor: renderEditor, import: importPage, settings }[p.id];
  fn(el);
}

const skeleton = () => `<div class="grid g-12">${'<div class="c-3 skeleton" style="height:120px"></div>'.repeat(4)}<div class="c-12 skeleton" style="height:360px"></div></div>`;

// ---------------------------------------------------------------- shared bits
function delta(cur, prev, { invert = false, isPct = false } = {}) {
  if (prev === null || prev === undefined || cur === null || cur === undefined || !Number.isFinite(prev)) return '';
  let d;
  let label;
  if (isPct) { d = cur - prev; label = `${d >= 0 ? '+' : ''}${(d * 100).toFixed(1)} pts`; }
  else {
    if (prev === 0) return cur === 0 ? '<span class="delta flat">0%</span>' : '';
    d = (cur - prev) / Math.abs(prev);
    label = `${d >= 0 ? '+' : ''}${(d * 100).toFixed(1)}%`;
  }
  if (Math.abs(d) < 0.0005) return '<span class="delta flat">0%</span>';
  const good = invert ? d < 0 : d > 0;
  return `<span class="delta ${good ? 'up' : 'down'}" title="vs previous period">${d >= 0 ? '▲' : '▼'} ${label}</span>`;
}

function kpi({ label, value, sw, deltaHtml = '', foot = '', tip = '', id = '' }) {
  return `<div class="card kpi" ${tip ? `title="${esc(tip)}"` : ''}>
    <div class="kpi-top">${sw ? `<span class="sw" style="background:var(${sw})"></span>` : ''}${esc(label)}</div>
    <div class="kpi-val num">${value}</div>
    <div class="kpi-foot">${deltaHtml}<span>${foot}</span></div>
    ${id ? `<div class="mini" id="${id}"></div>` : ''}
  </div>`;
}

const card = (title, sub, body, { cls = '', right = '', id = '' } = {}) =>
  `<div class="card ${cls}" ${id ? `id="${id}"` : ''}><div class="card-h"><div><h3>${title}</h3>${sub ? `<div class="sub">${sub}</div>` : ''}</div>${right ? `<div class="right">${right}</div>` : ''}</div><div class="card-b">${body}</div></div>`;

const legend = (items) => `<div class="legend">${items.map(([c, l, line]) => `<span><i class="${line ? 'line' : ''}" style="background:var(${c})"></i>${l}</span>`).join('')}</div>`;

function statusPill(s) {
  const m = STATUS_META[s] || { label: s, cls: '' };
  return `<span class="pill ${m.cls}">${m.label}</span>`;
}

const granLabel = { day: 'Daily', week: 'Weekly', month: 'Monthly' };
function granSeg() {
  const g = state.gran || 'auto';
  return `<div class="seg" id="gran-seg">${['auto', 'day', 'week', 'month'].map((k) => `<button data-g="${k}" class="${g === k ? 'on' : ''}">${k === 'auto' ? 'Auto' : granLabel[k]}</button>`).join('')}</div>`;
}
function bindGran(el) {
  el.querySelector('#gran-seg')?.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.gran = b.dataset.g === 'auto' ? null : b.dataset.g;
    renderPage();
  });
}
const bucketLabel = (k, gran) => {
  if (gran === 'month') { const [y, m] = k.split('-'); return new Date(+y, +m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' }); }
  const [y, m, d] = k.split('-').map(Number);
  const s = new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return gran === 'week' ? `Wk ${s}` : s;
};

function emptyState(el) {
  el.innerHTML = `<div class="card"><div class="empty">
    <div class="t">No eBay sales in this date range</div>
    <div>${state.data.orders.length ? 'Try a wider range, like <b>All</b>.' : 'Connect eBay in <a href="#/settings">Settings</a> and upload an Amazon CSV in <a href="#/import">Amazon import</a>.'}</div>
  </div></div>`;
}

function setupBanner() {
  const d = state.data;
  const out = [];
  if (!d.ebay.configured)
    out.push(`<div class="banner">${ICONS.alert}<div><b>eBay isn't connected.</b> Finish setup in Settings, then click <b>Connect eBay account</b>. <span class="muted">Missing: ${d.ebay.missing.join(', ')}</span></div><a class="btn sm" href="#/settings">Set up</a></div>`);
  // Loud warnings when an automatic pull stops working, so a silent failure can't hide missing sales or costs
  const stale = (iso, hours) => !iso || Date.now() - new Date(iso).getTime() > hours * 3600_000;
  if (d.ebay.needsReconnect)
    out.push(`<div class="banner" style="background:var(--bad-soft);border-color:var(--bad)">${ICONS.alert}<div><b>eBay needs to be reconnected.</b> eBay stopped accepting the saved connection, so no new sales are coming in.</div><a class="btn sm" href="/api/ebay/connect">Reconnect eBay</a></div>`);
  else if (d.ebay.refreshExpiresAt && new Date(d.ebay.refreshExpiresAt) - Date.now() < 30 * 86400_000)
    out.push(`<div class="banner">${ICONS.alert}<div><b>eBay connection expires ${fmtDate(d.ebay.refreshExpiresAt, { month: 'short', day: 'numeric', year: 'numeric' })}.</b> Reconnect now so syncing never stops.</div><a class="btn sm" href="/api/ebay/connect">Reconnect eBay</a></div>`);
  else if (d.ebay.configured && d.ebay.last && !d.ebay.last.ok)
    out.push(`<div class="banner" style="background:var(--bad-soft);border-color:var(--bad)">${ICONS.alert}<div><b>eBay sync is failing.</b> New sales are not coming in. <span class="muted">${esc((d.ebay.last.message || '').slice(0, 180))}</span></div><a class="btn sm" href="#/settings">Details</a></div>`);
  else if (d.ebay.configured && d.ebay.lastSuccess && stale(d.ebay.lastSuccess, 3))
    out.push(`<div class="banner">${ICONS.alert}<div><b>eBay hasn't synced since ${fmtDateTime(d.ebay.lastSuccess)}.</b> It normally runs every 30 minutes. Check that the server is running.</div><a class="btn sm" href="#/settings">Details</a></div>`);
  if (d.email.configured && d.email.last && !d.email.last.ok)
    out.push(`<div class="banner" style="background:var(--bad-soft);border-color:var(--bad)">${ICONS.alert}<div><b>Amazon email check is failing.</b> New Amazon costs are not coming in. <span class="muted">${esc((d.email.last.log || []).join(' ').slice(0, 180))}</span></div><a class="btn sm" href="#/settings">Details</a></div>`);
  else if (d.email.configured && d.email.last && stale(d.email.last.at, 3))
    out.push(`<div class="banner">${ICONS.alert}<div><b>Amazon email hasn't been checked since ${fmtDateTime(d.email.last.at)}.</b> It normally runs every 30 minutes.</div><a class="btn sm" href="#/settings">Details</a></div>`);
  if (!d.email.configured)
    out.push(`<div class="banner info">${ICONS.info}<div><b>Amazon email import is off.</b> Add a Gmail App Password so Amazon purchases come in automatically, with no weekly CSV.</div><a class="btn sm" href="#/settings">Set up</a></div>`);
  if (d.orders.some((o) => o.order_id.startsWith('DEMO-')))
    out.push(`<div class="banner info">${ICONS.info}<div><b>You're looking at demo data.</b> It shows how the dashboard works before your real eBay and Amazon data arrives. Remove it any time.</div><a class="btn sm" href="#/settings">Remove demo data</a></div>`);
  return out.join('');
}

// ---------------------------------------------------------------- OVERVIEW
function overview(el) {
  const r = range();
  const all = scoped();
  if (!all.length) { el.innerHTML = setupBanner(); const d = document.createElement('div'); el.appendChild(d); emptyState(d); return; }
  const s = summarize(all);
  const p = summarize(prevScoped());
  const hasPrev = Boolean(r.start) && prevScoped().length > 0;
  const gran = state.gran || autoGran(r, all);
  const series = buckets(r, all, gran);
  const dailyForSpark = buckets(r, all, autoGran(r, all));
  const c = colors();
  const expenses = state.data.books.expenses;
  const ox = opexFor(r, expenses);
  const oxPrev = r.start ? opexFor(previousRange(r), expenses) : { total: 0 };
  const biz = s.net - ox.total;
  const bizPrev = p.net - oxPrev.total;

  // goal + run rate
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthOrders = inRange(state.data.orders, { start: monthStart, end: new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0, 23, 59, 59) });
  const ms = summarize(monthOrders);
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dayOfMonth = now.getDate() - 1 + now.getHours() / 24;
  const projected = dayOfMonth > 0.5 ? (ms.net / dayOfMonth) * daysInMonth : null;
  const goal = Number(state.data.settings.monthly_goal) || 0;
  const thisSettle = settleMonth({ month: monthKey(now), orders: state.data.orders, expenses: state.data.books.expenses, settlements: state.data.books.settlements, splitAmazon: Number(state.data.settings.split_amazon) });

  const top = byProduct(all).filter((x) => x.countedOrders > 0).sort((a, b) => b.net - a.net).slice(0, 8);
  const allTime = summarize(state.data.orders);
  const oldAwaiting = state.data.orders.filter((o) => o.status === 'awaiting_cost' && Date.now() - new Date(o.created_at) > 3 * DAY);
  const openReturns = state.data.orders.filter((o) => o.returns.some((x) => !/CLOSED/i.test(x.state || '')));

  el.innerHTML = `${setupBanner()}
  <div class="grid g-12">
    <div class="card hero c-6">
      <div class="hero-label"><span class="kpi-top" style="gap:7px"><span class="sw" style="background:var(--s-profit);width:8px;height:8px;border-radius:2px"></span>Net business profit</span>${hasPrev ? delta(biz, bizPrev) : ''}</div>
      <div class="hero-value num ${biz < 0 ? 'neg' : ''}">${money(biz, 2)}</div>
      <div class="hero-meta">
        <span>Item profit <b class="ink2">${money(s.net, 2)}</b></span>
        <span>− operating costs <b class="ink2">${money(ox.total, 2)}</b></span>
        <span><b class="ink2">${count(s.countedOrders)}</b> costed orders</span>
      </div>
      <div class="spark" id="hero-spark"></div>
    </div>
    <div class="c-6 side-kpis">
      ${kpi({ label: 'Revenue', sw: '--s-revenue', value: moneyShort(s.revenueAll), deltaHtml: hasPrev ? delta(s.revenueAll, p.revenueAll) : '', foot: 'buyer paid, excl. tax', id: 'k-rev' })}
      ${kpi({ label: 'Orders', value: count(s.orders), deltaHtml: hasPrev ? delta(s.orders, p.orders) : '', foot: `${count(s.units)} units`, id: 'k-ord' })}
      ${kpi({ label: 'Profit margin', value: pct(s.revenue ? biz / s.revenue : null), deltaHtml: hasPrev && p.revenue ? delta(biz / s.revenue, bizPrev / p.revenue, { isPct: true }) : '', foot: `business profit ÷ revenue · item ${pct(s.margin)}`, tip: 'After operating costs. Item margin (before operating costs) shown underneath.' })}
      ${kpi({ label: 'ROI', value: pct(s.cost ? biz / s.cost : null), deltaHtml: hasPrev && p.cost ? delta(biz / s.cost, bizPrev / p.cost, { isPct: true }) : '', foot: `business profit ÷ Amazon cost · item ${pct(s.roi)}` })}
    </div>
  </div>

  <div class="kpis mt">
    ${kpi({ label: 'Amazon cost', sw: '--s-cost', value: moneyShort(s.cost), deltaHtml: hasPrev ? delta(s.cost, p.cost, { invert: true }) : '', foot: `avg ${money(s.avgCost)}` })}
    ${kpi({ label: 'eBay fees', sw: '--s-fees', value: moneyShort(s.fees), deltaHtml: hasPrev ? delta(s.feeRate, p.feeRate, { invert: true, isPct: true }) : '', foot: `${pct(s.feeRate)} of revenue incl. ads` })}
    ${kpi({ label: 'Operating costs', sw: '--s-ops', value: money(ox.total, 2), deltaHtml: hasPrev ? delta(ox.total, oxPrev.total, { invert: true }) : '', foot: `subscriptions, tools, proxies · ${count(ox.byCategory.size)} items`, tip: 'Monthly operating costs from the sheets / Editor → Operating expenses. Partly covered months are prorated by day.' })}
    ${kpi({ label: 'Refunds', sw: '--s-refunds', value: moneyShort(s.refunds), foot: s.amazonRefund ? `${money(s.amazonRefund)} recovered` : 'to buyers' })}
    ${kpi({ label: 'Avg order value', value: money(s.aov), deltaHtml: hasPrev ? delta(s.aov, p.aov) : '' })}
    ${kpi({ label: 'Item profit / order', value: money(s.profitPerOrder), deltaHtml: hasPrev ? delta(s.profitPerOrder, p.profitPerOrder) : '', foot: 'before operating costs' })}
    ${kpi({ label: 'Return rate', value: pct(s.returnRate), deltaHtml: hasPrev ? delta(s.returnRate, p.returnRate, { invert: true, isPct: true }) : '', foot: `${count(s.returnCount)} orders` })}
    ${kpi({ label: 'Awaiting cost', value: count(s.awaitingCount), foot: `${moneyShort(s.awaitingRevenue)} in sales not in profit yet`, tip: 'eBay sales with no linked Amazon purchase yet. Excluded from profit until linked.' })}
  </div>

  <div class="grid g-12 mt">
    ${card('Revenue, cost &amp; item profit', `${granLabel[gran]} · item profit before operating costs · red = loss period`, `${legend([['--s-revenue', 'Revenue', 1], ['--s-cost', 'Amazon cost', 1], ['--s-profit', 'Item profit']])}<div class="chart tall" id="ch-main"></div>`, { cls: 'c-8', right: granSeg() })}
    ${card('Where every dollar goes', 'Revenue broken into costs and what you keep', '<div class="chart tall" id="ch-waterfall"></div>', { cls: 'c-4' })}
  </div>

  <div class="grid g-12 mt">
    ${card('Cumulative profit', 'Running total: item profit, minus each month’s operating costs', '<div class="chart" id="ch-cum"></div>', { cls: 'c-5' })}
    ${card('Order outcomes', 'Share of eBay orders in the range', '<div class="chart" id="ch-outcomes"></div>', { cls: 'c-3' })}
    ${card('This month', now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }), `
      <div class="hero-value num" style="font-size:32px;margin-top:0">${money(ms.net, 0)}</div>
      <div class="muted" style="font-size:12.5px">${goal ? `of ${money(goal, 0)} goal` : 'Set a monthly goal in Settings'}</div>
      ${goal ? `<div class="goal-bar"><div style="width:${Math.min(100, Math.max(0, (ms.net / goal) * 100)).toFixed(1)}%"></div></div>` : '<div style="height:12px"></div>'}
      <div class="stat-row"><span class="k">After operating expenses</span><span class="v ${thisSettle.businessProfit < 0 ? 'neg' : ''}">${money(thisSettle.businessProfit, 0)}</span></div>
      <div class="stat-row"><span class="k">${esc(state.data.settings.partner_ebay)} owes ${esc(state.data.settings.partner_amazon)}</span><span class="v">${money(thisSettle.balance, 2)}</span></div>
      <div class="stat-row"><span class="k">Projected month-end</span><span class="v">${projected !== null ? money(projected, 0) : '—'}</span></div>
      <div class="stat-row"><span class="k">Daily run-rate</span><span class="v">${dayOfMonth > 0.5 ? money(ms.net / dayOfMonth) : '—'}</span></div>
      <div class="stat-row"><span class="k">Orders this month</span><span class="v">${count(ms.orders)}</span></div>
      <div class="stat-row"><span class="k">All-time profit</span><span class="v">${money(allTime.net, 0)}</span></div>`, { cls: 'c-4' })}
  </div>

  <div class="grid g-12 mt">
    ${card('Operating costs', `${money(ox.total, 2)} in this range · the sheets' section 2`, `<div class="chart" id="ch-opex" style="height:260px"></div>`, { cls: 'c-6', right: '<a class="btn sm" href="#/editor?tab=expenses">Edit</a>' })}
    ${card('Operating costs by month', 'Full month totals', `<div class="table-wrap" id="opex-months"></div>`, { cls: 'c-6' })}
  </div>
  <div class="grid g-12 mt">
    ${card('Top products by profit', 'Net profit in range', '<div class="chart" id="ch-top" style="height:320px"></div>', { cls: 'c-7' })}
    ${card('Needs attention', 'Click an item to jump there', `<div class="alert-list">
      ${alertItem('bad', ICONS.alert, 'Loss-making orders', `${money(s.lossTotal)} lost in this range`, s.lossCount, '#/orders?f=loss')}
      ${alertItem('info', ICONS.clock, 'Sales waiting on Amazon cost', `${oldAwaiting.length} are older than 3 days. Upload a fresh CSV`, state.data.orders.filter((o) => o.status === 'awaiting_cost').length, '#/import')}
      ${alertItem('warn', ICONS.link, 'Suggested matches to review', 'Title-only matches need a human yes/no', state.data.amazon.suggestions || 0, '#/editor?tab=matches')}
      ${alertItem('warn', ICONS.return, 'Open returns', 'Returns not closed yet', openReturns.length, '#/returns')}
      ${alertItem('good', ICONS.check, 'Repeat buyers', `${count(s.uniqueBuyers)} unique buyers in range`, s.repeatBuyers, '#/trends')}
    </div>`, { cls: 'c-5' })}
  </div>`;

  // hero spark
  sparkline($('#hero-spark'), dailyForSpark.map((b) => b.net), c.profit);
  sparkline($('#k-rev'), dailyForSpark.map((b) => b.revenueAll), c.revenue);
  sparkline($('#k-ord'), dailyForSpark.map((b) => b.orders), c.accent);

  // main chart
  const labels = series.map((b) => bucketLabel(b.key, gran));
  mount($('#ch-main'), {
    grid: { left: 8, right: 12, top: 16, bottom: 4, containLabel: true },
    tooltip: {
      ...tooltipBase(), trigger: 'axis', axisPointer: { type: 'line', lineStyle: { color: c.axis } },
      formatter: (ps) => {
        const b = series[ps[0].dataIndex];
        return ttHead(labels[ps[0].dataIndex]) + ttRow(c.revenue, 'Revenue', money(b.revenueAll)) + ttRow(c.cost, 'Amazon cost', money(b.cost)) +
          ttRow(c.fees, 'Fees + ads', money(b.fees + b.adFees)) + ttRow(c.refunds, 'Refunds', money(b.refunds)) +
          ttRow(b.net < 0 ? c.bad : c.profit, 'Item profit', money(b.net), true) + `<div style="opacity:.6;margin-top:4px">${count(b.orders)} orders · ${pct(b.margin)} margin</div>`;
      },
    },
    xAxis: { type: 'category', data: labels, ...axisBase({ splitLine: { show: false } }) },
    yAxis: { type: 'value', ...axisBase(), axisLabel: { ...axisBase().axisLabel, formatter: moneyShort }, axisLine: { show: false } },
    series: [
      { name: 'Net profit', type: 'bar', data: series.map((b) => ({ value: +b.net.toFixed(2), itemStyle: { color: b.net < 0 ? c.bad : c.profit, borderRadius: b.net < 0 ? [0, 0, 4, 4] : [4, 4, 0, 0] } })), barMaxWidth: 22, z: 2 },
      { name: 'Revenue', type: 'line', data: series.map((b) => +b.revenueAll.toFixed(2)), smooth: 0.3, symbol: 'circle', symbolSize: 6, showSymbol: false, lineStyle: { width: 2, color: c.revenue }, itemStyle: { color: c.revenue },
        areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: `${c.revenue}30` }, { offset: 1, color: `${c.revenue}00` }]) } },
      { name: 'Amazon cost', type: 'line', data: series.map((b) => +b.cost.toFixed(2)), smooth: 0.3, symbol: 'circle', symbolSize: 6, showSymbol: false, lineStyle: { width: 2, color: c.cost }, itemStyle: { color: c.cost } },
    ],
  });
  bindGran(el);

  // waterfall
  const steps = [
    ['Revenue', s.revenue, c.revenue],
    ['Amazon cost', -s.cost, c.cost],
    ['eBay fees', -s.fees, c.fees],
    ['Ad fees', -s.adFees, c.ads],
    ['Refunds', -(s.refunds - s.amazonRefund), c.refunds],
    ['Other costs', -s.extra, c.ink3],
    ['Operating costs', -ox.total, c.ops],
  ];
  let run = 0;
  const base = [];
  const vals = [];
  for (const [name, v, col] of steps) {
    if (name === 'Revenue') { base.push(0); vals.push({ value: v, itemStyle: { color: col } }); run = v; continue; }
    run += v;
    base.push(Math.min(run, run - v));
    vals.push({ value: Math.abs(v), itemStyle: { color: col } });
  }
  base.push(0);
  vals.push({ value: biz, itemStyle: { color: biz < 0 ? c.bad : c.profit } });
  const wfLabels = [...steps.map((x) => x[0]), 'Business profit'];
  mount($('#ch-waterfall'), {
    grid: { left: 8, right: 16, top: 10, bottom: 4, containLabel: true },
    tooltip: { ...tooltipBase(), trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(127,127,127,.08)' } },
      formatter: (ps) => { const i = ps[0].dataIndex; const raw = i < steps.length ? steps[i][1] : biz; return ttHead(wfLabels[i]) + `<div>${money(raw)}${s.revenue && i > 0 ? ` <span style="opacity:.6">(${pct(Math.abs(raw) / s.revenue)} of revenue)</span>` : ''}</div>`; } },
    xAxis: { type: 'value', ...axisBase(), axisLabel: { ...axisBase().axisLabel, formatter: moneyShort } },
    yAxis: { type: 'category', inverse: true, data: wfLabels, ...axisBase({ splitLine: { show: false } }), axisLabel: { color: c.ink2, fontSize: 12 } },
    series: [
      { type: 'bar', stack: 'w', data: base, itemStyle: { color: 'transparent' }, emphasis: { disabled: true }, tooltip: { show: false } },
      { type: 'bar', stack: 'w', data: vals, barWidth: 18, itemStyle: { borderRadius: 4 },
        label: { show: true, position: 'right', color: c.ink2, fontSize: 11, formatter: (p) => moneyShort(p.dataIndex === 0 || p.dataIndex === wfLabels.length - 1 ? p.value : -p.value) } },
    ],
  });

  // cumulative
  const cumGran = autoGran(r, all);
  const opexPerBucket = dailyForSpark.map((b) => {
    const [y, mo, d] = b.key.split('-').map(Number);
    const bStart = new Date(y, (mo || 1) - 1, d || 1);
    const bEnd = cumGran === 'month' ? new Date(y, mo, 0, 23, 59, 59) : cumGran === 'week' ? new Date(bStart.getTime() + 7 * DAY - 1) : new Date(bStart.getTime() + DAY - 1);
    const clip = { start: r.start && r.start > bStart ? r.start : bStart, end: r.end < bEnd ? r.end : bEnd };
    return opexFor(clip, expenses).total;
  });
  let acc = 0;
  const cum = dailyForSpark.map((b, i) => (acc += b.net - opexPerBucket[i]));
  const cumLabels = dailyForSpark.map((b) => bucketLabel(b.key, autoGran(r, all)));
  mount($('#ch-cum'), {
    grid: { left: 8, right: 12, top: 12, bottom: 4, containLabel: true },
    tooltip: { ...tooltipBase(), trigger: 'axis', formatter: (ps) => ttHead(cumLabels[ps[0].dataIndex]) + ttRow(c.profit, 'Business profit to date', money(ps[0].value), true) },
    xAxis: { type: 'category', data: cumLabels, boundaryGap: false, ...axisBase({ splitLine: { show: false } }) },
    yAxis: { type: 'value', ...axisBase(), axisLine: { show: false }, axisLabel: { ...axisBase().axisLabel, formatter: moneyShort } },
    series: [{ type: 'line', data: cum.map((v) => +v.toFixed(2)), smooth: 0.25, showSymbol: false, lineStyle: { width: 2.2, color: c.profit },
      areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: `${c.profit}40` }, { offset: 1, color: `${c.profit}00` }]) } }],
  });

  // outcomes donut (status colors + labels)
  const outcome = [
    ['Profitable', all.filter((o) => o.status === 'profitable').length, c.good],
    ['Loss', all.filter((o) => o.status === 'loss' || o.status === 'cancelled_after_purchase').length, c.bad],
    ['Returned', all.filter((o) => o.status === 'returned').length, c.warn],
    ['Awaiting cost', all.filter((o) => o.status === 'awaiting_cost').length, c.accent],
    ['Cancelled', all.filter((o) => o.status === 'cancelled').length, c.ink3],
  ].filter((x) => x[1] > 0);
  mount($('#ch-outcomes'), {
    tooltip: { ...tooltipBase(), trigger: 'item', formatter: (p) => ttHead(p.name) + `${count(p.value)} orders · ${p.percent.toFixed(1)}%` },
    legend: { bottom: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 10, textStyle: { color: c.ink2, fontSize: 11.5 } },
    series: [{ type: 'pie', radius: ['52%', '76%'], center: ['50%', '42%'], padAngle: 2, itemStyle: { borderRadius: 5, borderColor: c.surface, borderWidth: 2 },
      label: { show: true, position: 'center', formatter: () => `{a|${pct(outcome[0] ? outcome[0][1] / all.length : 0, 0)}}\n{b|profitable}`,
        rich: { a: { fontSize: 22, fontWeight: 700, color: c.ink }, b: { fontSize: 11, color: c.ink3, padding: [4, 0, 0, 0] } } },
      emphasis: { scale: true, scaleSize: 4, label: { show: true } },
      data: outcome.map(([name, value, color]) => ({ name, value, itemStyle: { color } })) }],
  });

  // top products
  const tp = [...top].reverse();
  mount($('#ch-top'), {
    grid: { left: 8, right: 70, top: 4, bottom: 4, containLabel: true },
    tooltip: { ...tooltipBase(), trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(127,127,127,.08)' } },
      formatter: (ps) => { const x = tp[ps[0].dataIndex]; return ttHead(x.title) + ttRow(c.profit, 'Net profit', money(x.net), true) + ttRow(c.revenue, 'Revenue', money(x.revenueAll)) + `<div style="opacity:.6;margin-top:4px">${count(x.orders)} orders · ${pct(x.margin)} margin</div>`; } },
    xAxis: { type: 'value', ...axisBase(), axisLabel: { ...axisBase().axisLabel, formatter: moneyShort } },
    yAxis: { type: 'category', data: tp.map((x) => x.title), ...axisBase({ splitLine: { show: false } }),
      axisLabel: { color: c.ink2, fontSize: 11.5, width: 190, overflow: 'truncate' } },
    series: [{ type: 'bar', data: tp.map((x) => ({ value: +x.net.toFixed(2), itemStyle: { color: x.net < 0 ? c.bad : c.profit } })), barWidth: 14, itemStyle: { borderRadius: [0, 4, 4, 0] },
      label: { show: true, position: 'right', color: c.ink2, fontSize: 11, formatter: (p) => moneyShort(p.value) } }],
  });

  // operating costs by category (range) + by month (full months)
  const cats = [...ox.byCategory.entries()].sort((x, y) => x[1] - y[1]);
  if (cats.length) {
    mount($('#ch-opex'), {
      grid: { left: 8, right: 64, top: 4, bottom: 4, containLabel: true },
      tooltip: { ...tooltipBase(), trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(127,127,127,.08)' } }, formatter: (ps) => ttHead(cats[ps[0].dataIndex][0]) + ttRow(c.ops, 'In this range', money(cats[ps[0].dataIndex][1], 2), true) },
      xAxis: { type: 'value', ...axisBase(), axisLabel: { ...axisBase().axisLabel, formatter: moneyShort } },
      yAxis: { type: 'category', data: cats.map((x) => x[0]), ...axisBase({ splitLine: { show: false } }), axisLabel: { color: c.ink2, fontSize: 11.5, width: 170, overflow: 'truncate' } },
      series: [{ type: 'bar', data: cats.map((x) => +x[1].toFixed(2)), barWidth: 14, itemStyle: { color: c.ops, borderRadius: [0, 4, 4, 0] }, label: { show: true, position: 'right', color: c.ink2, fontSize: 11, formatter: (p) => money(p.value, 2) } }],
    });
  } else $('#ch-opex').outerHTML = '<div class="empty">No operating costs in this range. Add them in Editor → Operating expenses.</div>';
  const months = [...new Set(expenses.map((e) => e.month))].sort().reverse();
  $('#opex-months').innerHTML = months.length ? `<table class="simple"><thead><tr><th>Month</th><th>Items</th><th class="r">Total</th></tr></thead><tbody>${months.map((mo) => {
    const list = expenses.filter((e) => e.month === mo);
    const [yy, mm] = mo.split('-').map(Number);
    return `<tr><td>${new Date(yy, mm - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}</td><td class="muted" style="font-size:12px">${list.map((e) => esc(e.category)).join(', ')}</td><td class="r"><b>${money(list.reduce((t, e) => t + e.amount, 0), 2)}</b></td></tr>`;
  }).join('')}</tbody></table>` : '<div class="empty">None yet</div>';

  $$('.alert', el).forEach((a) => a.addEventListener('click', () => { location.hash = a.dataset.href; }));
}

function alertItem(kind, icon, title, sub, n, href) {
  return `<div class="alert" data-href="${href}"><div class="alert-ic ${kind}">${icon}</div><div><div class="alert-t">${title}</div><div class="alert-s">${sub}</div></div><div class="n">${count(n)}</div></div>`;
}

// ---------------------------------------------------------------- ANALYTICS
function trends(el) {
  const r = range();
  const all = scoped();
  if (!all.length) return emptyState(el);
  const c = colors();
  const s = summarize(all);
  const live = all.filter((o) => !o.excluded && !o.cancelled);
  const counted = all.filter((o) => o.counted);
  const gran = state.gran || autoGran(r, all);
  const series = buckets(r, all, gran);
  const labels = series.map((b) => bucketLabel(b.key, gran));

  el.innerHTML = `
  <div class="kpis six">
    ${kpi({ label: 'Avg purchase lag', value: s.avgLag === null ? '—' : `${s.avgLag.toFixed(1)} days`, foot: 'eBay sale → Amazon order' })}
    ${kpi({ label: 'Units per order', value: s.unitsPerOrder ? s.unitsPerOrder.toFixed(2) : '—' })}
    ${kpi({ label: 'Unique buyers', value: count(s.uniqueBuyers), foot: `${count(s.repeatBuyers)} bought 2+ times` })}
    ${kpi({ label: 'Avg Amazon cost', sw: '--s-cost', value: money(s.avgCost), foot: 'per costed order' })}
    ${kpi({ label: 'Fee rate', sw: '--s-fees', value: pct(s.feeRate), foot: 'eBay + ad fees ÷ revenue' })}
    ${kpi({ label: 'Best day', value: bestDay(all), foot: 'highest profit day' })}
  </div>

  <div class="grid g-12 mt">
    ${card('When orders come in', 'Orders by weekday and hour (your local time)', '<div class="chart" id="ch-heat" style="height:290px"></div>', { cls: 'c-8' })}
    ${card('Profit by weekday', 'Total net profit per day of week', '<div class="chart" id="ch-wd" style="height:290px"></div>', { cls: 'c-4' })}
  </div>
  <div class="grid g-12 mt">
    ${card('Order value &amp; profit per order', `${granLabel[gran]} averages`, `${legend([['--s-revenue', 'Avg order value', 1], ['--s-profit', 'Profit per order', 1]])}<div class="chart" id="ch-aov"></div>`, { cls: 'c-6', right: granSeg() })}
    ${card('Margin trend', `${granLabel[gran]} net margin`, '<div class="chart" id="ch-margin"></div>', { cls: 'c-6' })}
  </div>
  <div class="grid g-12 mt">
    ${card('Margin distribution', 'How many orders land in each margin band', '<div class="chart" id="ch-hist"></div>', { cls: 'c-6' })}
    ${card('Fees as % of revenue', `${granLabel[gran]}: final value fees and promoted-listing fees`, `${legend([['--s-fees', 'eBay fees'], ['--s-ads', 'Ad fees']])}<div class="chart" id="ch-fees"></div>`, { cls: 'c-6' })}
  </div>
  <div class="grid g-12 mt">
    ${card('Sale price bands', 'Orders and margin by eBay sale price', '<div class="chart" id="ch-bands"></div>', { cls: 'c-6' })}
    ${card('Purchase lag', 'Days between the eBay sale and your Amazon order', '<div class="chart" id="ch-lag"></div>', { cls: 'c-6' })}
  </div>
  <div class="grid g-12 mt">
    ${card('Where buyers are', 'Net profit by ship-to state (top 15)', '<div class="chart" id="ch-state" style="height:380px"></div>', { cls: 'c-6' })}
    ${card('Orders by hour', 'All days combined', '<div class="chart" id="ch-hour" style="height:380px"></div>', { cls: 'c-6' })}
  </div>
  <div class="mt">${card('Period breakdown', `${granLabel[gran]} totals with change vs the prior period`, '<div class="table-wrap" id="period-table"></div>', { right: '<button class="btn sm" id="dl-periods">Export CSV</button>' })}</div>`;
  bindGran(el);

  // heatmap
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const heat = [];
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const o of live) { const d = new Date(o.created_at); grid[(d.getDay() + 6) % 7][d.getHours()]++; }
  let maxH = 0;
  grid.forEach((row, di) => row.forEach((v, h) => { heat.push([h, di, v]); maxH = Math.max(maxH, v); }));
  mount($('#ch-heat'), {
    grid: { left: 8, right: 8, top: 6, bottom: 50, containLabel: true },
    tooltip: { ...tooltipBase(), formatter: (p) => ttHead(`${days[p.value[1]]} ${hourLabel(p.value[0])}`) + `${count(p.value[2])} orders` },
    xAxis: { type: 'category', data: [...Array(24).keys()].map(hourLabel), ...axisBase({ splitLine: { show: false } }), axisLine: { show: false } },
    yAxis: { type: 'category', data: days, ...axisBase({ splitLine: { show: false } }), axisLine: { show: false }, inverse: true },
    visualMap: { min: 0, max: Math.max(1, maxH), orient: 'horizontal', left: 'center', bottom: 0, itemHeight: 160, itemWidth: 10, calculable: false,
      text: ['More', 'Fewer'], textStyle: { color: c.ink3, fontSize: 11 }, inRange: { color: document.documentElement.dataset.theme === 'light' ? ['#eef4fc', '#86b6ef', '#2a78d6', '#104281'] : ['#1b2230', '#1c5cab', '#3987e5', '#9ec5f4'] } },
    series: [{ type: 'heatmap', data: heat, itemStyle: { borderColor: c.surface, borderWidth: 2, borderRadius: 4 }, emphasis: { itemStyle: { borderColor: c.ink, borderWidth: 1 } } }],
  });

  // weekday profit
  const wd = Array(7).fill(0);
  const wdN = Array(7).fill(0);
  for (const o of counted) { const i = (new Date(o.created_at).getDay() + 6) % 7; wd[i] += o.net; wdN[i]++; }
  mount($('#ch-wd'), {
    grid: { left: 8, right: 8, top: 16, bottom: 4, containLabel: true },
    tooltip: { ...tooltipBase(), trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(127,127,127,.08)' } }, formatter: (ps) => ttHead(days[ps[0].dataIndex]) + ttRow(c.profit, 'Net profit', money(wd[ps[0].dataIndex]), true) + `<div style="opacity:.6">${wdN[ps[0].dataIndex]} orders · ${money(wdN[ps[0].dataIndex] ? wd[ps[0].dataIndex] / wdN[ps[0].dataIndex] : 0)}/order</div>` },
    xAxis: { type: 'category', data: days, ...axisBase({ splitLine: { show: false } }) },
    yAxis: { type: 'value', ...axisBase(), axisLine: { show: false }, axisLabel: { ...axisBase().axisLabel, formatter: moneyShort } },
    series: [{ type: 'bar', data: wd.map((v) => ({ value: +v.toFixed(2), itemStyle: { color: v < 0 ? c.bad : c.profit } })), barWidth: '55%', itemStyle: { borderRadius: [4, 4, 0, 0] } }],
  });

  // AOV + profit per order (same unit, one axis)
  lineChart($('#ch-aov'), labels, [
    { name: 'Avg order value', data: series.map((b) => b.aov), color: c.revenue },
    { name: 'Profit per order', data: series.map((b) => b.profitPerOrder), color: c.profit },
  ], money);

  // margin trend
  lineChart($('#ch-margin'), labels, [{ name: 'Net margin', data: series.map((b) => b.margin), color: c.profit, area: true }], (v) => pct(v), (v) => `${Math.round(v * 100)}%`);

  // histogram
  const edges = [-Infinity, -0.1, 0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, Infinity];
  const hl = ['< -10%', '-10–0%', '0–5%', '5–10%', '10–15%', '15–20%', '20–25%', '25–30%', '30%+'];
  const hist = Array(hl.length).fill(0);
  for (const o of counted) { if (o.margin === null) continue; const i = edges.findIndex((e, k) => o.margin >= e && o.margin < edges[k + 1]); if (i >= 0) hist[i]++; }
  mount($('#ch-hist'), {
    grid: { left: 8, right: 8, top: 16, bottom: 4, containLabel: true },
    tooltip: { ...tooltipBase(), trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(127,127,127,.08)' } }, formatter: (ps) => ttHead(`Margin ${hl[ps[0].dataIndex]}`) + `${count(ps[0].value)} orders (${pct(ps[0].value / Math.max(1, counted.length))})` },
    xAxis: { type: 'category', data: hl, ...axisBase({ splitLine: { show: false } }) },
    yAxis: { type: 'value', ...axisBase(), axisLine: { show: false }, minInterval: 1 },
    series: [{ type: 'bar', data: hist.map((v, i) => ({ value: v, itemStyle: { color: i < 2 ? c.bad : c.revenue } })), barWidth: '70%', itemStyle: { borderRadius: [4, 4, 0, 0] } }],
  });

  // fees % (stacked, same unit)
  mount($('#ch-fees'), {
    grid: { left: 8, right: 8, top: 16, bottom: 4, containLabel: true },
    tooltip: { ...tooltipBase(), trigger: 'axis', formatter: (ps) => ttHead(labels[ps[0].dataIndex]) + ps.map((p) => ttRow(p.color, p.seriesName, pct(p.value))).join('') },
    xAxis: { type: 'category', data: labels, ...axisBase({ splitLine: { show: false } }) },
    yAxis: { type: 'value', ...axisBase(), axisLine: { show: false }, axisLabel: { ...axisBase().axisLabel, formatter: (v) => `${Math.round(v * 100)}%` } },
    series: [
      { name: 'eBay fees', type: 'bar', stack: 'f', data: series.map((b) => (b.revenue ? b.fees / b.revenue : 0)), itemStyle: { color: c.fees }, barMaxWidth: 22 },
      { name: 'Ad fees', type: 'bar', stack: 'f', data: series.map((b) => (b.revenue ? b.adFees / b.revenue : 0)), itemStyle: { color: c.ads, borderRadius: [4, 4, 0, 0] }, barMaxWidth: 22 },
    ],
  });

  // price bands
  const bandEdges = [0, 25, 50, 100, 150, 250, Infinity];
  const bandLabels = ['<$25', '$25–50', '$50–100', '$100–150', '$150–250', '$250+'];
  const bands = bandLabels.map(() => []);
  for (const o of live) { const v = o.revenue / Math.max(1, o.units); const i = bandEdges.findIndex((e, k) => v >= e && v < bandEdges[k + 1]); if (i >= 0) bands[i].push(o); }
  const bandStats = bands.map(summarize);
  mount($('#ch-bands'), {
    grid: { left: 8, right: 8, top: 26, bottom: 4, containLabel: true },
    tooltip: { ...tooltipBase(), trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(127,127,127,.08)' } },
      formatter: (ps) => { const b = bandStats[ps[0].dataIndex]; return ttHead(bandLabels[ps[0].dataIndex]) + ttRow(c.revenue, 'Orders', count(b.orders)) + ttRow(c.profit, 'Net profit', money(b.net)) + ttRow(c.ink3, 'Margin', pct(b.margin)) + ttRow(c.ink3, 'Profit / order', money(b.profitPerOrder)); } },
    xAxis: { type: 'category', data: bandLabels, ...axisBase({ splitLine: { show: false } }) },
    yAxis: { type: 'value', ...axisBase(), axisLine: { show: false }, minInterval: 1 },
    series: [{ type: 'bar', data: bandStats.map((b) => b.orders), barWidth: '55%', itemStyle: { color: c.revenue, borderRadius: [4, 4, 0, 0] },
      label: { show: true, position: 'top', color: c.ink2, fontSize: 11, formatter: (p) => (bandStats[p.dataIndex].margin === null ? '' : `${pct(bandStats[p.dataIndex].margin, 0)} margin`) } }],
  });

  // lag
  const lagL = ['Same day', '1 day', '2 days', '3 days', '4+ days'];
  const lag = Array(5).fill(0);
  for (const o of counted) if (o.lag_days !== null && o.lag_days >= 0) lag[Math.min(4, o.lag_days)]++;
  mount($('#ch-lag'), {
    grid: { left: 8, right: 8, top: 16, bottom: 4, containLabel: true },
    tooltip: { ...tooltipBase(), trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(127,127,127,.08)' } }, formatter: (ps) => ttHead(lagL[ps[0].dataIndex]) + `${count(ps[0].value)} orders` },
    xAxis: { type: 'category', data: lagL, ...axisBase({ splitLine: { show: false } }) },
    yAxis: { type: 'value', ...axisBase(), axisLine: { show: false }, minInterval: 1 },
    series: [{ type: 'bar', data: lag.map((v, i) => ({ value: v, itemStyle: { color: i >= 3 ? c.serious : c.revenue } })), barWidth: '55%', itemStyle: { borderRadius: [4, 4, 0, 0] } }],
  });

  // states
  const st = [...groupBy(all, (o) => o.ship_state || null).entries()].map(([k, os]) => ({ k, ...summarize(os) })).sort((a, b) => b.net - a.net).slice(0, 15).reverse();
  mount($('#ch-state'), {
    grid: { left: 8, right: 60, top: 4, bottom: 4, containLabel: true },
    tooltip: { ...tooltipBase(), trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(127,127,127,.08)' } }, formatter: (ps) => { const x = st[ps[0].dataIndex]; return ttHead(x.k) + ttRow(c.profit, 'Net profit', money(x.net), true) + ttRow(c.revenue, 'Revenue', money(x.revenueAll)) + `<div style="opacity:.6">${x.orders} orders</div>`; } },
    xAxis: { type: 'value', ...axisBase(), axisLabel: { ...axisBase().axisLabel, formatter: moneyShort } },
    yAxis: { type: 'category', data: st.map((x) => x.k), ...axisBase({ splitLine: { show: false } }), axisLabel: { color: c.ink2 } },
    series: [{ type: 'bar', data: st.map((x) => +x.net.toFixed(2)), barWidth: 12, itemStyle: { color: c.profit, borderRadius: [0, 4, 4, 0] }, label: { show: true, position: 'right', color: c.ink2, fontSize: 11, formatter: (p) => moneyShort(p.value) } }],
  });

  // hours
  const hours = Array(24).fill(0);
  for (const o of live) hours[new Date(o.created_at).getHours()]++;
  mount($('#ch-hour'), {
    grid: { left: 8, right: 8, top: 16, bottom: 4, containLabel: true },
    tooltip: { ...tooltipBase(), trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(127,127,127,.08)' } }, formatter: (ps) => ttHead(hourLabel(ps[0].dataIndex)) + `${count(ps[0].value)} orders` },
    xAxis: { type: 'category', data: [...Array(24).keys()].map(hourLabel), ...axisBase({ splitLine: { show: false } }) },
    yAxis: { type: 'value', ...axisBase(), axisLine: { show: false }, minInterval: 1 },
    series: [{ type: 'bar', data: hours, barWidth: '60%', itemStyle: { color: c.revenue, borderRadius: [3, 3, 0, 0] } }],
  });

  // period table
  const rows = series.map((b, i) => ({ ...b, label: labels[i], growth: i > 0 && series[i - 1].net ? (b.net - series[i - 1].net) / Math.abs(series[i - 1].net) : null })).reverse();
  $('#period-table').innerHTML = `<table class="simple"><thead><tr><th>Period</th><th class="r">Orders</th><th class="r">Revenue</th><th class="r">Amazon cost</th><th class="r">Fees</th><th class="r">Refunds</th><th class="r">Net profit</th><th class="r">Margin</th><th class="r">Change</th></tr></thead><tbody>
    ${rows.map((b) => `<tr><td>${b.label}</td><td class="r">${count(b.orders)}</td><td class="r">${money(b.revenueAll)}</td><td class="r">${money(b.cost)}</td><td class="r">${money(b.fees + b.adFees)}</td><td class="r">${money(b.refunds)}</td><td class="r ${b.net < 0 ? 'neg' : ''}"><b>${money(b.net)}</b></td><td class="r">${pct(b.margin)}</td><td class="r">${b.growth === null ? '<span class="muted">—</span>' : `<span class="${b.growth >= 0 ? 'pos' : 'neg'}">${b.growth >= 0 ? '▲' : '▼'} ${Math.abs(b.growth * 100).toFixed(0)}%</span>`}</td></tr>`).join('')}
  </tbody></table>`;
  $('#dl-periods').onclick = () => downloadCsv('periods.csv', rows, [
    { title: 'Period', get: (b) => b.key }, { title: 'Orders', get: (b) => b.orders }, { title: 'Revenue', get: (b) => b.revenueAll.toFixed(2) },
    { title: 'Amazon cost', get: (b) => b.cost.toFixed(2) }, { title: 'eBay fees', get: (b) => b.fees.toFixed(2) }, { title: 'Ad fees', get: (b) => b.adFees.toFixed(2) },
    { title: 'Refunds', get: (b) => b.refunds.toFixed(2) }, { title: 'Net profit', get: (b) => b.net.toFixed(2) }, { title: 'Margin', get: (b) => (b.margin ?? '') },
  ]);
}

const hourLabel = (h) => (h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`);

function bestDay(orders) {
  const m = groupBy(orders.filter((o) => o.counted), (o) => bucketKey(o.created_at, 'day'));
  let best = null;
  for (const [k, os] of m) { const n = os.reduce((s, o) => s + o.net, 0); if (!best || n > best.n) best = { k, n }; }
  return best ? `<span title="${fmtDate(best.k + 'T12:00')}">${moneyShort(best.n)}</span> <span class="muted" style="font-size:12px;font-weight:500">${fmtDate(best.k + 'T12:00')}</span>` : '—';
}

function lineChart(el, labels, lines, fmt, axisFmt) {
  const c = colors();
  return mount(el, {
    grid: { left: 8, right: 12, top: 16, bottom: 4, containLabel: true },
    tooltip: { ...tooltipBase(), trigger: 'axis', axisPointer: { type: 'line', lineStyle: { color: c.axis } }, formatter: (ps) => ttHead(labels[ps[0].dataIndex]) + ps.map((p) => ttRow(p.color, p.seriesName, p.value === null ? '—' : fmt(p.value))).join('') },
    xAxis: { type: 'category', data: labels, boundaryGap: false, ...axisBase({ splitLine: { show: false } }) },
    yAxis: { type: 'value', ...axisBase(), axisLine: { show: false }, axisLabel: { ...axisBase().axisLabel, formatter: axisFmt || moneyShort } },
    series: lines.map((l) => ({
      name: l.name, type: 'line', data: l.data.map((v) => (v === null ? null : +v.toFixed(4))), smooth: 0.3, connectNulls: true, showSymbol: false, symbolSize: 8,
      lineStyle: { width: 2, color: l.color }, itemStyle: { color: l.color },
      areaStyle: l.area ? { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: `${l.color}40` }, { offset: 1, color: `${l.color}00` }]) } : undefined,
    })),
  });
}

// ---------------------------------------------------------------- PRODUCTS
function products(el) {
  const all = scoped();
  if (!all.length) return emptyState(el);
  const c = colors();
  const prods = byProduct(all);
  const costed = prods.filter((p) => p.countedOrders > 0);
  const best = [...prods].sort((a, b) => b.orders - a.orders)[0];
  const most = [...costed].sort((a, b) => b.net - a.net)[0];
  const worst = [...costed].sort((a, b) => a.net - b.net)[0];
  const bestMargin = [...costed].filter((p) => p.countedOrders >= 3).sort((a, b) => b.margin - a.margin)[0];

  el.innerHTML = `
  <div class="kpis five">
    ${kpi({ label: 'Products sold', value: count(prods.length), foot: `${count(prods.filter((p) => p.orders >= 2).length)} sold 2+ times` })}
    ${kpi({ label: 'Best seller', value: best ? `${count(best.orders)} orders` : '—', foot: best ? esc(trunc(best.title, 34)) : '' })}
    ${kpi({ label: 'Most profitable', sw: '--s-profit', value: most ? moneyShort(most.net) : '—', foot: most ? esc(trunc(most.title, 34)) : '' })}
    ${kpi({ label: 'Best margin (3+ orders)', value: bestMargin ? pct(bestMargin.margin) : '—', foot: bestMargin ? esc(trunc(bestMargin.title, 34)) : '' })}
    ${kpi({ label: 'Biggest drag', value: worst ? `<span class="${worst.net < 0 ? 'neg' : ''}">${moneyShort(worst.net)}</span>` : '—', foot: worst ? esc(trunc(worst.title, 34)) : '' })}
  </div>
  <div class="grid g-12 mt">
    ${card('Sale price vs Amazon cost', 'Each dot is an order · dots under the dashed line lost money after fees', `${legend([['--good', 'Profitable'], ['--bad', 'Loss']])}<div class="chart tall" id="ch-scatter"></div>`, { cls: 'c-7' })}
    ${card('Product leaderboard', 'Top 12', `<div class="seg" id="lb-seg" style="margin-bottom:10px"><button data-k="net" class="on">Profit</button><button data-k="revenueAll">Revenue</button><button data-k="orders">Orders</button><button data-k="margin">Margin</button></div><div class="chart" id="ch-lb" style="height:340px"></div>`, { cls: 'c-5' })}
  </div>
  <div class="card mt"><div class="sheet-bar"><h3 style="margin:0;font-size:13.5px">All products</h3><div class="search" style="margin-left:auto">${ICONS.search}<input class="input" id="prod-q" placeholder="Search products" /></div><button class="btn sm" id="prod-dl">Export CSV</button></div><div id="prod-table"></div></div>`;

  // scatter
  const pts = all.filter((o) => o.counted && o.revenue > 0);
  const feeRate = summarize(all).feeRate || 0.15;
  const maxV = Math.max(10, ...pts.map((o) => Math.max(o.revenue, o.cost)));
  mount($('#ch-scatter'), {
    grid: { left: 8, right: 16, top: 16, bottom: 26, containLabel: true },
    tooltip: { ...tooltipBase(), trigger: 'item', formatter: (p) => { const o = pts[p.dataIndex]; if (!o) return ''; return ttHead(trunc(o.title, 60)) + ttRow(c.revenue, 'Sold for', money(o.revenue)) + ttRow(c.cost, 'Amazon cost', money(o.cost)) + ttRow(o.net < 0 ? c.bad : c.good, 'Net', money(o.net), true) + `<div style="opacity:.6;margin-top:3px">${fmtDate(o.created_at)} · click for details</div>`; } },
    xAxis: { type: 'value', name: 'eBay sale', nameLocation: 'middle', nameGap: 26, nameTextStyle: { color: c.ink3 }, ...axisBase(), axisLabel: { ...axisBase().axisLabel, formatter: moneyShort }, max: Math.ceil(maxV * 1.05) },
    yAxis: { type: 'value', ...axisBase(), axisLine: { show: false }, axisLabel: { ...axisBase().axisLabel, formatter: moneyShort } },
    series: [
      { type: 'scatter', data: pts.map((o) => ({ value: [o.revenue, o.cost], itemStyle: { color: o.net < 0 ? c.bad : c.good, opacity: 0.75, borderColor: c.surface, borderWidth: 1 } })), symbolSize: 9, emphasis: { scale: 1.6 } },
      { type: 'line', data: [[0, 0], [maxV * 1.05, maxV * 1.05 * (1 - feeRate)]], showSymbol: false, lineStyle: { type: 'dashed', color: c.ink3, width: 1.5 }, tooltip: { show: false }, silent: true,
        endLabel: { show: true, formatter: 'break-even', color: c.ink3, fontSize: 11 } },
    ],
  }).on('click', (p) => { if (p.seriesIndex === 0) openOrder(pts[p.dataIndex].order_id); });

  // leaderboard
  let lbKey = 'net';
  let lbChart;
  const drawLb = () => {
    lbChart?.dispose();
    const base = lbKey === 'margin' ? costed.filter((p) => p.countedOrders >= 2) : lbKey === 'net' ? costed : prods;
    const list = [...base].sort((a, b) => (b[lbKey] ?? -1e9) - (a[lbKey] ?? -1e9)).slice(0, 12).reverse();
    const fmt = lbKey === 'margin' ? (v) => pct(v, 0) : lbKey === 'orders' ? count : moneyShort;
    const col = lbKey === 'orders' ? c.accent : lbKey === 'revenueAll' ? c.revenue : c.profit;
    lbChart = mount($('#ch-lb'), {
      grid: { left: 8, right: 56, top: 4, bottom: 4, containLabel: true },
      tooltip: { ...tooltipBase(), trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(127,127,127,.08)' } }, formatter: (ps) => { const x = list[ps[0].dataIndex]; return ttHead(trunc(x.title, 60)) + ttRow(c.profit, 'Net', money(x.net)) + ttRow(c.revenue, 'Revenue', money(x.revenueAll)) + `<div style="opacity:.6">${x.orders} orders · ${pct(x.margin)} margin</div>`; } },
      xAxis: { type: 'value', ...axisBase(), axisLabel: { ...axisBase().axisLabel, formatter: fmt } },
      yAxis: { type: 'category', data: list.map((x) => x.title), ...axisBase({ splitLine: { show: false } }), axisLabel: { color: c.ink2, fontSize: 11, width: 150, overflow: 'truncate' } },
      series: [{ type: 'bar', data: list.map((x) => ({ value: x[lbKey], itemStyle: { color: x[lbKey] < 0 ? c.bad : col } })), barWidth: 12, itemStyle: { borderRadius: [0, 4, 4, 0] }, label: { show: true, position: 'right', color: c.ink2, fontSize: 11, formatter: (p) => fmt(p.value) } }],
    });
  };
  drawLb();
  $('#lb-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $$('#lb-seg button').forEach((x) => x.classList.toggle('on', x === b));
    lbKey = b.dataset.k;
    drawLb();
  });

  const t = trackTable(new Tabulator('#prod-table', {
    data: prods.map((p) => ({ ...p, orders_n: p.orders, returnsN: p.returnCount })),
    layout: 'fitColumns',
    height: 520,
    placeholder: 'No products',
    initialSort: [{ column: 'net', dir: 'desc' }],
    columns: [
      { title: 'Product', field: 'title', minWidth: 260, widthGrow: 3, formatter: (cell) => `<span title="${esc(cell.getValue())}">${esc(cell.getValue())}</span>` },
      { title: 'Orders', field: 'orders_n', hozAlign: 'right', width: 90 },
      { title: 'Units', field: 'units', hozAlign: 'right', width: 80 },
      { title: 'Revenue', field: 'revenueAll', hozAlign: 'right', formatter: (c) => money(c.getValue()), width: 115 },
      { title: 'Avg sale', field: 'avgSale', hozAlign: 'right', formatter: (c) => money(c.getValue()), width: 100 },
      { title: 'Avg cost', field: 'avgCostPer', hozAlign: 'right', formatter: (c) => money(c.getValue()), width: 100 },
      { title: 'Fees', field: 'fees', hozAlign: 'right', formatter: (c) => money(c.getRow().getData().fees + c.getRow().getData().adFees), width: 100 },
      { title: 'Net profit', field: 'net', hozAlign: 'right', formatter: (c) => `<b class="${c.getValue() < 0 ? 'neg' : ''}">${money(c.getValue())}</b>`, width: 120 },
      { title: 'Margin', field: 'margin', hozAlign: 'right', formatter: (c) => pct(c.getValue()), width: 90 },
      { title: 'Returns', field: 'returnsN', hozAlign: 'right', formatter: (c) => { const d = c.getRow().getData(); return d.returnCount ? `${d.returnCount} <span class="muted">(${pct(d.returnRate, 0)})</span>` : '<span class="muted">0</span>'; }, width: 105 },
      { title: 'Last sold', field: 'lastSold', formatter: (c) => fmtDate(c.getValue()), width: 100 },
    ],
  }));
  $('#prod-q').addEventListener('input', (e) => { const v = e.target.value.toLowerCase(); t.setFilter((d) => d.title.toLowerCase().includes(v) || (d.sku || '').toLowerCase().includes(v)); });
  $('#prod-dl').onclick = () => t.download('csv', 'products.csv');
}

const trunc = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s || '');

// ---------------------------------------------------------------- ORDERS
function orders(el) {
  const all = scoped();
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  if (q.get('f')) state.ordersFilter = q.get('f');
  const filters = [
    ['all', 'All'], ['profitable', 'Profitable'], ['loss', 'Loss'], ['returned', 'Returned'], ['awaiting_cost', 'Awaiting cost'], ['cancelled', 'Cancelled'], ['excluded', 'Excluded'],
  ];
  const counts = Object.fromEntries(filters.map(([k]) => [k, k === 'all' ? all.length : all.filter((o) => matchFilter(o, k)).length]));
  el.innerHTML = `<div class="card"><div class="sheet-bar">
      <div class="seg" id="of-seg">${filters.map(([k, l]) => `<button data-f="${k}" class="${state.ordersFilter === k ? 'on' : ''}">${l} <span class="muted" style="font-weight:500">${counts[k]}</span></button>`).join('')}</div>
      <div class="search" style="margin-left:auto">${ICONS.search}<input class="input" id="ord-q" placeholder="Order #, item, buyer, Amazon #" /></div>
      <button class="btn sm" id="ord-dl">Export CSV</button>
    </div><div id="ord-table"></div></div>`;
  const t = trackTable(new Tabulator('#ord-table', {
    data: all,
    index: 'order_id',
    layout: 'fitColumns',
    height: 'calc(100vh - 200px)',
    placeholder: 'No orders match',
    selectableRows: false,
    initialSort: [{ column: 'created_at', dir: 'desc' }],
    columns: [
      { title: 'Date', field: 'created_at', width: 120, formatter: (c) => `${fmtDate(c.getValue())}<div class="muted" style="font-size:11px">${new Date(c.getValue()).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</div>` },
      { title: 'Item', field: 'title', minWidth: 240, widthGrow: 3, formatter: (c) => { const d = c.getRow().getData(); return `<div style="white-space:normal;line-height:1.3">${esc(trunc(d.title, 90))}</div><div class="mono muted" style="font-size:11px">${esc(d.order_id)}${d.units > 1 ? ` · ×${d.units}` : ''}</div>`; } },
      { title: 'Buyer', field: 'buyer', width: 130, formatter: (c) => { const d = c.getRow().getData(); return `${esc(d.buyer || '')}<div class="muted" style="font-size:11px">${esc([d.ship_city, d.ship_state].filter(Boolean).join(', '))}</div>`; } },
      { title: 'Revenue', field: 'revenue', hozAlign: 'right', width: 100, formatter: (c) => money(c.getValue()) },
      { title: 'Amazon', field: 'cost', hozAlign: 'right', width: 100, formatter: (c) => (c.getRow().getData().has_cost ? money(c.getValue()) : '<span class="muted">—</span>') },
      { title: 'Fees', field: 'fees', hozAlign: 'right', width: 90, formatter: (c) => money(c.getValue() + c.getRow().getData().ad_fees) },
      { title: 'Refund', field: 'refunds', hozAlign: 'right', width: 90, formatter: (c) => (c.getValue() ? money(c.getValue()) : '<span class="muted">—</span>') },
      { title: 'Net', field: 'net', hozAlign: 'right', width: 105, formatter: (c) => { const d = c.getRow().getData(); return d.has_cost && !d.excluded ? `<b class="${d.net < 0 ? 'neg' : 'pos'}">${money(d.net)}</b>` : '<span class="muted">pending</span>'; } },
      { title: 'Margin', field: 'margin', hozAlign: 'right', width: 85, formatter: (c) => (c.getRow().getData().has_cost ? pct(c.getValue()) : '') },
      { title: 'Status', field: 'status', width: 150, formatter: (c) => statusPill(c.getValue()) },
    ],
  }));
  const apply = () => {
    const v = ($('#ord-q').value || '').toLowerCase();
    t.setFilter((d) => matchFilter(d, state.ordersFilter) && (!v || [d.order_id, d.title, d.buyer, d.ship_name, ...d.amazon_orders.map((a) => a.amazon_order_id)].some((x) => (x || '').toLowerCase().includes(v))));
  };
  t.on('tableBuilt', apply);
  t.on('rowClick', (_e, row) => openOrder(row.getData().order_id));
  $('#of-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.ordersFilter = b.dataset.f;
    $$('#of-seg button').forEach((x) => x.classList.toggle('on', x === b));
    apply();
  });
  $('#ord-q').addEventListener('input', apply);
  $('#ord-dl').onclick = () => downloadCsv('orders.csv', t.getData('active'), ORDER_EXPORT);
}

const matchFilter = (o, f) => f === 'all' || o.status === f || (f === 'loss' && o.status === 'cancelled_after_purchase') || (f === 'cancelled' && o.status === 'cancelled_after_purchase');

export const ORDER_EXPORT = [
  { title: 'Date', get: (o) => o.created_at }, { title: 'eBay order', get: (o) => o.order_id }, { title: 'Item', get: (o) => o.title },
  { title: 'Units', get: (o) => o.units }, { title: 'Buyer', get: (o) => o.buyer }, { title: 'State', get: (o) => o.ship_state },
  { title: 'Revenue', get: (o) => o.revenue }, { title: 'Amazon cost', get: (o) => o.cost }, { title: 'eBay fees', get: (o) => o.fees },
  { title: 'Ad fees', get: (o) => o.ad_fees }, { title: 'Refunds', get: (o) => o.refunds }, { title: 'Amazon refund', get: (o) => o.amazon_refund },
  { title: 'Extra cost', get: (o) => o.extra_cost }, { title: 'Net profit', get: (o) => (o.has_cost ? o.net : '') }, { title: 'Status', get: (o) => o.status },
  { title: 'Amazon orders', get: (o) => o.amazon_orders.map((a) => a.amazon_order_id).join(' ') }, { title: 'Notes', get: (o) => o.overrides.notes },
];

// ---------------------------------------------------------------- order drawer
export function openOrder(id) {
  const o = state.data.orders.find((x) => x.order_id === id);
  if (!o) return;
  const c = colors();
  const row = (k, v, color, cls = '') => `<div class="calc-row ${cls}"><span class="k">${color ? `<i style="background:${color}"></i>` : ''}${k}</span><span>${v}</span></div>`;
  $('#drawer').innerHTML = `
    <div class="drawer-h">
      <div style="min-width:0">
        <div class="row" style="gap:8px">${statusPill(o.status)}<span class="mono muted">${esc(o.order_id)}</span></div>
        <div style="font-weight:650;font-size:15px;margin-top:8px;line-height:1.35">${esc(o.title)}</div>
        <div class="muted" style="font-size:12.5px;margin-top:4px">${o.approx_date ? `${new Date(o.created_at).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })} (from monthly sheet, exact date unknown)` : fmtDateTime(o.created_at)} · ${esc(o.buyer || '')} · ${esc([o.ship_name, o.ship_city, o.ship_state, o.ship_zip].filter(Boolean).join(', '))}</div>
      </div>
      <button class="btn icon-btn ghost" id="drawer-x" style="margin-left:auto" aria-label="Close">${ICONS.x}</button>
    </div>
    <div class="drawer-b">
      <h4>Profit math</h4>
      ${row('Revenue (buyer paid, excl. tax)', money(o.revenue), c.revenue)}
      ${row('Amazon cost', o.has_cost ? `−${money(o.cost)}` : '<span class="muted">not linked yet</span>', c.cost)}
      ${row('eBay fees', `−${money(o.fees)}${o.overrides.fee_override !== null ? ' <span class="pill">edited</span>' : ''}`, c.fees)}
      ${o.ad_fees ? row('Promoted listing fee', `−${money(o.ad_fees)}`, c.ads) : ''}
      ${o.refunds ? row('Refunded to buyer', `−${money(o.refunds)}`, c.refunds) : ''}
      ${o.amazon_refund ? row('Recovered from Amazon', `+${money(o.amazon_refund)}`, c.good) : ''}
      ${o.extra_cost ? row('Other costs', `−${money(o.extra_cost)}`, c.ink3) : ''}
      ${row('Net profit', o.has_cost && !o.excluded ? `<span class="${o.net < 0 ? 'neg' : 'pos'}">${money(o.net)}</span>` : '<span class="muted">pending</span>', null, 'total')}
      <div class="muted" style="font-size:12px">${o.has_cost ? `${pct(o.margin)} margin · ${pct(o.roi)} ROI` : 'Profit shows once an Amazon purchase is linked or a cost is entered in the Editor.'}${o.tax_collected ? ` · ${money(o.tax_collected)} sales tax collected by eBay (not revenue)` : ''}</div>

      ${o.ledger ? `<h4>Monthly sheet row</h4><div class="sub-card"><div class="t">${esc(o.ledger.title)}</div><div class="m"><span>${esc(o.ledger.month)}</span><span>Amazon cost ${money(o.ledger.amazon_cost)}</span><span>eBay payout ${money(o.ledger.sale_price)}</span>${o.ledger.note ? `<span>${esc(o.ledger.note)}</span>` : ''}</div><div class="m" style="margin-top:6px">${o.source === 'ledger' ? 'Revenue here is the eBay payout after eBay fees, as the sheet records it. When eBay syncs this sale, it is matched automatically and the real order takes over.' : 'This eBay order was matched to the sheet row. Its Amazon cost comes from the sheet.'}</div></div>` : ''}
      <h4>eBay items</h4>
      ${o.items.map((i) => `<div class="sub-card"><div class="t">${esc(i.title)}</div><div class="m"><span>Qty ${i.quantity}</span><span>${money(i.unit_price)} each</span>${i.sku ? `<span class="mono">SKU ${esc(i.sku)}</span>` : ''}${i.item_id ? `<a href="https://www.ebay.com/itm/${esc(i.item_id)}" target="_blank" rel="noopener">View listing ↗</a>` : ''}</div></div>`).join('')}

      <h4>Linked Amazon purchases</h4>
      ${o.amazon_orders.length ? o.amazon_orders.map((a) => `<div class="sub-card">
          <div class="row"><span class="mono">${esc(a.amazon_order_id)}</span><span class="pill ${a.method === 'manual' ? 'info' : 'good'}">${a.method === 'manual' ? 'Linked by hand' : 'Auto-matched'}</span><b style="margin-left:auto">${money(a.cost)}</b></div>
          <div class="m">${a.order_date ? `<span>Ordered ${fmtDate(a.order_date + 'T12:00')}</span>` : ''}${a.reasons ? `<span>${esc(a.reasons)}</span>` : ''}</div>
          ${a.lines.map((l) => `<div class="m" style="margin-top:6px"><span>${esc(trunc(l.title, 70))}</span><span>×${l.quantity}</span><span>${money(l.cost)}${l.ignored ? ' (ignored)' : ''}</span></div>`).join('')}
          <div style="margin-top:8px"><button class="btn sm danger" data-unlink="${esc(a.amazon_order_id)}">Unlink</button></div>
        </div>`).join('') : '<div class="muted" style="font-size:13px">None yet. Upload the Amazon CSV that has this purchase, or link it by hand in Editor → Amazon purchases.</div>'}

      ${o.returns.length ? `<h4>Returns</h4>${o.returns.map((r) => `<div class="sub-card"><div class="row"><b>${esc((r.reason || 'Return').replace(/_/g, ' ').toLowerCase())}</b><span class="pill warn" style="margin-left:auto">${esc((r.status || r.state || '').replace(/_/g, ' ').toLowerCase())}</span></div><div class="m"><span>Opened ${r.created_at ? fmtDate(r.created_at) : '—'}</span><span>Refund ${money(r.refund_amount)}</span></div></div>`).join('')}` : ''}

      ${o.overrides.notes ? `<h4>Notes</h4><div class="sub-card">${esc(o.overrides.notes)}</div>` : ''}
      <div class="row" style="margin-top:22px"><a class="btn" href="#/editor?order=${encodeURIComponent(o.order_id)}">${ICONS.editor} Edit in spreadsheet</a></div>
    </div>`;
  $('#drawer').classList.add('open');
  $('#scrim').classList.add('open');
  $('#drawer-x').onclick = closeDrawer;
  $$('[data-unlink]').forEach((b) => (b.onclick = async () => {
    if (!confirm('Unlink this Amazon order from the sale? It won\'t be auto-matched to this sale again.')) return;
    await api('/api/links', { method: 'POST', body: { amazon_order_id: b.dataset.unlink, ebay_order_id: null } });
    toast('Unlinked');
    await loadData();
    renderPage();
    openOrder(id);
  }));
}
export function closeDrawer() { $('#drawer').classList.remove('open'); $('#scrim').classList.remove('open'); }
$('#scrim').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
$('#drawer').addEventListener('click', (e) => { if (e.target.closest('a[href^="#/"]')) closeDrawer(); });

// ---------------------------------------------------------------- RETURNS
function returns(el) {
  const r = range();
  const all = scoped();
  if (!all.length) return emptyState(el);
  const c = colors();
  const s = summarize(all);
  const ret = all.filter((o) => o.returns.length || o.refunds > 0);
  const lossOnReturns = ret.filter((o) => o.counted).reduce((a, o) => a + Math.min(0, o.net), 0);
  const open = ret.filter((o) => o.returns.some((x) => !/CLOSED/i.test(x.state || '')));
  const recovered = ret.reduce((a, o) => a + o.amazon_refund, 0);
  const needRecovery = ret.filter((o) => o.has_cost && !o.amazon_refund && o.cost > 0);
  el.innerHTML = `
  <div class="kpis six">
    ${kpi({ label: 'Returned orders', sw: '--s-refunds', value: count(ret.length), foot: `${count(open.length)} still open` })}
    ${kpi({ label: 'Return rate', value: pct(s.returnRate), foot: 'of orders in range' })}
    ${kpi({ label: 'Refunded to buyers', value: money(s.refunds, 0) })}
    ${kpi({ label: 'Recovered from Amazon', sw: '--good', value: money(recovered, 0), foot: 'entered in Editor' })}
    ${kpi({ label: 'Net loss on returns', value: `<span class="${lossOnReturns < 0 ? 'neg' : ''}">${money(lossOnReturns, 0)}</span>` })}
    ${kpi({ label: 'Awaiting Amazon refund', value: count(needRecovery.length), foot: 'returns with no recovery logged', tip: 'Returned orders where you have not entered an Amazon refund yet' })}
  </div>
  <div class="grid g-12 mt">
    ${card('Returns over time', `${granLabel[autoGran(r, all)]} returned orders`, '<div class="chart" id="ch-ret"></div>', { cls: 'c-7' })}
    ${card('Return reasons', 'From eBay return cases', '<div class="chart" id="ch-reasons"></div>', { cls: 'c-5' })}
  </div>
  <div class="grid g-12 mt">
    ${card('Most-returned products', 'Products with at least one return', '<div class="table-wrap" id="ret-prod"></div>', { cls: 'c-6' })}
    ${card('Returned orders', 'Click a row for the full breakdown', '<div id="ret-table"></div>', { cls: 'c-6' })}
  </div>`;

  const gran = autoGran(r, all);
  const bs = buckets(r, all, gran);
  const labels = bs.map((b) => bucketLabel(b.key, gran));
  mount($('#ch-ret'), {
    grid: { left: 8, right: 12, top: 16, bottom: 4, containLabel: true },
    tooltip: { ...tooltipBase(), trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(127,127,127,.08)' } }, formatter: (ps) => { const b = bs[ps[0].dataIndex]; return ttHead(labels[ps[0].dataIndex]) + ttRow(c.refunds, 'Returned orders', count(b.returnCount)) + ttRow(c.ink3, 'Return rate', pct(b.returnRate)) + ttRow(c.ink3, 'Refunded', money(b.refunds)); } },
    xAxis: { type: 'category', data: labels, ...axisBase({ splitLine: { show: false } }) },
    yAxis: { type: 'value', ...axisBase(), axisLine: { show: false }, minInterval: 1 },
    series: [{ type: 'bar', data: bs.map((b) => b.returnCount), barMaxWidth: 22, itemStyle: { color: c.refunds, borderRadius: [4, 4, 0, 0] } }],
  });

  const reasons = [...groupBy(ret.flatMap((o) => (o.returns.length ? o.returns : [{ reason: 'Refund (no case)' }])), (x) => (x.reason || 'Unknown').replace(/_/g, ' ').toLowerCase()).entries()]
    .map(([k, v]) => ({ k: k[0].toUpperCase() + k.slice(1), n: v.length })).sort((a, b) => a.n - b.n);
  mount($('#ch-reasons'), {
    grid: { left: 8, right: 40, top: 4, bottom: 4, containLabel: true },
    tooltip: { ...tooltipBase(), trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(127,127,127,.08)' } }, formatter: (ps) => ttHead(reasons[ps[0].dataIndex].k) + `${ps[0].value} returns` },
    xAxis: { type: 'value', ...axisBase(), minInterval: 1 },
    yAxis: { type: 'category', data: reasons.map((x) => x.k), ...axisBase({ splitLine: { show: false } }), axisLabel: { color: c.ink2, fontSize: 11.5 } },
    series: [{ type: 'bar', data: reasons.map((x) => x.n), barWidth: 14, itemStyle: { color: c.refunds, borderRadius: [0, 4, 4, 0] }, label: { show: true, position: 'right', color: c.ink2, fontSize: 11 } }],
  });

  const prodRet = byProduct(all).filter((p) => p.returnCount > 0).sort((a, b) => b.returnCount - a.returnCount || b.returnRate - a.returnRate).slice(0, 12);
  $('#ret-prod').innerHTML = prodRet.length ? `<table class="simple"><thead><tr><th>Product</th><th class="r">Returns</th><th class="r">Rate</th><th class="r">Net</th></tr></thead><tbody>
    ${prodRet.map((p) => `<tr><td title="${esc(p.title)}">${esc(trunc(p.title, 48))}</td><td class="r">${p.returnCount}</td><td class="r ${p.returnRate > 0.1 ? 'neg' : ''}">${pct(p.returnRate, 0)}</td><td class="r ${p.net < 0 ? 'neg' : ''}">${money(p.net)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No returns in this range 🎉</div>';

  const t = trackTable(new Tabulator('#ret-table', {
    data: ret, layout: 'fitColumns', height: 420, placeholder: 'No returns in this range',
    initialSort: [{ column: 'created_at', dir: 'desc' }],
    columns: [
      { title: 'Sold', field: 'created_at', width: 90, formatter: (c) => fmtDate(c.getValue()) },
      { title: 'Item', field: 'title', minWidth: 160, formatter: (c) => esc(trunc(c.getValue(), 50)) },
      { title: 'Refund', field: 'refunds', hozAlign: 'right', width: 90, formatter: (c) => money(c.getValue()) },
      { title: 'Net', field: 'net', hozAlign: 'right', width: 90, formatter: (c) => (c.getRow().getData().has_cost ? `<span class="${c.getValue() < 0 ? 'neg' : 'pos'}">${money(c.getValue())}</span>` : '—') },
    ],
  }));
  t.on('rowClick', (_e, row) => openOrder(row.getData().order_id));
}

// ---------------------------------------------------------------- IMPORT
async function importPage(el) {
  el.innerHTML = `
  <div class="grid g-12">
    <div class="c-7 stack">
      <label class="dropzone" id="dz">
        <input type="file" id="file" accept=".csv,text/csv" multiple hidden />
        ${ICONS.import}
        <div class="t">Drop your Amazon order CSV here</div>
        <div class="s">or click to choose files · overlapping weeks are fine, nothing gets double-counted</div>
      </label>
      <div id="import-result"></div>
      ${card('Upload history', 'Every CSV you have imported', '<div class="table-wrap" id="imports"></div>')}
    </div>
    <div class="c-5 stack">
      ${card('How the import works', '', `<ol class="rules">
        <li><b>No duplicates.</b> Rows are keyed by Amazon <b>order number</b> + item. Re-uploading last week's rows updates them and never adds a copy.</li>
        <li><b>Only eBay sales count.</b> An Amazon order only affects profit once it's linked to an eBay sale. Everything else you buy is stored but <b>ignored</b>.</li>
        <li><b>Auto-linking needs proof.</b> It links only when the Amazon ship-to matches the eBay buyer's <b>zip</b> or <b>name</b>, or the <b>tracking number</b> matches, within a week after the sale.</li>
        <li><b>Title-only look-alikes never auto-link.</b> They show up in Editor → Match review for you to approve or reject.</li>
        <li><b>Your home address is always personal.</b> Anything shipped to a home zip in Settings is never matched.</li>
      </ol>`)}
      ${card('Which CSV to export', 'Email import (Settings) handles this automatically. CSVs are a backup or backfill.', `<div style="font-size:13px" class="ink2">
        <p style="margin-top:0"><b>Fastest</b>: the free Chrome extension <i>Amazon Order History Reporter</i> exports your orders as a CSV right away.</p>
        <p><b>Amazon Business</b>: Business Analytics → Reports → <i>Orders and shipments</i> → download CSV.</p>
        <p><b>Regular Amazon account</b>: Account → <i>Request your data</i> → "Your Orders" (can take days). Upload <span class="mono">Retail.OrderHistory.1.csv</span> from the zip.</p>
        <p style="margin-bottom:0"><b>Order history extensions</b> (e.g. Amazon Order History Reporter) also work. Any CSV with an order-number column, a date, a total and the ship-to address works.</p></div>`)}
    </div>
  </div>`;
  const dz = $('#dz');
  const input = $('#file');
  input.addEventListener('change', () => upload([...input.files]));
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('over'); upload([...e.dataTransfer.files].filter((f) => /\.csv$/i.test(f.name) || f.type.includes('csv'))); });
  loadImports();

  async function upload(files) {
    if (!files.length) return;
    const fd = new FormData();
    files.forEach((f) => fd.append('files', f));
    $('#import-result').innerHTML = `<div class="card"><div class="card-b row"><span class="dot spin"></span>Importing ${files.length} file${files.length > 1 ? 's' : ''} and matching to eBay sales…</div></div>`;
    try {
      const results = await api('/api/amazon/import', { method: 'POST', body: fd });
      $('#import-result').innerHTML = results.map((r) => r.kind === 'ledger' ? card(`${ICONS.check.replace('<svg', '<svg style="width:15px;height:15px;color:var(--good-ink);vertical-align:-2px"')} ${esc(r.filename)}`, `Monthly settlement sheet · ${esc(r.month)}`, `
        <div class="result-grid">
          <div class="result-cell"><div class="v">${count(r.linesNew)}</div><div class="k">new sales rows</div></div>
          <div class="result-cell"><div class="v">${count(r.linesUnchanged + r.linesUpdated)}</div><div class="k">already imported (${count(r.linesUpdated)} updated), not duplicated</div></div>
          <div class="result-cell"><div class="v">${money(r.expenseTotal, 2)}</div><div class="k">${count(r.expenses)} operating expenses</div></div>
          <div class="result-cell"><div class="v">${count(r.matchedToEbay)}</div><div class="k">rows matched to synced eBay orders</div></div>
        </div>
        <div style="margin-top:10px;font-size:12.5px" class="${r.checks.every((c) => c.ok) ? 'pos' : 'neg'}">${r.checks.length ? (r.checks.every((c) => c.ok) ? '✓ Totals match the sheet’s Total Transactions row' : `Totals differ from the sheet: ${r.checks.filter((c) => !c.ok).map((c) => `${c.field} sheet ${c.sheet} vs ${c.computed}`).join(', ')}`) : ''}</div>`) : card(`${ICONS.check.replace('<svg', '<svg style="width:15px;height:15px;color:var(--good-ink);vertical-align:-2px"')} ${esc(r.filename)}`, `${esc(r.format)} · ${count(r.rowsInFile)} rows`, `
        <div class="result-grid">
          <div class="result-cell"><div class="v">${count(r.linesNew)}</div><div class="k">new purchase lines</div></div>
          <div class="result-cell"><div class="v">${count(r.linesUnchanged + r.linesUpdated)}</div><div class="k">already imported (${count(r.linesUpdated)} updated), not duplicated</div></div>
          <div class="result-cell"><div class="v pos">${count(r.ordersLinked)}</div><div class="k">orders linked to eBay sales</div></div>
          <div class="result-cell"><div class="v">${count(r.ordersIgnored)}</div><div class="k">orders ignored (not eBay sales)</div></div>
          ${r.suggestions ? `<div class="result-cell"><div class="v" style="color:var(--warn)">${count(r.suggestions)}</div><div class="k"><a href="#/editor?tab=matches">possible matches to review →</a></div></div>` : ''}
        </div>`)).join('');
      toast('Import complete', 'good');
      await loadData();
      loadImports();
    } catch (e) {
      $('#import-result').innerHTML = `<div class="banner">${ICONS.alert}<div><b>Import failed.</b> ${esc(e.message)}</div></div>`;
    }
    input.value = '';
  }
  async function loadImports() {
    const rows = await api('/api/imports');
    $('#imports').innerHTML = rows.length ? `<table class="simple"><thead><tr><th>Uploaded</th><th>File</th><th class="r">Rows</th><th class="r">New</th><th class="r">Already had</th><th class="r">Linked</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${fmtDateTime(r.uploaded_at)}</td><td title="${esc(r.format)}">${esc(r.filename)}</td><td class="r">${count(r.rows_in_file)}</td><td class="r">${count(r.lines_new)}</td><td class="r">${count(r.lines_unchanged + r.lines_updated)}</td><td class="r">${count(r.orders_linked)} / ${count(r.orders_in_file)}</td></tr>`).join('')}
    </tbody></table>` : '<div class="empty">No uploads yet</div>';
  }
}

// ---------------------------------------------------------------- SETTINGS
async function settings(el) {
  const ebayMsg = new URLSearchParams(location.hash.split('?')[1] || '').get('ebay');
  if (ebayMsg) {
    toast(ebayMsg === 'connected' ? 'eBay connected. Pulling your sales now.' : `eBay: ${ebayMsg}`, ebayMsg === 'connected' ? 'good' : 'bad');
    history.replaceState(null, '', '#/settings');
  }
  const d = state.data;
  const e = d.ebay;
  const demo = d.orders.filter((o) => o.order_id.startsWith('DEMO-')).length;
  const log = await api('/api/sync-log').catch(() => []);
  const em = d.email;
  const mails = em.configured ? await api('/api/email/log').catch(() => []) : [];
  el.innerHTML = `<div class="grid g-12">
    <div class="c-7 stack">
      ${ebayCard(e, log)}
      ${emailCard(em, mails)}
      ${card('Matching rules', 'Controls how Amazon purchases link to eBay sales', `
        <label style="font-weight:600;font-size:13px">Home / personal zip codes</label>
        <div class="muted" style="font-size:12.5px;margin:2px 0 8px">Amazon orders shipped to these zips are always treated as personal and never counted.</div>
        <div class="row"><input class="input" id="home-zips" style="flex:1" placeholder="e.g. 62701, 62702" value="${esc((d.settings.home_zips || []).join(', '))}" /></div>
        <div class="row mt"><button class="btn" id="rematch">Re-run matcher</button><span class="muted" style="font-size:12px">Looks for new links among unlinked Amazon orders. Existing links are kept.</span></div>`)}
    </div>
    <div class="c-5 stack">
      ${card('Partners', 'Used by the Settlement page', `<div class="grid" style="grid-template-columns:1fr 1fr;gap:10px">
        <label style="font-size:12.5px" class="ink2">Pays Amazon (COGS)<input class="input" id="p-amazon" style="width:100%;margin-top:4px" value="${esc(d.settings.partner_amazon)}" /></label>
        <label style="font-size:12.5px" class="ink2">Collects eBay, pays expenses<input class="input" id="p-ebay" style="width:100%;margin-top:4px" value="${esc(d.settings.partner_ebay)}" /></label>
        <label style="font-size:12.5px" class="ink2">Profit share to the Amazon partner (%)<input class="input" id="p-split" type="number" min="0" max="100" style="width:100%;margin-top:4px" value="${Number(d.settings.split_amazon)}" /></label></div>`)}
      ${card('Goals', '', `<label style="font-weight:600;font-size:13px">Monthly net profit goal</label>
        <div class="row" style="margin-top:8px"><input class="input" id="goal" type="number" min="0" step="50" style="flex:1" value="${Number(d.settings.monthly_goal) || ''}" placeholder="2500" /></div>`)}
      <div class="row"><button class="btn primary" id="save-settings">${ICONS.save} Save settings</button></div>
      ${card('Data', '', `
        <div class="stat-row"><span class="k">Database</span><span class="v">${d.db === 'local-postgres' ? 'Local embedded Postgres' : 'Supabase Postgres'}</span></div>
        <div class="stat-row"><span class="k">eBay orders stored</span><span class="v">${count(d.orders.length)}</span></div>
        <div class="stat-row"><span class="k">Amazon orders stored</span><span class="v">${count(d.amazon.orders)} (${count(d.amazon.linked)} linked)</span></div>
        <div class="row mt"><button class="btn" id="export-all">Export all orders (CSV)</button>
        ${demo ? `<button class="btn danger" id="clear-demo">Remove ${count(demo)} demo orders</button>` : ''}</div>`)}
    </div></div>`;
  $('#sync-now')?.addEventListener('click', () => $('#sync-btn').click());
  $('#mail-now')?.addEventListener('click', async (ev) => {
    ev.target.disabled = true;
    ev.target.textContent = 'Checking…';
    const r = await api('/api/email/sync', { method: 'POST' }).catch((e) => ({ ok: false, log: [e.message] }));
    toast(r.log.join(' · '), r.ok ? 'good' : 'bad');
    await loadData();
    renderPage();
  });
  $('#save-settings').onclick = async () => {
    await api('/api/settings', { method: 'POST', body: { home_zips: $('#home-zips').value.split(/[,\s]+/).filter(Boolean), monthly_goal: $('#goal').value, partner_amazon: $('#p-amazon').value, partner_ebay: $('#p-ebay').value, split_amazon: $('#p-split').value } });
    toast('Settings saved', 'good');
    await loadData();
  };
  $('#rematch').onclick = async () => { const r = await api('/api/rematch', { method: 'POST' }); toast(`${r.linked} new links · ${r.suggestions} to review`); await loadData(); };
  $('#export-all').onclick = () => downloadCsv('all-orders.csv', d.orders, ORDER_EXPORT);
  $('#clear-demo')?.addEventListener('click', async () => {
    if (!confirm('Remove all demo orders and demo Amazon rows? Your real data is untouched.')) return;
    await api('/api/demo/clear', { method: 'POST' });
    toast('Demo data removed', 'good');
    await loadData();
    renderPage();
  });
}

function ebayCard(e, log) {
  const h4 = (t) => `<h4 style="margin:18px 0 6px;font-size:11.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--ink-3)">${t}</h4>`;
  const has = (k) => !e.missing.includes(k);
  const pill = (ok, yes = 'set', no = 'missing') => (ok ? `<span class="pill good">${yes}</span>` : `<span class="pill bad">${no}</span>`);
  const expSoon = e.refreshExpiresAt && new Date(e.refreshExpiresAt) - Date.now() < 30 * 86400_000;
  const connectBtn = e.canConnect
    ? `<a class="btn primary" href="/api/ebay/connect">${e.configured ? 'Reconnect eBay' : 'Connect eBay account'}</a>`
    : '<button class="btn" disabled title="Set EBAY_CLIENT_ID, EBAY_CLIENT_SECRET and EBAY_RUNAME first">Connect eBay account</button>';
  const rows = `<table class="simple"><tbody>
      <tr><td class="mono">EBAY_CLIENT_ID</td><td>App ID (Production)</td><td>${pill(has('EBAY_CLIENT_ID'))}</td></tr>
      <tr><td class="mono">EBAY_CLIENT_SECRET</td><td>Cert ID (Production)</td><td>${pill(has('EBAY_CLIENT_SECRET'))}</td></tr>
      <tr><td class="mono">EBAY_RUNAME</td><td>RuName from eBay → User Tokens → Your eBay Sign-in Settings</td><td>${pill(e.runameSet)}</td></tr>
      <tr><td>eBay account</td><td>Click Connect and approve on eBay</td><td>${pill(e.configured, 'connected', 'not connected')}</td></tr>
    </tbody></table>`;
  const status = e.configured ? `
      <div class="stat-row"><span class="k">Status</span><span class="v">${e.needsReconnect ? '<span class="pill bad">Reconnect needed</span>' : e.last?.ok ? '<span class="pill good">Syncing</span>' : e.last ? '<span class="pill bad">Last sync failed</span>' : '<span class="pill warn">Not synced yet</span>'}</span></div>
      <div class="stat-row"><span class="k">Last successful sync</span><span class="v">${e.lastSuccess ? fmtDateTime(e.lastSuccess) : '—'}</span></div>
      ${e.connectedAt ? `<div class="stat-row"><span class="k">Connected</span><span class="v">${fmtDateTime(e.connectedAt)}</span></div>` : ''}
      ${e.refreshExpiresAt ? `<div class="stat-row"><span class="k">Connection valid until</span><span class="v ${expSoon ? 'neg' : ''}">${fmtDate(e.refreshExpiresAt, { month: 'short', day: 'numeric', year: 'numeric' })}${expSoon ? ', reconnect soon' : ''}</span></div>` : ''}` : '';
  const logHtml = log.length ? `${h4('Recent syncs')}<table class="simple"><tbody>${log.slice(0, 6).map((l) => `<tr><td style="white-space:nowrap">${fmtDateTime(l.started_at)}</td><td>${l.ok ? '<span class="pill good">ok</span>' : l.finished_at ? '<span class="pill bad">failed</span>' : '<span class="pill">running</span>'}</td><td class="muted" style="font-size:12px">${esc(l.message || '')}</td></tr>`).join('')}</tbody></table>` : '';
  return card('eBay connection', e.configured ? 'Connected' : 'Not connected yet', `
    ${status}
    ${e.configured ? '' : rows}
    <div class="row mt">${connectBtn}${e.configured ? '<button class="btn" id="sync-now">Sync now</button>' : ''}<span class="muted" style="font-size:12px">Syncs automatically every 30 minutes once connected</span></div>
    ${logHtml}`);
}

function emailCard(em, mails) {
  const h4 = (t) => `<h4 style="margin:18px 0 6px;font-size:11.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--ink-3)">${t}</h4>`;
  const intro = '<p class="ink2" style="margin-top:0;font-size:13px">Reads only mail <b>from amazon.com</b>: order confirmations (cost, ship-to, items), cancellations (cost drops to $0) and refunds (logged as money recovered from Amazon). Uses the same order-number dedupe as the CSV. If a CSV later includes the order, the CSV row replaces the email row.</p>';
  if (!em.configured) {
    return card('Amazon purchases from email', 'Not connected yet', `${intro}
      <table class="simple"><tbody>
        <tr><td class="mono">EMAIL_USER</td><td>${em.user ? esc(em.user) : 'your Gmail address'}</td><td>${em.user ? '<span class="pill good">set</span>' : '<span class="pill bad">missing</span>'}</td></tr>
        <tr><td class="mono">EMAIL_PASSWORD</td><td>Gmail <b>App Password</b> (16 letters), not your normal password</td><td><span class="pill bad">missing</span></td></tr>
      </tbody></table>
      <p class="muted" style="font-size:12.5px;margin-bottom:0">Create one at <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener">myaccount.google.com/apppasswords</a> (2-Step Verification must be on). Put it in <span class="mono">.env</span> or Railway Variables, then restart.</p>`);
  }
  const rows = mails.map((m) => `<tr><td style="white-space:nowrap">${m.received_at ? fmtDate(m.received_at) : ''}</td>
    <td><span class="pill ${m.kind === 'order' ? 'info' : m.kind === 'refund' ? 'good' : 'warn'}">${m.kind}</span></td>
    <td style="font-size:12.5px">${esc(m.subject)}<div class="muted mono" style="font-size:11px">${esc((m.order_ids || []).join(' '))}${m.note ? ` · ${esc(m.note)}` : ''}</div></td>
    <td>${m.ok ? '' : '<span class="pill bad">review</span>'}</td></tr>`).join('');
  return card('Amazon purchases from email', `Reading ${esc(em.user)}`, `${intro}
    <div class="stat-row"><span class="k">Last check</span><span class="v">${em.last ? `${em.last.ok ? '<span class="pill good">ok</span>' : '<span class="pill bad">failed</span>'} ${fmtDateTime(em.last.at)}` : '—'}</span></div>
    ${em.last ? `<div class="muted" style="font-size:12.5px;padding:6px 0">${esc(em.last.log.join(' · '))}</div>` : ''}
    <div class="row mt"><button class="btn primary" id="mail-now">Check email now</button><span class="muted" style="font-size:12px">Also runs every 30 minutes</span></div>
    ${mails.length ? `${h4('Recent Amazon emails')}<div class="table-wrap" style="max-height:320px;overflow:auto"><table class="simple"><tbody>${rows}</tbody></table></div>` : ''}`);
}

// ---------------------------------------------------------------- boot
renderRangeSeg();
route();
loadData().then(route).catch((e) => { $('#content').innerHTML = `<div class="banner">${ICONS.alert}<div><b>Couldn't load data.</b> ${esc(e.message)}</div></div>`; });
