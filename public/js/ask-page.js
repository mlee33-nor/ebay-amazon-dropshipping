// Ask AI: a chat about the business, answered by a small language model that runs in this browser (WebGPU).
// Nothing is sent to an outside AI service. The model does two things: works out what is being asked
// (topic, period, product), and writes the reply. Every figure comes from the server's exact calculation;
// a reply containing a number that isn't in those figures is replaced by the figures themselves.
import { esc, api, ICONS } from './util.js';
import { state } from './app.js';

const WEBLLM = 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.85/+esm';
const MODELS = [
  { id: 'Qwen2.5-3B-Instruct-q4f16_1-MLC', name: 'Qwen 2.5 · 3B', note: 'recommended · about 2 GB' },
  { id: 'Qwen3-4B-q4f16_1-MLC', name: 'Qwen3 · 4B', note: 'smartest · about 3 GB, needs a stronger graphics chip', qwen3: true },
  { id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', name: 'Qwen 2.5 · 1.5B', note: 'lightest · about 1 GB' },
];
const store = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { return null; } };

// Survives page switches: the model stays loaded while the dashboard is open
const llm = { engine: null, model: null, status: 'off', progress: 0, text: '', error: '' };
const chat = []; // { role: 'user'|'assistant', text, facts?, route?, context?, note? }
let busy = false;
let view = null;

const hasGPU = () => typeof navigator !== 'undefined' && 'gpu' in navigator;
const modelInfo = (id) => MODELS.find((m) => m.id === id) || MODELS[0];

async function loadModel(id) {
  if (llm.status === 'loading') return;
  llm.status = 'loading'; llm.progress = 0; llm.text = 'Starting…'; llm.error = ''; llm.model = id;
  paintStatus();
  try {
    const webllm = await import(WEBLLM);
    const worker = new Worker(new URL('./llm-worker.js', import.meta.url), { type: 'module' });
    if (llm.engine) { try { await llm.engine.unload(); } catch {} }
    llm.engine = await webllm.CreateWebWorkerMLCEngine(worker, id, {
      initProgressCallback: (p) => { llm.progress = p.progress || 0; llm.text = p.text || ''; paintStatus(); },
    });
    llm.status = 'ready';
    store('dd_llm', id);
  } catch (e) {
    llm.status = 'error';
    llm.error = /webgpu|adapter|gpu/i.test(String(e?.message)) ? 'This computer’s graphics chip couldn’t run the model. Try the lightest model, or use Chrome/Edge with hardware acceleration on.' : String(e?.message || e);
    llm.engine = null;
  }
  paintStatus();
}

// ---------------------------------------------------------------- prompts
const TOPIC_HELP = `topic — pick exactly one:
- why_change: why profit or sales went up/down, what happened, explain a change
- listings_vs_sales: listings, views, watchers or traffic compared with sales ("more products posted but fewer sales")
- listings: number of listings, views, watchers, impressions
- profit: how much we made, earned, net profit, how we're doing
- sales_count: how many sales, orders or units
- revenue: revenue, payouts, gross sales
- amazon_cost: Amazon cost, COGS, how much was spent on Amazon
- fees: eBay fees, ad fees
- margin: margin or ROI
- average_order: average sale or order value
- refunds: refunds, returns, cancellations
- expenses: operating costs, subscriptions, proxies, software
- settlement: what Drew owes, sends or paid Myles; payments; due dates
- top_products: best products, best sellers
- worst_products: worst products, products losing money
- product: a question about one specific product (put its name in "product")
- compare: compare two periods
- recent_sales: the latest or most recent sales
- other: anything else`;
const EXAMPLES = [
  ['why are we down this month', { topic: 'why_change', period: 'this month', compare_to: '', product: '' }],
  ['how much did we make in august vs july', { topic: 'compare', period: 'july', compare_to: 'august', product: '' }],
  ['what does drew owe me', { topic: 'settlement', period: '', compare_to: '', product: '' }],
  ['how is the ukulele doing', { topic: 'product', period: '', compare_to: '', product: 'ukulele' }],
  ['why do we have more listings but less sales', { topic: 'listings_vs_sales', period: '', compare_to: '', product: '' }],
];
const ROUTE_SCHEMA = {
  type: 'object',
  properties: {
    topic: { type: 'string', enum: ['why_change', 'listings_vs_sales', 'listings', 'profit', 'sales_count', 'revenue', 'amazon_cost', 'fees', 'margin', 'average_order', 'refunds', 'expenses', 'settlement', 'top_products', 'worst_products', 'product', 'compare', 'recent_sales', 'other'] },
    period: { type: 'string' }, compare_to: { type: 'string' }, product: { type: 'string' },
  },
  required: ['topic', 'period', 'compare_to', 'product'],
};
const extra = () => (modelInfo(llm.model).qwen3 ? { extra_body: { enable_thinking: false } } : {});

