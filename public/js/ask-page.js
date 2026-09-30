// Ask AI: a chat about the business. The AI model (FreeLLMAPI) reads each question, the dashboard works the answer out
// from the same numbers and settlement math as every other page, and the model writes the reply from those facts. A
// reply with a number that isn't in the facts is dropped for the dashboard's own wording. While it works, the chat
// shows each step as it happens, so it's obvious it's thinking.
import { esc, ICONS } from './util.js';
import { state } from './app.js';

const chat = []; // { role: 'user'|'assistant', text, answer?, context?, pending?, stage?, started? }
let busy = false;
let view = null;
let ticker = null;

// ---------------------------------------------------------------- rendering
const md = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
const tableHtml = (t) => `<div class="table-wrap ask-tablewrap"><table class="simple ask-table"><thead><tr>${t.head.map((h, i) => `<th class="${i ? 'r' : ''}">${esc(h)}</th>`).join('')}</tr></thead><tbody>${t.rows.map((r) => `<tr>${r.map((c, i) => `<td class="${i ? 'r num' : ''}">${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const bulletsHtml = (b) => `<ul class="ask-bullets">${b.map((x) => `<li>${md(x)}</li>`).join('')}</ul>`;

function answerHtml(a) {
  const parts = [`<div class="bubble">${md(a.text || '')}</div>`];
  if (a.bullets?.length) parts.push(bulletsHtml(a.bullets));
  if (a.table) parts.push(tableHtml(a.table));
  // The figures the reply was written from, one click away
  const f = a.facts;
  if (f && (f.text || f.bullets?.length || f.table)) {
    parts.push(`<details class="ask-facts"><summary>${ICONS.search}<span>The numbers behind this</span></summary><div class="ask-facts-body">${f.text ? `<p>${md(f.text)}</p>` : ''}${f.bullets?.length ? bulletsHtml(f.bullets) : ''}${f.table ? tableHtml(f.table) : ''}</div></details>`);
  }
  if (a.understood) {
    const by = a.writtenBy === 'model' ? 'written by FreeLLMAPI from the dashboard’s numbers' : a.writtenBy === 'dashboard' ? 'the dashboard’s own wording (the AI reply didn’t match the numbers)' : a.understood.by === 'model' ? 'read by FreeLLMAPI' : 'built-in reader';
    parts.push(`<div class="ask-read" title="How the question was read. If it's wrong, rephrase the question.">${ICONS.search}<span>Answering: <b>${esc(a.understood.label)}</b>${a.understood.period ? ` · ${esc(a.understood.period)}` : ''}${a.understood.product ? ` · “${esc(a.understood.product)}”` : ''} · ${by}</span></div>`);
  }
  return parts.join('');
}

// The thinking bubble: each step with a spinner while it runs and a check once done, plus the seconds so far
const STEPS = [
  ['reading', 'Reading your question'],
  ['numbers', 'Looking up your numbers'],
  ['writing', 'Writing the answer'],
];
function thinkingHtml(m) {
  const ai = state.data?.ai?.configured;
  const steps = ai ? STEPS : STEPS.filter(([k]) => k === 'numbers');
  const at = steps.findIndex(([k]) => k === m.stage);
  const secs = Math.max(0, Math.floor((Date.now() - m.started) / 1000));
  const rows = steps.map(([k, label], i) => {
    const st = at < 0 ? (i === 0 ? 'on' : '') : i < at ? 'done' : i === at ? 'on' : '';
    const extra = k === 'reading' && ai ? ' <span class="muted">(FreeLLMAPI)</span>' : k === 'writing' ? ' <span class="muted">(FreeLLMAPI)</span>' : k === 'numbers' && m.understood ? ` <span class="muted">· ${esc(m.understood.label)}${m.understood.period ? `, ${esc(m.understood.period)}` : ''}</span>` : '';
    return `<li class="${st}"><span class="dot">${st === 'done' ? ICONS.check : st === 'on' ? '<i class="spin"></i>' : ''}</span>${label}${extra}</li>`;
  }).join('');
  return `<div class="bubble ask-think" aria-live="polite">
    <div class="ask-think-head"><span class="ask-typing"><i></i><i></i><i></i></span><b>Thinking…</b><span class="muted ask-secs">${secs}s</span></div>
    <ol class="ask-steps">${rows}</ol>
    ${m.note ? `<div class="muted ask-think-note">${esc(m.note)}</div>` : ''}
    ${secs >= 15 ? '<div class="muted ask-think-note">Still working. Free AI models can take a little while.</div>' : ''}
  </div>`;
}

function msgHtml(m) {
  if (m.role === 'user') return `<div class="ask-msg me"><div class="bubble">${esc(m.text)}</div></div>`;
  const chips = (m.answer?.chips || []).slice(0, 3).map((c) => `<button class="ask-chip" data-q="${esc(c)}">${esc(c)}</button>`).join('');
  const body = m.pending ? thinkingHtml(m) : m.error ? `<div class="bubble">${esc(m.error)}</div>` : answerHtml(m.answer);
  return `<div class="ask-msg ai">
    <div class="ask-av${m.pending ? ' pulse' : ''}">${ICONS.spark}</div>
    <div class="ask-body">${body}${!m.pending && chips ? `<div class="ask-chips">${chips}</div>` : ''}</div>
  </div>`;
}

const SUGGEST = ['How much did we make this month?', 'Why are we down this month?', 'What does Drew owe?', 'How many sales today?', 'Which sales are awaiting the Amazon email?', 'Top products this month', 'Compare August vs September', 'What was our best day?'];

function statusHtml() {
  const ai = state.data?.ai?.configured;
  return `<div class="ask-status">${ICONS.check}<div><b>${ai ? 'Answers are written by FreeLLMAPI from your numbers.' : 'Answers come straight from your numbers.'}</b> <span class="muted">${ai ? 'Every figure is checked against the dashboard; if one doesn’t match, you get the dashboard’s own answer.' : 'Every figure is the same one the dashboard shows.'}</span></div></div>`;
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
  if (q) { q.disabled = on; q.placeholder = on ? 'Thinking…' : 'Ask about profit, settlements, products, listings…'; }
  if (b) b.disabled = on;
  view?.querySelectorAll('.ask-chip').forEach((c) => { c.disabled = on; });
}

// POST the question and follow the server's progress lines ({stage}, then {done, answer} or {error})
async function streamAsk(body, onStep) {
  const res = await fetch('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (res.status === 401) { location.href = '/login'; throw new Error('Not logged in'); }
  if (!res.ok || !res.body) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `Request failed (${res.status})`); }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let result = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.error) throw new Error(msg.error);
      if (msg.done) result = msg.answer;
      else onStep(msg);
    }
    if (done) break;
  }
  if (!result) throw new Error('The answer was cut off. Try again.');
  return result;
}

async function send(question) {
  question = question.trim();
  if (!question || busy) return;
  setBusy(true);
  const context = [...chat].reverse().find((m) => m.role === 'assistant' && m.context)?.context || null;
  const um = { role: 'user', text: question };
  const am = { role: 'assistant', pending: true, stage: null, started: Date.now() };
  chat.push(um, am);
  paintLog();
  // Tick the seconds counter without rebuilding the whole log
  ticker = setInterval(() => {
    const el = view?.querySelector('.ask-think');
    if (el && am.pending) el.outerHTML = thinkingHtml(am);
  }, 1000);
  try {
    const a = await streamAsk({ question, context }, (s) => {
      if (s.stage) am.stage = s.stage;
      if (s.understood !== undefined) am.understood = s.understood;
      if (s.note) am.note = s.note;
      paintLog();
    });
    am.answer = a;
    am.context = a.context;
  } catch (e) {
    am.error = `Something went wrong: ${e.message}`;
  }
  clearInterval(ticker);
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
  if (busy) setBusy(true);
  const q = el.querySelector('#ask-q');
  el.querySelector('#ask-form').addEventListener('submit', (e) => { e.preventDefault(); const v = q.value; q.value = ''; q.style.height = ''; send(v); });
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); el.querySelector('#ask-form').requestSubmit(); } });
  q.addEventListener('input', () => { q.style.height = ''; q.style.height = `${Math.min(140, q.scrollHeight)}px`; });
  el.querySelector('#ask-log').addEventListener('click', (e) => { const b = e.target.closest('.ask-chip'); if (b) send(b.dataset.q); });
}
