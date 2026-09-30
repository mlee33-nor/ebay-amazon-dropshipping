// Hosted AI model for Ask AI (any OpenAI-compatible API, e.g. FreeLLMAPI). It reads every question (topic and
// period), the dashboard works out the answer from the books, and the model writes it in its own words from those
// facts. A reply with any number that isn't in the facts is thrown away, so the figures are always the dashboard's.
// Configured with AI_API_BASE, AI_API_KEY, AI_MODEL, AI_HOST, and AI_PROXY when the model is only reachable through a
// proxy (Tailscale, set by scripts/start.sh).
import { TOPICS } from './ask.js';

export const llmConfigured = () => Boolean(process.env.AI_API_BASE && process.env.AI_API_KEY);
const base = () => String(process.env.AI_API_BASE || '').replace(/\/+$/, '');
const model = () => process.env.AI_MODEL || 'auto';

const SYSTEM = `You turn questions about an eBay-to-Amazon dropshipping business into a data lookup.
Reply with one JSON object and nothing else: {"topic": "...", "period": "...", "compare_to": "...", "product": "..."}
topic, pick exactly one:
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
- compare: compare two periods, including "up or down vs August", "better than last month", "compared to July" (when only one period is named, put it in "period" and "this month" in "compare_to")
- recent_sales: the latest sales, or what sold on a day
- awaiting_amazon: sales not yet bought on Amazon / waiting for the Amazon email
- best_period: best or worst day, week or month
- promotions: promoted listings, ads, advertising, campaigns, ad rates, whether ads or promotion paid off
- other: anything else
period: the time words from the question ("this month", "august", "last 7 days", "last week", "all time"), or "" if none.
compare_to: the second period when comparing two periods, else "".
product: the product's name words if the question is about one item, else "".`;

