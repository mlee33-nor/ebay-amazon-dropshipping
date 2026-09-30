// Hosted AI model for Ask AI (any OpenAI-compatible API, e.g. FreeLLMAPI). Its only job is to read a question the
// built-in reader couldn't place and name the topic and period. It never sees the business's numbers and never
// writes the answer: the question text is all that is sent. Configured with AI_API_BASE, AI_API_KEY, AI_MODEL, and
// AI_PROXY when the model is only reachable through a proxy (Tailscale, set by scripts/start.sh).
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
- compare: compare two periods
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

// One read of the question: the topic JSON, or null for an error reply or one that isn't a known topic
async function readOnce(question, signal) {
  const res = await send(`${base()}/chat/completions`, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.AI_API_KEY}` },
    body: JSON.stringify({
      model: model(),
      temperature: 0,
      max_tokens: 800, // room for providers that think before replying
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: String(question).slice(0, 500) }],
    }),
  });
  if (!res.ok) { console.error(`AI model: ${res.status} ${(await res.text()).slice(0, 200)}`); return null; }
  const body = await res.json();
  const r = firstJson(body?.choices?.[0]?.message?.content);
  if (!r || typeof r.topic !== 'string' || !TOPICS[r.topic]) return null;
  const str = (v) => (typeof v === 'string' ? v.slice(0, 80) : '');
  return { topic: r.topic, period: str(r.period), compare_to: str(r.compare_to), product: str(r.product) };
}

// { topic, period, compare_to, product } or null (not configured, failed, timed out, or an unknown topic). A router like
// FreeLLMAPI's "auto" hands each request to some provider, and some are slow or reply with nothing usable. So a second
// request starts right away when the first fails, or after hedgeMs while it is still thinking; the first usable
// reply wins and the other is cancelled. Never more than two requests, never longer than timeoutMs.
export async function routeQuestion(question, { timeoutMs = Number(process.env.AI_TIMEOUT_MS || 15000), hedgeMs = Math.min(3500, timeoutMs * 0.4) } = {}) {
  if (!llmConfigured()) return null;
  const ctls = [];
  let launched = 0;
  let settled = 0;
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(hedge); clearTimeout(cutoff); ctls.forEach((c) => c.abort()); resolve(r); };
    const launch = () => {
      if (done || launched >= 2) return;
      launched++;
      const ctl = new AbortController();
      ctls.push(ctl);
      readOnce(question, ctl.signal)
        .catch((e) => { if (!done && e.name !== 'AbortError') console.error(`AI model: ${e.message}`); return null; })
        .then((r) => {
          settled++;
          if (r) return finish(r);
          if (launched < 2) launch(); // the first failed: ask again now rather than waiting
          else if (settled >= 2) finish(null);
        });
    };
    const hedge = setTimeout(launch, hedgeMs);
    const cutoff = setTimeout(() => { if (!done) console.error('AI model: timed out'); finish(null); }, timeoutMs);
    launch();
  });
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
