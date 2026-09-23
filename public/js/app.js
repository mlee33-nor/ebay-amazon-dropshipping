import { $, $$, esc, money, moneyShort, pct, count, signed, fmtDate, fmtDateTime, ago, api, toast, downloadCsv, ICONS, DAY, ymd, countUp, dismissed, settlementDueDate, dueStatus, syncInProgress, syncFailed, monthLabel, settleView, orderLabel } from './util.js';
import { rangeFor, previousRange, inRange, summarize, buckets, autoGran, byProduct, groupBy, STATUS_META, bucketKey, opexFor } from './metrics.js';
import { mount, disposeAll, colors, tooltipBase, axisBase, ttRow, ttHead, ttNote, sparkline, shadowPointer, crosshair, areaFade } from './charts.js';
import { renderEditor } from './editor.js';
import { renderSettlement } from './settle-page.js';
import { renderOpex } from './opex-page.js';
import { renderAsk } from './ask-page.js';
import { renderListingsPanel } from './listings-panel.js';
import { renderWatch } from './watch-page.js';
import { renderReports } from './reports-page.js';
import { settleMonth, monthKey, allMonths } from './settlement.js';

// ---------------------------------------------------------------- state
const store = (k, v) => { try { if (v === undefined) return JSON.parse(localStorage.getItem(k)); localStorage.setItem(k, JSON.stringify(v)); } catch { return null; } };
export const state = {
  data: null,
  range: store('dd_range') || '30d',
  month: store('dd_month') || `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`,
  custom: store('dd_custom') || { from: ymd(Date.now() - 29 * DAY), to: ymd(Date.now()) },
  gran: null,
  page: 'overview',
  ordersFilter: 'all',
  compare: store('dd_compare') || false,
};
const tables = new Set();
export const trackTable = (t) => { tables.add(t); return t; };

const PAGES = [
  { id: 'overview', label: 'Overview', icon: 'overview', sub: 'Profit at a glance', group: 'Insights' },
  { id: 'ask', label: 'Ask AI', icon: 'spark', sub: 'Ask about the business in your own words · every answer comes straight from your numbers', noRange: true, group: 'Insights' },
  { id: 'trends', label: 'Analytics', icon: 'trends', sub: 'Patterns, timing, pricing and geography', group: 'Insights' },
  { id: 'products', label: 'Products', icon: 'products', sub: 'What sells, what earns, what bleeds', group: 'Insights' },
  { id: 'orders', label: 'Orders', icon: 'orders', sub: 'Every eBay sale with its full profit math', group: 'Insights' },
  { id: 'watch', label: 'Watchlist', icon: 'alert', sub: 'Money to chase and things to fix: Amazon refunds, unmatched purchases, weak products', noRange: true, group: 'Insights' },
  { id: 'returns', label: 'Returns', icon: 'returns', sub: 'Refunds, reasons and recovery', group: 'Insights' },
  { id: 'settlement', label: 'Settlement', icon: 'settle', sub: 'Monthly partner settlement', noRange: true, group: 'Partners' },
  { id: 'reports', label: 'Reports', icon: 'receipt', sub: 'Monthly statement for the partners and the year-end export for taxes', noRange: true, group: 'Partners' },
  { id: 'costs', label: 'Operating costs', icon: 'wallet', sub: 'Monthly business expenses that come out of profit before the split', noRange: true, group: 'Partners' },
  { id: 'editor', label: 'Editor', icon: 'editor', sub: 'Spreadsheet mode: manual adjustments and matching', noRange: true, group: 'Data' },
  { id: 'import', label: 'Monthly sheets', icon: 'sheet', sub: 'Upload the partner settlement sheets', noRange: true, group: 'Data' },
  { id: 'settings', label: 'Settings', icon: 'settings', sub: 'eBay connection, Amazon email import, partners, goals', noRange: true, group: 'Data' },
];

// ---------------------------------------------------------------- data
export async function loadData() {
  state.data = await api('/api/data');
  renderRangeSeg();
  renderSidebarFoot();
  renderNav();
  return state.data;
}

const range = () => rangeFor(state.range, state.custom, state.month);
const scoped = () => inRange(state.data.orders, range());
const prevScoped = () => inRange(state.data.orders, previousRange(range()));

// ---------------------------------------------------------------- shell
function renderNav() {
  const d = state.data;
  const badges = {
    editor: d?.amazon?.suggestions || 0,
    orders: d ? d.orders.filter((o) => o.status === 'awaiting_cost').length : 0,
  };
  const groups = [];
  for (const p of PAGES) {
    let g = groups.find((x) => x.name === p.group);
    if (!g) { g = { name: p.group, pages: [] }; groups.push(g); }
    g.pages.push(p);
  }
  $('#nav').innerHTML = groups.map((g) => `<div class="nav-label">${g.name}</div>${g.pages.map(navLink).join('')}`).join('');
  function navLink(p) {
    let b = '';
    if (p.id === 'editor' && badges.editor) b = `<span class="badge" title="Suggested matches to review">${badges.editor}</span>`;
    else if (p.id === 'orders' && badges.orders) b = `<span class="nav-count" title="Sales awaiting their Amazon order email">${badges.orders}</span>`;
    return `<a href="#/${p.id}" class="${state.page === p.id ? 'active' : ''}" ${state.page === p.id ? 'aria-current="page"' : ''}>${ICONS[p.icon]}<span>${p.label}</span>${b}</a>`;
  }
}

function renderSidebarFoot() {
  const e = state.data?.ebay;
  if (!e) return;
  let dot = 'warn';
  let line = 'Not connected';
  let action = 'Set up';
  if (syncInProgress(e)) { dot = 'spin'; line = 'Syncing now…'; action = ''; }
  else if (e.needsReconnect) { dot = 'bad'; line = 'Needs reconnect'; action = 'Fix'; }
  else if (e.configured && e.last?.ok) { dot = 'ok'; line = `Synced ${ago(e.lastSuccess)}`; action = ''; }
  else if (e.configured && syncFailed(e)) { dot = 'bad'; line = 'Last sync failed'; action = 'Details'; }
  else if (e.configured) { dot = 'warn'; line = 'Waiting for first sync'; action = ''; }
  const az = state.data.amazon;
  const em = emailState();
  $('#sidebar-foot').innerHTML = `
    <div class="status-row"><span class="dot ${dot}"></span><div><div class="st-t">eBay sales</div><div class="st-s">${line}</div></div>${action ? `<a class="st-a" href="#/settings">${action}</a>` : ''}</div>
    <div class="status-row"><span class="dot ${em.dot}"></span><div><div class="st-t">Amazon email</div><div class="st-s">${em.line}</div></div>${em.action ? `<a class="st-a" href="#/settings?focus=email">${em.action}</a>` : ''}</div>
    <div class="status-row"><span class="dot ${az.orders ? 'ok' : ''}"></span><div><div class="st-t">Amazon purchases</div><div class="st-s">${az.orders ? `${count(az.linked)} of ${count(az.orders)} linked${az.latest ? ` · latest ${fmtDate(az.latest)}` : ''}` : 'None yet'}</div></div></div>
    <div class="status-foot"><span>${ICONS.db.replace('<svg', '<svg style="width:12px;height:12px;margin-right:5px;opacity:.7"')}${state.data.db === 'local-postgres' ? 'Local database' : 'Supabase Postgres'}</span><span class="mono" style="font-size:10.5px">${count(state.data.orders.length)} sales</span></div>`;
}

function emailState() {
  const m = state.data.email;
  if (!m.configured) return { dot: 'warn', line: 'Not connected', action: 'Set up' };
  if (m.running) return { dot: 'spin', line: 'Checking mail…', action: '' };
  if (m.last?.ok) return { dot: 'ok', line: `Checked ${ago(m.last.at)}`, action: '' };
  if (m.last) return { dot: 'bad', line: 'Last check failed', action: 'Details' };
  return { dot: 'warn', line: 'Not checked yet', action: '' };
}

const RANGES = [['1d', '1D'], ['7d', '7D'], ['30d', '30D'], ['90d', '90D'], ['mtd', 'MTD'], ['ytd', 'YTD'], ['12m', '12M'], ['all', 'All'], ['month', 'Month'], ['custom', 'Custom']];
function renderRangeSeg() {
  $('#range-seg').innerHTML = RANGES.map(([k, l]) => `<button data-r="${k}" class="${state.range === k ? 'on' : ''}">${l}</button>`).join('');
  $('#custom-range').classList.toggle('hidden', state.range !== 'custom');
  // Month picker: every month that has sales, plus the last 12 calendar months
  const months = new Set();
  const now = new Date();
  for (let i = 0; i < 12; i++) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); months.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`); }
  for (const o of state.data?.orders || []) { const d = new Date(o.created_at); months.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`); }
  $('#month-pick').innerHTML = [...months].sort().reverse().map((k) => { const [y, mo] = k.split('-').map(Number); return `<option value="${k}" ${k === state.month ? 'selected' : ''}>${new Date(y, mo - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</option>`; }).join('');
  $('#month-pick').classList.toggle('hidden', state.range !== 'month');
  $('#from-date').value = state.custom.from;
  $('#to-date').value = state.custom.to;
  requestAnimationFrame(() => {
    const on = $('#range-seg button.on');
    if (on && $('#range-seg').scrollWidth > $('#range-seg').clientWidth) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    updateSegFade($('#range-seg'));
  });
}
$('#range-seg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.range = b.dataset.r;
  store('dd_range', state.range);
  renderRangeSeg();
  renderPage();
});
$('#month-pick').addEventListener('change', (e) => { state.month = e.target.value; store('dd_month', state.month); renderPage(); });
for (const id of ['#from-date', '#to-date'])
  $(id).addEventListener('change', () => {
    let from = $('#from-date').value;
    let to = $('#to-date').value;
    const valid = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v);
    // A cleared or half-typed date keeps the previous range instead of silently falling back to 30 days
    if (!valid(from) || !valid(to)) {
      $('#from-date').value = state.custom.from;
      $('#to-date').value = state.custom.to;
      toast('Pick both a From and a To date. The previous range is kept.', 'bad');
      return;
    }
    if (from > to) { [from, to] = [to, from]; toast('From was after To, so the dates were swapped'); }
    state.custom = { from, to };
    $('#from-date').value = from;
    $('#to-date').value = to;
    store('dd_custom', state.custom);
    renderPage();
  });

// Range bar on phones: fade whichever edge has more presets hidden behind it, so it reads as scrollable
function updateSegFade(seg) {
  if (!seg) return;
  const over = seg.scrollWidth - seg.clientWidth > 2;
  seg.classList.toggle('scroll-fade-l', over && seg.scrollLeft > 2);
  seg.classList.toggle('scroll-fade-r', over && seg.scrollLeft < seg.scrollWidth - seg.clientWidth - 2);
}
$('#range-seg').addEventListener('scroll', () => updateSegFade($('#range-seg')), { passive: true });
window.addEventListener('resize', () => updateSegFade($('#range-seg')));

function setThemeIcon() {
  const dark = (document.documentElement.dataset.theme || 'dark') === 'dark';
  $('#theme-btn').innerHTML = dark ? ICONS.sun : ICONS.moon;
}
$('#theme-btn').addEventListener('click', () => {
  const next = (document.documentElement.dataset.theme || 'dark') === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('dd_theme', next); } catch {}
  setThemeIcon();
  syncThemeColor();
  renderPage();
});
// Keep the browser chrome (mobile address bar) the same colour as the page background
function syncThemeColor() {
  const m = document.querySelector('meta[name="theme-color"]');
  if (m) m.content = getComputedStyle(document.documentElement).getPropertyValue('--page').trim() || '#09090b';
}
if (!document.documentElement.dataset.theme) document.documentElement.dataset.theme = 'dark';
setThemeIcon();
syncThemeColor();

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

function setSidebar(open) {
  $('#sidebar').classList.toggle('open', open);
  $('#nav-scrim').classList.toggle('open', open);
  $('#menu-btn').setAttribute('aria-expanded', String(open));
}
$('#menu-btn').addEventListener('click', () => setSidebar(!$('#sidebar').classList.contains('open')));
$('#nav-scrim').addEventListener('click', () => setSidebar(false));
$('#sidebar').addEventListener('click', (e) => { if (e.target.closest('a')) setSidebar(false); });

// Soft notices can be dismissed for the session; the × lives inside the rendered banner markup.
$('#content').addEventListener('click', (e) => {
  const x = e.target.closest('.banner-x');
  if (!x) return;
  const b = x.closest('.banner');
  dismissed.add(x.dataset.k);
  b.style.transition = 'opacity .2s, transform .2s';
  b.style.opacity = '0';
  b.style.transform = 'translateY(-4px)';
  setTimeout(() => { const wrap = b.parentElement; b.remove(); if (wrap?.classList.contains('banners') && !wrap.children.length) wrap.remove(); }, 200);
});

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
  $('#page-sub').textContent = p.noRange ? p.sub : `${p.sub} · ${r.start ? rangeText(r) : 'All time'}`;
  $('#range-seg').parentElement.querySelector('.seg').classList.toggle('hidden', Boolean(p.noRange));
  $('#custom-range').classList.toggle('hidden', Boolean(p.noRange) || state.range !== 'custom');
  $('#month-pick').classList.toggle('hidden', Boolean(p.noRange) || state.range !== 'month');
  $('.topbar').classList.toggle('no-range', Boolean(p.noRange));
  const el = $('#content');
  el.scrollTop = 0;
  setSidebar(false);
  el.classList.remove('page-in');
  void el.offsetWidth; // restart the enter animation
  el.classList.add('page-in');
  renderDueBar();
  if (!state.data) { el.innerHTML = skeleton(); return; }
  const fn = { overview, ask: renderAsk, watch: renderWatch, reports: renderReports, trends, products, orders, returns, settlement: renderSettlement, costs: renderOpex, editor: renderEditor, import: importPage, settings }[p.id];
  fn(el);
}

