// Editor tab: spreadsheet mode (range select, copy/paste, undo) over eBay orders and Amazon purchases,
// plus a match-review queue. Edits are staged locally (highlighted) until Save.
import { $, $$, esc, money, pct, fmtDate, api, toast, downloadCsv, ICONS, monthLabel } from './util.js';
import { state, loadData, renderPage, trackTable, openOrder, ORDER_EXPORT, statusPill, skeletonRows } from './app.js';

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

const numEditor = { editor: 'number', editorParams: { step: 0.01, selectContents: true }, sorter: 'number' };
const dateFmt = { month: 'short', day: 'numeric', year: 'numeric' };
const blank = (v) => v === '' || v === null || v === undefined;
// Normalise an edited cell value so "12", 12 and 12.0 compare equal and a cleared cell means "no override"
const normVal = (f, v) => {
  if (f === 'excluded' || f === 'ignored') return v === true || v === 'true' || v === 1 || v === '1';
  if (f === 'notes' || f === 'note' || f === 'category' || f === 'month' || f === 'paid_by') return blank(v) ? '' : String(v);
  return blank(v) || Number.isNaN(Number(v)) ? null : Number(v);
};
// Paint the yellow "unsaved" tint from the dirty map (also re-applied whenever Tabulator re-renders a row)
const paintDirty = (row, key, fields) => {
  const ch = dirty.get(key) || {};
  for (const f of fields) row.getCell(f)?.getElement().classList.toggle('cell-dirty', Object.prototype.hasOwnProperty.call(ch, f));
};
const moneyFmt = (c) => { const v = c.getValue(); return v === null || v === undefined || v === '' ? '<span class="muted">—</span>' : money(Number(v)); };

function recompute(d) {
  const cost = d.cost_override !== null && d.cost_override !== '' && d.cost_override !== undefined ? Number(d.cost_override) : d.amazon_cost;
  const fees = d.fee_override !== null && d.fee_override !== '' && d.fee_override !== undefined ? Number(d.fee_override) : d.base_fees;
  const refunds = d.refund_override !== null && d.refund_override !== '' && d.refund_override !== undefined ? Number(d.refund_override) : d.base_refunds;
  const hasCost = d.has_link || (d.cost_override !== null && d.cost_override !== '' && d.cost_override !== undefined);
  const rev = d.cancelled ? 0 : d.revenue;
  d.net = hasCost ? +(rev - (d.cancelled ? 0 : fees) - (d.cancelled ? 0 : d.ad_fees) - cost - (d.cancelled ? 0 : refunds) + Number(d.amazon_refund || 0) - Number(d.extra_cost || 0)).toFixed(2) : null;
  // Same rule as the server's `counted`: sheet-covered and pre-partnership sales never count, nor do exclusions
  const notCounted = d.status === 'in_sheet' || d.status === 'before_start';
  const keep = notCounted || (d.status === 'not_dropship' && !hasCost) || d.status === 'check_sheet' || d.status === 'cancelled' || d.status === 'cancelled_after_purchase';
  d.live_counted = !notCounted && !d.excluded && hasCost && !(d.cancelled && !cost);
  d.view_status = keep && !(d.status === 'check_sheet' && hasCost) ? d.status
    : d.excluded ? 'excluded' : !hasCost ? 'awaiting_cost' : refunds > 0 || d.has_returns ? 'returned' : d.net < 0 ? 'loss' : 'profitable';
  return d;
}

