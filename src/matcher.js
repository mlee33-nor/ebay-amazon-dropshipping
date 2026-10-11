// Links Amazon purchases to eBay sales. Auto-links ONLY with address or tracking evidence
// (buyer zip / buyer name on the Amazon shipping address, or a shared tracking number).
// Title similarity alone never auto-links - it only produces suggestions for manual review.
// Amazon orders that never link are ignored by every metric.
import { q, getSetting } from './db.js';
import { businessDay } from './time.js';

const STOP = new Set(
  'the a an and or for with of to in on by new pack pcs piece set x inch in. oz lb count ct size color black white'.split(' ')
);
const tokens = (s) =>
  new Set(
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1 && !STOP.has(t))
  );

export function titleSimilarity(a, b) {
  const A = tokens(a);
  const B = tokens(b);
  // Needs a few real words on both sides; two-word titles overlap by accident
  if (A.size < 3 || B.size < 3) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  // overlap coefficient: eBay titles are often reworded/shortened copies of the Amazon title
  return inter / Math.min(A.size, B.size);
}

const trackingTokens = (s) =>
  String(s || '')
    .toUpperCase()
    .match(/[A-Z0-9]{10,}/g) || [];

// Names and cities compared as plain letters: "José" = "Jose", "O’Fallon" = "O'Fallon" = "OFallon"
const plain = (s) =>
  String(s || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z ]/g, ' ');
const nameParts = (n) =>
  plain(n)
    .split(/\s+/)
    .filter((t) => t.length > 1);

// Both sides as calendar days in the business time zone (Amazon order dates are stored that way too)
function dayDiff(amazonDate, ebayCreated) {
  const a = new Date(`${amazonDate}T12:00:00Z`).getTime();
  const eDay = new Date(`${businessDay(ebayCreated)}T12:00:00Z`).getTime();
  return Math.round((a - eDay) / 86400_000);
}

export function scorePair(az, eb, windowBefore = 1, windowAfter = 7) {
  if (!az.order_date) return null;
  const diff = dayDiff(az.order_date, eb.created_at);
  if (diff < -windowBefore || diff > windowAfter) return null;
  let score = 0;
  const reasons = [];
  let evidence = false;
  let strong = false; // only an exact tracking-number match is strong enough to skip the ambiguity guard

  const ebTracks = new Set((eb.tracking_numbers || []).map((t) => t.toUpperCase()));
  if (az.tracking.some((t) => ebTracks.has(t))) {
    score += 100;
    evidence = true;
    strong = true;
    reasons.push('tracking match');
  }
  if (az.zip && eb.ship_zip && az.zip === String(eb.ship_zip).slice(0, 5)) {
    score += 45;
    evidence = true;
    reasons.push('zip match');
  }
  const parts = nameParts(eb.ship_name);
  const hay = ` ${plain(az.shipText)} `;
  if (parts.length) {
    const last = parts[parts.length - 1];
    if (last.length > 2 && hay.includes(` ${last} `)) {
      score += 30;
      evidence = true;
      reasons.push('buyer last name');
      if (parts.length > 1 && hay.includes(` ${parts[0]} `)) {
        score += 10;
        reasons.push('buyer first name');
      }
    }
  }
  const city = plain(eb.ship_city).replace(/\s+/g, ' ').trim();
  const cityMatch = city.length > 2 && hay.replace(/\s+/g, ' ').includes(` ${city} `);
  const stateMatch = !az.state || !eb.ship_state || az.state === String(eb.ship_state).toUpperCase();
  if (cityMatch && evidence) {
    score += 10;
    reasons.push('city');
  } else if (!evidence && cityMatch && stateMatch && parts.length && hay.includes(` ${parts[0]} `)) {
    // Amazon order emails only show "First - CITY, ST": first name + city + state together count as proof
    score += 50;
    evidence = true;
    reasons.push('buyer first name + city');
  }
  // Price sanity: what we paid Amazon should be a believable cost for what the buyer paid on eBay
  if (az.total > 0 && eb.revenue > 0) {
    const ratio = az.total / eb.revenue;
    if (ratio >= 0.2 && ratio <= 1.05) score += 15;
    else if (ratio > 1.5 || ratio < 0.1) { score -= 40; reasons.push('price mismatch'); }
  }
  let bestSim = 0;
  for (const t1 of az.titles) for (const t2 of eb.titles) bestSim = Math.max(bestSim, titleSimilarity(t1, t2));
  if (bestSim > 0) {
    score += Math.round(bestSim * 30);
    if (bestSim >= 0.4) reasons.push(`title ${Math.round(bestSim * 100)}%`);
  }
  if (diff >= 0 && diff <= 1) score += 10;
  else if (diff >= 0 && diff <= 3) score += 5;
  reasons.push(diff === 0 ? 'same day' : `${diff}d after sale`);
  return { score, evidence, strong, reasons: reasons.join(', '), titleSim: bestSim };
}