// Red reminder across the top of every page: a settlement that is due within DUE_WARN_DAYS days, or overdue
const DUE_WARN_DAYS = 5;
function renderDueBar() {
  const bar = $('#due-bar');
  const d = state.data;
  if (!bar) return;
  if (!d) { bar.hidden = true; return; }
  const A = d.settings.partner_amazon;
  const B = d.settings.partner_ebay;
  const dueDay = d.settings.settlement_day ?? 26;
  const { expenses, settlements } = d.books;
  const items = allMonths(d.orders, expenses)
    .map((m) => settleMonth({ month: m, orders: d.orders, expenses, settlements, splitAmazon: Number(d.settings.split_amazon) }))
    .map((s) => ({ s, v: settleView(s, A, B), due: dueStatus(settlementDueDate(s.month, dueDay)) }))
    .filter((x) => !x.v.settled && !x.v.nothingDue && x.v.outstanding > 0.009 && x.due.days <= DUE_WARN_DAYS)
    .sort((a, b) => a.due.days - b.due.days);
  if (!items.length) { bar.hidden = true; bar.innerHTML = ''; return; }
  const x = items[0];
  const n = x.due.days;
  const when = n < 0 ? `overdue by ${-n} day${n === -1 ? '' : 's'}`
    : n === 0 ? 'due today'
    : `due ${fmtDate(settlementDueDate(x.s.month, dueDay), { weekday: 'short', month: 'short', day: 'numeric' })}, in ${n} day${n === 1 ? '' : 's'}`;
  const more = items.length > 1 ? ` · plus ${items.length - 1} more month${items.length > 2 ? 's' : ''}` : '';
  bar.hidden = false;
  bar.innerHTML = `<a class="due-bar ${n < 0 ? 'overdue' : ''}" href="#/settlement" role="alert">${ICONS.alert}<span class="txt"><b>${esc(x.v.from)} sends ${esc(x.v.to)} ${money(x.v.outstanding, 2)}</b> for ${monthLabel(x.s.month, 'long')} · ${when}${more}</span><span class="go">Open settlement ${ICONS.chevron}</span></a>`;
}

// "Sep 1 – Sep 22", or with years when the range crosses a year boundary / isn't this year: "Sep 23, 2025 – Sep 22, 2026"
function rangeText(r) {
  const withYear = r.start.getFullYear() !== r.end.getFullYear() || r.end.getFullYear() !== new Date().getFullYear();
  const f = withYear ? { month: 'short', day: 'numeric', year: 'numeric' } : undefined;
  return `${fmtDate(r.start, f)} – ${fmtDate(r.end, f)}`;
}

// Loading placeholders mirror the layout they stand in for (hero + settlement card, KPI strip, two charts)
const skCard = (inner) => `<div class="sk-card">${inner}</div>`;
const skeleton = () => `<div class="sk-grid" aria-busy="true" aria-label="Loading">
  <div class="sk-hero">${skCard('<div class="sk w40"></div><div class="sk num"></div><div class="sk w60"></div><div class="sk chart"></div>')}</div>
  <div class="sk-side">${skCard('<div class="sk w60"></div><div class="sk w40"></div><div class="sk num"></div><div class="sk w80"></div><div class="sk line"></div><div class="sk w80"></div><div class="sk w60"></div><div class="sk w80"></div>')}</div>
  ${'<div class="sk-kpi">' + skCard('<div class="sk w40"></div><div class="sk w60" style="height:22px"></div>') + '</div>'}
  ${'<div class="sk-kpi">' + skCard('<div class="sk w40"></div><div class="sk w60" style="height:22px"></div>') + '</div>'}
  ${'<div class="sk-kpi">' + skCard('<div class="sk w40"></div><div class="sk w60" style="height:22px"></div>') + '</div>'}
  ${'<div class="sk-kpi">' + skCard('<div class="sk w40"></div><div class="sk w60" style="height:22px"></div>') + '</div>'}
  <div class="sk-chart">${skCard('<div class="sk w40"></div><div class="sk w60"></div><div class="sk chart" style="height:260px"></div>')}</div>
  <div class="sk-chart2">${skCard('<div class="sk w60"></div><div class="sk w40"></div><div class="sk chart" style="height:260px"></div>')}</div>
</div>`;
// Table / list placeholder for panels that fetch on their own (settings log, editor sheets, match review)
export const skeletonRows = (n = 6) => `<div class="sk-rows" aria-busy="true" aria-label="Loading">${'<div class="sk"></div>'.repeat(n)}</div>`;

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
  return `<span class="delta ${good ? 'up' : 'down'}" title="vs previous period">${d >= 0 ? ICONS.arrowUp : ICONS.arrowDown}${label}</span>`;
}

// Count-up registry: kpi() and the hero stats register a number + the exact formatter used for the static
// text, and flushCounts() animates each one after the page HTML is in place. The final frame always renders
// format(target), so the value that settles on screen is identical to the static string.
let counters = [];
let counterId = 0;
function countable(raw, fmt) {
  if (raw === null || raw === undefined || !Number.isFinite(Number(raw)) || typeof fmt !== 'function') return '';
  const id = `cu-${++counterId}`;
  counters.push([id, Number(raw), fmt]);
  return `id="${id}"`;
}
function flushCounts(ms = 750) {
  const list = counters;
  counters = [];
  for (const [id, v, f] of list) countUp(document.getElementById(id), v, f, ms);
}

function kpi({ label, value, sw, deltaHtml = '', foot = '', tip = '', id = '', raw, fmt }) {
  return `<div class="card kpi" ${tip ? `title="${esc(tip)}"` : ''}>
    <div class="kpi-top">${sw ? `<span class="sw" style="background:var(${sw})"></span>` : ''}${esc(label)}</div>
    <div class="kpi-val num" ${countable(raw, fmt)}>${value}</div>
    <div class="kpi-foot">${deltaHtml}<span>${foot}</span></div>
    ${id ? `<div class="mini" id="${id}"></div>` : ''}
  </div>`;
}

const card = (title, sub, body, { cls = '', right = '', id = '' } = {}) =>
  `<div class="card ${cls}" ${id ? `id="${id}"` : ''}><div class="card-h"><div><h3>${title}</h3>${sub ? `<div class="sub">${sub}</div>` : ''}</div>${right ? `<div class="right">${right}</div>` : ''}</div><div class="card-b">${body}</div></div>`;

const legend = (items) => `<div class="legend">${items.map(([c, l, line]) => `<span><i class="${line ? 'line' : ''}" style="background:var(${c})"></i>${l}</span>`).join('')}</div>`;

// Refund money split by what it really is: refunded to buyers (eBay orders) vs the eBay refund fee that
// monthly-sheet refund rows record (the sheet's -$0.40 lines)
export function refundSplit(orders) {
  let buyer = 0;
  let fee = 0;
  for (const o of orders) {
    if (o.source === 'ledger') fee += o.refunds || 0;
    else buyer += o.refunds || 0;
  }
  return { buyer, fee };
}
// Why an order shows no profit of its own (instead of a bare "pending")
const NO_NET = {
  in_sheet: ['on sheet', 'Counted once, on its monthly sheet row (with the sheet Amazon cost)'],
  before_start: ['before start', 'Sold before the business start month; not counted'],
  cancelled: ['cancelled', 'Cancelled order; not counted'],
  check_sheet: ['check sheet', 'Looks like a reworded sheet row; link it or confirm it is separate'],
  returned: ['returned', 'Returned; no Amazon cost on record yet'],
  not_dropship: ['not dropship', 'No Amazon purchase found for this sale, so it is treated as something else and left out'],
  awaiting_email: ['awaiting email', 'No Amazon order email has matched this sale yet. It is not counted until one does.'],
  awaiting_cost: ['needs cost', 'The Amazon order was found but its total is unknown (e.g. paid by gift card). Type the cost in the Editor.'],
};
// Display status: an uncosted sale is either still waiting for its Amazon email, or has one with no usable total
export const viewStatus = (o) => (o.status === 'awaiting_cost' && !(o.amazon_orders || []).length ? 'awaiting_email' : o.status);
const noNetLabel = (o) => {
  const [label, tip] = NO_NET[viewStatus(o)] || (o.excluded ? ['excluded', 'Excluded from the numbers'] : ['pending', 'Waiting for the Amazon cost']);
  return `<span class="muted" title="${tip}">${label}</span>`;
};
const refundWord = (o) => (o.source === 'ledger' ? 'eBay refund fee' : 'Refunded to buyer');

// Every status pill carries an icon as well as a colour, so state never relies on colour alone
const STATUS_ICON = {
  profitable: 'trendUp', loss: 'trendDown', returned: 'return', awaiting_cost: 'clock', awaiting_email: 'mail', cancelled: 'x',
  cancelled_after_purchase: 'circleX', excluded: 'eyeOff', not_dropship: 'eyeOff', in_sheet: 'sheet', before_start: 'history', check_sheet: 'alert',
};
export function statusPill(s) {
  const m = STATUS_META[s] || { label: s, cls: '' };
  const ic = ICONS[STATUS_ICON[s]] || '';
  return `<span class="pill ${m.cls}">${ic}${m.label}</span>`;
}

