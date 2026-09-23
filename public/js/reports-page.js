// Reports: the monthly settlement statement (itemized, printable, copyable for a text message) and the
// year-end export for taxes. Every figure comes from settleMonth(), the same math as the Settlement page;
// the statement re-adds its own line items and shows whether they match the settlement to the cent.
import { $, esc, money, count, fmtDate, toast, downloadCsv, ICONS, settlementDueDate, dueStatus, monthLabel, settleView } from './util.js';
import { settleMonth, allMonths } from './settlement.js';
import { state } from './app.js';

const cents = (n) => Math.round((Number(n) || 0) * 100);
const d2 = (c) => c / 100;
let pickedMonth = null;
let pickedYear = null;

// One sale's money, exactly as settleMonth() adds it up
function lineOf(o) {
  const payout = cents(o.revenue) - cents(o.fees) - cents(o.refunds);
  const cogs = cents(o.cost) - cents(o.amazon_refund);
  const ads = cents(o.ad_fees);
  const other = cents(o.extra_cost);
  return { o, payout, cogs, ads, other, net: payout - cogs - ads - other };
}

export function statementFor(month) {
  const d = state.data;
  const s = settleMonth({ month, orders: d.orders, expenses: d.books.expenses, settlements: d.books.settlements, splitAmazon: Number(d.settings.split_amazon) });
  const lines = d.orders.filter((o) => o.counted && (o.business_month || '') === month).map(lineOf).sort((a, b) => (a.o.created_at < b.o.created_at ? -1 : 1));
  const sum = (k) => lines.reduce((t, l) => t + l[k], 0);
  const tot = { payout: sum('payout'), cogs: sum('cogs'), ads: sum('ads'), other: sum('other'), net: sum('net') };
  const matches = tot.net === cents(s.orderProfit) && tot.payout === cents(s.collected) && tot.cogs === cents(s.cogs);
  return { s, lines, tot, matches };
}

