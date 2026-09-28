// Hosted AI model for Ask AI (any OpenAI-compatible API, e.g. FreeLLMAPI). Its only job is to read a question the
// built-in reader couldn't place and name the topic and period. It never sees the business's numbers and never
// writes the answer: the question text is all that is sent. Configured with AI_API_BASE, AI_API_KEY, AI_MODEL.
import { TOPICS } from './ask.js';

export const llmConfigured = () => Boolean(process.env.AI_API_BASE && process.env.AI_API_KEY);
const base = () => String(process.env.AI_API_BASE || '').replace(/\/+$/, '');
const model = () => process.env.AI_MODEL || 'auto:fast';

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
- promotions: promoted listings, campaigns, ad rates, whether promotion paid off
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

// { topic, period, compare_to, product } or null (not configured, failed, timed out, or an unknown topic)
export async function routeQuestion(question, { timeoutMs = Number(process.env.AI_TIMEOUT_MS || 12000) } = {}) {
  if (!llmConfigured()) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base()}/chat/completions`, {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.AI_API_KEY}` },
      body: JSON.stringify({
        model: model(),
        temperature: 0,
        max_tokens: 150,
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: String(question).slice(0, 500) }],
      }),
    });
    if (!res.ok) { console.error(`AI model: ${res.status} ${(await res.text()).slice(0, 200)}`); return null; }
    const body = await res.json();
    const r = firstJson(body?.choices?.[0]?.message?.content);
    if (!r || typeof r.topic !== 'string' || !TOPICS[r.topic]) return null;
    const str = (v) => (typeof v === 'string' ? v.slice(0, 80) : '');
    return { topic: r.topic, period: str(r.period), compare_to: str(r.compare_to), product: str(r.product) };
  } catch (e) {
    console.error(`AI model: ${e.name === 'AbortError' ? 'timed out' : e.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