// Unlinked Amazon orders in the shape scorePair expects (also used by the dataset to avoid assuming a refunded
// sale had no purchase when an unlinked Amazon order could belong to it)
export async function loadUnlinkedAmazon() {
  return loadAmazon({ linked: false });
}

// Amazon orders in the shape scorePair expects. A fully cancelled (or ignored) order is never anyone's purchase, so
// it is never a candidate or a rival: SEALIGHT's cancelled first order must not block its replacement.
async function loadAmazon({ linked }) {
  const homeZips = ((await getSetting('home_zips')) || []).map((z) => String(z).slice(0, 5));
  const azRows = await q(
    `select l.amazon_order_id, min(l.order_date) as order_date,
            string_agg(coalesce(l.ship_name,'') || ' ' || coalesce(l.ship_address,''), ' ') as ship_text,
            max(l.ship_zip) as zip, max(l.ship_state) as state, sum(l.line_total) as total,
            -- what the books count as this order's cost: lines still bought (not ignored or cancelled), a typed-in
            -- cost first; unknown when any such line has no cost yet
            case when bool_or(coalesce(l.cost_override, l.line_total) is null) filter (where not coalesce(l.ignored, false) and coalesce(l.order_status, '') !~* 'cancel') then null
                 else sum(coalesce(l.cost_override, l.line_total)) filter (where not coalesce(l.ignored, false) and coalesce(l.order_status, '') !~* 'cancel') end as cost,
            string_agg(coalesce(l.tracking,''), ' ') as tracking,
            array_agg(l.title) as titles, bool_and(l.ignored) as all_ignored,
            bool_and(coalesce(l.order_status, '') ~* 'cancel') as all_cancelled,
            coalesce(sum(coalesce(l.quantity, 1)) filter (where not coalesce(l.ignored, false) and coalesce(l.order_status, '') !~* 'cancel'), 0)::int as units,
            max(k.ebay_order_id) as linked_to
     from amazon_lines l left join order_links k on k.amazon_order_id = l.amazon_order_id
     where ${linked ? 'k.amazon_order_id is not null' : 'k.amazon_order_id is null'}
     group by l.amazon_order_id`
  );
  return azRows
    .filter((r) => !r.all_ignored && !r.all_cancelled && !(r.zip && homeZips.includes(r.zip)))
    .map((r) => ({
      amazon_order_id: r.amazon_order_id,
      order_date: r.order_date instanceof Date ? r.order_date.toISOString().slice(0, 10) : r.order_date,
      shipText: r.ship_text,
      zip: r.zip,
      state: r.state ? String(r.state).toUpperCase() : null,
      total: r.total === null ? null : Number(r.total),
      cost: r.cost === null ? null : Number(r.cost),
      tracking: trackingTokens(r.tracking),
      // Email-sourced rows only carry a category placeholder, never compare it as a product title
      titles: (r.titles || []).filter((t) => t && !/title not in email/i.test(t)),
      units: Math.max(1, r.units),
      linked_to: r.linked_to,
    }));
}

