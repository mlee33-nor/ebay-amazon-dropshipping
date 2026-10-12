// eBay sync: OAuth refresh-token exchange, Fulfillment API (orders + tracking),
// Finances API (exact fees, ad fees, and every other money record), Post-Order API (returns).
// Each sync records a status per step (orders, finances, returns); a failed or skipped step makes the sync not ok.
import crypto from 'node:crypto';
import { q, one, getSetting, setSetting, accountState, currentAccount, MAIN } from './db.js';
import { runMatcher } from './matcher.js';
import { matchLedger } from './ledger.js';
import { syncListings } from './listings.js';

// Listing data changes slowly and eBay's analytics calls are rate-limited: refresh it every few hours, not every sync
const LISTINGS_EVERY_MS = Number(process.env.LISTINGS_SYNC_HOURS || 3) * 3600_000;

// Overridable for sandbox / the end-to-end test's mock server
const API = process.env.EBAY_API_BASE || 'https://api.ebay.com';
const APIZ = process.env.EBAY_APIZ_BASE || process.env.EBAY_API_BASE || 'https://apiz.ebay.com';
const MARKETPLACE = process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';
// First wait before retrying a 429/5xx (then x2, x4). Tests shorten it.
const RETRY_MS = Number(process.env.EBAY_RETRY_MS || 1000);
// A Finances or returns sync older than this is flagged: ad fees, refunds and returns since then may be missing
const STEP_STALE_MS = Number(process.env.EBAY_STEP_STALE_HOURS || 3) * 3600_000;

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

// One copy per account (each eBay store has its own connection, token and sync)
const S = accountState(() => ({ tokenCache: { token: null, exp: 0, scopes: null }, schemaReady: null, connection: null, running: null }));

// Columns the eBay sync adds to the tables src/db.js creates. Run once per process (startup and before the first sync);
// every statement is safe to run again. Pass true to run it again (a test standing in for a restart).
//   ebay_transactions: every record is stored, whatever its type, with or without an order (order_id null for
//     account-level charges and payouts). refs = eBay's references as given ([{referenceId, referenceType}]: ORDER_ID,
//     RETURN_ID, CASE_ID, ...); hold_id pairs a DISPUTE_HOLD-<id> debit with the DISPUTE_HOLD_REVERSE-<id>-<n> credit
//     that releases it; transaction_status, payout_id, memo are eBay's transactionStatus, payoutId, transactionMemo.
//   ebay_returns: recheck_error / recheck_failed_at = why and since when an open return couldn't be fetched by id.
//   sync_log: status = ok | partial (a step failed or was skipped) | failed; steps = { orders, finances, returns }:
//     { ok, status, at, message, warnings }.
export function ensureEbaySchema(again = false) {
  if (!S().schemaReady || again) {
    S().schemaReady = (async () => {
      for (const sql of [
        `alter table ebay_transactions add column if not exists refs jsonb default '[]'::jsonb`,
        'alter table ebay_transactions add column if not exists hold_id text',
        'alter table ebay_transactions add column if not exists transaction_status text',
        'alter table ebay_transactions add column if not exists payout_id text',
        'alter table ebay_transactions add column if not exists memo text',
        'create index if not exists ebay_transactions_type_idx on ebay_transactions(type, transaction_at)',
        'create index if not exists ebay_transactions_hold_idx on ebay_transactions(hold_id) where hold_id is not null',
        'alter table ebay_returns add column if not exists recheck_error text',
        'alter table ebay_returns add column if not exists recheck_failed_at timestamptz',
        'alter table sync_log add column if not exists status text',
        'alter table sync_log add column if not exists steps jsonb',
        // Records stored before these columns existed: each one filled on its own, so a record missing one field
        // (or with no raw at all) still gets the others. hold_id needs only the id.
        `update ebay_transactions set hold_id = substring(transaction_id from '^DISPUTE_HOLD(?:_REVERSE)?-([0-9]+)')
           where hold_id is null and transaction_id ~ '^DISPUTE_HOLD(_REVERSE)?-[0-9]'`,
        `update ebay_transactions set refs = raw->'references'
           where coalesce(refs, '[]'::jsonb) = '[]'::jsonb and jsonb_typeof(raw->'references') = 'array' and raw->'references' <> '[]'::jsonb`,
        `update ebay_transactions set transaction_status = raw->>'transactionStatus' where transaction_status is null and raw ? 'transactionStatus'`,
        `update ebay_transactions set payout_id = raw->>'payoutId' where payout_id is null and raw ? 'payoutId'`,
        `update ebay_transactions set memo = raw->>'transactionMemo' where memo is null and raw ? 'transactionMemo'`,
      ]) await q(sql);
    })().catch((e) => { S().schemaReady = null; throw e; });
  }
  return S().schemaReady;
}

