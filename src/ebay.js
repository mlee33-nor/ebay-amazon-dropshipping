// eBay sync: OAuth refresh-token exchange, Fulfillment API (orders + tracking),
// Finances API (exact fees, ad fees), Post-Order API (returns).
import { q, one, getSetting, setSetting } from './db.js';
import { runMatcher } from './matcher.js';
import { matchLedger } from './ledger.js';
import { syncListings } from './listings.js';

// Listing data changes slowly and eBay's analytics calls are rate-limited: refresh it every few hours, not every sync
const LISTINGS_EVERY_MS = Number(process.env.LISTINGS_SYNC_HOURS || 3) * 3600_000;

// Overridable for sandbox / the end-to-end test's mock server
const API = process.env.EBAY_API_BASE || 'https://api.ebay.com';
const APIZ = process.env.EBAY_APIZ_BASE || process.env.EBAY_API_BASE || 'https://apiz.ebay.com';
const MARKETPLACE = process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';

const SCOPE_SETS = [
  [
    'https://api.ebay.com/oauth/api_scope',
    'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly',
    'https://api.ebay.com/oauth/api_scope/sell.finances',
    'https://api.ebay.com/oauth/api_scope/sell.analytics.readonly',
    'https://api.ebay.com/oauth/api_scope/sell.marketing.readonly',
  ],
  // Connections made before Promoted Listings was added: keep listing analytics until the seller reconnects
  [
    'https://api.ebay.com/oauth/api_scope',
    'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly',
    'https://api.ebay.com/oauth/api_scope/sell.finances',
    'https://api.ebay.com/oauth/api_scope/sell.analytics.readonly',
  ],
  // Connections made before listing analytics was added: keep fees until the seller reconnects
  [
    'https://api.ebay.com/oauth/api_scope',
    'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly',
    'https://api.ebay.com/oauth/api_scope/sell.finances',
  ],
  [
    'https://api.ebay.com/oauth/api_scope',
    'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly',
  ],
  ['https://api.ebay.com/oauth/api_scope/sell.fulfillment'],
];

let tokenCache = { token: null, exp: 0, scopes: null };

// The refresh token comes from the in-app "Connect eBay" flow (stored in settings) and falls back to
// EBAY_REFRESH_TOKEN. eBay refresh tokens last ~18 months; the dashboard warns before they expire.
let connection = null; // { refresh_token, refresh_expires_at, connected_at, scopes }
export async function loadEbayConnection() {
  connection = await getSetting('ebay_oauth');
  tokenCache = { token: null, exp: 0, scopes: null };
  return connection;
}
const refreshToken = () => connection?.refresh_token || process.env.EBAY_REFRESH_TOKEN || null;
const basicAuth = () => Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString('base64');

export function ebayConfigured() {
  return Boolean(refreshToken() && process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET);
}

export function ebayMissing() {
  const m = ['EBAY_CLIENT_ID', 'EBAY_CLIENT_SECRET'].filter((k) => !process.env[k]);
  if (!refreshToken()) m.push('eBay account connection');
  return m;
}

export function ebayCanConnect() {
  return Boolean(process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET && process.env.EBAY_RUNAME);
}

export function ebayConsentUrl(state) {
  const p = new URLSearchParams({
    client_id: process.env.EBAY_CLIENT_ID,
    response_type: 'code',
    redirect_uri: process.env.EBAY_RUNAME,
    scope: SCOPE_SETS[0].join(' '),
    state,
  });
  return `${process.env.EBAY_AUTH_BASE || 'https://auth.ebay.com'}/oauth2/authorize?${p}`;
}

