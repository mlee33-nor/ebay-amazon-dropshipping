// eBay LISTING analytics for the Products page. Read-only toward eBay (GET / read calls only; never revises or ends).
//   syncListings():    active listings from the Trading API (GetMyeBaySelling ActiveList, paginated) + listing traffic
//                      from the Sell Analytics traffic report (by DAY for 90 days, by LISTING for 30 days), then one
//                      snapshot row per business day.
//   listingAnalytics(): listed-count growth, averages, top listings, traffic series, stale listings, sell-through and a
//                      last-30-vs-previous-30 "drivers" comparison ("more listings but fewer sales?").
import { q, getSetting, setSetting } from './db.js';
import { businessDay } from './time.js';
import * as ebay from './ebay.js'; // namespace import: works before ebayUserToken is exported (clear error instead of a crash)

const ANALYTICS_SCOPE = 'https://api.ebay.com/oauth/api_scope/sell.analytics.readonly';
const api = () => process.env.EBAY_API_BASE || 'https://api.ebay.com';
const marketplace = () => process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';
const DAY_MS = 86400_000;
const TRAFFIC_SKIPPED = 'listing traffic: skipped (reconnect eBay to allow analytics)';

// Same SQL as the block appended to SCHEMA in src/db.js; run here too so this module works on its own.
export const LISTINGS_SCHEMA = `
create table if not exists ebay_listings (
  item_id            text primary key,
  title              text,
  sku                text,
  price              numeric(12,2),
  currency           text,
  quantity           int,
  quantity_available int,
  quantity_sold      int default 0,
  start_time         timestamptz,
  listing_url        text,
  listing_type       text,
  watch_count        int,
  hit_count          int,
  first_seen         timestamptz default now(),
  last_seen          timestamptz default now(),
  ended              boolean default false,
  ended_at           timestamptz
);
create index if not exists ebay_listings_ended_idx on ebay_listings(ended);
create table if not exists listing_snapshots (
  day            date primary key,
  active_count   int not null default 0,
  total_watchers int default 0,
  total_views    int,
  views_source   text,
  avg_price      numeric(12,2),
  units_sold     int default 0,
  taken_at       timestamptz default now()
);
create table if not exists listing_traffic_daily (
  day          date primary key,
  impressions  int,
  views        int,
  ctr          numeric(10,4),
  conversion   numeric(10,4),
  transactions int,
  synced_at    timestamptz default now()
);
create table if not exists listing_traffic (
  item_id      text primary key,
  period_start date,
  period_end   date,
  impressions  int,
  views        int,
  ctr          numeric(10,4),
  conversion   numeric(10,4),
  transactions int,
  synced_at    timestamptz default now()
);
`;
let schemaReady = null;
const ensureSchema = () => (schemaReady ||= q(LISTINGS_SCHEMA).catch((e) => { schemaReady = null; throw e; }));

// ---------------- tiny dependency-free XML reader (enough for Trading API responses) ----------------
const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e] ?? m);
const localName = (n) => n.slice(n.indexOf(':') + 1);

export function parseXml(xml) {
  const root = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<[?!][^>]*>|<\/([^\s>]+)\s*>|<([^\s/>]+)([^>]*?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(xml))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2]) {
      const i = stack.map((n) => n.name).lastIndexOf(localName(m[2]));
      if (i > 0) stack.length = i; // tolerant close: pops to the matching open tag
    } else if (m[3]) {
      const node = { name: localName(m[3]), attrs: {}, children: [], text: '' };
      for (const a of m[4].matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) node.attrs[localName(a[1])] = decode(a[2] ?? a[3]);
      top.children.push(node);
      if (!m[5]) stack.push(node);
    } else if (m[6] !== undefined) top.text += decode(m[6]);
  }
  return root;
}
const kid = (n, name) => n?.children.find((c) => c.name === name) || null;
const kids = (n, name) => n?.children.filter((c) => c.name === name) || [];
const at = (n, p) => p.split('/').reduce((x, s) => kid(x, s), n); // direct children only, so Variations/* never leak in
const txt = (n, p) => { const t = at(n, p)?.text.trim(); return t || null; };
const int = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Math.trunc(Number(v)));
const numOrNull = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 10000) / 10000;