async function route(question) {
  const sys = `You turn questions about an eBay-to-Amazon dropshipping business into a data lookup. Reply with JSON only.\n${TOPIC_HELP}\nperiod: the time words from the question ("this month", "august", "last 7 days", "last week", "all time"), or "" if none. For a follow-up with no time words, reuse the previous period.\ncompare_to: the second period when comparing two periods, else "".\nproduct: the product's name words if the question is about one item, else "".`;
  const msgs = [{ role: 'system', content: sys }];
  for (const [q, r] of EXAMPLES) msgs.push({ role: 'user', content: q }, { role: 'assistant', content: JSON.stringify(r) });
  // The last two questions give follow-ups ("what about july?") their topic
  for (const m of chat.filter((x) => x.role === 'user' && x.route).slice(-2)) msgs.push({ role: 'user', content: m.text }, { role: 'assistant', content: JSON.stringify(m.route) });
  msgs.push({ role: 'user', content: question });
  const r = await llm.engine.chat.completions.create({ messages: msgs, temperature: 0, max_tokens: 120, response_format: { type: 'json_object', schema: JSON.stringify(ROUTE_SCHEMA) }, ...extra() });
  try { return JSON.parse(r.choices[0].message.content); } catch { return null; }
}

const plain = (s) => String(s || '').replace(/\*\*/g, '');
const factsText = (f) => [plain(f.text), ...(f.bullets || []).map((b) => `- ${plain(b)}`), ...(f.table ? [f.table.head.join(' | '), ...f.table.rows.map((r) => r.join(' | '))] : [])].join('\n');

