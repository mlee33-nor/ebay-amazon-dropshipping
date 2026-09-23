// Settlement page: the monthly partner sheet, computed live from orders + operating expenses.
import { $, $$, esc, money, count, fmtDate, api, toast, downloadCsv, ICONS, countUp, settlementDueDate, dueStatus } from './util.js';
import { settleMonth, allMonths } from './settlement.js';
import { state, loadData, renderPage } from './app.js';
import { mount, colors, tooltipBase, axisBase, ttRow, ttHead, shadowPointer } from './charts.js';

let selected = null;
const monthLabel = (m) => { const [y, mo] = m.split('-').map(Number); return new Date(y, mo - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }); };
const monthShort = (m) => { const [y, mo] = m.split('-').map(Number); return new Date(y, mo - 1, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' }); };

// Paid / owed state for one month, in words and colour. `due` comes from dueStatus() for that month.
function paidState(s, due) {
  const overdue = due.kind === 'overdue';
  if (s.paid === null) {
    if (s.sellerSends <= 0.009) return { cls: '', icon: ICONS.info, t: 'Nothing to send', s: 'No amount due for this month' };
    if (overdue) return { cls: 'bad', icon: ICONS.alert, t: due.text, s: `Was due ${due.label} · record the transfer below once it is sent` };
    if (due.kind === 'soon') return { cls: 'warn', icon: ICONS.clock, t: due.text, s: `Due ${due.label} · record the transfer below once it is sent` };
    return { cls: 'warn', icon: ICONS.clock, t: 'Not paid yet', s: `Due ${due.label} · record the transfer below once it is sent` };
  }
  const when = s.paidAt ? ` on ${fmtDate(`${s.paidAt}T12:00`)}` : '';
  if (Math.abs(s.balance) < 0.01) return { cls: 'good', icon: ICONS.check, t: `Paid in full${when}`, s: `${money(s.paid, 2)} received${s.note ? ` · ${s.note}` : ''}` };
  if (s.balance > 0) return { cls: overdue ? 'bad' : 'warn', icon: ICONS.clock, t: `${money(s.balance, 2)} still owed${overdue ? ` · ${due.text.toLowerCase()}` : ''}`, s: `${money(s.paid, 2)} paid${when}${s.note ? ` · ${s.note}` : ''} · due ${due.label}` };
  return { cls: 'info', icon: ICONS.info, t: `Overpaid by ${money(-s.balance, 2)}`, s: `${money(s.paid, 2)} paid${when}${s.note ? ` · ${s.note}` : ''}` };
}

// Due-date pill for the All-months table
function duePill(x, due) {
  const paid = x.paid !== null && Math.abs(x.balance) < 0.01;
  if (paid || x.sellerSends <= 0.009) return `<span class="muted">${fmtDate(due.dueDate)}</span>`;
  if (due.kind === 'overdue') return `<span class="pill bad" title="${due.label}">${fmtDate(due.dueDate)} · ${due.text.toLowerCase()}</span>`;
  if (due.kind === 'soon') return `<span class="pill warn" title="${due.label}">${fmtDate(due.dueDate)} · ${due.text.toLowerCase()}</span>`;
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
    el.innerHTML = `<div class="card"><div class="empty"><div class="ic">${ICONS.settle}</div><div class="t">Nothing to settle yet</div>Upload a <a href="#/import">monthly sheet</a> or connect eBay first.</div></div>`;
    return;
  }
  if (!selected || !months.includes(selected)) selected = months[months.length - 1];
  const all = months.map((m) => settleMonth({ month: m, orders: d.orders, expenses, settlements, splitAmazon: split }));
  const s = all.find((x) => x.month === selected);
  const owed = all.reduce((t, x) => t + x.balance, 0);
  const approx = d.orders.some((o) => o.approx_date && o.created_at.startsWith(selected));
  const dueDay = d.settings.settlement_day ?? 26;
  const dueOf = (x) => { const dueDate = settlementDueDate(x.month, dueDay); return { dueDate, ...dueStatus(dueDate, { paid: x.paid !== null && Math.abs(x.balance) < 0.01 }) }; };
  const due = dueOf(s);
  const st = paidState(s, due);
  const duePillCls = st.cls === 'bad' ? 'bad' : due.kind === 'soon' && s.paid === null ? 'warn' : st.cls === 'good' ? 'good' : 'info';
  const paidPct = s.paid !== null && s.sellerSends > 0 ? Math.min(100, (s.paid / s.sellerSends) * 100) : null;

  const line = (k, v, opts = {}) => `<div class="calc-row ${opts.total ? 'total' : ''}"><span class="k">${k}</span><span class="${opts.cls || ''}">${v}</span></div>`;
  const sec = (n, title) => `<h4><span class="no">${n}</span>${title}</h4>`;
  const sumLine = `${esc(A)} pays Amazon · ${esc(B)} collects eBay and pays operating costs · profit split ${split}/${100 - split}`;

  el.innerHTML = `
  <div class="row" style="margin-bottom:16px;gap:12px">
    <div class="seg" id="st-months" role="tablist" aria-label="Month">${months.map((m) => `<button data-m="${m}" class="${m === selected ? 'on' : ''}" role="tab" aria-selected="${m === selected}">${monthShort(m)}</button>`).join('')}</div>
    <span class="muted" style="font-size:12.5px;margin-left:auto">${sumLine}</span>
  </div>

  <div class="grid g-12">
    <div class="card hero owe c-5" style="padding-bottom:22px">
      <div class="hero-eyebrow">${ICONS.wallet.replace('<svg', '<svg style="width:13px;height:13px"')} ${monthLabel(selected)} settlement <span class="pill ${duePillCls}" style="margin-left:auto;text-transform:none;letter-spacing:0" title="Settlements are due on the ${dueDay}th of the following month">${ICONS.clock} ${st.cls === 'good' ? `Was due ${due.label}` : due.kind === 'later' || s.paid !== null ? `Due ${due.label}` : `${due.text} · ${due.label}`}</span></div>
      <div class="muted" style="margin-top:14px;font-size:13px;font-weight:500">${esc(B)} sends ${esc(A)}</div>
      <div class="hero-value num" id="st-value" style="margin-top:4px">${money(s.sellerSends, 2)}</div>
      <div class="hero-meta">
        <span>Reimbursement <b>${money(s.cogs + s.opexAmazon, 2)}</b></span>
        <span>${s.shareAmazon < 0 ? '−' : '+'} ${esc(A)}'s ${split}% share <b>${money(Math.abs(s.shareAmazon), 2)}</b></span>
      </div>
      <div class="status-card ${st.cls}" style="margin-top:18px"><div class="ic">${st.icon}</div><div><div class="t">${st.t}</div><div class="s">${esc(st.s)}</div></div></div>
      ${paidPct !== null ? `<div class="paid-bar ${s.balance < -0.009 ? 'over' : ''}" title="${paidPct.toFixed(0)}% of the amount due"><div style="width:${paidPct.toFixed(1)}%"></div></div>` : ''}
      <div class="settle-sec" style="margin-top:20px">
        <h4>Record a payment</h4>
        <form class="pay-form" id="pay-form" style="margin-top:8px">
          <label class="field">Amount paid<input class="input num" name="paid" type="number" step="0.01" inputmode="decimal" placeholder="0.00" value="${s.paid ?? ''}" /></label>
          <label class="field">Date<input class="input" name="paid_at" type="date" value="${s.paidAt || ''}" /></label>
          <label class="field full">Note<input class="input" name="note" placeholder="e.g. Zelle, Venmo, cash" value="${esc(s.note || '')}" /></label>
          <div class="actions"><button class="btn primary" type="submit">${ICONS.save} Save payment</button><button class="btn" type="button" id="pay-full">${ICONS.check} Mark paid in full</button></div>
        </form>
      </div>
    </div>

    <div class="card c-7"><div class="card-h"><div><h3>${monthLabel(selected)} settlement</h3><div class="sub">Same sections as the monthly sheet${approx ? ' · sheet rows have approximate dates within the month' : ''}</div></div><div class="right"><a class="btn sm" href="#/costs">Edit expenses</a></div></div>
      <div class="card-b settle-grid">
        <div>
          <div class="settle-sec">${sec(1, 'Transactions')}
            ${line('Items sold', count(s.orders))}
            ${line(`eBay payouts (collected by ${esc(B)})`, money(s.collected, 2))}
            ${line(`Amazon COGS (paid by ${esc(A)})`, `−${money(s.cogs, 2)}`)}
            ${line('eBay ad fees', `−${money(s.adFees, 2)}`)}
            ${s.otherCosts ? line('Other per-order costs', `−${money(s.otherCosts, 2)}`) : ''}
            ${line('Net item profit', money(s.orderProfit, 2), { total: true, cls: s.orderProfit < 0 ? 'neg' : '' })}
          </div>
          <div class="settle-sec">${sec(2, 'Operating costs')}
            ${s.expenses.length ? s.expenses.map((e) => line(`${esc(e.category)}${e.note ? ` <span class="muted" style="font-size:11.5px">${esc(e.note)}</span>` : ''}${e.paid_by === 'amazon' ? ` <span class="pill">${esc(A)} paid</span>` : ''}`, money(e.amount, 2))).join('') : '<div class="muted" style="font-size:13px;padding:6px 0">None entered</div>'}
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
            ${line(`${ICONS.arrow.replace('<svg', '<svg style="width:14px;height:14px;color:var(--accent)"')} ${esc(B)} sends ${esc(A)}`, money(s.sellerSends, 2), { total: true })}
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="grid g-12 mt">
    <div class="card c-5"><div class="card-h"><div><h3>Business profit by month</h3><div class="sub">After operating expenses</div></div></div><div class="card-b"><div class="chart" id="ch-bp"></div></div></div>
    <div class="card c-7"><div class="card-h"><div><h3>All months</h3><div class="sub">${owed > 0.009 ? `<b class="neg">${money(owed, 2)}</b> still owed to ${esc(A)} across all months` : `<span class="pos">Everything is settled</span> · click a month to open it`}</div></div><div class="right"><button class="btn sm" id="st-dl">${ICONS.down} Export CSV</button></div></div>
      <div class="card-b table-wrap"><table class="simple"><thead><tr><th>Month</th><th class="r">Items</th><th class="r">Payouts</th><th class="r">COGS</th><th class="r">Expenses</th><th class="r">Profit</th><th class="r">Sends</th><th>Due</th><th class="r">Paid</th><th class="r">Status</th></tr></thead><tbody>
      ${[...all].reverse().map((x) => `<tr data-m="${x.month}" class="${x.month === selected ? 'sel' : ''}" style="cursor:pointer"><td><b>${monthShort(x.month)}</b></td><td class="r">${count(x.orders)}</td><td class="r">${money(x.collected, 2)}</td><td class="r">${money(x.cogs, 2)}</td><td class="r">${money(x.opex, 2)}</td><td class="r ${x.businessProfit < 0 ? 'neg' : ''}">${money(x.businessProfit, 2)}</td><td class="r"><b>${money(x.sellerSends, 2)}</b></td><td style="white-space:nowrap">${duePill(x, dueOf(x))}</td><td class="r">${x.paid === null ? '<span class="muted">—</span>' : money(x.paid, 2)}</td><td class="r">${x.paid === null ? (x.sellerSends > 0.009 ? '<span class="pill warn">Unpaid</span>' : '<span class="pill">Nothing due</span>') : Math.abs(x.balance) < 0.01 ? `<span class="pill good">${ICONS.check} Paid</span>` : x.balance > 0 ? `<span class="pill warn">${money(x.balance, 2)} owed</span>` : `<span class="pill info">Overpaid ${money(-x.balance, 2)}</span>`}</td></tr>`).join('')}
      </tbody></table></div></div>
  </div>`;

  countUp($('#st-value'), s.sellerSends, (v) => money(v, 2), 800);

  $('#st-months').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { selected = b.dataset.m; renderPage(); } });
  $$('tr[data-m]', el).forEach((tr) => tr.addEventListener('click', () => { selected = tr.dataset.m; renderPage(); window.scrollTo({ top: 0, behavior: 'smooth' }); }));
  const save = async (body) => {
    await api('/api/settlements', { method: 'POST', body: { month: selected, ...body } });
    toast('Payment saved', 'good');
    await loadData();
    renderPage();
  };
  $('#pay-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    save({ paid: f.get('paid'), paid_at: f.get('paid_at'), note: f.get('note') });
  });
  $('#pay-full').onclick = () => save({ paid: s.sellerSends, paid_at: new Date().toISOString().slice(0, 10), note: $('#pay-form [name=note]').value });
  $('#st-dl').onclick = () => downloadCsv('settlements.csv', all, [
    { title: 'Month', get: (x) => x.month }, { title: 'Items', get: (x) => x.orders }, { title: 'eBay payouts', get: (x) => x.collected },
    { title: 'Amazon COGS', get: (x) => x.cogs }, { title: 'Ad fees', get: (x) => x.adFees }, { title: 'Operating expenses', get: (x) => x.opex },
    { title: 'Net business profit', get: (x) => x.businessProfit }, { title: `${A} share`, get: (x) => x.shareAmazon }, { title: `${B} share`, get: (x) => x.shareSeller },
    { title: `${B} sends ${A}`, get: (x) => x.sellerSends }, { title: 'Due', get: (x) => settlementDueDate(x.month, dueDay).toISOString().slice(0, 10) }, { title: 'Paid', get: (x) => x.paid ?? '' }, { title: 'Owed', get: (x) => x.balance },
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
