// Promoted Listings (read-only toward eBay): which active listings are in a running Promoted Listings campaign, at
// what ad rate, and how promoted listings do next to the rest. Needs the sell.marketing.readonly scope.
//   syncPromotions():       campaigns + their ads from the Sell Marketing API (called from syncListings)
//   promotionAnalytics():   promoted vs not promoted, campaigns, ad rates, ad fees, new listings left unpromoted,
//                           and 30-day performance of each group (views, times shown, orders)
import { q, getSetting, setSetting } from './db.js';

const MARKETING_SCOPE = 'https://api.ebay.com/oauth/api_scope/sell.marketing.readonly';
const api = () => process.env.EBAY_API_BASE || 'https://api.ebay.com';
const marketplace = () => process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';
const SKIPPED = 'promotions: skipped (reconnect eBay to allow reading Promoted Listings)';
const DAY_MS = 86400_000;

export const PROMOTIONS_SCHEMA = `
create table if not exists ebay_campaigns (
  campaign_id    text primary key,
  name           text,
  status         text,
  funding_model  text,
  bid_percentage numeric(6,2),
  rules_based    boolean default false,
  start_date     timestamptz,
  end_date       timestamptz,
  synced_at      timestamptz default now()
);
create table if not exists listing_ads (
  listing_id     text not null,
  campaign_id    text not null,
  ad_id          text,
  ad_status      text,
  bid_percentage numeric(6,2),
  synced_at      timestamptz default now(),
  primary key (listing_id, campaign_id)
);
create index if not exists listing_ads_campaign_idx on listing_ads(campaign_id);
`;
let ready = null;
const ensure = () => (ready ||= q(PROMOTIONS_SCHEMA).catch((e) => { ready = null; throw e; }));

const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;

async function get(url, token) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': marketplace(), Accept: 'application/json' } });
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, Number(process.env.LISTINGS_RETRY_MS ?? 1000) * 2 ** attempt));
      continue;
    }
    const text = await res.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    if (!res.ok) {
      const err = new Error(`eBay ${res.status} on ${new URL(url).pathname}: ${body?.errors?.[0]?.longMessage || body?.errors?.[0]?.message || text.slice(0, 160)}`);
      err.status = res.status;
      throw err;
    }
    return body;
  }
  throw new Error('eBay kept failing (429/5xx)');
}

async function bulk(sql, rows, extra = []) {
  for (let i = 0; i < rows.length; i += 500) await q(sql, [JSON.stringify(rows.slice(i, i + 500)), ...extra]);
}