// Authorization-code exchange after the seller approves on eBay's consent page
export async function ebayConnectWithCode(code) {
  const res = await fetch(`${API}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basicAuth()}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: process.env.EBAY_RUNAME }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.refresh_token) throw new Error(`eBay connection failed: ${body.error || res.status} ${body.error_description || ''}`.trim());
  const value = {
    refresh_token: body.refresh_token,
    refresh_expires_at: new Date(Date.now() + (body.refresh_token_expires_in || 47304000) * 1000).toISOString(),
    connected_at: new Date().toISOString(),
    scopes: SCOPE_SETS[0],
  };
  await setSetting('ebay_oauth', value);
  connection = value;
  tokenCache = { token: body.access_token, exp: Date.now() + (body.expires_in || 7200) * 1000, scopes: SCOPE_SETS[0] };
  return value;
}

async function getAccessToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp - 60_000) return tokenCache.token;
  if (!ebayConfigured()) throw new Error(`eBay not configured: missing ${ebayMissing().join(', ')}`);
  const basic = basicAuth();
  let lastErr;
  for (const scopes of SCOPE_SETS) {
    const res = await fetch(`${API}/identity/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken(),
        scope: scopes.join(' '),
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.access_token) {
      tokenCache = { token: body.access_token, exp: Date.now() + body.expires_in * 1000, scopes };
      return body.access_token;
    }
    lastErr = `${res.status} ${body.error || ''} ${body.error_description || ''}`.trim();
    if (body.error !== 'invalid_scope') break; // only retry with fewer scopes on scope errors
  }
  throw new Error(`eBay token refresh failed: ${lastErr}`);
}

// OAuth user token + the scopes it was granted, for read-only modules outside this file (src/listings.js)
export async function ebayUserToken() {
  const token = await getAccessToken();
  return { token, scopes: tokenCache.scopes || [] };
}

