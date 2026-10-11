// Settlement page: the monthly partner sheet, computed live from orders + operating expenses.
import { $, $$, esc, money, count, fmtDate, api, toast, downloadCsv, ICONS, countUp, settlementDueDate, settlementDueDay, dueStatus, monthLabel as mLabel, settleView, azDay } from './util.js';
import { settleMonth, allMonths, settlePeriodRange } from './settlement.js';
import { state, loadData, renderPage } from './app.js';
import { paymentWarnings, warningsText } from './health.js';
import { rowMonth, isSale } from './metrics.js';
import { mount, colors, tooltipBase, axisBase, ttRow, ttHead, shadowPointer } from './charts.js';

let selected = null;
const monthLabel = (m) => mLabel(m, 'long');
const monthShort = (m) => mLabel(m, 'short');
// "Aug 27 – Sep 26": the sale dates a payment covers
const periodText = (m, dueDay) => { const r = settlePeriodRange(m, dueDay); const f = (d) => fmtDate(new Date(`${d}T12:00:00Z`), { month: 'short', day: 'numeric', timeZone: 'UTC' }); return `${f(r.from)} – ${f(r.to)}`; };
const sumCents = (arr, f) => Math.round(arr.reduce((t, x) => t + Math.round((Number(f(x)) || 0) * 100), 0)) / 100;

// Paid / owed state for one month, in words and colour. `v` is settleView(), `due` comes from dueStatus().
function paidState(s, v, due) {
  const overdue = due.kind === 'overdue';
  const who = `${v.from} sends ${v.to}`;
  if (v.paid === null) {
    if (v.nothingDue) return { cls: '', icon: ICONS.info, t: 'Nothing to send', s: 'No amount due for this month' };
    if (overdue) return { cls: 'bad', icon: ICONS.alert, t: due.text, s: `${who} · was due ${due.label} · record the transfer below once it is sent` };
    if (due.kind === 'soon') return { cls: 'warn', icon: ICONS.clock, t: due.text, s: `${who} by ${due.label} · record the transfer below once it is sent` };
    return { cls: 'warn', icon: ICONS.clock, t: 'Not paid yet', s: `${who} by ${due.label} · record the transfer below once it is sent` };
  }
  const when = s.paidAt ? ` on ${fmtDate(s.paidAt)}` : '';
  const note = s.note ? ` · ${s.note}` : '';
  if (v.fullyPaid) return { cls: 'good', icon: ICONS.check, t: `Paid in full${when}`, s: `${money(v.paid, 2)} ${v.reverse ? `sent by ${v.from}` : 'received'}${note}` };
  if (v.outstanding > 0) return { cls: overdue ? 'bad' : 'warn', icon: ICONS.clock, t: `${money(v.outstanding, 2)} still owed${overdue ? ` · ${due.text.toLowerCase()}` : ''}`, s: `${money(v.paid, 2)} paid${when}${note} · ${v.from} still owes ${v.to} · due ${due.label}` };
  return { cls: 'info', icon: ICONS.info, t: `Overpaid by ${money(-v.outstanding, 2)}`, s: `${money(v.paid, 2)} paid by ${v.from}${when}${note}` };
}

// Due-date pill for the All-months table
function duePill(v, due) {
  if (v.fullyPaid || v.nothingDue) return `<span class="muted">${fmtDate(due.dueDate)}</span>`;
  if (due.kind === 'overdue') return `<span class="pill bad" title="${due.label}">${ICONS.alert} ${fmtDate(due.dueDate)} · ${due.text.toLowerCase()}</span>`;
  if (due.kind === 'soon') return `<span class="pill warn" title="${due.label}">${ICONS.clock} ${fmtDate(due.dueDate)} · ${due.text.toLowerCase()}</span>`;
  return `<span>${fmtDate(due.dueDate)}</span>`;
}

