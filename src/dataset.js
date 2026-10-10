// Builds the per-order profit dataset the dashboard renders. All money math lives here so the
// dashboard, the editor and CSV exports always agree. Every row carries `business_month` (Arizona
// time, decided here) and settlement groups by that field, so every viewer sees the same numbers.
import { q, num, getSetting } from './db.js';
import { businessMonth, businessDay } from './time.js';
import { sheetTitleMatch } from './ledger.js';
import { loadUnlinkedAmazon, scorePair } from './matcher.js';
import { settlePeriodOf, CYCLE_START } from '../public/js/settlement.js';

const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const iso = (d) => (d instanceof Date ? d.toISOString() : d);
const isoDate = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);

// A row's money in the settlement's terms, in cents (what a closed payment records for each row it covered)
export const rowCents = (r) => {
  const c = (n) => Math.round((Number(n) || 0) * 100);
  return { collected: c(r.revenue) - c(r.fees) - c(r.refunds), cogs: c(r.cost) - c(r.amazon_refund), ad: c(r.ad_fees), other: c(r.extra_cost) };
};
// A correction line: money moved between payments (never a sale)
function adjustmentRow(id, month, d, title, base, hold) {
  const v = (x) => Math.round(x) / 100;
  const at = base?.created_at || `${month}-26T19:00:00.000Z`;
  return {
    order_id: id, adjustment: true, hold, settle_month: month, settle_target: month, created_at: at, business_month: month,
    title, source: 'adjustment', status: 'adjustment', counted: true, has_cost: true, cost_source: 'adjustment',
    items: [], units: 0, item_subtotal: 0, shipping_charged: 0, discount: 0, tax_collected: 0,
    revenue: v(d.collected), fees: 0, raw_fees: 0, fee_credit: 0, refunds: 0, raw_refunds: 0, ad_fees: v(d.ad),
    amazon_cost: v(d.cogs), amazon_cost_unknown: false, cost: v(d.cogs), amazon_refund: 0, email_refund: 0, extra_cost: v(d.other),
    net: v(d.collected - d.cogs - d.ad - d.other), margin: null, roi: null, ledger: null, cancelled: false, in_sheet: false,
    before_start: false, possible_sheet_duplicate: false, excluded: false, lag_days: null, amazon_orders: [], returns: [], tracking_numbers: [],
    adjustment_of: base?.order_id || null,
    overrides: { cost_override: null, extra_cost: null, amazon_refund: null, fee_override: null, refund_override: null, notes: '', excluded: false },
  };
}

// Days after a sale with no Amazon order found before it counts as not a dropship sale
const NOT_DROPSHIP_AFTER_DAYS = 10;

