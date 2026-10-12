// Hosted AI model for Ask AI (any OpenAI-compatible API, e.g. FreeLLMAPI). It reads every question (topic and
// period), the dashboard works out the answer from the books, and the model adds a friendly line about it. The
// dashboard's own answer always stays the headline; the model's line is thrown away when any figure in it isn't one
// of the dashboard's (or has the wrong sign, month, or payer and payee), so the figures are always the dashboard's.
// Configured with AI_API_BASE, AI_API_KEY, AI_MODEL, AI_HOST, and AI_PROXY when the model is only reachable through a
// proxy (Tailscale, set by scripts/start.sh).
import { TOPICS } from './ask.js';

// Two ways to reach a model: Anthropic's API (ANTHROPIC_API_KEY) or any OpenAI-compatible endpoint such as FreeLLMAPI
// (AI_API_BASE + AI_API_KEY). With an Anthropic key, Anthropic answers everything (no FreeLLMAPI, so nothing depends on
// a PC being on); without one, the OpenAI-compatible endpoint does.
// The key: ANTHROPIC_API_KEY, or the same name typed another way in Railway (anthropic_Api, Anthropic_API_Key...).
// ANTHROPIC_API_KEY wins whenever it is defined, even empty (the tests set it empty so a real key is never used).
const anthropicKey = () => {
  if ('ANTHROPIC_API_KEY' in process.env) return process.env.ANTHROPIC_API_KEY || '';
  const name = Object.keys(process.env).find((k) => /^anthropic[_-]?api(?:[_-]?key)?$/i.test(k));
  return name ? process.env[name] || '' : '';
};
const anthropicOn = () => Boolean(anthropicKey());
const compatOn = () => Boolean(process.env.AI_API_BASE && process.env.AI_API_KEY);
export const llmConfigured = () => anthropicOn() || compatOn();
const ANTHROPIC_DEFAULT = 'claude-sonnet-5-5';
const anthropicModel = () => process.env.ANTHROPIC_MODEL || ANTHROPIC_DEFAULT;
const anthropicBase = () => String(process.env.ANTHROPIC_API_BASE || 'https://api.anthropic.com').replace(/\/+$/, '');
const providers = () => (anthropicOn() ? ['anthropic'] : compatOn() ? ['compat'] : []);
export const llmProvider = () => (anthropicOn() ? `Anthropic ${anthropicModel()}` : compatOn() ? 'OpenAI-compatible' : null);
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
- settlement: what Drew owes, sends or paid Myles; payments; due dates; whether Drew paid for a month or an item (put the item in "product")
- top_products: best products, best sellers
- worst_products: worst products, products losing money, what to stop selling
- product: a question about one specific product (put its name in "product")
- compare: compare two periods, including "up or down vs August", "better than last month", "compared to July" (when only one period is named, put it in "period" and "this month" in "compare_to"). A range like "Sep 27 to Oct 10" or "from July to September" is ONE period, not a comparison.
- recent_sales: the latest sales, or what sold on a day
- awaiting_amazon: sales not yet bought on Amazon / waiting for the Amazon email
- best_period: best or worst day, week or month
- promotions: promoted listings, ads, advertising, campaigns, ad rates, whether ads or promotion paid off
- other: anything else
period: the time words from the question, copied as written ("this month", "august", "last 7 days", "last week", "all time", "since sep 27", "sep 27 to oct 10", "between 9/27 and 10/10", "september pay cycle", "this pay period"), or "" if none.
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

// One chat request to the provider for this try: the reply text, or null for an error reply
async function chat(messages, signal, { maxTokens = 800, attempt = 0 } = {}) {
  const list = providers();
  const which = list[Math.min(attempt, list.length - 1)];
  return which === 'anthropic' ? chatAnthropic(messages, signal, maxTokens) : chatCompat(messages, signal, maxTokens);
}

// Anthropic Messages API. The system prompt goes in "system"; the key is sent only to Anthropic and never logged.
async function chatAnthropic(messages, signal, maxTokens) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const res = await fetch(`${anthropicBase()}/v1/messages`, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', 'x-api-key': anthropicKey(), 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: anthropicModel(), max_tokens: maxTokens, temperature: 0, system, messages: messages.filter((m) => m.role !== 'system') }),
  });
  if (!res.ok) { console.error(`AI model (Anthropic): ${res.status} ${(await res.text()).slice(0, 200)}`); return null; }
  const body = await res.json();
  if (body?.stop_reason === 'max_tokens') { console.error('AI model (Anthropic): reply was cut off, asking again'); return null; }
  return (body?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('') || null;
}