async function loadEbay() {
  const ebRows = await q(
    `select o.order_id, o.created_at, o.ship_name, o.ship_city, o.ship_state, o.ship_zip, o.tracking_numbers, o.revenue,
            coalesce(sum(li.quantity), 1)::int as units, array_agg(li.title) as titles
     from ebay_orders o left join ebay_line_items li on li.order_id = o.order_id
     where o.created_at >= now() - interval '800 days'
     group by o.order_id`
  );
  return ebRows.map((r) => ({ ...r, revenue: Number(r.revenue) || 0, titles: (r.titles || []).filter(Boolean) }));
}

// Units already bought for each eBay sale: the quantities on its linked Amazon orders (not the number of orders, so a
// 2-unit sale bought as one 2-unit Amazon order is full). A link to a cancelled (or ignored) Amazon order doesn't
// fill the sale: its replacement order must still link.
async function loadLinkCounts() {
  const counts = await q(`select k.ebay_order_id, sum(coalesce(l.quantity, 1))::int as n
    from order_links k join amazon_lines l on l.amazon_order_id = k.amazon_order_id
    where not coalesce(l.ignored, false) and coalesce(l.order_status, '') !~* 'cancel'
    group by k.ebay_order_id`);
  return new Map(counts.map((r) => [r.ebay_order_id, r.n]));
}

async function loadCandidates() {
  const amazon = await loadAmazon({ linked: false });
  if (!amazon.length) return { amazon, ebay: [], rejections: new Set(), linkCounts: new Map() };
  const ebay = await loadEbay();
  const rej = await q('select amazon_order_id, ebay_order_id from link_rejections');
  const rejections = new Set(rej.map((r) => `${r.amazon_order_id}|${r.ebay_order_id}`));
  return { amazon, ebay, rejections, linkCounts: await loadLinkCounts() };
}

function allPairs({ amazon, ebay, rejections }) {
  const pairs = [];
  for (const az of amazon) {
    for (const eb of ebay) {
      if (rejections.has(`${az.amazon_order_id}|${eb.order_id}`)) continue;
      const s = scorePair(az, eb);
      if (s) pairs.push({ az, eb, ...s });
    }
  }
  return pairs.sort((a, b) => b.score - a.score);
}

// Runs in passes: each confident link takes that sale out of contention, which can make a neighbouring
// ambiguous Amazon order unambiguous on the next pass. Stops when a pass links nothing new.
export async function runMatcher() {
  let linked = 0;
  let last = { linked: 0, suggestions: 0 };
  for (let pass = 0; pass < 12; pass++) {
    last = await matcherPass();
    linked += last.linked;
    if (!last.linked) break;
  }
  return { linked, suggestions: last.suggestions };
}