export function renderReports(el) {
  const d = state.data;
  const A = d.settings.partner_amazon;
  const B = d.settings.partner_ebay;
  const split = Number(d.settings.split_amazon);
  const dueDay = d.settings.settlement_day ?? 26;
  const months = allMonths(d.orders, d.books.expenses);
  if (!months.length) { el.innerHTML = `<div class="card"><div class="empty lg"><div class="ic">${ICONS.receipt}</div><div class="t">No months to report yet</div></div></div>`; return; }
  if (!pickedMonth || !months.includes(pickedMonth)) pickedMonth = months[months.length - 1];
  const years = [...new Set(months.map((m) => m.slice(0, 4)))].sort();
  if (!pickedYear || !years.includes(pickedYear)) pickedYear = years[years.length - 1];

  const { s, lines, tot, matches } = statementFor(pickedMonth);
  const v = settleView(s, A, B);
  const dueDate = settlementDueDate(pickedMonth, dueDay);
  const due = dueStatus(dueDate, { paid: v.fullyPaid });
  const paidLine = v.paid === null ? `<span class="neg">Not paid yet</span> · due ${fmtDate(dueDate, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}${due.kind === 'overdue' ? ` · <b class="neg">${esc(due.text.toLowerCase())}</b>` : ''}`
    : v.fullyPaid ? `<span class="pos">Paid in full</span>${s.paidAt ? ` on ${fmtDate(`${s.paidAt}T12:00`)}` : ''}${s.note ? ` · ${esc(s.note)}` : ''}`
    : `${money(v.paid, 2)} paid · <b class="neg">${money(v.outstanding, 2)} still owed</b> · due ${fmtDate(dueDate)}`;
  const row = (k, val, cls = '') => `<div class="st-row ${cls}"><span>${k}</span><span class="num">${val}</span></div>`;

  el.innerHTML = `
  <div class="grid g-12">
    <div class="c-8">
      <div class="row no-print" style="gap:10px;margin-bottom:12px;flex-wrap:wrap">
        <select class="select" id="rp-month" aria-label="Statement month">${[...months].reverse().map((m) => `<option value="${m}" ${m === pickedMonth ? 'selected' : ''}>${monthLabel(m, 'long')}</option>`).join('')}</select>
        <button class="btn primary" id="rp-print">${ICONS.down} Print / save PDF</button>
        <button class="btn" id="rp-copy">${ICONS.copy} Copy summary</button>
        <button class="btn" id="rp-csv">${ICONS.sheet} Itemized CSV</button>
      </div>
      <div class="card statement" id="statement">
        <div class="st-head">
          <div><div class="st-brand">Dropship Ledger</div><h2>${monthLabel(pickedMonth, 'long')} settlement statement</h2><div class="muted">${esc(B)} → ${esc(A)} · profit split ${split}/${100 - split}</div></div>
          <div class="st-amt"><div class="muted">${esc(v.from)} sends ${esc(v.to)}</div><div class="big num">${money(v.amount, 2)}</div><div class="st-paid">${paidLine}</div></div>
        </div>
        <div class="st-grid">
          <div>
            <h4>Summary</h4>
            ${row(`Sales counted`, count(s.orders))}
            ${row(`eBay payouts (collected by ${esc(B)})`, money(s.collected, 2))}
            ${row(`Amazon cost (paid by ${esc(A)})`, `−${money(s.cogs, 2)}`)}
            ${row('eBay ad fees', `−${money(s.adFees, 2)}`)}
            ${s.otherCosts ? row('Other per-order costs', `−${money(s.otherCosts, 2)}`) : ''}
            ${row('Operating costs', `−${money(s.opex, 2)}`)}
            ${row('Net business profit', money(s.businessProfit, 2), 'total')}
          </div>
          <div>
            <h4>Settlement</h4>
            ${row(`${esc(A)}'s reimbursement (Amazon cost${s.opexAmazon ? ' + expenses' : ''})`, money(s.cogs + s.opexAmazon, 2))}
            ${row(`${esc(A)}'s ${split}% share`, money(s.shareAmazon, 2))}
            ${row(`${esc(B)}'s ${100 - split}% share`, money(s.shareSeller, 2))}
            ${row(`${esc(v.from)} sends ${esc(v.to)}`, money(v.amount, 2), 'total')}
            <div class="st-check ${matches ? 'ok' : 'bad'}">${matches ? `${ICONS.check} Line items below add up to the settlement exactly` : `${ICONS.alert} Line items don’t add up to the settlement. Check the Editor.`}</div>
          </div>
        </div>
        ${s.expenses.length ? `<h4>Operating costs</h4><table class="simple st-table"><tbody>${s.expenses.map((e) => `<tr><td>${esc(e.category)}${e.note ? ` <span class="muted">${esc(e.note)}</span>` : ''}</td><td class="r num">${money(e.amount, 2)}</td></tr>`).join('')}</tbody></table>` : ''}
        <h4>Sales (${count(lines.length)})</h4>
        <div class="table-wrap"><table class="simple st-table"><thead><tr><th>Date</th><th>Item</th><th class="r">Payout</th><th class="r">Amazon</th><th class="r">Ads</th><th class="r">Profit</th></tr></thead><tbody>
          ${lines.map((l) => `<tr><td style="white-space:nowrap">${fmtDate(l.o.created_at)}${l.o.approx_date ? '<span class="muted">*</span>' : ''}</td><td>${esc(l.o.title.slice(0, 70))}</td><td class="r num">${money(d2(l.payout), 2)}</td><td class="r num">${money(d2(l.cogs), 2)}</td><td class="r num">${l.ads ? money(d2(l.ads), 2) : '—'}</td><td class="r num ${l.net < 0 ? 'neg' : ''}">${money(d2(l.net), 2)}</td></tr>`).join('')}
        </tbody><tfoot><tr class="total"><td></td><td><b>Total</b></td><td class="r num"><b>${money(d2(tot.payout), 2)}</b></td><td class="r num"><b>${money(d2(tot.cogs), 2)}</b></td><td class="r num"><b>${money(d2(tot.ads), 2)}</b></td><td class="r num"><b>${money(d2(tot.net), 2)}</b></td></tr></tfoot></table></div>
        ${lines.some((l) => l.o.approx_date) ? '<div class="muted" style="font-size:11.5px;margin-top:6px">* date within the month from the monthly sheet</div>' : ''}
        <div class="st-foot muted">Generated ${fmtDate(new Date(), { month: 'short', day: 'numeric', year: 'numeric' })} · settlements are due on the ${dueDay}th of each month</div>
      </div>
    </div>

    <div class="c-4 no-print">
      <div class="card">
        <div class="card-h"><div><h3>Year-end export for taxes</h3><div class="sub">Every counted sale, month totals and operating costs</div></div></div>
        <div class="card-b" id="tax-box"></div>
      </div>
    </div>
  </div>`;

  // ---- statement actions
  $('#rp-month').onchange = (e) => { pickedMonth = e.target.value; renderReports(el); };
  $('#rp-print').onclick = () => window.print();
  $('#rp-copy').onclick = async () => {
    const text = [
      `${monthLabel(pickedMonth, 'long')} settlement`,
      `Sales: ${s.orders} · eBay payouts ${money(s.collected, 2)}`,
      `Amazon cost (${A} paid): ${money(s.cogs, 2)}`,
      `Ad fees: ${money(s.adFees, 2)} · Operating costs: ${money(s.opex, 2)}`,
      `Net business profit: ${money(s.businessProfit, 2)}`,
      `${A} ${split}%: ${money(s.shareAmazon, 2)} · ${B} ${100 - split}%: ${money(s.shareSeller, 2)}`,
      `${v.from} sends ${v.to}: ${money(v.amount, 2)} (Amazon cost ${money(s.cogs + s.opexAmazon, 2)} + ${A}'s share ${money(s.shareAmazon, 2)})`,
      `Due ${fmtDate(dueDate, { weekday: 'short', month: 'short', day: 'numeric' })}${v.paid !== null ? ` · paid ${money(v.paid, 2)}` : ''}`,
    ].join('\n');
    try { await navigator.clipboard.writeText(text); toast('Summary copied: paste it into a text or email', 'good'); } catch { toast('Couldn’t copy. Select the statement text instead.', 'bad'); }
  };
  $('#rp-csv').onclick = () => downloadCsv(`statement-${pickedMonth}.csv`, lines, [
    { title: 'Date', get: (l) => l.o.created_at.slice(0, 10) }, { title: 'Item', get: (l) => l.o.title }, { title: 'eBay order', get: (l) => l.o.ebay_order_id || (l.o.source === 'ebay' ? l.o.order_id : '') },
    { title: 'eBay payout', get: (l) => d2(l.payout) }, { title: 'Amazon cost', get: (l) => d2(l.cogs) }, { title: 'Ad fees', get: (l) => d2(l.ads) }, { title: 'Other costs', get: (l) => d2(l.other) }, { title: 'Profit', get: (l) => d2(l.net) },
  ]);

  renderTax($('#tax-box'), years);
}

