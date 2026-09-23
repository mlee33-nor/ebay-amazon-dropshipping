// Editor tab: spreadsheet mode (range select, copy/paste, undo) over eBay orders and Amazon purchases,
// plus a match-review queue. Edits are staged locally (highlighted) until Save.
import { $, $$, esc, money, pct, fmtDate, api, toast, downloadCsv, ICONS } from './util.js';
import { state, loadData, renderPage, trackTable, openOrder, ORDER_EXPORT } from './app.js';

let tab = 'ebay';
const dirty = new Map(); // key -> {field: value}

export function renderEditor(el) {
  const qs = new URLSearchParams(location.hash.split('?')[1] || '');
  if (qs.get('tab')) tab = qs.get('tab');
  if (qs.get('order')) tab = 'ebay';
  dirty.clear();
  el.innerHTML = `<div class="card">
    <div class="sheet-bar">
      <div class="seg" id="ed-tabs">
        <button data-t="ebay" class="${tab === 'ebay' ? 'on' : ''}">eBay orders</button>
        <button data-t="amazon" class="${tab === 'amazon' ? 'on' : ''}">Amazon purchases</button>
        <button data-t="expenses" class="${tab === 'expenses' ? 'on' : ''}">Operating expenses</button>
        <button data-t="matches" class="${tab === 'matches' ? 'on' : ''}">Match review ${state.data.amazon.suggestions ? `<span class="badge" style="margin-left:4px">${state.data.amazon.suggestions}</span>` : ''}</button>
      </div>
      <div id="ed-tools" class="sheet-tools"></div>
    </div>
    <div id="ed-body"></div>
  </div>
  <div class="sheet-help" id="ed-help"></div>`;
  $('#ed-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (dirty.size && !confirm('You have unsaved changes. Discard them?')) return;
    tab = b.dataset.t;
    history.replaceState(null, '', '#/editor');
    renderPage();
  });
  if (tab === 'ebay') ebaySheet(qs.get('order'));
  else if (tab === 'amazon') amazonSheet();
  else if (tab === 'expenses') expensesSheet();
  else matchReview();
}

function toolbar(extra = '') {
  $('#ed-tools').innerHTML = `
    ${extra}
    <div class="search">${ICONS.search}<input class="input" id="ed-q" placeholder="Search" /></div>
    <span class="divider-v"></span>
    <button class="btn sm ghost" id="ed-undo" title="Undo (Ctrl+Z)">${ICONS.undo} Undo</button>
    <button class="btn sm ghost" id="ed-export" title="Download what's currently shown">${ICONS.down} Export</button>
    <span class="divider-v"></span>
    <button class="btn sm" id="ed-discard" disabled title="Throw away unsaved edits">Discard</button>
    <button class="btn sm primary" id="ed-save" disabled title="Write staged edits to the database">${ICONS.save} Save <span id="ed-n" class="cnt"></span></button>`;
  $('#ed-help').innerHTML = `<b style="color:var(--ink-2)">Spreadsheet mode.</b> Click and drag to select a range · <span class="kbd">Ctrl</span>+<span class="kbd">C</span> / <span class="kbd">Ctrl</span>+<span class="kbd">V</span> copy and paste ranges (works with Excel and Google Sheets) · double-click or type to edit · <span class="kbd">Enter</span> / <span class="kbd">Tab</span> to move · <span class="kbd">Ctrl</span>+<span class="kbd">Z</span> undo · editable columns are tinted blue, unsaved edits are yellow until you press <b style="color:var(--ink-2)">Save</b>.`;
}

function markDirty(n) {
  $('#ed-n').textContent = n ? String(n) : '';
  $('#ed-save').disabled = !n;
  $('#ed-discard').disabled = !n;
  $('#ed-save').title = n ? `Write ${n} staged edit${n > 1 ? 's' : ''} to the database` : 'Nothing to save yet';
}

const numEditor = { editor: 'number', editorParams: { step: 0.01, selectContents: true } };
const moneyFmt = (c) => { const v = c.getValue(); return v === null || v === undefined || v === '' ? '<span class="muted">—</span>' : money(Number(v)); };