async function ebayGet(url, { iaf = false } = {}) {
  const token = await getAccessToken();
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, {
      headers: {
        Authorization: iaf ? `IAF ${token}` : `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    const text = await res.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    if (!res.ok) {
      const msg = body?.errors?.[0]?.longMessage || body?.errors?.[0]?.message || text.slice(0, 200);
      const err = new Error(`eBay ${res.status} on ${new URL(url).pathname}: ${msg}`);
      err.status = res.status;
      throw err;
    }
    return body;
  }
  throw new Error(`eBay kept failing on ${url}`);
}

const money = (m) => (m && m.value !== undefined ? Number(m.value) : 0);

export function normalizeOrder(o) {
  const ps = o.pricingSummary || {};
  const shipTo = o.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo || {};
  const addr = shipTo.contactAddress || {};
  const refunds = (o.paymentSummary?.refunds || [])
    .filter((r) => !r.refundStatus || /REFUNDED|SUCCESS|COMPLETED/i.test(r.refundStatus))
    .reduce((s, r) => s + money(r.amount), 0);
  const sellerTax = money(ps.tax);
  const ebayTax = (o.lineItems || []).reduce(
    (s, li) => s + (li.ebayCollectAndRemitTaxes || []).reduce((t, x) => t + money(x.amount), 0),
    0
  );
  const total = money(ps.total);
  return {
    order: {
      order_id: o.orderId,
      created_at: o.creationDate,
      buyer_username: o.buyer?.username || null,
      ship_name: shipTo.fullName || null,
      ship_city: addr.city || null,
      ship_state: addr.stateOrProvince || null,
      ship_zip: addr.postalCode || null,
      ship_country: addr.countryCode || null,
      fulfillment_status: o.orderFulfillmentStatus || null,
      payment_status: o.orderPaymentStatus || null,
      cancel_state: o.cancelStatus?.cancelState || null,
      item_subtotal: money(ps.priceSubtotal),
      shipping_charged: money(ps.deliveryCost),
      discount: money(ps.priceDiscount) + money(ps.priceDiscountSubtotal),
      tax_collected: sellerTax + ebayTax,
      // Buyer-paid amount excluding sales tax (tax is a pass-through, never revenue)
      revenue: Math.round((total - sellerTax) * 100) / 100,
      ebay_fees: money(o.totalMarketplaceFee),
      refund_total: refunds,
      raw: o,
    },
    lines: (o.lineItems || []).map((li) => ({
      line_item_id: li.lineItemId,
      order_id: o.orderId,
      legacy_item_id: li.legacyItemId || null,
      sku: li.sku || null,
      title: li.title || null,
      quantity: li.quantity || 1,
      unit_price: li.quantity ? money(li.lineItemCost) / li.quantity : money(li.lineItemCost),
      line_total: money(li.total) || money(li.lineItemCost),
    })),
  };
}

export async function upsertOrder({ order, lines }) {
  await q(
    `insert into ebay_orders (order_id, created_at, buyer_username, ship_name, ship_city, ship_state, ship_zip,
       ship_country, fulfillment_status, payment_status, cancel_state, item_subtotal, shipping_charged, discount,
       tax_collected, revenue, ebay_fees, refund_total, raw, synced_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb, now())
     on conflict (order_id) do update set
       buyer_username = excluded.buyer_username, ship_name = excluded.ship_name, ship_city = excluded.ship_city,
       ship_state = excluded.ship_state, ship_zip = excluded.ship_zip, ship_country = excluded.ship_country,
       fulfillment_status = excluded.fulfillment_status, payment_status = excluded.payment_status,
       cancel_state = excluded.cancel_state, item_subtotal = excluded.item_subtotal,
       shipping_charged = excluded.shipping_charged, discount = excluded.discount,
       tax_collected = excluded.tax_collected, revenue = excluded.revenue,
       ebay_fees = greatest(excluded.ebay_fees, ebay_orders.ebay_fees),
       refund_total = greatest(excluded.refund_total, ebay_orders.refund_total),
       raw = excluded.raw, synced_at = now()`,
    [
      order.order_id, order.created_at, order.buyer_username, order.ship_name, order.ship_city, order.ship_state,
      order.ship_zip, order.ship_country, order.fulfillment_status, order.payment_status, order.cancel_state,
      order.item_subtotal, order.shipping_charged, order.discount, order.tax_collected, order.revenue,
      order.ebay_fees, order.refund_total, JSON.stringify(order.raw || {}),
    ]
  );
  for (const li of lines) {
    await q(
      `insert into ebay_line_items (line_item_id, order_id, legacy_item_id, sku, title, quantity, unit_price, line_total)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (line_item_id) do update set title = excluded.title, quantity = excluded.quantity,
         unit_price = excluded.unit_price, line_total = excluded.line_total, sku = excluded.sku`,
      [li.line_item_id, li.order_id, li.legacy_item_id, li.sku, li.title, li.quantity, li.unit_price, li.line_total]
    );
  }
}

async function syncOrders(log) {
  const backfillDays = Number(process.env.EBAY_BACKFILL_DAYS || 365);
  const lastSync = await getSetting('ebay_last_order_sync');
  let filter;
  if (lastSync) {
    const from = new Date(new Date(lastSync).getTime() - 3 * 86400_000).toISOString();
    filter = `lastmodifieddate:[${from}..]`;
  } else {
    const from = new Date(Date.now() - backfillDays * 86400_000).toISOString();
    filter = `creationdate:[${from}..]`;
  }
  const startedAt = new Date().toISOString();
  let offset = 0;
  let count = 0;
  while (true) {
    const url = `${API}/sell/fulfillment/v1/order?filter=${encodeURIComponent(filter)}&limit=200&offset=${offset}`;
    const page = await ebayGet(url);
    for (const o of page.orders || []) {
      await upsertOrder(normalizeOrder(o));
      count++;
    }
    offset += 200;
    if (!page.next || offset >= (page.total || 0)) break;
  }
  await setSetting('ebay_last_order_sync', startedAt);
  log.push(`orders: ${count} new/updated`);
  return count;
}

async function syncTracking(log) {
  const rows = await q(
    `select order_id from ebay_orders
     where not tracking_fetched and fulfillment_status in ('FULFILLED','IN_PROGRESS')
       and order_id not like 'DEMO-%'
     order by created_at desc limit 200`
  );
  let n = 0;
  const queue = [...rows];
  const worker = async () => {
    while (queue.length) {
      const { order_id } = queue.shift();
      try {
        const body = await ebayGet(`${API}/sell/fulfillment/v1/order/${encodeURIComponent(order_id)}/shipping_fulfillment`);
        const nums = (body.fulfillments || []).map((f) => f.shipmentTrackingNumber).filter(Boolean);
        await q('update ebay_orders set tracking_numbers = $2, tracking_fetched = true where order_id = $1', [order_id, nums]);
        n++;
      } catch (e) {
        if (e.status === 404) await q('update ebay_orders set tracking_fetched = true where order_id = $1', [order_id]);
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  log.push(`tracking: ${n} orders`);
}

async function syncFinances(log) {
  if (!tokenCache.scopes?.some((s) => s.includes('sell.finances'))) {
    log.push('finances: skipped (token lacks sell.finances scope; using order-level fees, no ad fees)');
    return;
  }
  // First run with the transactions table (or an empty one) backfills the whole history
  const hasAny = (await q('select 1 from ebay_transactions limit 1')).length > 0;
  const last = hasAny ? await getSetting('ebay_last_finance_sync') : null;
  const from = last
    ? new Date(new Date(last).getTime() - 7 * 86400_000)
    : new Date(Date.now() - Number(process.env.EBAY_BACKFILL_DAYS || 365) * 86400_000);
  const startedAt = new Date().toISOString();
  const touched = new Set();
  let stored = 0;
  let offset = 0;
  while (true) {
    const filter = `transactionDate:[${from.toISOString()}..${startedAt}]`;
    const url = `${APIZ}/sell/finances/v1/transaction?filter=${encodeURIComponent(filter)}&limit=1000&offset=${offset}`;
    const page = await ebayGet(url);
    for (const t of page.transactions || []) {
      const orderRef = t.orderId || t.references?.find((r) => r.referenceType === 'ORDER_ID')?.referenceId;
      if (!orderRef || !t.transactionId) continue;
      // Fee on a SALE is what eBay charged; on a REFUND it is the fee eBay credits back (per order line)
      const lineFees = (t.orderLineItems || []).reduce((s, li) => s + (li.marketplaceFees || []).reduce((x, f) => x + money(f.amount), 0), 0);
      const fee = money(t.totalFeeAmount) || lineFees;
      await q(
        `insert into ebay_transactions (transaction_id, order_id, type, fee_type, booking_entry, amount, fee_amount, transaction_at, raw)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
         on conflict (transaction_id) do update set order_id = excluded.order_id, type = excluded.type, fee_type = excluded.fee_type,
           booking_entry = excluded.booking_entry, amount = excluded.amount, fee_amount = excluded.fee_amount,
           transaction_at = excluded.transaction_at, raw = excluded.raw`,
        [t.transactionId, orderRef, t.transactionType || null, t.feeType || null, t.bookingEntry || null,
          money(t.amount), Math.abs(fee), t.transactionDate || null, JSON.stringify(t)]
      );
      touched.add(orderRef);
      stored++;
    }
    offset += 1000;
    if (!page.next || offset >= (page.total || 0)) break;
  }
  await applyFinanceTotals([...touched]);
  await setSetting('ebay_last_finance_sync', startedAt);
  log.push(`finances: ${stored} records on ${touched.size} orders`);
}

// Per-order totals from ALL stored Finances records: sale fees, ad fees net of ad credits, buyer refunds,
// and the fees eBay credited back on refunds.
export async function applyFinanceTotals(orderIds) {
  if (!orderIds.length) return;
  const rows = await q(
    `select order_id,
            sum(case when type = 'SALE' then fee_amount else 0 end) as sale_fees,
            sum(case when type = 'NON_SALE_CHARGE' and fee_type ilike '%AD_FEE%'
                     then case when booking_entry = 'CREDIT' then -amount else amount end else 0 end) as ad_fees,
            sum(case when type = 'REFUND' then amount else 0 end) as refunds,
            sum(case when type = 'REFUND' then fee_amount else 0 end) as fee_credit,
            bool_or(type = 'SALE') as has_sale
     from ebay_transactions where order_id = any($1) group by order_id`,
    [orderIds]
  );
  for (const r of rows) {
    if (r.has_sale) await q('update ebay_orders set ebay_fees = $2 where order_id = $1', [r.order_id, Number(r.sale_fees)]);
    await q('update ebay_orders set ad_fees = $2, fee_credit = $3 where order_id = $1', [r.order_id, Math.max(0, Number(r.ad_fees)), Number(r.fee_credit)]);
    if (Number(r.refunds) > 0) await q('update ebay_orders set refund_total = greatest(refund_total, $2) where order_id = $1', [r.order_id, Number(r.refunds)]);
  }
}

async function syncReturns(log) {
  const last = await getSetting('ebay_last_return_sync');
  const from = last
    ? new Date(new Date(last).getTime() - 30 * 86400_000)
    : new Date(Date.now() - Number(process.env.EBAY_BACKFILL_DAYS || 365) * 86400_000);
  const startedAt = new Date().toISOString();
  let pageNo = 1;
  let n = 0;
  while (pageNo < 50) {
    const url = `${API}/post-order/v2/return/search?creation_date_range_from=${encodeURIComponent(
      from.toISOString()
    )}&limit=200&offset=${pageNo}`;
    let body;
    try {
      body = await ebayGet(url, { iaf: true });
    } catch (e) {
      log.push(`returns: unavailable (${e.message})`);
      return 0;
    }
    const members = body.members || [];
    for (const r of members) {
      const refund =
        money(r.buyerTotalRefund?.actualRefundAmount) || money(r.buyerTotalRefund?.estimatedRefundAmount);
      await q(
        `insert into ebay_returns (return_id, order_id, item_id, state, status, reason, return_type, created_at, refund_amount, raw, synced_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb, now())
         on conflict (return_id) do update set state = excluded.state, status = excluded.status,
           refund_amount = excluded.refund_amount, raw = excluded.raw, synced_at = now()`,
        [
          String(r.returnId), r.orderId || null, r.creationInfo?.item?.itemId || null, r.state || null,
          r.status || null, r.creationInfo?.reason || r.creationInfo?.reasonType || null, r.currentType || null,
          r.creationInfo?.creationDate?.value || null, refund, JSON.stringify(r),
        ]
      );
      n++;
    }
    const total = body.total || 0;
    if (members.length < 200 || pageNo * 200 >= total) break;
    pageNo++;
  }
  await setSetting('ebay_last_return_sync', startedAt);
  log.push(`returns: ${n}`);
  return n;
}

let running = null;

export async function syncEbay() {
  if (running) return running;
  running = (async () => {
    const [{ id }] = await q('insert into sync_log (started_at) values (now()) returning id');
    const log = [];
    let orders = 0;
    let returns = 0;
    try {
      orders = await syncOrders(log);
      await syncTracking(log).catch((e) => log.push(`tracking: ${e.message}`));
      await syncFinances(log).catch((e) => log.push(`finances: ${e.message}`));
      returns = await syncReturns(log);
      const m = await runMatcher();
      log.push(`matcher: ${m.linked} new links`);
      log.push(`ledger: ${await matchLedger()} sheet rows matched to eBay orders`);
      const lastListings = await getSetting('listings_last_sync');
      if (!lastListings?.at || Date.now() - new Date(lastListings.at).getTime() > LISTINGS_EVERY_MS) await syncListings({ log }); // never throws
      await q('update sync_log set finished_at = now(), ok = true, message = $2, orders = $3, returns = $4 where id = $1', [
        id, log.join(' · '), orders, returns,
      ]);
      return { ok: true, log };
    } catch (e) {
      log.push(e.message);
      await q('update sync_log set finished_at = now(), ok = false, message = $2 where id = $1', [id, log.join(' · ')]);
      return { ok: false, log };
    } finally {
      running = null;
    }
  })();
  return running;
}

export async function ebayStatus() {
  const last = await one('select * from sync_log order by id desc limit 1');
  const lastOk = await one('select finished_at from sync_log where ok order by id desc limit 1');
  return {
    configured: ebayConfigured(),
    missing: ebayMissing(),
    canConnect: ebayCanConnect(),
    runameSet: Boolean(process.env.EBAY_RUNAME),
    connectedAt: connection?.connected_at || null,
    refreshExpiresAt: connection?.refresh_expires_at || null,
    source: connection?.refresh_token ? 'connected' : process.env.EBAY_REFRESH_TOKEN ? 'env' : null,
    needsReconnect: /invalid_grant|refresh token is invalid|token refresh failed/i.test(last?.message || '') && !last?.ok,
    running: Boolean(running),
    scopes: tokenCache.scopes,
    last,
    lastSuccess: lastOk?.finished_at || null,
  };
}