// ---------------- eBay calls ----------------
async function defaultAuth() {
  if (typeof ebay.ebayUserToken !== 'function') throw new Error('src/ebay.js does not export ebayUserToken yet (see the listings integration notes)');
  return ebay.ebayUserToken(); // { token, scopes }
}

async function withRetry(doFetch) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await doFetch();
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, Number(process.env.LISTINGS_RETRY_MS ?? 1000) * 2 ** attempt));
      continue;
    }
    return res;
  }
  throw new Error('eBay kept failing (429/5xx)');
}

async function tradingCall(callName, inner, token) {
  const body = `<?xml version="1.0" encoding="utf-8"?>\n<${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents">${inner}</${callName}Request>`;
  const res = await withRetry(() => fetch(`${api()}/ws/api.dll`, {
    method: 'POST',
    headers: {
      'X-EBAY-API-CALL-NAME': callName,
      'X-EBAY-API-SITEID': '0',
      'X-EBAY-API-COMPATIBILITY-LEVEL': '1349',
      'X-EBAY-API-IAF-TOKEN': token,
      'Content-Type': 'text/xml; charset=utf-8',
    },
    body,
  }));
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`eBay ${res.status} on ${callName}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const resp = kid(parseXml(text), `${callName}Response`);
  if (!resp) throw new Error(`eBay ${callName}: unexpected response ${text.slice(0, 120)}`);
  const errors = kids(resp, 'Errors').map((e) => ({
    code: txt(e, 'ErrorCode'), severity: txt(e, 'SeverityCode'), message: txt(e, 'LongMessage') || txt(e, 'ShortMessage'),
  }));
  const ack = txt(resp, 'Ack');
  if (ack !== 'Success' && ack !== 'Warning') {
    const err = new Error(`eBay ${callName} ${ack || 'failed'}: ${errors.map((e) => `${e.code} ${e.message}`).join('; ') || 'no details'}`);
    err.errors = errors;
    throw err;
  }
  return { resp, warnings: errors.filter((e) => e.severity === 'Warning') };
}

async function restGet(url, token) {
  const res = await withRetry(() => fetch(url, {
    headers: { Authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': marketplace(), Accept: 'application/json' },
  }));
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`eBay ${res.status} on ${new URL(url).pathname}: ${body?.errors?.[0]?.longMessage || body?.errors?.[0]?.message || text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

export function itemFromXml(it) {
  const itemId = txt(it, 'ItemID');
  const quantity = int(txt(it, 'Quantity'));
  const sold = int(txt(it, 'SellingStatus/QuantitySold')) ?? 0;
  const priceNode = at(it, 'SellingStatus/CurrentPrice') || at(it, 'BuyItNowPrice') || at(it, 'StartPrice');
  return {
    item_id: itemId,
    title: txt(it, 'Title'),
    sku: txt(it, 'SKU'),
    price: numOrNull(priceNode?.text.trim()),
    currency: priceNode?.attrs.currencyID || null,
    quantity,
    quantity_available: int(txt(it, 'QuantityAvailable')) ?? (quantity !== null ? Math.max(0, quantity - sold) : null),
    quantity_sold: sold,
    start_time: txt(it, 'ListingDetails/StartTime'),
    listing_url: txt(it, 'ListingDetails/ViewItemURL') || (itemId ? `https://www.ebay.com/itm/${itemId}` : null),
    listing_type: txt(it, 'ListingType'),
    watch_count: int(txt(it, 'WatchCount')),
    hit_count: int(txt(it, 'HitCount')),
  };
}

const activeListRequest = (page, withWatch) =>
  `<ActiveList><Include>true</Include>${withWatch ? '<IncludeWatchCount>true</IncludeWatchCount>' : ''}` +
  `<Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination></ActiveList>`;

async function pullActiveListings(token, lines) {
  const items = new Map();
  let page = 1;
  let totalPages = 1;
  let withWatch = true;
  const MAX_PAGES = 100; // 20,000 listings
  while (page <= Math.min(totalPages, MAX_PAGES)) {
    let r;
    try {
      r = await tradingCall('GetMyeBaySelling', activeListRequest(page, withWatch), token);
    } catch (e) {
      // IncludeWatchCount is documented for GetSellerList; if this call rejects it, retry without (WatchCount still comes back)
      if (withWatch && page === 1 && /IncludeWatchCount/i.test(e.message)) { withWatch = false; continue; }
      throw e;
    }
    for (const w of r.warnings) lines.push(`listings: eBay warning ${w.code} ${w.message}`);
    const list = kid(r.resp, 'ActiveList'); // eBay omits the container when nothing is listed
    for (const it of kids(kid(list, 'ItemArray'), 'Item')) {
      const item = itemFromXml(it);
      if (item.item_id) items.set(item.item_id, item); // de-duplicates an item that shifts across pages mid-pull
    }
    totalPages = int(txt(list, 'PaginationResult/TotalNumberOfPages')) || 1;
    page++;
  }
  return { items: [...items.values()], pages: page - 1, complete: totalPages <= MAX_PAGES };
}

// ---------------- traffic (Sell Analytics) ----------------
const ymd = (day) => day.replaceAll('-', '');
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const METRICS = ['LISTING_IMPRESSION_TOTAL', 'LISTING_VIEWS_TOTAL', 'CLICK_THROUGH_RATE', 'SALES_CONVERSION_RATE', 'TRANSACTION'];

function reportRows(body) {
  const keys = (body.header?.metrics || []).map((m) => m.key);
  return (body.records || []).map((rec) => {
    const out = { key: String(rec.dimensionValues?.[0]?.value ?? '') };
    keys.forEach((k, i) => {
      const mv = rec.metricValues?.[i];
      out[k] = mv && mv.applicable !== false ? numOrNull(mv.value) : null;
    });
    return out;
  });
}

const trafficUrl = (dimension, from, to, listingIds) => {
  let filter = `marketplace_ids:{${marketplace()}},date_range:[${ymd(from)}..${ymd(to)}]`;
  if (listingIds) filter += `,listing_ids:{${listingIds.join('|')}}`;
  return `${api()}/sell/analytics/v1/traffic_report?dimension=${dimension}&metric=${METRICS.join(',')}&filter=${encodeURIComponent(filter)}`;
};

async function syncTraffic(token, activeIds, syncStart, lines) {
  // eBay's traffic data lags ~1-2 days and "today" in Phoenix can be tomorrow in eBay's zone: end at yesterday
  const end = addDays(businessDay(syncStart), -1);
  const daily = reportRows(await restGet(trafficUrl('DAY', addDays(end, -89), end), token))
    .filter((r) => /^\d{8}$/.test(r.key))
    .map((r) => ({
      day: `${r.key.slice(0, 4)}-${r.key.slice(4, 6)}-${r.key.slice(6, 8)}`,
      impressions: int(r.LISTING_IMPRESSION_TOTAL), views: int(r.LISTING_VIEWS_TOTAL),
      ctr: r.CLICK_THROUGH_RATE, conversion: r.SALES_CONVERSION_RATE, transactions: int(r.TRANSACTION),
    }));
  const from30 = addDays(end, -29);
  const perListing = new Map();
  for (let i = 0; i < activeIds.length; i += 200) { // listing_ids filter takes at most 200 ids
    const chunk = activeIds.slice(i, i + 200);
    for (const r of reportRows(await restGet(trafficUrl('LISTING', from30, end, chunk), token))) perListing.set(r.key, r);
    for (const id of chunk) if (!perListing.has(id)) perListing.set(id, { key: id }); // no record = no traffic
  }
  // Write only after every call succeeded, so a failure never leaves half-replaced data
  await bulk(
    `insert into listing_traffic_daily (day, impressions, views, ctr, conversion, transactions, synced_at)
     select x.day, x.impressions, x.views, x.ctr, x.conversion, x.transactions, $2
     from jsonb_to_recordset($1::jsonb) as x(day date, impressions int, views int, ctr numeric, conversion numeric, transactions int)
     on conflict (day) do update set impressions = excluded.impressions, views = excluded.views, ctr = excluded.ctr,
       conversion = excluded.conversion, transactions = excluded.transactions, synced_at = excluded.synced_at`,
    daily, [syncStart]
  );
  const rows = [...perListing.values()].map((r) => ({
    item_id: r.key, impressions: int(r.LISTING_IMPRESSION_TOTAL) ?? 0, views: int(r.LISTING_VIEWS_TOTAL) ?? 0,
    ctr: r.CLICK_THROUGH_RATE ?? null, conversion: r.SALES_CONVERSION_RATE ?? null, transactions: int(r.TRANSACTION) ?? 0,
  }));
  await bulk(
    `insert into listing_traffic (item_id, period_start, period_end, impressions, views, ctr, conversion, transactions, synced_at)
     select x.item_id, $3::date, $4::date, x.impressions, x.views, x.ctr, x.conversion, x.transactions, $2
     from jsonb_to_recordset($1::jsonb) as x(item_id text, impressions int, views int, ctr numeric, conversion numeric, transactions int)
     on conflict (item_id) do update set period_start = excluded.period_start, period_end = excluded.period_end,
       impressions = excluded.impressions, views = excluded.views, ctr = excluded.ctr, conversion = excluded.conversion,
       transactions = excluded.transactions, synced_at = excluded.synced_at`,
    rows, [syncStart, from30, end]
  );
  await q('delete from listing_traffic where synced_at < $1', [syncStart]);
  lines.push(`listing traffic: ${daily.length} days, ${rows.length} listings (${from30}..${end})`);
}

async function bulk(sql, rows, extra = []) {
  for (let i = 0; i < rows.length; i += 500) await q(sql, [JSON.stringify(rows.slice(i, i + 500)), ...extra]);
}

// ---------------- sync ----------------
let running = null;

// Never throws. Pass { log } to append lines to syncEbay's log; { auth } overrides the token source (tests).
export function syncListings({ log = null, auth = defaultAuth, now = () => new Date() } = {}) {
  if (running) return running;
  running = (async () => {
    const lines = [];
    const out = { ok: false, active: 0, pages: 0, newlyEnded: 0, traffic: 'not run', log: lines };
    try {
      await ensureSchema();
      const syncStart = now();
      const { token, scopes } = await auth();
      const pull = await pullActiveListings(token, lines);
      await bulk(
        `insert into ebay_listings (item_id, title, sku, price, currency, quantity, quantity_available, quantity_sold, start_time,
           listing_url, listing_type, watch_count, hit_count, first_seen, last_seen, ended, ended_at)
         select x.item_id, x.title, x.sku, x.price, x.currency, x.quantity, x.quantity_available, coalesce(x.quantity_sold, 0),
           x.start_time, x.listing_url, x.listing_type, x.watch_count, x.hit_count, $2, $2, false, null
         from jsonb_to_recordset($1::jsonb) as x(item_id text, title text, sku text, price numeric, currency text, quantity int,
           quantity_available int, quantity_sold int, start_time timestamptz, listing_url text, listing_type text, watch_count int, hit_count int)
         on conflict (item_id) do update set title = excluded.title, sku = excluded.sku, price = excluded.price,
           currency = excluded.currency, quantity = excluded.quantity, quantity_available = excluded.quantity_available,
           quantity_sold = excluded.quantity_sold, start_time = coalesce(excluded.start_time, ebay_listings.start_time),
           listing_url = excluded.listing_url, listing_type = excluded.listing_type, watch_count = excluded.watch_count,
           hit_count = coalesce(excluded.hit_count, ebay_listings.hit_count), last_seen = excluded.last_seen,
           ended = false, ended_at = null`,
        pull.items, [syncStart]
      );
      out.active = pull.items.length;
      out.pages = pull.pages;
      // Only a complete, successful pull may mark listings ended (a failed page throws before this line)
      if (pull.complete) {
        out.newlyEnded = (await q('update ebay_listings set ended = true, ended_at = $1 where not ended and last_seen < $1 returning item_id', [syncStart])).length;
      }
      lines.push(`listings: ${out.active} active (${out.pages} page${out.pages === 1 ? '' : 's'}), ${out.newlyEnded} newly ended`);

      if (Array.isArray(scopes) && !scopes.includes(ANALYTICS_SCOPE)) {
        out.traffic = 'skipped';
        lines.push(TRAFFIC_SKIPPED);
      } else {
        try {
          await syncTraffic(token, pull.items.map((i) => i.item_id), syncStart, lines);
          out.traffic = 'ok';
        } catch (e) {
          out.traffic = 'skipped';
          lines.push(e.status === 401 || e.status === 403 ? `${TRAFFIC_SKIPPED} [${e.message}]` : `listing traffic: skipped (${e.message})`);
        }
      }
      await writeSnapshot(syncStart);
      out.ok = true;
    } catch (e) {
      lines.push(`listings: ${e.message}`);
    }
    try {
      await setSetting('listings_last_sync', { at: new Date().toISOString(), ok: out.ok, active: out.active, newlyEnded: out.newlyEnded, traffic: out.traffic, log: lines });
    } catch {}
    if (Array.isArray(log)) log.push(...lines);
    return out;
  })().finally(() => { running = null; });
  return running;
}

// ---------------- analytics ----------------
async function loadListings() {
  const rows = await q(
    `select item_id, title, sku, price, quantity, quantity_available, quantity_sold, start_time, listing_url, watch_count,
            hit_count, first_seen, last_seen, ended, ended_at from ebay_listings`
  );
  return rows.map((r) => ({
    itemId: r.item_id, title: r.title, sku: r.sku, price: numOrNull(r.price), quantity: r.quantity,
    quantityAvailable: r.quantity_available, quantitySold: r.quantity_sold || 0, watchers: r.watch_count,
    hitCount: r.hit_count, url: r.listing_url, ended: r.ended, endedAt: r.ended_at ? new Date(r.ended_at) : null,
    start: new Date(r.start_time || r.first_seen), startTime: r.start_time ? new Date(r.start_time).toISOString() : null,
  }));
}

// Views per active listing: 30-day views from Sell Analytics when synced, else lifetime HitCount if eBay sent it
async function attachViews(active) {
  const traffic = await q('select item_id, impressions, views, transactions from listing_traffic');
  if (traffic.length) {
    const m = new Map(traffic.map((t) => [t.item_id, t]));
    for (const l of active) { const t = m.get(l.itemId); l.views = t?.views ?? 0; l.impressions = t?.impressions ?? 0; }
    return 'analytics_30d';
  }
  if (active.some((l) => l.hitCount !== null)) {
    for (const l of active) { l.views = l.hitCount ?? 0; l.impressions = null; }
    return 'hit_count';
  }
  for (const l of active) { l.views = null; l.impressions = null; }
  return null;
}

async function writeSnapshot(at) {
  const active = (await loadListings()).filter((l) => !l.ended);
  const source = await attachViews(active);
  const prices = active.filter((l) => l.price !== null);
  await q(
    `insert into listing_snapshots (day, active_count, total_watchers, total_views, views_source, avg_price, units_sold, taken_at)
     values ($1, $2, $3, $4, $5, $6, $7, now())
     on conflict (day) do update set active_count = excluded.active_count, total_watchers = excluded.total_watchers,
       total_views = excluded.total_views, views_source = excluded.views_source, avg_price = excluded.avg_price,
       units_sold = excluded.units_sold, taken_at = excluded.taken_at`,
    [
      businessDay(at), active.length, active.reduce((s, l) => s + (l.watchers || 0), 0),
      source ? active.reduce((s, l) => s + l.views, 0) : null, source,
      prices.length ? r2(prices.reduce((s, l) => s + l.price, 0) / prices.length) : null,
      active.reduce((s, l) => s + l.quantitySold, 0),
    ]
  );
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const compare = (cur, prev) => ({
  current: cur,
  previous: prev,
  change: cur !== null && prev !== null ? r4(cur - prev) : null,
  changePct: cur !== null && prev !== null && prev !== 0 ? Math.round(((cur - prev) / Math.abs(prev)) * 1000) / 10 : null,
});

export async function listingAnalytics({ now = new Date() } = {}) {
  await ensureSchema();
  const nowMs = new Date(now).getTime();
  const today = businessDay(now);
  const listings = await loadListings();
  const active = listings.filter((l) => !l.ended);
  const viewsSource = await attachViews(active);
  const daysLive = (l) => Math.max(0, Math.floor((nowMs - l.start.getTime()) / DAY_MS));
  const card = (l) => ({
    itemId: l.itemId, title: l.title, sku: l.sku, price: l.price, url: l.url, startTime: l.startTime, daysLive: daysLive(l),
    views: l.views, impressions: l.impressions, watchers: l.watchers ?? 0, quantitySold: l.quantitySold, quantityAvailable: l.quantityAvailable,
  });

  // ---- listed-count history: snapshots where they exist, otherwise estimated from start/end times
  const snapshots = await q(`select to_char(day, 'YYYY-MM-DD') as day, active_count from listing_snapshots order by day`);
  const snapMap = new Map(snapshots.map((s) => [s.day, s.active_count]));
  const delta = new Map();
  const bump = (d, n) => delta.set(d, (delta.get(d) || 0) + n);
  let firstDay = null;
  for (const l of listings) {
    const s = businessDay(l.start);
    const e = l.ended && l.endedAt ? businessDay(l.endedAt) : null; // counted up to the day before it was seen ended
    if (e && e <= s) continue;
    bump(s, 1);
    if (e) bump(e, -1);
    if (!firstDay || s < firstDay) firstDay = s;
  }
  if (snapshots.length && (!firstDay || snapshots[0].day < firstDay)) firstDay = snapshots[0].day;
  const points = [];
  const pointMap = new Map();
  if (firstDay) {
    const cap = addDays(today, -364);
    let count = 0;
    for (let d = firstDay; d <= today; d = addDays(d, 1)) {
      count += delta.get(d) || 0;
      if (d < cap) continue;
      const p = snapMap.has(d) ? { day: d, active: snapMap.get(d), source: 'snapshot' } : { day: d, active: count, source: 'estimate' };
      points.push(p);
      pointMap.set(d, p.active);
    }
  }

  // ---- traffic series
  const trafficDays = (await q(
    `select to_char(day, 'YYYY-MM-DD') as day, impressions, views, ctr, conversion, transactions, synced_at
     from listing_traffic_daily order by day`
  )).map((t) => ({
    day: t.day, impressions: t.impressions, views: t.views, ctr: numOrNull(t.ctr), conversion: numOrNull(t.conversion), transactions: t.transactions,
  }));
  const lastSync = await getSetting('listings_last_sync');

  // ---- totals
  const totalWatchers = active.reduce((s, l) => s + (l.watchers || 0), 0);
  const totalViews = viewsSource ? active.reduce((s, l) => s + l.views, 0) : null;
  const priced = active.filter((l) => l.price !== null);
  const startedWithin = (days) => listings.filter((l) => l.start.getTime() >= nowMs - days * DAY_MS).length;

  // ---- top + stale
  const byViews = viewsSource
    ? [...active].sort((a, b) => b.views - a.views || (b.watchers || 0) - (a.watchers || 0) || a.itemId.localeCompare(b.itemId)).slice(0, 10).map(card)
    : [];
  const byWatchers = [...active]
    .sort((a, b) => (b.watchers || 0) - (a.watchers || 0) || (b.views || 0) - (a.views || 0) || a.itemId.localeCompare(b.itemId))
    .slice(0, 10).map(card);
  const medianViews = viewsSource ? median(active.map((l) => l.views)) : null;
  const staleAll = active
    // Fewer views than the typical listing; when the typical listing has none at all, the ones with zero views
    .filter((l) => daysLive(l) >= 30 && l.quantitySold === 0 && (medianViews === null || (medianViews > 0 ? l.views < medianViews : l.views === 0)))
    .sort((a, b) => daysLive(b) - daysLive(a) || (a.views || 0) - (b.views || 0) || a.itemId.localeCompare(b.itemId));

  // ---- sell-through
  const unitsSold = active.reduce((s, l) => s + l.quantitySold, 0);
  const withSale = active.filter((l) => l.quantitySold > 0).length;

  // ---- drivers: last 30 business days vs the 30 before
  const win = (endOffset) => ({ from: addDays(today, endOffset - 29), to: addDays(today, endOffset) });
  const cur = win(0);
  const prev = win(-30);
  const orders = await q(
    `select created_at, cancel_state from ebay_orders
     where created_at >= $1 and order_id not like 'DEMO-%' and order_id not like 'E2E-%'`,
    [new Date(nowMs - 62 * DAY_MS)]
  );
  const orderDays = orders
    .filter((o) => !(/CANCELED|CANCELLED/i.test(o.cancel_state || '') && !/NONE_REQUESTED|IN_PROGRESS/i.test(o.cancel_state || '')))
    .map((o) => businessDay(o.created_at));
  const measure = ({ from, to }) => {
    let listingDays = 0;
    let days = 0;
    for (let d = from; d <= to; d = addDays(d, 1)) { listingDays += pointMap.get(d) || 0; days++; }
    const t = trafficDays.filter((x) => x.day >= from && x.day <= to);
    const sum = (k) => t.reduce((s, x) => s + (x[k] || 0), 0);
    const weighted = (k, w) => {
      const rows = t.filter((x) => x[k] !== null && x[w]);
      const den = rows.reduce((s, x) => s + x[w], 0);
      return den ? r4(rows.reduce((s, x) => s + x[k] * x[w], 0) / den) : null;
    };
    const avgListings = listingDays / days;
    const views = t.length ? sum('views') : null;
    return {
      from, to, trafficDays: t.length,
      listings: r2(avgListings),
      listingsAtEnd: pointMap.get(to) ?? 0,
      newListings: listings.filter((l) => { const s = businessDay(l.start); return s >= from && s <= to; }).length,
      impressions: t.length ? sum('impressions') : null,
      views,
      viewsPerListing: views !== null && avgListings > 0 ? r2(views / avgListings) : null,
      ctr: t.length ? weighted('ctr', 'impressions') : null,
      conversion: t.length ? weighted('conversion', 'views') : null,
      sales: t.length ? sum('transactions') : null,
      orders: orderDays.filter((d) => d >= from && d <= to).length,
    };
  };
  const c = measure(cur);
  const p = measure(prev);
  const METRIC_KEYS = ['listings', 'listingsAtEnd', 'newListings', 'impressions', 'views', 'viewsPerListing', 'ctr', 'conversion', 'sales', 'orders'];

  return {
    generatedAt: new Date(nowMs).toISOString(),
    businessDay: today,
    lastSync: lastSync || null,
    totals: {
      activeListings: active.length,
      endedListings: listings.length - active.length,
      totalWatchers,
      avgWatchersPerListing: active.length ? r2(totalWatchers / active.length) : null,
      totalViews,
      avgViewsPerListing: viewsSource && active.length ? r2(totalViews / active.length) : null,
      viewsSource, // 'analytics_30d' (Sell Analytics, last 30 days) | 'hit_count' (lifetime) | null (no view data)
      avgPrice: priced.length ? r2(priced.reduce((s, l) => s + l.price, 0) / priced.length) : null,
      unitsAvailable: active.reduce((s, l) => s + (l.quantityAvailable || 0), 0),
    },
    added: { last7: startedWithin(7), last30: startedWithin(30), endedLast30: listings.filter((l) => l.ended && l.endedAt && l.endedAt.getTime() >= nowMs - 30 * DAY_MS).length },
    // Listings posted and ended per business month (ended counts start when tracking began)
    byMonth: (() => {
      const m = new Map();
      const row = (k) => { if (!m.has(k)) m.set(k, { month: k, added: 0, ended: 0 }); return m.get(k); };
      for (const l of listings) {
        row(businessDay(l.start).slice(0, 7)).added++;
        if (l.ended && l.endedAt) row(businessDay(l.endedAt).slice(0, 7)).ended++;
      }
      return [...m.values()].sort((a, b) => a.month.localeCompare(b.month)).slice(-12);
    })(),
    listedHistory: {
      approximate: true,
      note: 'Days with a snapshot are exact. Other days are estimated from listing start times and when a listing was first seen ended; listings that ended before tracking began are not known, so older days can undercount.',
      points,
    },
    traffic: {
      available: trafficDays.length > 0,
      lastStatus: lastSync?.traffic || null,
      rateUnits: 'CTR and conversion exactly as eBay reports them (believed to be percent, e.g. 1.25 = 1.25%)',
      days: trafficDays,
    },
    top: { byViews, byWatchers },
    stale: {
      criteria: { minDaysLive: 30, maxSold: 0, viewsBelowMedian: medianViews, viewsSource, viewsRule: medianViews === null ? null : medianViews > 0 ? `fewer than ${medianViews} views (the typical listing)` : 'no views at all' },
      count: staleAll.length,
      listings: staleAll.slice(0, 200).map(card),
    },
    sellThrough: {
      unitsSold,
      activeListings: active.length,
      unitsPerListing: active.length ? r4(unitsSold / active.length) : null,
      listingsWithSale: withSale,
      pctListingsWithSale: active.length ? r2((withSale / active.length) * 100) : null,
      note: 'Lifetime quantity sold on currently active listings',
    },
    drivers: {
      windows: { current: { from: c.from, to: c.to, trafficDays: c.trafficDays }, previous: { from: p.from, to: p.to, trafficDays: p.trafficDays } },
      definitions: {
        listings: 'average active listings per day (listedHistory)',
        listingsAtEnd: 'active listings on the last day of the window',
        newListings: 'listings whose start date falls in the window',
        impressions: 'eBay LISTING_IMPRESSION_TOTAL, summed',
        views: 'eBay LISTING_VIEWS_TOTAL, summed',
        viewsPerListing: 'views / average active listings',
        ctr: 'eBay CLICK_THROUGH_RATE, impression-weighted',
        conversion: 'eBay SALES_CONVERSION_RATE, view-weighted',
        sales: 'eBay TRANSACTION metric, summed',
        orders: 'ebay_orders by created_at (Phoenix day), cancelled and demo orders excluded',
      },
      ...Object.fromEntries(METRIC_KEYS.map((k) => [k, compare(c[k], p[k])])),
    },
  };
}