async function chatCompat(messages, signal, maxTokens) {
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
  let tries = 0;
  for (const ms of [Math.round(timeoutMs * 0.4), null]) { // a stalled first provider is dropped sooner
    const limit = ms ?? deadline - Date.now();
    if (limit < 50) break;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), limit);
    try {
      const r = await fn(ctl.signal, tries++);
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
// `prev` is what the previous question was about ({ intent, period, product }), so follow-ups ("and July?", "what
// about refunds") read right.
export async function routeQuestion(question, { prev = null, timeoutMs = Number(process.env.AI_TIMEOUT_MS || 40000) } = {}) {
  if (!llmConfigured()) return null;
  const about = prev?.intent ? [prev.intent, prev.period?.label, Array.isArray(prev.product) && prev.product.length ? `product "${prev.product.join(' ')}"` : null].filter(Boolean).join(', ') : '';
  const before = about ? `\n(The previous question was about: ${about}. A short follow-up like "and July?" or "what about refunds" keeps that period and product unless it names new ones.)` : '';
  return twoTries(async (signal, attempt) => {
    const r = firstJson(await chat([{ role: 'system', content: SYSTEM + before }, { role: 'user', content: String(question).slice(0, 500) }], signal, { attempt }));
    if (!r || typeof r.topic !== 'string' || !TOPICS[r.topic]) return null;
    const str = (v) => (typeof v === 'string' ? v.slice(0, 80) : '');
    return { topic: r.topic, period: str(r.period), compare_to: str(r.compare_to), product: str(r.product) };
  }, timeoutMs);
}

const WRITER = `You are the assistant in a small eBay-to-Amazon dropshipping business's dashboard. Myles buys the items on Amazon; Drew collects the eBay payouts, pays operating costs and sends Myles his money on the 26th. Profit is split 50/50.
The dashboard's own answer is shown above yours. Add one to three short, friendly sentences about it, using ONLY the facts below, which the dashboard worked out from the books.
Rules:
- Copy every number exactly as it appears in the facts (same dollar amounts, counts, dates and percentages), with its minus sign: −$15.07 is a loss, never "made $15.07".
- Never calculate, add, subtract, round, estimate or invent a number.
- Keep who pays whom, and whether something is paid, owed or still building up, exactly as the facts say.
- Keep each figure with the month or payment the facts give it.
- Don't mention anything that isn't in the facts. If the facts don't answer the question, say what they do show.
- No headings or lists. You may put the single most important figure in **bold**.`;

// ---------------------------------------------------------------- checking a written reply against the facts
// A reply is only shown when every figure in it is one the dashboard worked out, with the same sign, for the same
// month, and with the same payer and payee. Anything else and the dashboard's own wording stands alone.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_WORD = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/gi;
// Months named in a sentence ("May" only with a capital: "may" is an ordinary word)
const monthsIn = (s) => new Set([...String(s).matchAll(MONTH_WORD)].filter((m) => m[1] !== 'may').map((m) => MONTHS.indexOf(m[1].slice(0, 3).toLowerCase())));
const sentences = (s) => String(s).split(/\n+|(?<=[.!?])\s+(?=[A-Z*“"(])/).map((x) => x.trim()).filter(Boolean);
// Every figure in a text: { v (signed, as a number), kind: 'money' | 'pct' | 'num' }. A minus sign counts when it is
// "−" (the dashboard's) or a hyphen right before "$" ("-$15.07"); hyphens in order numbers and ranges don't.
function figuresIn(s) {
  const out = [];
  for (const m of String(s).matchAll(/(−\s?|-(?=\$))?(\$\s?)?(\d[\d,]*(?:\.\d+)?)(\s?%|\s?(?:dollars?|bucks)\b)?/gi)) {
    const n = Number(m[3].replace(/,/g, ''));
    if (!Number.isFinite(n)) continue;
    const money = Boolean(m[2]) || /dollar|buck/i.test(m[4] || '');
    out.push({ v: m[1] ? -n : n, raw: m[3], kind: money ? 'money' : m[4] && m[4].includes('%') ? 'pct' : 'num' });
  }
  return out;
}
// Who pays whom in a text, as "payer>payee" ("Drew owes Myles", "for Drew to send Myles", "Myles owes $15.15 to Drew",
// "Myles gets $5 from Drew", "Drew is owed $15.15 by Myles"). "you" is a party too: replies are written to the reader.
function directionsIn(s, names) {
  const who = [...names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'you'].join('|');
  const verb = '(?:still\\s+|also\\s+|already\\s+|now\\s+)?(?:(?:needs?|has|have|had|should|will|would|must|is going)\\s+(?:to\\s+)?)?(?:to\\s+)?(?:owes?|owed|owing|sends?|sent|sending|pays?|paid|paying|transfers?|transferred|gives?|gave|reimburses?|reimbursed)';
  const pairs = new Set();
  // "X owes Y", "X owes $5 to Y" (an amount or a few words may sit between the verb and "to Y")
  for (const m of String(s).matchAll(new RegExp(`\\b(${who})\\b(?:'s)?\\s+${verb}\\s+(?:back\\s+)?(?:(?:to\\s+)?(${who})\\b|.{0,40}?\\bto\\s+(${who})\\b)`, 'gi'))) pairs.add(`${m[1].toLowerCase()}>${(m[2] || m[3]).toLowerCase()}`);
  // "Y gets $5 from X", "Y is owed $5 by X"
  for (const m of String(s).matchAll(new RegExp(`\\b(${who})\\b\\s+(?:(?:is|are|was|were)\\s+owed\\b.{0,60}?\\b(?:by|from)|(?:gets|got|receives|received|will get|is getting|should get)\\b.{0,60}?\\bfrom)\\s+(${who})\\b`, 'gi'))) pairs.add(`${m[2].toLowerCase()}>${m[1].toLowerCase()}`);
  return pairs;
}
// The reader may be either partner, so "you owe ..." / "... is owed by you" is never safe to show
const YOU_PAY = /\byou\s+(?:still\s+|also\s+|now\s+)?(?:owe|owed|need\s+to\s+(?:pay|send)|have\s+to\s+(?:pay|send)|should\s+(?:pay|send|give)|must\s+(?:pay|send))\b|\bowed\b.{0,60}?\bby\s+you\b/i;
// A loss may be written as a positive amount only right after a loss word ("lost $15.07", "down **$50.99**"), and
// never in a sentence that also calls it a gain
const lossBefore = (s, raw) => new RegExp(`\\b(?:lost|loss of|losing|down|negative|minus|deficit of|short|in the red by)\\s+(?:by\\s+)?\\**\\$?\\s?${raw.replace(/[.]/g, '\\.')}(?![\\d.])`, 'i').test(s);
const GAIN = /\b(?:made|make|making|earned|earn|gained|gain|profit (?:is|was|of)|in the black|not a loss|no loss)\b|\bup\s+\**\$/i;
const SETTLED = /\b(paid in full|in full|fully paid|all paid|paid up|nothing (?:is |was )?(?:owed|due|outstanding)|(?:doesn'?t|does not|don'?t) owe|owes nothing|squared up|settled up|all settled|covers it exactly|exactly what it came to)\b/i;
const OWED = /\b(still owed|still owes?|owes?|owed|unpaid|not paid|outstanding|overdue|not due yet|isn'?t due)\b/i;
// What a figure is in its clause: paid, owed, or a payment's total so far. The closest role word wins.
const ROLES = [['paid', /\b(?:paid|sent)\b/gi], ['owed', /\b(?:still owed|owes?|owed|owing|outstanding|unpaid)\b/gi], ['total', /\b(?:(?<!paid )so far|comes to|came to|coming to)\b/gi]]; // "paid so far" is paid
const clauses = (s) => String(s).split(/,(?!\d)|;|\s(?:and|but|while|so)\s(?!far\b)/i);
function rolesIn(s) {
  const out = []; // { cents, role }
  for (const c of clauses(s)) {
    const words = ROLES.flatMap(([role, re]) => [...c.matchAll(re)].map((m) => ({ role, at: m.index, end: m.index + m[0].length })));
    for (const m of c.matchAll(/(−\s?|-(?=\$))?\$\s?(\d[\d,]*(?:\.\d+)?)/g)) {
      const at = m.index; const end = at + m[0].length;
      const near = words.map((w) => ({ ...w, d: w.end <= at ? at - w.end : w.at >= end ? w.at - end : 0 })).sort((x, y) => x.d - y.d)[0];
      // A role word more than a few words away is about something else ("lost $15.07 on the October payment so far")
      out.push({ k: Math.round(Number(m[2].replace(/,/g, '')) * 100), role: near && near.d <= 20 ? near.role : null });
    }
  }
  return out;
}
// The months a sentence puts its figures on. The dates of a payment's sales ("(sales Sep 27–Oct 26)") and its due
// day are not the payment's month: "October payment (sales Sep 27–Oct 26): $240.87" is October's only.
const undated = (s) => String(s).replace(/\(sales [^)]*\)/gi, ' ').replace(/\bdue\s+[A-Z][a-z]{2,8}\.?\s+\d{1,2}\b/g, ' ');
function figureMonths(s) {
  const t = undated(s);
  const pay = [...t.matchAll(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|May|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+payment\b/gi)].map((m) => MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()));
  const all = pay.length ? new Set(pay) : monthsIn(t);
  const out = new Map(); // cents (abs) -> months
  for (const m of t.matchAll(/(−\s?|-(?=\$))?\$\s?(\d[\d,]*(?:\.\d+)?)/g)) {
    const k = Math.round(Number(m[2].replace(/,/g, '')) * 100) * (m[1] ? -1 : 1);
    // "Sep $704.40" (a month written right before the amount) is that month's
    const own = t.slice(Math.max(0, m.index - 12), m.index).match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*$/i);
    out.set(k, own ? new Set([MONTHS.indexOf(own[1].toLowerCase())]) : all);
  }
  return out;
}
// The facts as plain lines: the dashboard's headline, its bullets and its table
const factLines = (facts) => [facts.text, ...(facts.bullets || []), ...(facts.table ? [facts.table.head.join(' | '), ...facts.table.rows.map((r) => r.join(' | '))] : [])]
  .filter(Boolean).map((l) => String(l).replace(/\*\*/g, ''));

// The problems with a written reply (an empty list means it can be shown). Money and percentages must be figures in
// the facts: never a number only from the question, a product title or these instructions. Plain numbers (counts,
// days, order numbers) may also come from the question. `facts.partners` ([Myles, Drew]) names who can pay whom.
export function checkReply(text, facts, question = '') {
  const [A, B] = facts.partners || ['Myles', 'Drew'];
  const factText = factLines(facts).join('\n');
  const problems = [];
  const money = new Map(); // signed cents -> months the facts put it on (empty: no month)
  const roles = new Map(); // cents (no sign) -> what the facts call it: paid, owed, or a payment's total so far
  const pcts = new Set();
  const factNums = new Set(figuresIn(factText).filter((f) => f.kind === 'num').map((f) => Math.abs(f.v)));
  const plain = new Set([...factNums, ...figuresIn(question).filter((f) => f.kind === 'num').map((f) => Math.abs(f.v))]);
  const moneyAbs = new Set(figuresIn(factText).filter((f) => f.kind === 'money').map((f) => Math.abs(f.v)));
  for (const s of sentences(factText)) {
    for (const f of figuresIn(s)) if (f.kind === 'pct') pcts.add(Math.abs(f.v));
    for (const [k, mos] of figureMonths(s)) {
      if (!money.has(k)) money.set(k, new Set());
      for (const mo of mos) money.get(k).add(mo);
    }
    for (const r of rolesIn(s)) {
      if (!roles.has(r.k)) roles.set(r.k, new Set());
      if (r.role) roles.get(r.k).add(r.role);
    }
  }
  for (const s of sentences(text)) {
    const months = monthsIn(undated(s));
    for (const f of figuresIn(s)) {
      // A dollar amount from the facts written without its "$" ("Drew paid 704.40") is still checked as money
      if (f.kind === 'num' && /\.\d\d$/.test(f.raw) && moneyAbs.has(Math.abs(f.v)) && !factNums.has(Math.abs(f.v))) f.kind = 'money';
      if (f.kind === 'pct') { if (!pcts.has(Math.abs(f.v))) problems.push(`${f.v}% isn't in the facts`); continue; }
      if (f.kind === 'num') { if (!plain.has(Math.abs(f.v))) problems.push(`${f.v} isn't in the facts`); continue; }
      const k = Math.round(f.v * 100);
      // A loss may be written as a positive amount right after a loss word ("we lost $15.07"), never as a gain
      const key = money.has(k) ? k : k > 0 && money.has(-k) && lossBefore(s, f.raw) && !GAIN.test(s) ? -k : null;
      if (key === null) { problems.push(money.has(-k) ? `$${f.v} has the wrong sign` : `$${f.v} isn't in the facts`); continue; }
      const factMonths = money.get(key);
      if (months.size && factMonths.size && ![...months].some((m) => factMonths.has(m))) problems.push(`$${Math.abs(f.v)} is put on a different month`);
    }
    // Paid, owed or so far: each amount keeps what the facts call it ("Drew paid $15.15" when $15.15 is what's owed).
    // "So far" on a figure the facts never call paid or owed ("profit is −$50.99 so far") is just a running total.
    for (const r of rolesIn(s)) {
      const fr = roles.get(r.k) || new Set();
      if (r.role === 'total' && !fr.has('paid') && !fr.has('owed')) continue;
      if (r.role && !fr.has(r.role)) problems.push(`$${(r.k / 100).toFixed(2)} is called ${r.role} when the facts don't`);
    }
  }
  // "Did Drew pay?": the reply can't say Yes when the dashboard says Partly, No or Not yet (or the other way round),
  // and can't call something paid or owed when the facts don't
  const lead = (s) => (String(s).replace(/\*\*/g, '').match(/^\s*(yes|no|partly|not yet)\b/i) || [])[1]?.toLowerCase() || null;
  const fl = lead(facts.text); const rl = lead(text);
  if (fl && rl && fl !== rl) problems.push(`it says "${rl}" where the dashboard says "${fl}"`);
  if (SETTLED.test(text) && !SETTLED.test(factText)) problems.push("it says it's paid up when the facts don't");
  if (OWED.test(text) && !OWED.test(factText)) problems.push("it says money is owed when the facts don't");
  // Who pays whom: every direction in the reply must be one the facts give. With none in the facts, only the usual
  // one (Drew pays Myles) is allowed. "You" may be either partner, so it is never the payer, and "Drew owes you" is
  // only kept when the facts have Drew paying the other partner.
  if (YOU_PAY.test(text)) problems.push('it tells the reader "you" owe money, and the reader may be either partner');
  const factDirs = directionsIn(factText, [A, B]);
  const usual = `${B.toLowerCase()}>${A.toLowerCase()}`;
  const other = (x) => (x === A.toLowerCase() ? B.toLowerCase() : A.toLowerCase());
  for (const d of directionsIn(text, [A, B])) {
    let [x, y] = d.split('>');
    if (x === y) continue;
    if (x === 'you') { if (!problems.some((p) => p.includes('"you"'))) problems.push('it tells the reader "you" owe money, and the reader may be either partner'); continue; }
    if (y === 'you') y = other(x);
    const pair = `${x}>${y}`;
    if (!factDirs.has(pair) && (factDirs.size || pair !== usual)) problems.push(`"${pair.replace('>', ' pays ')}" isn't who pays whom in the facts`);
  }
  return problems;
}

// The model's friendly line about an answer the dashboard computed, or null. The dashboard's own answer stays the
// headline; this is shown under it only if checkReply finds nothing wrong (so no figure can be made up or flipped).
export async function writeAnswer(question, facts, { timeoutMs = Number(process.env.AI_WRITE_TIMEOUT_MS || 40000) } = {}) {
  if (!llmConfigured()) return null;
  const lines = factLines(facts);
  return twoTries(async (signal, attempt) => {
    const out = await chat([{ role: 'system', content: WRITER }, { role: 'user', content: `Question: ${String(question).slice(0, 500)}\n\nFacts:\n${lines.map((l) => `- ${l}`).join('\n')}` }], signal, { maxTokens: 1200, attempt });
    const text = String(out || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    if (!text) return null;
    const bad = checkReply(text, facts, question);
    if (bad.length) { console.error(`AI model: reply didn't match the facts (${bad.slice(0, 3).join('; ')}); showing the dashboard's answer`); return null; }
    return text.slice(0, 1500);
  }, timeoutMs);
}

// Startup check for the deploy log: can the server reach the model? Logs the outcome only, never the key.
export async function checkModel({ timeoutMs = 15000 } = {}) {
  if (!llmConfigured()) return false;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  if (anthropicOn()) {
    try {
      const res = await fetch(`${anthropicBase()}/v1/models`, { signal: ctl.signal, headers: { 'x-api-key': anthropicKey(), 'anthropic-version': '2023-06-01' } });
      console.log(res.ok ? `AI model: Anthropic reachable, using ${anthropicModel()}` : `AI model: Anthropic answered ${res.status} (check ANTHROPIC_API_KEY)`);
      return res.ok;
    } catch (e) {
      console.error(`AI model: can't reach Anthropic: ${e.name === 'AbortError' ? 'timed out' : e.message}`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
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