// { sheets: false } builds from live eBay/Amazon data only, ignoring uploaded sheets (to check the live numbers
// against a sheet kept by hand)
export async function buildDataset({ sheets = true } = {}) {
  const [orders, lines, returns, links, overrides, amazonLines, azRefunds, allLedger, refundTx, adCreditTx, allAzIds, paidRows, freezeRows, otherTx, holdTx, failedEmails, orderlessTx] = await Promise.all([
    q(`select order_id, created_at, buyer_username, ship_name, ship_city, ship_state, ship_zip, ship_country,
              fulfillment_status, payment_status, cancel_state, item_subtotal, shipping_charged, discount,
              tax_collected, revenue, ebay_fees, fee_credit, ad_fees, refund_total, tracking_numbers
       from ebay_orders order by created_at desc`),
    q('select * from ebay_line_items'),
    q('select return_id, order_id, item_id, state, status, reason, return_type, created_at, refund_amount from ebay_returns'),
    q('select * from order_links'),
    q('select * from order_overrides'),
    q(`select l.line_key, l.amazon_order_id, l.order_date, l.asin, l.title, l.quantity, l.line_total, l.tax, l.shipping,
              l.order_status, l.tracking, l.cost_override, l.ignored, l.ship_name, l.ship_zip, l.source
       from amazon_lines l join order_links k on k.amazon_order_id = l.amazon_order_id`),
    q('select amazon_order_id, amount, received_at, title from amazon_refunds'),
    q('select * from ledger_entries order by month, row_no'),
    q("select order_id, amount, fee_amount, transaction_at from ebay_transactions where type = 'REFUND'"),
    q("select order_id, amount, transaction_at from ebay_transactions where type = 'NON_SALE_CHARGE' and fee_type = 'AD_FEE' and booking_entry = 'CREDIT'"),
    q('select distinct amazon_order_id from amazon_lines'),
    q('select month, paid, paid_at from settlements where paid is not null'),
    q('select month, row_keys, row_values, totals from settlement_freeze'),
    // eBay money on an order other than the sale, refunds and ad fees: return shipping labels and other fees
    q("select order_id, type, fee_type, booking_entry, amount, transaction_at from ebay_transactions where order_id is not null and (type = 'SHIPPING_LABEL' or (type = 'NON_SALE_CHARGE' and coalesce(fee_type, '') <> 'AD_FEE'))"),
    // Return/case holds and their releases, to spot a hold that was never released (a lost case)
    q("select order_id, type, booking_entry, amount, transaction_at, transaction_id from ebay_transactions where type in ('DISPUTE', 'CREDIT')"),
    // Amazon emails that couldn't be read: a sale near one may still have its purchase in it
    q('select received_at from amazon_emails where ok = false').catch(() => []),
    // eBay charges and credits that belong to no order (store fees, adjustments): listed for review, not guessed into a sale
    q('select type, fee_type, booking_entry, amount, transaction_at, transaction_id from ebay_transactions where order_id is null'),
  ]);

  const ledger = sheets ? allLedger : [];
  const group = (rows, key) => {
    const m = new Map();
    for (const r of rows) {
      const k = r[key];
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return m;
  };
  const linesBy = group(lines, 'order_id');
  const returnsBy = group(returns, 'order_id');
  const linksBy = group(links, 'ebay_order_id');
  const azBy = group(amazonLines, 'amazon_order_id');
  const azRefundsBy = group(azRefunds, 'amazon_order_id');
  const refundTxBy = group(refundTx, 'order_id');
  const adCreditBy = group(adCreditTx, 'order_id'); // ad fees eBay gave back (e.g. when a sale is refunded)
  const otherBy = group(otherTx, 'order_id'); // return labels and other eBay charges on an order
  // An Amazon email that couldn't be read, from the day before a sale to 12 days after: its purchase may be in it, so
  // the sale waits for its cost instead of being written off as not a dropship sale
  const failedAt = failedEmails.map((r) => new Date(r.received_at).getTime()).filter(Number.isFinite);
  const unreadEmailNear = (at) => { const t = new Date(at).getTime(); return failedAt.some((x) => x >= t - 86400_000 && x <= t + 12 * 86400_000); };
  const ovBy = new Map(overrides.map((o) => [o.order_id, o]));
  const ledgerByEbay = new Map(ledger.filter((l) => l.ebay_order_id && !l.is_refund).map((l) => [l.ebay_order_id, l]));
  const returnOpenBy = new Map(); // eBay order id -> its open return (also shown on the order's sheet row)
  const refundRowByEbay = new Map(ledger.filter((l) => l.ebay_order_id && l.is_refund).map((l) => [l.ebay_order_id, l]));
  const ebayById = new Map(orders.map((o) => [o.order_id, o]));

  // A month with an uploaded settlement sheet is settled by the sheet: its rows are the source of truth for
  // profit and settlement (so the dashboard equals the sheet to the cent). Real eBay orders matched to a sheet
  // row stay visible but aren't counted again; the sheet row takes their real date.
  const sheetMonths = new Set(ledger.map((l) => l.month));
  // Sales before the partnership started (default: the first sheet month) are not part of this business
  // Refunds are grouped by pay cycle (26th-to-26th from Sep 2026), so a refund after a payment's cutoff lands in
  // the next payment and never changes one already settled
  const dueDay = Number(await getSetting('settlement_day')) || 26;
  const cycleOf = (at) => settlePeriodOf(businessDay(at), dueDay);
  // Payments already made (a payment is recorded): a later refund on an old sale skips them for the next one
  // A payment counts only when a real amount was recorded (a blank, 0 or NaN entry is not a payment)
  const paid = paidRows.filter((r) => Number.isFinite(Number(r.paid)) && Math.abs(Number(r.paid)) >= 0.005);
  const paidCycles = new Set(paid.map((r) => r.month));
  const paidOn = new Map(paid.filter((r) => r.paid_at).map((r) => [r.month, String(r.paid_at).slice(0, 10)]));
  // Closed payments: what each covered when it was paid (settlement_freeze). Those rows stay on it; anything new goes
  // on the next open payment. Months paid before closing existed (none today) fall back to the paid-month rule.
  const frozen = new Map(freezeRows.map((r) => [r.month, new Set(Array.isArray(r.row_keys) ? r.row_keys : JSON.parse(r.row_keys || '[]'))]));
  const closedFor = (c, key) => (frozen.has(c) ? !frozen.get(c).has(key) : paidCycles.has(c) && c <= CYCLE_START);
  const nextCycle = (m) => { const [y, mo] = m.split('-').map(Number); return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`; };
  // The payment a refund goes on: the one for its day, unless it came after that payment was made (Drew paid early)
  const refundCycleOf = (at) => { let c = cycleOf(at); const d = businessDay(at); while (paidOn.get(c) && d > paidOn.get(c)) c = nextCycle(c); return c; };
  const startMonth = (await getSetting('business_start')) || [...new Set(allLedger.map((l) => l.month))].sort()[0] || null;
  // Unpaired sheet sale rows per month, used to flag eBay sales that are probably a reworded sheet row
  const unpairedSheetRows = group(ledger.filter((l) => !l.ebay_order_id && !l.is_refund), 'month');

  // Amazon refunds for purchases this inbox never saw (bought before its Amazon emails began) are matched to the one
  // sale whose known Amazon cost (sheet or entered cost) equals the refund to the cent, sold within 120 days before
  // it, whose title fits the item the refund email names. No single fit: listed for review, never guessed.
  const knownAz = new Set(allAzIds.map((r) => r.amazon_order_id));
  const orphanRefundsBy = new Map(); // eBay order id -> Amazon refunds matched to it
  const unmatchedRefunds = [];
  const words = (t) => new Set(String(t || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []);
  for (const r of azRefunds.filter((x) => !knownAz.has(x.amazon_order_id))) {
    const amount = num(r.amount) || 0;
    const at = new Date(r.received_at || 0).getTime();
    const named = words(r.title);
    const fits = orders.filter((o) => {
      const t = new Date(o.created_at).getTime();
      if (!(t < at && at - t <= 120 * 86400_000)) return false;
      const cost = num(ovBy.get(o.order_id)?.cost_override) ?? num(ledgerByEbay.get(o.order_id)?.amazon_cost);
      if (cost === null) return false;
      // No item name in the email: the refund must equal the cost to the cent
      if (!named.size) return Math.abs(cost - amount) <= 0.005;
      // The email names the item: the name must fit, and the refund can be less than the cost (Amazon often keeps a
      // little, e.g. HHLPRO: $107.89 paid, $104.79 back) but never more
      const own = words((linesBy.get(o.order_id) || [])[0]?.title || ledgerByEbay.get(o.order_id)?.title);
      return amount <= cost + 0.005 && [...named].filter((w) => own.has(w)).length >= Math.min(2, named.size);
    });
    if (fits.length === 1) {
      if (!orphanRefundsBy.has(fits[0].order_id)) orphanRefundsBy.set(fits[0].order_id, []);
      orphanRefundsBy.get(fits[0].order_id).push(r);
    } else unmatchedRefunds.push({ amazon_order_id: r.amazon_order_id, amount, received_at: iso(r.received_at), title: r.title || null, candidates: fits.map((o) => o.order_id) });
  }

  // Unlinked Amazon orders: a refunded sale is only assumed to have had no purchase if none of these could be its purchase
  const unlinkedAmazon = await loadUnlinkedAmazon();
  const out = [];
  const events = []; // refunds / Amazon refunds booked in a later month than the sale

  for (const o of orders) {
    const ov = ovBy.get(o.order_id) || {};
    const saleMonth = businessMonth(o.created_at);
    const saleCycle = cycleOf(o.created_at); // the payment this sale settles in
    const items = (linesBy.get(o.order_id) || []).map((li) => ({
      title: li.title,
      sku: li.sku,
      item_id: li.legacy_item_id,
      quantity: li.quantity,
      unit_price: num(li.unit_price),
      line_total: num(li.line_total),
    }));
    const title = items[0]?.title || '(no title)';
    let amazonCostUnknown = false;
    const amazonOrders = (linksBy.get(o.order_id) || []).map((lk) => {
      const azLines = (azBy.get(lk.amazon_order_id) || []).map((l) => {
        const cancelledLine = /cancel/i.test(l.order_status || '');
        // A $0.00 / missing Grand Total (e.g. paid with gift card balance) is an UNKNOWN cost, never $0
        const unknown = !l.ignored && !cancelledLine && num(l.cost_override) === null && num(l.line_total) === null;
        if (unknown) amazonCostUnknown = true;
        const cost = l.ignored || cancelledLine || unknown ? 0 : num(l.cost_override) ?? num(l.line_total) ?? 0;
        return {
          line_key: l.line_key, asin: l.asin, title: l.title, quantity: l.quantity,
          line_total: num(l.line_total), cost_override: num(l.cost_override), ignored: l.ignored,
          status: l.order_status, tracking: l.tracking, source: l.source, cost_unknown: unknown, cost,
        };
      });
      return {
        amazon_order_id: lk.amazon_order_id, method: lk.method, score: num(lk.score), reasons: lk.reasons,
        order_date: isoDate((azBy.get(lk.amazon_order_id) || [])[0]?.order_date),
        lines: azLines,
        cost: r2(azLines.reduce((s, l) => s + l.cost, 0)),
      };
    });
    const rets = (returnsBy.get(o.order_id) || []).map((r) => ({ ...r, created_at: iso(r.created_at), refund_amount: num(r.refund_amount) }));
    // A return that's still open with no refund issued yet: eBay holds the money, but nothing has been lost, so the sale
    // keeps counting where it was settled. It's flagged with what a refund would take off: eBay gives its fees back
    // except the $0.40 per-order fee, so the profit drops by the refund minus that fee credit.
    const openRet = rets.find((r) => !/CLOSED|REFUND/i.test(r.state || ''));
    const refundedSince = openRet && (refundTxBy.get(o.order_id) || []).some((t) => new Date(t.transaction_at) >= new Date(openRet.created_at));
    if (openRet && !refundedSince && !(num(o.refund_total) > 0)) {
      const amount = openRet.refund_amount ?? (num(o.revenue) || 0);
      returnOpenBy.set(o.order_id, {
        return_id: openRet.return_id, since: openRet.created_at, state: openRet.state, reason: openRet.reason, amount,
        profit_hit: r2(amount - Math.max(0, (num(o.ebay_fees) || 0) - 0.4)),
      });
    }

    const cancelled = /CANCELED|CANCELLED/i.test(o.cancel_state || '') && !/NONE_REQUESTED|IN_PROGRESS/i.test(o.cancel_state || '');
    const amazonCost = r2(amazonOrders.reduce((s, a) => s + a.cost, 0));
    const led = ledgerByEbay.get(o.order_id);
    const inSheetMonth = sheetMonths.has(saleMonth);
    const beforeStart = Boolean(startMonth) && saleMonth < startMonth;
    if (beforeStart) continue; // sold before the business started: not part of these books at all
    const inSheet = Boolean(led) || refundRowByEbay.has(o.order_id);
    const rawRevenue = num(o.revenue) || 0;
    const rawFees = num(o.ebay_fees) || 0;

    // ---- refunds, booked in the pay cycle they happened (eBay Finances REFUND records carry the date and
    // the fee eBay credits back). Without Finances records, the order-level refund total is used.
    const txs = refundTxBy.get(o.order_id) || [];
    const hasTx = txs.length > 0;
    const byMonth = new Map(); // pay cycle -> { refund, credit, amazonRefund, last }
    const bump = (m, k, v, at) => {
      if (!byMonth.has(m)) byMonth.set(m, { refund: 0, credit: 0, amazonRefund: 0, adCredit: 0, otherCharge: 0, last: at });
      const e = byMonth.get(m);
      e[k] += v;
      if (at && (!e.last || new Date(at) > new Date(e.last))) e.last = at;
    };
    for (const t of txs) {
      const at = t.transaction_at || o.created_at;
      // eBay's REFUND amount is what it took from the seller, already net of the fees it gave back. The buyer's whole
      // refund is that plus the fees; the fees then come back as the credit, so the money lost is exactly eBay's amount.
      bump(refundCycleOf(at), 'refund', (num(t.amount) || 0) + (num(t.fee_amount) || 0), iso(at));
      bump(refundCycleOf(at), 'credit', num(t.fee_amount) || 0, iso(at));
    }
    for (const a of amazonOrders) {
      // A cancelled purchase already costs $0: its refund email is the same money, not extra
      if (a.lines.length && a.lines.every((l) => /cancel/i.test(l.status || ''))) continue;
      let left = a.lines.filter((l) => !l.ignored && !/cancel/i.test(l.status || '')).reduce((t, l) => t + (num(l.line_total) || 0) + (num(l.tax) || 0), 0) || Infinity;
      for (const r of [...(azRefundsBy.get(a.amazon_order_id) || [])].sort((x, y) => new Date(x.received_at) - new Date(y.received_at))) {
        const at = r.received_at || o.created_at;
        const amt = Math.min(num(r.amount) || 0, Math.max(0, left)); // never more back than the order cost
        left -= amt;
        if (amt > 0) bump(refundCycleOf(at), 'amazonRefund', amt, iso(at));
      }
    }
    for (const r of orphanRefundsBy.get(o.order_id) || []) {
      const at = r.received_at || o.created_at;
      bump(refundCycleOf(at), 'amazonRefund', num(r.amount) || 0, iso(at));
    }
    // An ad fee eBay gives back is money in on the payment for that day, like a refund (never a change to a paid one)
    const adCredits = adCreditBy.get(o.order_id) || [];
    for (const c of adCredits) { const at = c.transaction_at || o.created_at; bump(refundCycleOf(at), 'adCredit', num(c.amount) || 0, iso(at)); }
    // Return labels and other eBay charges on the order: money Drew paid, booked on the payment for that day
    for (const t of otherBy.get(o.order_id) || []) { const at = t.transaction_at || o.created_at; bump(refundCycleOf(at), 'otherCharge', (t.booking_entry === 'CREDIT' ? -1 : 1) * (num(t.amount) || 0), iso(at)); }
    const same = byMonth.get(saleCycle) || { refund: 0, credit: 0, amazonRefund: 0, adCredit: 0, otherCharge: 0 };
    const totalTxRefund = txs.reduce((s, t) => s + (num(t.amount) || 0) + (num(t.fee_amount) || 0), 0); // the buyer's whole refund
    const lastRefundAt = txs.map((t) => t.transaction_at).filter(Boolean).map(iso).sort().at(-1) || rets.map((r) => r.created_at).filter(Boolean).sort().at(-1) || null;
    const totalRefund = hasTx ? totalTxRefund : num(o.refund_total) || 0;

    // Refunded on eBay and nothing bought on Amazon: no Amazon cost was ever incurred. Months covered by a
    // sheet already decided every sale, so this rule only applies outside sheet months.
    const mostlyRefunded = !cancelled && rawRevenue > 0 && totalRefund >= 0.8 * rawRevenue;
    const couldHavePurchase = () => unlinkedAmazon.some((az) => scorePair(az, {
      created_at: o.created_at, ship_name: o.ship_name, ship_city: o.ship_city, ship_state: o.ship_state, ship_zip: o.ship_zip,
      tracking_numbers: o.tracking_numbers || [], titles: items.map((i) => i.title).filter(Boolean), revenue: rawRevenue,
    })?.evidence);
    const refundedNoPurchase = mostlyRefunded && !inSheetMonth && !amazonOrders.length && num(ov.cost_override) === null && !led && !couldHavePurchase();

    // A multi-unit sale bought as several Amazon orders isn't costed until the linked Amazon quantity covers it
    const ebayUnits = items.reduce((s, i) => s + (i.quantity || 0), 0) || 1;
    const linkedUnits = amazonOrders.reduce((s, a) => s + a.lines.filter((l) => !l.ignored && !/cancel/i.test(l.status || '')).reduce((t, l) => t + (l.quantity || 1), 0), 0);
    const amazonCostPartial = amazonOrders.length > 0 && linkedUnits < ebayUnits;
    const costSource = num(ov.cost_override) !== null ? 'override'
      : amazonOrders.length && !amazonCostUnknown && !amazonCostPartial ? 'amazon'
      : led ? 'ledger'
      : refundedNoPurchase ? 'refunded'
      : null;
    const hasCost = costSource !== null;
    const cost = num(ov.cost_override) ?? (amazonOrders.length ? amazonCost : led ? num(led.amazon_cost) : 0);
    const revenue = cancelled ? 0 : rawRevenue;
    // Order-level refunds: with an override, everything sits on the order; otherwise only same-month refunds
    const refundOverride = num(ov.refund_override);
    // A counted sale shows the refunds in its own payment (later ones are their own lines). A sale the sheet covers
    // is never counted, so its row shows everything that happened to it, refunds booked elsewhere included.
    const all = [...byMonth.values()].reduce((t, e) => ({ refund: t.refund + e.refund, credit: t.credit + e.credit, otherCharge: t.otherCharge + e.otherCharge }), { refund: 0, credit: 0, otherCharge: 0 });
    const shown = inSheet ? all : same;
    const refunds = cancelled ? 0 : refundOverride ?? (hasTx ? r2(shown.refund) : num(o.refund_total) || 0);
    // A typed refund override is the buyer's whole refund: eBay's fee credit on it still comes back
    let fees = cancelled ? 0 : num(ov.fee_override) ?? r2(rawFees - (hasTx ? (refundOverride === null ? shown.credit : all.credit) : 0) + (shown.otherCharge || 0));
    // Without Finances records we can't see eBay's fee credit; for a refund with no purchase assume only the
    // fixed $0.40 per-order fee was kept (what eBay does on a full refund)
    if (!cancelled && refundedNoPurchase && !hasTx && num(ov.fee_override) === null) fees = Math.min(fees, 0.4);
    fees = Math.max(0, fees);
    // ebay_orders.ad_fees is charges minus credits; the sale's row keeps the charges minus only the credits on its own
    // payment (later credits are their own lines)
    const adGross = (num(o.ad_fees) || 0) + adCredits.reduce((t, c) => t + (num(c.amount) || 0), 0);
    const adFees = cancelled ? 0 : inSheet ? num(o.ad_fees) || 0 : r2(adGross - (same.adCredit || 0)); // sheet-covered rows: everything
    const emailRefundSame = r2(same.amazonRefund);
    const emailRefundAll = r2([...byMonth.values()].reduce((s, e) => s + e.amazonRefund, 0));
    const amazonRefund = num(ov.amazon_refund) ?? emailRefundSame;
    const extra = num(ov.extra_cost) || 0;
    const net = r2(revenue - fees - adFees - cost - refunds + amazonRefund - extra);

    // An eBay sale in a sheet month that looks like a sheet row the matcher couldn't pair (reworded title,
    // multi-quantity...) is flagged instead of counted, so a sale can never be counted twice
    const possibleSheetDup = !inSheet && inSheetMonth && (unpairedSheetRows.get(saleMonth) || [])
      .some((l) => sheetTitleMatch(l.title, title) >= 0.34 && sheetTitleMatch(l.title, title) * new Set(l.title.toLowerCase().split(/\s+/)).size >= 2);

    // No Amazon purchase behind it = not a dropship sale (something else sold on the account). It drops out of the
    // books only once the matching window has passed with no Amazon order found. Until then it waits for its Amazon
    // purchase, even in a month that has a sheet (the sheet is a snapshot; sales keep coming after it was made).
    // A linked Amazon order, a sheet row, a typed-in cost, or an unlinked Amazon order that could be its purchase keeps it.
    const pastMatchWindow = Date.now() - new Date(o.created_at).getTime() > NOT_DROPSHIP_AFTER_DAYS * 86400_000;
    // Shipped by Amazon (Amazon Logistics tracking AQUAA… / TBA…) means it was bought on Amazon, even when the purchase
    // email never reached the inbox (everything before Sep 22): it waits for its cost instead of dropping out.
    const amazonShipped = (o.tracking_numbers || []).some((t) => /^(AQUAA|TBA)/i.test(String(t)));
    const notDropship = !hasCost && !cancelled && !amazonOrders.length && !led && num(ov.cost_override) === null &&
      pastMatchWindow && !possibleSheetDup && !couldHavePurchase() && !amazonShipped && !unreadEmailNear(o.created_at);

    const firstAz = amazonOrders.map((a) => a.order_date).filter(Boolean).sort()[0];
    const lagDays = firstAz
      ? Math.round((new Date(`${firstAz}T12:00:00Z`) - new Date(`${businessDay(o.created_at)}T12:00:00Z`)) / 86400_000)
      : null;
    const units = items.reduce((s, i) => s + (i.quantity || 0), 0) || 1;

    let status = 'profitable';
    if (beforeStart) status = 'before_start';
    else if (inSheet) status = 'in_sheet';
    else if (ov.excluded) status = 'excluded';
    // Stays flagged until someone links it to its sheet row or confirms it is a separate sale
    else if (possibleSheetDup && !ov.confirmed_separate) status = 'check_sheet';
    else if (cancelled) status = hasCost && cost > 0 ? 'cancelled_after_purchase' : 'cancelled';
    else if (notDropship) status = 'not_dropship';
    else if (!hasCost && mostlyRefunded && inSheetMonth) status = 'returned'; // refunded, and the sheet left it out
    else if (!hasCost) status = 'awaiting_cost';
    else if (returnOpenBy.has(o.order_id)) status = 'return_open'; // still counted; flagged until the return settles
    else if (totalRefund > 0 || rets.length) status = 'returned';
    else if (net < 0) status = 'loss';

    const counted = !inSheet && !beforeStart && !ov.excluded && status !== 'check_sheet' && hasCost && !(cancelled && cost === 0);
    out.push({
      order_id: o.order_id,
      created_at: iso(o.created_at),
      business_month: saleMonth,
      buyer: o.buyer_username,
      ship_name: o.ship_name, ship_city: o.ship_city, ship_state: o.ship_state, ship_zip: o.ship_zip,
      fulfillment_status: o.fulfillment_status,
      cancel_state: o.cancel_state,
      title,
      item_id: items[0]?.item_id || null,
      items,
      units,
      item_subtotal: num(o.item_subtotal),
      shipping_charged: num(o.shipping_charged),
      discount: num(o.discount),
      tax_collected: num(o.tax_collected),
      revenue,
      fees,
      raw_fees: rawFees,
      fee_credit: r2(num(o.fee_credit) || 0),
      raw_refunds: r2(totalRefund),
      last_refund_at: totalRefund > 0 ? lastRefundAt : null,
      ad_fees: adFees,
      amazon_cost: amazonCost,
      amazon_cost_unknown: amazonCostUnknown,
      amazon_cost_partial: amazonCostPartial,
      amazon_units_linked: linkedUnits,
      cost,
      refunds,
      amazon_refund: amazonRefund,
      email_refund: emailRefundAll,
      extra_cost: extra,
      net,
      margin: revenue > 0 ? net / revenue : null,
      roi: cost > 0 ? net / cost : null,
      has_cost: hasCost,
      cost_source: costSource,
      source: 'ebay',
      ledger: led ? { entry_key: led.entry_key, month: led.month, title: led.title, sale_price: num(led.sale_price), amazon_cost: num(led.amazon_cost) } : null,
      counted,
      cancelled,
      in_sheet: inSheet,
      before_start: beforeStart,
      possible_sheet_duplicate: possibleSheetDup,
      excluded: inSheet || notDropship || Boolean(ov.excluded),
      status,
      lag_days: lagDays,
      amazon_orders: amazonOrders,
      returns: rets,
      return_open: returnOpenBy.get(o.order_id) || null,
      tracking_numbers: o.tracking_numbers || [],
      overrides: {
        cost_override: num(ov.cost_override),
        extra_cost: num(ov.extra_cost),
        amazon_refund: num(ov.amazon_refund),
        fee_override: num(ov.fee_override),
        refund_override: num(ov.refund_override),
        notes: ov.notes || '',
        excluded: Boolean(ov.excluded),
        confirmed_separate: Boolean(ov.confirmed_separate),
      },
    });

    // ---- later-month refunds become their own rows in the month they happened. For a sale covered by a
    // sheet, refunds inside sheet months are already in the sheet; later ones (after the sheets end) count.
    // A cancelled sale with no purchase has nothing to settle. A cancelled sale whose purchase counts (and a sale with a
    // typed refund) still gets later money that isn't the eBay refund itself: Amazon's refund, ad fees given back.
    if (beforeStart || ov.excluded || (cancelled && !(hasCost && cost > 0))) continue;
    const onlyNonEbay = cancelled || refundOverride !== null;
    if (!inSheet && !counted) continue; // the sale itself isn't in the books yet (e.g. awaiting cost)
    // A refund on a sale from an earlier payment goes on the payment for the day it happened, unless that payment has
    // already been made: then it goes on the next one not yet paid (a paid payment never changes). Refunds of the same
    // sale that land on the same payment (e.g. Amazon's refund and the buyer's) are one line.
    const later = new Map(); // payment month -> { refund, credit, amazonRefund, adCredit, offset, last }
    let offsetUsed = false;
    for (let [m, e] of byMonth) {
      if (m === saleCycle && !inSheet) continue; // refunds in the sale's own pay cycle are on the order row
      if (m < saleCycle) continue;
      // A sheet month's sheet already shows its refunds (through August, and any refund row it has). A refund
      // the sheet doesn't have is booked, so the books don't depend on the sheet being complete.
      // A sheet's refund row covers that sale's refund whatever day eBay dated it, so it's never counted twice.
      // But when the sale was on an EARLIER sheet and the later sheet booked only eBay's $0.40 (Mozi Wash: Aug sale, Sep
      // refund row), the refund must still reverse the sale; the row's own amount is credited back so it isn't counted twice.
      const refundRow = refundRowByEbay.get(o.order_id);
      const saleOnEarlierSheet = Boolean(refundRow && led && led.month < refundRow.month);
      if (inSheet && ((sheetMonths.has(m) && m < CYCLE_START) || (refundRow && !saleOnEarlierSheet))) continue;
      if (onlyNonEbay) e = { ...e, refund: 0, credit: 0 }; // the eBay refund is already on the sale (or there was no sale)
      if (!e.refund && !e.credit && !e.amazonRefund && !e.adCredit && !e.otherCharge) continue;
      let target = m;
      while (closedFor(target, `REFUND:${o.order_id}:${target}`)) target = nextCycle(target);
      const t = later.get(target) || { refund: 0, credit: 0, amazonRefund: 0, adCredit: 0, otherCharge: 0, offset: 0, last: null };
      t.refund += e.refund; t.credit += e.credit; t.amazonRefund += e.amazonRefund; t.adCredit += e.adCredit; t.otherCharge += e.otherCharge;
      if (saleOnEarlierSheet && !offsetUsed) { t.offset -= (num(refundRow.sale_price) || 0) - (num(refundRow.amazon_cost) || 0); offsetUsed = true; }
      if (e.last && (!t.last || e.last > t.last)) t.last = e.last;
      later.set(target, t);
    }
    for (const [m, e] of later) {
      const ovAmazon = num(ov.amazon_refund) !== null; // a manual Amazon refund replaces email-dated ones
      const azr = ovAmazon ? 0 : e.amazonRefund;
      events.push({
        order_id: `REFUND:${o.order_id}:${m}`,
        refund_of: o.order_id,
        settle_target: m, // the payment it goes on (may be later than its date, if that payment was already made)
        created_at: e.last || iso(o.created_at),
        business_month: businessMonth(e.last || o.created_at), // analytics: the calendar month it happened
        buyer: o.buyer_username, ship_name: o.ship_name, ship_city: o.ship_city, ship_state: o.ship_state, ship_zip: o.ship_zip,
        fulfillment_status: null, cancel_state: null,
        title: `Refund · ${led?.title || title}`, // a sheet sale's refund carries the sheet's name, so they group together
        item_id: items[0]?.item_id || null,
        items: [],
        units: 0,
        item_subtotal: 0, shipping_charged: 0, discount: 0, tax_collected: 0,
        revenue: 0,
        fees: r2(-e.credit - e.offset + e.otherCharge), // eBay's fee credit back (and a sheet refund row's amount already booked); return labels / other charges
        raw_fees: 0, fee_credit: r2(e.credit), raw_refunds: r2(e.refund), ad_fees: r2(-e.adCredit), // an ad fee given back
        amazon_cost: 0, amazon_cost_unknown: false, cost: 0,
        refunds: r2(e.refund),
        amazon_refund: r2(azr), email_refund: r2(azr), extra_cost: 0,
        net: r2(-e.refund + e.credit + azr + e.adCredit + e.offset - e.otherCharge),
        margin: null, roi: null,
        has_cost: true, cost_source: 'refund', source: 'refund',
        ledger: null,
        counted: true, cancelled: false, in_sheet: false, before_start: false, possible_sheet_duplicate: false,
        excluded: false, status: 'returned', lag_days: null, amazon_orders: [], returns: [], tracking_numbers: [],
        overrides: { cost_override: null, extra_cost: null, amazon_refund: null, fee_override: null, refund_override: null, notes: '', excluded: false },
      });
    }
  }

  // Ledger rows (monthly settlement sheets). When paired with a real eBay sale in the same month they take its
  // real date and buyer; otherwise dates are approximate (spread across the month in sheet order).
  const now = new Date();
  for (const l of ledger) {
    const eb = l.ebay_order_id ? ebayById.get(l.ebay_order_id) : null;
    const ebInMonth = eb && businessMonth(eb.created_at) === l.month;
    const ov = ovBy.get(`LEDGER:${l.entry_key}`) || {};
    const [y, m] = l.month.split('-').map(Number);
    const start = Date.UTC(y, m - 1, 1, 19); // noon in Arizona
    const monthEnd = Date.UTC(y, m, 0, 19);
    const end = Math.min(monthEnd, Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 19));
    const span = Math.max(0, end - start);
    const created = new Date(start + Math.floor((((l.row_no || 1) - 0.5) / (l.row_count || 1)) * (span / 86400_000)) * 86400_000);
    const refund = l.is_refund;
    const sale = num(l.sale_price) || 0;
    const revenue = refund ? 0 : sale;
    const refundFee = refund ? -sale : 0;
    const cost = num(ov.cost_override) ?? (num(l.amazon_cost) || 0);
    const adFees = num(l.ad_fees) || 0;
    const fees = num(ov.fee_override) ?? 0;
    const refunds = num(ov.refund_override) ?? refundFee;
    const amazonRefund = num(ov.amazon_refund) || 0;
    const extra = num(ov.extra_cost) || 0;
    const net = r2(revenue - fees - adFees - cost - refunds + amazonRefund - extra);
    out.push({
      order_id: `LEDGER:${l.entry_key}`,
      created_at: ebInMonth ? iso(eb.created_at) : new Date(created).toISOString(),
      business_month: l.month,
      approx_date: !ebInMonth,
      ebay_order_id: eb ? eb.order_id : null,
      buyer: eb?.buyer_username || null, ship_name: eb?.ship_name || null, ship_city: eb?.ship_city || null, ship_state: eb?.ship_state || null, ship_zip: eb?.ship_zip || null,
      fulfillment_status: null, cancel_state: null,
      title: l.title,
      item_id: null,
      items: [{ title: l.title, sku: null, item_id: null, quantity: 1, unit_price: sale, line_total: sale }],
      units: 1,
      item_subtotal: sale, shipping_charged: 0, discount: 0, tax_collected: 0,
      revenue, fees, raw_fees: 0, fee_credit: 0, raw_refunds: refundFee, ad_fees: adFees,
      amazon_cost: num(l.amazon_cost) || 0, amazon_cost_unknown: false, cost, refunds,
      amazon_refund: amazonRefund, email_refund: 0, extra_cost: extra, net,
      margin: revenue > 0 ? net / revenue : null,
      roi: cost > 0 ? net / cost : null,
      has_cost: true, cost_source: 'ledger', source: 'ledger',
      ledger: { entry_key: l.entry_key, month: l.month, title: l.title, sale_price: sale, amazon_cost: num(l.amazon_cost), note: l.note, source_file: l.source_file, is_refund: refund },
      counted: !ov.excluded,
      cancelled: false,
      in_sheet: false, before_start: false, possible_sheet_duplicate: false,
      excluded: Boolean(ov.excluded),
      status: ov.excluded ? 'excluded' : refund ? 'returned' : eb && returnOpenBy.has(eb.order_id) ? 'return_open' : net < 0 ? 'loss' : 'profitable',
      return_open: !refund && eb ? returnOpenBy.get(eb.order_id) || null : null,
      lag_days: null,
      amazon_orders: [],
      returns: refund ? [{ return_id: l.entry_key, reason: l.note || 'Refund (from monthly sheet)', state: 'CLOSED', status: 'REFUNDED', created_at: new Date(created).toISOString(), refund_amount: refundFee }] : [],
      tracking_numbers: [],
      overrides: {
        cost_override: num(ov.cost_override), extra_cost: num(ov.extra_cost), amazon_refund: num(ov.amazon_refund),
        fee_override: num(ov.fee_override), refund_override: num(ov.refund_override), notes: ov.notes || l.note || '', excluded: Boolean(ov.excluded),
      },
    });
  }
  out.push(...events);
  // Which payment each row settles in (26th-to-26th from Sep 2026; see settlement.js). A sheet row without a real
  // eBay date stays in its sheet's month.
  // Which payment each row is on. A row a closed payment covered stays on it; a counted row that is new for a closed
  // payment (a sale costed or found later, a late refund) goes on the next open one.
  const frozenMonthOf = new Map();
  for (const [mo, keys] of frozen) for (const k of keys) frozenMonthOf.set(k, mo);
  for (const r of out) {
    let m = r.settle_target || (r.approx_date ? r.business_month : settlePeriodOf(businessDay(r.created_at), dueDay));
    if (frozenMonthOf.has(r.order_id)) m = frozenMonthOf.get(r.order_id);
    else if (r.counted) while (frozen.has(m)) m = nextCycle(m);
    r.settle_month = m;
  }
  // A closed payment's amounts don't change either. If a row it covered changes later (an ad fee charged after the
  // payment, an edited cost) or stops counting, the closed payment keeps what it was paid on (a "Held as paid" line)
  // and the difference goes on the next open payment as an adjustment line.
  const nextOpen = (m) => { let n = nextCycle(m); while (frozen.has(n)) n = nextCycle(n); return n; };
  const byKey = new Map(out.map((r) => [r.order_id, r]));
  const zero = { collected: 0, cogs: 0, ad: 0, other: 0 };
  // oldest first, so an adjustment line that later lands on another closed payment is checked against it too
  for (const fr of [...freezeRows].sort((a, b) => (a.month < b.month ? -1 : 1))) {
    const vals = typeof fr.row_values === 'string' ? JSON.parse(fr.row_values) : fr.row_values;
    if (!vals) continue;
    for (const [key, was] of Object.entries(vals)) {
      const r = byKey.get(key);
      const now = r && r.counted && r.settle_month === fr.month ? rowCents(r) : zero;
      const d = { collected: now.collected - was.collected, cogs: now.cogs - was.cogs, ad: now.ad - was.ad, other: now.other - was.other };
      if (!d.collected && !d.cogs && !d.ad && !d.other) continue;
      const title = r?.title || was.title || key;
      const neg = { collected: -d.collected, cogs: -d.cogs, ad: -d.ad, other: -d.other };
      const hold = adjustmentRow(`HOLD:${key}`, fr.month, neg, `Held as paid · ${title}`, r, true);
      const adj = adjustmentRow(`ADJ:${key}:${fr.month}`, frozenMonthOf.get(`ADJ:${key}:${fr.month}`) || nextOpen(fr.month), d, `Change after the ${fr.month} payment · ${title}${!r || !r.counted ? ' (no longer counted)' : ''}`, r, false);
      out.push(hold, adj);
      byKey.set(hold.order_id, hold); byKey.set(adj.order_id, adj);
    }
  }

  // eBay money with no order, and return/case holds never released after 30 days (a case that may have been lost)
  out.unassignedCharges = orderlessTx.map((t) => ({ type: t.type, fee_type: t.fee_type, amount: (t.booking_entry === 'CREDIT' ? -1 : 1) * (num(t.amount) || 0), at: iso(t.transaction_at), id: t.transaction_id }));
  const released = new Set(holdTx.filter((t) => t.type === 'CREDIT').map((t) => String(t.transaction_id || '').match(/^DISPUTE_HOLD_REVERSE-(\d+)/)?.[1]).filter(Boolean));
  out.openHolds = holdTx.filter((t) => t.type === 'DISPUTE' && t.booking_entry === 'DEBIT')
    .map((t) => ({ order_id: t.order_id, amount: num(t.amount), since: iso(t.transaction_at), id: String(t.transaction_id || '').match(/^DISPUTE_HOLD-(\d+)/)?.[1] }))
    .filter((h) => !released.has(h.id) && Date.now() - new Date(h.since).getTime() > 30 * 86400_000 && !(refundTxBy.get(h.order_id) || []).length);
  out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  out.unmatchedRefunds = unmatchedRefunds; // not serialized with the rows; /api/data sends it separately
  return out;
}

export async function buildBooks() {
  const [expenses, settlements, payments, closed] = await Promise.all([
    q('select id, month, category, amount, note, paid_by, source from expenses order by month, category'),
    q('select * from settlements order by month'),
    q('select id, month, amount, paid_at, note, recorded_at from settlement_payments order by month, paid_at nulls first, id'),
    q('select month, frozen_at, totals from settlement_freeze order by month'),
  ]);
  const day = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);
  const ex = expenses.map((e) => ({ ...e, amount: num(e.amount) }));
  // A closed payment's operating costs don't change: a cost added or edited for it afterwards is held there as paid
  // and moved to the next open payment
  const closedMonths = new Set(closed.map((c) => c.month));
  const next = (m) => { const [y, mo] = m.split('-').map(Number); return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`; };
  const nextOpen = (m) => { let n = next(m); while (closedMonths.has(n)) n = next(n); return n; };
  for (const c of closed) {
    const t = typeof c.totals === 'string' ? JSON.parse(c.totals) : c.totals || {};
    const was = { seller: num(t.opexSeller ?? t.opex) ?? null, amazon: num(t.opexAmazon) ?? 0 };
    if (was.seller === null) continue;
    for (const [payer, frozen] of [['seller', was.seller], ['amazon', was.amazon]]) {
      const now = Math.round(ex.filter((e) => e.month === c.month && (payer === 'amazon' ? e.paid_by === 'amazon' : e.paid_by !== 'amazon')).reduce((t2, e) => t2 + Math.round((e.amount || 0) * 100), 0)) / 100;
      const d = Math.round((now - frozen) * 100) / 100;
      if (Math.abs(d) < 0.005) continue;
      ex.push({ id: `hold-${c.month}-${payer}`, month: c.month, category: 'Held as paid (costs changed after this payment)', amount: -d, paid_by: payer, source: 'adjustment', note: null });
      ex.push({ id: `adj-${c.month}-${payer}`, month: nextOpen(c.month), category: `Change to the ${c.month} costs after it was paid`, amount: d, paid_by: payer, source: 'adjustment', note: null });
    }
  }
  const splitOf = new Map(closed.map((c) => { const t = typeof c.totals === 'string' ? JSON.parse(c.totals) : c.totals || {}; return [c.month, t.split ?? null]; }));
  return {
    expenses: ex,
    settlements: settlements.map((s) => ({ ...s, paid: num(s.paid), paid_at: day(s.paid_at), split: splitOf.get(s.month) ?? null })),
    payments: payments.map((p) => ({ ...p, amount: num(p.amount), paid_at: day(p.paid_at) })),
    closed: closed.map((c) => ({ month: c.month, frozen_at: c.frozen_at, totals: c.totals })),
  };
}
