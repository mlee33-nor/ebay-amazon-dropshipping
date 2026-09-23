// Ask AI: a chat about the business. Every answer is written by the dashboard from the same numbers and
// settlement math as every other page, so it can't state anything that isn't true. Questions are read by a
// built-in reader (everyday phrasing, typos, follow-ups). A small language model that runs privately in this
// browser (WebGPU) is only consulted for a question the reader couldn't place: it names the topic and period,
// never the answer.
import { esc, api, ICONS } from './util.js';

const WEBLLM = 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.85/+esm';
const MODELS = [
  { id: 'Qwen2.5-3B-Instruct-q4f16_1-MLC', name: 'Qwen 2.5 · 3B', note: 'recommended · about 2 GB' },
  { id: 'Qwen3-4B-q4f16_1-MLC', name: 'Qwen3 · 4B', note: 'smartest · about 3 GB, needs a stronger graphics chip', qwen3: true },
  { id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', name: 'Qwen 2.5 · 1.5B', note: 'lightest · about 1 GB' },
];
const store = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { return null; } };

// Survives page switches: the model stays loaded while the dashboard is open
const llm = { engine: null, model: null, status: 'off', progress: 0, text: '', error: '' };
const chat = []; // { role: 'user'|'assistant', text, answer?, context?, route? }
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

// ---------------------------------------------------------------- the model's only job: name the topic and period
const TOPIC_HELP = `topic — pick exactly one:
- why_change: why profit or sales went up/down, what happened, explain a change
- listings_vs_sales: listings, views, watchers or traffic compared with sales
- listings: number of listings, views, watchers, impressions, listings to remove
- profit: how much we made, earned, net profit, how we're doing
- sales_count: how many sales, orders or units
- revenue: revenue, payouts, what eBay paid us
- amazon_cost: Amazon cost, what was spent on Amazon
- fees: eBay fees, ad fees
- margin: margin or ROI
- average_order: average sale or order value
- refunds: refunds, returns, cancellations
- expenses: operating costs, subscriptions, proxies, software
- settlement: what Drew owes, sends or paid Myles; payments; due dates
- top_products: best products, best sellers
- worst_products: worst products, products losing money, what to stop selling
- product: a question about one specific product (put its name in "product")
- compare: compare two periods
- recent_sales: the latest sales, or what sold on a day
- awaiting_amazon: sales not yet bought on Amazon / waiting for the Amazon email
- best_period: best or worst day, week or month
- promotions: promoted listings, campaigns, ad rates, what share of listings is promoted
- other: anything else`;
const EXAMPLES = [
  ['why are we down this month', { topic: 'why_change', period: 'this month', compare_to: '', product: '' }],
  ['how much did we make in august vs july', { topic: 'compare', period: 'july', compare_to: 'august', product: '' }],
  ['what does drew owe me', { topic: 'settlement', period: '', compare_to: '', product: '' }],
  ['how is the ukulele doing', { topic: 'product', period: '', compare_to: '', product: 'ukulele' }],
  ['anything we still have to buy on amazon', { topic: 'awaiting_amazon', period: '', compare_to: '', product: '' }],
];
const ROUTE_SCHEMA = {
  type: 'object',
  properties: {
    topic: { type: 'string', enum: ['why_change', 'listings_vs_sales', 'listings', 'profit', 'sales_count', 'revenue', 'amazon_cost', 'fees', 'margin', 'average_order', 'refunds', 'expenses', 'settlement', 'top_products', 'worst_products', 'product', 'compare', 'recent_sales', 'awaiting_amazon', 'best_period', 'promotions', 'other'] },
    period: { type: 'string' }, compare_to: { type: 'string' }, product: { type: 'string' },
  },
  required: ['topic', 'period', 'compare_to', 'product'],
};
const extra = () => (modelInfo(llm.model).qwen3 ? { extra_body: { enable_thinking: false } } : {});