function recompute(d) {
  const cost = d.cost_override !== null && d.cost_override !== '' && d.cost_override !== undefined ? Number(d.cost_override) : d.amazon_cost;
  const fees = d.fee_override !== null && d.fee_override !== '' && d.fee_override !== undefined ? Number(d.fee_override) : d.base_fees;
  const refunds = d.refund_override !== null && d.refund_override !== '' && d.refund_override !== undefined ? Number(d.refund_override) : d.base_refunds;
  const hasCost = d.has_link || (d.cost_override !== null && d.cost_override !== '' && d.cost_override !== undefined);
  const rev = d.cancelled ? 0 : d.revenue;
  d.net = hasCost ? +(rev - (d.cancelled ? 0 : fees) - (d.cancelled ? 0 : d.ad_fees) - cost - (d.cancelled ? 0 : refunds) + Number(d.amazon_refund || 0) - Number(d.extra_cost || 0)).toFixed(2) : null;
  return d;
}

// ------------------------------------------------------------------ eBay sheet
function ebaySheet(focusOrder) {
  toolbar(`<select class="select" id="ed-filter" style="height:28px;font-size:12px"><option value="all">All orders</option><option value="edited">Edited only</option><option value="awaiting_cost">Awaiting cost</option><option value="loss">Losses</option><option value="returned">Returned</option></select>`);
  const rows = state.data.orders.map((o) => recompute({
    order_id: o.order_id, created_at: o.created_at, title: o.title, revenue: o.revenue, status: o.status, cancelled: o.cancelled,
    base_fees: o.cancelled ? 0 : o.raw_fees, ad_fees: o.ad_fees,
    base_refunds: o.cancelled ? 0 : o.raw_refunds, amazon_cost: o.amazon_cost, has_link: o.amazon_orders.length > 0,
    amazon_ids: o.amazon_orders.map((a) => a.amazon_order_id).join(', '),
    cost_override: o.overrides.cost_override, fee_override: o.overrides.fee_override, refund_override: o.overrides.refund_override,
    extra_cost: o.overrides.extra_cost, amazon_refund: o.overrides.amazon_refund, excluded: o.overrides.excluded, notes: o.overrides.notes,
    edited: Object.entries(o.overrides).some(([k, v]) => (k === 'excluded' ? v : k === 'notes' ? Boolean(v) : v !== null)),
  }));
  const editable = new Set(['cost_override', 'fee_override', 'refund_override', 'extra_cost', 'amazon_refund', 'excluded', 'notes']);
  const edCell = (c) => (editable.has(c.getField()) ? 'cell-edit' : 'cell-ro');
  const t = trackTable(new Tabulator('#ed-body', {
    data: rows,
    index: 'order_id',
    height: 'calc(100vh - 250px)',
    layout: 'fitDataStretch',
    history: true,
    selectableRange: 1,
    selectableRangeColumns: true,
    selectableRangeRows: true,
    selectableRangeClearCells: true,
    editTriggerEvent: 'dblclick',
    clipboard: true,
    clipboardCopyStyled: false,
    clipboardCopyConfig: { rowHeaders: false, columnHeaders: false },
    clipboardCopyRowRange: 'range',
    clipboardPasteParser: 'range',
    clipboardPasteAction: 'range',
    rowHeader: { resizable: false, frozen: true, width: 44, hozAlign: 'center', formatter: 'rownum', cssClass: 'cell-ro', headerSort: false },
    initialSort: [{ column: 'created_at', dir: 'desc' }],
    placeholder: 'No eBay orders yet. Connect eBay in Settings or upload a monthly sheet.',
    columnDefaults: { headerSort: true, resizable: true },
    columns: [
      { title: 'Date', field: 'created_at', width: 100, formatter: (c) => fmtDate(c.getValue(), { month: 'short', day: 'numeric', year: '2-digit' }), cssClass: 'cell-ro' },
      { title: 'eBay order', field: 'order_id', width: 150, cssClass: 'cell-ro', formatter: (c) => `<span class="mono">${esc(c.getValue())}</span>` },
      { title: 'Item', field: 'title', width: 280, cssClass: 'cell-ro', formatter: (c) => `<span title="${esc(c.getValue())}">${esc(c.getValue())}</span>` },
      { title: 'Revenue', field: 'revenue', hozAlign: 'right', width: 95, formatter: moneyFmt, cssClass: 'cell-ro' },
      { title: 'Amazon cost', field: 'amazon_cost', hozAlign: 'right', width: 110, cssClass: 'cell-ro', formatter: (c) => (c.getRow().getData().has_link ? money(c.getValue()) : '<span class="muted">not linked</span>') },
      { title: 'Cost override', field: 'cost_override', hozAlign: 'right', width: 120, ...numEditor, formatter: moneyFmt, cssClass: 'cell-edit' },
      { title: 'eBay fees', field: 'base_fees', hozAlign: 'right', width: 95, formatter: moneyFmt, cssClass: 'cell-ro' },
      { title: 'Fee override', field: 'fee_override', hozAlign: 'right', width: 110, ...numEditor, formatter: moneyFmt, cssClass: 'cell-edit' },
      { title: 'Ad fees', field: 'ad_fees', hozAlign: 'right', width: 85, formatter: moneyFmt, cssClass: 'cell-ro' },
      { title: 'Refunds', field: 'base_refunds', hozAlign: 'right', width: 90, formatter: moneyFmt, cssClass: 'cell-ro' },
      { title: 'Refund override', field: 'refund_override', hozAlign: 'right', width: 125, ...numEditor, formatter: moneyFmt, cssClass: 'cell-edit' },
      { title: 'Amazon refund', field: 'amazon_refund', hozAlign: 'right', width: 120, ...numEditor, formatter: moneyFmt, cssClass: 'cell-edit' },
      { title: 'Extra cost', field: 'extra_cost', hozAlign: 'right', width: 100, ...numEditor, formatter: moneyFmt, cssClass: 'cell-edit' },
      { title: 'Net', field: 'net', hozAlign: 'right', width: 100, cssClass: 'cell-ro', formatter: (c) => (c.getValue() === null ? '<span class="muted">pending</span>' : `<b class="${c.getValue() < 0 ? 'neg' : 'pos'}">${money(c.getValue())}</b>`) },
      { title: 'Exclude', field: 'excluded', hozAlign: 'center', width: 85, editor: 'tickCross', formatter: 'tickCross', formatterParams: { crossElement: '<span class="muted">·</span>' }, cssClass: 'cell-edit' },
      { title: 'Notes', field: 'notes', width: 240, editor: 'input', cssClass: 'cell-edit' },
      { title: 'Amazon orders', field: 'amazon_ids', width: 190, cssClass: 'cell-ro', formatter: (c) => `<span class="mono muted">${esc(c.getValue())}</span>` },
    ],
  }));

  t.on('cellEdited', (cell) => {
    const f = cell.getField();
    if (!editable.has(f)) return;
    const row = cell.getRow();
    const d = row.getData();
    let v = cell.getValue();
    if (f !== 'notes' && f !== 'excluded') v = v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v);
    if (f === 'excluded') v = v === true || v === 'true' || v === 1 || v === '1';
    const ch = dirty.get(d.order_id) || {};
    ch[f] = v;
    dirty.set(d.order_id, ch);
    cell.getElement().classList.add('cell-dirty');
    row.update(recompute({ ...d, [f]: v }));
    markDirty(dirty.size);
  });
  t.on('tableBuilt', () => {
    if (focusOrder) {
      t.setFilter('order_id', '=', focusOrder);
      $('#ed-q').value = focusOrder;
    }
  });
  t.on('rowDblClick', (e, row) => { if (e.target.closest('.cell-ro') && e.target.closest('[tabulator-field="order_id"]')) openOrder(row.getData().order_id); });

  const applyFilter = () => {
    const v = $('#ed-q').value.toLowerCase();
    const f = $('#ed-filter').value;
    t.setFilter((d) => (f === 'all' || (f === 'edited' ? d.edited || dirty.has(d.order_id) : d.status === f)) && (!v || `${d.order_id} ${d.title} ${d.notes} ${d.amazon_ids}`.toLowerCase().includes(v)));
  };
  $('#ed-q').addEventListener('input', applyFilter);
  $('#ed-filter').addEventListener('change', applyFilter);
  $('#ed-undo').onclick = () => t.undo();
  $('#ed-discard').onclick = () => { dirty.clear(); renderPage(); };
  $('#ed-export').onclick = () => {
    const ids = new Set(t.getData('active').map((r) => r.order_id));
    downloadCsv('orders-edited.csv', state.data.orders.filter((o) => ids.has(o.order_id)), ORDER_EXPORT);
  };
  $('#ed-save').onclick = async () => {
    const changes = [...dirty.entries()].map(([order_id, ch]) => ({ order_id, ...ch }));
    $('#ed-save').disabled = true;
    try {
      await api('/api/overrides', { method: 'POST', body: { changes } });
      toast(`Saved ${changes.length} order${changes.length > 1 ? 's' : ''}`, 'good');
      dirty.clear();
      await loadData();
      renderPage();
    } catch (e) { toast(e.message, 'bad'); $('#ed-save').disabled = false; }
  };
}

