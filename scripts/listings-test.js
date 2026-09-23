// Listing analytics test: a mock eBay (Trading API GetMyeBaySelling XML, 2 pages + Sell Analytics traffic JSON) and a
// throwaway embedded Postgres. Never calls the real eBay API and never touches real data.
//   node scripts/listings-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-listings-'));
process.env.LOCAL_PG_DIR = dir;
process.env.LOCAL_PG_PORT = process.env.LISTINGS_TEST_PG_PORT || '5446';
delete process.env.DATABASE_URL;
process.env.DATABASE_URL = ''; // blank (not just deleted) so db.js's .env loader cannot put a real database back
process.env.LISTINGS_SYNC_HOURS = '0'; // refresh listings on every eBay sync in this test (production waits a few hours)

const DAY = 86400_000;
const NOW = Date.now();
const ago = (d) => new Date(NOW - d * DAY).toISOString();
const ANALYTICS = 'https://api.ebay.com/oauth/api_scope/sell.analytics.readonly';

// ---------------- mock eBay ----------------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const itemXml = (i) => `
      <Item>
        <BuyItNowPrice currencyID="USD">0.0</BuyItNowPrice>
        <ItemID>${i.id}</ItemID>
        <ListingDetails>
          <StartTime>${i.start}</StartTime>
          <ViewItemURL>https://www.ebay.com/itm/${i.id}</ViewItemURL>
          <ViewItemURLForNaturalSearch>https://www.ebay.com/itm/x/${i.id}</ViewItemURLForNaturalSearch>
        </ListingDetails>
        <ListingDuration>GTC</ListingDuration>
        <ListingType>FixedPriceItem</ListingType>
        <Quantity>${i.qty}</Quantity>
        <SellingStatus>
          <CurrentPrice currencyID="USD">${i.price}</CurrentPrice>
          <QuantitySold>${i.sold}</QuantitySold>
        </SellingStatus>
        <TimeLeft>P12DT3H2M1S</TimeLeft>
        <Title>${esc(i.title)}</Title>
        ${i.watch === undefined ? '' : `<WatchCount>${i.watch}</WatchCount>`}
        <QuantityAvailable>${i.qty - i.sold}</QuantityAvailable>
        <SKU>${esc(i.sku)}</SKU>
        ${i.variations ? `<Variations>
          <Variation><SKU>YOGA-BLUE</SKU><StartPrice currencyID="USD">29.99</StartPrice><Quantity>12</Quantity>
            <SellingStatus><QuantitySold>7</QuantitySold></SellingStatus><WatchCount>99</WatchCount></Variation>
          <Variation><SKU>YOGA-PINK</SKU><StartPrice currencyID="USD">31.99</StartPrice><Quantity>8</Quantity>
            <SellingStatus><QuantitySold>0</QuantitySold></SellingStatus></Variation>
        </Variations>` : ''}
        <PictureDetails><GalleryURL>https://i.ebayimg.com/${i.id}.jpg</GalleryURL></PictureDetails>
      </Item>`;
const sellingXml = (items, page, pages, total) => `<?xml version="1.0" encoding="UTF-8"?>
<GetMyeBaySellingResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Timestamp>${new Date().toISOString()}</Timestamp>
  <Ack>Success</Ack>
  <Version>1349</Version>
  <Build>E1349_CORE_API_19146596_R1</Build>
  <!-- page ${page} -->
  <ActiveList>
    <ItemArray>${items.map(itemXml).join('')}
    </ItemArray>
    <PaginationResult>
      <TotalNumberOfPages>${pages}</TotalNumberOfPages>
      <TotalNumberOfEntries>${total}</TotalNumberOfEntries>
    </PaginationResult>
  </ActiveList>
