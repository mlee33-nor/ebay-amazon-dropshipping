// Ask AI: a chat about the business. Every answer is written by the dashboard from the same numbers and settlement
// math as every other page, so it can't state anything that isn't true. Questions are read by a built-in reader
// (everyday phrasing, typos, follow-ups); one it can't place is read on the server by the hosted AI model, if one is
// set up (only the question text is sent), which names the topic and period, never the answer.
import { esc, api, ICONS } from './util.js';
import { state } from './app.js';

const chat = []; // { role: 'user'|'assistant', text, answer?, context? }
let busy = false;
let view = null;

// ---------------------------------------------------------------- rendering
const md = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
function answerHtml(a) {
  const parts = [`<div class="bubble">${md(a.text || '')}</div>`];
  if (a.bullets?.length) parts.push(`<ul class="ask-bullets">${a.bullets.map((b) => `<li>${md(b)}</li>`).join('')}</ul>`);
  if (a.table) parts.push(`<div class="table-wrap ask-tablewrap"><table class="simple ask-table"><thead><tr>${a.table.head.map((h, i) => `<th class="${i ? 'r' : ''}">${esc(h)}</th>`).join('')}</tr></thead><tbody>${a.table.rows.map((r) => `<tr>${r.map((c, i) => `<td class="${i ? 'r num' : ''}">${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
  if (a.understood) parts.push(`<div class="ask-read" title="What the question was read as. If it's wrong, rephrase the question.">${ICONS.search}<span>Answering: <b>${esc(a.understood.label)}</b>${a.understood.period ? ` · ${esc(a.understood.period)}` : ''}${a.understood.product ? ` · “${esc(a.understood.product)}”` : ''}${a.understood.by === 'model' ? ' · read by the AI model' : ''}</span></div>`);
  return parts.join('');
}
function msgHtml(m) {
  if (m.role === 'user') return `<div class="ask-msg me"><div class="bubble">${esc(m.text)}</div></div>`;
  const chips = (m.answer?.chips || []).slice(0, 3).map((c) => `<button class="ask-chip" data-q="${esc(c)}">${esc(c)}</button>`).join('');
  const body = m.pending ? `<div class="bubble"><span class="ask-typing"><i></i><i></i><i></i></span></div>` : m.error ? `<div class="bubble">${esc(m.error)}</div>` : answerHtml(m.answer);
  return `<div class="ask-msg ai">
    <div class="ask-av">${ICONS.spark}</div>
    <div class="ask-body">${body}${!m.pending && chips ? `<div class="ask-chips">${chips}</div>` : ''}</div>
  </div>`;
}

const SUGGEST = ['How much did we make this month?', 'Why are we down this month?', 'What does Drew owe?', 'How many sales today?', 'Which sales are awaiting the Amazon email?', 'Top products this month', 'Compare August vs September', 'What was our best day?'];

function statusHtml() {
  const ai = state.data?.ai?.configured;
  return `<div class="ask-status">${ICONS.check}<div><b>Answers come straight from your numbers.</b> <span class="muted">${ai ? 'Unusual questions are read with help from your AI model; only the question is sent to it, never your data.' : 'Every figure is the same one the dashboard shows.'}</span></div></div>`;
}

function paintLog() {
  const log = view && view.querySelector('#ask-log');
  if (!log) return;
  log.innerHTML = chat.length ? chat.map(msgHtml).join('') : `<div class="ask-empty"><div class="ic">${ICONS.spark}</div><div class="t">Ask anything about the business</div><p>Profit, what’s owed, why a month is up or down, which products earn, what sold today, listings.</p><div class="ask-chips center">${SUGGEST.map((q) => `<button class="ask-chip" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div></div>`;
  log.scrollTop = log.scrollHeight;
}
// While an answer is on its way the box stays locked, so a second question is never silently dropped
function setBusy(on) {
  busy = on;
  const q = view?.querySelector('#ask-q');
  const b = view?.querySelector('#ask-form button');
  if (q) { q.disabled = on; q.placeholder = on ? 'Answering…' : 'Ask about profit, settlements, products, listings…'; }
  if (b) b.disabled = on;
  view?.querySelectorAll('.ask-chip').forEach((c) => { c.disabled = on; });
}

async function send(question) {
  question = question.trim();
  if (!question || busy) return;
  setBusy(true);
  const context = [...chat].reverse().find((m) => m.role === 'assistant' && m.context)?.context || null;
  const um = { role: 'user', text: question };
  const am = { role: 'assistant', pending: true };
  chat.push(um, am);
  paintLog();
  try {
    const a = await api('/api/ask', { method: 'POST', body: { question, context } });
    am.answer = a;
    am.context = a.context;
  } catch (e) {
    am.error = `Something went wrong: ${e.message}`;
  }
  am.pending = false;
  setBusy(false);
  paintLog();
  view?.querySelector('#ask-q')?.focus();
}

export function renderAsk(el) {
  view = el;
  el.innerHTML = `<div class="card ask-card">
    <div class="ask-top" id="ask-status">${statusHtml()}</div>
    <div class="ask-log" id="ask-log" aria-live="polite"></div>
    <form class="ask-form" id="ask-form">
      <textarea class="input" id="ask-q" rows="1" placeholder="Ask about profit, settlements, products, listings…" aria-label="Your question"></textarea>
      <button class="btn primary" type="submit" aria-label="Send">${ICONS.send}</button>
    </form>
    <div class="ask-foot">Each answer says what it was read as. If that's not what you meant, rephrase the question.</div>
  </div>`;
  paintLog();
  const q = el.querySelector('#ask-q');
  el.querySelector('#ask-form').addEventListener('submit', (e) => { e.preventDefault(); const v = q.value; q.value = ''; q.style.height = ''; send(v); });
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); el.querySelector('#ask-form').requestSubmit(); } });
  q.addEventListener('input', () => { q.style.height = ''; q.style.height = `${Math.min(140, q.scrollHeight)}px`; });
  el.querySelector('#ask-log').addEventListener('click', (e) => { const b = e.target.closest('.ask-chip'); if (b) send(b.dataset.q); });
}