// ------------------------------------------------------------------ Amazon sheet
async function amazonSheet() {
  toolbar(`<select class="select" id="ed-filter" style="height:28px;font-size:12px"><option value="all">All purchases</option><option value="linked">Linked to eBay</option><option value="unlinked">Not linked (ignored)</option><option value="ignored">Marked personal</option></select>`);
  $('#ed-body').innerHTML = '<div class="empty"><span class="dot spin" style="display:inline-block"></span> Loading purchases…</div>';
  const rows = (await api('/api/amazon')).map((r) => ({ ...r, order_date: r.order_date ? String(r.order_date).slice(0, 10) : null, line_total: r.line_total === null ? null : Number(r.line_total), cost_override: r.cost_override === null ? null : Number(r.cost_override), ebay_order_id_orig: r.ebay_order_id }));
  $('#ed-body').innerHTML = '';
  const t = trackTable(new Tabulator('#ed-body', {
    data: rows,
    index: 'line_key',
    height: 'calc(100vh - 250px)',
    layout: 'fitDataStretch',
    history: true,
    selectableRange: 1,
    selectableRangeColumns: true,
    selectableRangeRows: true,
    editTriggerEvent: 'dblclick',
    clipboard: true,
    clipboardCopyConfig: { rowHeaders: false, columnHeaders: false },
    clipboardCopyRowRange: 'range',
    clipboardPasteParser: 'range',
    clipboardPasteAction: 'range',
    rowHeader: { resizable: false, frozen: true, width: 44, hozAlign: 'center', formatter: 'rownum', cssClass: 'cell-ro', headerSort: false },
    initialSort: [{ column: 'order_date', dir: 'desc' }],
    placeholder: 'No Amazon purchases yet. They arrive automatically from the email import (Settings).',
    columns: [
      { title: 'Date', field: 'order_date', width: 100, cssClass: 'cell-ro', formatter: (c) => (c.getValue() ? fmtDate(`${c.getValue()}T12:00`, { month: 'short', day: 'numeric', year: '2-digit' }) : '') },
      { title: 'Amazon order', field: 'amazon_order_id', width: 180, cssClass: 'cell-ro', formatter: (c) => `<span class="mono">${esc(c.getValue())}</span>` },
      { title: 'Item', field: 'title', width: 280, cssClass: 'cell-ro', formatter: (c) => `<span title="${esc(c.getValue())}">${esc(c.getValue())}</span>` },
      { title: 'Qty', field: 'quantity', hozAlign: 'right', width: 60, cssClass: 'cell-ro' },
      { title: 'Total paid', field: 'line_total', hozAlign: 'right', width: 100, cssClass: 'cell-ro', formatter: moneyFmt },
      { title: 'Cost override', field: 'cost_override', hozAlign: 'right', width: 120, ...numEditor, formatter: moneyFmt, cssClass: 'cell-edit' },
      { title: 'Personal', field: 'ignored', hozAlign: 'center', width: 90, editor: 'tickCross', formatter: 'tickCross', formatterParams: { crossElement: '<span class="muted">·</span>' }, cssClass: 'cell-edit' },
      { title: 'Linked eBay order', field: 'ebay_order_id', width: 190, editor: 'input', cssClass: 'cell-edit', formatter: (c) => (c.getValue() ? `<span class="mono">${esc(c.getValue())}</span>` : '<span class="muted">not linked: ignored</span>') },
      { title: 'Link', field: 'link_method', width: 110, cssClass: 'cell-ro', formatter: (c) => (c.getValue() === 'manual' ? '<span class="pill info">by hand</span>' : c.getValue() ? `<span class="pill good" title="${esc(c.getRow().getData().link_reasons || '')}">auto</span>` : '') },
      { title: 'Ship to', field: 'ship_name', width: 200, cssClass: 'cell-ro', formatter: (c) => { const d = c.getRow().getData(); return esc([d.ship_name, d.ship_state, d.ship_zip].filter(Boolean).join(' · ')); } },
      { title: 'Status', field: 'order_status', width: 110, cssClass: 'cell-ro' },
    ],
  }));
  const linkChanges = new Map();
  t.on('cellEdited', (cell) => {
    const d = cell.getRow().getData();
    const f = cell.getField();
    if (f === 'ebay_order_id') {
      linkChanges.set(d.amazon_order_id, (cell.getValue() || '').trim() || null);
      // keep every line of the same Amazon order in sync
      t.getRows().filter((r) => r.getData().amazon_order_id === d.amazon_order_id).forEach((r) => { r.update({ ebay_order_id: cell.getValue() }); r.getCell('ebay_order_id').getElement().classList.add('cell-dirty'); });
    } else {
      const ch = dirty.get(d.line_key) || {};
      ch[f] = f === 'ignored' ? Boolean(cell.getValue()) : cell.getValue() === '' || cell.getValue() === null ? null : Number(cell.getValue());
      dirty.set(d.line_key, ch);
      cell.getElement().classList.add('cell-dirty');
    }
    markDirty(dirty.size + linkChanges.size);
  });
  const applyFilter = () => {
    const v = $('#ed-q').value.toLowerCase();
    const f = $('#ed-filter').value;
    t.setFilter((d) => (f === 'all' || (f === 'linked' && d.ebay_order_id) || (f === 'unlinked' && !d.ebay_order_id) || (f === 'ignored' && d.ignored)) && (!v || `${d.amazon_order_id} ${d.title} ${d.ship_name} ${d.ebay_order_id || ''} ${d.asin || ''}`.toLowerCase().includes(v)));
  };
  $('#ed-q').addEventListener('input', applyFilter);
  $('#ed-filter').addEventListener('change', applyFilter);
  $('#ed-undo').onclick = () => t.undo();
  $('#ed-discard').onclick = () => { dirty.clear(); renderPage(); };
  $('#ed-export').onclick = () => t.download('csv', 'amazon-purchases.csv');
  $('#ed-save').onclick = async () => {
    $('#ed-save').disabled = true;
    try {
      if (dirty.size) await api('/api/amazon/lines', { method: 'POST', body: { changes: [...dirty.entries()].map(([line_key, ch]) => ({ line_key, ...ch })) } });
      const errors = [];
      for (const [amazon_order_id, ebay_order_id] of linkChanges) {
        try { await api('/api/links', { method: 'POST', body: { amazon_order_id, ebay_order_id } }); } catch (e) { errors.push(e.message); }
      }
      if (errors.length) toast(errors.join(' · '), 'bad'); else toast('Saved', 'good');
      dirty.clear();
      await loadData();
      renderPage();
    } catch (e) { toast(e.message, 'bad'); $('#ed-save').disabled = false; }
  };
}

