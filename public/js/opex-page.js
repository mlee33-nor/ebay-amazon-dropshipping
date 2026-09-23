// Operating costs page: the monthly business expenses (subscriptions, proxies, tools…) that come out of
// profit before the partners split it. Same data as the sheets' section 2 and Editor → Operating expenses.
import { $, $$, esc, money, api, toast, ICONS } from './util.js';
import { state, loadData, renderPage } from './app.js';

const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const monthLabel = (m) => { const [y, mo] = m.split('-').map(Number); return new Date(y, mo - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }); };
const prevMonth = (m) => { const [y, mo] = m.split('-').map(Number); return monthKey(new Date(y, mo - 2, 1)); };
// Names are matched the way a person reads them: trimmed, case-insensitive, runs of spaces collapsed
const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
// A valid amount is a finite number above zero, rounded to cents. Returns null for blank, zero, negative or junk.
const parseAmount = (raw) => {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
};

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
  // "Copy last month" only copies names not already entered this month, so the button says exactly that
  const thisNames = new Set(thisList.map((e) => norm(e.category)));
  const toCopy = lastList.filter((e) => !thisNames.has(norm(e.category)));
  const skipped = lastList.filter((e) => thisNames.has(norm(e.category)));
  const copyTotal = toCopy.reduce((s, e) => s + e.amount, 0);
  const lastName = monthLabel(last).split(' ')[0];
  const categories = [...new Set(expenses.map((e) => e.category))].sort();
  const monthOptions = (sel) => {
    const opts = new Set(months);
    for (let i = -1; i < 12; i++) { const x = new Date(); x.setDate(1); x.setMonth(x.getMonth() - i); opts.add(monthKey(x)); }
    return [...opts].sort().reverse().map((m) => `<option value="${m}" ${m === sel ? 'selected' : ''}>${monthLabel(m)}</option>`).join('');
  };
  const payer = (p) => (p === 'amazon' ? esc(A) : esc(B));
  const copyBtn = !lastList.length ? ''
    : toCopy.length ? `<button class="btn" id="ox-copy" title="${esc(`Adds ${toCopy.map((e) => e.category).join(', ')}${skipped.length ? `; skips ${skipped.map((e) => e.category).join(', ')} (already here)` : ''}`)}">${ICONS.undo.replace('<svg', '<svg style="transform:scaleX(-1)"')} Copy ${toCopy.length} ${toCopy.length === 1 ? 'cost' : 'costs'} from ${lastName} (${money(copyTotal, 2)})</button>`
    : `<span class="muted" style="font-size:12px">All of ${lastName}'s costs are already here</span>`;

  el.innerHTML = `
  <div class="grid g-12">
    <div class="card c-5">
      <div class="card-h"><div><h3>Add a cost</h3><div class="sub">Subscriptions, proxies, tools, insertion fees… anything the business pays monthly</div></div></div>
      <div class="card-b">
        <form id="ox-form" class="pay-form" novalidate>
          <label class="field">Month<select class="select" name="month">${monthOptions(thisMonth)}</select></label>
          <label class="field">Amount<input class="input num" name="amount" type="number" step="0.01" min="0.01" inputmode="decimal" placeholder="0.00" required /></label>
          <label class="field full">What is it<input class="input" name="category" list="ox-cats" placeholder="e.g. eBay Sub Cost Total, Proxies (2x)" required /></label>
          <datalist id="ox-cats">${categories.map((c) => `<option value="${esc(c)}"></option>`).join('')}</datalist>
          <label class="field">Paid by<select class="select" name="paid_by"><option value="seller">${esc(B)} (eBay partner)</option><option value="amazon">${esc(A)} (Amazon partner)</option></select></label>
          <label class="field">Note<input class="input" name="note" placeholder="optional" /></label>
          <div class="form-err" id="ox-err" role="alert" hidden></div>
          <div class="actions"><button class="btn primary" type="submit">${ICONS.save} Add cost</button></div>
        </form>
        <div class="muted" style="font-size:12px;margin-top:12px">Costs paid by ${esc(B)} come out of profit before the split. Costs paid by ${esc(A)} are also paid back to ${esc(A)} in the settlement.</div>
      </div>
    </div>
    <div class="card c-7">
      <div class="card-h"><div><h3>${monthLabel(thisMonth)}</h3><div class="sub">${thisList.length ? `${thisList.length} costs · ${money(total(thisMonth), 2)}` : 'No costs entered for this month yet'}</div></div>
        <div class="right">${copyBtn}</div></div>
      <div class="card-b">
        <div class="stat-row"><span class="k">This month</span><span class="v">${money(total(thisMonth), 2)}</span></div>
        <div class="stat-row"><span class="k">Last month</span><span class="v">${money(total(last), 2)}</span></div>
        <div class="stat-row"><span class="k">All months</span><span class="v">${money(expenses.reduce((s, e) => s + e.amount, 0), 2)}</span></div>
        <div class="muted" style="font-size:12px;margin-top:10px">Tip: most costs repeat monthly. Use <b>Copy last month</b>, then fix any amounts that changed and delete one-offs.</div>
      </div>
    </div>
  </div>
  <div class="stack mt">
    ${months.map((m) => {
      const list = expenses.filter((e) => e.month === m);
      return `<div class="card"><div class="card-h"><div><h3>${monthLabel(m)}</h3><div class="sub">${list.length} ${list.length === 1 ? 'cost' : 'costs'}</div></div><div class="right"><b class="num">${money(total(m), 2)}</b></div></div>
        <div class="card-b table-wrap">${list.length ? `<table class="simple ox-table"><thead><tr><th>What</th><th class="ox-payer">Paid by</th><th class="ox-note">Note</th><th class="r">Amount</th><th><span class="sr-only">Delete</span></th></tr></thead><tbody>
          ${list.map((e) => `<tr data-id="${e.id}">
            <td class="ox-what">${esc(e.category)}${e.source === 'sheet' ? ` <span class="pill">${ICONS.sheet} from sheet</span>` : ''}<div class="ox-sub muted">${payer(e.paid_by)}${e.note ? ` · ${esc(e.note)}` : ''}</div></td>
            <td class="ox-payer">${payer(e.paid_by)}</td>
            <td class="ox-note muted">${esc(e.note || '')}</td>
            <td class="r ox-amt-cell"><input class="input num ox-amt" type="number" step="0.01" min="0.01" inputmode="decimal" value="${e.amount}" aria-label="Amount for ${esc(e.category)}" /></td>
            <td class="r ox-del-cell"><button class="btn sm ghost danger ox-del" title="Delete" aria-label="Delete ${esc(e.category)}">${ICONS.trash}</button></td>
          </tr>`).join('')}</tbody></table>` : `<div class="empty" style="padding:22px 16px"><div class="ic" style="width:36px;height:36px;border-radius:10px;margin-bottom:8px">${ICONS.wallet.replace('<svg', '<svg style="width:16px;height:16px"')}</div><div class="t" style="font-size:13.5px">Nothing for this month yet</div>Add a cost above, or copy last month's recurring costs.</div>`}</div></div>`;
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

  const form = $('#ox-form');
  const err = $('#ox-err');
  const showErr = (html, field) => {
    err.innerHTML = html;
    err.hidden = false;
    $$('.input', form).forEach((i) => i.removeAttribute('aria-invalid'));
    if (field) { const f = form.querySelector(`[name=${field}]`); f.setAttribute('aria-invalid', 'true'); f.focus(); }
  };
  const clearErr = () => { err.hidden = true; err.innerHTML = ''; $$('.input', form).forEach((i) => i.removeAttribute('aria-invalid')); };
  form.addEventListener('input', clearErr);
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const f = new FormData(form);
    const month = String(f.get('month'));
    const category = String(f.get('category') || '').trim().replace(/\s+/g, ' ');
    if (!category) return showErr('Enter what the cost is for.', 'category');
    const amount = parseAmount(f.get('amount'));
    if (amount === null) return showErr('Enter an amount greater than $0.00.', 'amount');
    // The server upserts on month + name, so a second entry with the same name would silently replace the first
    const existing = expenses.find((e) => e.month === month && norm(e.category) === norm(category));
    if (existing) {
      const sum = Math.round((existing.amount + amount) * 100) / 100;
      showErr(`“${esc(existing.category)}” already exists in ${monthLabel(month)} — edit its amount below instead.
        <button type="button" class="btn sm" id="ox-addto">Add ${money(amount, 2)} to it (${money(sum, 2)})</button>`, 'category');
      $('#ox-addto').onclick = () => save([{ id: existing.id, month: existing.month, category: existing.category, amount: sum, paid_by: existing.paid_by, note: existing.note }], `${existing.category} is now ${money(sum, 2)}`);
      return;
    }
    save([{ month, category, amount, paid_by: f.get('paid_by'), note: String(f.get('note') || '').trim() || null }], `Added ${category}`);
  });

  $('#ox-copy')?.addEventListener('click', () => {
    if (!toCopy.length) return toast(`Everything from ${lastName} is already here`);
    const lines = toCopy.map((e) => `  • ${e.category}: ${money(e.amount, 2)}`).join('\n');
    const skip = skipped.length ? `\n\nSkipped (already in ${monthLabel(thisMonth)}): ${skipped.map((e) => e.category).join(', ')}` : '';
    const msg = `Copy ${toCopy.length} ${toCopy.length === 1 ? 'cost' : 'costs'} from ${monthLabel(last)} into ${monthLabel(thisMonth)}?\n\n${lines}\n\nTotal: ${money(copyTotal, 2)}${skip}\n\nOne-off costs can be deleted afterwards.`;
    if (!confirm(msg)) return;
    save(toCopy.map((e) => ({ month: thisMonth, category: e.category, amount: e.amount, paid_by: e.paid_by, note: e.note })), `Copied ${toCopy.length} costs (${money(copyTotal, 2)}) into ${monthLabel(thisMonth)}`);
  });

  $$('.ox-amt', el).forEach((inp) => inp.addEventListener('change', () => {
    const id = Number(inp.closest('tr').dataset.id);
    const e = expenses.find((x) => x.id === id);
    const amount = parseAmount(inp.value);
    if (amount === null) {
      toast(`${e.category}: enter an amount greater than $0.00 (to remove a cost, use the × button)`, 'bad');
      inp.value = e.amount; // restore the saved value
      inp.setAttribute('aria-invalid', 'true');
      setTimeout(() => inp.removeAttribute('aria-invalid'), 2500);
      return;
    }
    if (amount === e.amount) { inp.value = e.amount; return; }
    save([{ id, month: e.month, category: e.category, amount, paid_by: e.paid_by, note: e.note }], `Updated ${e.category}`);
  }));
  $$('.ox-del', el).forEach((b) => b.addEventListener('click', () => {
    const id = Number(b.closest('tr').dataset.id);
    const e = expenses.find((x) => x.id === id);
    if (!confirm(`Delete "${e.category}" (${money(e.amount, 2)}) from ${monthLabel(e.month)}?`)) return;
    save([{ id, _delete: true }], `Deleted ${e.category}`);
  }));
}
