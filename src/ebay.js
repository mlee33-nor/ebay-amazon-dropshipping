// eBay sync: OAuth refresh-token exchange, Fulfillment API (orders + tracking),
// Finances API (exact fees, ad fees), Post-Order API (returns).
import { q, one, getSetting, setSetting } from './db.js';
import { runMatcher } from './matcher.js';
import { matchLedger } from './ledger.js';

// Overridable for sandbox / the end-to-end test's mock server
const API = process.env.EBAY_API_BASE || 'https://api.ebay.com';
const APIZ = process.env.EBAY_APIZ_BASE || process.env.EBAY_API_BASE || 'https://apiz.ebay.com';
const MARKETPLACE = process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';

const SCOPE_SETS = [
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

export function ebayConfigured() {
  return Boolean(process.env.EBAY_REFRESH_TOKEN && process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET);
}

export function ebayMissing() {
  return ['EBAY_CLIENT_ID', 'EBAY_CLIENT_SECRET', 'EBAY_REFRESH_TOKEN'].filter((k) => !process.env[k]);
}

async function getAccessToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp - 60_000) return tokenCache.token;
  if (!ebayConfigured()) throw new Error(`eBay not configured: missing ${ebayMissing().join(', ')}`);
  const basic = Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString('base64');
  let lastErr;
  for (const scopes of SCOPE_SETS) {
    const res = await fetch(`${API}/identity/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: process.env.EBAY_REFRESH_TOKEN,
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
  const last = await getSetting('ebay_last_finance_sync');
  const from = last
    ? new Date(new Date(last).getTime() - 7 * 86400_000)
    : new Date(Date.now() - Number(process.env.EBAY_BACKFILL_DAYS || 365) * 86400_000);
  const startedAt = new Date().toISOString();
  const saleFees = new Map();
  const adFees = new Map();
  const refunds = new Map();
  let offset = 0;
  while (true) {
    const filter = `transactionDate:[${from.toISOString()}..${startedAt}]`;
    const url = `${APIZ}/sell/finances/v1/transaction?filter=${encodeURIComponent(filter)}&limit=1000&offset=${offset}`;
    const page = await ebayGet(url);
    for (const t of page.transactions || []) {
      const orderRef = t.orderId || t.references?.find((r) => r.referenceType === 'ORDER_ID')?.referenceId;
      if (!orderRef) continue;
      if (t.transactionType === 'SALE') {
        saleFees.set(orderRef, (saleFees.get(orderRef) || 0) + money(t.totalFeeAmount));
      } else if (t.transactionType === 'NON_SALE_CHARGE' && /AD_FEE/i.test(t.feeType || '')) {
        const amt = money(t.amount) * (t.bookingEntry === 'CREDIT' ? -1 : 1);
        adFees.set(orderRef, (adFees.get(orderRef) || 0) + amt);
      } else if (t.transactionType === 'REFUND') {
        refunds.set(orderRef, (refunds.get(orderRef) || 0) + money(t.amount));
      }
    }
    offset += 1000;
    if (!page.next || offset >= (page.total || 0)) break;
  }
  for (const [id, fee] of saleFees) await q('update ebay_orders set ebay_fees = $2 where order_id = $1', [id, fee]);
  for (const [id, fee] of adFees) await q('update ebay_orders set ad_fees = $2 where order_id = $1', [id, Math.max(0, fee)]);
  for (const [id, amt] of refunds)
    await q('update ebay_orders set refund_total = greatest(refund_total, $2) where order_id = $1', [id, amt]);
  await setSetting('ebay_last_finance_sync', startedAt);
  log.push(`finances: fees on ${saleFees.size}, ad fees on ${adFees.size}, refunds on ${refunds.size}`);
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
    running: Boolean(running),
    scopes: tokenCache.scopes,
    last,
    lastSuccess: lastOk?.finished_at || null,
  };
}