// The refresh token comes from the in-app "Connect eBay" flow (stored in settings) and falls back to
// EBAY_REFRESH_TOKEN. eBay refresh tokens last ~18 months; the dashboard warns before they expire.
// S().connection: { refresh_token, refresh_expires_at, connected_at, scopes }
export async function loadEbayConnection() {
  await ensureEbaySchema();
  S().connection = await getSetting('ebay_oauth');
  S().tokenCache = { token: null, exp: 0, scopes: null };
  return S().connection;
}
const refreshToken = () => S().connection?.refresh_token || (currentAccount() === MAIN ? process.env.EBAY_REFRESH_TOKEN : null) || null;
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
  S().connection = value;
  S().tokenCache = { token: body.access_token, exp: Date.now() + (body.expires_in || 7200) * 1000, scopes: SCOPE_SETS[0] };
  return value;
}

async function getAccessToken() {
  if (S().tokenCache.token && Date.now() < S().tokenCache.exp - 60_000) return S().tokenCache.token;
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
      S().tokenCache = { token: body.access_token, exp: Date.now() + body.expires_in * 1000, scopes };
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
  return { token, scopes: S().tokenCache.scopes || [] };
}

async function ebayGet(url, { iaf = false } = {}) {
  const token = await getAccessToken();
  let lastStatus = null;
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
      lastStatus = res.status;
      if (attempt < 3) await new Promise((r) => setTimeout(r, RETRY_MS * 2 ** attempt));
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
  const err = new Error(`eBay kept failing (${lastStatus}) on ${new URL(url).pathname}`);
  err.status = lastStatus;
  throw err;
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
  const ids = [];
  while (true) {
    const url = `${API}/sell/fulfillment/v1/order?filter=${encodeURIComponent(filter)}&limit=200&offset=${offset}`;
    const page = await ebayGet(url);
    for (const o of page.orders || []) {
      await upsertOrder(normalizeOrder(o));
      ids.push(o.orderId);
      count++;
    }
    offset += 200;
    if (!page.next || offset >= (page.total || 0)) break;
  }
  // Finances records stored before their order arrived (an orders outage while Finances kept working) still reach
  // the order: its fees, ad fees and refunds always come from every stored record, whichever step ran first.
  await applyFinanceTotals(ids);
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

// Every transaction type the Finances API documents. Anything else is still stored, and named in the sync log.
const KNOWN_TX_TYPES = new Set(['SALE', 'REFUND', 'CREDIT', 'DISPUTE', 'NON_SALE_CHARGE', 'SHIPPING_LABEL', 'TRANSFER',
  'ADJUSTMENT', 'WITHDRAWAL', 'LOAN_REPAYMENT', 'PURCHASE']);
// Fee types eBay documents for Finances records (FeeTypeEnum). A record with any other feeType is still stored, and
// named as a warning: a new kind of eBay charge should be looked at, not pass unnoticed.
const KNOWN_FEE_TYPES = new Set(['AD_FEE', 'BELOW_STANDARD_FEE', 'BOLD_FEE', 'FINAL_VALUE_FEE', 'FINAL_VALUE_FEE_FIXED_PER_ORDER',
  'FINAL_VALUE_SHIPPING_FEE', 'GALLERY_PLUS_FEE', 'HIGH_ITEM_NOT_AS_DESCRIBED_FEE', 'INSERTION_FEE', 'INTERNATIONAL_FEE',
  'OTHER_FEES', 'PAYMENT_DISPUTE_FEE', 'PRIVATE_LISTING_FEE', 'REGULATORY_OPERATING_FEE', 'RESERVE_PRICE_FEE', 'SCHEDULING_FEE',
  'SUBSCRIPTION_FEE', 'SUBTITLE_FEE', 'TAX_DEDUCTION_AT_SOURCE', 'INCOME_TAX_WITHHOLDING', 'VALUE_PACK_FEE']);
// What the books read today (src/dataset.js): SALE fees, REFUNDs and AD_FEE charges/credits. The rest is stored for the
// books to use (disputes, return labels, store fees, payouts) and counted in the sync log so nothing is silently skipped.
const inBooks = (r) => r.type === 'SALE' || r.type === 'REFUND' || (r.type === 'NON_SALE_CHARGE' && /AD_FEE/i.test(r.fee_type || ''));

// One Finances record as stored. EVERY record is kept, whatever its type, with or without an order:
//   order_id    the ORDER_ID (from orderId or the references), null for account-level records (store subscription,
//               insertion fees, payouts/TRANSFER, ADJUSTMENT, ...)
//   refs        every reference eBay gives, as eBay gives it ([{ referenceId, referenceType }], e.g. RETURN_ID, CASE_ID)
//   hold_id     for return/case holds: the id shared by DISPUTE_HOLD-<id> (the debit) and DISPUTE_HOLD_REVERSE-<id>-<n>
//               (the CREDIT that releases it), so a hold and its release pair up
//   transaction_status, payout_id, memo   eBay's transactionStatus, payoutId and transactionMemo
// A record eBay sends without a transactionId gets a stable id made from its contents (NOID-...), so re-syncing the
// same window never stores it twice. Only fields that never change go into it: payoutId, transactionStatus and the memo
// are filled in or changed when the record is paid out, and the 7-day look-back re-reads it after that, so hashing them
// would store the same record twice (an ad fee counted double). Two records with exactly the same contents are told
// apart by `seen` (one Map per sync): the second one gets #2, the third #3, in the order eBay lists them.
// A record WITH a transactionId carries the same key (noid): if eBay first sent it without an id and later with one,
// syncFinances removes the NOID- copy so the record is never counted twice.
function noIdKey(t, orderId, refs) {
  const refKey = refs.map((r) => [r.referenceType, r.referenceId]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return crypto.createHash('sha1').update(JSON.stringify([t.transactionType, t.transactionDate, t.bookingEntry, t.amount?.value,
    t.amount?.currency, t.feeType, orderId, refKey])).digest('hex').slice(0, 24);
}
export function normalizeTransaction(t, seen = null) {
  const refs = (t.references || []).map((r) => ({ referenceId: r.referenceId != null ? String(r.referenceId) : null, referenceType: r.referenceType || null }));
  const orderId = t.orderId || refs.find((r) => r.referenceType === 'ORDER_ID')?.referenceId || null;
  // Fee on a SALE is what eBay charged; on a REFUND it is the fee eBay credits back (per order line)
  const lineFees = (t.orderLineItems || []).reduce((s, li) => s + (li.marketplaceFees || []).reduce((x, f) => x + money(f.amount), 0), 0);
  const fee = money(t.totalFeeAmount) || lineFees;
  let id;
  let repeat = 0;
  const key = noIdKey(t, orderId, refs);
  if (t.transactionId) id = String(t.transactionId);
  else {
    repeat = seen ? (seen.get(key) || 0) + 1 : 1;
    if (seen) seen.set(key, repeat);
    id = repeat > 1 ? `NOID-${key}#${repeat}` : `NOID-${key}`;
  }
  return {
    transaction_id: id,
    order_id: orderId,
    type: t.transactionType || null,
    fee_type: t.feeType || null,
    booking_entry: t.bookingEntry || null,
    amount: money(t.amount),
    fee_amount: Math.abs(fee),
    transaction_at: t.transactionDate || null,
    refs,
    hold_id: /^DISPUTE_HOLD(?:_REVERSE)?-(\d+)/.exec(id)?.[1] || null,
    transaction_status: t.transactionStatus || null,
    payout_id: t.payoutId || null,
    memo: t.transactionMemo || null,
    repeat, // > 1: the n-th record with exactly the same contents in this sync (no transactionId)
    noid: t.transactionId ? key : null, // the key its NOID- id would have had, had eBay sent it without the transactionId
    raw: t,
  };
}

export async function upsertTransaction(r) {
  await ensureEbaySchema();
  const vals = [r.order_id, r.type, r.fee_type, r.booking_entry, r.amount, r.fee_amount, r.transaction_at, JSON.stringify(r.raw || {}),
    JSON.stringify(r.refs || []), r.hold_id, r.transaction_status, r.payout_id, r.memo];
  const sql = `insert into ebay_transactions (transaction_id, order_id, type, fee_type, booking_entry, amount, fee_amount, transaction_at, raw,
       refs, hold_id, transaction_status, payout_id, memo)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14)
     on conflict (transaction_id) do update set order_id = excluded.order_id, type = excluded.type, fee_type = excluded.fee_type,
       booking_entry = excluded.booking_entry, amount = excluded.amount, fee_amount = excluded.fee_amount,
       transaction_at = excluded.transaction_at, raw = excluded.raw, refs = excluded.refs, hold_id = excluded.hold_id,
       transaction_status = excluded.transaction_status, payout_id = excluded.payout_id, memo = excluded.memo
     where ebay_transactions.type is not distinct from excluded.type
     returning transaction_id`;
  const rows = await q(sql, [r.transaction_id, ...vals]);
  if (rows.length) return rows[0].transaction_id;
  // Same id already held by a record of another type (eBay ids are only unique per type, e.g. a SALE's id is its order
  // number): keep both, the later one as TYPE:id, instead of letting one overwrite the other.
  // If TYPE:id is itself held by a record of yet another type, nothing was stored: fail the step rather than lose it.
  const alt = `${r.type}:${r.transaction_id}`;
  const altRows = await q(sql, [alt, ...vals]);
  if (!altRows.length) throw new Error(`Finances record ${r.transaction_id} (${r.type}) collides with stored records of other types`);
  return alt;
}

async function syncFinances(log) {
  // Get (or refresh) the token first: the scopes are only known once a token was granted. A refresh that fails (eBay's
  // sign-in down, network) then fails this step with the real error instead of reading as a missing scope.
  await getAccessToken();
  if (!S().tokenCache.scopes?.some((s) => s.includes('sell.finances'))) {
    const why = 'token lacks sell.finances scope; using order-level fees, no ad fees or refund dates. Reconnect eBay';
    log.push(`finances: skipped (${why})`);
    return { skipped: why };
  }
  // First run with the transactions table (or an empty one) backfills the whole history. So does the first run that
  // stores every record (ebay_finances_all_records_since unset): the code before it dropped records with no order or no
  // transactionId (store subscription, insertion fees, payouts), and only a full re-read brings back the ones older than
  // the 7-day look-back. Safe to repeat: every record is upserted by its id, and order totals come from all stored records.
  const hasAny = (await q('select 1 from ebay_transactions limit 1')).length > 0;
  const last = hasAny ? await getSetting('ebay_last_finance_sync') : null;
  const allRecords = await getSetting('ebay_finances_all_records_since');
  const from = last && allRecords
    ? new Date(new Date(last).getTime() - 7 * 86400_000)
    : new Date(Date.now() - Number(process.env.EBAY_BACKFILL_DAYS || 365) * 86400_000);
  const startedAt = new Date().toISOString();
  const touched = new Set();
  let stored = 0;
  let orderless = 0;
  const notInBooks = new Map(); // "TYPE" or "NON_SALE_CHARGE/FEE_TYPE" -> count, for the sync log
  const unknown = new Set();
  const unknownFee = new Set();
  const noIdInBooks = new Map(); // records the books read that came without a transactionId, by type
  const seen = new Map(); // records without a transactionId: how many with the same contents so far
  const withId = new Map(); // content key -> order id, for records that came with a transactionId
  let twins = 0;
  let offset = 0;
  while (true) {
    const filter = `transactionDate:[${from.toISOString()}..${startedAt}]`;
    const url = `${APIZ}/sell/finances/v1/transaction?filter=${encodeURIComponent(filter)}&limit=1000&offset=${offset}`;
    const page = await ebayGet(url);
    for (const t of page.transactions || []) {
      const r = normalizeTransaction(t, seen);
      if (r.repeat > 1) twins++;
      if (r.noid) withId.set(r.noid, r.order_id);
      else if (inBooks(r)) noIdInBooks.set(r.type, (noIdInBooks.get(r.type) || 0) + 1);
      await upsertTransaction(r);
      if (r.order_id) touched.add(r.order_id);
      else orderless++;
      if (!inBooks(r)) {
        const k = r.type === 'NON_SALE_CHARGE' ? `NON_SALE_CHARGE/${r.fee_type || 'no fee type'}` : r.type || 'no type';
        notInBooks.set(k, (notInBooks.get(k) || 0) + 1);
      }
      if (!KNOWN_TX_TYPES.has(r.type)) unknown.add(r.type || 'no type');
      if (r.fee_type && !KNOWN_FEE_TYPES.has(r.fee_type)) unknownFee.add(r.fee_type);
      stored++;
    }
    offset += 1000;
    if (!page.next || offset >= (page.total || 0)) break;
  }
  // A record stored earlier without a transactionId (NOID-<key>) that eBay now sends with one: the NOID- copy goes, or
  // the record would count twice. Copies still sent without an id in this same read (seen) are the ones to keep:
  // NOID-<key> stays if one was, #2 too if two were, and so on.
  let replaced = 0;
  for (const [key, orderId] of withId) {
    const keep = seen.get(key) || 0;
    const rows = await q('select transaction_id from ebay_transactions where transaction_id = $1 or transaction_id like $2',
      [`NOID-${key}`, `NOID-${key}#%`]);
    const drop = rows.map((x) => x.transaction_id).filter((tid) => Number(tid.split('#')[1] || 1) > keep);
    if (!drop.length) continue;
    await q('delete from ebay_transactions where transaction_id = any($1)', [drop]);
    replaced += drop.length;
    if (orderId) touched.add(orderId);
  }
  await applyFinanceTotals([...touched]);
  await setSetting('ebay_last_finance_sync', startedAt);
  await setSetting('ebay_finances_all_records_since', allRecords || startedAt);
  let msg = `finances: ${stored} records on ${touched.size} orders`;
  if (orderless) msg += `, ${orderless} with no order`;
  if (notInBooks.size) msg += ` (stored, not yet in the books: ${[...notInBooks].map(([k, n]) => `${k} ${n}`).join(', ')})`;
  if (twins) msg += ` · ${twins} ${twins === 1 ? 'record' : 'records'} with no id identical to another (each kept, numbered #2, #3, ...)`;
  if (replaced) msg += ` · ${replaced} stored without an id now came with one (the copy without the id removed)`;
  // Warnings also go on the step, so the page shows them (ebayStatus().notes) on an ok sync too
  const warnings = [
    ...[...unknown].map((t) => `unknown Finances type ${t}`),
    ...[...unknownFee].map((fee) => `unknown fee type ${fee}`),
    ...[...noIdInBooks].map(([t, n]) => `${n} ${t} ${n === 1 ? 'record' : 'records'} without transactionId`),
  ];
  for (const w of warnings) msg += ` · WARNING ${w}`;
  log.push(msg);
  return { stored, orders: touched.size, orderless, warnings };
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
  const seen = new Set();
  // 1. Returns opened in the window (a search failure fails the step: it is reported, never read as "no returns")
  while (pageNo < 50) {
    const url = `${API}/post-order/v2/return/search?creation_date_range_from=${encodeURIComponent(
      from.toISOString()
    )}&limit=200&offset=${pageNo}`;
    const body = await ebayGet(url, { iaf: true });
    const members = body.members || [];
    for (const r of members) {
      await upsertReturn(r);
      seen.add(String(r.returnId));
      n++;
    }
    const total = body.total || 0;
    if (members.length < 200 || pageNo * 200 >= total) break;
    pageNo++;
  }
  // The search worked, so the window moves on now. The recheck below picks returns by their stored state, not by this
  // window, so a recheck problem never needs the window held back (holding it back made it grow on every sync).
  await setSetting('ebay_last_return_sync', startedAt);
  // 2. Every stored return that isn't CLOSED yet, fetched by id however old it is. The search only looks back 30 days
  // from the last sync, so a case still open on day 30 would otherwise stay "Return open" forever.
  //   - eBay answers 403/404/410 (it no longer serves that return): a warning, not a failure. The return stays as
  //     stored, the error is kept on it (recheck_error, recheck_failed_at) and it's tried again next sync.
  //   - Anything else (429, 5xx, network) fails the step, until that return has failed for RECHECK_WARN_DAYS: then it's
  //     a warning too, so one bad return can't keep every sync 'partial' for good.
  const open = await q(
    `select return_id, state, recheck_failed_at from ebay_returns
     where coalesce(state, '') !~* 'CLOSED' and return_id not like 'DEMO-%' order by created_at`);
  let refreshed = 0;
  const failed = [];
  const warnings = [];
  for (const { return_id, state, recheck_failed_at } of open) {
    if (seen.has(return_id)) continue;
    try {
      const body = await ebayGet(`${API}/post-order/v2/return/${encodeURIComponent(return_id)}`, { iaf: true });
      const r = body.summary || body; // getReturn answers { summary, detail }; the summary has the search's fields
      if (String(r.returnId ?? '') !== return_id) throw new Error('eBay answered without this return');
      await upsertReturn(r);
      refreshed++;
    } catch (e) {
      await q('update ebay_returns set recheck_error = $2, recheck_failed_at = coalesce(recheck_failed_at, now()) where return_id = $1',
        [return_id, e.message.slice(0, 300)]);
      const gone = [403, 404, 410].includes(e.status);
      const days = recheck_failed_at ? (Date.now() - new Date(recheck_failed_at).getTime()) / 86400_000 : 0;
      if (gone) warnings.push(`return ${return_id} not found on eBay (${e.status}); left as ${state || 'open'}`);
      else if (days >= RECHECK_WARN_DAYS) warnings.push(`return ${return_id} could not be rechecked for ${Math.floor(days)} days (${e.message.slice(0, 120)}); left as ${state || 'open'}`);
      else failed.push(`${return_id}: ${e.message}`);
    }
  }
  log.push(`returns: ${n} in the last window, ${refreshed} open ${refreshed === 1 ? 'return' : 'returns'} rechecked`);
  for (const w of warnings) log.push(`returns: WARNING ${w}`);
  if (failed.length) {
    const err = new Error(`could not recheck ${failed.length} open ${failed.length === 1 ? 'return' : 'returns'} (${failed.join('; ').slice(0, 300)})`);
    err.count = n; // the search's returns were stored all the same
    err.warnings = warnings;
    throw err;
  }
  return { count: n, warnings };
}
// How long a return's recheck may keep failing with a temporary error (429, 5xx, network) before it stops failing the
// returns step and becomes a warning
const RECHECK_WARN_DAYS = Number(process.env.EBAY_RECHECK_WARN_DAYS || 3);

// A return as stored, from a search member or getReturn's summary (same fields). A refresh that leaves out the state
// keeps the one already stored rather than reopening the return; one that leaves out the refund amount keeps the stored
// amount (null, never 0, when eBay never gave one: the books then use the sale's revenue for the open-return flag).
// Fetching it at all clears any earlier recheck error.
export async function upsertReturn(r) {
  await ensureEbaySchema();
  const b = r.buyerTotalRefund || {};
  const refund = b.actualRefundAmount?.value !== undefined || b.estimatedRefundAmount?.value !== undefined
    ? money(b.actualRefundAmount) || money(b.estimatedRefundAmount)
    : null;
  await q(
    `insert into ebay_returns (return_id, order_id, item_id, state, status, reason, return_type, created_at, refund_amount, raw, synced_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb, now())
     on conflict (return_id) do update set state = coalesce(excluded.state, ebay_returns.state),
       status = coalesce(excluded.status, ebay_returns.status), return_type = coalesce(excluded.return_type, ebay_returns.return_type),
       order_id = coalesce(ebay_returns.order_id, excluded.order_id),
       refund_amount = coalesce(excluded.refund_amount, ebay_returns.refund_amount), raw = excluded.raw, synced_at = now(),
       recheck_error = null, recheck_failed_at = null`,
    [
      String(r.returnId), r.orderId || null, r.creationInfo?.item?.itemId || null, r.state || null,
      r.status || null, r.creationInfo?.reason || r.creationInfo?.reasonType || null, r.currentType || null,
      r.creationInfo?.creationDate?.value || null, refund, JSON.stringify(r),
    ]
  );
}

export async function syncEbay() {
  if (S().running) return S().running;
  const run = (async () => {
    await ensureEbaySchema();
    const [{ id }] = await q('insert into sync_log (started_at) values (now()) returning id');
    const log = [];
    // Each money step is run on its own: one failing never stops the others, but it is recorded and makes the sync
    // not ok (status 'partial', or 'failed' when the orders themselves didn't come in). A step can also come back ok
    // with warnings (a return eBay no longer serves): kept on the step, they don't make the sync not ok.
    const steps = {};
    const step = async (name, fn) => {
      const at = new Date().toISOString();
      try {
        const r = await fn();
        steps[name] = r?.skipped
          ? { ok: false, status: 'skipped', at, message: r.skipped }
          : { ok: true, status: 'ok', at, message: null };
        if (r?.warnings?.length) steps[name].warnings = r.warnings;
        return r;
      } catch (e) {
        steps[name] = { ok: false, status: 'failed', at, message: e.message };
        if (e.warnings?.length) steps[name].warnings = e.warnings;
        log.push(`${name}: FAILED (${e.message})`);
        return e.count !== undefined ? { count: e.count } : null; // what the step did store before it failed
      }
    };
    const save = async (status, orders, returns) => {
      const bad = STEPS.filter((s) => steps[s] && !steps[s].ok).map((s) => `${s} ${steps[s].status}`);
      const message = (bad.length ? [`${status}: ${bad.join(', ')}`, ...log] : log).join(' · ');
      await q(`update sync_log set finished_at = now(), ok = $2, status = $3, steps = $4::jsonb, message = $5, orders = $6, returns = $7
               where id = $1`, [id, status === 'ok', status, JSON.stringify(steps), message, orders, returns]);
    };
    try {
      const orders = (await step('orders', () => syncOrders(log))) || 0;
      await syncTracking(log).catch((e) => log.push(`tracking: ${e.message}`));
      await step('finances', () => syncFinances(log));
      const returns = (await step('returns', () => syncReturns(log)))?.count || 0;
      const m = await runMatcher();
      log.push(`matcher: ${m.linked} new links`);
      log.push(`ledger: ${await matchLedger()} sheet rows matched to eBay orders`);
      const lastListings = await getSetting('listings_last_sync');
      if (!lastListings?.at || Date.now() - new Date(lastListings.at).getTime() > LISTINGS_EVERY_MS) await syncListings({ log }); // never throws
      const status = !steps.orders.ok ? 'failed' : STEPS.every((s) => steps[s].ok) ? 'ok' : 'partial';
      await save(status, orders, returns);
      return { ok: status === 'ok', status, steps, log };
    } catch (e) {
      log.push(e.message);
      await save('failed', 0, 0);
      return { ok: false, status: 'failed', steps, log };
    }
  })();
  S().running = run;
  // Cleared however the run ends, also when the schema check or the log row itself fails (before the try above)
  const st = S(); // captured: the run may settle outside this account's context
  const clear = () => { if (st.running === run) st.running = null; };
  run.then(clear, clear);
  return run;
}

const STEPS = ['orders', 'finances', 'returns'];
const STEP_LAST_OK = { orders: 'ebay_last_order_sync', finances: 'ebay_last_finance_sync', returns: 'ebay_last_return_sync' };
const STEP_LABEL = { orders: 'orders', finances: 'Finances (fees, ad fees, refunds)', returns: 'returns' };

// Sync status for the page. Besides the last run, it gives each step's own result and freshness:
//   status       'ok' | 'partial' (a step failed or was skipped) | 'failed' | 'running' (null before the first sync)
//   steps        { orders, finances, returns }: { ok, status: 'ok'|'failed'|'skipped'|'unknown', at, message,
//                lastOk (when that step last fully succeeded), stale (no success in EBAY_STEP_STALE_HOURS, default 3) }
//   financesFailed / financesStale / returnsFailed / returnsStale   the same, flattened for banners
//   warnings     plain sentences naming every step that failed, was skipped or is stale (for a banner and the
//                Settle warning: a payment worked out while Finances is stale can miss ad fees and refunds)
//   notes        smaller things from steps that still worked (a return eBay no longer serves, left as stored); not
//                a reason for a red banner or to hold a payment
export async function ebayStatus() {
  const last = await one('select * from sync_log order by id desc limit 1');
  const lastOk = await one('select finished_at from sync_log where ok order by id desc limit 1');
  const lastDone = await one('select * from sync_log where finished_at is not null order by id desc limit 1');
  const configured = ebayConfigured();
  const now = Date.now();
  const steps = {};
  const warnings = [];
  const notes = [];
  for (const name of STEPS) {
    const s = lastDone?.steps?.[name] || null; // runs from before per-step tracking have none
    const lastStepOk = await getSetting(STEP_LAST_OK[name]);
    const stale = configured && (!lastStepOk || now - new Date(lastStepOk).getTime() > STEP_STALE_MS);
    steps[name] = {
      ok: s ? s.ok : null, status: s?.status || 'unknown', at: s?.at || null, message: s?.message || null,
      warnings: s?.warnings || [], lastOk: lastStepOk || null, stale,
    };
    for (const w of s?.warnings || []) notes.push(`eBay ${STEP_LABEL[name]}: ${w}.`);
    if (!configured) continue;
    const since = lastStepOk ? `last synced ${new Date(lastStepOk).toISOString()}` : 'never synced';
    if (s && !s.ok) warnings.push(`eBay ${STEP_LABEL[name]} ${s.status} on the last sync (${s.message || 'no reason given'}); ${since}.`);
    else if (stale) warnings.push(`eBay ${STEP_LABEL[name]} ${since}.`);
  }
  const status = !last ? null : !last.finished_at ? 'running' : last.status || (last.ok ? 'ok' : 'failed');
  return {
    configured,
    missing: ebayMissing(),
    canConnect: ebayCanConnect(),
    runameSet: Boolean(process.env.EBAY_RUNAME),
    connectedAt: S().connection?.connected_at || null,
    refreshExpiresAt: S().connection?.refresh_expires_at || null,
    source: S().connection?.refresh_token ? 'connected' : currentAccount() === MAIN && process.env.EBAY_REFRESH_TOKEN ? 'env' : null,
    // Only eBay saying the refresh token itself is bad means reconnect; a refresh that failed because eBay's sign-in
    // was down (5xx, network) clears up on its own
    needsReconnect: /invalid_grant|refresh token is invalid/i.test(last?.message || '') && !last?.ok,
    running: Boolean(S().running),
    scopes: S().tokenCache.scopes,
    last,
    lastSuccess: lastOk?.finished_at || null,
    status,
    partial: (lastDone?.status || null) === 'partial',
    steps,
    financesFailed: configured && steps.finances.ok === false,
    financesStale: steps.finances.stale,
    returnsFailed: configured && steps.returns.ok === false,
    returnsStale: steps.returns.stale,
    warnings,
    notes,
  };
}
