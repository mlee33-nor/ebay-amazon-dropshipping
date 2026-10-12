import { $, $$, esc, money, moneyShort, pct, count, signed, fmtDate, fmtDateTime, fmtTime, ago, api, toast, downloadCsv, ICONS, DAY, countUp, dismissed, settlementDueDate, dueStatus, syncInProgress, syncFailed, monthLabel, settleView, orderLabel, azDay, azHour, azWeekday, azStart, addDays, daysBetween, accountId, setAccountId, apiLink } from './util.js';
import { rangeFor, previousRange, inRange, summarize, buckets, autoGran, byProduct, groupBy, STATUS_META, bucketKey, opexFor, isSale, saleIdOf, rowMonth, periodMonth } from './metrics.js';
import { ORDER_EXPORT } from './report-math.js';
import { ebayStepIssues, ebayIssueText, emailFailures, emailFailureText } from './health.js';
import { mount, disposeAll, colors, tooltipBase, axisBase, ttRow, ttHead, ttNote, sparkline, shadowPointer, crosshair, areaFade } from './charts.js';
import { renderEditor } from './editor.js';
import { renderSettlement } from './settle-page.js';
import { renderOpex } from './opex-page.js';
import { renderAsk } from './ask-page.js';
import { renderListingsPanel } from './listings-panel.js';
import { renderPromotionsPanel } from './promotions-panel.js';
import { renderWatch } from './watch-page.js';
import { renderReports } from './reports-page.js';
import { renderOverview } from './overview-page.js';
import { renderReview, reviewItems } from './review-page.js';
import { dashPrefs, showPage, showAlert, PAGE_OPTIONS, CARD_OPTIONS, ALERT_OPTIONS, defaultPrefs } from './dash-prefs.js';
import { settleMonth, allMonths, settlePeriodOf, settlePeriodRange, CYCLE_START } from './settlement.js';

export { ORDER_EXPORT };

// ---------------------------------------------------------------- state
const store = (k, v) => { try { if (v === undefined) return JSON.parse(localStorage.getItem(k)); localStorage.setItem(k, JSON.stringify(v)); } catch { return null; } };
const dueDayOf = () => Number(state.data?.settings?.settlement_day) || 26;
// The payment being built today (Arizona time): from the 27th it is next month's
const currentPeriod = () => settlePeriodOf(azDay(), dueDayOf());
export const state = {
  data: null,
  range: 'period', // every visit opens on this pay period; a choice made in the range bar lasts until the page is reloaded
  month: store('dd_month') || settlePeriodOf(azDay(), 26), // a payment (pay period), see rangeFor
  custom: store('dd_custom') || { from: addDays(azDay(), -29), to: azDay() },
  gran: null,
  page: 'overview',
  ordersFilter: 'all',
  compare: store('dd_compare') || false,
};
const tables = new Set();
export const trackTable = (t) => { tables.add(t); return t; };

const PAGES = [
  { id: 'overview', label: 'Overview', icon: 'overview', sub: 'Profit and what is owed, at a glance', group: 'Main' },
  { id: 'review', label: 'Review', icon: 'alert', sub: 'Things to look at: sales waiting for a cost, emails, eBay charges', noRange: true, group: 'Main' },
  { id: 'orders', label: 'Orders', icon: 'orders', sub: 'Every sale and what it made', group: 'Main' },
  { id: 'settlement', label: 'Settlement', icon: 'settle', sub: 'What Drew sends Myles each pay period, and the payments made', noRange: true, group: 'Main' },
  { id: 'reports', label: 'Statements', icon: 'receipt', sub: 'A statement for each payment, and the year-end export for taxes', noRange: true, group: 'Main' },
  { id: 'costs', label: 'Monthly costs', icon: 'wallet', sub: 'Subscriptions and tools that come out of profit before the split', noRange: true, group: 'Main' },
  { id: 'promotions', label: 'Promotions', icon: 'target', sub: 'Promoted listings: ad fees and what they sold', noRange: true, group: 'Main' },
  { id: 'ask', label: 'Ask AI', icon: 'spark', sub: 'Ask about the business in your own words · every answer comes straight from your numbers', noRange: true, group: 'Main' },
  { id: 'trends', label: 'Analytics', icon: 'trends', sub: 'Patterns, timing, pricing and geography', group: 'More' },
  { id: 'products', label: 'Products', icon: 'products', sub: 'Listings, views and what sells', group: 'More' },
  { id: 'returns', label: 'Returns', icon: 'returns', sub: 'Refunds, reasons and recovery', group: 'More' },
  { id: 'watch', label: 'Watchlist', icon: 'alert', sub: 'Money to chase and things to fix: Amazon refunds, unmatched purchases, weak products', noRange: true, group: 'More' },
  { id: 'editor', label: 'Editor', icon: 'editor', sub: 'Spreadsheet mode: fix a cost or match by hand', noRange: true, group: 'More' },
  { id: 'import', label: 'Monthly sheets', icon: 'sheet', sub: 'Check the partners\' sheets against the site', noRange: true, group: 'More' },
  { id: 'settings', label: 'Settings', icon: 'settings', sub: 'Connections, partners, and what the dashboard shows', noRange: true, group: 'Settings' },
];

// ---------------------------------------------------------------- data
export async function loadData() {
  try { state.data = await api('/api/data'); } catch (e) {
    if (!/Unknown account/.test(e.message)) throw e;
    setAccountId('main');
    state.data = await api('/api/data');
  }
  renderAccountSwitch();
  renderRangeSeg();
  renderSidebarFoot();
  renderNav();
  return state.data;
}