async function matcherPass() {
  const ctx = await loadCandidates();
  if (!ctx.amazon.length) return { linked: 0, suggestions: 0 };
  const pairs = allPairs(ctx);
  // Ambiguity guard: if an Amazon order has two plausible eBay sales (e.g. two "Jane - HOUSTON, TX"
  // buyers the same week) and the runner-up is close, don't guess. It goes to Match review instead.
  const ambiguous = new Set();
  const byAz = new Map();
  for (const p of pairs) {
    if (!p.evidence) continue;
    if (!byAz.has(p.az.amazon_order_id)) byAz.set(p.az.amazon_order_id, []);
    byAz.get(p.az.amazon_order_id).push(p);
  }
  for (const [id, list] of byAz) {
    const open = list.filter((p) => (ctx.linkCounts.get(p.eb.order_id) || 0) < Math.max(1, p.eb.units));
    if (open.length > 1 && open[1].score >= open[0].score - 15 && !open[0].strong) ambiguous.add(id);
  }
  // Each Amazon order's best candidate sale (pairs are sorted best first). An Amazon order that clearly belongs to
  // another sale must not count as a rival on this one, or it would block its own, better match.
  const bestForAz = new Map();
  for (const p of pairs) {
    if (!p.evidence || bestForAz.has(p.az.amazon_order_id)) continue;
    if ((ctx.linkCounts.get(p.eb.order_id) || 0) >= Math.max(1, p.eb.units) && !p.strong) continue; // that sale is full
    bestForAz.set(p.az.amazon_order_id, p);
  }
  // Same in the other direction: one eBay sale with two close Amazon candidates and room for only one.
  // Every plausible candidate is a rival, including one that is itself unsure between two sales (it may be this
  // sale's real purchase). Only an Amazon order that clearly belongs to another sale (a tracking match there, or
  // 15+ points better) is left out, so it can't block its own, better match.
  const byEb = new Map();
  for (const p of pairs) {
    if (!p.evidence || p.score < 50) continue;
    const best = bestForAz.get(p.az.amazon_order_id);
    if (best && best.eb.order_id !== p.eb.order_id && (best.strong || best.score >= p.score + 15)) continue;
    if (!byEb.has(p.eb.order_id)) byEb.set(p.eb.order_id, []);
    byEb.get(p.eb.order_id).push(p);
  }
  for (const [ebId, list] of byEb) {
    if (list[0].score < 70) continue; // nothing here would be linked anyway
    const room = Math.max(1, list[0].eb.units) - (ctx.linkCounts.get(ebId) || 0);
    if (list.length > room && room > 0 && list[room].score >= list[room - 1].score - 15 && !list[room - 1].strong)
      list.forEach((p) => ambiguous.add(p.az.amazon_order_id));
  }
  const takenAmazon = new Set();
  let linked = 0;
  for (const p of pairs) {
    // A tracking-number match is definitive: an ambiguity flag never holds it back
    if (takenAmazon.has(p.az.amazon_order_id) || (ambiguous.has(p.az.amazon_order_id) && !p.strong)) continue;
    if (!p.evidence || p.score < 70) continue;
    const existing = ctx.linkCounts.get(p.eb.order_id) || 0;
    // A second Amazon order on the same sale needs room (multi-unit sale) or a tracking match
    if (existing >= Math.max(1, p.eb.units) && !p.strong) continue;
    await q(
      `insert into order_links (amazon_order_id, ebay_order_id, method, score, reasons)
       values ($1, $2, 'auto', $3, $4) on conflict (amazon_order_id) do nothing`,
      [p.az.amazon_order_id, p.eb.order_id, p.score, p.reasons]
    );
    takenAmazon.add(p.az.amazon_order_id);
    ctx.linkCounts.set(p.eb.order_id, existing + p.az.units);
    linked++;
  }
  const suggestions = new Set(pairs.filter((p) => !takenAmazon.has(p.az.amazon_order_id) && p.score >= 35).map((p) => p.az.amazon_order_id)).size;
  return { linked, suggestions };
}

// The unlinked Amazon orders that could be one sale's purchase, best first ("Check email now" on a sale)
export async function candidatesForSale(ebayOrderId, limit = 3) {
  const ctx = await loadCandidates();
  const eb = ctx.ebay.find((e) => e.order_id === ebayOrderId);
  if (!eb) return [];
  return ctx.amazon
    .filter((az) => !ctx.rejections.has(`${az.amazon_order_id}|${eb.order_id}`))
    .map((az) => ({ az, s: scorePair(az, eb) }))
    .filter((x) => x.s && x.s.score >= 20)
    .sort((a, b) => b.s.score - a.s.score)
    .slice(0, limit)
    .map(({ az, s }) => ({
      amazon_order_id: az.amazon_order_id, order_date: az.order_date, total: az.total,
      ship: String(az.shipText || '').replace(/\s+/g, ' ').trim(), score: s.score, evidence: s.evidence, reasons: s.reasons,
    }));
}

