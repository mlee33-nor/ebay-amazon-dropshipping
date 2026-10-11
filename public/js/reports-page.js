// Reports: the settlement statement for one payment (itemized, printable, copyable for a text message) and the
// year-end export for taxes. Every figure comes from settleMonth(), the same math as the Settlement page; the
// statement lists exactly the lines that payment is made of and shows whether they add up to it to the cent.
import { $, esc, money, count, fmtDate, toast, downloadCsv, ICONS, settlementDueDate, dueStatus, monthLabel, settleView, azDay } from './util.js';
import { allMonths, settlePeriodRange, CYCLE_START } from './settlement.js';
import { statementFor as statementOf, taxRows, taxTotals, isSheetRefundFee } from './report-math.js';
import { state } from './app.js';

const d2 = (c) => c / 100;
let pickedMonth = null;
let pickedYear = null;

export const statementFor = (month) => statementOf(state.data, month);

// "Sep 27 – Oct 26, 2026": the sale dates a payment covers
const periodText = (m, dueDay) => {
  const r = settlePeriodRange(m, dueDay);
  return `${fmtDate(r.from)} – ${fmtDate(r.to, { month: 'short', day: 'numeric', year: 'numeric' })}`;
};

export function renderReports(el) {
  const d = state.data;
  const A = d.settings.partner_amazon;
  const B = d.settings.partner_ebay;
  const split = Number(d.settings.split_amazon);
  const dueDay = d.settings.settlement_day ?? 26;
  const months = allMonths(d.orders, d.books.expenses);
  if (!months.length) { el.innerHTML = `<div class="card"><div class="empty lg"><div class="ic">${ICONS.receipt}</div><div class="t">No months to report yet</div></div></div>`; return; }
  if (!pickedMonth || !months.includes(pickedMonth)) pickedMonth = months[months.length - 1];
  const years = [...new Set(d.orders.filter((o) => o.counted && o.business_month).map((o) => o.business_month.slice(0, 4)).concat(months.map((m) => m.slice(0, 4))))].sort();
  if (!pickedYear || !years.includes(pickedYear)) pickedYear = years[years.length - 1];

  const { s, lines, tot, matches, sales, refundLines } = statementFor(pickedMonth);
  const v = settleView(s, A, B);
  const dueDate = settlementDueDate(pickedMonth, dueDay);
  const due = dueStatus(dueDate, { paid: v.fullyPaid });
  const covers = pickedMonth >= CYCLE_START ? `Sales ${periodText(pickedMonth, dueDay)} (Arizona time)` : `Sales in ${monthLabel(pickedMonth, 'long')}`;
  const paidLine = v.paid === null ? `<span class="neg">Not paid yet</span> · due ${fmtDate(dueDate, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}${due.kind === 'overdue' ? ` · <b class="neg">${esc(due.text.toLowerCase())}</b>` : ''}`
    : v.fullyPaid ? `<span class="pos">Paid in full</span>${s.paidAt ? ` on ${fmtDate(s.paidAt)}` : ''}${s.note ? ` · ${esc(s.note)}` : ''}`
    : `${money(v.paid, 2)} paid · <b class="neg">${money(v.outstanding, 2)} still owed</b> · due ${fmtDate(dueDate)}`;
  const row = (k, val, cls = '') => `<div class="st-row ${cls}"><span>${k}</span><span class="num">${val}</span></div>`;
  const salesWord = `${count(sales)} sale${sales === 1 ? '' : 's'}${refundLines ? ` + ${count(refundLines)} refund line${refundLines === 1 ? '' : 's'}` : ''}`;

  el.innerHTML = `
  <div class="grid g-12">
    <div class="c-8">
      <div class="row no-print" style="gap:10px;margin-bottom:12px;flex-wrap:wrap">
        <select class="select" id="rp-month" aria-label="Statement payment">${[...months].reverse().map((m) => `<option value="${m}" ${m === pickedMonth ? 'selected' : ''}>${monthLabel(m, 'long')} payment</option>`).join('')}</select>
        <button class="btn primary" id="rp-print">${ICONS.down} Print / save PDF</button>
        <button class="btn" id="rp-copy">${ICONS.copy} Copy summary</button>
        <button class="btn" id="rp-csv">${ICONS.sheet} Itemized CSV</button>
      </div>
      <div class="card statement" id="statement">
        <div class="st-head">
          <div><div class="st-brand">Dropship Ledger</div><h2>${monthLabel(pickedMonth, 'long')} settlement statement</h2><div class="muted">${esc(covers)}</div><div class="muted">${esc(B)} → ${esc(A)} · profit split ${split}/${100 - split}</div></div>
          <div class="st-amt"><div class="muted">${esc(v.from)} sends ${esc(v.to)}</div><div class="big num">${money(v.amount, 2)}</div><div class="st-paid">${paidLine}</div></div>
        </div>
        <div class="st-grid">
          <div>
            <h4>Summary</h4>
            ${row('Sales counted', salesWord)}
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
        <h4>Lines on this payment (${count(lines.length)})</h4>
        <div class="table-wrap"><table class="simple st-table"><thead><tr><th>Date</th><th>Item</th><th class="r">Payout</th><th class="r">Amazon</th><th class="r">Ads</th><th class="r">Profit</th></tr></thead><tbody>
          ${lines.map((l) => `<tr><td style="white-space:nowrap">${fmtDate(l.o.created_at)}${l.o.approx_date ? '<span class="muted">*</span>' : ''}</td><td>${esc(l.o.title.slice(0, 70))}</td><td class="r num">${money(d2(l.payout), 2)}</td><td class="r num">${money(d2(l.cogs), 2)}</td><td class="r num">${l.ads ? money(d2(l.ads), 2) : '—'}</td><td class="r num ${l.net < 0 ? 'neg' : ''}">${money(d2(l.net), 2)}</td></tr>`).join('')}
        </tbody><tfoot><tr class="total"><td></td><td><b>Total</b></td><td class="r num"><b>${money(d2(tot.payout), 2)}</b></td><td class="r num"><b>${money(d2(tot.cogs), 2)}</b></td><td class="r num"><b>${money(d2(tot.ads), 2)}</b></td><td class="r num"><b>${money(d2(tot.net), 2)}</b></td></tr></tfoot></table></div>
        ${lines.some((l) => l.o.approx_date) ? '<div class="muted" style="font-size:11.5px;margin-top:6px">* date within the month from the monthly sheet</div>' : ''}
        ${refundLines ? '<div class="muted" style="font-size:11.5px;margin-top:6px">“Refund ·” lines are refunds of earlier sales, booked on this payment because they happened in its period or after an earlier payment was made.</div>' : ''}
        <div class="st-foot muted">Generated ${fmtDate(new Date(), { month: 'short', day: 'numeric', year: 'numeric' })} · each payment is due on the ${dueDay}th (Arizona time)</div>
      </div>
    </div>

    <div class="c-4 no-print">
      <div class="card">
        <div class="card-h"><div><h3>Year-end export for taxes</h3><div class="sub">Every counted sale by the calendar month it happened, month totals and operating costs</div></div></div>
        <div class="card-b" id="tax-box"></div>
      </div>
    </div>
  </div>`;

  // ---- statement actions
  $('#rp-month').onchange = (e) => { pickedMonth = e.target.value; renderReports(el); };
  $('#rp-print').onclick = () => window.print();
  $('#rp-copy').onclick = async () => {
    const text = [
      `${monthLabel(pickedMonth, 'long')} settlement${pickedMonth >= CYCLE_START ? ` (${periodText(pickedMonth, dueDay)})` : ''}`,
      `Sales: ${salesWord} · eBay payouts ${money(s.collected, 2)}`,
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
    { title: 'Date', get: (l) => azDay(l.o.created_at) }, { title: 'Item', get: (l) => l.o.title },
    { title: 'eBay order', get: (l) => (l.o.source === 'refund' ? l.o.refund_of : l.o.ebay_order_id || (l.o.source === 'ebay' ? l.o.order_id : '')) },
    { title: 'Line', get: (l) => (l.o.source === 'refund' ? 'refund of an earlier sale' : l.o.ledger?.is_refund ? 'sheet refund' : 'sale') },
    { title: 'eBay payout', get: (l) => d2(l.payout) }, { title: 'Amazon cost', get: (l) => d2(l.cogs) }, { title: 'Ad fees', get: (l) => d2(l.ads) }, { title: 'Other costs', get: (l) => d2(l.other) }, { title: 'Profit', get: (l) => d2(l.net) },
  ]);

  renderTax($('#tax-box'), years);
}

