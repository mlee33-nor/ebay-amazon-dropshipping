// Settlement page: the monthly partner sheet, computed live from orders + operating expenses.
import { $, $$, esc, money, count, fmtDate, api, toast, downloadCsv, ICONS } from './util.js';
import { settleMonth, allMonths } from './settlement.js';
import { state, loadData, renderPage } from './app.js';
import { mount, colors, tooltipBase, axisBase, ttRow, ttHead } from './charts.js';

let selected = null;
const monthLabel = (m) => { const [y, mo] = m.split('-').map(Number); return new Date(y, mo - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }); };
const monthShort = (m) => { const [y, mo] = m.split('-').map(Number); return new Date(y, mo - 1, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' }); };

export function renderSettlement(el) {
  const d = state.data;
  const { expenses, settlements } = d.books;
  const A = d.settings.partner_amazon;
  const B = d.settings.partner_ebay;
  const split = Number(d.settings.split_amazon);
  const months = allMonths(d.orders, expenses);
  if (!months.length) {
    el.innerHTML = '<div class="card"><div class="empty"><div class="t">Nothing to settle yet</div>Upload a monthly sheet or sync eBay first.</div></div>';
    return;
  }
  if (!selected || !months.includes(selected)) selected = months[months.length - 1];
  const all = months.map((m) => settleMonth({ month: m, orders: d.orders, expenses, settlements, splitAmazon: split }));
  const s = all.find((x) => x.month === selected);
  const owed = all.reduce((t, x) => t + x.balance, 0);
  const approx = d.orders.some((o) => o.approx_date && o.created_at.startsWith(selected));

  const line = (k, v, opts = {}) => `<div class="calc-row ${opts.total ? 'total' : ''}"><span class="k">${k}</span><span class="${opts.cls || ''}">${v}</span></div>`;
  el.innerHTML = `
  <div class="row" style="margin-bottom:16px">
    <div class="seg" id="st-months">${months.map((m) => `<button data-m="${m}" class="${m === selected ? 'on' : ''}">${monthShort(m)}</button>`).join('')}</div>
    <span class="muted" style="font-size:12.5px;margin-left:auto">${esc(A)} pays Amazon · ${esc(B)} collects eBay and pays operating costs · profit split ${split}/${100 - split}</span>
  </div>

  <div class="grid g-12">
    <div class="card hero c-5">
      <div class="hero-label">${esc(B)} sends ${esc(A)} · ${monthLabel(selected)}</div>
      <div class="hero-value num">${money(s.sellerSends, 2)}</div>
      <div class="hero-meta">
        <span>Reimbursement <b class="ink2">${money(s.cogs + s.opexAmazon, 2)}</b></span>
        <span>${s.shareAmazon < 0 ? 'minus' : 'plus'} ${esc(A)}'s share <b class="ink2">${money(Math.abs(s.shareAmazon), 2)}</b></span>
      </div>
      <div style="margin:16px 0 20px">
        ${s.paid !== null
          ? `<span class="pill ${Math.abs(s.balance) < 0.01 ? 'good' : 'warn'}">${Math.abs(s.balance) < 0.01 ? 'Paid in full' : `Paid ${money(s.paid, 2)}, ${s.balance > 0 ? `${money(s.balance, 2)} still owed` : `overpaid ${money(-s.balance, 2)}`}`}</span> <span class="muted" style="font-size:12px">${s.paidAt ? fmtDate(`${s.paidAt}T12:00`) : ''} ${esc(s.note || '')}</span>`
          : '<span class="pill warn">Not paid yet</span>'}
      </div>
      <form class="row" id="pay-form" style="margin-bottom:20px">
        <input class="input" name="paid" type="number" step="0.01" placeholder="Amount paid" style="width:130px" value="${s.paid ?? ''}" />
        <input class="input" name="paid_at" type="date" style="width:150px" value="${s.paidAt || ''}" />
        <input class="input" name="note" placeholder="Note" style="flex:1;min-width:100px" value="${esc(s.note || '')}" />
        <button class="btn primary" type="submit">Save payment</button>
        <button class="btn" type="button" id="pay-full">Mark paid in full</button>
      </form>
    </div>
    <div class="card c-7"><div class="card-h"><div><h3>${monthLabel(selected)} settlement</h3><div class="sub">Same sections as the monthly sheet${approx ? ' · sheet rows have approximate dates within the month' : ''}</div></div></div>
      <div class="card-b grid" style="grid-template-columns:1fr 1fr;gap:28px">
        <div>
          <h4 style="margin:0 0 6px;font-size:11.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--ink-3)">1. Transactions</h4>
          ${line('Items sold', count(s.orders))}
          ${line(`eBay payouts (collected by ${esc(B)})`, money(s.collected, 2))}
          ${line(`Amazon COGS (paid by ${esc(A)})`, `−${money(s.cogs, 2)}`)}
          ${line('eBay ad fees', `−${money(s.adFees, 2)}`)}
          ${s.otherCosts ? line('Other per-order costs', `−${money(s.otherCosts, 2)}`) : ''}
          ${line('Net item profit', money(s.orderProfit, 2), { total: true, cls: s.orderProfit < 0 ? 'neg' : '' })}
          <h4 style="margin:18px 0 6px;font-size:11.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--ink-3)">2. Operating costs</h4>
          ${s.expenses.length ? s.expenses.map((e) => line(`${esc(e.category)}${e.note ? ` <span class="muted" style="font-size:11.5px">${esc(e.note)}</span>` : ''}${e.paid_by === 'amazon' ? ` <span class="pill">${esc(A)} paid</span>` : ''}`, money(e.amount, 2))).join('') : '<div class="muted" style="font-size:13px">None entered</div>'}
          ${line('Total operating expenses', money(s.opex, 2), { total: true })}
          <a class="btn sm" style="margin-top:8px" href="#/editor?tab=expenses">Edit expenses</a>
        </div>
        <div>
          <h4 style="margin:0 0 6px;font-size:11.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--ink-3)">3. Monthly summary</h4>
          ${line('Gross revenue (eBay payouts)', money(s.collected, 2))}
          ${line('Amazon COGS', `−${money(s.cogs, 2)}`)}
          ${line('eBay fees (ads)', `−${money(s.adFees, 2)}`)}
          ${line('Operating expenses', `−${money(s.opex, 2)}`)}
          ${line('Net business profit', money(s.businessProfit, 2), { total: true, cls: s.businessProfit < 0 ? 'neg' : 'pos' })}
          <h4 style="margin:18px 0 6px;font-size:11.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--ink-3)">4. Partner settlement</h4>
          ${line(`${esc(A)}'s reimbursement (Amazon COGS${s.opexAmazon ? ' + expenses' : ''})`, money(s.cogs + s.opexAmazon, 2))}
          ${line(`${esc(A)}'s ${split}% profit share`, money(s.shareAmazon, 2), { cls: s.shareAmazon < 0 ? 'neg' : '' })}
          ${line(`${esc(B)}'s ${100 - split}% profit share`, money(s.shareSeller, 2), { cls: s.shareSeller < 0 ? 'neg' : '' })}
          ${line(`👉 ${esc(B)} sends ${esc(A)}`, money(s.sellerSends, 2), { total: true })}
        </div>
      </div>
    </div>
  </div>

  <div class="grid g-12 mt">
    <div class="card c-5"><div class="card-h"><div><h3>Business profit by month</h3><div class="sub">After operating expenses</div></div></div><div class="card-b"><div class="chart" id="ch-bp"></div></div></div>
    <div class="card c-7"><div class="card-h"><div><h3>All months</h3><div class="sub">${owed > 0.009 ? `<b class="neg">${money(owed, 2)}</b> still owed to ${esc(A)} across all months` : 'Everything is settled'}</div></div><div class="right"><button class="btn sm" id="st-dl">Export CSV</button></div></div>
      <div class="card-b table-wrap"><table class="simple"><thead><tr><th>Month</th><th class="r">Items</th><th class="r">Payouts</th><th class="r">COGS</th><th class="r">Expenses</th><th class="r">Profit</th><th class="r">Sends</th><th class="r">Paid</th><th class="r">Owed</th></tr></thead><tbody>
      ${[...all].reverse().map((x) => `<tr data-m="${x.month}" style="cursor:pointer"><td>${monthShort(x.month)}</td><td class="r">${count(x.orders)}</td><td class="r">${money(x.collected, 2)}</td><td class="r">${money(x.cogs, 2)}</td><td class="r">${money(x.opex, 2)}</td><td class="r ${x.businessProfit < 0 ? 'neg' : ''}">${money(x.businessProfit, 2)}</td><td class="r"><b>${money(x.sellerSends, 2)}</b></td><td class="r">${x.paid === null ? '<span class="muted">—</span>' : money(x.paid, 2)}</td><td class="r ${x.balance > 0.009 ? 'neg' : 'pos'}">${Math.abs(x.balance) < 0.01 ? '✓' : money(x.balance, 2)}</td></tr>`).join('')}
      </tbody></table></div></div>
  </div>`;

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
    { title: `${B} sends ${A}`, get: (x) => x.sellerSends }, { title: 'Paid', get: (x) => x.paid ?? '' }, { title: 'Owed', get: (x) => x.balance },
  ]);

  const c = colors();
  mount($('#ch-bp'), {
    grid: { left: 8, right: 12, top: 16, bottom: 4, containLabel: true },
    tooltip: { ...tooltipBase(), trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(127,127,127,.08)' } },
      formatter: (ps) => { const x = all[ps[0].dataIndex]; return ttHead(monthLabel(x.month)) + ttRow(c.profit, 'Net item profit', money(x.orderProfit, 2)) + ttRow(c.ink3, 'Operating expenses', `−${money(x.opex, 2)}`) + ttRow(x.businessProfit < 0 ? c.bad : c.good, 'Business profit', money(x.businessProfit, 2), true); } },
    xAxis: { type: 'category', data: all.map((x) => monthShort(x.month)), ...axisBase({ splitLine: { show: false } }) },
    yAxis: { type: 'value', ...axisBase(), axisLine: { show: false }, axisLabel: { ...axisBase().axisLabel, formatter: (v) => money(v, 0) } },
    series: [{ type: 'bar', barWidth: '45%', data: all.map((x) => ({ value: x.businessProfit, itemStyle: { color: x.businessProfit < 0 ? c.bad : c.profit, borderRadius: x.businessProfit < 0 ? [0, 0, 4, 4] : [4, 4, 0, 0] } })),
      label: { show: true, position: 'top', color: c.ink2, fontSize: 11, formatter: (p) => money(p.value, 0) } }],
  });
}
