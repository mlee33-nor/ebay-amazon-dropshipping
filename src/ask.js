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
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

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
export function parsePeriods(q, today = businessDay(new Date())) {
  const t = fixMonths(norm(q));
  const curM = today.slice(0, 7);
  const out = [];
  const span = (from, to, label, extra = {}) => ({ from, to: to > today ? today : to, label, ...extra });
  const month = (m, label) => span(monthStart(m), monthEnd(m), label || monthName(m), { month: m, partial: m === curM });
  if (/\btoday\b/.test(t)) out.push(span(today, today, 'today'));
  if (/\byesterday\b/.test(t)) { const y = addDays(today, -1); out.push(span(y, y, 'yesterday')); }
  const dow = (new Date(toUTC(today)).getUTCDay() + 6) % 7; // Monday = 0
  if (/\bthis week\b/.test(t)) out.push(span(addDays(today, -dow), today, 'this week', { kind: 'week' }));
  if (/\blast week\b/.test(t)) out.push(span(addDays(today, -dow - 7), addDays(today, -dow - 1), 'last week', { kind: 'week' }));
  if (/\b(this month|month to date|mtd|so far this month)\b/.test(t)) out.push(month(curM, 'this month'));
  if (/\blast month\b/.test(t)) out.push(month(shiftMonth(curM, -1), `last month (${monthName(shiftMonth(curM, -1))})`));
  if (/\b(this year|ytd|year to date)\b/.test(t)) out.push(span(`${today.slice(0, 4)}-01-01`, today, `this year`));
  const lastN = t.match(/\b(?:last|past|previous)\s+(\d{1,3})\s+(day|week|month)s?\b/);
  if (lastN) {
    const n = Number(lastN[1]);
    const days = lastN[2] === 'day' ? n : lastN[2] === 'week' ? n * 7 : n * 30;
    out.push(span(addDays(today, -(days - 1)), today, `the last ${n} ${lastN[2]}${n === 1 ? '' : 's'}`, { kind: 'window', days }));
  }
  const q3 = t.match(/\bq([1-4])(?:\s+(20\d\d))?\b/);
  if (q3) { const y = q3[2] || today.slice(0, 4); const s = `${y}-${String((Number(q3[1]) - 1) * 3 + 1).padStart(2, '0')}`; out.push(span(monthStart(s), monthEnd(shiftMonth(s, 2)), `Q${q3[1]} ${y}`)); }
  for (const m of t.matchAll(MONTH_RE)) {
    const word = m[1];
    // "may" is also an ordinary word: only a month when it looks like one
    if (word === 'may' && !m[2] && !/\b(in|for|of|during|since|from|to|vs|and)\s+may\b/.test(t)) continue;
    let y = Number(m[2] || today.slice(0, 4));
    let key = `${y}-${String(monthIdx(word) + 1).padStart(2, '0')}`;
    if (!m[2] && key > curM) key = `${y - 1}${key.slice(4)}`; // "December" in September means last December
    const since = new RegExp(`\\bsince\\s+${word}`).test(t);
    out.push(since ? span(monthStart(key), today, `since ${monthName(key)}`) : month(key));
  }
  if (/\b(all time|alltime|ever|overall|lifetime|since (we )?(start|started|began|opened)|in total|total so far|to date)\b/.test(t)) out.push({ from: null, to: today, label: 'all time', all: true });
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
function findProduct(ctx, toks) {
  const cand = toks.filter((t) => t.length >= 3 && !STOP.has(t) && !ALL_VOCAB.has(t) && !/^\d+$/.test(t) && !MONTH_NAMES.some((m) => m.startsWith(t.slice(0, 3)) && t.length <= m.length));
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
function understand(question, ctx, prev) {
  const text = norm(question);
  const toks = tokens(question);
  const periods = parsePeriods(question, ctx.today);
  const product = findProduct(ctx, toks);
  const is = (k) => hasWord(toks, VOCAB[k]);
  let intent = null;
  if (is('why') || /\bhow come\b|\bwhat (happened|went wrong)\b/.test(text)) intent = is('listings') ? 'listings_vs_sales' : 'why';
  else if (is('listings') && !is('settle')) intent = 'listings';
  else if (periods.length >= 2 && (is('compare') || /\band\b/.test(text))) intent = 'compare';
  else if (is('compare') && periods.length === 1) intent = 'compare';
  else if (is('settle') && !is('why')) intent = 'settlement';
  else if (is('worst')) intent = product ? 'product' : 'worst';
  else if (is('top') || hasPhrase(text, ['best seller', 'best selling', 'sells best', 'sell the most', 'sold the most', 'most sold', 'most popular'])) intent = 'top';
  else if (hasPhrase(text, ['last sale', 'latest sale', 'recent sale', 'last order', 'latest order', 'recent order', 'newest sale', 'last few sales', 'last 5 sales', 'last 10 sales', 'recent sales'])) intent = 'recent';
  else if (is('expenses') || hasPhrase(text, ['operating cost', 'operating costs'])) intent = 'expenses';
  else if (is('refunds')) intent = 'refunds';
  else if (is('margin')) intent = 'margin';
  else if (is('aov') && is('count')) intent = 'aov';
  else if (is('fees')) intent = 'fees';
  else if (hasPhrase(text, ['amazon cost', 'amazon costs', 'spent on amazon', 'cost of goods', 'cogs', 'spend on amazon'])) intent = 'cogs';
  else if (hasPhrase(text, ['how many', 'number of']) || (is('count') && !is('profit') && !is('revenue'))) intent = 'count';
  else if (is('revenue') || hasPhrase(text, ['in sales', 'sales total', 'total sales'])) intent = 'revenue';
  else if (is('profit')) intent = 'profit';
  else if (product) intent = 'product';
  else if (prev?.intent && (periods.length || /^(what about|and|how about|same for)\b/.test(text))) intent = prev.intent;
  else if (is('products')) intent = 'top';

  // Follow-ups: "what about August?" keeps the topic; "and refunds?" keeps the period
  let period = periods[0] || null;
  if (!period && prev?.period && intent && intent !== 'help') period = prev.period;
  const direction = is('up') && !is('down') ? 'up' : is('down') && !is('up') ? 'down' : null;
  return { intent: intent || 'help', period, periods, product: product || (intent === prev?.intent ? prev?.product : null) || null, direction, listingsWord: is('listings') };
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
const periodTitle = (ctx, p) => (p.month && p.partial ? `this month (${monthName(p.month, true).split(' ')[0]} 1–${Number(ctx.today.slice(8))})` : p.label);

function answerWhy(ctx, it) {
  const p = it.period || defaultPeriod(ctx);
  const c = comparisonFor(ctx, p);
  if (!c) return { text: 'A “why” needs something to compare against. Try “why are we down this month?” or “why was August better than July?”.', chips: ['Why are we down this month?', 'Compare August vs September'] };
  const cur = stats(rowsFor(ctx, p));
  const prv = stats(rowsFor(ctx, c));
  const d = cur.net - prv.net;
  const up = d >= 0;
  const lines = [];
  const bullets = [];
  const wrongPremise = (it.direction === 'down' && d > 0) || (it.direction === 'up' && d < 0);
  const head = `Item profit ${periodTitle(ctx, p)} is ${$(cur.net)}, ${up ? 'up' : 'down'} ${$(Math.abs(d))}${prv.net ? ` (${pct(Math.abs(chg(cur.net, prv.net)))})` : ''} vs ${c.label} (${$(prv.net)}).`;
  lines.push(`**${wrongPremise ? `We're actually ${up ? 'up' : 'down'}, not ${up ? 'down' : 'up'}. ` : ''}${head}**`);
  if (!cur.n && !prv.n) return { text: `There are no costed sales in ${p.label} or ${c.label} to compare yet.` };

  // Driver 1: number of sales (volume), driver 2: profit per sale; they add up to the change exactly
  const volume = Math.round((cur.n - prv.n) * prv.avg);
  const perSale = d - volume;
  const drivers = [];
  if (cur.n !== prv.n) drivers.push({ v: volume, t: `**${cur.n < prv.n ? 'Fewer' : 'More'} sales:** ${cur.n} vs ${prv.n} (${cur.n - prv.n > 0 ? '+' : '−'}${Math.abs(cur.n - prv.n)}${prv.n ? `, ${cur.n - prv.n > 0 ? '+' : '−'}${pct(Math.abs(chg(cur.n, prv.n)))}` : ''}). At last period's ${$(Math.round(prv.avg))} average profit per sale, that is **${signed$(volume)}** (${volume < 0 ? 'pulled profit down' : 'pushed profit up'}).` });
  if (cur.n && Math.abs(perSale) >= 1) {
    // What moved the average profit per sale, in dollars across this period's sales
    const avg = (s, k) => (s.n ? s[k] / s.n : 0);
    const parts = [
      ['payout per sale', (avg(cur, 'payout') - avg(prv, 'payout')) * cur.n, `${$(Math.round(avg(prv, 'payout')))} → ${$(Math.round(avg(cur, 'payout')))}`],
      ['Amazon cost per sale', -(avg(cur, 'cogs') - avg(prv, 'cogs')) * cur.n, `${$(Math.round(avg(prv, 'cogs')))} → ${$(Math.round(avg(cur, 'cogs')))}`],
      ['ad fees per sale', -(avg(cur, 'ads') - avg(prv, 'ads')) * cur.n, `${$(Math.round(avg(prv, 'ads')))} → ${$(Math.round(avg(cur, 'ads')))}`],
    ].filter(([, v]) => Math.abs(v) >= 100).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    drivers.push({ v: perSale, t: `**${perSale < 0 ? 'Less' : 'More'} profit per sale:** ${$(Math.round(prv.avg))} → ${$(Math.round(cur.avg))}, worth **${signed$(perSale)}** (${perSale < 0 ? 'pulled profit down' : 'pushed profit up'}).${parts.length ? ` Mostly ${parts.slice(0, 2).map(([k, v, s]) => `${k} (${s}, ${signed$(Math.round(v))})`).join(' and ')}.` : ''}` });
  }
  drivers.sort((a, b) => (up ? b.v - a.v : a.v - b.v));
  bullets.push(...drivers.map((x) => x.t));

  // Refunds and losing sales
  if (cur.refunds || prv.refunds) {
    const dr = cur.refunds - prv.refunds;
    if (Math.abs(dr) >= 100) bullets.push(`**Refunds:** ${plural(cur.refundedSales, 'refunded sale')} cost ${$(cur.refunds)} vs ${$(prv.refunds)} before (${signed$(-dr)} to profit, ${dr > 0 ? 'pulled profit down' : 'pushed profit up'}).`);
  }
  if (cur.losses.length) bullets.push(`**${plural(cur.losses.length, 'sale')} lost money** (${$(cur.losses.reduce((t, x) => t + x.net, 0))}): ${cur.losses.slice(0, 3).map((x) => `${short(x.o.title, 34)} ${$(x.net)}`).join(', ')}.`);

  // Products that carried the earlier period but didn't this time
  const pc = new Map(byProduct(rowsFor(ctx, p)).map((x) => [productKey({ title: x.title }), x]));
  const swings = byProduct(rowsFor(ctx, c)).map((x) => ({ title: x.title, was: x.net, now: pc.get(productKey({ title: x.title }))?.net || 0 }))
    .map((x) => ({ ...x, d: x.now - x.was })).filter((x) => (up ? x.d > 0 : x.d < 0)).sort((a, b) => (up ? b.d - a.d : a.d - b.d)).slice(0, 3);
  if (!up && swings.length && swings[0].d <= -500) bullets.push(`**Products that earned less:** ${swings.map((x) => `${short(x.title, 32)} (${$(x.was)} → ${$(x.now)})`).join('; ')}.`);
  if (up) {
    const risers = byProduct(rowsFor(ctx, p)).sort((a, b) => b.net - a.net).slice(0, 3);
    if (risers.length) bullets.push(`**Biggest earners:** ${risers.map((x) => `${short(x.title, 32)} ${$(x.net)}`).join('; ')}.`);
  }

  // Not in profit yet
  const aw = awaitingFor(ctx, p);
  if (aw.length) bullets.push(`**${plural(aw.length, 'sale')} (${$(aw.reduce((t, o) => t + cents(o.revenue), 0))}) aren't in profit yet**: they're waiting for the Amazon order email, so the real number may be higher.`);

  // Operating costs
  const oc = opexIn(ctx, p);
  const op = opexIn(ctx, c);
  const word = (a, b) => (a > b ? 'higher' : a < b ? 'lower' : 'the same');
  if (oc || op) bullets.push(`**Operating costs were ${word(oc, op)}:** ${$(oc)} in ${periodTitle(ctx, p)} vs ${$(op)} in ${c.label}${p.partial ? ' (this month counts in full, like the settlement)' : ''}. Business profit after them was ${word(cur.net - oc, prv.net - op)}: ${$(cur.net - oc)} vs ${$(prv.net - op)}.`);

  // Listing traffic, when available
  const L = listingDrivers(ctx);
  if (L) bullets.push(L.summary);
  if (p.partial) bullets.push(`The month isn't over: ${daysIn(p.month) - Number(ctx.today.slice(8))} days left.`);

  return {
    text: lines.join('\n'),
    trend: up ? 'up' : 'down',
    bullets,
    chips: [cur.losses.length ? `Losing sales ${p.label}` : null, `Top products ${p.label}`, it.period?.month ? null : 'Compare last month vs this month', 'Why do we have more listings but fewer sales?'].filter(Boolean),
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
  const bits = [trend(F, 'listings', 'active listings'), F.traffic ? trend(F, 'viewsPerListing', 'views per listing', 1) : null, F.traffic ? trend(F, 'salesRate', 'orders per 100 views', 2) : null].filter(Boolean);
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
    F.traffic ? trend(F, 'salesRate', '**Orders per 100 views**', 2) : null,
  ].filter(Boolean);
  const reasons = [];
  if (F.traffic) {
    if (ch('listings') > 0.05 && ch('viewsPerListing') < -0.05) reasons.push('you have more listings, but each one gets fewer views. The new listings aren’t pulling in much traffic, so the same views are spread across more items');
    if (ch('impressions') > 0.05 && ch('viewRate') < -0.05) reasons.push('eBay shows your listings more often, but fewer people click them. Price, main photo and title decide that click');
    if (ch('views') >= -0.05 && ch('salesRate') < -0.05) reasons.push('people still look at the listings, but fewer of them buy. Compare prices with competitors and check the handling time');
    if (ch('impressions') < -0.05) reasons.push('eBay is showing your listings less often in search. Listings lose visibility as they age, and promoted-listing changes matter too');
  } else if (ch('listings') > 0.05 && ch('orders') < -0.05) {
    reasons.push('listings are up while orders are down. I can’t see views yet, so I can’t tell whether the new listings aren’t being seen or aren’t converting. Reconnect eBay in Settings to allow listing traffic');
  }
  const text = reasons.length
    ? `**Short answer: ${reasons[0]}.**${reasons.length > 1 ? ` Also, ${reasons.slice(1).join('; also, ')}.` : ''}`
    : '**Listing traffic and conversion are roughly steady**, so the change in sales looks like normal variation rather than a listings problem.';
  if (F.L.stale?.count) bullets.push(`**${plural(F.L.stale.count, 'listing')} ${F.L.stale.count === 1 ? 'has' : 'have'} been live 30+ days with no sales${F.L.stale.criteria?.viewsBelowMedian !== null && F.L.stale.criteria?.viewsBelowMedian !== undefined ? ' and below-median views' : ''}.** Refreshing or ending them keeps the store focused (Products → Listings).`);
  return { text, bullets, chips: ['Which listings get the most views?', 'Why are we down this month?'] };
}

function answerMetric(ctx, it) {
  const p = it.period || (it.product ? allTime(ctx) : defaultPeriod(ctx));
  const rows = rowsFor(ctx, p, it.product);
  const s = stats(rows);
  const what = it.product ? ` on “${it.product.join(' ')}”` : '';
  const when = periodTitle(ctx, p);
  const aw = it.product ? [] : awaitingFor(ctx, p);
  const awNote = aw.length ? ` ${plural(aw.length, 'more sale')} ${aw.length === 1 ? 'is' : 'are'} waiting for an Amazon cost and ${aw.length === 1 ? 'isn’t' : 'aren’t'} included yet.` : '';
  switch (it.intent) {
    case 'profit': {
      const oc = it.product ? 0 : opexIn(ctx, p);
      const txt = it.product
        ? `**We made ${$(s.net)} profit${what} ${when}** across ${plural(s.n, 'sale')} (${$(s.n ? Math.round(s.net / s.n) : 0)} per sale).`
        : `**Net business profit ${when}: ${$(s.net - oc)}.** That's ${$(s.net)} item profit from ${plural(s.n, 'sale')} minus ${$(oc)} operating costs.${awNote}`;
      const b = [];
      if (!it.product && p.month) { const st = settle(ctx, p.month); b.push(`Settlement for ${monthName(p.month)}: ${ctx.s.B} sends ${ctx.s.A} ${$(cents(st.sellerSends))}.`); }
      return { text: txt, bullets: b, chips: [`Why are we ${s.net >= 0 ? 'up' : 'down'} ${p.label}?`, `Top products ${p.label}`, `How many sales ${p.label}?`] };
    }
    case 'count': return { text: `**${plural(s.n, 'sale')}${what} ${when}** counted in profit.${awNote}${s.refundedSales ? ` ${s.refundedSales} of them had a refund.` : ''}`, chips: [`Profit ${p.label}`, `Average order ${p.label}`] };
    case 'revenue': return { text: `**eBay payouts${what} ${when}: ${$(s.payout)}** from ${plural(s.n, 'sale')} (after eBay's final value fees and buyer refunds).`, bullets: [`Buyers paid ${$(s.revenue)} before fees on eBay-synced sales (monthly-sheet rows only record the payout).`], chips: [`Profit ${p.label}`, `Fees ${p.label}`] };
    case 'cogs': return { text: `**Amazon cost${what} ${when}: ${$(s.cogs)}** across ${plural(s.n, 'sale')} (${$(s.n ? Math.round(s.cogs / s.n) : 0)} per sale). ${ctx.s.A} pays this and gets it back in the settlement.`, chips: [`Profit ${p.label}`, `What does ${ctx.s.B} owe?`] };
    case 'fees': return { text: `**Ad fees${what} ${when}: ${$(s.ads)}** (${pct(s.payout ? s.ads / s.payout : null)} of payouts). eBay's final value fees are already taken out of the payouts.`, chips: [`Profit ${p.label}`, `Margin ${p.label}`] };
    case 'margin': return { text: `**Margin${what} ${when}: ${pct(s.payout ? s.net / s.payout : null)}** of payouts (${$(s.net)} profit on ${$(s.payout)}). Return on Amazon spend: ${pct(s.cogs ? s.net / s.cogs : null)}.`, chips: [`Why are we down ${p.label}?`, `Worst products ${p.label}`] };
    case 'aov': return { text: `**Average sale${what} ${when}: ${$(s.n ? Math.round(s.payout / s.n) : 0)} payout, ${$(s.n ? Math.round(s.net / s.n) : 0)} profit** across ${plural(s.n, 'sale')}.`, chips: [`Top products ${p.label}`] };
    case 'refunds': {
      const ref = rows.filter((o) => cents(o.refunds) > 0 || o.status === 'returned');
      return {
        text: `**${plural(ref.length, 'sale')} with a refund${what} ${when}: ${$(s.refunds)} refunded.**`,
        bullets: ref.slice(0, 6).map((o) => `${dayLabel(businessDay(o.created_at))}: ${short(o.title)} ${$(cents(o.refunds))} refunded, ${$(rowMoney(o).net)} net${o.ledger?.note ? ` (${short(o.ledger.note, 30)})` : ''}`),
        chips: [`Losing sales ${p.label}`, `Profit ${p.label}`],
      };
    }
    default: return null;
  }
}

function answerProducts(ctx, it, worst) {
  const p = it.period || allTime(ctx);
  const list = byProduct(rowsFor(ctx, p)).sort((a, b) => (worst ? a.net - b.net : b.net - a.net));
  const byUnits = !worst && /sold|selling|seller|units|popular|most/.test(it.raw || '') && !/profit/.test(it.raw || '');
  if (byUnits) list.sort((a, b) => b.n - a.n || b.net - a.net);
  const top = (worst ? list.filter((x) => x.net < 0 || x.refunds) : list).slice(0, 5);
  if (!top.length) return { text: worst ? `No product lost money ${p.label}.` : `No costed sales ${p.label} yet.`, chips: [`Top products ${p.label}`] };
  return {
    text: `**${worst ? 'Weakest' : byUnits ? 'Best-selling' : 'Most profitable'} products ${periodTitle(ctx, p)}:**`,
    table: { head: ['Product', 'Sold', 'Profit', 'Per sale'], rows: top.map((x) => [short(x.title, 44), String(x.n), $(x.net), $(Math.round(x.net / x.n))]) },
    bullets: worst ? top.filter((x) => x.refunds).slice(0, 3).map((x) => `${short(x.title, 40)}: ${plural(x.refunds, 'refund')}`) : [],
    chips: [worst ? `Top products ${p.label}` : `Worst products ${p.label}`, `Why are we down ${p.label === 'all time' ? 'this month' : p.label}?`],
  };
}

function answerSettlement(ctx, it) {
  const { A, B } = ctx.s;
  const months = allMonths(ctx.orders, ctx.books.expenses);
  const all = months.map((m) => settle(ctx, m));
  const due = (m) => { const [y, mo] = m.split('-').map(Number); return ymdOf(Date.UTC(y, mo - 1, ctx.s.dueDay)); };
  const pick = it.period?.month ? all.filter((x) => x.month === it.period.month) : null;
  const owedOf = (x) => cents(x.sellerSends) - cents(x.paid || 0);
  if (pick) {
    const x = pick[0];
    if (!x) return { text: `There's nothing to settle for ${it.period.label}.` };
    const o = owedOf(x);
    return {
      text: `**${monthName(x.month)}: ${B} sends ${A} ${$(cents(x.sellerSends))}**, due ${dayLabel(due(x.month))}. ${x.paid !== null ? (o <= 0 ? `✓ Paid${x.paidAt ? ` on ${dayLabel(x.paidAt)}` : ''}.` : `${$(cents(x.paid))} paid, ${$(o)} still owed.`) : 'Not paid yet.'}`,
      bullets: [`Amazon cost ${A} paid: ${$(cents(x.cogs))}`, `Net business profit ${$(cents(x.businessProfit))}, so ${A}'s ${ctx.s.split}% share is ${$(cents(x.shareAmazon))}`, `${$(cents(x.cogs))} + ${$(cents(x.shareAmazon))} = ${$(cents(x.sellerSends))}`],
      chips: ['What is owed across all months?', `Profit ${it.period.label}`],
    };
  }
  const open = all.filter((x) => owedOf(x) > 0);
  const total = open.reduce((t, x) => t + owedOf(x), 0);
  if (!open.length) return { text: `**Everything is settled.** ${B} doesn't owe ${A} anything right now.`, bullets: all.slice(-3).map((x) => `${monthName(x.month)}: ${$(cents(x.sellerSends))} ✓`), chips: ['Profit this month'] };
  return {
    text: `**${B} owes ${A} ${$(total)}** across ${plural(open.length, 'month')}.`,
    bullets: open.map((x) => { const dd = due(x.month); const late = dd < ctx.today; const days = Math.round((toUTC(dd) - toUTC(ctx.today)) / 86400_000); return `${monthName(x.month)}: ${$(owedOf(x))}, due ${dayLabel(dd)} (${late ? `${-days} days overdue` : days === 0 ? 'today' : `in ${days} days`})`; }),
    chips: [open.at(-1) ? `How was ${monthName(open.at(-1).month).split(' ')[0]}'s settlement calculated?` : 'Profit this month'],
  };
}

function answerCompare(ctx, it) {
  let [a, b] = it.periods;
  if (!b) { b = a; a = comparisonFor(ctx, b); }
  if (!a || !b) return { text: 'Tell me the two periods, for example “compare August vs September” or “this month vs last month”.' };
  if (a.from && b.from && a.from > b.from) [a, b] = [b, a];
  const x = stats(rowsFor(ctx, a)); const y = stats(rowsFor(ctx, b));
  const ox = opexIn(ctx, a); const oy = opexIn(ctx, b);
  const row = (k, va, vb, fmt = $) => [k, fmt(va), fmt(vb), fmt === $ ? signed$(vb - va) : `${vb - va >= 0 ? '+' : ''}${vb - va}`];
  // Ready-made sentences with the direction spelled out, so nothing has to be worked out from the table
  const bx = x.net - ox;
  const by = y.net - oy;
  const dir = (d) => (d > 0 ? 'up' : d < 0 ? 'down' : 'unchanged');
  const sentence = (label, va, vb) => `${label} ${dir(vb - va)} ${$(Math.abs(vb - va))}: ${$(va)} in ${a.label} → ${$(vb)} in ${b.label}${va ? ` (${vb - va >= 0 ? '+' : '−'}${pct(Math.abs(chg(vb, va)))})` : ''}`;
  const perSale = (s) => (s.n ? Math.round(s.avg) : 0);
  return {
    text: `**${sentence('Business profit', bx, by)}.**`,
    trend: by >= bx ? 'up' : 'down',
    bullets: [
      `Sales ${dir(y.n - x.n)} by ${Math.abs(y.n - x.n)}${x.n ? ` (${y.n - x.n >= 0 ? '+' : '−'}${pct(Math.abs(chg(y.n, x.n)))})` : ''}: ${x.n} in ${a.label} → ${y.n} in ${b.label}`,
      `${sentence('Item profit', x.net, y.net)}`,
      `Profit per sale ${dir(perSale(y) - perSale(x))}: ${$(perSale(x))} → ${$(perSale(y))}`,
      `${sentence('Operating costs', ox, oy)}`,
      b.partial ? `${b.label} isn't over yet.` : null,
    ].filter(Boolean),
    table: { head: ['', a.label, b.label, 'Change'], rows: [
      row('Sales', x.n, y.n, String), row('eBay payouts', x.payout, y.payout), row('Amazon cost', x.cogs, y.cogs), row('Ad fees', x.ads, y.ads),
      row('Item profit', x.net, y.net), row('Operating costs', ox, oy), row('Business profit', x.net - ox, y.net - oy),
    ] },
    chips: [`Why is ${b.label} ${y.net >= x.net ? 'up' : 'down'}?`],
  };
}

function answerRecent(ctx, it) {
  const n = Number((it.raw || '').match(/\b(\d{1,2})\b/)?.[1]) || 5;
  const rows = ctx.orders.filter((o) => o.source === 'ebay' || o.counted).filter((o) => !(o.source === 'ebay' && o.in_sheet) && o.status !== 'not_dropship')
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, Math.min(20, n));
  return {
    text: `**Latest ${plural(rows.length, 'sale')}:**`,
    table: { head: ['Date', 'Item', 'Profit'], rows: rows.map((o) => [dayLabel(businessDay(o.created_at)), short(o.title, 44), o.counted ? $(rowMoney(o).net) : o.status === 'awaiting_cost' ? 'waiting on cost' : o.status.replace('_', ' ')]) },
    chips: ['Profit this month', 'Top products this month'],
  };
}

function answerExpenses(ctx, it) {
  const p = it.period || defaultPeriod(ctx);
  const list = ctx.books.expenses.filter((e) => (p.month ? e.month === p.month : p.all || (monthEnd(e.month) >= (p.from || '0') && monthStart(e.month) <= p.to)));
  const total = opexIn(ctx, p);
  if (!list.length) return { text: `No operating costs recorded for ${p.label}.`, chips: ['Operating costs last month'] };
  return {
    text: `**Operating costs ${periodTitle(ctx, p)}: ${$(total)}**${p.month ? '' : ' (partly covered months counted by their share of days)'}. ${ctx.s.B} pays these; they come out of profit before the split.`,
    table: { head: ['Month', 'Expense', 'Amount'], rows: list.map((e) => [monthName(e.month, true), e.category, $(cents(e.amount))]) },
    chips: [`Profit ${p.label}`],
  };
}

function answerListings(ctx) {
  const F = listingFacts(ctx);
  if (!F) return { text: 'Listing data isn’t in yet. Connect eBay in **Settings** (reconnect once to allow listing data) and it fills in on the next sync.', chips: ['Top products this month'] };
  const { L } = F;
  const T = L.totals;
  const bullets = [
    `Active listings: **${fmtN(T.activeListings)}** (${fmtN(L.added?.last30)} posted in the last 30 days, ${fmtN(L.added?.endedLast30)} ended)`,
    T.avgViewsPerListing !== null ? `Views per listing: **${fmtN(T.avgViewsPerListing, 1)}** ${T.viewsSource === 'analytics_30d' ? 'in the last 30 days' : 'lifetime'}` : null,
    T.avgWatchersPerListing !== null ? `Watchers per listing: **${fmtN(T.avgWatchersPerListing, 2)}** (${fmtN(T.totalWatchers)} in total)` : null,
    L.top?.byViews?.length ? `Most viewed: ${L.top.byViews.slice(0, 3).map((x) => `${short(x.title, 30)} (${fmtN(x.views)} views, ${fmtN(x.quantitySold)} sold)`).join('; ')}` : null,
    L.top?.byWatchers?.length ? `Most watched: ${L.top.byWatchers.slice(0, 3).map((x) => `${short(x.title, 30)} (${fmtN(x.watchers)})`).join('; ')}` : null,
    L.sellThrough?.pctListingsWithSale !== null && L.sellThrough?.pctListingsWithSale !== undefined ? `${fmtN(L.sellThrough.pctListingsWithSale, 1)}% of active listings have sold at least once` : null,
    L.stale?.count ? `**${plural(L.stale.count, 'listing')} to refresh or remove**: live 30+ days, no sales${L.stale.criteria?.viewsBelowMedian !== null ? ', below-median views' : ''}` : null,
    listingDrivers(ctx)?.summary || null,
  ].filter(Boolean);
  return { text: `**You have ${fmtN(T.activeListings)} active eBay listings.**`, bullets, chips: ['Why do we have more listings but fewer sales?', 'Top products this month'] };
}

function answerProduct(ctx, it) {
  const p = it.period || allTime(ctx);
  const rows = rowsFor(ctx, p, it.product);
  if (!rows.length) return { text: `No costed sales matching “${it.product.join(' ')}” ${p.label}.`, chips: ['Top products all time'] };
  const s = stats(rows);
  const titles = [...new Set(rows.map((o) => o.title))];
  return {
    text: `**“${short(titles[0], 60)}”${titles.length > 1 ? ` (+${titles.length - 1} similar)` : ''}: ${plural(s.n, 'sale')}, ${$(s.net)} profit ${periodTitle(ctx, p)}.**`,
    bullets: [`Average payout ${$(Math.round(s.payout / s.n))}, Amazon cost ${$(Math.round(s.cogs / s.n))}, profit ${$(Math.round(s.avg))} per sale`, s.refundedSales ? `${plural(s.refundedSales, 'refund')} (${$(s.refunds)})` : 'No refunds', `Last sold ${dayLabel(businessDay(rows.map((o) => o.created_at).sort().at(-1)))}`],
    chips: ['Top products all time'],
  };
}

const HELP = {
  text: "I can answer questions about the business from your own data. Things you can ask:",
  bullets: ['Why are we down this month?', 'How much profit did we make in August?', 'What does Drew owe Myles?', 'Top products this month', 'Worst products all time', 'Compare August vs September', 'How many sales last week?', 'How much did we make on the ukulele?', 'Refunds this month', 'Operating costs in September', 'Last 5 sales'],
  chips: ['Why are we down this month?', 'What does Drew owe?', 'Top products this month'],
};

// Topics the local AI model routes a question to (it fills these from the question; the numbers come from here)
export const TOPICS = {
  why_change: 'why', listings_vs_sales: 'listings_vs_sales', listings: 'listings', profit: 'profit', sales_count: 'count', revenue: 'revenue',
  amazon_cost: 'cogs', fees: 'fees', margin: 'margin', average_order: 'aov', refunds: 'refunds', expenses: 'expenses', settlement: 'settlement',
  top_products: 'top', worst_products: 'worst', product: 'product', compare: 'compare', recent_sales: 'recent',
};
function fromRoute(route, ctx, question) {
  const intent = TOPICS[route?.topic];
  if (!intent) return null;
  const periods = [...parsePeriods(route.period || '', ctx.today), ...parsePeriods(route.compare_to || '', ctx.today)];
  const product = route.product ? findProduct(ctx, tokens(route.product)) : null;
  if (intent === 'product' && !product) return null;
  const toks = tokens(question);
  const up = hasWord(toks, VOCAB.up);
  const down = hasWord(toks, VOCAB.down);
  return { intent, period: periods[0] || null, periods, product, direction: up && !down ? 'up' : down && !up ? 'down' : null };
}

// route: optional { topic, period, compare_to, product } from the local AI model; without it the built-in parser reads the question
export async function ask(question, prev = null, route = null) {
  const ctx = await load();
  const it = { ...(fromRoute(route, ctx, question) || understand(question, ctx, prev)), raw: norm(question) };
  let ans;
  switch (it.intent) {
    case 'why': ans = answerWhy(ctx, it); break;
    case 'listings_vs_sales': ans = answerListingsVsSales(ctx); break;
    case 'listings': ans = answerListings(ctx); break;
    case 'compare': ans = answerCompare(ctx, it); break;
    case 'settlement': ans = answerSettlement(ctx, it); break;
    case 'top': ans = answerProducts(ctx, it, false); break;
    case 'worst': ans = answerProducts(ctx, it, true); break;
    case 'recent': ans = answerRecent(ctx, it); break;
    case 'expenses': ans = answerExpenses(ctx, it); break;
    case 'product': ans = answerProduct(ctx, it); break;
    case 'help': ans = HELP; break;
    default: ans = answerMetric(ctx, it) || HELP;
  }
  // Don't send back the raw text; the client returns this as context for follow-ups
  const context = { intent: it.intent === 'help' ? prev?.intent || null : it.intent, period: it.period, product: it.product };
  return { ...ans, understood: it.intent === 'help' ? null : { topic: it.intent, period: it.period?.label || null, product: it.product?.join(' ') || null }, context };
}

export const _test = { parsePeriods, understand: (q, ctx, prev) => understand(q, ctx, prev), osa };