// Never throws; appends its own "promotions:" log lines. Rows are replaced only for campaigns that were read in full,
// so a failed call never wipes what was known before.
export async function syncPromotions({ token, scopes, lines, syncStart = new Date() }) {
  let status = 'skipped';
  try {
    await ensure();
    if (Array.isArray(scopes) && !scopes.includes(MARKETING_SCOPE)) { lines.push(SKIPPED); return status; }
    const campaigns = [];
    for (let offset = 0; offset < 20000; offset += 100) {
      const body = await get(`${api()}/sell/marketing/v1/ad_campaign?limit=100&offset=${offset}`, token);
      const page = body.campaigns || [];
      campaigns.push(...page);
      if (!body.next || !page.length) break;
    }
    const ads = [];
    const readOk = [];
    const failures = [];
    for (const c of campaigns) {
      if (c.campaignStatus === 'ENDED' || c.campaignStatus === 'DELETED') { readOk.push(c.campaignId); continue; } // ended: nothing live to read
      try {
        const got = [];
        for (let offset = 0; offset < 200000; offset += 500) {
          const body = await get(`${api()}/sell/marketing/v1/ad_campaign/${encodeURIComponent(c.campaignId)}/ad?limit=500&offset=${offset}`, token);
          const page = body.ads || [];
          got.push(...page);
          if (!body.next || !page.length) break;
        }
        for (const a of got) if (a.listingId) ads.push({ listing_id: String(a.listingId), campaign_id: c.campaignId, ad_id: a.adId || null, ad_status: a.adStatus || null, bid_percentage: num(a.bidPercentage) });
        readOk.push(c.campaignId);
      } catch (e) {
        failures.push(`${c.campaignName || c.campaignId} (${e.message})`);
      }
    }
    await bulk(
      `insert into ebay_campaigns (campaign_id, name, status, funding_model, bid_percentage, rules_based, start_date, end_date, synced_at)
       select x.campaign_id, x.name, x.status, x.funding_model, x.bid_percentage, x.rules_based, x.start_date, x.end_date, $2
       from jsonb_to_recordset($1::jsonb) as x(campaign_id text, name text, status text, funding_model text, bid_percentage numeric, rules_based boolean, start_date timestamptz, end_date timestamptz)
       on conflict (campaign_id) do update set name = excluded.name, status = excluded.status, funding_model = excluded.funding_model,
         bid_percentage = excluded.bid_percentage, rules_based = excluded.rules_based, start_date = excluded.start_date, end_date = excluded.end_date, synced_at = excluded.synced_at`,
      campaigns.map((c) => ({
        campaign_id: c.campaignId, name: c.campaignName || null, status: c.campaignStatus || null,
        funding_model: c.fundingStrategy?.fundingModel || null, bid_percentage: num(c.fundingStrategy?.bidPercentage),
        rules_based: Boolean(c.campaignCriterion) || c.campaignTargetingType === 'SMART', start_date: c.startDate || null, end_date: c.endDate || null,
      })),
      [syncStart]
    );
    await bulk(
      `insert into listing_ads (listing_id, campaign_id, ad_id, ad_status, bid_percentage, synced_at)
       select x.listing_id, x.campaign_id, x.ad_id, x.ad_status, x.bid_percentage, $2
       from jsonb_to_recordset($1::jsonb) as x(listing_id text, campaign_id text, ad_id text, ad_status text, bid_percentage numeric)
       on conflict (listing_id, campaign_id) do update set ad_id = excluded.ad_id, ad_status = excluded.ad_status,
         bid_percentage = excluded.bid_percentage, synced_at = excluded.synced_at`,
      ads, [syncStart]
    );
    // Drop what disappeared: ads of campaigns read in full, and campaigns eBay no longer lists
    if (readOk.length) await q('delete from listing_ads where campaign_id = any($1) and synced_at < $2', [readOk, syncStart]);
    await q('delete from listing_ads where campaign_id not in (select campaign_id from ebay_campaigns where synced_at >= $1)', [syncStart]);
    await q('delete from ebay_campaigns where synced_at < $1', [syncStart]);
    const liveAd = (a) => !['PAUSED', 'ARCHIVED'].includes(a.ad_status || '') && campaigns.find((c) => c.campaignId === a.campaign_id)?.campaignStatus === 'RUNNING';
    const live = new Set(ads.filter(liveAd).map((a) => a.listing_id));
    lines.push(`promotions: ${campaigns.length} campaign${campaigns.length === 1 ? '' : 's'}, ${live.size} promoted listing${live.size === 1 ? '' : 's'}`);
    for (const c of campaigns) {
      const mine = ads.filter((a) => a.campaign_id === c.campaignId);
      const byStatus = {};
      for (const a of mine) byStatus[a.ad_status || 'no status'] = (byStatus[a.ad_status || 'no status'] || 0) + 1;
      const shape = [c.campaignStatus, c.fundingStrategy?.fundingModel, c.fundingStrategy?.bidPercentage ? `${c.fundingStrategy.bidPercentage}%` : null,
        c.campaignTargetingType, c.campaignCriterion ? `rules: ${c.campaignCriterion.criterionType || 'yes'}${c.campaignCriterion.autoSelectFutureInventory ? ', adds new listings automatically' : ''}` : null,
        c.fundingStrategy?.adRateStrategy || null, c.channels ? `channels ${[].concat(c.channels).join('/')}` : null].filter(Boolean).join(', ');
      lines.push(`promotions: "${c.campaignName || c.campaignId}": ${shape}; ${mine.length} ads${mine.length ? ` (${Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}`);
    }
    if (failures.length) lines.push(`promotions: couldn't read the ads of ${failures.join('; ')}`);
    status = failures.length ? 'partial' : 'ok';
  } catch (e) {
    lines.push(e.status === 401 || e.status === 403 ? `${SKIPPED} [${e.message}]` : `promotions: skipped (${e.message})`);
  }
  try { await setSetting('promotions_last_sync', { at: new Date().toISOString(), status, log: lines.filter((l) => l.startsWith('promotions')) }); } catch {}
  return status;
}

// A listing counts as promoted when it has an active ad in a running campaign
const LIVE = "coalesce(a.ad_status, '') not in ('PAUSED', 'ARCHIVED') and c.status = 'RUNNING'";

export async function promotionAnalytics({ now = new Date() } = {}) {
  await ensure();
  const nowMs = new Date(now).getTime();
  const lastSync = await getSetting('promotions_last_sync');
  const active = await q(`select item_id, title, price, coalesce(start_time, first_seen) as started, quantity_sold, listing_url from ebay_listings where not ended`);
  const ads = await q(
    `select a.listing_id, a.campaign_id, a.ad_status, coalesce(a.bid_percentage, c.bid_percentage) as rate, c.status as campaign_status, (${LIVE}) as live
     from listing_ads a join ebay_campaigns c on c.campaign_id = a.campaign_id`
  );
  const campaigns = await q(
    // Counted over listings that are still active, so the campaign totals agree with the promoted count
    `select c.campaign_id, c.name, c.status, c.funding_model, c.bid_percentage, c.rules_based,
            count(a.*) filter (where ${LIVE} and l.item_id is not null)::int as live_ads, count(a.*) filter (where l.item_id is not null)::int as ads,
            avg(coalesce(a.bid_percentage, c.bid_percentage)) filter (where ${LIVE} and l.item_id is not null) as avg_rate
     from ebay_campaigns c
     left join listing_ads a on a.campaign_id = c.campaign_id
     left join ebay_listings l on l.item_id = a.listing_id and not l.ended
     group by c.campaign_id order by count(a.*) filter (where ${LIVE} and l.item_id is not null) desc, c.name`
  );
  const activeIds = new Set(active.map((l) => l.item_id));
  const liveAds = ads.filter((a) => a.live && activeIds.has(a.listing_id));
  const promotedIds = new Set(liveAds.map((a) => a.listing_id));
  const pausedIds = new Set(ads.filter((a) => !a.live && activeIds.has(a.listing_id) && !promotedIds.has(a.listing_id)).map((a) => a.listing_id));
  const promoted = active.filter((l) => promotedIds.has(l.item_id));
  const notPromoted = active.filter((l) => !promotedIds.has(l.item_id));

  // Ad rate across the promoted listings (a listing in two campaigns counts at its highest rate)
  const rateBy = new Map();
  for (const a of liveAds) { const r = num(a.rate); if (r !== null) rateBy.set(a.listing_id, Math.max(rateBy.get(a.listing_id) ?? 0, r)); }
  const rates = [...rateBy.values()].sort((x, y) => x - y);
  const rateStats = rates.length ? { avg: r2(rates.reduce((t, x) => t + x, 0) / rates.length), min: rates[0], max: rates.at(-1), median: rates[Math.floor(rates.length / 2)] } : null;

  // 30-day performance of each group, from the per-listing traffic report
  const traffic = new Map((await q('select item_id, impressions, views, transactions from listing_traffic')).map((t) => [t.item_id, t]));
  const perf = (list) => {
    const n = list.length;
    let impressions = 0; let views = 0; let orders = 0; let sold = 0; let withViews = 0;
    for (const l of list) {
      const t = traffic.get(l.item_id);
      impressions += t?.impressions || 0; views += t?.views || 0; orders += t?.transactions || 0; sold += l.quantity_sold || 0;
      if ((t?.views || 0) > 0) withViews++;
    }
    return {
      listings: n,
      shownPerListing: n && traffic.size ? r1(impressions / n) : null,
      viewsPerListing: n && traffic.size ? r2(views / n) : null,
      ordersPer1000: n && traffic.size ? r1((orders / n) * 1000) : null,
      pctWithViews: n && traffic.size ? r1((withViews / n) * 100) : null,
      soldPer100: n ? r1((sold / n) * 100) : null,
    };
  };

  // New listings (posted in the last 30 days) left off every campaign
  const fresh = active.filter((l) => new Date(l.started).getTime() >= nowMs - 30 * DAY_MS);
  const freshNot = fresh.filter((l) => !promotedIds.has(l.item_id));

  // What promoting cost: eBay's ad fee records (charges minus credits) against sales, last 30 days
  const [fees] = await q(
    `select coalesce(sum(case when booking_entry = 'CREDIT' then -amount else amount end), 0) as net
     from ebay_transactions where fee_type = 'AD_FEE' and transaction_at >= $1`, [new Date(nowMs - 30 * DAY_MS)]);
  const [sales] = await q(
    `select coalesce(sum(revenue), 0) as revenue, count(*)::int as n from ebay_orders
     where created_at >= $1 and order_id not like 'DEMO-%' and order_id not like 'E2E-%'
       and not (coalesce(cancel_state, '') ~* 'CANCEL' and coalesce(cancel_state, '') !~* 'NONE_REQUESTED|IN_PROGRESS')`, [new Date(nowMs - 30 * DAY_MS)]);
  const adFees30 = r2(num(fees?.net) || 0);
  const revenue30 = r2(num(sales?.revenue) || 0);

  return {
    lastSync: lastSync || null,
    available: Boolean(lastSync && lastSync.status !== 'skipped') || campaigns.length > 0,
    activeListings: active.length,
    promoted: promoted.length,
    notPromoted: notPromoted.length,
    paused: pausedIds.size,
    pctPromoted: active.length ? r1((promoted.length / active.length) * 100) : null,
    pctNotPromoted: active.length ? r1((notPromoted.length / active.length) * 100) : null,
    rate: rateStats,
    campaigns: campaigns.map((c) => ({
      id: c.campaign_id, name: c.name, status: c.status, type: c.funding_model === 'COST_PER_CLICK' ? 'Advanced (cost per click)' : 'General (cost per sale)',
      rulesBased: c.rules_based, liveAds: c.live_ads, ads: c.ads, rate: num(c.avg_rate) !== null ? r2(num(c.avg_rate)) : num(c.bid_percentage),
    })),
    performance: { promoted: perf(promoted), notPromoted: perf(notPromoted), trafficAvailable: traffic.size > 0 },
    newListings: { last30: fresh.length, notPromoted: freshNot.length, pctNotPromoted: fresh.length ? r1((freshNot.length / fresh.length) * 100) : null },
    adFees: { last30: adFees30, salesLast30: revenue30, pctOfSales: revenue30 ? r2((adFees30 / revenue30) * 100) : null },
  };
}

// Every active listing that isn't promoted, for a CSV (to add them to a campaign in Seller Hub)
export async function unpromotedListings() {
  await ensure();
  return q(
    `select l.item_id, l.title, l.price, coalesce(l.start_time, l.first_seen) as started, l.quantity_sold, coalesce(t.views, 0) as views_30d,
            coalesce(t.impressions, 0) as shown_30d, l.listing_url
     from ebay_listings l
     left join listing_traffic t on t.item_id = l.item_id
     where not l.ended and not exists (
       select 1 from listing_ads a join ebay_campaigns c on c.campaign_id = a.campaign_id where a.listing_id = l.item_id and ${LIVE})
     order by coalesce(l.start_time, l.first_seen) desc`
  );
}