const granLabel = { hour: 'Hourly', day: 'Daily', week: 'Weekly', month: 'Monthly' };
function granSeg() {
  const g = state.gran || 'auto';
  return `<div class="seg" id="gran-seg">${['auto', 'hour', 'day', 'week', 'month'].map((k) => `<button data-g="${k}" class="${g === k ? 'on' : ''}">${k === 'auto' ? 'Auto' : granLabel[k]}</button>`).join('')}</div>`;
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
  if (k.includes('T')) { const h = Number(k.slice(11, 13)); return h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`; }
  if (gran === 'month') return monthLabel(k);
  const [y, m, d] = k.split('-').map(Number);
  const s = new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return gran === 'week' ? `Wk ${s}` : s;
};

function emptyState(el) {
  const has = state.data.orders.length > 0;
  el.innerHTML = `<div class="card"><div class="empty lg">
    <div class="ic">${has ? ICONS.calendar : ICONS.orders}</div>
    <div class="t">${has ? 'No eBay sales in this date range' : 'No sales yet'}</div>
    <p>${has ? 'Nothing was sold between these dates. Widen the range or pick another month.' : 'Connect eBay and the Amazon email import, or upload a monthly settlement sheet, and the numbers appear here.'}</p>
    <div class="actions">${has
      ? '<button class="btn" data-range="30d">Last 30 days</button><button class="btn" data-range="all">All time</button>'
      : `<a class="btn primary" href="#/settings">${ICONS.settings} Open Settings</a><a class="btn" href="#/import">${ICONS.sheet} Upload a monthly sheet</a>`}</div>
  </div></div>`;
  $$('[data-range]', el).forEach((b) => b.addEventListener('click', () => { state.range = b.dataset.range; store('dd_range', state.range); renderRangeSeg(); renderPage(); }));
}

// One compact notice per issue. Soft setup hints get an × (remembered for the session); failures never do.
function notice({ key, kind = '', icon = ICONS.alert, text, action, href, soft = false }) {
  if (soft && dismissed.has(key)) return '';
  return `<div class="banner ${kind}" data-k="${key}">${icon}<div>${text}</div>${action ? `<a class="btn sm" href="${href}">${action}</a>` : ''}${soft ? `<button class="banner-x" data-k="${key}" aria-label="Dismiss">${ICONS.x}</button>` : ''}</div>`;
}

function setupBanner() {
  const d = state.data;
  const out = [];
  if (!d.ebay.configured)
    out.push(notice({ key: 'ebay-setup', soft: true, text: `<b>eBay isn't connected.</b> Finish setup in Settings, then click <b>Connect eBay account</b>. <span class="muted">Missing: ${d.ebay.missing.join(', ')}</span>`, action: 'Set up', href: '#/settings' }));
  // Loud warnings when an automatic pull stops working, so a silent failure can't hide missing sales or costs
  const stale = (iso, hours) => !iso || Date.now() - new Date(iso).getTime() > hours * 3600_000;
  if (d.ebay.needsReconnect)
    out.push(notice({ key: 'ebay-reconnect', kind: 'bad', text: '<b>eBay needs to be reconnected.</b> eBay stopped accepting the saved connection, so no new sales are coming in.', action: 'Reconnect eBay', href: '/api/ebay/connect' }));
  else if (d.ebay.refreshExpiresAt && new Date(d.ebay.refreshExpiresAt) - Date.now() < 30 * 86400_000)
    out.push(notice({ key: 'ebay-expiring', text: `<b>eBay connection expires ${fmtDate(d.ebay.refreshExpiresAt, { month: 'short', day: 'numeric', year: 'numeric' })}.</b> Reconnect now so syncing never stops.`, action: 'Reconnect eBay', href: '/api/ebay/connect' }));
  else if (d.ebay.configured && syncFailed(d.ebay))
    out.push(notice({ key: 'ebay-failing', kind: 'bad', text: `<b>eBay sync is failing.</b> New sales are not coming in. <span class="muted">${esc((d.ebay.last.message || '').slice(0, 180))}</span>`, action: 'Details', href: '#/settings' }));
  else if (d.ebay.configured && !syncInProgress(d.ebay) && d.ebay.lastSuccess && stale(d.ebay.lastSuccess, 3))
    out.push(notice({ key: 'ebay-stale', text: `<b>eBay hasn't synced since ${fmtDateTime(d.ebay.lastSuccess)}.</b> It normally runs every 30 minutes. Check that the server is running.`, action: 'Details', href: '#/settings' }));
  if (d.email.configured && !d.email.running && d.email.last && !d.email.last.ok)
    out.push(notice({ key: 'email-failing', kind: 'bad', text: `<b>Amazon email check is failing.</b> New Amazon costs are not coming in. <span class="muted">${esc((d.email.last.log || []).join(' ').slice(0, 180))}</span>`, action: 'Details', href: '#/settings?focus=email' }));
  else if (d.email.configured && !d.email.running && d.email.last && stale(d.email.last.at, 3))
    out.push(notice({ key: 'email-stale', text: `<b>Amazon email hasn't been checked since ${fmtDateTime(d.email.last.at)}.</b> It normally runs every 30 minutes.`, action: 'Details', href: '#/settings?focus=email' }));
  if (!d.email.configured)
    out.push(notice({ key: 'email-setup', kind: 'info', icon: ICONS.mail, soft: true, text: '<b>Amazon email import is off.</b> Add a Gmail App Password so every Amazon purchase and its cost arrives automatically.', action: 'Set up', href: '#/settings?focus=email' }));
  if (d.orders.some((o) => o.order_id.startsWith('DEMO-')))
    out.push(notice({ key: 'demo', kind: 'info', icon: ICONS.info, soft: true, text: "<b>You're looking at demo data.</b> It shows how the dashboard works before your real eBay and Amazon data arrives. Remove it any time.", action: 'Remove demo data', href: '#/settings' }));
  const html = out.filter(Boolean).join('');
  return html ? `<div class="banners">${html}</div>` : '';
}

// Robinhood-style running profit: the line is the running total over the range; drag or hover across it and
// the headline shows the total up to that point. Operating costs are spread evenly across the period, so the
// last point always equals the headline. Optional dashed line: the previous period of the same length.
function heroScrub({ r, all, s, ox, oxPrev, biz, hasPrev, rangeLabel }) {
  const el = $('#hero-spark');
  const c = colors();
  const g = r.start && r.end - r.start <= 1.5 * DAY ? 'hour' : 'day';
  const run = (bs, total, opex) => {
    let acc = 0;
    const out = bs.map((b, i) => { acc += b.net; return Math.round((acc - (opex * (i + 1)) / bs.length) * 100) / 100; });
    // Guard: whatever the bucketing, the final point is exactly the headline figure
    if (out.length) out[out.length - 1] = Math.round((total - opex) * 100) / 100;
    return out;
  };
  const bs = buckets(r, all, g);
  const cur = run(bs, s.net, ox.total);
  const labels = bs.map((b) => (g === 'hour' ? `${fmtDate(r.start)} · ${bucketLabel(b.key, g)}` : bucketLabel(b.key, g)));
  const cmp = state.compare && hasPrev ? (() => {
    const pr = previousRange(r);
    const pb = buckets(pr, prevScoped(), g).slice(-bs.length);
    return { run: run(pb, summarize(prevScoped()).net, oxPrev.total), labels: pb.map((b) => bucketLabel(b.key, g)) };
  })() : null;
  const up = biz >= 0;
  const col = up ? c.profit : c.bad;
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
    val.textContent = money(biz, 2);
    val.classList.toggle('neg', biz < 0);
    at.innerHTML = cmp ? `<span class="k-dash"></span>Previous period ended at <b>${money(cmp.run.at(-1) ?? 0, 2)}</b> · drag to compare day by day` : 'Drag across the chart to see the running profit';
    at.classList.remove('on');
  };
  idle();
  if (!chart) return;
  chart.on('updateAxisPointer', (e) => {
    const i = e.axesInfo?.[0]?.value;
    if (i === undefined || i === null || cur[i] === undefined) return;
    const v = cur[i];
    const day = bs[i].net;
    val.textContent = money(v, 2);
    val.classList.toggle('neg', v < 0);
    const vs = cmp && cmp.run[i] !== undefined ? ` · <span class="k-dash"></span>same point last period ${money(cmp.run[i], 2)} <b class="${v - cmp.run[i] >= 0 ? 'pos' : 'neg'}">${v - cmp.run[i] >= 0 ? '+' : '−'}${money(Math.abs(v - cmp.run[i]), 2)}</b>` : '';
    at.innerHTML = `<b>${esc(labels[i])}</b> · ${day >= 0 ? '+' : '−'}${money(Math.abs(day), 2)} item profit ${g === 'hour' ? 'that hour' : 'that day'} · ${count(bs[i].countedOrders)} sales${vs}`;
    at.classList.add('on');
  });
  chart.getZr().on('globalout', idle);
  el.addEventListener('touchend', () => setTimeout(idle, 1200), { passive: true });
  void rangeLabel;
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
  // Monthly-sheet rows are eBay payouts after fees, and their refund rows carry eBay's refund fee, not a buyer refund
  const split = refundSplit(all.filter((o) => o.counted));
  const refundFees = split.fee;
  const sheetRows = all.some((o) => o.counted && o.source === 'ledger');
  const adPart = `ad fees ${money(s.adFees, 2)}`;
  const feeFoot = s.fees < 0.005 && sheetRows
    ? `sheet rows are already net of eBay fees · ${adPart}`
    : `${pct(s.revenue ? s.fees / s.revenue : null)} of revenue${sheetRows ? ' · sheet rows already net' : ''} · ${adPart}`;

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

  // what we owe each other: this month's settlement + the running balance across every month
  const A = state.data.settings.partner_amazon;
  const B = state.data.settings.partner_ebay;
  const settleArgs = { orders: state.data.orders, expenses: state.data.books.expenses, settlements: state.data.books.settlements, splitAmazon: Number(state.data.settings.split_amazon) };
  const dueDay = state.data.settings.settlement_day ?? 26;
  const allSettled = allMonths(state.data.orders, state.data.books.expenses).map((m) => settleMonth({ month: m, ...settleArgs }));
  const view = (x) => settleView(x, A, B);
  // Net position across every month: > 0 means B owes A, < 0 means A owes B (a loss month can flip the direction)
  const owedAll = Math.round(allSettled.reduce((t, x) => t + view(x).signedOwed, 0) * 100) / 100;
  // The card shows the month picked in the range bar (Month range), otherwise the current month
  const pickedMonth = state.range === 'month' && /^\d{4}-\d{2}$/.test(state.month || '') ? state.month : null;
  const cardMonth = pickedMonth || monthKey(now);
  const cardSettle = cardMonth === monthKey(now) ? thisSettle : settleMonth({ month: cardMonth, ...settleArgs });
  const cv = view(cardSettle);
  const cardDue = dueStatus(settlementDueDate(cardMonth, dueDay), { paid: cv.fullyPaid });
  const settleStatus = (() => {
    if (cv.paid === null) {
      if (cv.nothingDue) return { cls: '', icon: ICONS.info, t: cardMonth === monthKey(now) ? 'Nothing due yet' : 'Nothing to send', s: cardMonth === monthKey(now) ? 'No settled sales this month so far' : 'No amount due for this month' };
      if (cardDue.kind === 'overdue') return { cls: 'bad', icon: ICONS.alert, t: cardDue.text, s: `${esc(cv.from)} sends ${esc(cv.to)} · was due ${cardDue.label}` };
      return { cls: 'warn', icon: ICONS.clock, t: cardDue.kind === 'soon' ? cardDue.text : 'Not paid yet', s: `${esc(cv.from)} sends by ${cardDue.label}` };
    }
    if (cv.fullyPaid) return { cls: 'good', icon: ICONS.check, t: 'Paid in full', s: cardSettle.paidAt ? `on ${fmtDate(`${cardSettle.paidAt}T12:00`)}` : 'Recorded on the monthly sheet' };
    if (cv.outstanding > 0) return { cls: cardDue.kind === 'overdue' ? 'bad' : 'warn', icon: ICONS.clock, t: `${money(cv.outstanding, 2)} still owed`, s: `${money(cv.paid, 2)} paid so far · ${cardDue.text.toLowerCase()}` };
    return { cls: 'info', icon: ICONS.info, t: `Overpaid by ${money(-cv.outstanding, 2)}`, s: `${money(cv.paid, 2)} paid by ${esc(cv.from)}` };
  })();

  // "What we owe each other": the most recent month still owed, plus anything older that is also outstanding
  const unpaid = allSettled.filter((x) => view(x).outstanding > 0.009 && !view(x).nothingDue);
  const latestUnpaid = unpaid[unpaid.length - 1];
  const olderUnpaid = unpaid.slice(0, -1);
  const settleCallout = (() => {
    if (!latestUnpaid) return '';
    const lv = view(latestUnpaid);
    const due = dueStatus(settlementDueDate(latestUnpaid.month, dueDay));
    // Older months can point either way, so describe them by their net direction
    const olderNet = Math.round(olderUnpaid.reduce((t, x) => t + view(x).signedOwed, 0) * 100) / 100;
    const olderDir = olderNet > 0 ? `${esc(B)} → ${esc(A)}` : `${esc(A)} → ${esc(B)}`;
    const older = olderUnpaid.length ? ` <span class="muted">plus ${Math.abs(olderNet) >= 0.01 ? `${money(Math.abs(olderNet), 2)}${(olderNet > 0) !== !lv.reverse ? ` (${olderDir})` : ''} ` : ''}from ${olderUnpaid.length} earlier month${olderUnpaid.length > 1 ? 's' : ''}${olderUnpaid.some((x) => dueStatus(settlementDueDate(x.month, dueDay)).kind === 'overdue') ? ', overdue' : ''}</span>` : '';
    return `<a class="callout ${due.kind}" href="#/settlement">
      <span class="callout-ic">${ICONS.wallet}</span>
      <span class="callout-body"><b>${esc(lv.from)} ${ICONS.arrow.replace('<svg', '<svg class="arr"')} ${esc(lv.to)}</b> <span class="callout-amt num">${money(lv.outstanding, 2)}</span> <span class="muted">for ${monthLabel(latestUnpaid.month, 'long')}</span>${older}</span>
      <span class="pill ${due.kind === 'overdue' ? 'bad' : due.kind === 'soon' ? 'warn' : 'info'}">${due.kind === 'later' ? `Due ${fmtDate(settlementDueDate(latestUnpaid.month, dueDay))}` : due.text}</span>
      <span class="callout-go">Open settlement ${ICONS.chevron}</span>
    </a>`;
  })();

  // Settlement state block: one loud, unambiguous label (SETTLED / DUE / OVERDUE …) plus the day count
  const stateLabel = settleStatus.cls === 'good' ? 'Settled' : settleStatus.cls === 'bad' ? 'Overdue'
    : settleStatus.cls === 'warn' ? (cv.paid !== null ? 'Partly paid' : 'Due') : settleStatus.cls === 'info' ? 'Overpaid' : 'Nothing due';
  const stateIcon = settleStatus.cls === 'good' ? ICONS.circleCheck : settleStatus.cls === 'bad' ? ICONS.alert : settleStatus.cls === 'warn' ? ICONS.clock : settleStatus.cls === 'info' ? ICONS.info : ICONS.minus;
  const stateSide = (() => {
    if (cv.nothingDue || cv.settled || cardDue.kind === 'paid') return '';
    const d = cardDue.days;
    if (d < 0) return `<div class="side"><div class="big num">${-d}</div><div class="sm">${-d === 1 ? 'day' : 'days'} overdue</div></div>`;
    if (d === 0) return '<div class="side"><div class="big">Today</div><div class="sm">due date</div></div>';
    return `<div class="side"><div class="big num">${d}</div><div class="sm">${d === 1 ? 'day' : 'days'} left</div></div>`;
  })();
  const avatar = (name) => `<span class="avatar ${name === A ? '' : 'b'}" aria-hidden="true">${esc(String(name || '?').trim().charAt(0).toUpperCase())}</span>`;
  const rangeLabel = r.start ? rangeText(r) : 'All time';
  const hstat = ({ label, sw, value, raw, fmt, deltaHtml = '', foot = '', tip = '', id = '' }) => `<div class="hstat" ${tip ? `title="${esc(tip)}"` : ''}>
      <div class="k">${sw ? `<span class="sw" style="background:var(${sw})"></span>` : ''}${esc(label)}</div>
      <div class="v num" ${countable(raw, fmt)}>${value}</div>
      <div class="f">${deltaHtml}<span>${foot}</span></div>
      ${id ? `<div class="mini" id="${id}"></div>` : ''}
    </div>`;
  const marginNow = s.revenue ? biz / s.revenue : null;
  const roiNow = s.cost ? biz / s.cost : null;

  el.innerHTML = `${setupBanner()}${settleCallout}
  <div class="grid g-12">
    <div class="card hero c-8 ${biz < 0 ? 'loss' : ''}">
      <div class="hero-top">
        <span class="hero-eyebrow"><span class="sw" style="background:var(${biz < 0 ? '--bad' : '--s-profit'})"></span>Net business profit</span>
        <span class="muted" style="font-size:12px">${esc(rangeLabel)}</span>
        ${hasPrev ? delta(biz, bizPrev) : ''}
        ${r.start ? `<button class="chip-toggle ${state.compare ? 'on' : ''}" id="hero-compare" type="button" aria-pressed="${Boolean(state.compare)}" title="Overlay the previous period of the same length">${ICONS.history} Compare</button>` : ''}
      </div>
      <div class="hero-value num ${biz < 0 ? 'neg' : ''}" id="hero-value">${money(biz, 2)}</div>
      <div class="hero-meta">
        <span>Item profit <b>${money(s.net, 2)}</b></span>
        <span>− operating costs <b>${money(ox.total, 2)}</b></span>
        <span><b>${count(s.countedOrders)}</b> costed of <b>${count(s.orders)}</b> sales</span>
      </div>
      <div class="scrub-at" id="hero-at" aria-live="polite">Drag across the chart to see the running profit</div>
      <div class="spark scrub" id="hero-spark" title=""></div>
      <div class="hero-stats">
        ${hstat({ label: 'Revenue', sw: '--s-revenue', value: moneyShort(s.revenueAll), raw: s.revenueAll, fmt: moneyShort, deltaHtml: hasPrev ? delta(s.revenueAll, p.revenueAll) : '', foot: 'buyer paid, excl. tax', id: 'k-rev' })}
        ${hstat({ label: 'Orders', value: count(s.orders), raw: s.orders, fmt: count, deltaHtml: hasPrev ? delta(s.orders, p.orders) : '', foot: `${count(s.units)} units`, id: 'k-ord' })}
        ${hstat({ label: 'Profit margin', value: pct(marginNow), raw: marginNow, fmt: pct, deltaHtml: hasPrev && p.revenue ? delta(biz / s.revenue, bizPrev / p.revenue, { isPct: true }) : '', foot: `item ${pct(s.margin)}`, tip: 'After operating costs. Item margin (before operating costs) shown underneath.' })}
        ${hstat({ label: 'ROI', value: pct(roiNow), raw: roiNow, fmt: pct, deltaHtml: hasPrev && p.cost ? delta(biz / s.cost, bizPrev / p.cost, { isPct: true }) : '', foot: `item ${pct(s.roi)}`, tip: 'Business profit ÷ Amazon cost. Item ROI (before operating costs) shown underneath.' })}
      </div>
    </div>

    <div class="card settle-card c-4">
      <div class="settle-head">
        <span class="eyebrow">${ICONS.wallet} Partner settlement</span>
        <span class="pill">${ICONS.calendar} ${monthLabel(cardMonth, 'long')}</span>
      </div>
      <div class="settle-who">${avatar(cv.from)}<b>${esc(cv.from)}</b><span class="muted">sends</span>${ICONS.arrowRight.replace('<svg', '<svg class="arrow"')}${avatar(cv.to)}<b>${esc(cv.to)}</b></div>
      <div class="settle-amt num" id="settle-value">${money(cv.amount, 2)}</div>
      <div class="settle-math"><span>Reimbursement <b>${money(cardSettle.cogs + cardSettle.opexAmazon, 2)}</b></span><span>${cardSettle.shareAmazon < 0 ? '−' : '+'} ${esc(A)}'s share <b>${money(Math.abs(cardSettle.shareAmazon), 2)}</b></span></div>
      <div class="settle-hint">${pickedMonth ? 'The month picked in the range bar' : 'This month so far · pick <b>Month</b> in the range bar to see another'}</div>
      <div class="state ${settleStatus.cls}" role="status" title="${!cv.nothingDue ? esc(`Settlements are due on the ${dueDay}th of each month`) : ''}">
        <div class="ic">${stateIcon}</div>
        <div><div class="lbl"><span class="live"></span>${stateLabel}</div><div class="t">${settleStatus.t}</div><div class="s">${settleStatus.s}</div></div>
        ${stateSide}
      </div>
      <div class="settle-track-h"><span>Month by month</span><span>${allSettled.length > 6 ? `latest 6 of ${allSettled.length}` : ''}</span></div>
      <div class="settle-track" role="list" aria-label="Settlement by month">${[...allSettled].reverse().slice(0, 6).map((x) => {
        const xv = view(x);
        const d = dueStatus(settlementDueDate(x.month, dueDay));
        const badge = xv.settled
          ? `<span class="pill good">${ICONS.check} Settled</span>`
          : d.kind === 'overdue' ? `<span class="pill bad">${ICONS.alert} Overdue</span>`
          : `<span class="pill warn">${ICONS.clock} Due ${fmtDate(settlementDueDate(x.month, dueDay))}</span>`;
        return `<a class="settle-row ${xv.settled ? 'ok' : d.kind}${x.month === cardMonth ? ' sel' : ''}" role="listitem" href="#/settlement" data-month="${x.month}" title="${esc(`${xv.from} sends ${xv.to} ${money(xv.amount, 2)}`)}">
          <span class="m">${monthLabel(x.month)}</span>
          <span class="amt num">${xv.reverse ? `<span class="dir">${esc(xv.from)} → ${esc(xv.to)}</span>` : ''}${money(xv.amount, 2)}</span>
          ${badge}
        </a>`;
      }).join('')}</div>
      <div class="stat-row" style="margin-top:10px"><span class="k">Owed across all months</span><span class="v ${Math.abs(owedAll) > 0.009 ? 'neg' : 'pos'}">${owedAll > 0.009 ? `${esc(B)} owes ${esc(A)} ${money(owedAll, 2)}` : owedAll < -0.009 ? `${esc(A)} owes ${esc(B)} ${money(-owedAll, 2)}` : `${ICONS.check.replace('<svg', '<svg style="width:13px;height:13px"')} All settled`}</span></div>
      <div style="margin-top:12px"><a class="btn sm" href="#/settlement">Open settlement ${ICONS.arrow}</a></div>
    </div>
  </div>

  <div class="grid g-12 mt">
    ${card('This month', now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }), `
      <div class="row" style="align-items:baseline;gap:8px"><div class="hero-value num" style="font-size:32px;margin-top:0" ${countable(ms.net, (v) => money(v, 0))}>${money(ms.net, 0)}</div><span class="muted" style="font-size:12.5px">item profit</span></div>
      <div class="muted" style="font-size:12.5px;margin-top:2px">${goal ? `${pct(Math.max(0, ms.net / goal), 0)} of the ${money(goal, 0)} goal` : 'Set a monthly goal in <a href="#/settings">Settings</a>'}</div>
      ${goal ? `<div class="goal-bar"><div style="width:${Math.min(100, Math.max(0, (ms.net / goal) * 100)).toFixed(1)}%"></div></div>` : '<div style="height:10px"></div>'}
      <div class="stat-row"><span class="k">After operating expenses</span><span class="v ${thisSettle.businessProfit < 0 ? 'neg' : ''}">${money(thisSettle.businessProfit, 2)}</span></div>
      <div class="stat-row"><span class="k">Projected month-end</span><span class="v">${projected !== null ? money(projected, 0) : '—'}</span></div>
      <div class="stat-row"><span class="k">Daily run-rate</span><span class="v">${dayOfMonth > 0.5 ? money(ms.net / dayOfMonth) : '—'}</span></div>
      <div class="stat-row"><span class="k">Orders this month</span><span class="v">${count(ms.orders)}</span></div>
      <div class="stat-row"><span class="k">All-time item profit</span><span class="v">${money(allTime.net, 0)}</span></div>`, { cls: 'c-4' })}
    ${card('Needs attention', 'Click an item to jump there', `<div class="alert-list">
      ${alertItem('bad', ICONS.alert, 'Loss-making orders', `${money(s.lossTotal)} lost in this range`, s.lossCount, '#/orders?f=loss')}
      ${alertItem('info', ICONS.mail, 'Sales awaiting the Amazon email', `${oldAwaiting.length} older than 3 days · open one and press Check email now`, state.data.orders.filter((o) => o.status === 'awaiting_cost').length, '#/orders?f=awaiting_cost')}
      ${alertItem('warn', ICONS.link, 'Suggested matches to review', 'Title-only matches need a human yes/no', state.data.amazon.suggestions || 0, '#/editor?tab=matches')}
      ${alertItem('warn', ICONS.return, 'Open returns', 'Returns not closed yet', openReturns.length, '#/returns')}
      ${alertItem('good', ICONS.users, 'Repeat buyers', `${count(s.uniqueBuyers)} unique buyers in range`, s.repeatBuyers, '#/trends')}
    </div>`, { cls: 'c-4' })}
    ${card('Where every dollar goes', 'Revenue broken into costs and what you keep', '<div class="chart tall" id="ch-waterfall"></div>', { cls: 'c-4' })}
  </div>

  <div class="grid g-12 mt">
    ${card('Revenue, cost &amp; item profit', `${granLabel[gran]} · item profit before operating costs · red = loss period`, `${legend([['--s-revenue', 'Revenue', 1], ['--s-cost', 'Amazon cost', 1], ['--s-profit', 'Item profit']])}<div class="chart tall" id="ch-main"></div>`, { cls: 'c-8 fill', right: granSeg() })}
    <div class="c-4 kpis two kpi-block">
      ${kpi({ label: 'Amazon cost', sw: '--s-cost', value: moneyShort(s.cost), raw: s.cost, fmt: moneyShort, deltaHtml: hasPrev ? delta(s.cost, p.cost, { invert: true }) : '', foot: `avg ${money(s.avgCost)}` })}
      ${kpi({ label: 'eBay fees', sw: '--s-fees', value: moneyShort(s.fees), raw: s.fees, fmt: moneyShort, deltaHtml: hasPrev && p.fees ? delta(s.fees, p.fees, { invert: true }) : '', foot: feeFoot,
        tip: 'Final value fees on synced eBay orders (the waterfall’s “eBay fees” bar). Monthly-sheet rows record the eBay payout after fees, so their fees are already out of revenue. Promoted-listing (ad) fees are counted separately.' })}
      ${kpi({ label: 'Operating costs', sw: '--s-ops', value: money(ox.total, 2), raw: ox.total, fmt: (v) => money(v, 2), deltaHtml: hasPrev ? delta(ox.total, oxPrev.total, { invert: true }) : '', foot: `subscriptions, tools, proxies · ${count(ox.byCategory.size)} items`, tip: 'Monthly operating costs from the sheets / Editor → Operating expenses. Partly covered months are prorated by day.' })}
      ${kpi({ label: 'Refunds', sw: '--s-refunds', value: moneyShort(s.refunds), raw: s.refunds, fmt: moneyShort, foot: [refundFees ? (split.buyer ? `${money(split.buyer, 2)} to buyers · ${money(refundFees, 2)} eBay refund fees` : 'eBay refund fees on sheet refund rows') : 'to buyers', s.amazonRefund ? `${money(s.amazonRefund)} recovered` : ''].filter(Boolean).join(' · '), tip: 'Money refunded to buyers on eBay orders, plus the eBay refund fee recorded on monthly-sheet refund rows.' })}
      ${kpi({ label: 'Avg order value', value: money(s.aov), raw: s.aov, fmt: money, deltaHtml: hasPrev ? delta(s.aov, p.aov) : '' })}
      ${kpi({ label: 'Item profit / order', value: money(s.profitPerOrder), raw: s.profitPerOrder, fmt: money, deltaHtml: hasPrev ? delta(s.profitPerOrder, p.profitPerOrder) : '', foot: 'before operating costs' })}
      ${kpi({ label: 'Return rate', value: pct(s.returnRate), raw: s.returnRate, fmt: pct, deltaHtml: hasPrev ? delta(s.returnRate, p.returnRate, { invert: true, isPct: true }) : '', foot: `${count(s.returnCount)} orders` })}
      ${kpi({ label: 'Awaiting email', value: count(s.awaitingCount), raw: s.awaitingCount, fmt: count, foot: `${moneyShort(s.awaitingRevenue)} in sales not in profit yet`, tip: 'eBay sales with no linked Amazon purchase yet. Excluded from profit until linked.' })}
    </div>
  </div>

  <div class="grid g-12 mt">
    ${card('Cumulative profit', 'Running total: item profit, minus each month’s operating costs', '<div class="chart" id="ch-cum"></div>', { cls: 'c-5' })}
    ${card('Order outcomes', 'Share of eBay orders in the range', '<div class="chart" id="ch-outcomes"></div>', { cls: 'c-3' })}
    ${card('Operating costs', `${money(ox.total, 2)} in this range · the sheets' section 2`, `<div class="chart" id="ch-opex"></div>`, { cls: 'c-4', right: '<a class="btn sm" href="#/costs">Edit</a>' })}
  </div>

  <div class="grid g-12 mt">
    ${card('Top products by profit', 'Net item profit in range', '<div class="chart" id="ch-top" style="height:320px"></div>', { cls: 'c-7' })}
    ${card('Operating costs by month', 'Full month totals from the sheets and the Editor', `<div class="table-wrap" id="opex-months"></div>`, { cls: 'c-5' })}
  </div>`;

  countUp($('#hero-value'), biz, (v) => money(v, 2));
  countUp($('#settle-value'), cv.amount, (v) => money(v, 2), 700);
  flushCounts();

  // hero spark
  heroScrub({ r, all, s, ox, oxPrev, biz, hasPrev, rangeLabel });
  $('#hero-compare')?.addEventListener('click', () => { state.compare = !state.compare; store('dd_compare', state.compare); renderPage(); });
  sparkline($('#k-rev'), dailyForSpark.map((b) => b.revenueAll), c.revenue);
  sparkline($('#k-ord'), dailyForSpark.map((b) => b.orders), c.accent);

  // main chart
  const labels = series.map((b) => bucketLabel(b.key, gran));
  mount($('#ch-main'), {
    grid: { left: 8, right: 12, top: 16, bottom: 4, containLabel: true },
    tooltip: {
      ...tooltipBase(), trigger: 'axis', axisPointer: crosshair(),
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
      { name: 'Revenue', type: 'line', data: series.map((b) => +b.revenueAll.toFixed(2)), smooth: 0.3, symbol: 'circle', symbolSize: 6, showSymbol: false, lineStyle: { width: 1.75, color: c.revenue }, itemStyle: { color: c.revenue, borderColor: c.surface, borderWidth: 2 },
        areaStyle: { color: areaFade(c.revenue, 0.16) } },
      { name: 'Amazon cost', type: 'line', data: series.map((b) => +b.cost.toFixed(2)), smooth: 0.3, symbol: 'circle', symbolSize: 6, showSymbol: false, lineStyle: { width: 1.75, color: c.cost }, itemStyle: { color: c.cost, borderColor: c.surface, borderWidth: 2 } },
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
    series: [{ type: 'line', data: cum.map((v) => +v.toFixed(2)), smooth: 0.25, showSymbol: false, lineStyle: { width: 1.75, color: c.profit }, itemStyle: { color: c.profit, borderColor: c.surface, borderWidth: 2 },
      areaStyle: { color: areaFade(c.profit, 0.24) } }],
  });

  // outcomes donut (status colors + labels)
  const outcome = [
    ['Profitable', all.filter((o) => o.status === 'profitable').length, c.good],
    ['Loss', all.filter((o) => o.status === 'loss' || o.status === 'cancelled_after_purchase').length, c.bad],
    ['Returned', all.filter((o) => o.status === 'returned').length, c.warn],
    ['Awaiting email', all.filter((o) => o.status === 'awaiting_cost').length, c.accent],
    ['Cancelled', all.filter((o) => o.status === 'cancelled').length, c.ink3],
  ].filter((x) => x[1] > 0);
  if (!outcome.length) $('#ch-outcomes').outerHTML = `<div class="empty"><div class="ic">${ICONS.orders}</div><div class="t">No orders to chart</div>Order outcomes appear once sales land in this range.</div>`;
  else mount($('#ch-outcomes'), {
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
  // Refund note for product tooltips: refunds are part of this product's net, so say so
  const refundNote = productRefundNote;
  mount($('#ch-top'), {
    grid: { left: 8, right: 70, top: 4, bottom: 4, containLabel: true },
    tooltip: { ...tooltipBase(), trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(127,127,127,.08)' } },
      formatter: (ps) => { const x = tp[ps[0].dataIndex]; return ttHead(x.title) + ttRow(c.profit, 'Net profit', money(x.net), true) + ttRow(c.revenue, 'Revenue', money(x.revenueAll)) + `<div style="opacity:.6;margin-top:4px">${count(x.orders)} orders · ${pct(x.margin)} margin</div>` + refundNote(x); } },
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

  $$('.alert', el).forEach((a) => {
    a.addEventListener('click', () => { location.hash = a.dataset.href; });
    a.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); location.hash = a.dataset.href; } });
  });
}

function alertItem(kind, icon, title, sub, n, href) {
  return `<div class="alert" data-href="${href}" role="link" tabindex="0"><div class="alert-ic ${n ? kind : 'zero'}">${icon}</div><div><div class="alert-t">${title}</div><div class="alert-s">${sub}</div></div><div class="n ${n ? '' : 'zero'}">${count(n)}</div>${ICONS.chevron.replace('<svg', '<svg class="chev"')}</div>`;
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
    tooltip: { ...tooltipBase(), trigger: 'axis', axisPointer: crosshair(), formatter: (ps) => ttHead(labels[ps[0].dataIndex]) + ps.map((p) => ttRow(p.color, p.seriesName, p.value === null ? '—' : fmt(p.value))).join('') },
    xAxis: { type: 'category', data: labels, boundaryGap: false, ...axisBase({ splitLine: { show: false } }) },
    yAxis: { type: 'value', ...axisBase(), axisLine: { show: false }, axisLabel: { ...axisBase().axisLabel, formatter: axisFmt || moneyShort } },
    series: lines.map((l) => ({
      name: l.name, type: 'line', data: l.data.map((v) => (v === null ? null : +v.toFixed(4))), smooth: 0.3, connectNulls: true, showSymbol: false, symbolSize: 8,
      lineStyle: { width: 1.75, color: l.color }, itemStyle: { color: l.color, borderColor: c.surface, borderWidth: 2 },
      areaStyle: l.area ? { color: areaFade(l.color, 0.24) } : undefined,
    })),
  });
}

// ---------------------------------------------------------------- PRODUCTS
function products(el) {
  // Two views: the eBay store's listings (views, watchers, what to refresh) and the sales each product made
  const tab = store('dd_prod_tab') || 'listings';
  const tabs = `<div class="seg prod-tabs" id="prod-tabs" role="tablist" aria-label="Products view"><button role="tab" data-t="listings" class="${tab === 'listings' ? 'on' : ''}" aria-selected="${tab === 'listings'}">${ICONS.package} Listings</button><button role="tab" data-t="sales" class="${tab === 'sales' ? 'on' : ''}" aria-selected="${tab === 'sales'}">${ICONS.trends} Sales</button></div>`;
  const bindTabs = () => $('#prod-tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && b.dataset.t !== tab) { store('dd_prod_tab', b.dataset.t); renderPage(); } });
  if (tab === 'listings') { el.innerHTML = `${tabs}<div id="listings-panel"></div>`; bindTabs(); renderListingsPanel($('#listings-panel')); return; }
  const all = scoped();
  if (!all.length) { el.innerHTML = `${tabs}<div id="prod-empty"></div>`; bindTabs(); return emptyState($('#prod-empty')); }
  const c = colors();
  const prods = byProduct(all);
  const costed = prods.filter((p) => p.countedOrders > 0);
  const best = [...prods].sort((a, b) => b.orders - a.orders)[0];
  const most = [...costed].sort((a, b) => b.net - a.net)[0];
  const worst = [...costed].sort((a, b) => a.net - b.net)[0];
  const bestMargin = [...costed].filter((p) => p.countedOrders >= 3).sort((a, b) => b.margin - a.margin)[0];

  el.innerHTML = `${tabs}
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

  bindTabs();
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
      tooltip: { ...tooltipBase(), trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(127,127,127,.08)' } }, formatter: (ps) => { const x = list[ps[0].dataIndex]; return ttHead(trunc(x.title, 60)) + ttRow(c.profit, 'Net', money(x.net)) + ttRow(c.revenue, 'Revenue', money(x.revenueAll)) + `<div style="opacity:.6">${x.orders} orders · ${pct(x.margin)} margin</div>` + productRefundNote(x); } },
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
    data: prods.map((p) => ({ ...p, orders_n: p.orders, returnsN: p.returnCount, feesAll: p.fees + p.adFees })),
    layout: 'fitColumns',
    height: 520,
    placeholder: 'No products',
    initialSort: [{ column: 'net', dir: 'desc' }],
    columns: [
      { title: 'Product', field: 'title', minWidth: 260, widthGrow: 3, formatter: (cell) => `<span title="${esc(cell.getValue())}">${esc(cell.getValue())}</span>` },
      { title: 'Orders', field: 'orders_n', hozAlign: 'right', sorter: 'number', width: 90 },
      { title: 'Units', field: 'units', hozAlign: 'right', sorter: 'number', width: 80 },
      { title: 'Revenue', field: 'revenueAll', hozAlign: 'right', sorter: 'number', formatter: (c) => money(c.getValue()), width: 115 },
      { title: 'Avg sale', field: 'avgSale', hozAlign: 'right', sorter: 'number', formatter: (c) => money(c.getValue()), width: 100 },
      { title: 'Avg cost', field: 'avgCostPer', hozAlign: 'right', sorter: 'number', formatter: (c) => money(c.getValue()), width: 100 },
      { title: 'Fees', field: 'feesAll', hozAlign: 'right', sorter: 'number', formatter: (c) => money(c.getValue()), width: 100 },
      { title: 'Net profit', field: 'net', hozAlign: 'right', sorter: 'number', formatter: (c) => `<b class="${c.getValue() < 0 ? 'neg' : ''}">${money(c.getValue())}</b>`, width: 120 },
      { title: 'Margin', field: 'margin', hozAlign: 'right', sorter: 'number', formatter: (c) => pct(c.getValue()), width: 90 },
      { title: 'Returns', field: 'returnsN', hozAlign: 'right', sorter: 'number', formatter: (c) => { const d = c.getRow().getData(); return d.returnCount ? `${d.returnCount} <span class="muted">(${pct(d.returnRate, 0)})</span>` : '<span class="muted">0</span>'; }, width: 105 },
      { title: 'Last sold', field: 'lastSold', formatter: (c) => fmtDate(c.getValue()), width: 100 },
    ],
  }));
  $('#prod-q').addEventListener('input', (e) => { const v = e.target.value.toLowerCase(); t.setFilter((d) => d.title.toLowerCase().includes(v) || (d.sku || '').toLowerCase().includes(v)); });
  $('#prod-dl').onclick = () => t.download('csv', 'products.csv');
}