// ------------------------------------------------------------------ eBay sheet
function ebaySheet(focusOrder) {
  toolbar(`<select class="select" id="ed-filter" style="height:28px;font-size:12px"><option value="all">All orders</option><option value="edited">Edited only</option><option value="awaiting_cost">Awaiting cost</option><option value="loss">Losses</option><option value="returned">Returned</option></select>`);
  // Monthly-sheet rows carry their Amazon cost from the sheet, so they are costed like any linked order
  const rows = state.data.orders.map((o) => recompute({
    order_id: o.order_id, source: o.source, ebay_order_id: o.ebay_order_id || null, created_at: o.created_at, title: o.title, revenue: o.revenue, status: o.status, cancelled: o.cancelled,
    base_fees: o.cancelled ? 0 : o.raw_fees, ad_fees: o.ad_fees, has_returns: o.returns.length > 0,
    base_refunds: o.cancelled ? 0 : o.raw_refunds, amazon_cost: o.amazon_cost, has_link: o.source === 'ledger' || o.amazon_orders.length > 0,
    cost_origin: o.source === 'ledger' ? 'sheet' : o.amazon_orders.length ? 'amazon' : null,
    amazon_ids: o.amazon_orders.map((a) => a.amazon_order_id).join(', '),
    cost_override: o.overrides.cost_override, fee_override: o.overrides.fee_override, refund_override: o.overrides.refund_override,
    extra_cost: o.overrides.extra_cost, amazon_refund: o.overrides.amazon_refund, excluded: o.overrides.excluded, notes: o.overrides.notes,
    edited: Object.entries(o.overrides).some(([k, v]) => (k === 'excluded' ? v : k === 'notes' ? Boolean(v) : v !== null)),
  }));
  const EDIT_FIELDS = ['cost_override', 'fee_override', 'refund_override', 'extra_cost', 'amazon_refund', 'excluded', 'notes'];
  const editable = new Set(EDIT_FIELDS);
  const orig = new Map(rows.map((r) => [r.order_id, Object.fromEntries(EDIT_FIELDS.map((f) => [f, normVal(f, r[f])]))]));
  const refundTitle = (d) => (d.source === 'ledger' ? 'eBay refund fee (monthly sheet)' : 'Refunded to buyer');
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
    rowFormatter: (row) => paintDirty(row, row.getData().order_id, EDIT_FIELDS),
    initialSort: [{ column: 'created_at', dir: 'desc' }],
    placeholder: 'No eBay orders yet. Connect eBay in Settings or upload a monthly sheet.',
    columnDefaults: { headerSort: true, resizable: true },
    columns: [
      { title: 'Date', field: 'created_at', width: 110, formatter: (c) => fmtDate(c.getValue(), dateFmt), cssClass: 'cell-ro' },
      { title: 'eBay order', field: 'order_id', width: 170, cssClass: 'cell-ro', formatter: (c) => { const d = c.getRow().getData(); return d.source === 'ledger' ? `<span title="Row from the monthly settlement sheet">Monthly sheet</span>${d.ebay_order_id ? ` <span class="mono muted">${esc(d.ebay_order_id)}</span>` : ''}` : `<span class="mono">${esc(c.getValue())}</span>`; } },
      { title: 'Item', field: 'title', width: 280, cssClass: 'cell-ro', formatter: (c) => `<span title="${esc(c.getValue())}">${esc(c.getValue())}</span>` },
      { title: 'Status', field: 'view_status', width: 172, cssClass: 'cell-ro', formatter: (c) => statusPill(c.getValue()) },
      { title: 'Revenue', field: 'revenue', hozAlign: 'right', width: 95, sorter: 'number', formatter: (c) => `<span title="${c.getRow().getData().source === 'ledger' ? 'eBay payout after fees (monthly sheet)' : 'Buyer paid, excl. tax'}">${moneyFmt(c)}</span>`, cssClass: 'cell-ro' },
      { title: 'Amazon cost', field: 'amazon_cost', hozAlign: 'right', width: 145, sorter: 'number', cssClass: 'cell-ro', formatter: (c) => {
        const d = c.getRow().getData();
        if (d.status === 'in_sheet') return '<span class="muted" title="This eBay sale is covered by its monthly-sheet row, which carries the cost">in monthly sheet</span>';
        if (d.status === 'before_start') return '<span class="muted" title="Sold before the partnership started; not counted">before partnership</span>';
        if (d.cost_origin === 'sheet') return `${money(c.getValue())} <span class="pill" title="Amazon cost from the monthly settlement sheet">${ICONS.sheet} sheet</span>`;
        return d.has_link ? money(c.getValue()) : '<span class="muted">not linked</span>';
      } },
      { title: 'Cost override', field: 'cost_override', hozAlign: 'right', width: 120, ...numEditor, formatter: moneyFmt, cssClass: 'cell-edit' },
      { title: 'eBay fees', field: 'base_fees', hozAlign: 'right', width: 95, sorter: 'number', formatter: (c) => (c.getRow().getData().source === 'ledger' && !c.getValue() ? '<span class="muted" title="Sheet payouts are already net of eBay fees">in payout</span>' : moneyFmt(c)), cssClass: 'cell-ro' },
      { title: 'Fee override', field: 'fee_override', hozAlign: 'right', width: 110, ...numEditor, formatter: moneyFmt, cssClass: 'cell-edit' },
      { title: 'Ad fees', field: 'ad_fees', hozAlign: 'right', width: 85, sorter: 'number', formatter: moneyFmt, cssClass: 'cell-ro' },
      { title: 'Refunds', field: 'base_refunds', hozAlign: 'right', width: 90, sorter: 'number', formatter: (c) => `<span title="${refundTitle(c.getRow().getData())}">${moneyFmt(c)}</span>`, cssClass: 'cell-ro' },
      { title: 'Refund override', field: 'refund_override', hozAlign: 'right', width: 125, ...numEditor, formatter: moneyFmt, cssClass: 'cell-edit' },
      { title: 'Amazon refund', field: 'amazon_refund', hozAlign: 'right', width: 120, ...numEditor, formatter: moneyFmt, cssClass: 'cell-edit' },
      { title: 'Extra cost', field: 'extra_cost', hozAlign: 'right', width: 100, ...numEditor, formatter: moneyFmt, cssClass: 'cell-edit' },
      { title: 'Net', field: 'net', hozAlign: 'right', width: 110, sorter: 'number', cssClass: 'cell-ro', formatter: (c) => {
        const d = c.getRow().getData();
        if (d.status === 'in_sheet') return '<span class="muted" title="Counted once, through its monthly-sheet row">in sheet</span>';
        if (d.status === 'before_start') return '<span class="muted" title="Before the partnership started">not counted</span>';
        return c.getValue() === null ? '<span class="muted">pending</span>' : `<b class="${c.getValue() < 0 ? 'neg' : 'pos'}">${money(c.getValue())}</b>`;
      } },
      { title: 'Exclude', field: 'excluded', hozAlign: 'center', width: 85, editor: 'tickCross', formatter: 'tickCross', formatterParams: { crossElement: '<span class="muted">·</span>' }, cssClass: 'cell-edit' },
      { title: 'Notes', field: 'notes', width: 240, editor: 'input', cssClass: 'cell-edit' },
      { title: 'Amazon orders', field: 'amazon_ids', width: 190, cssClass: 'cell-ro', formatter: (c) => `<span class="mono muted">${esc(c.getValue())}</span>` },
    ],
  }));

  // Every edit, undo and redo re-diffs the cell against the saved value, so undoing back to the original
  // removes the pending change (no phantom yellow cell or Save count)
  const syncCell = (cell) => {
    const f = cell.getField();
    if (!editable.has(f)) return;
    const row = cell.getRow();
    const d = row.getData();
    const v = normVal(f, cell.getValue());
    const ch = { ...(dirty.get(d.order_id) || {}) };
    if (v === orig.get(d.order_id)[f]) delete ch[f]; else ch[f] = v;
    if (Object.keys(ch).length) dirty.set(d.order_id, ch); else dirty.delete(d.order_id);
    row.update(recompute({ ...d, [f]: v }));
    paintDirty(row, d.order_id, EDIT_FIELDS);
    markDirty(dirty.size);
  };
  t.on('cellEdited', syncCell);
  t.on('historyUndo', (type, component) => { if (type === 'cellEdit') syncCell(component); });
  t.on('historyRedo', (type, component) => { if (type === 'cellEdit') syncCell(component); });
  t.on('tableBuilt', () => {
    if (focusOrder) {
      t.setFilter('order_id', '=', focusOrder);
      const r = rows.find((x) => x.order_id === focusOrder);
      $('#ed-q').value = r?.source === 'ledger' ? (r.ebay_order_id || r.title) : focusOrder;
    }
  });
  t.on('rowDblClick', (e, row) => { if (e.target.closest('.cell-ro') && e.target.closest('[tabulator-field="order_id"]')) openOrder(row.getData().order_id); });

  const applyFilter = () => {
    const v = $('#ed-q').value.toLowerCase();
    const f = $('#ed-filter').value;
    // "Losses" matches the Overview/Orders definition: counted orders with a negative net
    const pass = (d) => (f === 'all' ? true : f === 'edited' ? d.edited || dirty.has(d.order_id) : f === 'loss' ? d.live_counted && d.net !== null && d.net < 0 : d.status === f);
    t.setFilter((d) => pass(d) && (!v || `${d.source === 'ledger' ? 'monthly sheet' : d.order_id} ${d.ebay_order_id || ''} ${d.title} ${d.notes} ${d.amazon_ids}`.toLowerCase().includes(v)));
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
  $('#ed-body').innerHTML = skeletonRows(12);
  const linkChanges = new Map();
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
    rowFormatter: (row) => {
      const d = row.getData();
      paintDirty(row, d.line_key, ['cost_override', 'ignored']);
      row.getCell('ebay_order_id')?.getElement().classList.toggle('cell-dirty', linkChanges.has(d.amazon_order_id));
    },
    initialSort: [{ column: 'order_date', dir: 'desc' }],
    placeholder: 'No Amazon purchases yet. They arrive automatically from the email import (Settings).',
    columns: [
      { title: 'Date', field: 'order_date', width: 110, cssClass: 'cell-ro', formatter: (c) => (c.getValue() ? fmtDate(`${c.getValue()}T12:00`, dateFmt) : '') },
      { title: 'Amazon order', field: 'amazon_order_id', width: 180, cssClass: 'cell-ro', formatter: (c) => `<span class="mono">${esc(c.getValue())}</span>` },
      { title: 'Item', field: 'title', width: 280, cssClass: 'cell-ro', formatter: (c) => `<span title="${esc(c.getValue())}">${esc(c.getValue())}</span>` },
      { title: 'Qty', field: 'quantity', hozAlign: 'right', width: 60, sorter: 'number', cssClass: 'cell-ro' },
      { title: 'Total paid', field: 'line_total', hozAlign: 'right', width: 100, sorter: 'number', cssClass: 'cell-ro', formatter: moneyFmt },
      { title: 'Cost override', field: 'cost_override', hozAlign: 'right', width: 120, ...numEditor, formatter: moneyFmt, cssClass: 'cell-edit' },
      { title: 'Personal', field: 'ignored', hozAlign: 'center', width: 90, editor: 'tickCross', formatter: 'tickCross', formatterParams: { crossElement: '<span class="muted">·</span>' }, cssClass: 'cell-edit' },
      { title: 'Linked eBay order', field: 'ebay_order_id', width: 190, editor: 'input', cssClass: 'cell-edit', formatter: (c) => (c.getValue() ? `<span class="mono">${esc(c.getValue())}</span>` : '<span class="muted">not linked: ignored</span>') },
      { title: 'Link', field: 'link_method', width: 110, cssClass: 'cell-ro', formatter: (c) => (c.getValue() === 'manual' ? `<span class="pill info">${ICONS.check} by hand</span>` : c.getValue() ? `<span class="pill good" title="${esc(c.getRow().getData().link_reasons || '')}">${ICONS.link} auto</span>` : '') },
      { title: 'Ship to', field: 'ship_name', width: 200, cssClass: 'cell-ro', formatter: (c) => { const d = c.getRow().getData(); return esc([d.ship_name, d.ship_state, d.ship_zip].filter(Boolean).join(' · ')); } },
      { title: 'Status', field: 'order_status', width: 110, cssClass: 'cell-ro' },
    ],
  }));
  const origAz = new Map(rows.map((r) => [r.line_key, { cost_override: normVal('cost_override', r.cost_override), ignored: normVal('ignored', r.ignored), ebay_order_id: r.ebay_order_id || null }]));
  const syncAz = (cell) => {
    const d = cell.getRow().getData();
    const f = cell.getField();
    if (f === 'ebay_order_id') {
      const v = (cell.getValue() || '').trim() || null;
      const changed = v !== origAz.get(d.line_key).ebay_order_id;
      if (changed) linkChanges.set(d.amazon_order_id, v); else linkChanges.delete(d.amazon_order_id);
      // keep every line of the same Amazon order in sync
      t.getRows().filter((r) => r.getData().amazon_order_id === d.amazon_order_id).forEach((r) => { r.update({ ebay_order_id: cell.getValue() }); r.getCell('ebay_order_id')?.getElement().classList.toggle('cell-dirty', changed); });
    } else if (f === 'cost_override' || f === 'ignored') {
      const v = normVal(f, cell.getValue());
      const ch = { ...(dirty.get(d.line_key) || {}) };
      if (v === origAz.get(d.line_key)[f]) delete ch[f]; else ch[f] = v;
      if (Object.keys(ch).length) dirty.set(d.line_key, ch); else dirty.delete(d.line_key);
      paintDirty(cell.getRow(), d.line_key, ['cost_override', 'ignored']);
    }
    markDirty(dirty.size + linkChanges.size);
  };
  t.on('cellEdited', syncAz);
  t.on('historyUndo', (type, component) => { if (type === 'cellEdit') syncAz(component); });
  t.on('historyRedo', (type, component) => { if (type === 'cellEdit') syncAz(component); });
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
  $('#ed-body').innerHTML = skeletonRows(8);
  const list = await api('/api/suggestions');
  if (!list.length) { $('#ed-body').innerHTML = `<div class="empty lg"><div class="ic">${ICONS.circleCheck}</div><div class="t">Nothing to review</div><p>Every Amazon purchase is either linked to an eBay sale or has no plausible match. New candidates show up here after each email check.</p></div>`; return; }
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
  const EX_FIELDS = ['month', 'category', 'amount', 'paid_by', 'note'];
  const snap = (d) => ({ month: normVal('month', d.month), category: normVal('category', d.category), amount: normVal('amount', d.amount), paid_by: normVal('paid_by', d.paid_by || 'seller'), note: normVal('note', d.note) });
  const origEx = new Map(rows.map((r) => [r.id, snap(r)]));
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
    rowFormatter: (row) => { const d = row.getData(); const ch = dirty.get(d.id ? `id:${d.id}` : d._tmp); for (const f of EX_FIELDS) row.getCell(f)?.getElement().classList.toggle('cell-dirty', Boolean(ch?.[`__${f}`])); },
    groupBy: 'month',
    groupHeader: (value, n, data) => `${/^\d{4}-\d{2}$/.test(value || '') ? esc(monthLabel(value)) : esc(value)} <span class="muted" style="margin-left:8px">${n} items · ${money(data.reduce((s, r) => s + (Number(r.amount) || 0), 0), 2)}</span>`,
    placeholder: 'No operating expenses yet',
    columns: [
      { title: 'Month', field: 'month', width: 110, editor: 'input', editorParams: { mask: '9999-99' }, cssClass: 'cell-edit' },
      { title: 'Category', field: 'category', minWidth: 200, widthGrow: 2, editor: 'input', cssClass: 'cell-edit' },
      { title: 'Amount', field: 'amount', hozAlign: 'right', width: 120, ...numEditor, formatter: moneyFmt, cssClass: 'cell-edit' },
      { title: 'Paid by', field: 'paid_by', width: 200, editor: 'list', editorParams: { values: payer }, formatter: (c) => esc(payer[c.getValue()] || payer.seller), cssClass: 'cell-edit' },
      { title: 'Note', field: 'note', minWidth: 180, widthGrow: 2, editor: 'input', cssClass: 'cell-edit' },
      { title: 'Source', field: 'source', width: 110, cssClass: 'cell-ro', formatter: (c) => (c.getValue() === 'sheet' ? `<span class="pill">${ICONS.sheet} sheet</span>` : `<span class="pill info">${ICONS.editor} manual</span>`) },
      { title: '', field: '_del', width: 60, hozAlign: 'center', headerSort: false, cssClass: 'cell-ro', formatter: () => `<button class="btn sm ghost danger" title="Delete" aria-label="Delete row">${ICONS.trash}</button>`,
        cellClick: (_e, cell) => { const d = cell.getRow().getData(); if (d.id) dirty.set(`del:${d.id}`, { id: d.id, _delete: true }); cell.getRow().delete(); markDirty(dirty.size); } },
    ],
  }));
  let tmp = 0;
  // Re-diff the whole row against what is saved; a row edited back to its saved values is no longer pending
  const syncEx = (row) => {
    const d = row.getData();
    const key = d.id ? `id:${d.id}` : d._tmp;
    const now = snap(d);
    const was = d.id ? origEx.get(d.id) : null;
    const changed = was ? EX_FIELDS.filter((f) => now[f] !== was[f]) : EX_FIELDS;
    if (was && !changed.length) dirty.delete(key);
    else dirty.set(key, { id: d.id, month: d.month, category: d.category, amount: d.amount, note: d.note, paid_by: d.paid_by || 'seller', ...Object.fromEntries(changed.map((f) => [`__${f}`, true])) });
    for (const f of EX_FIELDS) row.getCell(f)?.getElement().classList.toggle('cell-dirty', Boolean(dirty.get(key)?.[`__${f}`]));
    markDirty(dirty.size);
  };
  t.on('cellEdited', (cell) => syncEx(cell.getRow()));
  const onHistory = (undo) => (type, component) => {
    const d = component.getData?.() || {};
    if (type === 'cellEdit') syncEx(component.getRow());
    else if (type === 'rowDelete' && d.id) { if (undo) dirty.delete(`del:${d.id}`); else dirty.set(`del:${d.id}`, { id: d.id, _delete: true }); markDirty(dirty.size); }
    else if (type === 'rowAdd' && d._tmp) { if (undo) dirty.delete(d._tmp); else dirty.set(d._tmp, { month: d.month, category: d.category, amount: d.amount, paid_by: d.paid_by || 'seller', note: d.note }); markDirty(dirty.size); }
  };
  t.on('historyUndo', onHistory(true));
  t.on('historyRedo', onHistory(false));
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
    const changes = [...dirty.values()].map((c) => Object.fromEntries(Object.entries(c).filter(([k]) => !k.startsWith('__')))).filter((c) => c._delete || (c.category && /^\d{4}-\d{2}$/.test(c.month || '')));
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
