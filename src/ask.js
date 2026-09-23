// Built-in business assistant. No outside AI service: questions are understood by a tolerant parser (typos,
// follow-ups, everyday phrasing) and answered from the same data and settlement math as the dashboard, so
// every number is exact. "Why" questions get a driver analysis: what changed, and how many dollars each
// change was worth.
import { buildDataset, buildBooks } from './dataset.js';
import { getSetting } from './db.js';
import { businessDay, businessMonth } from './time.js';
import { settleMonth, allMonths } from '../public/js/settlement.js';

// ---------------------------------------------------------------- money + dates
const cents = (n) => Math.round((Number(n) || 0) * 100);
const $ = (c) => `${c < 0 ? '−' : ''}$${(Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signed$ = (c) => `${c >= 0 ? '+' : '−'}$${(Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (x, d = 1) => (x === null || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(d)}%`);
const chg = (a, b) => (b ? (a - b) / Math.abs(b) : null);
const plural = (n, w) => `${Number(n).toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`;

const toUTC = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const ymdOf = (t) => new Date(t).toISOString().slice(0, 10);
const addDays = (ymd, n) => ymdOf(toUTC(ymd) + n * 86400_000);
const monthStart = (m) => `${m}-01`;
const monthEnd = (m) => { const [y, mo] = m.split('-').map(Number); return ymdOf(Date.UTC(y, mo, 0)); };
const daysIn = (m) => Number(monthEnd(m).slice(8));
const shiftMonth = (m, n) => { const [y, mo] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mo - 1 + n, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const monthName = (m, short = false) => { const [y, mo] = m.split('-').map(Number); const n = MONTH_NAMES[mo - 1]; const s = n[0].toUpperCase() + n.slice(1, short ? 3 : undefined); return `${s} ${y}`; };
const dayLabel = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return `${MONTH_NAMES[m - 1].slice(0, 1).toUpperCase()}${MONTH_NAMES[m - 1].slice(1, 3)} ${d}`; };

// ---------------------------------------------------------------- words
const norm = (s) => String(s || '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9$.%/\s-]/g, ' ').replace(/\s+/g, ' ').trim();
const tokens = (s) => norm(s).split(/[\s/-]+/).filter(Boolean);
// Optimal-string-alignment distance: catches typos and swapped letters ("profti", "busienss")
function osa(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[a.length][b.length];
}
const like = (tok, word) => tok === word || (word.length >= 5 && tok.length >= 4 && osa(tok, word) <= 1) || (word.length >= 6 && tok.startsWith(word.slice(0, -1)) && tok.length <= word.length + 3);
const hasWord = (toks, words) => toks.some((t) => words.some((w) => like(t, w)));
const hasPhrase = (text, list) => list.some((p) => text.includes(p));

const VOCAB = {
  why: ['why', 'reason', 'explain', 'happened', 'cause', 'caused'],
  down: ['down', 'lower', 'less', 'drop', 'dropped', 'dropping', 'decline', 'declined', 'worse', 'slow', 'slower', 'slowed', 'fell', 'fallen', 'falling', 'bad', 'decrease', 'decreased', 'behind', 'struggling'],
  up: ['up', 'higher', 'more', 'better', 'increase', 'increased', 'grew', 'growing', 'ahead', 'good', 'great', 'rise', 'rose', 'jump', 'jumped'],
  listings: ['listing', 'listings', 'listed', 'posted', 'post', 'posting', 'views', 'viewed', 'watchers', 'watching', 'watch', 'impressions', 'traffic', 'inventory', 'uploaded', 'live'],
  settle: ['owe', 'owes', 'owed', 'owing', 'settle', 'settlement', 'settlements', 'send', 'sends', 'pay', 'paid', 'pays', 'payment', 'payments', 'transfer', 'due', 'drew', 'myles'],
  expenses: ['expense', 'expenses', 'operating', 'opex', 'overhead', 'subscription', 'subscriptions', 'proxies', 'proxy', 'atlas', 'software', 'tools'],
  cogs: ['cogs', 'amazon', 'spent', 'spend', 'buying', 'purchases', 'purchase', 'bought'],
  refunds: ['refund', 'refunds', 'refunded', 'return', 'returns', 'returned', 'cancel', 'cancelled', 'canceled'],
  fees: ['fee', 'fees', 'ads', 'ad', 'promoted', 'advertising'],
  margin: ['margin', 'margins', 'roi'],
  aov: ['average', 'avg', 'aov', 'typical'],
  count: ['many', 'number', 'count', 'orders', 'order', 'sales', 'sold', 'sell', 'units'],
  revenue: ['revenue', 'gross', 'payout', 'payouts', 'turnover', 'sales$', 'collected'],
  profit: ['profit', 'profits', 'net', 'make', 'made', 'earn', 'earned', 'earning', 'earnings', 'income', 'money', 'profitable', 'doing', 'performance', 'perform'],
  top: ['best', 'top', 'highest', 'winners', 'winner', 'strongest', 'biggest'],
  worst: ['worst', 'losing', 'losers', 'loser', 'lose', 'lost', 'loss', 'losses', 'least', 'unprofitable', 'bleeding', 'weakest', 'negative'],
  recent: ['latest', 'recent', 'newest', 'last'],
  compare: ['vs', 'versus', 'compare', 'compared', 'comparison', 'against'],
  products: ['product', 'products', 'item', 'items', 'seller', 'sellers', 'selling'],
  help: ['help', 'what', 'can'],
};
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'on', 'in', 'for', 'to', 'from', 'with', 'did', 'do', 'does', 'we', 'our', 'us', 'i', 'my', 'me', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that', 'these', 'those', 'how', 'much', 'what', 'whats', 'which', 'who', 'when', 'where', 'show', 'tell', 'give', 'list', 'about', 'so', 'far', 'have', 'has', 'had', 'any', 'all', 'at', 'by', 'than', 'then', 'there', 'their', 'can', 'you', 'your', 'get', 'got', 'on', 'total', 'week', 'weeks', 'month', 'months', 'year', 'years', 'day', 'days', 'today', 'yesterday', 'time', 'ever', 'overall', 'since', 'start', 'started', 'business', 'dropship', 'dropshipping', 'ebay', 'store', 'shop', 'q1', 'q2', 'q3', 'q4', 'vs', 'and', 'but', 'not', 'no', 'yes', 'please', 'thanks', 'just', 'still', 'only', 'also', 'too', 'very', 'really', 'lot', 'lots', 'kinda', 'like', 'currently', 'now', 'right', 'past', 'previous', 'next', 'so', 'far', 'much', 'many', 'some', 'each', 'per', 'same', 'point', 'period', 'compared', 'dollars', 'thing', 'things', 'stuff', 'one', 'ones', 'guy', 'guys', 'color', 'colour', 'sky', 'weather']);
const ALL_VOCAB = new Set(Object.values(VOCAB).flat());

// ---------------------------------------------------------------- periods (Arizona business days)
const MONTH_RE = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b(?:\s+(20\d\d))?/g;
const monthIdx = (w) => MONTH_NAMES.findIndex((n) => n.startsWith(w.slice(0, 3)));

const fixMonths = (t) => t.split(' ').map((w) => (w.length >= 4 && !MONTH_NAMES.includes(w) ? MONTH_NAMES.find((m) => m.length >= 5 && osa(w, m) <= 1) || w : w)).join(' ');
const NUM_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fourteen: 14, thirty: 30, sixty: 60, ninety: 90 };
const MONTH_DAY_RE = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?!\s*(?:days?|weeks?|months?|sales?|orders?|items?))/g;

// Every time period mentioned in a question, in the order it was mentioned (Arizona business days)
export function parsePeriods(q, today = businessDay(new Date())) {
  let t = fixMonths(norm(q));
  const curM = today.slice(0, 7);
  const found = [];
  const at = (re) => { const m = t.match(re); return m ? t.indexOf(m[0]) : -1; };
  const span = (from, to, label, extra = {}) => ({ from, to: to > today ? today : to, label, ...extra });
  const month = (m, label) => span(monthStart(m), monthEnd(m), label || monthName(m), { month: m, partial: m === curM });
  const add = (idx, p) => { if (idx >= 0) found.push({ idx, p }); };
  const yearFor = (mm, y) => { let key = `${y}-${String(mm).padStart(2, '0')}`; if (key > curM) key = `${Number(y) - 1}${key.slice(4)}`; return key; };

  // Specific days first ("Sep 14", "9/14"), then blank them out so "Sep" isn't also read as the whole month
  for (const m of t.matchAll(MONTH_DAY_RE)) {
    const key = yearFor(monthIdx(m[1]) + 1, today.slice(0, 4));
    const day = `${key}-${String(Math.min(Number(m[2]), daysIn(key))).padStart(2, '0')}`;
    if (Number(m[2]) >= 1 && Number(m[2]) <= 31) add(m.index, span(day, day, dayLabel(day)));
  }
  for (const m of t.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g)) {
    const mm = Number(m[1]); const dd = Number(m[2]);
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) continue;
    const key = m[3] ? `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${String(mm).padStart(2, '0')}` : yearFor(mm, today.slice(0, 4));
    const day = `${key}-${String(Math.min(dd, daysIn(key))).padStart(2, '0')}`;
    add(m.index, span(day, day, dayLabel(day)));
  }
  t = t.replace(MONTH_DAY_RE, (x) => ' '.repeat(x.length)).replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, (x) => ' '.repeat(x.length));

  add(at(/\btoday\b|\bso far today\b/), span(today, today, 'today'));
  { const y = addDays(today, -1); add(at(/\byesterday\b/), span(y, y, 'yesterday')); }
  const dow = (new Date(toUTC(today)).getUTCDay() + 6) % 7; // Monday = 0
  add(at(/\bthis week\b/), span(addDays(today, -dow), today, 'this week', { kind: 'week' }));
  add(at(/\blast week\b/), span(addDays(today, -dow - 7), addDays(today, -dow - 1), 'last week', { kind: 'week' }));
  add(at(/\b(this month|month to date|mtd|so far this month)\b/), month(curM, 'this month'));
  add(at(/\blast month\b/), month(shiftMonth(curM, -1), `last month (${monthName(shiftMonth(curM, -1))})`));
  add(at(/\b(this year|ytd|year to date)\b/), span(`${today.slice(0, 4)}-01-01`, today, 'this year'));
  { const y = Number(today.slice(0, 4)) - 1; add(at(/\blast year\b/), span(`${y}-01-01`, `${y}-12-31`, String(y))); }
  // Rolling windows: "last 7 days", "past two weeks", "past month"
  const win = t.match(/\b(?:last|past|previous|the past|the last)\s+(\d{1,3}|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fourteen|thirty|sixty|ninety)\s+(day|week|month|year)s?\b/);
  const bare = !win && t.match(/\b(?:this past|the past|past)\s+(week|month|year)\b/);
  if (win || bare) {
    const n = win ? (NUM_WORDS[win[1]] || Number(win[1])) : 1;
    const unit = win ? win[2] : bare[1];
    const days = unit === 'day' ? n : unit === 'week' ? n * 7 : unit === 'month' ? n * 30 : n * 365;
    add(t.indexOf((win || bare)[0]), span(addDays(today, -(days - 1)), today, n === 1 ? `the last ${days} days` : `the last ${n} ${unit}s`, { kind: 'window', days }));
  }
  const q3 = t.match(/\bq([1-4])(?:\s+(20\d\d))?\b/);
  if (q3) { const y = q3[2] || today.slice(0, 4); const s = `${y}-${String((Number(q3[1]) - 1) * 3 + 1).padStart(2, '0')}`; add(t.indexOf(q3[0]), span(monthStart(s), monthEnd(shiftMonth(s, 2)), `Q${q3[1]} ${y}`)); }
  for (const m of t.matchAll(MONTH_RE)) {
    const word = m[1];
    // "may" is also an ordinary word: only a month when it looks like one
    if (word === 'may' && !m[2] && !/\b(in|for|of|during|since|from|to|vs|and)\s+may\b/.test(t)) continue;
    const key = m[2] ? `${m[2]}-${String(monthIdx(word) + 1).padStart(2, '0')}` : yearFor(monthIdx(word) + 1, today.slice(0, 4)); // "December" in September means last December
    const since = new RegExp(`\\bsince\\s+${word}`).test(t);
    add(m.index, since ? span(monthStart(key), today, `since ${monthName(key)}`) : month(key));
  }
  add(at(/\b(all time|alltime|ever|overall|lifetime|since (we )?(start|started|began|opened|launched)|in total|total so far|to date|since the (start|beginning))\b/), { from: null, to: today, label: 'all time', all: true });
  found.sort((a, b) => a.idx - b.idx);
  const out = found.map((x) => x.p);
  // de-duplicate identical spans
  return out.filter((p, i) => out.findIndex((x) => x.from === p.from && x.to === p.to) === i);
}

// ---------------------------------------------------------------- data
async function load() {
  const [orders, books] = await Promise.all([buildDataset(), buildBooks()]);
  const s = {
    A: (await getSetting('partner_amazon')) || 'Myles',
    B: (await getSetting('partner_ebay')) || 'Drew',
    split: Number((await getSetting('split_amazon')) ?? 50),
    dueDay: Number((await getSetting('settlement_day')) ?? 26),
  };
  let listings = null;
  try { const m = await import('./listings.js'); if (m.listingAnalytics) listings = await m.listingAnalytics(); } catch { listings = null; }
  return { orders, books, s, listings, today: businessDay(new Date()) };
}

const counted = (ctx) => ctx.orders.filter((o) => o.counted);
function inPeriod(o, p) {
  if (!p || p.all) return true;
  // Whole months use the server's business month, so sheet rows with approximate dates land exactly
  if (p.month && !p.sinceMonth) return o.business_month === p.month && businessDay(o.created_at) <= p.to;
  const d = businessDay(o.created_at);
  return d >= p.from && d <= p.to;
}
const rowMoney = (o) => {
  const payout = cents(o.revenue) - cents(o.fees) - cents(o.refunds);
  const cogs = cents(o.cost) - cents(o.amazon_refund);
  const ads = cents(o.ad_fees);
  const other = cents(o.extra_cost);
  return { payout, cogs, ads, other, net: payout - cogs - ads - other, refunds: cents(o.refunds) };
};
function stats(rows) {
  const t = { n: rows.length, payout: 0, cogs: 0, ads: 0, other: 0, net: 0, refunds: 0, revenue: 0, refundedSales: 0, losses: [] };
  for (const o of rows) {
    const m = rowMoney(o);
    t.payout += m.payout; t.cogs += m.cogs; t.ads += m.ads; t.other += m.other; t.net += m.net; t.refunds += m.refunds;
    t.revenue += cents(o.revenue);
    if (m.refunds > 0 || o.status === 'returned') t.refundedSales++;
    if (m.net < 0) t.losses.push({ o, net: m.net });
  }
  t.losses.sort((a, b) => a.net - b.net);
  t.avg = t.n ? t.net / t.n : 0;
  return t;
}
// Operating costs in a period: a month fully inside counts in full (the current month through today counts in
// full, like the settlement); a partly covered month counts by its share of days
function opexIn(ctx, p) {
  let total = 0;
  for (const e of ctx.books.expenses) {
    const amt = cents(e.amount);
    if (!p || p.all) { total += amt; continue; }
    const ms = monthStart(e.month);
    const me = monthEnd(e.month) > ctx.today ? ctx.today : monthEnd(e.month);
    if (me < ms) continue;
    const from = p.from > ms ? p.from : ms;
    const to = p.to < me ? p.to : me;
    if (to < from) continue;
    if (from <= ms && to >= me) total += amt;
    else total += Math.round((amt * ((toUTC(to) - toUTC(from)) / 86400_000 + 1)) / daysIn(e.month));
  }
  return total;
}
const settle = (ctx, month) => settleMonth({ month, orders: ctx.orders, expenses: ctx.books.expenses, settlements: ctx.books.settlements, splitAmazon: ctx.s.split });
const productKey = (o) => (o.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 48);
function byProduct(rows) {
  const m = new Map();
  for (const o of rows) {
    const k = productKey(o);
    if (!m.has(k)) m.set(k, { title: o.title, n: 0, net: 0, payout: 0, refunds: 0 });
    const p = m.get(k); const r = rowMoney(o);
    p.n++; p.net += r.net; p.payout += r.payout; if (r.refunds > 0) p.refunds++;
  }
  return [...m.values()];
}
const short = (t, n = 46) => (t.length > n ? `${t.slice(0, n - 1).trim()}…` : t);

// ---------------------------------------------------------------- product mention in a question
// Everyday question words that also appear in listing titles ("Low Profile...", "Cost-Saving...") are never product names
const NOT_PRODUCT = new Set(['cost', 'costs', 'costing', 'price', 'prices', 'pricing', 'amount', 'amounts', 'total', 'totals', 'spend', 'spending', 'paid', 'pay',
  'paying', 'get', 'got', 'getting', 'look', 'looks', 'looking', 'data', 'info', 'report', 'summary', 'going', 'low', 'high', 'slow', 'fast', 'good', 'bad', 'better',
  'worse', 'down', 'up', 'less', 'more', 'most', 'least', 'lot', 'much', 'many', 'big', 'small', 'new', 'old', 'need', 'needs', 'want', 'know', 'tell', 'show',
  'give', 'check', 'see', 'still', 'yet', 'ever', 'right', 'now', 'currently', 'current', 'recently', 'lately', 'our', 'ours', 'team', 'shop', 'store', 'account',
  'something', 'anything', 'everything', 'nothing', 'ones', 'kind', 'type', 'thing', 'stuff', 'why', 'what', 'which', 'when', 'where', 'who', 'how']);

function findProduct(ctx, toks) {
  const cand = toks.filter((t) => t.length >= 3 && !STOP.has(t) && !NOT_PRODUCT.has(t) && !ALL_VOCAB.has(t) && !/^\d+$/.test(t) && !MONTH_NAMES.some((m) => m.startsWith(t.slice(0, 3)) && t.length <= m.length));
  if (!cand.length) return null;
  const products = byProduct(ctx.orders.filter((o) => o.counted || o.status === 'awaiting_cost'));
  const df = new Map();
  for (const p of products) for (const w of new Set(tokens(p.title))) df.set(w, (df.get(w) || 0) + 1);
  let best = null;
  for (const p of products) {
    const words = new Set(tokens(p.title));
    let hits = 0;
    for (const c of cand) if ([...words].some((w) => like(c, w) || (c.length >= 4 && w.startsWith(c)))) hits++;
    if (!hits) continue;
    const score = hits / cand.length;
    if (!best || score > best.score) best = { score, words: cand };
  }
  if (!best || best.score < (best.words.length > 1 ? 0.66 : 0.5)) return null;
  // Rare-enough words only: a word in most titles ("set", "pack") isn't a product name
  const words = best.words.filter((w) => [...df.entries()].some(([k, n]) => (like(w, k) || k.startsWith(w)) && n <= Math.max(3, products.length * 0.25)));
  return words.length ? words : null;
}
const productFilter = (words) => (o) => { const ts = tokens(o.title); return words.every((w) => ts.some((t) => like(w, t) || (w.length >= 4 && t.startsWith(w)))); };

// ---------------------------------------------------------------- intent
// Phrase rules, checked in this order. The order settles the conflicts between everyday phrasings:
// "how much did eBay pay us" is payouts, "did Drew pay" is the settlement, "what subscriptions do we pay for" is
// operating costs, "promoted listing fees" is fees (not listings), "lost to returns" is refunds (not losing products).
const RULES = [
  ['help', /^(hi|hey|hello|yo|help|thanks|thank you|ok|okay)\b|\bwhat can (you|i) (do|ask)\b|\bhow does this work\b/],
  ['why', /\b(why|how come|what happened|what went wrong|reasons?|explain|what caused|what'?s causing)\b/],
  ['awaiting', /\b(awaiting|waiting (on|for)|not (yet )?(been )?(ordered|bought|purchased)|havent (we |you |i )?(yet )?(ordered|bought|purchased)|(ordered|bought) yet|still need to (order|buy)|needs? to be (ordered|bought)|need to (order|buy)|unmatched|no amazon (order|purchase|match|email)|without an? amazon|missing (amazon|cost)|not matched)\b/],
  ['fees', /\b(fees?|advertising|ad spend|promoted)\b/],
  ['listings', /\b(listings?|listed|delist\w*|posted|posting|views?|viewed|watchers?|watching|watch ?count|impressions?|traffic|stale|inventory)\b/],
  ['best_period', /\b(best|worst|biggest|highest|lowest|slowest|busiest|strongest|weakest|top)\s+(day|week|month|weekday)s?\b/],
  ['settlement', /\b(owe[sd]?|owing|settle[sd]?|settlement|reimburse\w*|payment|payments|transfer(red|s)?|pay ?back)\b|\bdue\b|\b(drew|myles|partner)\b.*\b(pay|paid|pays|send|sent|sends)\b|\b(pay|paid|send|sent)\b.*\b(drew|myles|partner|me)\b/],
  ['expenses', /\b(expenses?|operating|opex|overhead|subscriptions?|proxies|proxy|atlas|software|tools?|infinity|bills?)\b/],
  ['refunds', /\b(refunds?|refunded|returns?|returned|cancel\w*|chargebacks?)\b/],
  ['cogs', /\b(amazon (cost|costs|spend|spending|total)|cost of goods|cogs|(spent|spend|spending|paid|pay|pay for|paying) (on|to|at|for) amazon|buying costs?|product costs?|how much .*amazon)\b/],
  ['margin', /\b(margins?|roi|return on (investment|spend))\b/],
  ['aov', /\b(average|avg|typical|mean)\b|\bper (sale|order|item)\b/],
  ['worst', /\b(worst|losing|lose money|lost money|losers?|least profitable|unprofitable|bleeding|stop selling|(should|could) (we )?(drop|cut|stop)|money pits?)\b/],
  ['top', /\b(best|top|most profitable|best[- ]?sell\w*|sells? (the )?best|sell the most|sold the most|most sold|most popular|made the most|most money|highest profit|winners?|biggest earners?)\b/],
  ['recent', /\b(last|latest|recent|newest|most recent)\s+(\d+\s+)?(sales?|orders?|sold|items?)\b|\bwhat (did we |have we |has |)(sell|sold)\b|\bwhat sold\b|\b(list|show)( me)?( the| all)? (sales|orders)\b|\bwhich (sales|orders|items)\b/],
  ['count', /\b(how many|number of|count of|# of|any sales|anything sold|did we sell|did we get any|sales count)\b/],
  ['revenue', /\b(revenue|gross|payouts?|turnover|sales (dollars|total|amount)|total sales|in sales|ebay (paid|pay|pays|deposit\w*)|brought in|bring in|collected|sales volume)\b/],
  ['profit', /\b(profits?|net|make|made|making|earn\w*|income|money|doing|clear(ed)?|take home|bottom line|business|p ?& ?l|pnl|up or down)\b/],
];

const DEICTIC = /\b(that|the same) (month|period|time|week|day|year)\b|\bthen\b|\bback then\b/;

function understand(question, ctx, prev) {
  const text = norm(question).replace(/\bhavent\b|\bhaven t\b/g, 'havent');
  const toks = tokens(question);
  const periods = parsePeriods(question, ctx.today);
  // Product names come from what's left once the topic and time words are taken out ("what did we clear in July"
  // must not find the "Clear Corner Lights" listing)
  let rest = fixMonths(text);
  for (const [, re] of RULES) rest = rest.replace(new RegExp(re.source, 'g'), ' ');
  rest = rest.replace(MONTH_DAY_RE, ' ').replace(MONTH_RE, ' ')
    .replace(/\b(today|yesterday|this|last|past|previous|week|month|year|days?|weeks?|months?|years?|so far|since|ever|overall|all time|numbers?|stuff|things?|item|items|product|products|sales?|orders?)\b/g, ' ');
  const product = findProduct(ctx, tokens(rest));
  let intent = null;
  for (const [name, re] of RULES) if (re.test(text)) { intent = name; break; }
  // Typos ("proft", "refnds") fall back to the fuzzy word lists
  if (!intent) {
    const is = (k) => hasWord(toks, VOCAB[k]);
    intent = is('why') ? 'why' : is('refunds') ? 'refunds' : is('expenses') ? 'expenses' : is('settle') ? 'settlement'
      : is('listings') ? 'listings' : is('margin') ? 'margin' : is('worst') ? 'worst' : is('top') ? 'top' : is('profit') ? 'profit' : null;
  }
  if (intent === 'why' && RULES.find(([n]) => n === 'listings')[1].test(text)) intent = 'listings_vs_sales';
  // Two periods, or one with a comparison word, is a comparison (unless it's a "why")
  if (intent !== 'why' && intent !== 'listings_vs_sales' && intent !== 'help' &&
      ((periods.length >= 2 && /\b(vs\.?|versus|compare[ds]?|comparison|against|better than|worse than|compared|and|or|to)\b/.test(text)) ||
       (periods.length === 1 && /\b(vs\.?|versus|compare[ds]?|comparison|against|compared to)\b/.test(text)))) intent = 'compare';
  // A product name with no topic: its summary. With a topic ("how many ukuleles did we sell"): that topic for the product.
  if (!intent && product) intent = 'product';
  // "how is the ukulele doing" / "what did we make on the ukulele": that product's own summary
  if ((intent === 'top' || intent === 'profit') && product) intent = 'product';
  // Follow-ups: "what about August?", "and July?", "same for last week" keep the previous topic
  if ((!intent || intent === 'help') && prev?.intent && (periods.length || product || /^(what about|how about|and|same for|what of|now)\b/.test(text))) intent = prev.intent;
  if (!intent) intent = 'help';

  // "what about refunds?", "did he pay for that month?" keep the period being talked about
  let period = periods[0] || null;
  if (!period && prev?.period && intent !== 'help' && (/^(what about|how about|and|same|also)\b/.test(text) || DEICTIC.test(text))) period = prev.period;
  const up = /\b(up|higher|more|better|increase[ds]?|grew|growing|ahead|good|great|rose|jump(ed)?|improv\w*)\b/.test(text);
  const down = /\b(down|lower|less|drop(ped)?|declin\w*|worse|slow(er|ed)?|fell|fallen|bad|decrease[ds]?|behind|struggl\w*|low)\b/.test(text);
  return { intent, period, periods, product: product || (intent === prev?.intent && !periods.length ? prev?.product : null) || null, direction: up && !down ? 'up' : down && !up ? 'down' : null };
}

// ---------------------------------------------------------------- answers
const defaultPeriod = (ctx) => ({ from: monthStart(ctx.today.slice(0, 7)), to: ctx.today, label: 'this month', month: ctx.today.slice(0, 7), partial: true });
const allTime = (ctx) => ({ from: null, to: ctx.today, label: 'all time', all: true });
const rowsFor = (ctx, p, product) => counted(ctx).filter((o) => inPeriod(o, p) && (!product || productFilter(product)(o)));
const awaitingFor = (ctx, p) => ctx.orders.filter((o) => o.status === 'awaiting_cost' && inPeriod(o, p));

// The fair comparison period for "why" questions
function comparisonFor(ctx, p) {
  if (p.month && p.partial) {
    const pm = shiftMonth(p.month, -1);
    const day = Math.min(Number(ctx.today.slice(8)), daysIn(pm));
    return { from: monthStart(pm), to: `${pm}-${String(day).padStart(2, '0')}`, label: `the same point last month (${monthName(pm, true).split(' ')[0]} 1–${day})` };
  }
  if (p.month) { const pm = shiftMonth(p.month, -1); return { from: monthStart(pm), to: monthEnd(pm), label: monthName(pm), month: pm }; }
  if (p.all) return null;
  const len = (toUTC(p.to) - toUTC(p.from)) / 86400_000 + 1;
  return { from: addDays(p.from, -len), to: addDays(p.from, -1), label: `the ${plural(len, 'day')} before` };
}
// "Sep 1–22" style label for a partial month
const periodTitle = (ctx, p) => {
  if (!(p.month && p.partial)) return p.label;
  const span = `${monthName(p.month, true).split(' ')[0]} 1–${Number(ctx.today.slice(8))}`;
  return p.label === 'this month' ? `this month (${span})` : `${p.label} (so far, ${span})`;
};

// "in August 2026", "on Sep 14", "today": a period as it reads inside a sentence
const periodPhrase = (ctx, p) => {
  const s = periodTitle(ctx, p);
  if (/^(today|yesterday|this |last |all time|since )/.test(s)) return s;
  if (/^the last /.test(s)) return `in ${s}`;
  if (/^[A-Z][a-z]{2} \d{1,2}$/.test(s)) return `on ${s}`;
  return `in ${s}`;
};
// A period's name for tables and comparisons ("August 2026", "September 2026 so far")
const shortLabel = (p) => (p.month ? `${monthName(p.month)}${p.partial ? ' so far' : ''}` : p.label);
const isAre = (n) => (n === 1 ? 'is' : 'are');
const counts = (n, one, many) => (n === 1 ? one : many);

function answerWhy(ctx, it) {
  const p = it.period || defaultPeriod(ctx);
  const c = comparisonFor(ctx, p);
  if (!c) return { text: 'A “why” needs something to compare against. Try “why are we down this month?” or “why was August better than July?”.', chips: ['Why are we down this month?', 'Compare August vs September'] };
  const cur = stats(rowsFor(ctx, p));
  const prv = stats(rowsFor(ctx, c));
  if (!cur.n && !prv.n) return { text: `There are no costed sales ${periodPhrase(ctx, p)} or in ${c.label} to compare yet.` };
  const d = cur.net - prv.net;
  const up = d >= 0;
  const cIn = /^the same point/.test(c.label) ? `at ${c.label}` : `in ${c.label}`;
  const wrongPremise = (it.direction === 'down' && d > 0) || (it.direction === 'up' && d < 0);
  const head = `Item profit ${periodTitle(ctx, p)} is ${$(cur.net)}, ${up ? 'up' : 'down'} ${$(Math.abs(d))}${prv.net ? ` (${pct(Math.abs(chg(cur.net, prv.net)))})` : ''} from ${$(prv.net)} ${cIn}.`;
  const text = `**${wrongPremise ? `We're actually ${up ? 'up' : 'down'}, not ${up ? 'down' : 'up'}. ` : ''}${head}**`;
  const bullets = [];

  // The change splits exactly into: how many sales (at last period's profit per sale) + profit per sale
  const volume = Math.round((cur.n - prv.n) * prv.avg);
  const perSale = d - volume;
  const drivers = [];
  const effect = (v) => (v < 0 ? 'pulled profit down' : 'pushed profit up');
  if (cur.n !== prv.n) drivers.push({ v: volume, t: `**${cur.n < prv.n ? 'Fewer' : 'More'} sales:** ${cur.n} vs ${prv.n}${prv.n ? ` (${cur.n > prv.n ? '+' : '−'}${pct(Math.abs(chg(cur.n, prv.n)))})` : ''}. At last period's ${$(Math.round(prv.avg))} profit per sale, that's **${signed$(volume)}** (${effect(volume)}).` });
  if (cur.n && Math.abs(perSale) >= 1) {
    const avg = (s, k) => (s.n ? Math.round(s[k] / s.n) : 0);
    const p0 = avg(prv, 'payout'); const p1 = avg(cur, 'payout');
    const c0 = avg(prv, 'cogs'); const c1 = avg(cur, 'cogs');
    const a0 = avg(prv, 'ads'); const a1 = avg(cur, 'ads');
    let why = '';
    if (p1 < p0 && c1 < c0) why = ` Cheaper items sold: the average sale paid out ${$(p1)} (was ${$(p0)}) and cost ${$(c1)} on Amazon (was ${$(c0)}).`;
    else if (p1 < p0) why = ` The average sale paid out less, ${$(p1)} vs ${$(p0)}, while Amazon cost per sale was ${$(c1)} vs ${$(c0)}.`;
    else if (c1 > c0) why = ` Amazon costs rose faster than payouts: cost per sale ${$(c0)} → ${$(c1)}, payout per sale ${$(p0)} → ${$(p1)}.`;
    else if (p1 > p0 || c1 < c0) why = ` The average sale paid out ${$(p1)} (was ${$(p0)}) and cost ${$(c1)} on Amazon (was ${$(c0)}).`;
    if (Math.abs(a1 - a0) >= 100) why += ` Ad fees per sale went from ${$(a0)} to ${$(a1)}.`;
    drivers.push({ v: perSale, t: `**${perSale < 0 ? 'Less' : 'More'} profit per sale:** ${$(Math.round(prv.avg))} → ${$(Math.round(cur.avg))}, worth **${signed$(perSale)}** (${effect(perSale)}).${why}` });
  }
  drivers.sort((a, b) => (up ? b.v - a.v : a.v - b.v));
  bullets.push(...drivers.map((x) => x.t));

  // Money lost on refunded sales, then any other sales that lost money
  const refundLoss = (s) => s.losses.filter((x) => cents(x.o.refunds) > 0 || x.o.status === 'returned').reduce((t, x) => t + x.net, 0);
  const rc = refundLoss(cur); const rp = refundLoss(prv);
  if (rc || rp) bullets.push(`**Refunds:** ${plural(cur.refundedSales, 'refunded sale')} lost ${$(-rc)} vs ${$(-rp)} ${cIn}${rc !== rp ? ` (${effect(rc - rp)})` : ''}.`);
  const otherLoss = cur.losses.filter((x) => !(cents(x.o.refunds) > 0 || x.o.status === 'returned'));
  if (otherLoss.length) bullets.push(`**${plural(otherLoss.length, 'sale')} lost money** without a refund (${$(otherLoss.reduce((t, x) => t + x.net, 0))}): ${otherLoss.slice(0, 3).map((x) => `${short(x.o.title, 34)} ${$(x.net)}`).join(', ')}.`);

  // Products that carried the earlier period but didn't this time
  const pc = new Map(byProduct(rowsFor(ctx, p)).map((x) => [productKey({ title: x.title }), x]));
  const swings = byProduct(rowsFor(ctx, c)).map((x) => ({ title: x.title, was: x.net, now: pc.get(productKey({ title: x.title }))?.net || 0 }))
    .map((x) => ({ ...x, d: x.now - x.was })).filter((x) => (up ? x.d > 0 : x.d < 0)).sort((a, b) => (up ? b.d - a.d : a.d - b.d)).slice(0, 3);
  if (!up && swings.length && swings[0].d <= -500) bullets.push(`**Products that earned less:** ${swings.map((x) => `${short(x.title, 32)} (${$(x.was)} → ${$(x.now)})`).join('; ')}.`);
  if (up) {
    const risers = byProduct(rowsFor(ctx, p)).sort((a, b) => b.net - a.net).slice(0, 3);
    if (risers.length) bullets.push(`**Biggest earners:** ${risers.map((x) => `${short(x.title, 32)} ${$(x.net)}`).join('; ')}.`);
  }

  // Not in the numbers yet
  const aw = waitingIn(ctx, p);
  if (aw.length) bullets.push(`**${plural(aw.length, 'sale')} (${$(aw.reduce((t, o) => t + cents(o.revenue), 0))}) ${isAre(aw.length)} not counted yet**: ${counts(aw.length, 'it’s', 'they’re')} awaiting the Amazon order email, so the final number may be higher.`);

  // Operating costs
  const oc = opexIn(ctx, p);
  const op = opexIn(ctx, c);
  const word = (a, b) => (a > b ? 'higher' : a < b ? 'lower' : 'the same');
  if (oc || op) bullets.push(`**Operating costs:** ${$(oc)} ${p.partial ? 'this month (the full month, as the settlement counts it)' : periodPhrase(ctx, p)} vs ${$(op)} for ${c.label.replace(/^the same point last month \((.*)\)$/, '$1')}. After them, business profit is ${word(cur.net - oc, prv.net - op)}: ${$(cur.net - oc)} vs ${$(prv.net - op)}.`);

  const L = listingDrivers(ctx);
  if (L) bullets.push(L.summary);
  if (p.partial) { const left = daysIn(p.month) - Number(ctx.today.slice(8)); bullets.push(`The month isn't over: ${plural(left, 'day')} left.`); }

  return {
    text, trend: up ? 'up' : 'down', bullets,
    chips: [cur.losses.length ? `Worst products ${p.label}` : null, `Top products ${p.label}`, it.period?.month ? null : 'Compare last month vs this month', 'Why do we have more listings but fewer sales?'].filter(Boolean),
  };
}

// Listing numbers from src/listings.js (last 30 days vs the 30 before). Rates are worked out here from raw counts
// (views per 100 times shown, orders per 100 views), so they never depend on how eBay formats its percentages.
function listingFacts(ctx) {
  const L = ctx.listings;
  if (!L || !(L.totals?.activeListings > 0)) return null;
  const D = L.drivers || {};
  const val = (k, w) => (D[k] && D[k][w] !== undefined ? D[k][w] : null);
  const rate = (num, den, w) => { const n = val(num, w); const d = val(den, w); return n !== null && d ? (n / d) * 100 : null; };
  const m = {
    listings: [val('listings', 'previous'), val('listings', 'current')],
    newListings: [val('newListings', 'previous'), val('newListings', 'current')],
    impressions: [val('impressions', 'previous'), val('impressions', 'current')],
    views: [val('views', 'previous'), val('views', 'current')],
    viewsPerListing: [val('viewsPerListing', 'previous'), val('viewsPerListing', 'current')],
    viewRate: [rate('views', 'impressions', 'previous'), rate('views', 'impressions', 'current')],
    orders: [val('orders', 'previous'), val('orders', 'current')],
    salesRate: [rate('orders', 'views', 'previous'), rate('orders', 'views', 'current')],
    ordersPerK: [rate('orders', 'listings', 'previous') === null ? null : rate('orders', 'listings', 'previous') * 10, rate('orders', 'listings', 'current') === null ? null : rate('orders', 'listings', 'current') * 10],
  };
  const ch = (k) => { const [a, b] = m[k]; return a !== null && b !== null && a !== 0 ? (b - a) / Math.abs(a) : null; };
  return { L, m, ch, traffic: m.views[1] !== null && m.views[0] !== null };
}
const fmtN = (x, d = 0) => (x === null || x === undefined ? '—' : Number(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const fmtCh = (x) => (x === null || !Number.isFinite(x) ? '' : ` (${x >= 0 ? '+' : '−'}${Math.abs(Math.round(x * 100))}%)`);
const trend = (F, k, label, d = 0) => { const [a, b] = F.m[k]; return a === null || b === null ? null : `${label} ${fmtN(a, d)} → ${fmtN(b, d)}${fmtCh(F.ch(k))}`; };

function listingDrivers(ctx) {
  const F = listingFacts(ctx);
  if (!F) return null;
  const bits = [trend(F, 'listings', 'active listings'), trend(F, 'orders', 'orders'), trend(F, 'ordersPerK', 'orders per 1,000 listings', 1), F.traffic ? trend(F, 'viewsPerListing', 'views per listing', 1) : null, F.traffic ? trend(F, 'salesRate', 'orders per 100 views', 2) : null].filter(Boolean);
  return bits.length ? { summary: `**Listings (last 30 days vs the 30 before):** ${bits.join(', ')}.` } : null;
}

function answerListingsVsSales(ctx) {
  const F = listingFacts(ctx);
  if (!F) {
    return { text: 'I can’t see your eBay listings yet, so I can’t compare listings with sales. Connect eBay in **Settings** (reconnect once to allow listing data) and it fills in on the next sync.', chips: ['Why are we down this month?', 'How many sales this month?'] };
  }
  const { m, ch } = F;
  const bullets = [
    trend(F, 'listings', '**Active listings (daily average)**'),
    trend(F, 'newListings', '**New listings posted**'),
    F.traffic ? trend(F, 'impressions', '**Times shown in search**') : null,
    F.traffic ? trend(F, 'views', '**Listing views**') : null,
    F.traffic ? trend(F, 'viewsPerListing', '**Views per listing**', 1) : null,
    F.traffic ? trend(F, 'viewRate', '**Views per 100 times shown**', 2) : null,
    trend(F, 'orders', '**Orders**'),
    trend(F, 'ordersPerK', '**Orders per 1,000 active listings**', 1),
    F.traffic ? trend(F, 'salesRate', '**Orders per 100 views**', 2) : null,
  ].filter(Boolean);
  const reasons = [];
  // Listings growing faster than orders: each listing sells less (works with or without eBay's traffic data)
  if (ch('ordersPerK') !== null && ch('ordersPerK') < -0.1) reasons.push(`listings grew faster than sales. Active listings are ${fmtCh(ch('listings')).trim().replace(/[()]/g, '')} but orders only ${fmtCh(ch('orders')).trim().replace(/[()]/g, '')}, so each listing sells less: ${fmtN(m.ordersPerK[0], 1)} → ${fmtN(m.ordersPerK[1], 1)} orders per 1,000 listings. Most new listings aren't selling yet`);
  if (F.traffic) {
    if (ch('listings') > 0.05 && ch('viewsPerListing') < -0.05) reasons.push('you have more listings, but each one gets fewer views. The new listings aren’t pulling in much traffic, so the same views are spread across more items');
    if (ch('impressions') > 0.05 && ch('viewRate') < -0.05) reasons.push('eBay shows your listings more often, but fewer people click them. Price, main photo and title decide that click');
    if (ch('views') >= -0.05 && ch('salesRate') < -0.05) reasons.push('people still look at the listings, but fewer of them buy. Compare prices with competitors and check the handling time');
    if (ch('impressions') < -0.05) reasons.push('eBay is showing your listings less often in search. Listings lose visibility as they age, and promoted-listing changes matter too');
  }
  if (!F.traffic) reasons.push('I can’t see listing views yet, so I can’t tell whether the new listings aren’t being seen or are seen but not bought. Reconnect eBay once in Settings to allow listing traffic');
  const real = F.traffic ? reasons : reasons.slice(0, -1); // the last one is only the note about missing views
  const text = real.length
    ? `**Short answer: ${real[0]}.**${reasons.length > 1 ? ` Also, ${reasons.slice(1).join('; also, ')}.` : ''}`
    : F.traffic
      ? '**Listing traffic and conversion are roughly steady**, so the change in sales looks like normal variation rather than a listings problem.'
      : `**Sales are keeping pace with listings** (${fmtN(m.ordersPerK[0], 1)} → ${fmtN(m.ordersPerK[1], 1)} orders per 1,000 listings). ${reasons[0]}.`;
  if (F.L.stale?.count) bullets.push(`**${plural(F.L.stale.count, 'listing')} ${F.L.stale.count === 1 ? 'has' : 'have'} been live 30+ days with no sales${F.L.stale.criteria?.viewsBelowMedian !== null && F.L.stale.criteria?.viewsBelowMedian !== undefined ? ' and below-median views' : ''}.** Refreshing or ending them keeps the store focused (Products → Listings).`);
  return { text, bullets, chips: ['Which listings get the most views?', 'Why are we down this month?'] };
}

// Sales still waiting for their Amazon purchase (never in any totals until matched)
const waitingIn = (ctx, p) => ctx.orders.filter((o) => o.status === 'awaiting_cost' && inPeriod(o, p));
const waitWord = (o) => (o.amazon_orders?.length ? 'needs its cost typed in' : 'awaiting the Amazon email');
// Operating costs are monthly: when a period only covers part of a month, say that the month's cost was split
function opexSplit(ctx, p) {
  if (!p || p.all || p.month) return false;
  return ctx.books.expenses.some((e) => {
    const ms = monthStart(e.month);
    const me = monthEnd(e.month) > ctx.today ? ctx.today : monthEnd(e.month);
    const from = p.from > ms ? p.from : ms;
    const to = p.to < me ? p.to : me;
    return to >= from && !(from <= ms && to >= me);
  });
}

function answerMetric(ctx, it) {
  const p = it.period || (it.product ? allTime(ctx) : defaultPeriod(ctx));
  const rows = rowsFor(ctx, p, it.product);
  const s = stats(rows);
  const productName = it.product ? (rows[0] ? `“${short(rows[0].title, 50)}”` : `“${it.product.join(' ')}”`) : '';
  const when = periodPhrase(ctx, p);
  const wait = it.product ? [] : waitingIn(ctx, p);
  const waitNote = wait.length ? ` ${plural(wait.length, 'more sale')} ${isAre(wait.length)} awaiting the Amazon email and ${counts(wait.length, 'isn’t', 'aren’t')} counted yet.` : '';
  switch (it.intent) {
    case 'profit': {
      const oc = opexIn(ctx, p);
      const b = [`Item profit ${$(s.net)} from ${plural(s.n, 'sale')}, minus ${$(oc)} operating costs${opexSplit(ctx, p) ? ' (months only partly in the period count by their share of days)' : ''}.`];
      if (p.month) { const st = settle(ctx, p.month); b.push(`${monthName(p.month)} settlement: ${ctx.s.B} sends ${ctx.s.A} ${$(cents(st.sellerSends))}.`); }
      if (it.defaulted) { const all = stats(rowsFor(ctx, allTime(ctx))); b.push(`All time: ${$(all.net - opexIn(ctx, allTime(ctx)))} business profit from ${plural(all.n, 'sale')}.`); }
      return { text: `**Net business profit ${periodTitle(ctx, p)}: ${$(s.net - oc)}.**${waitNote}`, bullets: b, chips: [`Why are we ${s.net >= 0 ? 'up' : 'down'} ${p.label}?`, `Top products ${p.label}`, `How many sales ${p.label}?`] };
    }
    case 'count': {
      const total = s.n + wait.length;
      return {
        text: `**${plural(total, 'sale')}${productName ? ` of ${productName}` : ''} ${when}.**${wait.length ? ` ${s.n} counted in profit, ${wait.length} awaiting the Amazon email.` : ''}${s.refundedSales ? ` ${s.refundedSales} of the counted sales ${counts(s.refundedSales, 'was', 'were')} refunded.` : ''}`,
        bullets: wait.slice(0, 5).map((o) => `${dayLabel(businessDay(o.created_at))}: ${short(o.title)}, ${$(cents(o.revenue))} (${waitWord(o)})`),
        chips: [`Profit ${p.label}`, `What sold ${p.label}?`],
      };
    }
    case 'revenue': return { text: `**eBay payouts${productName ? ` for ${productName}` : ''} ${when}: ${$(s.payout)}** from ${plural(s.n, 'sale')}, after eBay's fees and buyer refunds.${waitNote}`, chips: [`Profit ${p.label}`, `Fees ${p.label}`] };
    case 'cogs': return { text: `**Amazon cost${productName ? ` for ${productName}` : ''} ${when}: ${$(s.cogs)}** for ${plural(s.n, 'sale')}${s.n ? ` (${$(Math.round(s.cogs / s.n))} per sale)` : ''}. ${ctx.s.A} pays this and gets it back in the settlement.${waitNote}`, chips: [`Profit ${p.label}`, `What does ${ctx.s.B} owe?`] };
    case 'fees': {
      const synced = rows.filter((o) => o.source === 'ebay');
      const fvf = synced.reduce((t, o) => t + cents(o.fees), 0);
      const sheetRows = rows.length - synced.length;
      return {
        text: `**eBay fees ${when}: ${$(fvf)} in final value fees and ${$(s.ads)} in promoted-listing (ad) fees.**`,
        bullets: [
          synced.length ? `Final value fees are from the ${plural(synced.length, 'sale')} synced from eBay.` : null,
          sheetRows ? `${plural(sheetRows, 'monthly-sheet sale')} only record the payout after eBay's fees, so their final value fees aren't broken out.` : null,
        ].filter(Boolean),
        chips: [`Profit ${p.label}`, `Margin ${p.label}`],
      };
    }
    case 'margin': return { text: `**Margin ${when}: ${pct(s.payout ? s.net / s.payout : null)}** of payouts (${$(s.net)} item profit on ${$(s.payout)}).`, bullets: [`Return on Amazon spend: ${pct(s.cogs ? s.net / s.cogs : null)} (${$(s.net)} profit on ${$(s.cogs)} spent).`], chips: [`Worst products ${p.label}`, `Profit ${p.label}`] };
    case 'aov': return { text: `**Average sale ${when}: ${$(s.n ? Math.round(s.payout / s.n) : 0)} payout, ${$(s.n ? Math.round(s.net / s.n) : 0)} profit**, across ${plural(s.n, 'sale')}.`, chips: [`Top products ${p.label}`] };
    case 'refunds': {
      const ref = rows.filter((o) => cents(o.refunds) > 0 || o.status === 'returned');
      const cancelled = ctx.orders.filter((o) => o.cancelled && o.source === 'ebay' && inPeriod(o, p));
      const line = (o) => {
        const m = rowMoney(o);
        if (o.source === 'ledger') return `${dayLabel(businessDay(o.created_at))}: ${short(o.title)}: refunded. eBay kept a ${$(m.refunds)} fee${m.cogs > 0 ? ` and the ${$(m.cogs)} Amazon purchase wasn't recovered` : ''}, so it lost ${$(-m.net)}`;
        return `${dayLabel(businessDay(o.created_at))}: ${short(o.title)}: ${$(m.refunds)} refunded to the buyer, ${m.net < 0 ? `lost ${$(-m.net)}` : `still ${$(m.net)} profit`}`;
      };
      const lost = -ref.reduce((t, o) => t + Math.min(0, rowMoney(o).net), 0);
      return {
        text: ref.length ? `**${plural(ref.length, 'refunded sale')} ${when}, ${lost ? `${$(lost)} lost on them` : 'no money lost on them'}.**` : `**No refunds ${when}.**`,
        bullets: [...ref.slice(0, 8).map(line), cancelled.length ? `${plural(cancelled.length, 'order')} ${counts(cancelled.length, 'was', 'were')} cancelled (not counted).` : null].filter(Boolean),
        chips: [`Worst products ${p.label}`, `Profit ${p.label}`],
      };
    }
    default: return null;
  }
}

function answerProducts(ctx, it, worst) {
  const p = it.period || allTime(ctx);
  const all = byProduct(rowsFor(ctx, p));
  const byUnits = !worst && /\b(sold|selling|seller|sells|units|popular|most sold|sell the most)\b/.test(it.raw || '') && !/profit|money|earn/.test(it.raw || '');
  if (worst) {
    const losers = all.filter((x) => x.net < 0).sort((a, b) => a.net - b.net);
    const refundedOk = all.filter((x) => x.net >= 0 && x.refunds).sort((a, b) => a.net - b.net);
    if (!losers.length) return { text: `**No product lost money ${periodPhrase(ctx, p)}.**`, bullets: refundedOk.length ? [`Refunded but still profitable: ${refundedOk.slice(0, 3).map((x) => `${short(x.title, 36)} (${$(x.net)})`).join('; ')}`] : [], chips: [`Top products ${p.label}`] };
    return {
      text: `**${plural(losers.length, 'product')} lost money ${periodPhrase(ctx, p)}.** The worst: ${short(losers[0].title, 50)}, ${$(losers[0].net)} over ${plural(losers[0].n, 'sale')}.`,
      table: { head: ['Product', 'Sold', 'Refunds', 'Profit'], rows: losers.slice(0, 6).map((x) => [short(x.title, 44), String(x.n), String(x.refunds), $(x.net)]) },
      bullets: refundedOk.length ? [`Refunded but still profitable overall: ${refundedOk.slice(0, 3).map((x) => `${short(x.title, 36)} (${$(x.net)})`).join('; ')}`] : [],
      chips: [`Top products ${p.label}`, `Refunds ${p.label}`],
    };
  }
  const list = [...all].sort((a, b) => (byUnits ? b.n - a.n || b.net - a.net : b.net - a.net)).slice(0, 5);
  if (!list.length) return { text: `No costed sales ${periodPhrase(ctx, p)} yet.`, chips: ['Top products all time'] };
  const lead = list[0];
  return {
    text: byUnits
      ? `**Best seller ${periodPhrase(ctx, p)}: ${short(lead.title, 50)}, ${plural(lead.n, 'sale')} (${$(lead.net)} profit).**`
      : `**Most profitable ${periodPhrase(ctx, p)}: ${short(lead.title, 50)}, ${$(lead.net)} from ${plural(lead.n, 'sale')}.**`,
    table: { head: ['Product', 'Sold', 'Profit', 'Per sale'], rows: list.map((x) => [short(x.title, 44), String(x.n), $(x.net), $(Math.round(x.net / x.n))]) },
    chips: [`Worst products ${p.label}`, `Why are we down ${p.label === 'all time' ? 'this month' : p.label}?`],
  };
}

function answerSettlement(ctx, it) {
  const { A, B } = ctx.s;
  const months = allMonths(ctx.orders, ctx.books.expenses);
  const all = months.map((m) => settle(ctx, m));
  const due = (m) => { const [y, mo] = m.split('-').map(Number); return ymdOf(Date.UTC(y, mo - 1, ctx.s.dueDay)); };
  const owedOf = (x) => cents(x.sellerSends) - cents(x.paid || 0);
  const paidList = all.filter((x) => x.paid !== null && cents(x.paid));
  const paidTotal = paidList.reduce((t, x) => t + cents(x.paid), 0);
  const paidDetail = paidList.map((x) => `${monthName(x.month, true).split(' ')[0]} ${$(cents(x.paid))}`).join(', ');
  const whenDue = (m) => { const dd = due(m); const days = Math.round((toUTC(dd) - toUTC(ctx.today)) / 86400_000); return `due ${dayLabel(dd)} (${days < 0 ? `${plural(-days, 'day')} overdue` : days === 0 ? 'today' : `in ${plural(days, 'day')}`})`; };
  if (it.period?.month) {
    const x = all.find((m) => m.month === it.period.month);
    if (!x) return { text: `There's nothing to settle for ${monthName(it.period.month)}.` };
    const o = owedOf(x);
    const state = x.paid !== null && o <= 0 ? `Paid in full${x.paidAt ? ` on ${dayLabel(x.paidAt)}` : ''}.`
      : x.paid !== null ? `${$(cents(x.paid))} paid, ${$(o)} still owed, ${whenDue(x.month)}.`
      : `Not paid yet, ${whenDue(x.month)}.`;
    const share = cents(x.shareAmazon);
    return {
      text: `**${monthName(x.month)}: ${B} sends ${A} ${$(cents(x.sellerSends))}.** ${state}`,
      bullets: [`Amazon cost ${A} paid: ${$(cents(x.cogs))}`, `${A}'s ${ctx.s.split}% share of the ${$(cents(x.businessProfit))} business profit: ${$(share)}`, `${$(cents(x.cogs))} ${share < 0 ? '−' : '+'} ${$(Math.abs(share))} = ${$(cents(x.sellerSends))}`],
      chips: [`What does ${B} owe in total?`, `Profit ${monthName(x.month).split(' ')[0]}`],
    };
  }
  const open = all.filter((x) => owedOf(x) > 0);
  const total = open.reduce((t, x) => t + owedOf(x), 0);
  const owedLines = open.map((x) => `${monthName(x.month)}: ${$(owedOf(x))}, ${whenDue(x.month)}`);
  // "How much has Drew paid me?" leads with what was paid
  if (/\b(paid|sent|received|gotten|got)\b/.test(it.raw || '') && !/\bowe/.test(it.raw || '')) {
    return {
      text: paidList.length ? `**${B} has paid ${A} ${$(paidTotal)} so far** (${paidDetail}).` : `**Nothing has been recorded as paid yet.**`,
      bullets: open.length ? [`Still owed: ${$(total)}`, ...owedLines] : ['Nothing is owed right now.'],
      chips: ['Profit this month'],
    };
  }
  if (!open.length) return { text: `**Everything is settled.** ${B} doesn't owe ${A} anything right now.`, bullets: paidList.length ? [`Paid so far: ${$(paidTotal)} (${paidDetail}).`] : [], chips: ['Profit this month'] };
  return {
    text: `**${B} owes ${A} ${$(total)}**${open.length > 1 ? ` across ${plural(open.length, 'month')}` : ` for ${monthName(open[0].month)}`}.`,
    bullets: [...owedLines, paidList.length ? `Paid so far: ${$(paidTotal)} (${paidDetail}).` : null].filter(Boolean),
    chips: [`How was ${monthName(open.at(-1).month).split(' ')[0]}'s settlement worked out?`, 'Profit this month'],
  };
}

function answerCompare(ctx, it) {
  let [a, b] = it.periods;
  if (!b) { b = a; a = comparisonFor(ctx, b); }
  if (!a || !b) return { text: 'Tell me the two periods, for example “compare August vs September” or “this month vs last month”.' };
  const subject = it.periods[0]; // "is September better than August": September is the one asked about
  if (a.from && b.from && a.from > b.from) [a, b] = [b, a];
  const x = stats(rowsFor(ctx, a)); const y = stats(rowsFor(ctx, b));
  const ox = opexIn(ctx, a); const oy = opexIn(ctx, b);
  const la = shortLabel(a); const lb = shortLabel(b);
  const row = (k, va, vb, fmt = $) => [k, fmt(va), fmt(vb), fmt === $ ? signed$(vb - va) : `${vb - va > 0 ? '+' : vb - va < 0 ? '−' : ''}${Math.abs(vb - va)}`];
  const bx = x.net - ox;
  const by = y.net - oy;
  const dir = (d) => (d > 0 ? 'up' : d < 0 ? 'down' : 'unchanged');
  const perSale = (s) => (s.n ? Math.round(s.avg) : 0);
  let lead = '';
  if (/\b(better|worse|beat|beating|ahead|behind|more|less)\b/.test(it.raw || '') && subject) {
    const subjIsB = subject === b || (subject.from === b.from && subject.to === b.to);
    const subjBetter = subjIsB ? by > bx : bx > by;
    lead = `${subjBetter ? 'Yes' : 'No'}: ${shortLabel(subject)} ${subjBetter ? 'is ahead' : 'is behind'}. `;
  }
  return {
    text: `**${lead}Business profit ${dir(by - bx)} ${$(Math.abs(by - bx))}: ${$(bx)} in ${la} → ${$(by)} in ${lb}${bx ? ` (${by - bx >= 0 ? '+' : '−'}${pct(Math.abs(chg(by, bx)))})` : ''}.**`,
    trend: by >= bx ? 'up' : 'down',
    bullets: [
      `Sales ${dir(y.n - x.n)}${y.n !== x.n ? ` by ${Math.abs(y.n - x.n)}` : ''}: ${x.n} → ${y.n}${x.n && y.n !== x.n ? ` (${y.n > x.n ? '+' : '−'}${pct(Math.abs(chg(y.n, x.n)))})` : ''}`,
      `Profit per sale ${dir(perSale(y) - perSale(x))}: ${$(perSale(x))} → ${$(perSale(y))}`,
      b.partial ? `${lb.replace(/ so far$/, '')} isn't over yet, so it's being compared with a full month.` : null,
    ].filter(Boolean),
    table: { head: ['', la, lb, 'Change'], rows: [
      row('Sales', x.n, y.n, String), row('eBay payouts', x.payout, y.payout), row('Amazon cost', x.cogs, y.cogs), row('Ad fees', x.ads, y.ads),
      row('Item profit', x.net, y.net), row('Operating costs', ox, oy), row('Business profit', bx, by),
    ] },
    chips: [`Why is ${lb.replace(/ so far$/, '')} ${by >= bx ? 'up' : 'down'}?`],
  };
}

// "What sold today?" lists that period's sales; "last 5 sales" the latest ones. Waiting sales are included.
function answerRecent(ctx, it) {
  const raw = it.raw || '';
  const asked = Number(raw.match(/\b(\d{1,2})\s+(sales?|orders?|items?)\b/)?.[1]);
  const single = !asked && /\b(last|latest|most recent|newest)\s+(sale|order)\b/.test(raw);
  const n = Math.min(20, asked || (single ? 1 : it.period ? 20 : 5));
  const pool = ctx.orders.filter((o) => (o.counted || o.status === 'awaiting_cost') && !(o.source === 'ebay' && o.in_sheet) && (!it.period || inPeriod(o, it.period)));
  const rows = pool.sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, n);
  if (!rows.length) return { text: `**No sales ${it.period ? periodPhrase(ctx, it.period) : 'yet'}.**`, chips: ['Last 5 sales', 'Profit this month'] };
  const cell = (o) => (o.counted ? $(rowMoney(o).net) : waitWord(o));
  if (single) { const o = rows[0]; return { text: `**Latest sale: ${short(o.title, 60)}**, ${dayLabel(businessDay(o.created_at))}, ${o.source === 'ledger' ? `${$(cents(o.revenue))} payout` : `sold for ${$(cents(o.revenue))}`}, ${o.counted ? `${$(rowMoney(o).net)} profit` : waitWord(o)}.`, chips: ['Last 5 sales', 'How many sales today?'] }; }
  return {
    text: it.period ? `**${plural(pool.length, 'sale')} ${periodPhrase(ctx, it.period)}${pool.length > rows.length ? ` (latest ${rows.length} shown)` : ''}:**` : `**Latest ${plural(rows.length, 'sale')}:**`,
    table: { head: ['Date', 'Item', 'Sold for', 'Profit'], rows: rows.map((o) => [dayLabel(businessDay(o.created_at)), short(o.title, 40), o.source === 'ledger' ? `${$(cents(o.revenue))} payout` : $(cents(o.revenue)), cell(o)]) },
    chips: ['Profit this month', 'Which sales are awaiting the Amazon email?'],
  };
}

function answerAwaiting(ctx, it) {
  const list = ctx.orders.filter((o) => o.status === 'awaiting_cost' && (!it.period || inPeriod(o, it.period))).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  if (!list.length) return { text: '**Every sale has its Amazon purchase.** Nothing is waiting.', chips: ['Last 5 sales'] };
  const email = list.filter((o) => !o.amazon_orders.length);
  const cost = list.filter((o) => o.amazon_orders.length);
  const parts = [email.length ? `${email.length} for the Amazon order email` : null, cost.length ? `${cost.length} with an Amazon order whose cost is unknown` : null].filter(Boolean);
  const days = (o) => { const n = Math.max(0, Math.floor((Date.now() - new Date(o.created_at)) / 86400_000)); return n === 0 ? 'today' : plural(n, 'day'); };
  return {
    text: list.length === 1
      ? `**1 sale is waiting ${email.length ? 'for its Amazon order email' : 'for its cost to be typed in'}.** It isn't counted in the numbers until it's matched.`
      : `**${list.length} sales are waiting**: ${parts.join(', ')}. They aren't counted in the numbers until they're matched.`,
    table: { head: ['Sold', 'Item', 'Price', 'Waiting for'], rows: list.slice(0, 12).map((o) => [dayLabel(businessDay(o.created_at)), short(o.title, 40), $(cents(o.revenue)), o.amazon_orders.length ? 'its cost' : `email · ${days(o)}`]) },
    bullets: [`To check right away, open the sale in Orders and press **Check email now**. A sale with no Amazon email after ${NOT_MATCHED_DAYS} days is treated as not a dropship sale.`],
    chips: ['Last 5 sales', 'Profit this month'],
  };
}
const NOT_MATCHED_DAYS = 10;

// Best / worst day, week or month by profit
function answerBestPeriod(ctx, it) {
  const m = (it.raw || '').match(/\b(best|worst|biggest|highest|lowest|slowest|busiest|strongest|weakest|top)\s+(day|week|month|weekday)s?\b/);
  const worst = Boolean(m && /worst|lowest|slowest|weakest/.test(m[1]));
  const unit = m ? (m[2] === 'weekday' ? 'day' : m[2]) : 'day';
  const p = it.period || allTime(ctx);
  const rows = rowsFor(ctx, p);
  const dated = unit === 'month' ? rows : rows.filter((o) => !o.approx_date);
  const key = (o) => {
    const d = businessDay(o.created_at);
    if (unit === 'month') return o.business_month;
    if (unit === 'week') { const dow = (new Date(toUTC(d)).getUTCDay() + 6) % 7; return addDays(d, -dow); }
    return d;
  };
  const g = new Map();
  for (const o of dated) { const k = key(o); if (!g.has(k)) g.set(k, []); g.get(k).push(o); }
  const list = [...g.entries()].map(([k, os]) => { const s = stats(os); const net = unit === 'month' ? s.net - opexIn(ctx, { from: monthStart(k), to: monthEnd(k) > ctx.today ? ctx.today : monthEnd(k), month: k }) : s.net; return { k, n: s.n, net }; })
    .sort((a, b) => (worst ? a.net - b.net : b.net - a.net));
  if (!list.length) return { text: rows.length ? `The sales ${periodPhrase(ctx, p)} came from the monthly sheets without exact dates, so they can't be ranked by ${unit}. Ask for the best month instead.` : `No costed sales ${periodPhrase(ctx, p)} yet.`, chips: ['Best month'] };
  const lab = (k) => (unit === 'month' ? monthName(k) : unit === 'week' ? `the week of ${dayLabel(k)}` : dayLabel(k));
  const measure = unit === 'month' ? 'business profit' : 'item profit';
  const skipped = rows.length - dated.length;
  return {
    text: `**${worst ? 'Worst' : 'Best'} ${unit} ${periodPhrase(ctx, p)}: ${lab(list[0].k)}, ${$(list[0].net)} ${measure} from ${plural(list[0].n, 'sale')}.**`,
    table: { head: [unit === 'month' ? 'Month' : unit === 'week' ? 'Week of' : 'Day', 'Sales', measure[0].toUpperCase() + measure.slice(1)], rows: list.slice(0, 5).map((x) => [unit === 'week' ? dayLabel(x.k) : lab(x.k), String(x.n), $(x.net)]) },
    bullets: skipped ? [`${plural(skipped, 'monthly-sheet sale')} without an exact date ${isAre(skipped)} left out of the ${unit} ranking.`] : [],
    chips: [`${worst ? 'Best' : 'Worst'} ${unit}`, 'Profit this month'],
  };
}

function answerExpenses(ctx, it) {
  const p = it.period || defaultPeriod(ctx);
  let list = ctx.books.expenses.filter((e) => (p.month ? e.month === p.month : p.all || (monthEnd(e.month) >= (p.from || '0') && monthStart(e.month) <= p.to)));
  // "how much are proxies costing us": just the matching expense lines
  const words = tokens(it.raw || '').filter((w) => w.length >= 4 && !['operating', 'expense', 'expenses', 'costs', 'cost', 'costing', 'monthly', 'much', 'spend', 'what', 'much', 'this', 'month'].includes(w));
  const hit = list.filter((e) => words.some((w) => tokens(e.category).some((c) => like(w, c) || c.startsWith(w.slice(0, 5)) || w.startsWith(c.slice(0, 5)))));
  if (hit.length) {
    const sum = hit.reduce((t, e) => t + cents(e.amount), 0);
    return { text: `**${[...new Set(hit.map((e) => e.category))].join(', ')} ${periodPhrase(ctx, p)}: ${$(sum)}.**`, table: { head: ['Month', 'Expense', 'Amount'], rows: hit.map((e) => [monthName(e.month, true), e.category, $(cents(e.amount))]) }, chips: ['What are our operating costs?'] };
  }
  const total = opexIn(ctx, p);
  if (!list.length) return { text: `No operating costs recorded ${periodPhrase(ctx, p)}.`, chips: ['Operating costs last month'] };
  return {
    text: `**Operating costs ${periodPhrase(ctx, p)}: ${$(total)}.** ${ctx.s.B} pays these, and they come out of profit before the split.`,
    table: { head: ['Month', 'Expense', 'Amount'], rows: list.map((e) => [monthName(e.month, true), e.category, $(cents(e.amount))]) },
    bullets: opexSplit(ctx, p) ? ['Months only partly inside the period count by their share of days.'] : [],
    chips: [`Profit ${p.label}`],
  };
}

function answerListings(ctx, it) {
  const F = listingFacts(ctx);
  if (!F) return { text: 'Listing data isn’t in yet. It fills in on the next eBay sync.', chips: ['Top products this month'] };
  const { L } = F;
  const T = L.totals;
  const monthRow = it.period?.month ? (L.byMonth || []).find((x) => x.month === it.period.month) : null;
  const bullets = [
    monthRow ? `Posted in ${monthName(it.period.month)}: **${fmtN(monthRow.added)}**${it.period.partial ? ' so far' : ''} (${fmtN(monthRow.ended)} ended)` : null,
    `${fmtN(L.added?.last30)} posted in the last 30 days, ${fmtN(L.added?.endedLast30)} ended`,
    T.avgViewsPerListing !== null ? `Views per listing: **${fmtN(T.avgViewsPerListing, 1)}** ${T.viewsSource === 'analytics_30d' ? 'in the last 30 days' : 'lifetime'}` : 'Views per listing: needs one more eBay permission (Settings → Connect eBay)',
    T.avgWatchersPerListing !== null ? `Watchers per listing: **${fmtN(T.avgWatchersPerListing, 2)}** (${fmtN(T.totalWatchers)} in total)` : null,
    L.top?.byViews?.length ? `Most viewed: ${L.top.byViews.slice(0, 3).map((x) => `${short(x.title, 30)} (${fmtN(x.views)} views, ${fmtN(x.quantitySold)} sold)`).join('; ')}` : null,
    L.top?.byWatchers?.length ? `Most watched: ${L.top.byWatchers.slice(0, 3).map((x) => `${short(x.title, 30)} (${fmtN(x.watchers)})`).join('; ')}` : null,
    L.sellThrough?.pctListingsWithSale !== null && L.sellThrough?.pctListingsWithSale !== undefined ? `${fmtN(L.sellThrough.pctListingsWithSale, 1)}% of active listings have sold at least once` : null,
    L.stale?.count ? `**${plural(L.stale.count, 'listing')} to refresh or remove**: live 30+ days with no sales${L.stale.criteria?.viewsBelowMedian !== null ? ' and below-median views' : ''} (Products → Listings)` : null,
    listingDrivers(ctx)?.summary || null,
  ].filter(Boolean);
  return { text: `**You have ${fmtN(T.activeListings)} active eBay listings.**`, bullets, chips: ['Why do we have more listings but fewer sales?', 'Top products this month'] };
}

function answerProduct(ctx, it) {
  const p = it.period || allTime(ctx);
  const rows = rowsFor(ctx, p, it.product);
  if (!rows.length) return { text: `No costed sales matching “${it.product.join(' ')}” ${periodTitle(ctx, p)}.`, chips: ['Top products all time'] };
  const s = stats(rows);
  const titles = [...new Set(rows.map((o) => o.title))];
  return {
    text: `**“${short(titles[0], 60)}”${titles.length > 1 ? ` (+${titles.length - 1} similar)` : ''}: ${plural(s.n, 'sale')}, ${$(s.net)} profit ${periodTitle(ctx, p)}.**`,
    bullets: [`Per sale: ${$(Math.round(s.payout / s.n))} payout, ${$(Math.round(s.cogs / s.n))} Amazon cost, ${$(Math.round(s.avg))} profit`, s.refundedSales ? plural(s.refundedSales, 'refund') : 'No refunds', `Last sold ${dayLabel(businessDay(rows.map((o) => o.created_at).sort().at(-1)))}`],
    chips: ['Top products all time'],
  };
}

const HELP = {
  text: 'I answer questions about the business from your own numbers. For example:',
  bullets: ['How much did we make this month?', 'Why are we down this month?', 'What does Drew owe?', 'How many sales today?', 'Which sales are awaiting the Amazon email?', 'Top products this month', 'What should we stop selling?', 'Compare August vs September', 'What was our best day?', 'How much did we spend on Amazon in September?', 'How many listings do we have?'],
  chips: ['How much did we make this month?', 'What does Drew owe?', 'How many sales today?'],
};

// Plain-English name of what a question was read as (shown under each answer)
const TOPIC_LABELS = {
  why: 'Why it changed', listings_vs_sales: 'Listings vs sales', listings: 'Listings', compare: 'Comparison', settlement: 'Settlement', top: 'Top products',
  worst: 'Weakest products', recent: 'Sales list', expenses: 'Operating costs', product: 'One product', profit: 'Profit', count: 'Number of sales',
  revenue: 'eBay payouts', cogs: 'Amazon cost', fees: 'Ad fees', margin: 'Margin', aov: 'Average sale', refunds: 'Refunds', awaiting: 'Sales awaiting Amazon',
  best_period: 'Best / worst period',
};

// Topics the local AI model can route a question to. It's only asked when the built-in reader couldn't read the question.
export const TOPICS = {
  why_change: 'why', listings_vs_sales: 'listings_vs_sales', listings: 'listings', profit: 'profit', sales_count: 'count', revenue: 'revenue',
  amazon_cost: 'cogs', fees: 'fees', margin: 'margin', average_order: 'aov', refunds: 'refunds', expenses: 'expenses', settlement: 'settlement',
  top_products: 'top', worst_products: 'worst', product: 'product', compare: 'compare', recent_sales: 'recent', awaiting_amazon: 'awaiting', best_period: 'best_period',
};
function fromRoute(route, ctx, question) {
  const intent = TOPICS[route?.topic];
  if (!intent) return null;
  // Periods written in the question itself always win over the model's reading of them
  const own = parsePeriods(question, ctx.today);
  const periods = own.length ? own : [...parsePeriods(route.period || '', ctx.today), ...parsePeriods(route.compare_to || '', ctx.today)];
  const product = route.product ? findProduct(ctx, tokens(route.product)) : null;
  if (intent === 'product' && !product) return null;
  return { intent, period: periods[0] || null, periods, product, direction: null };
}

// route: optional { topic, period, compare_to, product } from the local AI model. The built-in reader decides whenever it
// recognises the question; the model's reading is only used for questions the reader couldn't place.
const DEFAULT_ALL = new Set(['top', 'worst', 'product', 'best_period']);
const NO_PERIOD = new Set(['settlement', 'listings', 'listings_vs_sales', 'awaiting', 'recent', 'help', 'compare']);

export async function ask(question, prev = null, route = null) {
  const ctx = await load();
  const parsed = understand(question, ctx, prev);
  const modelRead = fromRoute(route, ctx, question);
  const routed = parsed.intent === 'help' ? modelRead : null;
  const it = { ...(routed || parsed), raw: norm(question) };
  // "that month" with no earlier context: the model's reading of the conversation supplies the period
  if (!routed && !it.period && modelRead?.period && DEICTIC.test(it.raw)) { it.period = modelRead.period; it.periods = modelRead.periods; }
  // The period an answer covers when the question didn't name one: products and records all time, everything else this month
  if (!it.period && !NO_PERIOD.has(it.intent)) { it.period = DEFAULT_ALL.has(it.intent) || it.product ? allTime(ctx) : defaultPeriod(ctx); it.defaulted = true; }
  if (routed && !it.direction) it.direction = parsed.direction;
  let ans;
  switch (it.intent) {
    case 'why': ans = answerWhy(ctx, it); break;
    case 'listings_vs_sales': ans = answerListingsVsSales(ctx); break;
    case 'listings': ans = answerListings(ctx, it); break;
    case 'compare': ans = answerCompare(ctx, it); break;
    case 'settlement': ans = answerSettlement(ctx, it); break;
    case 'top': ans = answerProducts(ctx, it, false); break;
    case 'worst': ans = answerProducts(ctx, it, true); break;
    case 'recent': ans = answerRecent(ctx, it); break;
    case 'expenses': ans = answerExpenses(ctx, it); break;
    case 'product': ans = answerProduct(ctx, it); break;
    case 'awaiting': ans = answerAwaiting(ctx, it); break;
    case 'best_period': ans = answerBestPeriod(ctx, it); break;
    case 'help': ans = HELP; break;
    default: ans = answerMetric(ctx, it) || HELP;
  }
  // The client sends this back as context for follow-ups ("what about July?")
  const context = { intent: it.intent === 'help' ? prev?.intent || null : it.intent, period: it.period, product: it.product };
  const understood = it.intent === 'help' ? null : {
    topic: it.intent, label: TOPIC_LABELS[it.intent] || it.intent, by: routed ? 'model' : 'reader',
    period: it.intent === 'compare' ? it.periods.map((x) => x.label).join(' vs ') || null : it.period ? periodTitle(ctx, it.period) : null,
    product: it.product?.join(' ') || null,
  };
  return { ...ans, understood, context };
}

export const _test = { parsePeriods, understand: (q, ctx, prev) => understand(q, ctx, prev), osa, listingsVsSales: (listings) => answerListingsVsSales({ listings }) };