// Product tooltip refund line. Sheet refund rows carry eBay's refund fee, which is not money back to the buyer.
function productRefundNote(x) {
  if (!x.returnCount) return '';
  const { buyer, fee } = refundSplit(x.orders.filter((o) => o.counted));
  const parts = [`↩ ${x.returnCount} refunded`];
  if (buyer) parts.push(`${money(buyer, 2)} back to buyer`);
  if (fee) parts.push(`${money(fee, 2)} eBay refund fee`);
  if (x.amazonRefund) parts.push(`${money(x.amazonRefund, 2)} recovered from Amazon`);
  return `<div style="margin-top:5px;color:var(--warn-ink, var(--warn))">${parts.join(' · ')}</div>`;
}

const trunc = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s || '');

// ---------------------------------------------------------------- ORDERS
function orders(el) {
  const all = scoped();
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  if (q.get('f')) state.ordersFilter = q.get('f');
  const filters = [
    ['all', 'All'], ['profitable', 'Profitable'], ['loss', 'Loss'], ['returned', 'Returned'], ['awaiting_cost', 'Awaiting email'], ['cancelled', 'Cancelled'], ['excluded', 'Excluded'],
  ];
  const counts = Object.fromEntries(filters.map(([k]) => [k, all.filter((o) => matchFilter(o, k)).length]));
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
      { title: 'Date', field: 'created_at', width: 108, minWidth: 100, formatter: (c) => `${fmtDate(c.getValue())}<div class="muted" style="font-size:11px">${new Date(c.getValue()).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</div>` },
      { title: 'Item', field: 'title', minWidth: 186, widthGrow: 3, formatter: (c) => { const d = c.getRow().getData(); return `<div style="white-space:normal;line-height:1.3">${esc(trunc(d.title, 90))}</div><div class="${d.source === 'ledger' ? '' : 'mono '}muted" style="font-size:11px">${esc(orderLabel(d))}${d.units > 1 ? ` · ×${d.units}` : ''}</div>`; } },
      { title: 'Buyer', field: 'buyer', width: 120, minWidth: 110, formatter: (c) => { const d = c.getRow().getData(); return `${esc(d.buyer || '')}<div class="muted" style="font-size:11px">${esc([d.ship_city, d.ship_state].filter(Boolean).join(', '))}</div>`; } },
      { title: 'Revenue', field: 'revenue', hozAlign: 'right', sorter: 'number', width: 96, minWidth: 92, formatter: (c) => money(c.getValue()) },
      { title: 'Amazon', field: 'cost', hozAlign: 'right', sorter: 'number', width: 96, minWidth: 92, formatter: (c) => (c.getRow().getData().has_cost ? money(c.getValue()) : '<span class="muted">—</span>') },
      { title: 'Fees', field: 'fees', hozAlign: 'right', width: 82, minWidth: 78, sorter: (a, b, ra, rb) => (a + ra.getData().ad_fees) - (b + rb.getData().ad_fees), formatter: (c) => money(c.getValue() + c.getRow().getData().ad_fees) },
      { title: 'Refund', field: 'refunds', hozAlign: 'right', sorter: 'number', width: 90, minWidth: 86, formatter: (c) => (c.getValue() ? `<span title="${refundWord(c.getRow().getData())}">${money(c.getValue(), 2)}</span>` : '<span class="muted">—</span>') },
      { title: 'Net', field: 'net', hozAlign: 'right', sorter: 'number', width: 96, minWidth: 90, formatter: (c) => { const d = c.getRow().getData(); return d.has_cost && !d.excluded ? `<b class="${d.net < 0 ? 'neg' : 'pos'}">${money(d.net)}</b>` : noNetLabel(d); } },
      { title: 'Margin', field: 'margin', hozAlign: 'right', sorter: 'number', width: 86, minWidth: 82, formatter: (c) => (c.getRow().getData().has_cost ? pct(c.getValue()) : '') },
      { title: 'Status', field: 'status', width: 160, minWidth: 156, formatter: (c) => statusPill(viewStatus(c.getRow().getData())) },
    ],
  }));
  const apply = () => {
    const v = ($('#ord-q').value || '').toLowerCase();
    t.setFilter((d) => matchFilter(d, state.ordersFilter) && (!v || [d.source === 'ledger' ? 'monthly sheet' : d.order_id, d.ebay_order_id, d.title, d.buyer, d.ship_name, ...d.amazon_orders.map((a) => a.amazon_order_id)].some((x) => (x || '').toLowerCase().includes(v))));
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

// "Loss" means what the Overview counts as loss-making: any counted order with a negative net (a returned or
// cancelled-after-purchase order can be a loss too). Other filters follow the order's status.
// Not-dropship sales are hidden everywhere except the Excluded filter
const matchFilter = (o, f) => (f === 'loss' ? Boolean(o.counted) && o.net < 0 : f === 'all' ? o.status !== 'not_dropship' : o.status === f || (f === 'cancelled' && o.status === 'cancelled_after_purchase') || (f === 'excluded' && o.status === 'not_dropship'));

export const ORDER_EXPORT = [
  { title: 'Date', get: (o) => o.created_at }, { title: 'eBay order', get: (o) => (o.source === 'ledger' ? orderLabel(o) : o.order_id) }, { title: 'Item', get: (o) => o.title },
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
  const sheet = o.source === 'ledger'; // monthly-sheet row: revenue is the eBay payout after fees
  const row = (k, v, color, cls = '') => `<div class="calc-row ${cls}"><span class="k">${color ? `<i style="background:${color}"></i>` : ''}${k}</span><span>${v}</span></div>`;
  $('#drawer').innerHTML = `
    <div class="drawer-h">
      <div style="min-width:0">
        <div class="row" style="gap:8px">${statusPill(viewStatus(o))}<span class="${o.source === 'ledger' ? '' : 'mono '}muted">${esc(orderLabel(o))}</span></div>
        <div style="font-weight:650;font-size:15px;margin-top:8px;line-height:1.35">${esc(o.title)}</div>
        <div class="muted" style="font-size:12.5px;margin-top:4px">${[
          o.approx_date ? `${new Date(o.created_at).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })} (from monthly sheet, exact date unknown)` : fmtDateTime(o.created_at),
          esc(o.buyer || ''),
          esc([o.ship_name, o.ship_city, o.ship_state, o.ship_zip].filter(Boolean).join(', ')),
        ].filter(Boolean).join(' · ')}</div>
      </div>
      <button class="btn icon-btn ghost" id="drawer-x" style="margin-left:auto" aria-label="Close">${ICONS.x}</button>
    </div>
    <div class="drawer-b">
      <div class="drawer-summary">
        <div><div class="k"><i class="sw" style="background:${c.revenue}"></i>${sheet ? 'eBay payout' : 'Buyer paid'}</div><div class="v">${money(o.revenue)}</div></div>
        <div><div class="k"><i class="sw" style="background:${c.cost}"></i>Amazon cost</div><div class="v">${o.has_cost ? money(o.cost) : '<span class="muted">—</span>'}</div></div>
        <div><div class="k"><i class="sw" style="background:${o.net < 0 ? c.bad : c.profit}"></i>Net profit</div><div class="v ${o.has_cost && !o.excluded ? (o.net < 0 ? 'neg' : 'pos') : 'muted'}">${o.has_cost && !o.excluded ? money(o.net) : noNetLabel(o)}</div></div>
      </div>
      <h4>Profit math</h4>
      ${row(sheet ? 'eBay payout (after fees)' : 'Buyer paid (excl. tax)', money(o.revenue), c.revenue)}
      ${row(sheet ? 'Amazon cost (from sheet)' : 'Amazon cost', o.has_cost ? `−${money(o.cost)}` : '<span class="muted">not linked yet</span>', c.cost)}
      ${sheet && !o.fees ? row('eBay fees', '<span class="muted">already out of the payout</span>', c.fees) : row('eBay fees', `−${money(o.fees)}${o.overrides.fee_override !== null ? ' <span class="pill">edited</span>' : ''}`, c.fees)}
      ${o.ad_fees ? row('Promoted listing fee', `−${money(o.ad_fees)}`, c.ads) : ''}
      ${o.refunds ? row(refundWord(o), `−${money(o.refunds, 2)}`, c.refunds) : ''}
      ${o.amazon_refund ? row('Recovered from Amazon', `+${money(o.amazon_refund)}`, c.good) : ''}
      ${o.extra_cost ? row('Other costs', `−${money(o.extra_cost)}`, c.ink3) : ''}
      ${row('Net profit', o.has_cost && !o.excluded ? `<span class="${o.net < 0 ? 'neg' : 'pos'}">${money(o.net)}</span>` : noNetLabel(o), null, 'total')}
      <div class="muted" style="font-size:12px">${o.has_cost ? `${pct(o.margin)} margin · ${pct(o.roi)} ROI` : 'Profit shows once an Amazon purchase is linked or a cost is entered in the Editor.'}${o.tax_collected ? ` · ${money(o.tax_collected)} sales tax collected by eBay (not revenue)` : ''}</div>

      ${o.ledger ? `<h4>Monthly sheet row</h4><div class="sub-card"><div class="t">${esc(o.ledger.title)}</div><div class="m"><span>${monthLabel(o.ledger.month, 'long')}</span><span>Amazon cost ${money(o.ledger.amazon_cost, 2)}</span><span>${o.ledger.sale_price < 0 ? `eBay refund fee ${money(-o.ledger.sale_price, 2)}` : `eBay payout ${money(o.ledger.sale_price, 2)}`}</span>${o.ledger.note ? `<span>${esc(o.ledger.note)}</span>` : ''}</div><div class="m" style="margin-top:6px">${o.source === 'ledger' ? 'Revenue here is the eBay payout after eBay fees, as the sheet records it. When eBay syncs this sale, it is matched automatically and the real order takes over.' : 'This eBay order was matched to the sheet row. Its Amazon cost comes from the sheet.'}</div></div>` : ''}
      <h4>eBay items</h4>
      ${o.items.map((i) => `<div class="sub-card"><div class="t">${esc(i.title)}</div><div class="m"><span>Qty ${i.quantity}</span>${sheet ? (i.unit_price > 0 ? `<span>${money(i.unit_price, 2)} payout (after fees)</span>` : '') : `<span>${money(i.unit_price)} each</span>`}${i.sku ? `<span class="mono">SKU ${esc(i.sku)}</span>` : ''}${i.item_id ? `<a href="https://www.ebay.com/itm/${esc(i.item_id)}" target="_blank" rel="noopener">View listing ↗</a>` : ''}</div></div>`).join('')}

      ${o.status === 'awaiting_cost' ? awaitingPanel(o) : ''}
      <h4>Linked Amazon purchases</h4>
      ${o.amazon_orders.length ? o.amazon_orders.map((a) => `<div class="sub-card">
          <div class="row"><span class="mono">${esc(a.amazon_order_id)}</span><span class="pill ${a.method === 'manual' ? 'info' : 'good'}">${a.method === 'manual' ? 'Linked by hand' : 'Auto-matched'}</span><b style="margin-left:auto">${money(a.cost)}</b></div>
          <div class="m">${a.order_date ? `<span>Ordered ${fmtDate(a.order_date + 'T12:00')}</span>` : ''}${a.reasons ? `<span>${esc(a.reasons)}</span>` : ''}</div>
          ${a.lines.map((l) => `<div class="m" style="margin-top:6px"><span>${esc(trunc(l.title, 70))}</span><span>×${l.quantity}</span><span>${money(l.cost)}${l.ignored ? ' (ignored)' : ''}</span></div>`).join('')}
          <div style="margin-top:8px"><button class="btn sm danger" data-unlink="${esc(a.amazon_order_id)}">Unlink</button></div>
        </div>`).join('') : '<div class="muted" style="font-size:13px">None yet. Purchases arrive from the <a href="#/settings?focus=email">Amazon email import</a>; you can also link one by hand in Editor → Amazon purchases, or type a cost override in the spreadsheet.</div>'}

      ${o.returns.length ? `<h4>Returns</h4>${o.returns.map((r) => `<div class="sub-card"><div class="row"><b>${esc((r.reason || 'Return').replace(/_/g, ' ').toLowerCase())}</b><span class="pill warn" style="margin-left:auto">${esc((r.status || r.state || '').replace(/_/g, ' ').toLowerCase())}</span></div><div class="m"><span>${sheet ? 'Month of' : 'Opened'} ${r.created_at ? (sheet ? monthLabel(o.ledger?.month || '', 'long') : fmtDate(r.created_at)) : '—'}</span><span>${sheet ? 'eBay refund fee' : 'Refund'} ${money(r.refund_amount, 2)}</span></div></div>`).join('')}` : ''}

      ${o.overrides.notes ? `<h4>Notes</h4><div class="sub-card">${esc(o.overrides.notes)}</div>` : ''}
      <div class="row" style="margin-top:22px"><a class="btn" href="#/editor?order=${encodeURIComponent(o.order_id)}">${ICONS.editor} Edit in spreadsheet</a></div>
    </div>`;
  if (!$('#drawer').classList.contains('open')) drawerReturnFocus = document.activeElement;
  $('#drawer').classList.add('open');
  $('#drawer').setAttribute('aria-hidden', 'false');
  $('#scrim').classList.add('open');
  requestAnimationFrame(() => $('#drawer-x')?.focus({ preventScroll: true }));
  $('#drawer-x').onclick = closeDrawer;
  $('#chk-email')?.addEventListener('click', () => checkEmailFor(o, id));
  $$('[data-unlink]').forEach((b) => (b.onclick = async () => {
    if (!confirm('Unlink this Amazon order from the sale? It won\'t be auto-matched to this sale again.')) return;
    await api('/api/links', { method: 'POST', body: { amazon_order_id: b.dataset.unlink, ebay_order_id: null } });
    toast('Unlinked');
    await loadData();
    renderPage();
    openOrder(id);
  }));
}
// Uncosted sale: say exactly what is missing. Not counted in any numbers until it is resolved.
function awaitingPanel(o) {
  if (viewStatus(o) === 'awaiting_email') {
    return `<div class="await-box">
      <div class="await-h">${ICONS.mail}<div><b>Awaiting the Amazon order email</b><div class="muted">This sale isn't in any totals until its Amazon purchase is matched. After ${10} days with no match it's treated as not a dropship sale.</div></div></div>
      <button class="btn primary sm" id="chk-email">${ICONS.refresh} Check email now</button>
      <div id="chk-out" class="await-out" aria-live="polite"></div>
    </div>`;
  }
  return `<div class="await-box warn">
      <div class="await-h">${ICONS.alert}<div><b>Amazon order found, but its cost is unknown</b><div class="muted">The Amazon email had no usable total (for example, paid with a gift card). Type the real cost in the spreadsheet and it counts right away.</div></div></div>
      <a class="btn primary sm" href="#/editor?order=${encodeURIComponent(o.order_id)}">${ICONS.editor} Enter the cost</a>
    </div>`;
}