export function renderSettlement(el) {
  const d = state.data;
  const { expenses, settlements } = d.books;
  const A = d.settings.partner_amazon;
  const B = d.settings.partner_ebay;
  const split = Number(d.settings.split_amazon);
  const months = allMonths(d.orders, expenses);
  if (!months.length) {
    el.innerHTML = `<div class="card"><div class="empty lg"><div class="ic">${ICONS.settle}</div><div class="t">Nothing to settle yet</div><p>The monthly partner settlement is computed from counted sales and operating costs. Once either exists, the month appears here.</p><div class="actions"><a class="btn primary" href="#/import">${ICONS.sheet} Upload a monthly sheet</a><a class="btn" href="#/settings">${ICONS.settings} Connect eBay</a></div></div></div>`;
    return;
  }
  if (!selected || !months.includes(selected)) selected = months[months.length - 1];
  const all = months.map((m) => settleMonth({ month: m, orders: d.orders, expenses, settlements, splitAmazon: split }));
  const s = all.find((x) => x.month === selected);
  const view = (x) => settleView(x, A, B);
  const v = view(s);
  // Net position across every month: > 0 means B owes A, < 0 means A owes B
  const owed = sumCents(all, (x) => view(x).signedOwed);
  const approx = d.orders.some((o) => o.approx_date && o.created_at.startsWith(selected));
  const dueDay = d.settings.settlement_day ?? 26;
  const dueOf = (x) => { const dueDate = settlementDueDate(x.month, dueDay); return { dueDate, ...dueStatus(dueDate, { paid: view(x).fullyPaid }) }; };
  const due = dueOf(s);
  const st = paidState(s, v, due);
  const duePillCls = st.cls === 'bad' ? 'bad' : due.kind === 'soon' && v.paid === null ? 'warn' : st.cls === 'good' ? 'good' : 'info';
  const paidPct = v.paid !== null && v.amount > 0 ? Math.min(100, (v.paid / v.amount) * 100) : null;
  const sendsLine = `${esc(v.from)} sends ${esc(v.to)}`;
  const hasOther = all.some((x) => Math.abs(x.otherCosts) > 0.009);
  const statusPill = (x) => {
    const w = view(x);
    if (w.paid === null) return w.nothingDue ? `<span class="pill">${ICONS.minus} Nothing due</span>` : `<span class="pill warn">${ICONS.clock} Unpaid</span>`;
    if (w.fullyPaid) return `<span class="pill good">${ICONS.check} Paid</span>`;
    return w.outstanding > 0 ? `<span class="pill warn">${ICONS.clock} ${money(w.outstanding, 2)} owed</span>` : `<span class="pill info">${ICONS.info} Overpaid ${money(-w.outstanding, 2)}</span>`;
  };
  // Presentation of the selected month's state: a loud label, an icon and the day count next to the words
  const stLabel = st.cls === 'good' ? 'Settled' : st.cls === 'bad' ? 'Overdue' : st.cls === 'warn' ? (v.paid !== null ? 'Partly paid' : 'Due') : st.cls === 'info' ? 'Overpaid' : 'Nothing due';
  const stIcon = st.cls === 'good' ? ICONS.circleCheck : st.cls === 'bad' ? ICONS.alert : st.cls === 'warn' ? ICONS.clock : st.cls === 'info' ? ICONS.info : ICONS.minus;
  const stSide = (() => {
    if (v.nothingDue || v.fullyPaid || due.kind === 'paid') return '';
    const n = due.days;
    if (n < 0) return `<div class="side"><div class="big num">${-n}</div><div class="sm">${-n === 1 ? 'day' : 'days'} overdue</div></div>`;
    if (n === 0) return '<div class="side"><div class="big">Today</div><div class="sm">due date</div></div>';
    return `<div class="side"><div class="big num">${n}</div><div class="sm">${n === 1 ? 'day' : 'days'} left</div></div>`;
  })();
  const avatar = (name) => `<span class="avatar ${name === A ? '' : 'b'}" aria-hidden="true">${esc(String(name || '?').trim().charAt(0).toUpperCase())}</span>`;
  const sendsCell = (x) => { const w = view(x); return `${w.reverse ? `<span class="muted" style="font-size:11px;font-weight:500">${esc(w.from)} → ${esc(w.to)}</span> ` : ''}<b>${money(w.amount, 2)}</b>`; };
  const tot = {
    orders: all.reduce((t, x) => t + x.orders, 0), collected: sumCents(all, (x) => x.collected), cogs: sumCents(all, (x) => x.cogs), adFees: sumCents(all, (x) => x.adFees),
    other: sumCents(all, (x) => x.otherCosts), opex: sumCents(all, (x) => x.opex), profit: sumCents(all, (x) => x.businessProfit), sends: sumCents(all, (x) => x.sellerSends),
    paid: sumCents(all.filter((x) => x.paid !== null), (x) => x.paid),
  };
  const netLabel = (n) => (Math.abs(n) < 0.01 ? '<span class="pos">All settled</span>' : `<span class="neg">${n > 0 ? `${esc(B)} owes ${esc(A)}` : `${esc(A)} owes ${esc(B)}`} ${money(Math.abs(n), 2)}</span>`);

  const line = (k, v, opts = {}) => `<div class="calc-row ${opts.total ? 'total' : ''}"><span class="k">${k}</span><span class="${opts.cls || ''}">${v}</span></div>`;
  const sec = (n, title) => `<h4><span class="no">${n}</span>${title}</h4>`;
  const sumLine = `${esc(A)} pays Amazon · ${esc(B)} collects eBay and pays operating costs · profit split ${split}/${100 - split}`;

  // This month's payments (each transfer is its own entry) and whether the payment is closed
  const payments = (d.books.payments || []).filter((p) => p.month === selected);
  const closedRec = (d.books.closed || []).find((c) => c.month === selected);

  // Heads-up for returns still open: eBay holds the money but hasn't refunded, so nothing has moved yet. A refund
  // comes off the payment for the day it happens; the Amazon partner's share of the profit is what changes hands.
  const openReturns = d.orders.filter((o) => o.counted && o.return_open);
  const returnsNote = openReturns.length ? `<div class="banner" style="margin-bottom:16px">${ICONS.clock}<div><b>${openReturns.length === 1 ? '1 return is open' : `${openReturns.length} returns are open`}, not refunded yet.</b> ${openReturns.map((o) => {
    const r = o.return_open;
    return `<span class="muted">${esc(o.title.slice(0, 48))}: ${money(r.amount, 2)} on hold since ${fmtDate(r.since)}. If refunded, about ${money(r.profit_hit, 2)} comes off the profit, so ${esc(B)} sends about ${money(Math.round(r.profit_hit * split) / 100, 2)} less, on the payment for the day of the refund.</span>`;
  }).join(' ')}</div></div>` : '';

  // Before a payment is recorded: anything that could still change this payment (sales waiting for a cost, fresh sales
  // that may still get an ad fee, a sync that failed or is behind, the period not being over). Shown while the payment
  // is still open, and asked again when a payment is added. Open returns have their own note above.
  const warnings = () => paymentWarnings({ month: selected, orders: d.orders, ebay: d.ebay, email: d.email, dueDay });
  const pending = !v.fullyPaid && !v.nothingDue ? warnings().filter((w) => w.key !== 'returns') : [];
  const pendingNote = pending.length ? `<div class="banner ${pending.some((w) => w.key === 'sync' || w.key === 'waiting') ? 'bad' : ''}" style="margin-bottom:16px" role="status">${ICONS.alert}<div><b>The ${esc(monthLabel(selected))} payment may not be final yet.</b><ul class="check-list">${pending.map((w) => `<li>${esc(w.title)}${w.items.length ? `<span class="muted">: ${w.items.slice(0, 3).map(esc).join(' · ')}${w.items.length > 3 ? ` · and ${w.items.length - 3} more` : ''}</span>` : ''}</li>`).join('')}</ul></div></div>` : '';
  // Asked before any payment is saved; false means the person chose to wait
  const confirmComplete = (what) => {
    const list = warnings();
    if (!list.length) return true;
    return confirm(`Before you record ${what} for the ${monthLabel(selected)} payment:\n\n${warningsText(list)}\n\nAnything still to come goes on the next payment once this one is recorded. Record it now anyway?`);
  };

  // Sales on this payment; a refund line (a refund of an earlier sale) is money on it, not a sale
  const onIt = d.orders.filter((o) => o.counted && rowMonth(o) === selected);
  const soldN = onIt.filter(isSale).length;
  const soldText = soldN === onIt.length ? count(soldN) : `${count(soldN)} <span class="muted">+ ${count(onIt.length - soldN)} refund line${onIt.length - soldN === 1 ? '' : 's'}</span>`;

  el.innerHTML = `
  <div class="row" style="margin-bottom:16px;gap:12px">
    <div class="seg" id="st-months" role="tablist" aria-label="Month">${months.map((m) => `<button data-m="${m}" class="${m === selected ? 'on' : ''}" role="tab" aria-selected="${m === selected}">${monthShort(m)}</button>`).join('')}</div>
    <span class="muted" style="font-size:12.5px;margin-left:auto">${sumLine}</span>
  </div>
  ${pendingNote}
  ${returnsNote}

  <div class="grid g-12">
    <div class="card settle-card c-5">
      <div class="settle-head">
        <span class="eyebrow" title="Sales from ${esc(periodText(selected, dueDay))} are in this payment">${ICONS.wallet} ${monthLabel(selected)} settlement · <span class="muted">${esc(periodText(selected, dueDay))}</span></span>
        <span class="pill ${duePillCls}" title="Settlements are due on the ${dueDay}th of each month">${ICONS.calendar} ${due.kind === 'paid' ? due.text : due.kind === 'later' || v.paid !== null ? `Due ${due.label}` : `${due.text} · ${due.label}`}</span>
      </div>
      <div class="settle-who">${avatar(v.from)}<b>${esc(v.from)}</b><span class="muted">sends</span>${ICONS.arrowRight.replace('<svg', '<svg class="arrow"')}${avatar(v.to)}<b>${esc(v.to)}</b></div>
      <div class="settle-amt num" id="st-value">${money(v.amount, 2)}</div>
      <div class="settle-math">
        <span>Reimbursement <b>${money(s.cogs + s.opexAmazon, 2)}</b></span>
        <span>${s.shareAmazon < 0 ? '−' : '+'} ${esc(A)}'s ${split}% share <b>${money(Math.abs(s.shareAmazon), 2)}</b></span>
      </div>
      ${v.reverse ? `<div class="settle-hint">${esc(A)}'s share of this month's loss is bigger than ${esc(A)}'s reimbursement, so ${esc(A)} pays ${esc(B)} the difference.</div>` : ''}
      <div class="state ${st.cls}" role="status"><div class="ic">${stIcon}</div><div><div class="lbl"><span class="live"></span>${stLabel}</div><div class="t">${st.t}</div><div class="s">${esc(st.s)}</div></div>${stSide}</div>
      ${paidPct !== null ? `<div class="paid-bar ${v.outstanding < -0.009 ? 'over' : ''}" title="${paidPct.toFixed(0)}% of the amount due"><div style="width:${paidPct.toFixed(1)}%"></div></div>` : ''}
      <div class="settle-sec" style="margin-top:20px">
        <div class="row" style="justify-content:space-between;gap:8px"><h4 style="margin:0">Payments</h4>${closedRec ? `<span class="pill good" title="Recorded what this payment covered on ${esc(fmtDate(closedRec.frozen_at))}. Anything that turns up later for this period (a late refund, a sale costed later) goes on the next payment, so this one never changes.">${ICONS.check} Closed</span>` : ''}</div>
        ${payments.length ? `<ul class="pay-list">${payments.map((p) => `<li><span class="num"><b>${money(Math.abs(p.amount), 2)}</b>${p.amount < 0 ? ' <span class="muted">(correction)</span>' : ''}</span><span class="muted">${p.paid_at ? esc(fmtDate(p.paid_at, { month: 'short', day: 'numeric', year: 'numeric' })) : 'date not recorded'}${p.note ? ` · ${esc(p.note)}` : ''}</span><button class="btn sm ghost pay-del" data-id="${p.id}" title="Remove this payment (entered by mistake)" aria-label="Remove payment">${ICONS.x}</button></li>`).join('')}</ul>` : `<div class="muted" style="font-size:13px;margin-top:6px">No payment recorded yet.</div>`}
        <form class="pay-form" id="pay-form" style="margin-top:10px">
          <label class="field">Amount ${esc(v.from)} sent ${esc(v.to)}<input class="input num" name="amount" type="number" step="0.01" inputmode="decimal" placeholder="0.00" required /></label>
          <label class="field">Date<input class="input" name="paid_at" type="date" value="${azDay()}" max="${azDay()}" required /></label>
          <label class="field full">Note<input class="input" name="note" placeholder="e.g. Zelle, the fishing line he missed" /></label>
          <div class="actions"><button class="btn primary" type="submit">${ICONS.save} Add payment</button>${Math.abs(v.outstanding ?? v.amount) >= 0.01 && !(v.paid !== null && v.outstanding < 0) ? `<button class="btn" type="button" id="pay-full" title="Records exactly what's left, worked out on the server from the latest numbers">${ICONS.check} Pay the remaining ${money(Math.abs(v.paid === null ? v.amount : v.outstanding), 2)}</button>` : ''}</div>
          <div class="muted" style="font-size:11.5px;margin-top:6px">Each transfer is its own payment, so a later one (like a missed sale) never overwrites the first. A mistake can be removed, or corrected with a negative amount.</div>
        </form>
      </div>
    </div>

    <div class="card c-7"><div class="card-h"><div><h3>${monthLabel(selected)} settlement</h3><div class="sub">Same sections as the monthly sheet${approx ? ' · sheet rows have approximate dates within the month' : ''}</div></div><div class="right"><a class="btn sm" href="#/costs">Edit expenses</a></div></div>
      <div class="card-b settle-grid">
        <div>
          <div class="settle-sec">${sec(1, 'Transactions')}
            ${line('Items sold', soldText)}
            ${line(`eBay payouts (collected by ${esc(B)})`, money(s.collected, 2))}
            ${line(`Amazon COGS (paid by ${esc(A)})`, `−${money(s.cogs, 2)}`)}
            ${line('eBay ad fees', `−${money(s.adFees, 2)}`)}
            ${s.otherCosts ? line('Other per-order costs', `−${money(s.otherCosts, 2)}`) : ''}
            ${line('Net item profit', money(s.orderProfit, 2), { total: true, cls: s.orderProfit < 0 ? 'neg' : '' })}
          </div>
          <div class="settle-sec">${sec(2, 'Operating costs')}
            ${s.expenses.length ? s.expenses.map((e) => line(`${esc(e.category)}${e.note ? ` <span class="muted" style="font-size:11.5px">${esc(e.note)}</span>` : ''}${e.paid_by === 'amazon' ? ` <span class="pill">${ICONS.wallet} ${esc(A)} paid</span>` : ''}`, money(e.amount, 2))).join('') : '<div class="muted" style="font-size:13px;padding:6px 0">None entered</div>'}
            ${line('Total operating expenses', money(s.opex, 2), { total: true })}
          </div>
        </div>
        <div>
          <div class="settle-sec">${sec(3, 'Monthly summary')}
            ${line('Gross revenue (eBay payouts)', money(s.collected, 2))}
            ${line('Amazon COGS', `−${money(s.cogs, 2)}`)}
            ${line('eBay fees (ads)', `−${money(s.adFees, 2)}`)}
            ${line('Operating expenses', `−${money(s.opex, 2)}`)}
            ${line('Net business profit', money(s.businessProfit, 2), { total: true, cls: s.businessProfit < 0 ? 'neg' : 'pos' })}
          </div>
          <div class="settle-sec">${sec(4, 'Partner settlement')}
            ${line(`${esc(A)}'s reimbursement (Amazon COGS${s.opexAmazon ? ' + expenses' : ''})`, money(s.cogs + s.opexAmazon, 2))}
            ${line(`${esc(A)}'s ${split}% profit share`, money(s.shareAmazon, 2), { cls: s.shareAmazon < 0 ? 'neg' : '' })}
            ${line(`${esc(B)}'s ${100 - split}% profit share`, money(s.shareSeller, 2), { cls: s.shareSeller < 0 ? 'neg' : '' })}
            ${line(`${ICONS.arrow.replace('<svg', '<svg style="width:14px;height:14px;color:var(--accent)"')} ${sendsLine}`, money(v.amount, 2), { total: true })}
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="grid g-12 mt">
    <div class="card c-5"><div class="card-h"><div><h3>Business profit by month</h3><div class="sub">After operating expenses</div></div></div><div class="card-b"><div class="chart" id="ch-bp"></div></div></div>
    <div class="card c-7"><div class="card-h"><div><h3>All months</h3><div class="sub">${owed > 0.009 ? `<b class="neg">${money(owed, 2)}</b> still owed to ${esc(A)} across all months` : owed < -0.009 ? `<b class="neg">${money(-owed, 2)}</b> still owed to ${esc(B)} across all months` : `<span class="pos">Everything is settled</span> · click a month to open it`} · payouts − COGS − ad fees${hasOther ? ' − other' : ''} − expenses = profit</div></div><div class="right"><button class="btn sm" id="st-dl">${ICONS.down} Export CSV</button></div></div>
      <div class="card-b table-wrap"><table class="simple settle-table"><thead><tr><th>Month</th><th class="r">Items</th><th class="r">Payouts</th><th class="r">COGS</th><th class="r">Ad fees</th>${hasOther ? '<th class="r">Other</th>' : ''}<th class="r">Expenses</th><th class="r">Profit</th><th class="r">Transfer</th><th>Due</th><th class="r">Paid</th><th class="r">Status</th></tr></thead><tbody>
      ${[...all].reverse().map((x) => `<tr data-m="${x.month}" class="${x.month === selected ? 'sel' : ''}" style="cursor:pointer"><td style="white-space:nowrap"><b>${monthShort(x.month)}</b></td><td class="r">${count(x.orders)}</td><td class="r">${money(x.collected, 2)}</td><td class="r">${money(x.cogs, 2)}</td><td class="r">${money(x.adFees, 2)}</td>${hasOther ? `<td class="r">${money(x.otherCosts, 2)}</td>` : ''}<td class="r">${money(x.opex, 2)}</td><td class="r ${x.businessProfit < 0 ? 'neg' : ''}">${money(x.businessProfit, 2)}</td><td class="r" style="white-space:nowrap">${sendsCell(x)}</td><td style="white-space:nowrap">${duePill(view(x), dueOf(x))}</td><td class="r">${x.paid === null ? '<span class="muted">—</span>' : money(Math.abs(x.paid), 2)}</td><td class="r">${statusPill(x)}</td></tr>`).join('')}
      </tbody><tfoot><tr class="total"><td><b>Total</b></td><td class="r">${count(tot.orders)}</td><td class="r">${money(tot.collected, 2)}</td><td class="r">${money(tot.cogs, 2)}</td><td class="r">${money(tot.adFees, 2)}</td>${hasOther ? `<td class="r">${money(tot.other, 2)}</td>` : ''}<td class="r">${money(tot.opex, 2)}</td><td class="r ${tot.profit < 0 ? 'neg' : ''}"><b>${money(tot.profit, 2)}</b></td><td class="r" style="white-space:nowrap" title="Net of every month's transfer">${tot.sends < -0.009 ? `<span class="muted" style="font-size:11px;font-weight:500">${esc(A)} → ${esc(B)}</span> ` : ''}<b>${money(Math.abs(tot.sends), 2)}</b></td><td></td><td class="r">${money(Math.abs(tot.paid), 2)}</td><td class="r" style="white-space:nowrap">${netLabel(owed)}</td></tr></tfoot></table></div></div>
  </div>`;

  countUp($('#st-value'), v.amount, (n) => money(n, 2), 800);

  $('#st-months').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { selected = b.dataset.m; renderPage(); } });
  $$('tr[data-m]', el).forEach((tr) => tr.addEventListener('click', () => { selected = tr.dataset.m; renderPage(); window.scrollTo({ top: 0, behavior: 'smooth' }); }));
  const done = async (msg) => { toast(msg, 'good'); await loadData(); renderPage(); };
  $('#pay-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const raw = Number(String(f.get('amount') ?? '').trim());
    if (!Number.isFinite(raw) || Math.abs(raw) < 0.01) { toast('Enter the amount that was sent', 'bad'); return; }
    // A transfer in the reverse direction (A → B) is stored as a negative payment so balance = sends − paid holds;
    // a negative entry the other way is a correction
    const amount = v.reverse ? -raw : raw;
    const paidAt = String(f.get('paid_at') || '');
    if (paidAt > azDay()) { toast('The payment date can’t be in the future (Arizona time)', 'bad'); return; }
    if (!confirmComplete(`${money(raw, 2)}`)) return;
    try {
      await api('/api/settlements/payments', { method: 'POST', body: { month: selected, amount, paid_at: paidAt, note: f.get('note') } });
      await done('Payment added');
    } catch (err) { toast(err.message, 'bad'); }
  });
  $('#pay-full')?.addEventListener('click', async () => {
    if (!confirmComplete('the remaining amount')) return;
    try {
      // The server works out what's left from fresh numbers; `expected` is what this page showed, so a server that
      // checks it can refuse when the page was out of date
      const expected = Math.abs(v.paid === null ? v.amount : v.outstanding);
      const r = await api('/api/settlements/pay-remaining', { method: 'POST', body: { month: selected, note: $('#pay-form [name=note]').value || undefined, expected } });
      const shown = Math.round(expected * 100);
      const got = Math.round(Math.abs(Number(r.amount) || 0) * 100);
      await done(r.nothing ? 'Nothing left to pay' : `Recorded ${money(Math.abs(r.amount), 2)}${got !== shown ? ` (the latest numbers, not the ${money(expected, 2)} this page showed)` : ''}`);
    } catch (err) { toast(err.message, 'bad'); }
  });
  $$('.pay-del', el).forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Remove this payment? Use this only for an entry made by mistake.')) return;
    try { await api(`/api/settlements/payments/${b.dataset.id}`, { method: 'DELETE' }); await done('Payment removed'); } catch (err) { toast(err.message, 'bad'); }
  }));
  $('#st-dl').onclick = () => downloadCsv('settlements.csv', all, [
    { title: 'Month', get: (x) => x.month }, { title: 'Items', get: (x) => x.orders }, { title: 'eBay payouts', get: (x) => x.collected },
    { title: 'Amazon COGS', get: (x) => x.cogs }, { title: 'Ad fees', get: (x) => x.adFees }, { title: 'Operating expenses', get: (x) => x.opex },
    { title: 'Net business profit', get: (x) => x.businessProfit }, { title: `${A} share`, get: (x) => x.shareAmazon }, { title: `${B} share`, get: (x) => x.shareSeller },
    { title: `${B} sends ${A}`, get: (x) => x.sellerSends }, { title: 'Due', get: (x) => settlementDueDay(x.month, dueDay) }, { title: 'Paid', get: (x) => x.paid ?? '' }, { title: 'Owed', get: (x) => x.balance },
  ]);

  const c = colors();
  mount($('#ch-bp'), {
    grid: { left: 8, right: 12, top: 24, bottom: 4, containLabel: true },
    tooltip: { ...tooltipBase(), trigger: 'axis', axisPointer: shadowPointer(),
      formatter: (ps) => { const x = all[ps[0].dataIndex]; return ttHead(monthLabel(x.month)) + ttRow(c.profit, 'Net item profit', money(x.orderProfit, 2)) + ttRow(c.ops, 'Operating expenses', `−${money(x.opex, 2)}`) + ttRow(x.businessProfit < 0 ? c.bad : c.profit, 'Business profit', money(x.businessProfit, 2), true); } },
    xAxis: { type: 'category', data: all.map((x) => monthShort(x.month)), ...axisBase({ splitLine: { show: false } }) },
    yAxis: { type: 'value', ...axisBase(), axisLine: { show: false }, axisLabel: { ...axisBase().axisLabel, formatter: (v) => money(v, 0) } },
    series: [{ type: 'bar', barWidth: '42%', data: all.map((x) => ({ value: x.businessProfit, itemStyle: { color: x.businessProfit < 0 ? c.bad : c.profit, borderRadius: x.businessProfit < 0 ? [0, 0, 5, 5] : [5, 5, 0, 0] } })),
      label: { show: true, position: 'top', color: c.ink2, fontSize: 11, formatter: (p) => money(p.value, 0) } }],
  });
}