// Today, this pay period (27th to 26th), the one before it, a pay period picked from the list, all time, or dates
const prevPeriod = (m) => { const [y, mo] = m.split('-').map(Number); return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`; };
const range = () => {
  const dueDay = dueDayOf();
  if (state.range === 'today') return rangeFor('1d', null, null, { dueDay });
  if (state.range === 'period') return rangeFor('month', null, currentPeriod(), { dueDay });
  if (state.range === 'lastperiod') return rangeFor('month', null, prevPeriod(currentPeriod()), { dueDay });
  return rangeFor(state.range, state.custom, state.month, { dueDay });
};
export const currentRange = range;
export { currentPeriod };
const scoped = () => inRange(state.data.orders, range());
const prevScoped = () => inRange(state.data.orders, previousRange(range()));

// ---------------------------------------------------------------- shell
function renderNav() {
  const d = state.data;
  const badges = {
    editor: d?.amazon?.suggestions || 0,
    orders: d ? d.orders.filter((o) => o.status === 'awaiting_cost').length : 0,
    review: d ? reviewItems(d).open : 0,
  };
  const groups = [];
  // Pages switched off in Settings -> Customize dashboard are left out of the menu (the open one always shows)
  for (const p of PAGES.filter((x) => x.id === state.page || !d || showPage(d.settings, x.id))) {
    let g = groups.find((x) => x.name === p.group);
    if (!g) { g = { name: p.group, pages: [] }; groups.push(g); }
    g.pages.push(p);
  }
  $('#nav').innerHTML = groups.map((g) => `${g.name === 'Main' || g.name === 'Settings' ? '' : `<div class="nav-label">${g.name}</div>`}${g.name === 'Settings' ? '<div class="nav-sep"></div>' : ''}${g.pages.map(navLink).join('')}`).join('');
  function navLink(p) {
    let b = '';
    if (p.id === 'editor' && badges.editor) b = `<span class="badge" title="Suggested matches to review">${badges.editor}</span>`;
    else if (p.id === 'review' && badges.review) b = `<span class="badge" title="Things to look at">${badges.review}</span>`;
    else if (p.id === 'orders' && badges.orders) b = `<span class="nav-count" title="Sales awaiting their Amazon order email">${badges.orders}</span>`;
    return `<a href="#/${p.id}" class="${state.page === p.id ? 'active' : ''}" ${state.page === p.id ? 'aria-current="page"' : ''}>${ICONS[p.icon]}<span>${p.label}</span>${b}</a>`;
  }
}

function renderSidebarFoot() {
  const e = state.data?.ebay;
  if (!e) return;
  if (state.data.combined) {
    // One line per account: its eBay sync and its Amazon inbox
    $('#sidebar-foot').innerHTML = state.data.byAccount.map((a) => {
      const ok = a.ebay?.configured && a.ebay?.last?.ok;
      const mail = a.email?.configured && (a.email?.last?.ok || a.email?.last?.connected);
      return `<div class="status-row"><span class="dot ${ok && mail ? 'ok' : 'warn'}"></span><div><div class="st-t">${esc(a.name)}</div><div class="st-s">eBay ${ok ? `synced ${ago(a.ebay.lastSuccess)}` : a.ebay?.configured ? 'check' : 'not connected'} · email ${mail ? 'ok' : a.email?.configured ? 'check' : 'not set up'}</div></div><button class="st-a" data-acct-go="${esc(a.id)}">Open</button></div>`;
    }).join('') + `<div class="status-foot"><span>ENTIRE BUSINESS</span><span class="mono" style="font-size:10.5px">${count(state.data.orders.length)} sales</span></div>`;
    $$('[data-acct-go]', $('#sidebar-foot')).forEach((b) => b.addEventListener('click', () => switchAccount(b.dataset.acctGo)));
    return;
  }
  let dot = 'warn';
  let line = 'Not connected';
  let action = 'Set up';
  if (syncInProgress(e)) { dot = 'spin'; line = 'Syncing now…'; action = ''; }
  else if (e.needsReconnect) { dot = 'bad'; line = 'Needs reconnect'; action = 'Fix'; }
  else if (e.configured && ebayStepIssues(e).length) { dot = 'bad'; line = `Incomplete: ${ebayStepIssues(e).map((i) => i.step).join(', ')}`; action = 'Details'; }
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
  const unread = emailFailures(m).length;
  const ok = m.last?.ok || m.last?.connected === true; // the mailbox was read
  if (ok && unread) return { dot: 'ok', line: `Checked ${ago(m.last.at)} · ${unread} to look at`, action: 'Details' };
  if (ok) return { dot: 'ok', line: `Checked ${ago(m.last.at)}`, action: '' };
  if (m.last) return { dot: 'bad', line: 'Last check failed', action: 'Details' };
  return { dot: 'warn', line: 'Not checked yet', action: '' };
}

const RANGES = [['today', 'Today'], ['period', 'This pay period'], ['lastperiod', 'Last pay period'], ['month', 'Pick a period'], ['all', 'All time'], ['custom', 'Dates']];
function renderRangeSeg() {
  $('#range-seg').innerHTML = RANGES.map(([k, l]) => `<button data-r="${k}" class="${state.range === k ? 'on' : ''}">${l}</button>`).join('');
  $('#custom-range').classList.toggle('hidden', state.range !== 'custom');
  // Month picker: one entry per payment (from September 2026 a payment covers the 27th through the 26th, so its
  // numbers match the Settlement page): every payment with sales, plus the last 12
  const months = new Set();
  let m = currentPeriod();
  for (let i = 0; i < 12; i++) { months.add(m); const [y, mo] = m.split('-').map(Number); m = mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`; }
  for (const o of state.data?.orders || []) months.add(rowMonth(o));
  const dd = dueDayOf();
  const optLabel = (k) => { if (k < CYCLE_START) return monthLabel(k, 'long'); const p = settlePeriodRange(k, dd); return `${monthLabel(k, 'long')} payment · ${fmtDate(p.from)} – ${fmtDate(p.to)}`; };
  $('#month-pick').innerHTML = [...months].filter(Boolean).sort().reverse().map((k) => `<option value="${k}" ${k === state.month ? 'selected' : ''}>${esc(optLabel(k))}</option>`).join('');
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
  // Orders opened from the menu (no ?f=) always starts on All, so a filter picked earlier can't hide a sale
  if (state.page === 'orders' && !new URLSearchParams(location.hash.split('?')[1] || '').get('f')) state.ordersFilter = 'all';
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
  if (state.data.combined && ONE_ACCOUNT.has(p.id)) return pickAccount(el, p);
  const fn = { overview: renderOverview, review: renderReview, promotions: (x) => renderPromotionsPanel(x), ask: renderAsk, watch: renderWatch, reports: renderReports, trends, products, orders, returns, settlement: renderSettlement, costs: renderOpex, editor: renderEditor, import: importPage, settings }[p.id];
  fn(el);
  // A failing sync is shown on every page, not only the Overview, so nobody pays or reads numbers from stale data
  if (p.id !== 'overview') { const loud = setupBanner({ failuresOnly: true }); if (loud) el.insertAdjacentHTML('afterbegin', loud); }
}