async function checkEmailFor(o, id) {
  const btn = $('#chk-email');
  const out = $('#chk-out');
  btn.disabled = true;
  btn.innerHTML = `${ICONS.refresh} Checking email…`;
  out.innerHTML = '';
  try {
    const r = await api(`/api/orders/${encodeURIComponent(id)}/check-email`, { method: 'POST' });
    if (r.matched) {
      toast(`Matched: Amazon order ${r.links.map((l) => l.amazon_order_id).join(', ')}${r.links[0]?.total ? ` (${money(Number(r.links[0].total), 2)})` : ''}`, 'good');
      await loadData();
      renderPage();
      openOrder(id);
      return;
    }
    const why = r.ok ? 'No matching Amazon order email yet.' : `The email check didn't run: ${esc(r.log?.at(-1) || 'unknown error')}`;
    out.innerHTML = `<div class="await-res">${ICONS.info}<span>${why}${r.ok ? ' Checked just now.' : ''}</span></div>${r.candidates?.length ? `
      <div class="await-cands"><div class="muted" style="font-size:12px;margin:10px 0 6px">Possible matches the matcher wasn't sure enough to link on its own:</div>
      ${r.candidates.map((c) => `<div class="sub-card"><div class="row"><span class="mono">${esc(c.amazon_order_id)}</span><b style="margin-left:auto">${c.total === null ? '<span class="muted">total unknown</span>' : money(c.total, 2)}</b></div>
        <div class="m">${c.order_date ? `<span>Ordered ${fmtDate(c.order_date + 'T12:00')}</span>` : ''}${c.ship ? `<span>Ship to ${esc(c.ship.slice(0, 60))}</span>` : ''}<span>${esc(c.reasons)}</span></div>
        <div style="margin-top:8px"><button class="btn sm" data-link-az="${esc(c.amazon_order_id)}">${ICONS.link} This is the purchase: link it</button></div></div>`).join('')}</div>` : ''}`;
    out.querySelectorAll('[data-link-az]').forEach((b) => (b.onclick = async () => {
      if (!confirm(`Link Amazon order ${b.dataset.linkAz} to this sale? Its cost will count toward profit.`)) return;
      await api('/api/links', { method: 'POST', body: { amazon_order_id: b.dataset.linkAz, ebay_order_id: id } });
      toast('Linked', 'good');
      await loadData();
      renderPage();
      openOrder(id);
    }));
  } catch (e) {
    out.innerHTML = `<div class="await-res bad">${ICONS.alert}<span>${esc(e.message)}</span></div>`;
  }
  if (btn.isConnected) { btn.disabled = false; btn.innerHTML = `${ICONS.refresh} Check email again`; }
}