async function route(question) {
  const sys = `You turn questions about an eBay-to-Amazon dropshipping business into a data lookup. Reply with JSON only.\n${TOPIC_HELP}\nperiod: the time words from the question ("this month", "august", "last 7 days", "last week", "all time"), or "" if none.\ncompare_to: the second period when comparing two periods, else "".\nproduct: the product's name words if the question is about one item, else "".`;
  const msgs = [{ role: 'system', content: sys }];
  for (const [q, r] of EXAMPLES) msgs.push({ role: 'user', content: q }, { role: 'assistant', content: JSON.stringify(r) });
  for (const m of chat.filter((x) => x.role === 'user' && x.route).slice(-2)) msgs.push({ role: 'user', content: m.text }, { role: 'assistant', content: JSON.stringify(m.route) });
  msgs.push({ role: 'user', content: question });
  const r = await llm.engine.chat.completions.create({ messages: msgs, temperature: 0, max_tokens: 120, response_format: { type: 'json_object', schema: JSON.stringify(ROUTE_SCHEMA) }, ...extra() });
  try { return JSON.parse(r.choices[0].message.content); } catch { return null; }
}

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
  const lead = `${ICONS.check}<div><b>Answers come straight from your numbers.</b> <span class="muted">Every figure is the same one the dashboard shows.</span></div>`;
  if (!hasGPU()) return `<div class="ask-status">${lead}</div>`;
  const pick = `<select class="select sm" id="ask-model" aria-label="AI model">${MODELS.map((m) => `<option value="${m.id}" ${m.id === (llm.model || store('dd_llm') || MODELS[0].id) ? 'selected' : ''}>${m.name}: ${m.note}</option>`).join('')}</select>`;
  if (llm.status === 'ready') return `<div class="ask-status">${lead}<span class="ask-model-on"><span class="dot ok"></span>${esc(modelInfo(llm.model).name)} helps with unusual questions</span></div>`;
  if (llm.status === 'loading') return `<div class="ask-status">${lead}<div class="ask-prog"><div style="width:${Math.round(llm.progress * 100)}%"></div></div><div class="ask-prog-t">${esc(llm.text.replace(/\s*\[.*?\]\s*/g, ' ').slice(0, 140))}</div></div>`;
  const err = llm.status === 'error' ? `<div class="ask-err">${esc(llm.error)}</div>` : '';
  return `<div class="ask-status">${lead}<details class="ask-model-opt"><summary>Optional: AI model for unusual questions</summary><div class="muted" style="font-size:12px;margin:6px 0 8px">Runs privately on this computer and only helps read questions the built-in reader doesn't recognise. It never writes the answer. The first time downloads it once.</div>${err}<div class="row" style="gap:8px">${pick}<button class="btn sm" id="ask-load">${ICONS.down} Turn on</button></div></details></div>`;
}

function paintStatus() { const s = view && view.querySelector('#ask-status'); if (s) { s.innerHTML = statusHtml(); bindStatus(); } }
function paintLog() {
  const log = view && view.querySelector('#ask-log');
  if (!log) return;
  log.innerHTML = chat.length ? chat.map(msgHtml).join('') : `<div class="ask-empty"><div class="ic">${ICONS.spark}</div><div class="t">Ask anything about the business</div><p>Profit, what’s owed, why a month is up or down, which products earn, what sold today, listings.</p><div class="ask-chips center">${SUGGEST.map((q) => `<button class="ask-chip" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div></div>`;
  log.scrollTop = log.scrollHeight;
}
function bindStatus() {
  view.querySelector('#ask-load')?.addEventListener('click', () => loadModel(view.querySelector('#ask-model').value));
  view.querySelector('#ask-model')?.addEventListener('change', (e) => { if (llm.status === 'ready' && e.target.value !== llm.model) loadModel(e.target.value); });
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
    let a = await api('/api/ask', { method: 'POST', body: { question, context } });
    // Not recognised: let the model (if it's on) name the topic and period, then ask again
    if (!a.understood && llm.status === 'ready') {
      let r = null;
      try { r = await route(question); } catch { r = null; }
      if (r && r.topic !== 'other') {
        um.route = r;
        const b = await api('/api/ask', { method: 'POST', body: { question, context, route: r } });
        if (b.understood) a = b;
      }
    }
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