// ------------------------------------------------------------------ Match review
async function matchReview() {
  $('#ed-tools').innerHTML = '';
  $('#ed-help').textContent = 'These Amazon orders look like they might belong to an eBay sale, but there is not enough proof (zip, name or tracking) to link them automatically. Until you link one, it stays out of the numbers.';
  $('#ed-body').innerHTML = '<div class="empty"><span class="dot spin" style="display:inline-block"></span> Finding candidates…</div>';
  const list = await api('/api/suggestions');
  if (!list.length) { $('#ed-body').innerHTML = '<div class="empty"><div class="t">Nothing to review</div>Every Amazon purchase is either linked or has no plausible eBay sale.</div>'; return; }
  $('#ed-body').innerHTML = list.map((s) => `<div class="match-card" data-az="${esc(s.amazon_order_id)}">
      <div>
        <div class="muted" style="font-size:11.5px;text-transform:uppercase;letter-spacing:.06em">Amazon purchase</div>
        <div style="font-weight:600;margin-top:4px">${esc(s.amazon_titles.join(' · '))}</div>
        <div class="muted mono" style="margin-top:4px">${esc(s.amazon_order_id)} · ${s.order_date ? fmtDate(`${s.order_date}T12:00`) : ''}</div>
        <button class="btn sm ghost" style="margin-top:8px" data-personal>Mark as personal purchase</button>
      </div>
      <div>${s.candidates.map((c) => `<div class="cand">
          <div class="score" style="color:${c.score >= 60 ? 'var(--good-ink)' : c.score >= 45 ? 'var(--warn)' : 'var(--ink-3)'}" title="Match score">${c.score}</div>
          <div style="min-width:0;flex:1"><div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(c.ebay_titles.join(' · '))}</div>
          <div class="muted" style="font-size:12px">${fmtDate(c.created_at)} · ${esc(c.ship_name || '')} · ${esc(c.reasons)}</div></div>
          <button class="btn sm primary" data-link="${esc(c.ebay_order_id)}">Link</button>
          <button class="btn sm" data-reject="${esc(c.ebay_order_id)}" title="Not a match">${ICONS.x}</button>
        </div>`).join('')}</div>
    </div>`).join('');
  $('#ed-body').addEventListener('click', async (e) => {
    const card = e.target.closest('.match-card');
    if (!card) return;
    const az = card.dataset.az;
    const link = e.target.closest('[data-link]');
    const rej = e.target.closest('[data-reject]');
    const personal = e.target.closest('[data-personal]');
    try {
      if (link) { await api('/api/links', { method: 'POST', body: { amazon_order_id: az, ebay_order_id: link.dataset.link } }); card.remove(); toast('Linked', 'good'); }
      else if (rej) { await api('/api/links/reject', { method: 'POST', body: { amazon_order_id: az, ebay_order_id: rej.dataset.reject } }); rej.closest('.cand').remove(); if (!card.querySelector('.cand')) card.remove(); }
      else if (personal) { await api('/api/links/reject', { method: 'POST', body: { amazon_order_id: az, ignore_amazon: true } }); card.remove(); toast('Marked personal'); }
      else return;
      loadData();
    } catch (err) { toast(err.message, 'bad'); }
  });
}