let drawerReturnFocus = null;
export function closeDrawer() {
  const wasOpen = $('#drawer').classList.contains('open');
  $('#drawer').classList.remove('open');
  $('#drawer').setAttribute('aria-hidden', 'true');
  $('#scrim').classList.remove('open');
  if (wasOpen && drawerReturnFocus?.isConnected) drawerReturnFocus.focus({ preventScroll: true });
  drawerReturnFocus = null;
}
$('#scrim').addEventListener('click', closeDrawer);
// Capture phase so a focused table/editor can't swallow Escape; an open cell editor keeps Escape to cancel its edit
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !$('#drawer').classList.contains('open')) return;
  if (e.target.closest?.('.tabulator-editing')) return;
  e.preventDefault();
  closeDrawer();
}, true);
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
  const rs = refundSplit(all.filter((o) => o.counted));
  el.innerHTML = `
  <div class="kpis six">
    ${kpi({ label: 'Returned orders', sw: '--s-refunds', value: count(ret.length), foot: `${count(open.length)} still open` })}
    ${kpi({ label: 'Return rate', value: pct(s.returnRate), foot: 'of orders in range' })}
    ${kpi({ label: 'Refunded to buyers', value: money(rs.buyer, 2), foot: rs.fee ? `+ ${money(rs.fee, 2)} eBay refund fees on sheet rows` : 'eBay orders', tip: 'Monthly-sheet refund rows record the eBay refund fee (e.g. $0.40), not money sent back to the buyer, so they are listed separately.' })}
    ${kpi({ label: 'Recovered from Amazon', sw: '--good', value: money(recovered, 2), foot: 'entered in Editor' })}
    ${kpi({ label: 'Net loss on returns', value: `<span class="${lossOnReturns < 0 ? 'neg' : ''}">${money(lossOnReturns, 2)}</span>` })}
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
    tooltip: { ...tooltipBase(), trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(127,127,127,.08)' } }, formatter: (ps) => { const b = bs[ps[0].dataIndex]; const x = refundSplit(b.orders.filter((o) => o.counted)); return ttHead(labels[ps[0].dataIndex]) + ttRow(c.refunds, 'Returned orders', count(b.returnCount)) + ttRow(c.ink3, 'Return rate', pct(b.returnRate)) + ttRow(c.ink3, 'Refunded to buyers', money(x.buyer, 2)) + (x.fee ? ttRow(c.ink3, 'eBay refund fees', money(x.fee, 2)) : ''); } },
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
    ${prodRet.map((p) => `<tr><td title="${esc(p.title)}">${esc(trunc(p.title, 48))}</td><td class="r">${p.returnCount}</td><td class="r ${p.returnRate > 0.1 ? 'neg' : ''}">${pct(p.returnRate, 0)}</td><td class="r ${p.net < 0 ? 'neg' : ''}">${money(p.net, 2)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No returns in this range 🎉</div>';

  const t = trackTable(new Tabulator('#ret-table', {
    data: ret, layout: 'fitColumns', height: 420, placeholder: 'No returns in this range',
    initialSort: [{ column: 'created_at', dir: 'desc' }],
    columns: [
      { title: 'Sold', field: 'created_at', width: 90, formatter: (c) => fmtDate(c.getValue()) },
      { title: 'Item', field: 'title', minWidth: 160, formatter: (c) => esc(trunc(c.getValue(), 50)) },
      { title: 'Refund / fee', field: 'refunds', hozAlign: 'right', sorter: 'number', width: 110, formatter: (c) => { const d = c.getRow().getData(); return `<span title="${refundWord(d)}">${money(c.getValue(), 2)}</span>${d.source === 'ledger' && c.getValue() ? '<div class="muted" style="font-size:11px">eBay refund fee</div>' : ''}`; } },
      { title: 'Net', field: 'net', hozAlign: 'right', sorter: 'number', width: 90, formatter: (c) => (c.getRow().getData().has_cost ? `<span class="${c.getValue() < 0 ? 'neg' : 'pos'}">${money(c.getValue(), 2)}</span>` : '—') },
    ],
  }));
  t.on('rowClick', (_e, row) => openOrder(row.getData().order_id));
}