// ---------------------------------------------------------------- accounts
// The switcher at the top left: ENTIRE BUSINESS (every account added together, read-only) and each account (eBay store)
const ONE_ACCOUNT = new Set(['settlement', 'reports', 'costs', 'editor', 'import', 'ask', 'promotions', 'products', 'watch', 'settings']);
function renderAccountSwitch() {
  const d = state.data;
  if (!d?.accounts) return;
  const cur = d.account?.id || accountId();
  const many = d.accounts.length > 1;
  $('#acct-name').textContent = d.account?.name || 'MDBIZ MAIN';
  $('#acct-sub').textContent = d.combined ? `${d.accounts.length} accounts combined` : many ? 'Switch account' : 'eBay × Amazon profit';
  $('#acct-menu').innerHTML = [
    many ? `<button role="menuitem" data-acct="all" class="${cur === 'all' ? 'on' : ''}"><b>ENTIRE BUSINESS</b><span>Every account added together</span></button><div class="acct-sep"></div>` : '',
    ...d.accounts.map((a) => `<button role="menuitem" data-acct="${esc(a.id)}" class="${many ? 'sub ' : ''}${cur === a.id ? 'on' : ''}"><b>${esc(a.name)}</b><span>${a.id === 'main' ? 'Main account' : 'Account'}</span></button>`),
    '<div class="acct-sep"></div><button role="menuitem" data-acct="+"><b>+ Add an account</b><span>Another eBay store with its own Amazon inbox</span></button>',
  ].join('');
}
export async function switchAccount(id) {
  setAccountId(id);
  $('#acct-menu').hidden = true;
  $('#acct-btn').setAttribute('aria-expanded', 'false');
  state.data = null;
  renderPage();
  try { await loadData(); } catch (e) { toast(e.message, 'bad'); }
  route();
}
async function addAccount() {
  const name = prompt('Name the new account (for example the eBay store name):');
  if (!name || !name.trim()) return;
  try {
    const r = await api('/api/accounts', { method: 'POST', body: { name }, headers: { 'X-Account': 'main' } });
    toast(`${r.account.name} added. Connect its eBay store and Amazon inbox here.`, 'good');
    location.hash = '#/settings';
    await switchAccount(r.account.id);
  } catch (e) { toast(e.message, 'bad'); }
}
$('#acct-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  const m = $('#acct-menu');
  m.hidden = !m.hidden;
  $('#acct-btn').setAttribute('aria-expanded', String(!m.hidden));
});
$('#acct-menu').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-acct]');
  if (!b) return;
  if (b.dataset.acct === '+') { $('#acct-menu').hidden = true; addAccount(); return; }
  switchAccount(b.dataset.acct);
});
document.addEventListener('click', (e) => { if (!e.target.closest('.acct-wrap')) $('#acct-menu').hidden = true; });

// A page that works on one account at a time, opened on ENTIRE BUSINESS: pick the account
function pickAccount(el, p) {
  const d = state.data;
  el.innerHTML = `<div class="card"><div class="empty lg">
    <div class="ic">${ICONS[p.icon] || ICONS.info}</div>
    <div class="t">${esc(p.label)} works on one account at a time</div>
    <p>ENTIRE BUSINESS adds every account together to look at. ${p.id === 'settlement' || p.id === 'reports' ? 'Each account has its own pay periods and payments.' : 'Pick the account to open.'}</p>
    <div class="actions">${d.accounts.map((a) => `<button class="btn" data-pick="${esc(a.id)}">${esc(a.name)}</button>`).join('')}</div>
  </div></div>`;
  $$('[data-pick]', el).forEach((b) => b.addEventListener('click', () => switchAccount(b.dataset.pick)));
}

// Red reminder across the top of every page: a settlement that is due within DUE_WARN_DAYS days, or overdue
const DUE_WARN_DAYS = 5;
function renderDueBar() {
  const bar = $('#due-bar');
  const d = state.data;
  if (!bar) return;
  if (!d || !showAlert(d.settings, 'due')) { bar.hidden = true; return; }
  const A = d.settings.partner_amazon;
  const B = d.settings.partner_ebay;
  const dueDay = d.settings.settlement_day ?? 26;
  const books = d.combined ? d.byAccount.map((a) => ({ name: a.name, orders: d.orders.filter((o) => o.account === a.id), ...a.books, split: a.settings.split_amazon }))
    : [{ name: '', orders: d.orders, ...d.books, split: d.settings.split_amazon }];
  const items = books.flatMap((bk) => allMonths(bk.orders, bk.expenses)
    .map((m) => settleMonth({ month: m, orders: bk.orders, expenses: bk.expenses, settlements: bk.settlements, splitAmazon: Number(bk.split) }))
    .map((s) => ({ s, acct: bk.name, v: settleView(s, A, B), due: dueStatus(settlementDueDate(s.month, dueDay)) })))
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
  bar.innerHTML = `<a class="due-bar ${n < 0 ? 'overdue' : ''}" href="#/settlement" role="alert">${ICONS.alert}<span class="txt"><b>${esc(x.v.from)} sends ${esc(x.v.to)} ${money(x.v.outstanding, 2)}</b> for ${monthLabel(x.s.month, 'long')}${x.acct ? ` (${esc(x.acct)})` : ''} · ${when}${more}</span><span class="go">Open settlement ${ICONS.chevron}</span></a>`;
}

// "Sep 1 – Sep 22", or with years when the range crosses a year boundary / isn't this year: "Sep 23, 2025 – Sep 22, 2026"
// A payment (Month) says so: "October 2026 payment · Sep 27 – Oct 26"; the calendar month to date says so too
function rangeText(r) {
  const y = (d) => azDay(d).slice(0, 4);
  const withYear = y(r.start) !== y(r.end) || y(r.end) !== y(Date.now());
  const f = withYear ? { month: 'short', day: 'numeric', year: 'numeric' } : undefined;
  if (r.month && r.period) return `${monthLabel(r.month, 'long')} payment · ${fmtDate(r.period.from, f)} – ${fmtDate(r.period.to, f)}`;
  return `${r.calendar ? 'Calendar month to date · ' : ''}${fmtDate(r.start, f)} – ${fmtDate(r.end, f)}`;
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
  needs_review: ['needs review', 'An Amazon email that may hold this sale couldn’t be read, so it is held back instead of being dropped. Check it and link or type the cost in the Editor.'],
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
  profitable: 'trendUp', loss: 'trendDown', returned: 'return', return_open: 'clock', awaiting_cost: 'clock', awaiting_email: 'mail', cancelled: 'x',
  cancelled_after_purchase: 'circleX', excluded: 'eyeOff', not_dropship: 'eyeOff', in_sheet: 'sheet', before_start: 'history', check_sheet: 'alert', needs_review: 'alert',
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
  const s = fmtDate(k.slice(0, 10), { month: 'short', day: 'numeric' });
  return gran === 'week' ? `Wk ${s}` : s;
};

