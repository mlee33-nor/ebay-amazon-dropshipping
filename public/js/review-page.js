// Review: everything that needs a person to look at it, in one place (instead of banners across the top). Each
// section says what it is, why it matters, and what to do; empty sections are left out.
import { $$, esc, money, count, fmtDate, ICONS, api, toast, azDay } from './util.js';
import { settlePeriodOf } from './settlement.js';
import { emailFailures, emailFailureText } from './health.js';
import { state, loadData, renderPage, openOrder, statusPill, viewStatus } from './app.js';

// An eBay charge with no order that has the same amount as a monthly cost entered for that pay period (or its calendar
// month) is already in the numbers, e.g. the $74.95 store subscription entered as "eBay Sub Cost"
function costFor(c, d) {
  const day = azDay(c.at);
  const months = new Set([settlePeriodOf(day, Number(d.settings.settlement_day) || 26), day.slice(0, 7)]);
  return d.books.expenses.find((e) => months.has(e.month) && Math.abs(Number(e.amount) - Number(c.amount)) < 0.005) || null;
}

// What the Review page lists, with how many still need a look (the menu badge)
export function reviewItems(d) {
  const charges = (d.flags?.unassignedCharges || []).map((c) => ({ ...c, cost: c.amount > 0 ? costFor(c, d) : null }));
  const sections = {
    waiting: d.orders.filter((o) => o.status === 'awaiting_cost'),
    held: d.orders.filter((o) => o.status === 'needs_review' || o.status === 'check_sheet'),
    emails: emailFailures(d.email),
    refunds: d.amazon?.unmatchedRefunds || [],
    holds: d.flags?.openHolds || [],
    charges,
    matches: d.amazon?.suggestions || 0,
  };
  const open = sections.waiting.length + sections.held.length + sections.emails.length + sections.refunds.length + sections.holds.length
    + charges.filter((c) => !c.reviewed && !c.cost).length;
  return { sections, open };
}