// ---------------------------------------------------------------- IMPORT
// Monthly partner sheets: the only upload in the app. Amazon costs otherwise arrive from the email import.
const monthName = (m) => { const [y, mo] = m.split('-').map(Number); return new Date(y, mo - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }); };

// Derived from the dataset (ledger rows carry their source file), so it never drifts from what is actually loaded
function sheetsOnFile() {
  const d = state.data;
  const byMonth = new Map();
  for (const o of d.orders) {
    if (!o.ledger) continue;
    const m = o.ledger.month;
    if (!byMonth.has(m)) byMonth.set(m, { month: m, file: o.ledger.source_file, rows: 0, matched: 0, cost: 0, payout: 0 });
    const x = byMonth.get(m);
    x.rows++;
    if (o.source !== 'ledger') x.matched++;
    x.cost += Number(o.ledger.amazon_cost) || 0;
    x.payout += Number(o.ledger.sale_price) || 0;
    if (o.ledger.source_file) x.file = o.ledger.source_file;
  }
  for (const e of d.books.expenses) {
    if (e.source !== 'sheet') continue;
    if (!byMonth.has(e.month)) byMonth.set(e.month, { month: e.month, file: null, rows: 0, matched: 0, cost: 0, payout: 0 });
    const x = byMonth.get(e.month);
    x.expenses = (x.expenses || 0) + 1;
    x.expenseTotal = (x.expenseTotal || 0) + (Number(e.amount) || 0);
  }
  for (const s of d.books.settlements) {
    const x = byMonth.get(s.month);
    if (x && /sheet/i.test(s.note || '')) x.paid = s.paid;
  }
  return [...byMonth.values()].sort((a, b) => (a.month < b.month ? 1 : -1));
}