function emptyState(el) {
  const has = state.data.orders.length > 0;
  el.innerHTML = `<div class="card"><div class="empty lg">
    <div class="ic">${has ? ICONS.calendar : ICONS.orders}</div>
    <div class="t">${has ? 'No eBay sales in this date range' : 'No sales yet'}</div>
    <p>${has ? 'Nothing was sold between these dates. Widen the range or pick another month.' : 'Connect eBay and the Amazon email import, or upload a monthly settlement sheet, and the numbers appear here.'}</p>
    <div class="actions">${has
      ? '<button class="btn" data-range="period">This pay period</button><button class="btn" data-range="all">All time</button>'
      : `<a class="btn primary" href="#/settings">${ICONS.settings} Open Settings</a><a class="btn" href="#/import">${ICONS.sheet} Upload a monthly sheet</a>`}</div>
  </div></div>`;
  $$('[data-range]', el).forEach((b) => b.addEventListener('click', () => { state.range = b.dataset.range; store('dd_range', state.range); renderRangeSeg(); renderPage(); }));
}

// One compact notice per issue. Soft setup hints get an × (remembered for the session); failures never do.
// Which Settings -> Customize dashboard switch an alert belongs to
const alertKind = (key) => (/^(ebay-setup|email-setup|demo|ebay-expiring)$/.test(key) ? 'setup' : key.startsWith('email-unread') ? 'emails' : key === 'refund-unmatched' ? 'refunds'
  : key.startsWith('ebay-orderless') ? 'charges' : key.startsWith('ebay-holds') ? 'holds' : 'sync');
function notice({ key, kind = '', icon = ICONS.alert, text, action, href, soft = false }) {
  if (soft && dismissed.has(key)) return '';
  if (['emails', 'refunds', 'charges', 'holds'].includes(alertKind(key))) return ''; // listed on the Review page instead
  if (state.data && !showAlert(state.data.settings, alertKind(key))) return '';
  return `<div class="banner ${kind}" data-k="${key}">${icon}<div>${text}</div>${action ? `<a class="btn sm" href="${href}">${action}</a>` : ''}${soft ? `<button class="banner-x" data-k="${key}" aria-label="Dismiss">${ICONS.x}</button>` : ''}</div>`;
}

// `failuresOnly`: just the loud failures (a sync step or the email import not working), shown on every other page
export function setupBanner({ failuresOnly = false } = {}) {
  const d = state.data;
  if (d.combined) return '';
  const out = [];
  if (!d.ebay.configured)
    out.push(notice({ key: 'ebay-setup', soft: true, text: `<b>eBay isn't connected.</b> Finish setup in Settings, then click <b>Connect eBay account</b>. <span class="muted">Missing: ${d.ebay.missing.join(', ')}</span>`, action: 'Set up', href: '#/settings' }));
  // Loud warnings when an automatic pull stops working, so a silent failure can't hide missing sales or costs
  const stale = (iso, hours) => !iso || Date.now() - new Date(iso).getTime() > hours * 3600_000;
  if (d.ebay.needsReconnect)
    out.push(notice({ key: 'ebay-reconnect', kind: 'bad', text: '<b>eBay needs to be reconnected.</b> eBay stopped accepting the saved connection, so no new sales are coming in.', action: 'Reconnect eBay', href: apiLink('/api/ebay/connect') }));
  else if (d.ebay.refreshExpiresAt && new Date(d.ebay.refreshExpiresAt) - Date.now() < 30 * 86400_000)
    out.push(notice({ key: 'ebay-expiring', text: `<b>eBay connection expires ${fmtDate(d.ebay.refreshExpiresAt, { month: 'short', day: 'numeric', year: 'numeric' })}.</b> Reconnect now so syncing never stops.`, action: 'Reconnect eBay', href: apiLink('/api/ebay/connect') }));
  else if (d.ebay.configured && syncFailed(d.ebay))
    out.push(notice({ key: 'ebay-failing', kind: 'bad', text: `<b>eBay sync is failing.</b> New sales are not coming in. <span class="muted">${esc((d.ebay.last.message || '').slice(0, 180))}</span>`, action: 'Details', href: '#/settings' }));
  else if (d.ebay.configured && !syncInProgress(d.ebay) && d.ebay.lastSuccess && stale(d.ebay.lastSuccess, 3))
    out.push(notice({ key: 'ebay-stale', text: `<b>eBay hasn't synced since ${fmtDateTime(d.ebay.lastSuccess)}.</b> It normally runs every 30 minutes. Check that the server is running.`, action: 'Details', href: '#/settings' }));
  // A sync can finish while one of its steps failed (Finances: fees, ad fees, refunds; Returns): loud, never dismissible
  const steps = ebayStepIssues(d.ebay);
  if (steps.length) {
    const missing = steps.flatMap((i) => (i.step === 'finances' ? ['ad fees', 'fee credits', 'refunds'] : i.step === 'returns' ? ['open returns'] : ['new sales']));
    const what = missing.length > 1 ? `${missing.slice(0, -1).join(', ')} and ${missing.at(-1)}` : missing[0];
    out.push(notice({ key: 'ebay-steps', kind: 'bad', text: `<b>eBay sync is incomplete: ${esc(steps.map((i) => i.step).join(' and '))} ${steps.every((i) => i.problem === 'stale') ? 'behind' : 'not working'}.</b> ${esc(what[0].toUpperCase() + what.slice(1))} may be missing, so the numbers (and what is owed) can be wrong until it syncs. <span class="muted">${esc(ebayIssueText(steps))}</span>`, action: 'Details', href: '#/settings' }));
  }
  // Emails the reader didn't understand: the import itself works, so this is a heads-up, not a failure. The Overview
  // lists them (with Dismiss) in Needs attention, so the banner is for the other pages.
  const unread = emailFailures(d.email);
  if (unread.length && !(state.page === 'overview'))
    out.push(notice({ key: `email-unread-${unread.length}`, kind: 'warn', icon: ICONS.mail, soft: true, text: `<b>${unread.length === 1 ? 'An Amazon email couldn’t be read' : `${unread.length} Amazon emails couldn’t be read`}.</b> Email is still working; these are usually multi-item or gift-card orders. If one is for an eBay sale, enter its cost; if not, dismiss it on the Overview.`, action: 'Overview', href: '#/overview' }));
  // A check that read the mailbox is not failing, even if some emails in it couldn't be understood
  if (d.email.configured && !d.email.running && d.email.last && !d.email.last.ok && d.email.last.connected !== true)
    out.push(notice({ key: 'email-failing', kind: 'bad', text: `<b>Amazon email check is failing.</b> New Amazon costs are not coming in. <span class="muted">${esc((d.email.last.log || []).join(' ').slice(0, 180))}</span>`, action: 'Details', href: '#/settings?focus=email' }));
  else if (d.email.configured && !d.email.running && d.email.last && stale(d.email.last.at, 3))
    out.push(notice({ key: 'email-stale', text: `<b>Amazon email hasn't been checked since ${fmtDateTime(d.email.last.at)}.</b> It normally runs every 30 minutes.`, action: 'Details', href: '#/settings?focus=email' }));
  if (!d.email.configured)
    out.push(notice({ key: 'email-setup', kind: 'info', icon: ICONS.mail, soft: true, text: '<b>Amazon email import is off.</b> Add a Gmail App Password so every Amazon purchase and its cost arrives automatically.', action: 'Set up', href: '#/settings?focus=email' }));
  // Amazon refunds that couldn't be tied to one sale are not in the settlement until someone places them
  const unplaced = d.amazon?.unmatchedRefunds || [];
  if (unplaced.length)
    out.push(notice({ key: 'refund-unmatched', kind: 'bad', text: `<b>${unplaced.length === 1 ? 'An Amazon refund isn’t' : `${unplaced.length} Amazon refunds aren’t`} in the settlement yet.</b> It couldn’t be matched to exactly one sale. ${unplaced.slice(0, 3).map((r) => `<span class="muted">${money(r.amount, 2)} on ${fmtDate(r.received_at)}${r.title ? ` for “${esc(r.title.slice(0, 50))}”` : ''} (Amazon order ${esc(r.amazon_order_id)})</span>`).join(' ')} Set that sale’s Amazon refund in the Editor.`, action: 'Open Editor', href: '#/editor' }));
  // eBay money with no order (a store subscription, a charge eBay didn't tie to a sale) is not in any sale's numbers.
  // The key carries the list, so a new charge shows again after an older one was dismissed.
  const orderless = d.flags?.unassignedCharges || [];
  if (orderless.length) {
    const total = orderless.reduce((t, c) => t + (Number(c.amount) || 0), 0);
    out.push(notice({ key: `ebay-orderless-${orderless.map((c) => c.id).join('|').slice(-120)}`, text: `<b>${orderless.length === 1 ? 'An eBay charge has' : `${orderless.length} eBay charges have`} no order (${money(total, 2)} in all).</b> They are not in the numbers. If one is a business cost, add it under Operating costs. ${orderless.slice(0, 3).map((c) => `<span class="muted">${esc(String(c.fee_type || c.type || '').replace(/_/g, ' ').toLowerCase())} ${money(c.amount, 2)} on ${fmtDate(c.at)}</span>`).join(' ')}${orderless.length > 3 ? ` <span class="muted">and ${orderless.length - 3} more</span>` : ''}`, action: 'Operating costs', href: '#/costs', soft: true }));
  }
  // A return hold eBay never released or refunded after 30 days: a case that may have been decided without a refund
  // record, so the sale's money may be wrong
  const holds = d.flags?.openHolds || [];
  if (holds.length)
    out.push(notice({ key: `ebay-holds-${holds.map((h) => h.id).join('|').slice(-120)}`, kind: 'bad', text: `<b>${holds.length === 1 ? 'A return hold has' : `${holds.length} return holds have`} been open over 30 days.</b> eBay held the money and never released or refunded it. Check the case on eBay. ${holds.slice(0, 3).map((h) => `<span class="muted">order ${esc(h.order_id || '?')}: ${money(h.amount, 2)} since ${fmtDate(h.since)}</span>`).join(' ')}`, action: 'Returns', href: '#/returns' }));
  if (d.orders.some((o) => o.order_id.startsWith('DEMO-')))
    out.push(notice({ key: 'demo', kind: 'info', icon: ICONS.info, soft: true, text: "<b>You're looking at demo data.</b> It shows how the dashboard works before your real eBay and Amazon data arrives. Remove it any time.", action: 'Remove demo data', href: '#/settings' }));
  const loud = /data-k="(ebay-steps|ebay-failing|email-failing|ebay-reconnect)"/;
  const html = out.filter((h) => h && (!failuresOnly || loud.test(h))).join('');
  return html ? `<div class="banners">${html}</div>` : '';
}

