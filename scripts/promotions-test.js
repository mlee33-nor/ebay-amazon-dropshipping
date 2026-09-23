// Promoted Listings: campaigns and ads read from a mock eBay Marketing API (never the real one), then the numbers
// the Products → Promotional tab shows. Throwaway database.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-promo-'));
process.env.LOCAL_PG_DIR = dir;
process.env.LOCAL_PG_PORT = '5443';
process.env.DATABASE_URL = '';
process.env.LISTINGS_RETRY_MS = '1';

// ---- mock eBay Marketing API
let failC4 = false;
let deny = false;
const calls = [];
const CAMPAIGNS = [
  { campaignId: 'C1', campaignName: 'All new items', campaignStatus: 'RUNNING', fundingStrategy: { fundingModel: 'COST_PER_SALE', bidPercentage: '5.0' } },
  { campaignId: 'C2', campaignName: 'Paused test', campaignStatus: 'PAUSED', fundingStrategy: { fundingModel: 'COST_PER_SALE', bidPercentage: '3.0' } },
  { campaignId: 'C3', campaignName: 'Old summer', campaignStatus: 'ENDED', fundingStrategy: { fundingModel: 'COST_PER_SALE', bidPercentage: '2.0' } },
  { campaignId: 'C4', campaignName: 'Advanced', campaignStatus: 'RUNNING', fundingStrategy: { fundingModel: 'COST_PER_CLICK' } },
];
const ADS = {
  C1: [[{ adId: 'a1', listingId: 'L1', adStatus: 'ACTIVE' }, { adId: 'a2', listingId: 'L2', adStatus: 'ACTIVE', bidPercentage: '7.0' }], [{ adId: 'a3', listingId: 'L3', adStatus: 'ACTIVE' }, { adId: 'a99', listingId: 'L99', adStatus: 'ACTIVE' }]],
  C2: [[{ adId: 'b4', listingId: 'L4', adStatus: 'ACTIVE' }]],
  C4: [[{ adId: 'c5', listingId: 'L5', adStatus: 'ACTIVE', bidPercentage: '4.0' }]],
};
const mock = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  calls.push(`${req.method} ${url.pathname}`);
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (deny) return send(403, { errors: [{ message: 'Insufficient permissions to fulfill the request.' }] });
  if (url.pathname === '/sell/marketing/v1/ad_campaign') {
    const offset = Number(url.searchParams.get('offset'));
    return send(200, offset === 0 ? { campaigns: CAMPAIGNS.slice(0, 2), next: 'more' } : { campaigns: CAMPAIGNS.slice(2) });
  }
  const m = url.pathname.match(/^\/sell\/marketing\/v1\/ad_campaign\/([^/]+)\/ad$/);
  if (m) {
    if (m[1] === 'C4' && failC4) return send(500, { errors: [{ message: 'boom' }] });
    const pages = ADS[m[1]] || [[]];
    const i = Number(url.searchParams.get('offset')) / 500;
    return send(200, { ads: pages[i] || [], ...(i + 1 < pages.length ? { next: 'more' } : {}) });
  }
  send(404, {});
});
await new Promise((r) => mock.listen(0, r));
process.env.EBAY_API_BASE = `http://127.0.0.1:${mock.address().port}`;

const { initDb, q, closeDb } = await import('../src/db.js');
const { syncPromotions, promotionAnalytics, unpromotedListings } = await import('../src/promotions.js');
await initDb();

let failed = false;
const check = async (label, fn) => { try { await fn(); console.log(`  PASS  ${label}`); } catch (e) { failed = true; console.log(`  FAIL  ${label}\n        ${e.message}`); } };
const NOW = Date.now();
const ago = (days) => new Date(NOW - days * 86400_000).toISOString();

// Six active listings: L5 and L6 are new (posted in the last 30 days); L7 has ended
for (const [id, days, sold] of [['L1', 90, 2], ['L2', 80, 0], ['L3', 70, 0], ['L4', 60, 1], ['L5', 10, 0], ['L6', 5, 0]]) {
  await q(`insert into ebay_listings (item_id, title, price, quantity, quantity_sold, start_time, listing_url, first_seen, last_seen, ended) values ($1,$2,20,5,$3,$4,$5,$4,now(),false)`,
    [id, `Item ${id}`, sold, ago(days), `https://www.ebay.com/itm/${id}`]);
}
await q(`insert into ebay_listings (item_id, title, price, quantity_sold, start_time, first_seen, last_seen, ended, ended_at) values ('L7','Gone',20,0,$1,$1,$1,true,$1)`, [ago(100)]);
for (const [id, impressions, views, tx] of [['L1', 1000, 30, 1], ['L2', 500, 10, 0], ['L3', 200, 0, 0], ['L4', 100, 5, 0], ['L6', 50, 2, 0]]) {
  await q(`insert into listing_traffic (item_id, impressions, views, transactions) values ($1,$2,$3,$4)`, [id, impressions, views, tx]);
}
// Ad fees in the last 30 days: 5.00 + 2.50 − 1.00 credit = 6.50 (a 9.99 charge from 40 days ago doesn't count)
for (const [id, amt, booking, days] of [['t1', 5, 'DEBIT', 3], ['t2', 2.5, 'DEBIT', 10], ['t3', 1, 'CREDIT', 12], ['t4', 9.99, 'DEBIT', 40]]) {
  await q(`insert into ebay_transactions (transaction_id, type, fee_type, booking_entry, amount, transaction_at) values ($1,'NON_SALE_CHARGE','AD_FEE',$2,$3,$4)`, [id, booking, amt, ago(days)]);
}
await q(`insert into ebay_orders (order_id, created_at, revenue, cancel_state) values ('O1',$1,100,'NONE_REQUESTED'), ('O2',$2,30,'NONE_REQUESTED'), ('O3',$3,500,'NONE_REQUESTED')`, [ago(2), ago(20), ago(45)]);