// ---------------------------------------------------------------- taxes
// The tax year goes by the calendar month each sale or refund happened (Arizona time), not by the payment it is on.
function renderTax(box, years) {
  const d = state.data;
  const draw = () => {
    const rows = taxRows(d.orders, pickedYear);
    const months = [...new Set(rows.map((r) => r.month))].sort();
    const exp = d.books.expenses.filter((e) => e.month.startsWith(pickedYear));
    const sum = (list, k) => list.reduce((t, r) => t + (r[k] || 0), 0);
    const T = { ...taxTotals(rows), opex: exp.reduce((t, e) => t + Math.round((Number(e.amount) || 0) * 100), 0) };
    const line = (k, v, cls = '') => `<div class="stat-row ${cls}"><span class="k">${k}</span><span class="v num">${v}</span></div>`;
    box.innerHTML = `
      <select class="select" id="tax-year" aria-label="Tax year" style="margin-bottom:12px">${years.map((y) => `<option ${y === pickedYear ? 'selected' : ''}>${y}</option>`).join('')}</select>
      ${line('Sales counted', count(T.sales))}
      ${line('Gross sales (buyers paid, excl. tax)', money(d2(T.gross), 2))}
      ${line('eBay fees (net of fees given back on refunds)', `−${money(d2(T.fees), 2)}`)}
      ${line('Refunds to buyers', `−${money(d2(T.refunds), 2)}`)}
      ${T.noGross ? line('Payout-only sheet sales (no gross on record)', money(d2(T.noGrossPayout), 2)) : ''}
      ${line('eBay payouts', money(d2(T.payout), 2), 'strong')}
      ${line('Amazon cost of goods', `−${money(d2(T.cogs), 2)}`)}
      ${line('Ad fees', `−${money(d2(T.ads), 2)}`)}
      ${T.other ? line('Other per-order costs', `−${money(d2(T.other), 2)}`) : ''}
      ${line('Operating costs', `−${money(d2(T.opex), 2)}`)}
      ${line('Net business profit', money(d2(T.net - T.opex), 2), 'strong')}
      <div class="muted" style="font-size:11.5px;margin:10px 0">Compare “Gross sales” with eBay’s 1099-K. ${T.noGross ? `${T.noGross} monthly-sheet sale${T.noGross === 1 ? '' : 's'} had no matched eBay order, so only the payout is known for ${T.noGross === 1 ? 'it' : 'them'}. ` : ''}Share these files with your accountant.</div>
      <div class="col" style="gap:8px">
        <button class="btn" id="tax-sales">${ICONS.down} Every sale (CSV)</button>
        <button class="btn" id="tax-months">${ICONS.down} Month by month (CSV)</button>
        <button class="btn" id="tax-exp">${ICONS.down} Operating costs (CSV)</button>
      </div>`;
    box.querySelector('#tax-year').onchange = (e) => { pickedYear = e.target.value; draw(); };
    box.querySelector('#tax-sales').onclick = () => downloadCsv(`sales-${pickedYear}.csv`, rows, [
      { title: 'Date', get: (r) => azDay(r.o.created_at) }, { title: 'Month', get: (r) => r.month },
      { title: 'Source', get: (r) => (r.o.source === 'refund' ? 'refund of an earlier sale' : r.o.source === 'ledger' ? (isSheetRefundFee(r.o) ? 'eBay refund fee (monthly sheet)' : 'monthly sheet') : 'eBay') },
      { title: 'eBay order', get: (r) => (r.o.source === 'ebay' ? r.o.order_id : r.o.source === 'refund' ? r.o.refund_of : r.o.ebay_order_id || '') }, { title: 'Item', get: (r) => r.o.title },
      { title: 'Gross sale', get: (r) => (r.gross === null ? '' : d2(r.gross)) }, { title: 'eBay fees', get: (r) => (r.fees === null ? '' : d2(r.fees)) }, { title: 'Refunds', get: (r) => d2(r.refunds) },
      { title: 'eBay payout', get: (r) => d2(r.payout) }, { title: 'Ad fees', get: (r) => d2(r.ads) }, { title: 'Amazon cost', get: (r) => d2(r.cogs) }, { title: 'Other costs', get: (r) => d2(r.other) }, { title: 'Profit', get: (r) => d2(r.net) },
    ]);
    box.querySelector('#tax-months').onclick = () => downloadCsv(`months-${pickedYear}.csv`, [...months.map((m) => ({ m, list: rows.filter((r) => r.month === m), opex: exp.filter((e) => e.month === m).reduce((t, e) => t + Math.round((Number(e.amount) || 0) * 100), 0) })), { m: `${pickedYear} total`, list: rows, opex: T.opex }], [
      { title: 'Month', get: (x) => x.m }, { title: 'Sales', get: (x) => x.list.filter((r) => r.sale).length }, { title: 'Gross sales', get: (x) => d2(sum(x.list, 'gross')) }, { title: 'eBay fees', get: (x) => d2(sum(x.list, 'fees')) },
      { title: 'Refunds', get: (x) => d2(sum(x.list, 'refunds')) }, { title: 'eBay payouts', get: (x) => d2(sum(x.list, 'payout')) }, { title: 'Ad fees', get: (x) => d2(sum(x.list, 'ads')) },
      { title: 'Amazon cost', get: (x) => d2(sum(x.list, 'cogs')) }, { title: 'Other costs', get: (x) => d2(sum(x.list, 'other')) }, { title: 'Operating costs', get: (x) => d2(x.opex) }, { title: 'Net business profit', get: (x) => d2(sum(x.list, 'net') - x.opex) },
    ]);
    box.querySelector('#tax-exp').onclick = () => downloadCsv(`operating-costs-${pickedYear}.csv`, exp, [
      { title: 'Month', get: (e) => e.month }, { title: 'Expense', get: (e) => e.category }, { title: 'Amount', get: (e) => Number(e.amount) }, { title: 'Note', get: (e) => e.note || '' }, { title: 'Paid by', get: (e) => (e.paid_by === 'amazon' ? d.settings.partner_amazon : d.settings.partner_ebay) },
    ]);
  };
  draw();
}