</GetMyeBaySellingResponse>`;
const failureXml = `<?xml version="1.0" encoding="UTF-8"?>
<GetMyeBaySellingResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Failure</Ack>
  <Errors><ShortMessage>Internal error.</ShortMessage><LongMessage>Internal error to the application.</LongMessage>
  <ErrorCode>10007</ErrorCode><SeverityCode>Error</SeverityCode></Errors></GetMyeBaySellingResponse>`;

const A = { id: '110000000001', title: 'Hydro Flask 32 oz Wide Mouth & Straw Lid', sku: 'HF32', price: '44.99', qty: 5, sold: 3, start: ago(120), watch: 12 };
const B = { id: '110000000002', title: 'Kala Bamboo Soprano Ukulele', sku: 'KALA-S', price: '89.00', qty: 2, sold: 0, start: ago(60), watch: 2 };
const C = { id: '110000000003', title: 'Precut Tennis Balls for Walker Glides 4pk', sku: 'TB4', price: '19.99', qty: 10, sold: 0, start: ago(45), watch: 0 };
const D = { id: '110000000004', title: 'Yoga Mat 6mm (variations)', sku: 'YOGA-PARENT', price: '29.99', qty: 20, sold: 1, start: ago(10), watch: 5, variations: true };
const E = { id: '110000000005', title: 'Vintage Brass Desk Lamp', sku: 'LAMP1', price: '15.00', qty: 1, sold: 0, start: ago(3), watch: 1 };
const F = { id: '110000000006', title: 'Clip-on Desk Fan', sku: 'FAN1', price: '25.50', qty: 3, sold: 0, start: ago(1), watch: 0 };

const phases = {
  1: { items: [A, B, C, D, E], views: { [A.id]: 300, [B.id]: 40, [C.id]: 5, [D.id]: 120, [E.id]: 10 } },
  // E ended; F is new; A sold one more and gained watchers. F has no traffic record at all (eBay omits zero rows).
  2: { items: [{ ...A, sold: 4, watch: 14 }, B, C, D, F], views: { [A.id]: 320, [B.id]: 40, [C.id]: 5, [D.id]: 130 } },
};
let phase = 1;
let trafficMode = 'ok'; // 'ok' | '403'
let tradingMode = 'ok'; // 'ok' | 'fail-page-2'
const hits = [];
const tradingCalls = [];
const trafficCalls = [];

const { businessDay } = await import('../src/time.js');
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const TODAY = businessDay(new Date(NOW));
const dayVals = (day) => {
  if (day >= addDays(TODAY, -29)) return { imp: 2000, views: 60, ctr: 2.0, conv: 1.0, tx: 1 };
  if (day >= addDays(TODAY, -59) && day <= addDays(TODAY, -50)) return { imp: 2000, views: 80, ctr: 6.0, conv: 2.5, tx: 2 };
  if (day >= addDays(TODAY, -49) && day <= addDays(TODAY, -30)) return { imp: 500, views: 80, ctr: 1.5, conv: 2.5, tx: 2 };
  return { imp: 300, views: 10, ctr: 1.0, conv: 0, tx: 0 };
};
// eBay returns metrics in header order, which need not match the request order
const HEADER = ['TRANSACTION', 'LISTING_VIEWS_TOTAL', 'LISTING_IMPRESSION_TOTAL', 'SALES_CONVERSION_RATE', 'CLICK_THROUGH_RATE'];
const report = (dimension, rows) => ({
  dimensionMetadata: [],
  header: { dimensionKeys: [{ key: dimension, dataType: dimension === 'DAY' ? 'DATE' : 'STRING' }], metrics: HEADER.map((key) => ({ key, dataType: 'NUMBER' })) },
  records: rows.map((r) => ({
    dimensionValues: [{ value: r.key, applicable: true }],
    metricValues: [r.tx, r.views, r.imp, r.conv, r.ctr].map((value) => ({ value, applicable: true })),
  })),
  warnings: [],
});

const mock = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  hits.push(`${req.method} ${url.pathname}`);
  let body = '';
  for await (const chunk of req) body += chunk;
  const json = (obj, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const xml = (text) => { res.writeHead(200, { 'Content-Type': 'text/xml' }); res.end(text); };
  if (url.pathname === '/identity/v1/oauth2/token') return json({ access_token: 'mock-access', expires_in: 7200, token_type: 'User Access Token' });

  if (url.pathname === '/ws/api.dll') {
    if (req.method !== 'POST') return json({ error: 'method' }, 405);
    const page = Number(body.match(/<PageNumber>(\d+)<\/PageNumber>/)?.[1]);
    tradingCalls.push({
      phase, page, body,
      callName: req.headers['x-ebay-api-call-name'], siteId: req.headers['x-ebay-api-siteid'],
      compat: req.headers['x-ebay-api-compatibility-level'], iaf: req.headers['x-ebay-api-iaf-token'],
    });
    if (req.headers['x-ebay-api-iaf-token'] !== 'mock-access') return xml(failureXml);
    const items = phases[phase].items;
    if (tradingMode === 'fail-page-2' && page === 2) return xml(failureXml);
    return xml(sellingXml(page === 1 ? items.slice(0, 3) : items.slice(3), page, 2, items.length));
  }

  if (url.pathname === '/sell/analytics/v1/traffic_report') {
    const filter = url.searchParams.get('filter') || '';
    const dim = url.searchParams.get('dimension');
    trafficCalls.push({ phase, dim, filter, metric: url.searchParams.get('metric'), auth: req.headers.authorization });
    if (req.headers.authorization !== 'Bearer mock-access') return json({ errors: [{ message: 'bad token' }] }, 401);
    if (trafficMode === '403') return json({ errors: [{ errorId: 1100, message: 'Access denied', longMessage: 'Insufficient permissions to fulfill the request.' }] }, 403);
    const [, from, to] = filter.match(/date_range:\[(\d{8})\.\.(\d{8})\]/) || [];
    if (!from || !filter.includes('marketplace_ids:{EBAY_US}')) return json({ errors: [{ message: 'bad filter' }] }, 400);
    const iso = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`;
    if (dim === 'DAY') {
      const rows = [];
      for (let d = iso(from); d <= iso(to); d = addDays(d, 1)) rows.push({ key: d.replaceAll('-', ''), ...dayVals(d) });
      return json(report('DAY', rows));
    }
    if (dim === 'LISTING') {
      const ids = (filter.match(/listing_ids:\{([^}]*)\}/)?.[1] || '').split('|').filter(Boolean);
      const v = phases[phase].views;
      return json(report('LISTING', ids.filter((id) => id in v).map((id) => ({ key: id, views: v[id], imp: v[id] * 20, ctr: 1.1, conv: 0.5, tx: 0 }))));
    }
  }
  // Empty answers for the rest of syncEbay(), used only by the post-integration hand-off check
  if (url.pathname === '/sell/fulfillment/v1/order') return json({ orders: [], total: 0 });
  if (url.pathname === '/sell/finances/v1/transaction') return json({ transactions: [], total: 0 });
  if (url.pathname === '/post-order/v2/return/search') return json({ members: [], total: 0 });
  json({ errors: [{ message: `mock: no route ${url.pathname}` }] }, 404);
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${mock.address().port}`;

// Point every eBay base URL at the mock BEFORE importing anything that reads it
try { process.loadEnvFile?.(new URL('../.env', import.meta.url)); } catch {}
Object.assign(process.env, {
  EBAY_API_BASE: base, EBAY_APIZ_BASE: base, EBAY_AUTH_BASE: base, LISTINGS_RETRY_MS: '1',
  EBAY_CLIENT_ID: 'test-client', EBAY_CLIENT_SECRET: 'test-secret', EBAY_REFRESH_TOKEN: 'test-refresh',
});
process.env.DATABASE_URL = '';

const { initDb, q, closeDb } = await import('../src/db.js');
const ebay = await import('../src/ebay.js');
const { syncListings, listingAnalytics, parseXml, itemFromXml } = await import('../src/listings.js');
await initDb();

// After integration, the real ebay.js token path (OAuth refresh against the mock) is used; before it, the same
// mock token endpoint is called directly with the scopes the integrated SCOPE_SETS[0] will grant.
const integrated = typeof ebay.ebayUserToken === 'function';
const mockAuth = async () => {
  const r = await fetch(`${base}/identity/v1/oauth2/token`, { method: 'POST', body: 'grant_type=refresh_token' });
  return { token: (await r.json()).access_token, scopes: ['https://api.ebay.com/oauth/api_scope', ANALYTICS] };
};
const auth = integrated ? undefined : mockAuth;
console.log(`DB: throwaway embedded Postgres in ${dir}  mock eBay: ${base}  token path: ${integrated ? 'ebay.ebayUserToken()' : 'test mock auth'}\n`);

let failed = false;
const check = async (label, fn) => {
  try { await fn(); console.log(`  PASS  ${label}`); } catch (e) { failed = true; console.log(`  FAIL  ${label}\n        ${e.stack?.split('\n').slice(0, 3).join('\n        ')}`); }
};

try {
  // ---- parser unit checks
  await check('XML parser: entities, CDATA, attributes, item-level fields only (variation SKU/qty/watch ignored)', () => {
    const doc = parseXml(sellingXml([D, A], 1, 1, 2).replace('<Title>Hydro', '<Title><![CDATA[Hydro & <co>]]> Hydro'));
    const items = doc.children[0].children.find((c) => c.name === 'ActiveList').children[0].children.map(itemFromXml);
    assert.equal(items[0].sku, 'YOGA-PARENT');
    assert.equal(items[0].quantity_sold, 1);
    assert.equal(items[0].quantity, 20);
    assert.equal(items[0].watch_count, 5);
    assert.equal(items[0].price, 29.99);
    assert.equal(items[0].currency, 'USD');
    assert.equal(items[1].title, 'Hydro & <co> Hydro Flask 32 oz Wide Mouth & Straw Lid');
  });

  // ---- sync 1
  const s1 = await syncListings({ auth });
  console.log('  sync 1:', s1.log.join(' | '));
  await check('sync 1 ok: 5 active listings over 2 pages', async () => {
    assert.equal(s1.ok, true);
    assert.equal(s1.active, 5);
    assert.equal(s1.pages, 2);
    assert.equal(s1.traffic, 'ok');
    assert.equal((await q('select count(*)::int n from ebay_listings where not ended'))[0].n, 5);
  });
  await check('pagination: pages 1 and 2 requested once each with the right Trading API headers + body', () => {
    const calls = tradingCalls.filter((c) => c.phase === 1);
    assert.deepEqual(calls.map((c) => c.page), [1, 2]);
    for (const c of calls) {
      assert.equal(c.callName, 'GetMyeBaySelling');
      assert.equal(c.siteId, '0');
      assert.equal(c.compat, '1349');
      assert.equal(c.iaf, 'mock-access');
      assert.match(c.body, /<ActiveList><Include>true<\/Include><IncludeWatchCount>true<\/IncludeWatchCount>/);
      assert.match(c.body, /<EntriesPerPage>200<\/EntriesPerPage>/);
      assert.match(c.body, /xmlns="urn:ebay:apis:eBLBaseComponents"/);
    }
  });
  await check('listing fields stored (title with &, price, qty, sold, start time, SKU, URL, watchers)', async () => {
    const a = (await q('select * from ebay_listings where item_id = $1', [A.id]))[0];
    assert.equal(a.title, A.title);
    assert.equal(Number(a.price), 44.99);
    assert.equal(a.quantity, 5);
    assert.equal(a.quantity_available, 2);
    assert.equal(a.quantity_sold, 3);
    assert.equal(new Date(a.start_time).toISOString(), A.start);
    assert.equal(a.sku, 'HF32');
    assert.equal(a.listing_url, `https://www.ebay.com/itm/${A.id}`);
    assert.equal(a.watch_count, 12);
    const d = (await q('select sku, quantity_sold, watch_count from ebay_listings where item_id = $1', [D.id]))[0];
    assert.deepEqual(d, { sku: 'YOGA-PARENT', quantity_sold: 1, watch_count: 5 });
  });
  await check('traffic calls: DAY for 90 days ending yesterday, LISTING for 30 days with listing_ids, all 5 metrics', () => {
    const calls = trafficCalls.filter((c) => c.phase === 1);
    const day = calls.find((c) => c.dim === 'DAY');
    const lst = calls.find((c) => c.dim === 'LISTING');
    const end = addDays(TODAY, -1).replaceAll('-', '');
    assert.equal(day.filter, `marketplace_ids:{EBAY_US},date_range:[${addDays(TODAY, -90).replaceAll('-', '')}..${end}]`);
    assert.equal(lst.filter, `marketplace_ids:{EBAY_US},date_range:[${addDays(TODAY, -30).replaceAll('-', '')}..${end}],listing_ids:{${[A, B, C, D, E].map((x) => x.id).join('|')}}`);
    assert.equal(day.metric, 'LISTING_IMPRESSION_TOTAL,LISTING_VIEWS_TOTAL,CLICK_THROUGH_RATE,SALES_CONVERSION_RATE,TRANSACTION');
    assert.equal(day.auth, 'Bearer mock-access');
  });

  // ---- sync 2, same day: E ended, F new
  phase = 2;
  const s2 = await syncListings({ auth });
  console.log('  sync 2:', s2.log.join(' | '));
  await check('second sync the same day: still exactly one snapshot row, updated to the latest numbers', async () => {
    const snaps = await q(`select to_char(day,'YYYY-MM-DD') as day, active_count, total_watchers, total_views, views_source, avg_price::float, units_sold from listing_snapshots`);
    assert.equal(snaps.length, 1);
    assert.deepEqual(snaps[0], { day: TODAY, active_count: 5, total_watchers: 21, total_views: 495, views_source: 'analytics_30d', avg_price: 41.89, units_sold: 5 });
  });
  await check('ended listing marked (E ended with ended_at), new listing F active, 6 rows total', async () => {
    assert.equal(s2.newlyEnded, 1);
    const rows = await q('select item_id, ended, ended_at, first_seen, last_seen from ebay_listings order by item_id');
    assert.equal(rows.length, 6);
    const e = rows.find((r) => r.item_id === E.id);
    assert.equal(e.ended, true);
    assert.ok(e.ended_at);
    assert.ok(new Date(e.last_seen) < new Date(e.ended_at));
    assert.deepEqual(rows.filter((r) => r.ended).map((r) => r.item_id), [E.id]);
    const f = rows.find((r) => r.item_id === F.id);
    assert.equal(f.ended, false);
  });
  await check('traffic tables: 90 daily rows (no duplicates), per-listing rows for the 5 active items (F = 0 views)', async () => {
    assert.equal((await q('select count(*)::int n from listing_traffic_daily'))[0].n, 90);
    const lt = await q('select item_id, views from listing_traffic order by item_id');
    assert.deepEqual(lt.map((r) => [r.item_id, r.views]), [[A.id, 320], [B.id, 40], [C.id, 5], [D.id, 130], [F.id, 0]]);
  });

  // ---- orders for the sales comparison (created_at -> Phoenix business day)
  const ord = (id, daysAgo, cancel = 'NONE_REQUESTED') => q('insert into ebay_orders (order_id, created_at, cancel_state) values ($1,$2,$3)', [id, ago(daysAgo), cancel]);
  await ord('T-1', 2); await ord('T-2', 20); await ord('T-3', 5, 'CANCELED'); await ord('DEMO-1', 3);
  for (const [i, d] of [31, 35, 40, 50, 55].entries()) await ord(`P-${i}`, d);
  await ord('OLD-1', 70);

  // ---- analytics
  const a = await listingAnalytics();
  await check('totals: active, avg views/watchers per listing, avg price', () => {
    assert.deepEqual(a.totals, {
      activeListings: 5, endedListings: 1, totalWatchers: 21, avgWatchersPerListing: 4.2, totalViews: 495,
      avgViewsPerListing: 99, viewsSource: 'analytics_30d', avgPrice: 41.89, unitsAvailable: 1 + 2 + 10 + 19 + 3,
    });
  });
  await check('added in last 7 / 30 days (E and F / D, E and F), ended in last 30', () => {
    assert.deepEqual(a.added, { last7: 2, last30: 3, endedLast30: 1 });
  });
  await check('listed-count history: backfilled from start times, snapshot for today, flagged approximate', () => {
    const h = a.listedHistory;
    assert.equal(h.approximate, true);
    assert.equal(h.points.length, 121);
    assert.deepEqual(h.points[0], { day: addDays(TODAY, -120), active: 1, source: 'estimate' });
    const at = (n) => h.points.find((p) => p.day === addDays(TODAY, -n));
    assert.equal(at(61).active, 1); // A only
    assert.equal(at(60).active, 2); // + B
    assert.equal(at(45).active, 3); // + C
    assert.equal(at(10).active, 4); // + D
    assert.equal(at(3).active, 5);  // + E
    assert.equal(at(1).active, 6);  // + F (E not yet known ended)
    assert.deepEqual(at(0), { day: TODAY, active: 5, source: 'snapshot' });
  });
  await check('daily traffic series: 90 days with eBay values (metric order taken from the report header)', () => {
    assert.equal(a.traffic.available, true);
    assert.equal(a.traffic.days.length, 90);
    assert.deepEqual(a.traffic.days.at(-1), { day: addDays(TODAY, -1), impressions: 2000, views: 60, ctr: 2, conversion: 1, transactions: 1 });
    assert.deepEqual(a.traffic.days[0], { day: addDays(TODAY, -90), impressions: 300, views: 10, ctr: 1, conversion: 0, transactions: 0 });
  });
  await check('top 10 by views and by watchers (ties broken by views)', () => {
    assert.deepEqual(a.top.byViews.map((x) => [x.itemId, x.views]), [[A.id, 320], [D.id, 130], [B.id, 40], [C.id, 5], [F.id, 0]]);
    assert.deepEqual(a.top.byWatchers.map((x) => [x.itemId, x.watchers]), [[A.id, 14], [D.id, 5], [B.id, 2], [C.id, 0], [F.id, 0]]);
    assert.equal(a.top.byViews[0].daysLive, 120);
    assert.equal(a.top.byViews[0].impressions, 6400);
    assert.equal(a.top.byViews[0].url, `https://www.ebay.com/itm/${A.id}`);
  });
  await check('stale: live 30+ days, 0 sold, views strictly below the median (40): only C, not B (40 = median)', () => {
    assert.equal(a.stale.criteria.viewsBelowMedian, 40);
    assert.equal(a.stale.count, 1);
    assert.deepEqual(a.stale.listings.map((x) => [x.itemId, x.daysLive, x.views]), [[C.id, 45, 5]]);
  });
  await check('sell-through: 5 units / 5 listings, 2 of 5 listings have a sale', () => {
    assert.deepEqual({ ...a.sellThrough, note: undefined }, { unitsSold: 5, activeListings: 5, unitsPerListing: 1, listingsWithSale: 2, pctListingsWithSale: 40, note: undefined });
  });
  await check('drivers: last 30 vs previous 30 days, exact', () => {
    const d = a.drivers;
    assert.deepEqual(d.windows, {
      current: { from: addDays(TODAY, -29), to: TODAY, trafficDays: 29 },
      previous: { from: addDays(TODAY, -59), to: addDays(TODAY, -30), trafficDays: 30 },
    });
    // average active per day: current = A30+B30+C30+D11+E3+F2 = 106/30; previous = A30+B30+C16 = 76/30
    assert.deepEqual(d.listings, { current: 3.53, previous: 2.53, change: 1, changePct: 39.5 });
    assert.deepEqual(d.listingsAtEnd, { current: 5, previous: 3, change: 2, changePct: 66.7 });
    assert.deepEqual(d.newListings, { current: 3, previous: 1, change: 2, changePct: 200 }); // D,E,F vs C (B started the day before)
    assert.deepEqual(d.impressions, { current: 58000, previous: 30000, change: 28000, changePct: 93.3 });
    assert.deepEqual(d.views, { current: 1740, previous: 2400, change: -660, changePct: -27.5 });
    // views / average active listings: 1740 / (106/30) = 492.45; 2400 / (76/30) = 947.37
    assert.deepEqual(d.viewsPerListing, { current: 492.45, previous: 947.37, change: -454.92, changePct: -48 });
    // previous CTR is impression-weighted: (10*2000*6 + 20*500*1.5) / 30000 = 4.5 (a plain mean would be 3)
    assert.deepEqual(d.ctr, { current: 2, previous: 4.5, change: -2.5, changePct: -55.6 });
    assert.deepEqual(d.conversion, { current: 1, previous: 2.5, change: -1.5, changePct: -60 });
    assert.deepEqual(d.sales, { current: 29, previous: 60, change: -31, changePct: -51.7 });
    // orders: T-1, T-2 now (T-3 cancelled, DEMO-1 excluded); P-0..P-4 before; OLD-1 outside both windows
    assert.deepEqual(d.orders, { current: 2, previous: 5, change: -3, changePct: -60 });
  });

  // ---- 403 from Sell Analytics degrades gracefully
  trafficMode = '403';
  const s3 = await syncListings({ auth });
  console.log('  sync 3 (analytics 403):', s3.log.join(' | '));
  await check('analytics 403: sync still ok, listings refreshed, clear skip line, old traffic kept', async () => {
    assert.equal(s3.ok, true);
    assert.equal(s3.traffic, 'skipped');
    assert.equal(s3.active, 5);
    assert.ok(s3.log.some((l) => l.startsWith('listing traffic: skipped (reconnect eBay to allow analytics)')), s3.log.join(' | '));
    assert.equal((await q('select count(*)::int n from listing_traffic_daily'))[0].n, 90);
    assert.equal((await q('select count(*)::int n from listing_snapshots'))[0].n, 1);
    const again = await listingAnalytics();
    assert.equal(again.totals.avgViewsPerListing, 99);
  });

  // ---- token without the analytics scope: skipped without even calling eBay analytics
  const before = trafficCalls.length;
  const noScope = async () => ({ ...(await mockAuth()), scopes: ['https://api.ebay.com/oauth/api_scope', 'https://api.ebay.com/oauth/api_scope/sell.finances'] });
  const s4 = await syncListings({ auth: noScope });
  await check('token lacking sell.analytics.readonly: skipped with the reconnect line, no analytics call made', () => {
    assert.equal(s4.ok, true);
    assert.equal(s4.traffic, 'skipped');
    assert.ok(s4.log.includes('listing traffic: skipped (reconnect eBay to allow analytics)'));
    assert.equal(trafficCalls.length, before);
  });

  // ---- Trading API failure mid-pagination: nothing marked ended, sync reports failure without throwing
  trafficMode = 'ok';
  tradingMode = 'fail-page-2';
  let s5;
  await check('Trading API failure on page 2: returns ok:false (no throw) and marks nothing ended', async () => {
    s5 = await syncListings({ auth });
    assert.equal(s5.ok, false);
    assert.ok(s5.log.some((l) => /GetMyeBaySelling Failure: 10007/.test(l)), s5.log.join(' | '));
    assert.equal((await q('select count(*)::int n from ebay_listings where ended'))[0].n, 1);
  });
  tradingMode = 'ok';

  // ---- log hand-off to syncEbay's log array + concurrent calls share one run
  await check('syncListings({ log }) appends to the caller log; concurrent calls share one run', async () => {
    const log = [];
    const [x, y] = await Promise.all([syncListings({ auth, log }), syncListings({ auth, log })]);
    assert.equal(x, y);
    assert.ok(log.some((l) => l.startsWith('listings: 5 active (2 pages)')), log.join(' | '));
  });
  if (integrated) {
    await check('integrated: syncEbay() runs syncListings and carries its log lines', async () => {
      const r = await ebay.syncEbay();
      assert.equal(r.ok, true, r.log.join(' | '));
      assert.ok(r.log.some((l) => l.startsWith('listings: 5 active (2 pages)')), r.log.join(' | '));
      assert.ok(r.log.some((l) => l.startsWith('listing traffic: 90 days')), r.log.join(' | '));
    });
  } else console.log('  SKIP  syncEbay() hand-off (runs once the ebay.js integration snippets are applied)');
  await check('read-only toward eBay: only token, GetMyeBaySelling and GET reports were called', () => {
    const allowed = new Set(['POST /identity/v1/oauth2/token', 'POST /ws/api.dll', 'GET /sell/analytics/v1/traffic_report',
      'GET /sell/fulfillment/v1/order', 'GET /sell/finances/v1/transaction', 'GET /post-order/v2/return/search',
      'GET /sell/marketing/v1/ad_campaign']); // Promoted Listings (read-only), covered by scripts/promotions-test.js
    assert.deepEqual([...new Set(hits)].filter((h) => !allowed.has(h)), []);
    assert.ok(tradingCalls.every((c) => c.callName === 'GetMyeBaySelling'));
  });
} finally {
  await closeDb();
  mock.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failed ? '\nLISTINGS: FAILED' : '\nLISTINGS: ALL CHECKS PASSED');
  process.exitCode = failed ? 1 : 0;
}