async function write(question, facts, onToken) {
  const s = state.data.settings;
  const sys = `You are the in-house analyst for a small eBay-to-Amazon dropshipping business. ${s.partner_amazon} buys the items on Amazon (pays the Amazon cost). ${s.partner_ebay} collects the eBay payouts and pays the operating costs. Profit is split ${s.split_amazon}/${100 - Number(s.split_amazon)}. Each month ${s.partner_ebay} sends ${s.partner_amazon} the Amazon cost plus ${s.partner_amazon}'s share, due on the ${s.settlement_day || 26}th of that month.
Answer the question using ONLY the FACTS. The first line of FACTS is the answer.
- Copy every number exactly as written in FACTS. Never calculate, round, estimate, subtract or add numbers of your own, and never turn a count into a percentage.
- Keep the direction words from FACTS (up/down, higher/lower, more/fewer). Never say something rose if FACTS say it went down.
- If the question assumes something FACTS contradict (it asks why we're down but FACTS say up), say that first.
- Start with the direct answer in one sentence, using the first line of FACTS.
- For "why" questions, explain the two or three biggest reasons in plain words, then give one practical suggestion based on the facts.
- For any other question, just answer it: no advice, no suggestions, no lecturing.
- If the FACTS don't answer the question, say so and say what is missing.
- Under 110 words. No headings, no tables, no bullet lists longer than 3 items.`;
  const stream = await llm.engine.chat.completions.create({
    messages: [{ role: 'system', content: sys }, { role: 'user', content: `QUESTION: ${question}\n\nFACTS:\n${factsText(facts)}` }],
    temperature: 0.1, max_tokens: 380, stream: true, ...extra(),
  });
  let out = '';
  for await (const chunk of stream) { out += chunk.choices[0]?.delta?.content || ''; onToken(out); }
  return out.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

// Every money amount, decimal or percentage in the reply must appear in the facts
const numKey = (s) => s.replace(/[$,+−-]/g, '').replace(/\.0+%$/, '%');
// A reply whose first sentence says the opposite of the figures' direction ("down" when profit is up)
function contradictsTrend(reply, facts) {
  if (!facts.trend) return false;
  const first = (reply.split(/(?<=[.!?])\s/)[0] || '').toLowerCase();
  if (/\b(not|isn'?t|aren'?t|wasn'?t|weren'?t)\s+(down|up|lower|higher)\b/.test(first)) return false; // "we're not down" is a correction
  const downish = /\b(down|lower|decreas\w*|dropp?\w*|fell|declin\w*|worse|less profit)\b/.test(first);
  const upish = /\b(up|higher|increas\w*|rose|grew|better|more profit)\b/.test(first);
  return facts.trend === 'up' ? downish && !upish : upish && !downish;
}

// The numbers in the reply that aren't in the facts (empty = every number is backed by the figures)
function unbackedNumbers(reply, facts) {
  const hay = new Set([...factsText(facts).matchAll(/[$−-]?\$?\d[\d,]*(?:\.\d+)?%?/g)].map((m) => numKey(m[0])));
  const bad = [];
  for (const m of reply.matchAll(/[$−-]?\$?\d[\d,]*(?:\.\d+)?%?/g)) {
    const raw = m[0];
    const k = numKey(raw);
    if (!/[$.%]/.test(raw) && Number(k) <= 31) continue; // small counts and day numbers
    if (!hay.has(k)) bad.push(raw);
  }
  return bad;
}

// ---------------------------------------------------------------- rendering
const md = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
function factsHtml(f, open) {
  if (!f) return '';
  const rows = [];
  if (f.bullets?.length) rows.push(`<ul class="ask-bullets">${f.bullets.map((b) => `<li>${md(b)}</li>`).join('')}</ul>`);
  if (f.table) rows.push(`<div class="table-wrap"><table class="simple ask-table"><thead><tr>${f.table.head.map((h, i) => `<th class="${i ? 'r' : ''}">${esc(h)}</th>`).join('')}</tr></thead><tbody>${f.table.rows.map((r) => `<tr>${r.map((c, i) => `<td class="${i ? 'r num' : ''}">${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
  if (!rows.length) return '';
  return `<details class="ask-facts" ${open ? 'open' : ''}><summary>${ICONS.receipt} Exact figures</summary>${rows.join('')}</details>`;
}
function msgHtml(m, i) {
  if (m.role === 'user') return `<div class="ask-msg me"><div class="bubble">${esc(m.text)}</div></div>`;
  const f = m.facts;
  const chips = (f?.chips || []).slice(0, 3).map((c) => `<button class="ask-chip" data-q="${esc(c)}">${esc(c)}</button>`).join('');
  const body = m.pending ? `<span class="ask-typing"><i></i><i></i><i></i></span>` : m.text ? md(m.text) : f ? md(f.text) : '';
  return `<div class="ask-msg ai" data-i="${i}">
    <div class="ask-av">${ICONS.spark}</div>
    <div class="ask-body">
      <div class="bubble">${body}</div>
      ${!m.pending && f && m.text ? factsHtml(f, false) : !m.pending && f ? factsHtml(f, true) : ''}
      ${m.note ? `<div class="ask-note">${esc(m.note)}</div>` : ''}
      ${!m.pending && chips ? `<div class="ask-chips">${chips}</div>` : ''}
    </div>
  </div>`;
}

const SUGGEST = ['Why are we down this month?', 'What does Drew owe Myles?', 'Top products this month', 'Compare August vs September', 'Why do we have more listings but fewer sales?', 'How many sales last week?'];

function statusHtml() {
  if (!hasGPU()) return `<div class="ask-status warn">${ICONS.info}<div><b>This browser can’t run the local AI model.</b> It needs WebGPU (Chrome or Edge on a computer). You’ll still get exact answers straight from the figures.</div></div>`;
  const pick = `<select class="select sm" id="ask-model" aria-label="AI model">${MODELS.map((m) => `<option value="${m.id}" ${m.id === (llm.model || store('dd_llm') || MODELS[0].id) ? 'selected' : ''}>${m.name}: ${m.note}</option>`).join('')}</select>`;
  if (llm.status === 'ready') return `<div class="ask-status ok"><span class="dot ok"></span><div><b>${esc(modelInfo(llm.model).name)}</b> running on this computer · private, nothing leaves your browser</div>${pick}</div>`;
  if (llm.status === 'loading') return `<div class="ask-status"><div class="ask-prog"><div style="width:${Math.round(llm.progress * 100)}%"></div></div><div class="ask-prog-t">${esc(llm.text.replace(/\s*\[.*?\]\s*/g, ' ').slice(0, 140))}</div></div>`;
  const err = llm.status === 'error' ? `<div class="ask-err">${esc(llm.error)}</div>` : '';
  return `<div class="ask-status">${ICONS.spark}<div><b>Turn on the AI model</b><div class="muted" style="font-size:12px">Runs privately on this computer. The first time downloads the model once and keeps it in the browser; after that it starts in seconds.</div>${err}</div>${pick}<button class="btn primary sm" id="ask-load">${ICONS.down} Turn on</button></div>`;
}

function paintStatus() { const s = view && view.querySelector('#ask-status'); if (s) { s.innerHTML = statusHtml(); bindStatus(); } }
function paintLog() {
  const log = view && view.querySelector('#ask-log');
  if (!log) return;
  log.innerHTML = chat.length ? chat.map(msgHtml).join('') : `<div class="ask-empty"><div class="ic">${ICONS.spark}</div><div class="t">Ask anything about the business</div><p>Profit, what’s owed, why a month is up or down, which products earn, listings vs sales.</p><div class="ask-chips center">${SUGGEST.map((q) => `<button class="ask-chip" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div></div>`;
  log.scrollTop = log.scrollHeight;
}
function bindStatus() {
  view.querySelector('#ask-load')?.addEventListener('click', () => loadModel(view.querySelector('#ask-model').value));
  view.querySelector('#ask-model')?.addEventListener('change', (e) => { if (llm.status === 'ready' && e.target.value !== llm.model) loadModel(e.target.value); });
}

// While an answer is being written the box stays locked, so a second question is never silently dropped
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
  const useModel = llm.status === 'ready';
  const prevCtx = [...chat].reverse().find((m) => m.role === 'assistant' && m.context)?.context || null;
  const um = { role: 'user', text: question };
  chat.push(um);
  const am = { role: 'assistant', pending: true };
  chat.push(am);
  paintLog();
  try {
    let r = null;
    if (useModel) { try { r = await route(question); } catch { r = null; } }
    um.route = r && r.topic !== 'other' ? r : null;
    const facts = await api('/api/ask', { method: 'POST', body: { question, context: prevCtx, route: um.route } });
    am.facts = facts;
    am.context = facts.context;
    if (useModel && facts.understood) {
      am.pending = false; am.text = '…';
      const bubble = () => view?.querySelector(`.ask-msg.ai[data-i="${chat.indexOf(am)}"] .bubble`);
      paintLog();
      const reply = await write(question, facts, (t) => { const b = bubble(); if (b) b.innerHTML = md(t); const log = view?.querySelector('#ask-log'); if (log) log.scrollTop = log.scrollHeight; });
      const bad = reply ? unbackedNumbers(reply, facts) : ['(empty reply)'];
      if (reply && contradictsTrend(reply, facts)) bad.push(`direction: figures say ${facts.trend}`);
      if (!bad.length) am.text = reply;
      else {
        console.info('[Ask AI] reply replaced by the exact figures; numbers not in the figures:', bad, reply);
        am.text = ''; am.note = 'Showing the exact figures: the AI’s wording didn’t match them.';
      }
    } else am.pending = false;
  } catch (e) {
    am.pending = false;
    am.text = `Something went wrong: ${e.message}`;
  }
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
    <div class="ask-foot">Answers use your live data. Figures are exact; the wording comes from the AI model.</div>
  </div>`;
  bindStatus();
  paintLog();
  const q = el.querySelector('#ask-q');
  el.querySelector('#ask-form').addEventListener('submit', (e) => { e.preventDefault(); const v = q.value; q.value = ''; q.style.height = ''; send(v); });
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); el.querySelector('#ask-form').requestSubmit(); } });
  q.addEventListener('input', () => { q.style.height = ''; q.style.height = `${Math.min(140, q.scrollHeight)}px`; });
  el.querySelector('#ask-log').addEventListener('click', (e) => { const b = e.target.closest('.ask-chip'); if (b) send(b.dataset.q); });
  // Start the model again automatically (from the browser cache) if it was turned on before
  if (hasGPU() && llm.status === 'off' && store('dd_llm')) loadModel(store('dd_llm'));
}