export function renderReview(el) {
  const d = state.data;
  const { sections: x, open } = reviewItems(d);
  const sec = (icon, kind, title, why, body, n) => `<div class="card rv-sec"><div class="card-h"><div class="rv-h"><span class="rv-ic ${kind}">${icon}</span><div><h3>${title}${n !== undefined ? ` <span class="rv-n">${count(n)}</span>` : ''}</h3><div class="sub">${why}</div></div></div></div><div class="card-b">${body}</div></div>`;
  const out = [];

  if (x.waiting.length) out.push(sec(ICONS.mail, 'warn', 'Sales waiting for the Amazon cost', 'Not in profit or the payment until the Amazon order is found. Usually the email just hasn’t arrived yet; open a sale to check email now or type the cost.',
    `<table class="simple rv-rows"><tbody>${x.waiting.map((o) => `<tr data-id="${esc(o.order_id)}"><td class="muted" style="white-space:nowrap">${fmtDate(o.created_at)}</td><td>${esc(String(o.title || '').slice(0, 70))}</td><td class="r num">${money(o.revenue, 2)} sale</td><td>${statusPill(viewStatus(o))}</td></tr>`).join('')}</tbody></table>`, x.waiting.length));

  if (x.held.length) out.push(sec(ICONS.alert, 'bad', 'Sales held for a check', 'An Amazon email that may have the cost couldn’t be read, or the sale may already be on a monthly sheet. Open it to link the right purchase or type the cost.',
    `<table class="simple rv-rows"><tbody>${x.held.map((o) => `<tr data-id="${esc(o.order_id)}"><td class="muted" style="white-space:nowrap">${fmtDate(o.created_at)}</td><td>${esc(String(o.title || '').slice(0, 70))}</td><td class="r num">${money(o.revenue, 2)} sale</td><td>${statusPill(viewStatus(o))}</td></tr>`).join('')}</tbody></table>`, x.held.length));

  if (x.emails.length) out.push(sec(ICONS.mail, 'warn', 'Amazon emails the reader didn’t understand', 'Email is working. These are usually multi-item, gift-card or partly cancelled orders. If one is for an eBay sale, open that sale and type its cost. If it isn’t (a personal order), dismiss it.',
    `<div class="rv-list">${x.emails.map((f) => `<div class="rv-item"><div><div>${esc(f.subject || 'Amazon email')}</div><div class="muted">${esc([(f.order_ids || []).join(' '), f.received_at ? fmtDate(f.received_at) : '', f.note || ''].filter(Boolean).join(' · ') || emailFailureText(f))}</div></div>${f.message_id ? `<button class="btn sm" data-dismiss="${esc(f.message_id)}">Dismiss</button>` : ''}</div>`).join('')}</div>`, x.emails.length));

  if (x.refunds.length) out.push(sec(ICONS.alert, 'bad', 'Amazon refunds not matched to a sale', 'Amazon refunded Myles, but the refund couldn’t be tied to exactly one sale, so it isn’t taken off the payment yet. Set it on the right sale in the Editor (Amazon refund column).',
    `<div class="rv-list">${x.refunds.map((r) => `<div class="rv-item"><div><div>${money(r.amount, 2)}${r.title ? ` for “${esc(String(r.title).slice(0, 60))}”` : ''}</div><div class="muted">Amazon order ${esc(r.amazon_order_id || '')} · ${fmtDate(r.received_at)}</div></div><a class="btn sm" href="#/editor">Open Editor</a></div>`).join('')}</div>`, x.refunds.length));

  if (x.holds.length) out.push(sec(ICONS.alert, 'bad', 'Return holds open over 30 days', 'eBay held money for a return and never released or refunded it. Check the case on eBay: if the buyer was refunded, the refund shows up on its own after the next sync.',
    `<div class="rv-list">${x.holds.map((h) => `<div class="rv-item"><div><div>Order ${esc(h.order_id || '?')}: ${money(h.amount, 2)} held</div><div class="muted">since ${fmtDate(h.since)}</div></div></div>`).join('')}</div>`, x.holds.length));

  if (x.charges.length) {
    const todo = x.charges.filter((c) => !c.reviewed && !c.cost);
    const label = (c) => (c.type === 'ADJUSTMENT' ? 'eBay adjustment' : String(c.fee_type || c.type || '').replace(/_/g, ' ').toLowerCase().replace(/^other fees$/, 'eBay account fee (often the store subscription)'));
    out.push(sec(ICONS.receipt, todo.length ? 'warn' : 'good', 'eBay charges with no order', 'Money eBay charged or credited that isn’t tied to a sale, so it isn’t in any sale’s numbers. If it is a business cost, it belongs in Monthly costs. One with the same amount as a monthly cost for that period is already counted.',
      `<div class="rv-list">${[...x.charges].sort((a, b) => (a.at < b.at ? 1 : -1)).map((c) => `<div class="rv-item ${c.reviewed || c.cost ? 'done' : ''}"><div><div>${money(Math.abs(c.amount), 2)} ${c.amount < 0 ? 'credit' : 'charge'} · ${esc(label(c))}</div><div class="muted">${fmtDate(c.at)}${c.cost ? ` · already in Monthly costs as “${esc(c.cost.category)}”` : c.reviewed ? ' · marked as looked at' : ''}</div></div>${c.cost ? `<span class="pill good">${ICONS.check} Counted</span>` : `<button class="btn sm" data-charge="${esc(c.id)}" data-reviewed="${c.reviewed ? '1' : ''}">${c.reviewed ? 'Undo' : 'Looked at it'}</button>`}</div>`).join('')}</div>
      <div class="row mt"><a class="btn sm" href="#/costs">Open Monthly costs</a></div>`, todo.length));
  }

  if (x.matches) out.push(sec(ICONS.link, 'info', 'Possible matches to confirm', 'Amazon orders that might belong to a sale but need a yes or no from a person.', `<a class="btn sm" href="#/editor?tab=matches">Review ${count(x.matches)} in the Editor</a>`, x.matches));

  el.innerHTML = `<div class="rv-top">${open ? `<b>${count(open)} thing${open === 1 ? '' : 's'} to look at.</b> Nothing here changes a payment that has already been made.` : `${ICONS.circleCheck}<b>Nothing to review.</b> Every sale has its cost and nothing needs a look.`}</div>
    <div class="stack">${out.join('')}</div>`;

  $$('.rv-rows tr[data-id]', el).forEach((tr) => tr.addEventListener('click', () => openOrder(tr.dataset.id)));
  $$('[data-dismiss]', el).forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Dismiss this email? Only if it isn’t for an eBay sale (a personal order, or one already costed). It stays in the email log in Settings.')) return;
    try { await api('/api/email/failed/dismiss', { method: 'POST', body: { message_id: b.dataset.dismiss } }); toast('Dismissed', 'good'); await loadData(); renderPage(); } catch (e) { toast(e.message, 'bad'); }
  }));
  $$('[data-charge]', el).forEach((b) => b.addEventListener('click', async () => {
    try { await api('/api/review/charge', { method: 'POST', body: { id: b.dataset.charge, reviewed: !b.dataset.reviewed } }); await loadData(); renderPage(); } catch (e) { toast(e.message, 'bad'); }
  }));
}