// ------------------------------------------------------------------ Operating expenses sheet
function expensesSheet() {
  const A = state.data.settings.partner_amazon;
  const B = state.data.settings.partner_ebay;
  toolbar('<button class="btn sm" id="ex-add" title="Add a row for this month">+ Add expense</button>');
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const rows = state.data.books.expenses.map((x) => ({ ...x }));
  const payer = { seller: `${B} (eBay partner)`, amazon: `${A} (Amazon partner)` };
  const t = trackTable(new Tabulator('#ed-body', {
    data: rows,
    index: 'id',
    height: 'calc(100vh - 250px)',
    layout: 'fitColumns',
    history: true,
    selectableRange: 1,
    editTriggerEvent: 'dblclick',
    clipboard: true,
    clipboardPasteParser: 'range',
    clipboardPasteAction: 'range',
    initialSort: [{ column: 'month', dir: 'desc' }],
    groupBy: 'month',
    groupHeader: (value, n, data) => `${esc(value)} <span class="muted" style="margin-left:8px">${n} items · ${money(data.reduce((s, r) => s + (Number(r.amount) || 0), 0), 2)}</span>`,
    placeholder: 'No operating expenses yet',
    columns: [
      { title: 'Month', field: 'month', width: 110, editor: 'input', editorParams: { mask: '9999-99' }, cssClass: 'cell-edit' },
      { title: 'Category', field: 'category', minWidth: 200, widthGrow: 2, editor: 'input', cssClass: 'cell-edit' },
      { title: 'Amount', field: 'amount', hozAlign: 'right', width: 120, ...numEditor, formatter: moneyFmt, cssClass: 'cell-edit' },
      { title: 'Paid by', field: 'paid_by', width: 200, editor: 'list', editorParams: { values: payer }, formatter: (c) => esc(payer[c.getValue()] || payer.seller), cssClass: 'cell-edit' },
      { title: 'Note', field: 'note', minWidth: 180, widthGrow: 2, editor: 'input', cssClass: 'cell-edit' },
      { title: 'Source', field: 'source', width: 110, cssClass: 'cell-ro', formatter: (c) => (c.getValue() === 'sheet' ? '<span class="pill">sheet</span>' : '<span class="pill info">manual</span>') },
      { title: '', field: '_del', width: 60, hozAlign: 'center', headerSort: false, cssClass: 'cell-ro', formatter: () => `<button class="btn sm ghost" title="Delete">${ICONS.x}</button>`,
        cellClick: (_e, cell) => { const d = cell.getRow().getData(); if (d.id) dirty.set(`del:${d.id}`, { id: d.id, _delete: true }); cell.getRow().delete(); markDirty(dirty.size); } },
    ],
  }));
  let tmp = 0;
  t.on('cellEdited', (cell) => {
    const d = cell.getRow().getData();
    const key = d.id ? `id:${d.id}` : d._tmp;
    dirty.set(key, { id: d.id, month: d.month, category: d.category, amount: d.amount, note: d.note, paid_by: d.paid_by || 'seller' });
    cell.getElement().classList.add('cell-dirty');
    markDirty(dirty.size);
  });
  $('#ex-add').onclick = async () => {
    const _tmp = `new:${++tmp}`;
    const row = await t.addRow({ _tmp, month: thisMonth, category: '', amount: 0, paid_by: 'seller', note: '', source: 'manual' }, true);
    dirty.set(_tmp, { month: thisMonth, category: '', amount: 0, paid_by: 'seller' });
    markDirty(dirty.size);
    row.getCell('category').edit();
  };
  $('#ed-q').addEventListener('input', (ev) => { const v = ev.target.value.toLowerCase(); t.setFilter((d) => `${d.month} ${d.category} ${d.note || ''}`.toLowerCase().includes(v)); });
  $('#ed-undo').onclick = () => t.undo();
  $('#ed-discard').onclick = () => { dirty.clear(); renderPage(); };
  $('#ed-export').onclick = () => t.download('csv', 'operating-expenses.csv');
  $('#ed-save').onclick = async () => {
    const changes = [...dirty.values()].filter((c) => c._delete || (c.category && /^\d{4}-\d{2}$/.test(c.month || '')));
    if (changes.length < dirty.size) toast('Rows need a month (YYYY-MM) and a category, so some were skipped', 'bad');
    try {
      await api('/api/expenses', { method: 'POST', body: { changes } });
      toast('Expenses saved', 'good');
      dirty.clear();
      await loadData();
      renderPage();
    } catch (err) { toast(err.message, 'bad'); }
  };
}