// Pull the first JSON object out of a reply (some providers wrap it in text or code fences)
function firstJson(s) {
  const m = String(s || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// Through AI_PROXY (an HTTP proxy, e.g. Tailscale's) when set. AI_HOST sends that Host name while connecting to the
// address in AI_API_BASE: Tailscale's proxy can't look up tailnet names, so the base is the PC's Tailscale IP and
// `tailscale serve` still needs its name to route the request. fetch() can't set Host, so this uses undici.request.
let dispatcher;
async function send(url, { method = 'GET', headers = {}, body, signal } = {}) {
  const u = await import('undici');
  if (process.env.AI_PROXY && !dispatcher) dispatcher = new u.ProxyAgent(process.env.AI_PROXY);
  const h = { ...headers, ...(process.env.AI_HOST ? { host: process.env.AI_HOST } : {}) };
  const res = await u.request(url, { method, headers: h, body, signal, ...(process.env.AI_PROXY ? { dispatcher } : {}) });
  const text = await res.body.text();
  return { ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: async () => text, json: async () => JSON.parse(text) };
}

// One chat request: the reply text, or null for an error reply
async function chat(messages, signal, { maxTokens = 800 } = {}) {
  const res = await send(`${base()}/chat/completions`, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.AI_API_KEY}` },
    body: JSON.stringify({ model: model(), temperature: 0, max_tokens: maxTokens, messages }), // room for providers that think first
  });
  if (!res.ok) { console.error(`AI model: ${res.status} ${(await res.text()).slice(0, 200)}`); return null; }
  const body = await res.json();
  // A reply cut off at the length limit (a provider that spent it thinking) is not an answer
  if (body?.choices?.[0]?.finish_reason === 'length') { console.error('AI model: reply was cut off, asking again'); return null; }
  return body?.choices?.[0]?.message?.content ?? null;
}

// Up to two tries, one after the other (a router like FreeLLMAPI's "auto" may give the second try to another
// provider). The first gets 40% of the time, the second the rest, so the whole wait is at most timeoutMs.
async function twoTries(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (const ms of [Math.round(timeoutMs * 0.4), null]) { // a stalled first provider is dropped sooner
    const limit = ms ?? deadline - Date.now();
    if (limit < 50) break;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), limit);
    try {
      const r = await fn(ctl.signal);
      if (r) return r;
    } catch (e) {
      console.error(`AI model: ${e.name === 'AbortError' ? 'timed out' : e.message}`);
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

// { topic, period, compare_to, product } or null (not configured, failed, timed out, or an unknown topic).
// `prev` is what the previous question was about ({ intent, period }), so follow-ups ("and July?") read right.
export async function routeQuestion(question, { prev = null, timeoutMs = Number(process.env.AI_TIMEOUT_MS || 40000) } = {}) {
  if (!llmConfigured()) return null;
  const before = prev?.intent ? `\n(The previous question was about: ${prev.intent}${prev.period?.label ? `, ${prev.period.label}` : ''}. A short follow-up like "and July?" keeps that topic.)` : '';
  return twoTries(async (signal) => {
    const r = firstJson(await chat([{ role: 'system', content: SYSTEM + before }, { role: 'user', content: String(question).slice(0, 500) }], signal));
    if (!r || typeof r.topic !== 'string' || !TOPICS[r.topic]) return null;
    const str = (v) => (typeof v === 'string' ? v.slice(0, 80) : '');
    return { topic: r.topic, period: str(r.period), compare_to: str(r.compare_to), product: str(r.product) };
  }, timeoutMs);
}

const WRITER = `You are the assistant in a small eBay-to-Amazon dropshipping business's dashboard. Myles buys the items on Amazon; Drew collects the eBay payouts, pays operating costs and sends Myles his money on the 26th. Profit is split 50/50.
Answer the user's question in plain, friendly words using ONLY the facts below, which the dashboard worked out from the books.
Rules:
- Copy every number exactly as it appears in the facts (same dollar amounts, counts, dates and percentages).
- Never calculate, add, subtract, round, estimate or invent a number.
- Keep who pays whom, and whether something is paid, owed or still building up, exactly as the facts say.
- Don't mention anything that isn't in the facts. If the facts don't answer the question, say what they do show.
- 1 to 4 short sentences, no headings or lists. You may put the single most important figure in **bold**.`;

// Every number in a text, normalized ("$1,304.76" -> "1304.76", "7.0%" -> "7")
const numbersIn = (s) => (String(s).match(/\d[\d,]*(?:\.\d+)?/g) || []).map((n) => String(Number(n.replace(/,/g, ''))));

// The model's wording of an answer the dashboard computed, or null. The facts are the dashboard's own answer; the
// reply is used only if every number in it appears in those facts or in the question (so no figure can be made up).
export async function writeAnswer(question, facts, { timeoutMs = Number(process.env.AI_WRITE_TIMEOUT_MS || 40000) } = {}) {
  if (!llmConfigured()) return null;
  const lines = [facts.text, ...(facts.bullets || []), ...(facts.table ? [facts.table.head.join(' | '), ...facts.table.rows.map((r) => r.join(' | '))] : [])]
    .filter(Boolean).map((l) => String(l).replace(/\*\*/g, ''));
  const allowed = new Set([...numbersIn(lines.join('\n')), ...numbersIn(question), ...numbersIn(WRITER)]); // + the 50/50 split, the 26th
  return twoTries(async (signal) => {
    const out = await chat([{ role: 'system', content: WRITER }, { role: 'user', content: `Question: ${String(question).slice(0, 500)}\n\nFacts:\n${lines.map((l) => `- ${l}`).join('\n')}` }], signal, { maxTokens: 1200 });
    const text = String(out || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    if (!text) return null;
    const bad = numbersIn(text).filter((n) => !allowed.has(n));
    if (bad.length) { console.error(`AI model: reply used numbers not in the facts (${bad.slice(0, 5).join(', ')}); showing the dashboard's answer`); return null; }
    return text.slice(0, 1500);
  }, timeoutMs);
}

// Startup check for the deploy log: can the server reach the model? Logs the outcome only, never the key.
export async function checkModel({ timeoutMs = 15000 } = {}) {
  if (!llmConfigured()) return false;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await send(`${base()}/models`, { signal: ctl.signal, headers: { authorization: `Bearer ${process.env.AI_API_KEY}` } });
    const body = await res.json().catch(() => null);
    const n = Array.isArray(body?.data) ? body.data.length : 0;
    console.log(res.ok ? `AI model: reachable (${n} models${process.env.AI_PROXY ? ', through Tailscale' : ''})` : `AI model: ${res.status} from ${base()}`);
    return res.ok;
  } catch (e) {
    console.error(`AI model: can't reach ${base()}: ${e.name === 'AbortError' ? 'timed out' : e.cause?.message || e.message}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}