export async function getSuggestions(limit = 300) {
  const ctx = await loadCandidates();
  const pairs = allPairs(ctx).filter((p) => p.score >= 35);
  const best = new Map();
  for (const p of pairs) {
    const list = best.get(p.az.amazon_order_id) || [];
    if (list.length < 3) list.push(p);
    best.set(p.az.amazon_order_id, list);
  }
  return [...best.values()]
    .map((list) => ({
      amazon_order_id: list[0].az.amazon_order_id,
      order_date: list[0].az.order_date,
      amazon_titles: list[0].az.titles,
      candidates: list.map((p) => ({
        ebay_order_id: p.eb.order_id,
        created_at: p.eb.created_at,
        ebay_titles: p.eb.titles,
        ship_name: p.eb.ship_name,
        score: p.score,
        evidence: p.evidence,
        reasons: p.reasons,
      })),
    }))
    .sort((a, b) => b.candidates[0].score - a.candidates[0].score)
    .slice(0, limit);
}

// The last answer and the inputs it was worked out from: the dashboard asks on every load, but the full Amazon x eBay
// scan only runs again when an order, link, cost or rejection changed
let sharedCache = { key: null, value: null };

// One Amazon order that looks like the purchase for two or more eBay sales (the same buyer bought twice, Amazon
// shipped both in one order). order_links holds one sale per Amazon order, so this is never linked automatically: it
// is listed so the cost can be split by hand. An Amazon order with 2+ units qualifies when 2+ sales from that buyer
// have address evidence against it and their units fit in it; a linked order qualifies when another such sale fits in
// its spare units.
export async function sharedOrderSuggestions() {
  const amazon = [...(await loadAmazon({ linked: false })), ...(await loadAmazon({ linked: true }))].filter((az) => az.units >= 2);
  if (!amazon.length) return [];
  const ebay = await loadEbay();
  const linkCounts = await loadLinkCounts();
  const rej = new Set((await q('select amazon_order_id, ebay_order_id from link_rejections')).map((r) => `${r.amazon_order_id}|${r.ebay_order_id}`));
  const key = JSON.stringify([amazon, ebay, [...linkCounts], [...rej].sort()]);
  if (sharedCache.key === key) return sharedCache.value;
  const out = [];
  for (const az of amazon) {
    const sales = [];
    for (const eb of ebay) {
      if (rej.has(`${az.amazon_order_id}|${eb.order_id}`)) continue;
      // Any other sale must still be waiting for its purchase; the sale this order is linked to always counts
      if (eb.order_id !== az.linked_to && (linkCounts.get(eb.order_id) || 0) >= Math.max(1, eb.units)) continue;
      const s = scorePair(az, eb);
      if (s && s.evidence && s.score >= 50) sales.push({ eb, s });
    }
    if (sales.length < 2 || (az.linked_to && !sales.some((x) => x.eb.order_id === az.linked_to))) continue;
    // The linked sale first, then the best evidence; as many as the order's units cover
    sales.sort((a, b) => (b.eb.order_id === az.linked_to) - (a.eb.order_id === az.linked_to) || b.s.score - a.s.score);
    let room = az.units;
    const fit = [];
    for (const x of sales) {
      const u = Math.max(1, x.eb.units);
      if (u <= room) { fit.push(x); room -= u; }
    }
    if (fit.length < 2) continue;
    const revenue = fit.reduce((t, x) => t + x.eb.revenue, 0);
    // Suggested share of the Amazon cost the books count (typed-in costs, cancelled and ignored lines left out), split
    // by each sale's eBay revenue; the last share takes the rounding so the shares add up to the cost exactly
    let left = az.cost;
    const shares = fit.map((x, i) => {
      if (az.cost === null || !(revenue > 0)) return null;
      const share = i === fit.length - 1 ? Math.round(left * 100) / 100 : Math.round((az.cost * x.eb.revenue / revenue) * 100) / 100;
      left -= share;
      return share;
    });
    out.push({
      amazon_order_id: az.amazon_order_id,
      order_date: az.order_date,
      amazon_units: az.units,
      total: az.cost,
      linked_to: az.linked_to || null,
      sales: fit.map((x, i) => ({
        ebay_order_id: x.eb.order_id, created_at: x.eb.created_at, ship_name: x.eb.ship_name, units: Math.max(1, x.eb.units),
        revenue: x.eb.revenue, score: x.s.score, reasons: x.s.reasons, cost_share: shares[i],
      })),
    });
  }
  sharedCache = { key, value: out };
  return out;
}
