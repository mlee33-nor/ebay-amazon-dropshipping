// Operating costs page: the monthly business expenses (subscriptions, proxies, tools…) that come out of
// profit before the partners split it. Same data as the sheets' section 2 and Editor → Operating expenses.
import { $, $$, esc, money, api, toast, ICONS } from './util.js';
import { state, loadData, renderPage } from './app.js';

const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const monthLabel = (m) => { const [y, mo] = m.split('-').map(Number); return new Date(y, mo - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }); };
const prevMonth = (m) => { const [y, mo] = m.split('-').map(Number); return monthKey(new Date(y, mo - 2, 1)); };

export function renderOpex(el) {
  const d = state.data;
  const A = d.settings.partner_amazon;
  const B = d.settings.partner_ebay;
  const expenses = d.books.expenses;
  const thisMonth = monthKey(new Date());
  const months = [...new Set([thisMonth, ...expenses.map((e) => e.month)])].sort().reverse();
  const total = (m) => expenses.filter((e) => e.month === m).reduce((s, e) => s + e.amount, 0);
  const last = prevMonth(thisMonth);
  const lastList = expenses.filter((e) => e.month === last);
  const thisList = expenses.filter((e) => e.month === thisMonth);
  const categories = [...new Set(expenses.map((e) => e.category))].sort();
  const monthOptions = (sel) => {
    const opts = new Set(months);
    for (let i = -1; i < 12; i++) { const x = new Date(); x.setDate(1); x.setMonth(x.getMonth() - i); opts.add(monthKey(x)); }
    return [...opts].sort().reverse().map((m) => `<option value="${m}" ${m === sel ? 'selected' : ''}>${monthLabel(m)}</option>`).join('');
  };
  const payer = (p) => (p === 'amazon' ? esc(A) : esc(B));

  el.innerHTML = `
  <div class="grid g-12">
    <div class="card c-5">
      <div class="card-h"><div><h3>Add a cost</h3><div class="sub">Subscriptions, proxies, tools, insertion fees… anything the business pays monthly</div></div></div>
      <div class="card-b">
        <form id="ox-form" class="pay-form">
          <label class="field">Month<select class="select" name="month">${monthOptions(thisMonth)}</select></label>
          <label class="field">Amount<input class="input num" name="amount" type="number" step="0.01" min="0" inputmode="decimal" placeholder="0.00" required /></label>
          <label class="field full">What is it<input class="input" name="category" list="ox-cats" placeholder="e.g. eBay Sub Cost Total, Proxies (2x)" required /></label>
          <datalist id="ox-cats">${categories.map((c) => `<option value="${esc(c)}"></option>`).join('')}</datalist>
          <label class="field">Paid by<select class="select" name="paid_by"><option value="seller">${esc(B)} (eBay partner)</option><option value="amazon">${esc(A)} (Amazon partner)</option></select></label>
          <label class="field">Note<input class="input" name="note" placeholder="optional" /></label>
          <div class="actions"><button class="btn primary" type="submit">${ICONS.save} Add cost</button></div>
        </form>
        <div class="muted" style="font-size:12px;margin-top:12px">Costs paid by ${esc(B)} come out of profit before the split. Costs paid by ${esc(A)} are also paid back to ${esc(A)} in the settlement.</div>
      </div>
    </div>
    <div class="card c-7">
      <div class="card-h"><div><h3>${monthLabel(thisMonth)}</h3><div class="sub">${thisList.length ? `${thisList.length} costs · ${money(total(thisMonth), 2)}` : 'No costs entered for this month yet'}</div></div>
        <div class="right">${lastList.length ? `<button class="btn" id="ox-copy">${ICONS.undo.replace('<svg', '<svg style="transform:scaleX(-1)"')} Copy ${monthLabel(last).split(' ')[0]}'s ${lastList.length} costs (${money(total(last), 2)})</button>` : ''}</div></div>
      <div class="card-b">
        <div class="stat-row"><span class="k">This month</span><span class="v">${money(total(thisMonth), 2)}</span></div>
        <div class="stat-row"><span class="k">Last month</span><span class="v">${money(total(last), 2)}</span></div>
        <div class="stat-row"><span class="k">All months</span><span class="v">${money(expenses.reduce((s, e) => s + e.amount, 0), 2)}</span></div>
        <div class="muted" style="font-size:12px;margin-top:10px">Tip: most costs repeat monthly. Use <b>Copy last month</b>, then fix any amounts that changed.</div>
      </div>
    </div>
  </div>
  <div class="stack mt">
    ${months.map((m) => {
      const list = expenses.filter((e) => e.month === m);
      return `<div class="card"><div class="card-h"><div><h3>${monthLabel(m)}</h3><div class="sub">${list.length} ${list.length === 1 ? 'cost' : 'costs'}</div></div><div class="right"><b class="num">${money(total(m), 2)}</b></div></div>
        <div class="card-b table-wrap">${list.length ? `<table class="simple"><thead><tr><th>What</th><th>Paid by</th><th>Note</th><th class="r">Amount</th><th></th></tr></thead><tbody>
          ${list.map((e) => `<tr data-id="${e.id}">
            <td>${esc(e.category)}${e.source === 'sheet' ? ' <span class="pill">from sheet</span>' : ''}</td>
            <td>${payer(e.paid_by)}</td>
            <td class="muted">${esc(e.note || '')}</td>
            <td class="r"><input class="input num ox-amt" type="number" step="0.01" value="${e.amount}" style="width:110px;height:30px;text-align:right" aria-label="Amount for ${esc(e.category)}" /></td>
            <td class="r"><button class="btn sm ghost ox-del" title="Delete" aria-label="Delete ${esc(e.category)}">${ICONS.x}</button></td>
          </tr>`).join('')}</tbody></table>` : '<div class="empty" style="padding:18px">Nothing for this month yet.</div>'}</div></div>`;
    }).join('')}
  </div>`;

  const save = async (changes, msg) => {
    try {
      await api('/api/expenses', { method: 'POST', body: { changes } });
      toast(msg, 'good');
      await loadData();
      renderPage();
    } catch (e) { toast(e.message, 'bad'); }
  };
  $('#ox-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const category = String(f.get('category') || '').trim();
    if (!category) return;
    save([{ month: f.get('month'), category, amount: Number(f.get('amount')) || 0, paid_by: f.get('paid_by'), note: f.get('note') || null }], `Added ${category}`);
  });
  $('#ox-copy')?.addEventListener('click', () => {
    const existing = new Set(thisList.map((e) => e.category));
    const toAdd = lastList.filter((e) => !existing.has(e.category));
    if (!toAdd.length) return toast('Everything from last month is already here');
    save(toAdd.map((e) => ({ month: thisMonth, category: e.category, amount: e.amount, paid_by: e.paid_by, note: e.note })), `Copied ${toAdd.length} costs into ${monthLabel(thisMonth)}`);
  });
  $$('.ox-amt', el).forEach((inp) => inp.addEventListener('change', () => {
    const id = Number(inp.closest('tr').dataset.id);
    const e = expenses.find((x) => x.id === id);
    save([{ id, month: e.month, category: e.category, amount: Number(inp.value) || 0, paid_by: e.paid_by, note: e.note }], `Updated ${e.category}`);
  }));
  $$('.ox-del', el).forEach((b) => b.addEventListener('click', () => {
    const id = Number(b.closest('tr').dataset.id);
    const e = expenses.find((x) => x.id === id);
    if (!confirm(`Delete "${e.category}" (${money(e.amount, 2)}) from ${monthLabel(e.month)}?`)) return;
    save([{ id, _delete: true }], `Deleted ${e.category}`);
  }));
}