function sheetsTable(rows) {
  if (!rows.length) return `<div class="empty"><div class="ic">${ICONS.sheet}</div><div class="t">No monthly sheets yet</div>Drop the first settlement sheet above and its sales, expenses and payment will appear here.</div>`;
  return `<table class="simple"><thead><tr><th>Month</th><th>File</th><th class="r">Sales rows</th><th class="r">Matched to eBay</th><th class="r">Expenses</th><th class="r">Paid on sheet</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td style="white-space:nowrap"><b>${monthName(r.month)}</b></td><td class="muted" style="font-size:12px;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.file || '')}">${esc(r.file || '—')}</td><td class="r">${count(r.rows)}</td><td class="r">${r.rows ? `${count(r.matched)} <span class="muted">/ ${count(r.rows)}</span>` : '—'}</td><td class="r" style="white-space:nowrap">${r.expenses ? `${money(r.expenseTotal, 2)} <span class="muted">· ${count(r.expenses)}</span>` : '<span class="muted">—</span>'}</td><td class="r" style="white-space:nowrap">${r.paid !== undefined ? `<span class="pill good">${money(r.paid, 2)}</span>` : '<span class="muted">—</span>'}</td></tr>`).join('')}
  </tbody></table>`;
}

async function importPage(el) {
  const d = state.data;
  const em = emailState();
  el.innerHTML = `
  <div class="grid g-12">
    <div class="c-7 stack">
      <label class="dropzone" id="dz">
        <input type="file" id="file" accept=".csv,text/csv" multiple hidden />
        <div class="dz-ic">${ICONS.sheet}</div>
        <div class="t">Drop a monthly settlement sheet here</div>
        <div class="s">The partner CSV with <b>Item Name · Amazon Cost · eBay Sale Price</b>. Re-uploading a month updates it; nothing is ever double-counted.</div>
        <span class="btn sm">${ICONS.import} Choose files</span>
      </label>
      <div id="import-result" class="stack"></div>
      ${card('Sheets on file', 'One row per month loaded from a settlement sheet', '<div class="table-wrap" id="imports"></div>')}
    </div>
    <div class="c-5 stack">
      ${card('Where Amazon costs come from', 'Sheets are the monthly record; day-to-day costs arrive by email', `
        <div class="status-card ${em.dot === 'ok' ? 'good' : em.dot === 'bad' ? 'bad' : 'warn'}"><div class="ic">${ICONS.mail}</div><div><div class="t">Amazon email import</div><div class="s">${em.line}${d.email.configured ? ` · reading ${esc(d.email.user)}` : ' · costs arrive automatically once connected'}</div></div><a class="btn sm" href="#/settings?focus=email">${d.email.configured ? 'Status' : 'Set up'}</a></div>
        <div class="stat-row" style="margin-top:10px"><span class="k">Amazon purchases on record</span><span class="v">${count(d.amazon.orders)} <span class="muted">· ${count(d.amazon.linked)} linked</span></span></div>
        <div class="stat-row"><span class="k">Cost overrides and manual links</span><span class="v"><a href="#/editor">Editor ${ICONS.arrow.replace('<svg', '<svg style="width:12px;height:12px"')}</a></span></div>`)}
      ${card('How a sheet is read', 'Same rules every month', `<ol class="rules">
        <li><b>The month comes from the file name</b>, e.g. <span class="mono">SEP 26</span>, or from the sheet's title row.</li>
        <li><b>Section 1 becomes sales.</b> Each row is keyed by month + item name, so an edited sheet updates in place and rows you deleted disappear too.</li>
        <li><b>Section 2 becomes operating expenses</b>, one per category, and a <b>Paid</b> line is recorded as that month's settlement payment.</li>
        <li><b>Rows match real eBay orders</b> once eBay syncs: same month, similar title and a payout that fits the order's price after fees. The sheet then supplies that order's Amazon cost.</li>
        <li><b>Totals are checked</b> against the sheet's <i>Total Transactions</i> row and any difference is shown right after upload.</li>
      </ol>`)}
    </div>
  </div>`;
  const dz = $('#dz');
  const input = $('#file');
  input.addEventListener('change', () => upload([...input.files]));
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('over'); upload([...e.dataTransfer.files].filter((f) => /\.csv$/i.test(f.name) || f.type.includes('csv'))); });
  $('#imports').innerHTML = sheetsTable(sheetsOnFile());

  const okIcon = ICONS.check.replace('<svg', '<svg style="width:15px;height:15px;color:var(--good-ink);vertical-align:-2px"');
  const warnIcon = ICONS.alert.replace('<svg', '<svg style="width:15px;height:15px;color:var(--warn-ink);vertical-align:-2px"');
  async function upload(files) {
    if (!files.length) return;
    const fd = new FormData();
    files.forEach((f) => fd.append('files', f));
    $('#import-result').innerHTML = `<div class="card"><div class="card-b"><div class="row" style="margin-bottom:6px"><span class="dot spin"></span>Reading ${files.length} sheet${files.length > 1 ? 's' : ''} and matching rows to eBay sales…</div>${skeletonRows(4).replace('class="sk-rows"', 'class="sk-rows" style="padding:8px 0 0"')}</div></div>`;
    try {
      const results = await api('/api/amazon/import', { method: 'POST', body: fd });
      $('#import-result').innerHTML = results.map((r) => r.kind === 'ledger' ? card(`${okIcon} ${esc(r.filename)}`, `Monthly settlement sheet · ${monthName(r.month)}`, `
        <div class="result-grid">
          <div class="result-cell"><div class="v">${count(r.linesNew)}</div><div class="k">new sales rows</div></div>
          <div class="result-cell"><div class="v">${count(r.linesUnchanged + r.linesUpdated)}</div><div class="k">already on file (${count(r.linesUpdated)} updated), not duplicated</div></div>
          <div class="result-cell"><div class="v">${money(r.expenseTotal, 2)}</div><div class="k">${count(r.expenses)} operating expenses</div></div>
          <div class="result-cell"><div class="v">${count(r.matchedToEbay)}</div><div class="k">rows matched to synced eBay orders</div></div>
          ${r.settlementPaid !== null && r.settlementPaid !== undefined ? `<div class="result-cell"><div class="v pos">${money(r.settlementPaid, 2)}</div><div class="k">recorded as paid for this month</div></div>` : ''}
        </div>
        <div style="margin-top:10px;font-size:12.5px" class="${r.checks.every((c) => c.ok) ? 'pos' : 'neg'}">${r.checks.length ? (r.checks.every((c) => c.ok) ? '✓ Totals match the sheet’s Total Transactions row' : `Totals differ from the sheet: ${r.checks.filter((c) => !c.ok).map((c) => `${c.field} sheet ${c.sheet} vs ${c.computed}`).join(', ')}`) : ''}</div>`)
        : card(`${warnIcon} ${esc(r.filename)}`, 'Not a monthly settlement sheet', `<div class="ink2" style="font-size:13px">This file has no <b>Item Name / Amazon Cost / eBay Sale Price</b> columns, so it was not treated as a sheet. Amazon purchases come in through the <a href="#/settings?focus=email">email import</a>; upload only the partner settlement sheets here.</div>`)).join('');
      toast('Sheet import complete', 'good');
      await loadData();
      $('#imports').innerHTML = sheetsTable(sheetsOnFile());
    } catch (e) {
      $('#import-result').innerHTML = `<div class="banner bad">${ICONS.alert}<div><b>Import failed.</b> ${esc(e.message)}</div></div>`;
    }
    input.value = '';
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
  el.innerHTML = skeleton(); // the page waits on two log fetches; show its shape rather than a blank screen
  const log = await api('/api/sync-log').catch(() => []);
  const em = d.email;
  const mails = em.configured ? await api('/api/email/log').catch(() => []) : [];
  const focus = new URLSearchParams(location.hash.split('?')[1] || '').get('focus');
  el.innerHTML = `<div class="grid g-12">
    <div class="c-7 stack">
      <div class="section-h" style="margin-top:0"><h2>Data sources</h2><span class="sub">where sales and costs come from</span></div>
      ${emailCard(em, mails)}
      ${ebayCard(e, log)}
      ${card('Matching rules', 'Controls how Amazon purchases link to eBay sales', `
        <div class="field-h">Home / personal zip codes</div>
        <div class="field-s">Amazon orders shipped to these zips are always treated as personal and never counted.</div>
        <div class="row"><input class="input" id="home-zips" style="flex:1" placeholder="e.g. 62701, 62702" value="${esc((d.settings.home_zips || []).join(', '))}" /></div>
        <div class="row mt"><button class="btn" id="rematch">Re-run matcher</button><span class="muted" style="font-size:12px">Looks for new links among unlinked Amazon orders. Existing links are kept.</span></div>`, { cls: 'set-card' })}
    </div>
    <div class="c-5 stack">
      <div class="section-h" style="margin-top:0"><h2>Partnership</h2><span class="sub">drives the Settlement page</span></div>
      ${card('Partners', 'Who pays what, and how profit is split', `<div class="grid" style="grid-template-columns:1fr 1fr;gap:12px">
        <label class="field">Pays Amazon (COGS)<input class="input" id="p-amazon" value="${esc(d.settings.partner_amazon)}" /></label>
        <label class="field">Collects eBay, pays expenses<input class="input" id="p-ebay" value="${esc(d.settings.partner_ebay)}" /></label>
        <label class="field">Profit share to the Amazon partner (%)<input class="input" id="p-split" type="number" min="0" max="100" value="${Number(d.settings.split_amazon)}" /></label>
        <label class="field">Settlement due day of month<input class="input" id="p-due" type="number" min="1" max="28" step="1" value="${Number(d.settings.settlement_day) || 26}" /></label></div>
        <div class="muted" style="font-size:12px;margin-top:10px">${esc(d.settings.partner_amazon)} ${Number(d.settings.split_amazon)}% · ${esc(d.settings.partner_ebay)} ${100 - Number(d.settings.split_amazon)}% · each month is due on the ${Number(d.settings.settlement_day) || 26}th of each month</div>`, { cls: 'set-card' })}
      ${card('Goal', 'Shown on the Overview as a progress bar', `<label class="field">Monthly item-profit goal<input class="input" id="goal" type="number" min="0" step="50" value="${Number(d.settings.monthly_goal) || ''}" placeholder="2500" /></label>`, { cls: 'set-card' })}
      <div class="row"><button class="btn primary" id="save-settings">${ICONS.save} Save settings</button><span class="muted" style="font-size:12px">Saves partners, split, goal and zip codes</span></div>
      <div class="section-h"><h2>Data</h2></div>
      ${card('Storage', '', `
        <div class="stat-row"><span class="k">Database</span><span class="v">${d.db === 'local-postgres' ? 'Local embedded Postgres' : 'Supabase Postgres'}</span></div>
        <div class="stat-row"><span class="k">eBay orders stored</span><span class="v">${count(d.orders.filter((o) => o.source === 'ebay').length)}</span></div>
        <div class="stat-row"><span class="k">Monthly-sheet sales rows</span><span class="v">${count(d.orders.filter((o) => o.source === 'ledger').length)}${d.orders.some((o) => o.source === 'ledger' && o.ebay_order_id) ? ` <span class="muted">(${count(d.orders.filter((o) => o.source === 'ledger' && o.ebay_order_id).length)} matched to eBay)</span>` : ''}</span></div>
        <div class="stat-row"><span class="k">Amazon orders stored</span><span class="v">${count(d.amazon.orders)} (${count(d.amazon.linked)} linked)</span></div>
        <div class="row mt"><button class="btn" id="export-all">${ICONS.down} Export all orders (CSV)</button>
        ${demo ? `<button class="btn danger" id="clear-demo">Remove ${count(demo)} demo orders</button>` : ''}</div>`, { cls: 'set-card' })}
    </div></div>`;
  if (focus === 'email') {
    const target = $('#email-card');
    if (target) {
      target.classList.add('focus');
      requestAnimationFrame(() => target.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      setTimeout(() => target.classList.remove('focus'), 2600);
    }
  }
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
    const dueDayVal = Math.min(28, Math.max(1, Number($('#p-due').value) || 26));
    await api('/api/settings', { method: 'POST', body: { home_zips: $('#home-zips').value.split(/[,\s]+/).filter(Boolean), monthly_goal: $('#goal').value, partner_amazon: $('#p-amazon').value, partner_ebay: $('#p-ebay').value, split_amazon: $('#p-split').value, settlement_day: dueDayVal } });
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
  const busy = syncInProgress(e);
  const statusPillHtml = busy ? '<span class="pill info"><span class="dot spin" style="width:6px;height:6px"></span>Syncing…</span>'
    : e.needsReconnect ? '<span class="pill bad">Reconnect needed</span>'
    : e.last?.ok ? '<span class="pill good">Connected</span>'
    : syncFailed(e) ? '<span class="pill bad">Last sync failed</span>'
    : '<span class="pill warn">Not synced yet</span>';
  const status = e.configured ? `
      <div class="stat-row"><span class="k">Status</span><span class="v">${statusPillHtml}${busy && e.last?.started_at ? ` <span class="muted" style="font-size:12px">started ${ago(e.last.started_at)}</span>` : ''}</span></div>
      <div class="stat-row"><span class="k">Last successful sync</span><span class="v">${e.lastSuccess ? fmtDateTime(e.lastSuccess) : '—'}</span></div>
      ${e.connectedAt ? `<div class="stat-row"><span class="k">Connected</span><span class="v">${fmtDateTime(e.connectedAt)}</span></div>` : ''}
      ${e.refreshExpiresAt ? `<div class="stat-row"><span class="k">Connection valid until</span><span class="v ${expSoon ? 'neg' : ''}">${fmtDate(e.refreshExpiresAt, { month: 'short', day: 'numeric', year: 'numeric' })}${expSoon ? ', reconnect soon' : ''}</span></div>` : ''}` : '';
  const logHtml = log.length ? `${h4('Recent syncs')}<table class="simple"><tbody>${log.slice(0, 6).map((l) => `<tr><td style="white-space:nowrap">${fmtDateTime(l.started_at)}</td><td>${l.ok ? '<span class="pill good">ok</span>' : l.finished_at ? '<span class="pill bad">failed</span>' : '<span class="pill">running</span>'}</td><td class="muted" style="font-size:12px">${esc(l.message || '')}</td></tr>`).join('')}</tbody></table>` : '';
  return card('eBay sales', e.configured ? 'Connected · the source of every sale, fee and refund' : 'Not connected yet · sales come in automatically once connected', `
    ${status}
    ${e.configured ? '' : rows}
    <div class="row mt">${connectBtn}${e.configured ? '<button class="btn" id="sync-now">Sync now</button>' : ''}<span class="muted" style="font-size:12px">Syncs automatically every 30 minutes once connected</span></div>
    ${logHtml}`, { cls: 'set-card', right: !e.configured ? '<span class="pill warn">Not connected</span>' : busy ? '<span class="pill info">Syncing…</span>' : e.needsReconnect ? '<span class="pill bad">Reconnect</span>' : syncFailed(e) ? '<span class="pill bad">Failing</span>' : '<span class="pill good">Connected</span>' });
}

function emailCard(em, mails) {
  const h4 = (t) => `<h4 style="margin:18px 0 6px;font-size:11.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--ink-3)">${t}</h4>`;
  const intro = '<p class="ink2" style="margin-top:0;font-size:13px">This is where Amazon costs come from. It reads only mail <b>from amazon.com</b>: order confirmations (cost, ship-to, items), cancellations (cost drops to $0) and refunds (logged as money recovered from Amazon). Purchases are keyed by Amazon order number, so nothing is ever double-counted, and each one links to its eBay sale by zip, name or tracking number.</p>';
  const opts = { id: 'email-card', cls: 'set-card' };
  if (!em.configured) {
    return card('Amazon purchases from email', 'Primary source of Amazon costs · not connected yet', `${intro}
      <table class="simple env-table"><tbody>
        <tr><td class="mono">EMAIL_USER</td><td>${em.user ? esc(em.user) : 'your Gmail address'}</td><td>${em.user ? '<span class="pill good">set</span>' : '<span class="pill bad">missing</span>'}</td></tr>
        <tr><td class="mono">EMAIL_PASSWORD</td><td>Gmail <b>App Password</b> (16 letters), not your normal password</td><td><span class="pill bad">missing</span></td></tr>
      </tbody></table>
      <p class="muted" style="font-size:12.5px;margin-bottom:0">Create one at <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener">myaccount.google.com/apppasswords</a> (2-Step Verification must be on). Put it in <span class="mono">.env</span> or Railway Variables, then restart. Until then, enter costs by hand in the <a href="#/editor">Editor</a>.</p>`, { ...opts, right: '<span class="pill warn">Not connected</span>' });
  }
  const rows = mails.map((m) => `<tr><td style="white-space:nowrap">${m.received_at ? fmtDate(m.received_at) : ''}</td>
    <td><span class="pill ${m.kind === 'order' ? 'info' : m.kind === 'refund' ? 'good' : 'warn'}">${m.kind}</span></td>
    <td style="font-size:12.5px">${esc(m.subject)}<div class="muted mono" style="font-size:11px">${esc((m.order_ids || []).join(' '))}${m.note ? ` · ${esc(m.note)}` : ''}</div></td>
    <td>${m.ok ? '' : '<span class="pill bad">review</span>'}</td></tr>`).join('');
  return card('Amazon purchases from email', `Primary source of Amazon costs · reading ${esc(em.user)}`, `${intro}
    <div class="stat-row"><span class="k">${em.running ? 'Status' : 'Last check'}</span><span class="v">${em.running ? '<span class="pill info"><span class="dot spin" style="width:6px;height:6px"></span>Checking mail…</span>' : em.last ? `${em.last.ok ? '<span class="pill good">ok</span>' : '<span class="pill bad">failed</span>'} ${fmtDateTime(em.last.at)}` : '—'}</span></div>
    ${em.last ? `<div class="muted" style="font-size:12.5px;padding:6px 0">${esc(em.last.log.join(' · '))}</div>` : ''}
    <div class="row mt"><button class="btn primary" id="mail-now">${ICONS.mail} Check email now</button><span class="muted" style="font-size:12px">Also runs every 30 minutes</span></div>
    ${mails.length ? `${h4('Recent Amazon emails')}<div class="table-wrap" style="max-height:320px;overflow:auto"><table class="simple"><tbody>${rows}</tbody></table></div>` : ''}`, { ...opts, right: em.running ? '<span class="pill info">Checking…</span>' : `<span class="pill ${em.last && !em.last.ok ? 'bad' : 'good'}">${em.last && !em.last.ok ? 'Failing' : 'Connected'}</span>` });
}

// ---------------------------------------------------------------- boot
renderRangeSeg();
route();
loadData().then(route).catch((e) => { $('#content').innerHTML = `<div class="banner">${ICONS.alert}<div><b>Couldn't load data.</b> ${esc(e.message)}</div></div>`; });