// ---------------------------------------------------------------- ANALYTICS
function trends(el) {
  const r = range();
  const all = scoped();
  if (!all.length) return emptyState(el);
  const c = colors();
  const s = summarize(all);
  // Order counts are sales only (refund lines keep their money in the totals); times are Arizona time
  const live = all.filter((o) => !o.excluded && !o.cancelled && isSale(o));
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
    ${card('When orders come in', 'Orders by weekday and hour (Arizona time)', '<div class="chart" id="ch-heat" style="height:290px"></div>', { cls: 'c-8' })}
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
    ${card('Orders by hour', 'All days combined · Arizona time', '<div class="chart" id="ch-hour" style="height:380px"></div>', { cls: 'c-6' })}
  </div>
  <div class="mt">${card('Period breakdown', `${granLabel[gran]} totals with change vs the prior period`, '<div class="table-wrap" id="period-table"></div>', { right: '<button class="btn sm" id="dl-periods">Export CSV</button>' })}</div>`;
  bindGran(el);

  // heatmap
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const heat = [];
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const o of live) grid[(azWeekday(o.created_at) + 6) % 7][azHour(o.created_at)]++;
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
  for (const o of counted) { const i = (azWeekday(o.created_at) + 6) % 7; wd[i] += o.net; if (isSale(o)) wdN[i]++; }
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
  for (const o of live) hours[azHour(o.created_at)]++;
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
  const tabs = `<div class="seg prod-tabs" id="prod-tabs" role="tablist" aria-label="Products view"><button role="tab" data-t="listings" class="${tab === 'listings' ? 'on' : ''}" aria-selected="${tab === 'listings'}">${ICONS.package} Listings</button><button role="tab" data-t="promo" class="${tab === 'promo' ? 'on' : ''}" aria-selected="${tab === 'promo'}">${ICONS.target} Promotional</button><button role="tab" data-t="sales" class="${tab === 'sales' ? 'on' : ''}" aria-selected="${tab === 'sales'}">${ICONS.trends} Sales</button></div>`;
  const bindTabs = () => $('#prod-tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && b.dataset.t !== tab) { store('dd_prod_tab', b.dataset.t); renderPage(); } });
  if (tab === 'listings') { el.innerHTML = `${tabs}<div id="listings-panel"></div>`; bindTabs(); renderListingsPanel($('#listings-panel')); return; }
  if (tab === 'promo') { el.innerHTML = `${tabs}<div id="promo-panel"></div>`; bindTabs(); renderPromotionsPanel($('#promo-panel')); return; }
  const all = scoped();
  if (!all.length) { el.innerHTML = `${tabs}<div id="prod-empty"></div>`; bindTabs(); return emptyState($('#prod-empty')); }
  const c = colors();
  // A refund line counts under the product it refunds, never as a product of its own
  const prods = byProduct(all, state.data.orders);
  const costed = prods.filter((p) => p.countedRows > 0);
  const best = [...prods].sort((a, b) => b.orders - a.orders)[0];
  const most = [...costed].sort((a, b) => b.net - a.net)[0];
  const worst = [...costed].sort((a, b) => a.net - b.net)[0];
  const bestMargin = [...costed].filter((p) => p.countedOrders >= 3).sort((a, b) => b.margin - a.margin)[0];

  el.innerHTML = `${tabs}
  <div class="kpis five">
    ${kpi({ label: 'Products sold', value: count(prods.filter((p) => p.orders > 0).length), foot: `${count(prods.filter((p) => p.orders >= 2).length)} sold 2+ times` })}
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
    ['all', 'All'], ['profitable', 'Profitable'], ['loss', 'Loss'], ['returned', 'Returned'], ['return_open', 'Return open'], ['awaiting_cost', 'Awaiting email'], ['cancelled', 'Cancelled'], ['excluded', 'Excluded'],
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
      ...(state.data.combined ? [{ title: 'Account', field: 'account_name', width: 120, minWidth: 100, formatter: (c) => esc(c.getValue() || '') }] : []),
      { title: 'Date', field: 'created_at', width: 108, minWidth: 100, formatter: (c) => `${fmtDate(c.getValue())}<div class="muted" style="font-size:11px">${c.getRow().getData().approx_date ? 'date approx.' : `${fmtTime(c.getValue())} AZ`}</div>` },
      { title: 'Item', field: 'title', minWidth: 186, widthGrow: 3, formatter: (c) => { const d = c.getRow().getData(); return `<div style="white-space:normal;line-height:1.3">${esc(trunc(d.title, 90))}</div><div class="${d.source === 'ledger' ? '' : 'mono '}muted" style="font-size:11px">${esc(orderLabel(d))}${d.units > 1 ? ` · ×${d.units}` : ''}</div>`; } },
      { title: 'Buyer', field: 'buyer', width: 120, minWidth: 110, formatter: (c) => { const d = c.getRow().getData(); return `${esc(d.buyer || '')}<div class="muted" style="font-size:11px">${esc([d.ship_city, d.ship_state].filter(Boolean).join(', '))}</div>`; } },
      { title: 'Revenue', field: 'revenue', hozAlign: 'right', sorter: 'number', width: 96, minWidth: 92, formatter: (c) => money(c.getValue()) },
      { title: 'Amazon', field: 'cost', hozAlign: 'right', sorter: 'number', width: 96, minWidth: 92, formatter: (c) => (c.getRow().getData().has_cost ? money(c.getValue()) : '<span class="muted">—</span>') },
      { title: 'Fees', field: 'fees', hozAlign: 'right', width: 82, minWidth: 78, sorter: (a, b, ra, rb) => (a + ra.getData().ad_fees) - (b + rb.getData().ad_fees), formatter: (c) => money(c.getValue() + c.getRow().getData().ad_fees) },
      { title: 'Refund', field: 'refunds', hozAlign: 'right', sorter: 'number', width: 90, minWidth: 86, formatter: (c) => (c.getValue() ? `<span title="${refundWord(c.getRow().getData())}">${money(c.getValue(), 2)}</span>` : '<span class="muted">—</span>') },
      { title: 'Net', field: 'net', hozAlign: 'right', sorter: 'number', width: 96, minWidth: 90, formatter: (c) => { const d = c.getRow().getData(); return d.has_cost && !d.excluded ? `<b class="${d.net < 0 ? 'neg' : 'pos'}">${money(d.net)}</b>` : noNetLabel(d); } },
      { title: 'Margin', field: 'margin', hozAlign: 'right', sorter: 'number', width: 86, minWidth: 82, formatter: (c) => { const d = c.getRow().getData(); return d.has_cost && !d.excluded ? pct(c.getValue()) : ''; } },
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

// ORDER_EXPORT (the order CSV columns) lives in report-math.js and is re-exported above

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
          o.approx_date ? `${monthLabel(o.business_month, 'long')} (from monthly sheet, exact date unknown)` : `${fmtDateTime(o.created_at)} Arizona time`,
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
      ${o.return_open ? returnOpenPanel(o) : ''}
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
// An open return: eBay is holding the money but hasn't refunded yet, so the sale still counts where it was settled
function returnOpenPanel(o) {
  const r = o.return_open;
  const why = r.reason ? ` (${esc(r.reason.toLowerCase().replace(/_/g, ' '))})` : '';
  return `<div class="await-box warn">
      <div class="await-h">${ICONS.clock}<div><b>Return open since ${fmtDate(r.since)} · ${money(r.amount, 2)} on hold</b><div class="muted">The buyer started a return${why} and eBay is holding the money, but no refund has been issued, so nothing is lost yet and this sale still counts where it was settled. If it's refunded, about <b>${money(r.profit_hit, 2)}</b> comes off the profit on the payment for the day of the refund (eBay gives its fees back except $0.40). If the item goes back to Amazon, that refund is added too.</div></div></div>
    </div>`;
}

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
  // Only what's in the books: a sheet-covered sale appears once (its sheet row), and later refunds are their own lines
  const ret = all.filter((o) => o.counted && (o.returns.length || o.refunds > 0 || o.return_open || o.source === 'refund'));
  const retSales = new Set(ret.map(saleIdOf)); // a sale and its later refund line are one returned sale
  const lossOnReturns = ret.filter((o) => o.counted).reduce((a, o) => a + Math.min(0, o.net), 0);
  const open = ret.filter((o) => o.return_open || o.returns.some((x) => !/CLOSED/i.test(x.state || '')));
  const recovered = ret.reduce((a, o) => a + o.amazon_refund, 0);
  const needRecovery = ret.filter((o) => o.has_cost && !o.amazon_refund && o.cost > 0);
  const rs = refundSplit(all.filter((o) => o.counted));
  el.innerHTML = `
  <div class="kpis six">
    ${kpi({ label: 'Returned orders', sw: '--s-refunds', value: count(retSales.size), foot: `${count(open.length)} still open` })}
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

  const prodRet = byProduct(all, state.data.orders).filter((p) => p.returnCount > 0).sort((a, b) => b.returnCount - a.returnCount || b.returnRate - a.returnRate).slice(0, 12);
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
const monthName = (m) => monthLabel(m, 'long');

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
        <div class="t">Drop a monthly sheet to check it against the site</div>
        <div class="s">The partner CSV with <b>Item Name · Amazon Cost · eBay Sale Price</b>. From October 2026 a sheet is only <b>checked</b>: every line is compared with the site and each difference explained. Nothing is changed, and a paid month is never rewritten.</div>
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
  // A sheet checked against the site: totals side by side, then every line that differs and why
  function sheetCheckCard(r) {
    const diff = r.difference;
    const same = diff !== null && Math.abs(diff) < 0.01;
    const head = `<div class="result-grid">
        <div class="result-cell"><div class="v">${r.sheet.sends === null ? '—' : money(r.sheet.sends, 2)}</div><div class="k">the sheet says Drew sends Myles</div></div>
        <div class="result-cell"><div class="v pos">${money(r.site.sellerSends, 2)}</div><div class="k">the site (${count(r.site.orders)} lines on this payment)</div></div>
        <div class="result-cell"><div class="v ${same ? 'pos' : 'neg'}">${diff === null ? '—' : same ? 'Match' : `${diff > 0 ? '+' : '−'}${money(Math.abs(diff), 2)}`}</div><div class="k">${diff === null ? 'no total on the sheet' : same ? 'sheet and site agree' : diff > 0 ? 'the sheet overpays Myles' : 'the sheet underpays Myles'}</div></div>
        <div class="result-cell"><div class="v">${count(r.counts.matches)}</div><div class="k">lines match to the cent</div></div>
      </div>`;
    const row = (l) => {
      const t = esc(l.sheet ? l.sheet.title : l.site.title);
      const label = l.status === 'differs' ? '<span class="pill warn">differs</span>' : l.status === 'only_on_sheet' ? '<span class="pill bad">only on the sheet</span>' : '<span class="pill bad">missing from the sheet</span>';
      const nums = `<span class="muted num">${l.sheet ? `sheet ${money(l.sheet.net, 2)}` : ''}${l.sheet && l.site ? ' · ' : ''}${l.site ? `site ${money(l.site.net, 2)}` : ''}</span>`;
      return `<li>${label} <b>${t}</b> ${nums}<ul>${l.why.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></li>`;
    };
    const issues = r.lines.filter((l) => l.status !== 'matches');
    const notes = r.lines.filter((l) => l.note);
    const body = `${head}
      ${r.structural.length ? `<div class="banner bad" style="margin-top:12px">${ICONS.alert}<div><b>The sheet's own math:</b><ul class="check-list">${r.structural.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div></div>` : ''}
      ${issues.length ? `<h4 style="margin:14px 0 6px">${issues.length} line${issues.length > 1 ? 's' : ''} to fix</h4><ul class="check-list">${issues.map(row).join('')}</ul>` : '<div class="pos" style="margin-top:12px">✓ Every line matches the site.</div>'}
      ${notes.length ? `<div class="muted" style="font-size:12px;margin-top:8px">${notes.map((l) => `${esc(l.sheet.title)}: ${esc(l.note)}`).join(' · ')}</div>` : ''}
      ${r.waiting.length ? `<div class="muted" style="font-size:12px;margin-top:8px">Not on either yet (waiting for the Amazon cost): ${r.waiting.map((w) => esc(w.title.slice(0, 40))).join(', ')}</div>` : ''}
      <div class="muted" style="font-size:11.5px;margin-top:10px">Checked only. Nothing was changed.</div>`;
    return card(`${same && !issues.length ? okIcon : warnIcon} ${esc(r.filename)}`, `Sheet check · ${monthName(r.month)} payment`, body);
  }

  async function upload(files) {
    if (!files.length) return;
    const fd = new FormData();
    files.forEach((f) => fd.append('files', f));
    $('#import-result').innerHTML = `<div class="card"><div class="card-b"><div class="row" style="margin-bottom:6px"><span class="dot spin"></span>Reading ${files.length} sheet${files.length > 1 ? 's' : ''} and matching rows to eBay sales…</div>${skeletonRows(4).replace('class="sk-rows"', 'class="sk-rows" style="padding:8px 0 0"')}</div></div>`;
    try {
      const results = await api('/api/amazon/import', { method: 'POST', body: fd });
      $('#import-result').innerHTML = results.map((r) => r.kind === 'sheet_check' ? sheetCheckCard(r) : r.kind === 'ledger' ? card(`${okIcon} ${esc(r.filename)}`, `Monthly settlement sheet · ${monthName(r.month)}`, `
        <div class="result-grid">
          <div class="result-cell"><div class="v">${count(r.linesNew)}</div><div class="k">new sales rows</div></div>
          <div class="result-cell"><div class="v">${count(r.linesUnchanged + r.linesUpdated)}</div><div class="k">already on file (${count(r.linesUpdated)} updated), not duplicated</div></div>
          <div class="result-cell"><div class="v">${money(r.expenseTotal, 2)}</div><div class="k">${count(r.expenses)} operating expenses</div></div>
          <div class="result-cell"><div class="v">${count(r.matchedToEbay)}</div><div class="k">rows matched to synced eBay orders</div></div>
          ${r.settlementPaid !== null && r.settlementPaid !== undefined ? `<div class="result-cell"><div class="v pos">${money(r.settlementPaid, 2)}</div><div class="k">recorded as paid for this month</div></div>` : ''}
        </div>
        <div style="margin-top:10px;font-size:12.5px" class="${r.checks.every((c) => c.ok) ? 'pos' : 'neg'}">${r.checks.length ? (r.checks.every((c) => c.ok) ? '✓ Totals match the sheet’s Total Transactions row' : `Totals differ from the sheet: ${r.checks.filter((c) => !c.ok).map((c) => `${c.field} sheet ${c.sheet} vs ${c.computed}`).join(', ')}`) : ''}</div>`)
        : card(`${warnIcon} ${esc(r.filename)}`, 'Not a monthly settlement sheet', `<div class="ink2" style="font-size:13px">This file has no <b>Item Name / Amazon Cost / eBay Sale Price</b> columns, so it was not treated as a sheet. Amazon purchases come in through the <a href="#/settings?focus=email">email import</a>; upload only the partner settlement sheets here.</div>`)).join('');
      toast(results.every((r) => r.kind === 'sheet_check') ? 'Sheet checked. Nothing was changed' : 'Sheet import complete', 'good');
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
  const backTo = new URLSearchParams(location.hash.split('?')[1] || '').get('account');
  if (backTo && backTo !== accountId()) { history.replaceState(null, '', location.hash.replace(/([?&])account=[^&]*/, '$1')); return switchAccount(backTo); }
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
      <div class="section-h" style="margin-top:0"><h2>Accounts</h2><span class="sub">each eBay store with its own Amazon inbox</span></div>
      ${accountsCard()}
      <div class="section-h" id="dashboard-sec"><h2>Customize dashboard</h2><span class="sub">what everyone sees · saved for both partners</span></div>
      ${dashboardCard(d.settings)}
      <div class="section-h"><h2>Data sources</h2><span class="sub">where sales and costs come from</span></div>
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
  bindDashboardCard();
  bindAccountsCard();
  if (focus === 'dashboard') requestAnimationFrame(() => $('#dashboard-sec')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
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

// Accounts: rename this one, add another, switch
function accountsCard() {
  const d = state.data;
  const me = d.account || { id: 'main', name: 'MDBIZ MAIN' };
  return card('Accounts', `You are in <b>${esc(me.name)}</b>. Everything on this page (eBay, Amazon email, partners) is for this account.`, `
    <div class="acct-list">${d.accounts.map((a) => `<div class="acct-row ${a.id === me.id ? 'on' : ''}"><div><b>${esc(a.name)}</b><div class="muted" style="font-size:12px">${a.id === 'main' ? 'Main account · reads EMAIL_USER / EMAIL_PASSWORD' : `reads EMAIL_USER_${esc(a.id.toUpperCase())} / EMAIL_PASSWORD_${esc(a.id.toUpperCase())}`}</div></div>${a.id === me.id ? '<span class="pill good">Open</span>' : `<button class="btn sm" data-acct-open="${esc(a.id)}">Open</button>`}</div>`).join('')}</div>
    <div class="row mt" style="gap:8px;flex-wrap:wrap"><input class="input" id="acct-rename" style="flex:1;min-width:180px" value="${esc(me.name)}" aria-label="Account name" /><button class="btn" id="acct-rename-btn">Rename</button><button class="btn primary" id="acct-add-btn">+ Add an account</button></div>`, { cls: 'set-card' });
}
function bindAccountsCard() {
  $$('[data-acct-open]').forEach((b) => b.addEventListener('click', () => switchAccount(b.dataset.acctOpen)));
  $('#acct-add-btn')?.addEventListener('click', addAccount);
  $('#acct-rename-btn')?.addEventListener('click', async () => {
    const id = state.data.account?.id || 'main';
    try { await api(`/api/accounts/${encodeURIComponent(id)}/rename`, { method: 'POST', body: { name: $('#acct-rename').value } }); toast('Renamed', 'good'); await loadData(); renderPage(); } catch (e) { toast(e.message, 'bad'); }
  });
}

// On/off switches for menu pages, Overview cards and alerts (dash-prefs.js)
function dashboardCard(settings) {
  const p = dashPrefs(settings);
  const group = (g, title, list) => `<div class="dash-group"><div class="field-h">${title}</div>${list.map((o) => `<label class="dash-opt ${o.locked ? 'locked' : ''}"><input type="checkbox" data-g="${g}" data-k="${o.id}" ${p[g][o.id] ? 'checked' : ''} ${o.locked ? 'disabled' : ''} /><span><b>${esc(o.label)}</b><span class="muted">${esc(o.note)}</span></span></label>`).join('')}</div>`;
  return card('What the dashboard shows', 'Each switch saves as soon as you click it. Hidden pages still open from links.', `<div class="dash-groups">
    ${group('pages', 'Pages in the menu', PAGE_OPTIONS)}
    ${group('cards', 'Overview cards', CARD_OPTIONS)}
    ${group('alerts', 'Alerts', ALERT_OPTIONS)}
    </div>
    <div class="row mt"><button class="btn" id="dash-reset">Back to the defaults</button><span class="muted" id="dash-saved" style="font-size:12px"></span></div>`, { cls: 'set-card', id: 'dash-card' });
}
function bindDashboardCard() {
  // Saved on every click; the menu updates straight away and the page stays where it is
  const save = async (prefs, rerender = false) => {
    const note = $('#dash-saved');
    if (note) note.textContent = 'Saving…';
    try {
      const r = await api('/api/settings/dashboard', { method: 'POST', body: prefs });
      if (state.data) state.data.settings = r.settings;
      renderNav();
      if (rerender) renderPage();
      else if (note) note.textContent = 'Saved';
    } catch (e) { toast(e.message, 'bad'); if (note) note.textContent = ''; }
  };
  const current = () => {
    const prefs = { pages: {}, cards: {}, alerts: {} };
    for (const box of $$('#dash-card input[type=checkbox]')) prefs[box.dataset.g][box.dataset.k] = box.checked;
    return prefs;
  };
  $$('#dash-card input[type=checkbox]').forEach((box) => box.addEventListener('change', () => save(current())));
  $('#dash-reset')?.addEventListener('click', () => { if (confirm('Put every page, card and alert back to the default?')) save(defaultPrefs(), true); });
}

function ebayCard(e, log) {
  const h4 = (t) => `<h4 style="margin:18px 0 6px;font-size:11.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--ink-3)">${t}</h4>`;
  const has = (k) => !e.missing.includes(k);
  const pill = (ok, yes = 'set', no = 'missing') => (ok ? `<span class="pill good">${yes}</span>` : `<span class="pill bad">${no}</span>`);
  const expSoon = e.refreshExpiresAt && new Date(e.refreshExpiresAt) - Date.now() < 30 * 86400_000;
  const connectBtn = e.canConnect
    ? `<a class="btn primary" href="${apiLink('/api/ebay/connect')}">${e.configured ? 'Reconnect eBay' : 'Connect eBay account'}</a>`
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

// The main account reads EMAIL_USER / EMAIL_PASSWORD; another account EMAIL_USER_<ID> / EMAIL_PASSWORD_<ID>
const envSuffix = () => (state.data?.account?.id && state.data.account.id !== 'main' ? `_${state.data.account.id.toUpperCase()}` : '');
function emailCard(em, mails) {
  const h4 = (t) => `<h4 style="margin:18px 0 6px;font-size:11.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--ink-3)">${t}</h4>`;
  const intro = '<p class="ink2" style="margin-top:0;font-size:13px">This is where Amazon costs come from. It reads only mail <b>from amazon.com</b>: order confirmations (cost, ship-to, items), cancellations (cost drops to $0) and refunds (logged as money recovered from Amazon). Purchases are keyed by Amazon order number, so nothing is ever double-counted, and each one links to its eBay sale by zip, name or tracking number.</p>';
  const opts = { id: 'email-card', cls: 'set-card' };
  if (!em.configured) {
    return card('Amazon purchases from email', 'Primary source of Amazon costs · not connected yet', `${intro}
      <table class="simple env-table"><tbody>
        <tr><td class="mono">EMAIL_USER${envSuffix()}</td><td>${em.user ? esc(em.user) : 'your Gmail address'}</td><td>${em.user ? '<span class="pill good">set</span>' : '<span class="pill bad">missing</span>'}</td></tr>
        <tr><td class="mono">EMAIL_PASSWORD${envSuffix()}</td><td>Gmail <b>App Password</b> (16 letters), not your normal password</td><td><span class="pill bad">missing</span></td></tr>
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