const SCOPES = ['https://api.ebay.com/oauth/api_scope', 'https://api.ebay.com/oauth/api_scope/sell.marketing.readonly'];

await check('no marketing permission: skipped without calling eBay', async () => {
  const lines = [];
  const n = calls.length;
  assert.equal(await syncPromotions({ token: 't', scopes: ['https://api.ebay.com/oauth/api_scope'], lines }), 'skipped');
  assert.equal(calls.length, n);
  assert.match(lines[0], /reconnect eBay/);
});

let lines = [];
await check('sync: campaigns and ads over several pages, ended campaigns not read', async () => {
  assert.equal(await syncPromotions({ token: 't', scopes: SCOPES, lines }), 'ok');
  assert.ok(calls.includes('GET /sell/marketing/v1/ad_campaign/C1/ad'));
  assert.ok(!calls.includes('GET /sell/marketing/v1/ad_campaign/C3/ad'), 'ended campaign skipped');
  assert.equal((await q('select count(*)::int n from ebay_campaigns'))[0].n, 4);
  assert.equal((await q('select count(*)::int n from listing_ads'))[0].n, 6); // L1 L2 L3 L99 L4 L5
  assert.match(lines.join(' | '), /promotions: 4 campaigns, 5 promoted listings/); // L1 L2 L3 L99 L5 (L99 isn't an active listing)
});

let a;
await check('promoted vs not: only an active ad in a running campaign counts; ended listings ignored', async () => {
  a = await promotionAnalytics({ now: new Date(NOW) });
  assert.equal(a.activeListings, 6);
  assert.equal(a.promoted, 4); // L1 L2 L3 (C1) + L5 (C4)
  assert.equal(a.notPromoted, 2); // L4 (its campaign is paused) + L6
  assert.equal(a.paused, 1);
  assert.equal(a.pctPromoted, 66.7);
  assert.equal(a.pctNotPromoted, 33.3);
});
await check('ad rates: an ad without its own rate uses the campaign rate', async () => {
  assert.deepEqual(a.rate, { avg: 5.25, min: 4, max: 7, median: 5 }); // 5, 7, 5, 4
});
await check('new listings (last 30 days) left unpromoted: 1 of 2', async () => {
  assert.deepEqual(a.newListings, { last30: 2, notPromoted: 1, pctNotPromoted: 50 });
});
await check('ad fees in the last 30 days, net of credits, as a share of sales', async () => {
  assert.deepEqual(a.adFees, { last30: 6.5, salesLast30: 130, pctOfSales: 5 });
});
await check('30-day performance: promoted vs not promoted, per listing', async () => {
  assert.deepEqual(a.performance.promoted, { listings: 4, shownPerListing: 425, viewsPerListing: 10, ordersPer1000: 250, pctWithViews: 50, soldPer100: 50 });
  assert.deepEqual(a.performance.notPromoted, { listings: 2, shownPerListing: 75, viewsPerListing: 3.5, ordersPer1000: 0, pctWithViews: 100, soldPer100: 50 });
});
await check('campaigns list: live ads and rate per campaign', async () => {
  const c1 = a.campaigns.find((c) => c.id === 'C1');
  assert.equal(c1.liveAds, 3); // L1 L2 L3; the ad for L99 (not an active listing) isn't counted
  assert.equal(c1.rate, 5.67); // L1 5, L2 7, L3 5 → 17/3
  assert.equal(a.campaigns.find((c) => c.id === 'C2').liveAds, 0); // paused campaign

});
await check('not-promoted list for the CSV: newest first', async () => {
  const rows = await unpromotedListings();
  assert.deepEqual(rows.map((r) => r.item_id), ['L6', 'L4']);
});

await check('a campaign whose ads fail to load keeps what was known before', async () => {
  failC4 = true;
  lines = [];
  assert.equal(await syncPromotions({ token: 't', scopes: SCOPES, lines }), 'partial');
  assert.match(lines.join(' | '), /couldn't read the ads of Advanced/);
  const b = await promotionAnalytics({ now: new Date(NOW) });
  assert.equal(b.promoted, 4, 'L5 still promoted');
  failC4 = false;
});
await check('eBay says no (403): skipped, nothing wiped', async () => {
  deny = true;
  lines = [];
  assert.equal(await syncPromotions({ token: 't', scopes: SCOPES, lines }), 'skipped');
  assert.match(lines[0], /reconnect eBay/);
  assert.equal((await promotionAnalytics({ now: new Date(NOW) })).promoted, 4);
  deny = false;
});
await check('read-only toward eBay: only GET calls', async () => {
  assert.ok(calls.every((c) => c.startsWith('GET ')), calls.filter((c) => !c.startsWith('GET ')).join(', '));
});

await closeDb();
mock.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(failed ? '\nPROMOTIONS: FAILED' : '\nPROMOTIONS: ALL CHECKS PASSED');
process.exitCode = failed ? 1 : 0;