// ---------------------------------------------------------------- taxes
// Gross sales for a counted sale: eBay orders carry the buyer-paid price (excluding sales tax, which eBay
// collects and remits). Monthly-sheet rows only record the payout, so their gross comes from the matched eBay
// order when there is one; the fees are then the gap between gross and payout, keeping every total consistent.
function taxLine(o, ebayById) {
  const l = lineOf(o);
  let gross = null;
  if (o.source === 'ebay') gross = cents(o.revenue);
  else if (o.ebay_order_id && ebayById.has(o.ebay_order_id)) gross = o.ledger?.sale_price < 0 ? 0 : cents(ebayById.get(o.ebay_order_id).revenue);
  const refunds = cents(o.refunds);
  const fees = gross === null ? null : gross - refunds - l.payout;
  return { ...l, gross, fees, refunds, month: o.business_month };
}

function renderTax(box, years) {
  const d = state.data;
  const ebayById = new Map(d.orders.filter((o) => o.source === 'ebay').map((o) => [o.order_id, o]));
  const rowsFor = (y) => d.orders.filter((o) => o.counted && (o.business_month || '').startsWith(y)).map((o) => taxLine(o, ebayById));
  const draw = () => {
    const rows = rowsFor(pickedYear);
    const months = [...new Set(rows.map((r) => r.month))].sort();
    const exp = d.books.expenses.filter((e) => e.month.startsWith(pickedYear));
    const sum = (list, k) => list.reduce((t, r) => t + (r[k] || 0), 0);
    const noGross = rows.filter((r) => r.gross === null);
    const T = { gross: sum(rows, 'gross'), fees: sum(rows, 'fees'), refunds: sum(rows, 'refunds'), payout: sum(rows, 'payout'), ads: sum(rows, 'ads'), cogs: sum(rows, 'cogs'), other: sum(rows, 'other'), net: sum(rows, 'net'), opex: exp.reduce((t, e) => t + cents(e.amount), 0) };
    const line = (k, v, cls = '') => `<div class="stat-row ${cls}"><span class="k">${k}</span><span class="v num">${v}</span></div>`;
    box.innerHTML = `
      <select class="select" id="tax-year" aria-label="Tax year" style="margin-bottom:12px">${years.map((y) => `<option ${y === pickedYear ? 'selected' : ''}>${y}</option>`).join('')}</select>
      ${line('Sales counted', count(rows.length))}
      ${line('Gross sales (buyers paid, excl. tax)', money(d2(T.gross), 2))}
      ${line('eBay fees', `−${money(d2(T.fees), 2)}`)}
      ${line('Refunds to buyers', `−${money(d2(T.refunds), 2)}`)}
      ${noGross.length ? line(`Payout-only sales (no gross on record)`, money(d2(sum(noGross, 'payout')), 2)) : ''}
      ${line('eBay payouts', money(d2(T.payout), 2), 'strong')}
      ${line('Amazon cost of goods', `−${money(d2(T.cogs), 2)}`)}
      ${line('Ad fees', `−${money(d2(T.ads), 2)}`)}
      ${T.other ? line('Other per-order costs', `−${money(d2(T.other), 2)}`) : ''}
      ${line('Operating costs', `−${money(d2(T.opex), 2)}`)}
      ${line('Net business profit', money(d2(T.net - T.opex), 2), 'strong')}
      <div class="muted" style="font-size:11.5px;margin:10px 0">Compare “Gross sales” with eBay’s 1099-K. ${noGross.length ? `${noGross.length} monthly-sheet sale${noGross.length === 1 ? '' : 's'} had no matched eBay order, so only the payout is known for ${noGross.length === 1 ? 'it' : 'them'}. ` : ''}Share these files with your accountant.</div>
      <div class="col" style="gap:8px">
        <button class="btn" id="tax-sales">${ICONS.down} Every sale (CSV)</button>
        <button class="btn" id="tax-months">${ICONS.down} Month by month (CSV)</button>
        <button class="btn" id="tax-exp">${ICONS.down} Operating costs (CSV)</button>
      </div>`;
    box.querySelector('#tax-year').onchange = (e) => { pickedYear = e.target.value; draw(); };
    box.querySelector('#tax-sales').onclick = () => downloadCsv(`sales-${pickedYear}.csv`, rows, [
      { title: 'Date', get: (r) => r.o.created_at.slice(0, 10) }, { title: 'Month', get: (r) => r.month }, { title: 'Source', get: (r) => (r.o.source === 'ledger' ? 'monthly sheet' : 'eBay') },
      { title: 'eBay order', get: (r) => (r.o.source === 'ebay' ? r.o.order_id : r.o.ebay_order_id || '') }, { title: 'Item', get: (r) => r.o.title },
      { title: 'Gross sale', get: (r) => (r.gross === null ? '' : d2(r.gross)) }, { title: 'eBay fees', get: (r) => (r.fees === null ? '' : d2(r.fees)) }, { title: 'Refunds', get: (r) => d2(r.refunds) },
      { title: 'eBay payout', get: (r) => d2(r.payout) }, { title: 'Ad fees', get: (r) => d2(r.ads) }, { title: 'Amazon cost', get: (r) => d2(r.cogs) }, { title: 'Other costs', get: (r) => d2(r.other) }, { title: 'Profit', get: (r) => d2(r.net) },
    ]);
    box.querySelector('#tax-months').onclick = () => downloadCsv(`months-${pickedYear}.csv`, [...months.map((m) => ({ m, list: rows.filter((r) => r.month === m), opex: exp.filter((e) => e.month === m).reduce((t, e) => t + cents(e.amount), 0) })), { m: `${pickedYear} total`, list: rows, opex: T.opex }], [
      { title: 'Month', get: (x) => x.m }, { title: 'Sales', get: (x) => x.list.length }, { title: 'Gross sales', get: (x) => d2(sum(x.list, 'gross')) }, { title: 'eBay fees', get: (x) => d2(sum(x.list, 'fees')) },
      { title: 'Refunds', get: (x) => d2(sum(x.list, 'refunds')) }, { title: 'eBay payouts', get: (x) => d2(sum(x.list, 'payout')) }, { title: 'Ad fees', get: (x) => d2(sum(x.list, 'ads')) },
      { title: 'Amazon cost', get: (x) => d2(sum(x.list, 'cogs')) }, { title: 'Other costs', get: (x) => d2(sum(x.list, 'other')) }, { title: 'Operating costs', get: (x) => d2(x.opex) }, { title: 'Net business profit', get: (x) => d2(sum(x.list, 'net') - x.opex) },
    ]);
    box.querySelector('#tax-exp').onclick = () => downloadCsv(`operating-costs-${pickedYear}.csv`, exp, [
      { title: 'Month', get: (e) => e.month }, { title: 'Expense', get: (e) => e.category }, { title: 'Amount', get: (e) => Number(e.amount) }, { title: 'Note', get: (e) => e.note || '' }, { title: 'Paid by', get: (e) => (e.paid_by === 'amazon' ? d.settings.partner_amazon : d.settings.partner_ebay) },
    ]);
  };
  draw();
}
