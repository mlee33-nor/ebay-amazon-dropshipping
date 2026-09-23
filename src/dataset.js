// Builds the per-order profit dataset the dashboard renders. All money math lives here so the
// dashboard, the editor and CSV exports always agree. Every row carries `business_month` (Arizona
// time, decided here) and settlement groups by that field, so every viewer sees the same numbers.
import { q, num, getSetting } from './db.js';
import { businessMonth, businessDay } from './time.js';
import { sheetTitleMatch } from './ledger.js';
import { loadUnlinkedAmazon, scorePair } from './matcher.js';

const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const iso = (d) => (d instanceof Date ? d.toISOString() : d);
const isoDate = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);

export async function buildDataset() {
  const [orders, lines, returns, links, overrides, amazonLines, azRefunds, ledger, refundTx] = await Promise.all([
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
    q('select amazon_order_id, amount, received_at from amazon_refunds'),
    q('select * from ledger_entries order by month, row_no'),
    q("select order_id, amount, fee_amount, transaction_at from ebay_transactions where type = 'REFUND'"),
  ]);

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
  const ovBy = new Map(overrides.map((o) => [o.order_id, o]));
  const ledgerByEbay = new Map(ledger.filter((l) => l.ebay_order_id && !l.is_refund).map((l) => [l.ebay_order_id, l]));
  const refundRowByEbay = new Map(ledger.filter((l) => l.ebay_order_id && l.is_refund).map((l) => [l.ebay_order_id, l]));
  const ebayById = new Map(orders.map((o) => [o.order_id, o]));

  // A month with an uploaded settlement sheet is settled by the sheet: its rows are the source of truth for
  // profit and settlement (so the dashboard equals the sheet to the cent). Real eBay orders matched to a sheet
  // row stay visible but aren't counted again; the sheet row takes their real date.
  const sheetMonths = new Set(ledger.map((l) => l.month));
  // Sales before the partnership started (default: the first sheet month) are not part of this business
  const startMonth = (await getSetting('business_start')) || [...sheetMonths].sort()[0] || null;
  // Unpaired sheet sale rows per month, used to flag eBay sales that are probably a reworded sheet row
  const unpairedSheetRows = group(ledger.filter((l) => !l.ebay_order_id && !l.is_refund), 'month');

  // Unlinked Amazon orders: a refunded sale is only assumed to have had no purchase if none of these could be its purchase
  const unlinkedAmazon = await loadUnlinkedAmazon();
  const out = [];
  const events = []; // refunds / Amazon refunds booked in a later month than the sale

  for (const o of orders) {
    const ov = ovBy.get(o.order_id) || {};
    const saleMonth = businessMonth(o.created_at);
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

    const cancelled = /CANCELED|CANCELLED/i.test(o.cancel_state || '') && !/NONE_REQUESTED|IN_PROGRESS/i.test(o.cancel_state || '');
    const amazonCost = r2(amazonOrders.reduce((s, a) => s + a.cost, 0));
    const led = ledgerByEbay.get(o.order_id);
    const inSheetMonth = sheetMonths.has(saleMonth);
    const beforeStart = Boolean(startMonth) && saleMonth < startMonth;
    const inSheet = Boolean(led) || refundRowByEbay.has(o.order_id);
    const rawRevenue = num(o.revenue) || 0;
    const rawFees = num(o.ebay_fees) || 0;

    // ---- refunds, booked in the month they happened (eBay Finances REFUND records carry the date and
    // the fee eBay credits back). Without Finances records, the order-level refund total is used.
    const txs = refundTxBy.get(o.order_id) || [];
    const hasTx = txs.length > 0;
    const byMonth = new Map(); // month -> { refund, credit, amazonRefund, last }
    const bump = (m, k, v, at) => {
      if (!byMonth.has(m)) byMonth.set(m, { refund: 0, credit: 0, amazonRefund: 0, last: at });
      const e = byMonth.get(m);
      e[k] += v;
      if (at && (!e.last || new Date(at) > new Date(e.last))) e.last = at;
    };
    for (const t of txs) {
      const at = t.transaction_at || o.created_at;
      bump(businessMonth(at), 'refund', num(t.amount) || 0, iso(at));
      bump(businessMonth(at), 'credit', num(t.fee_amount) || 0, iso(at));
    }
    for (const a of amazonOrders) {
      for (const r of azRefundsBy.get(a.amazon_order_id) || []) {
        const at = r.received_at || o.created_at;
        bump(businessMonth(at), 'amazonRefund', num(r.amount) || 0, iso(at));
      }
    }
    const same = byMonth.get(saleMonth) || { refund: 0, credit: 0, amazonRefund: 0 };
    const totalTxRefund = txs.reduce((s, t) => s + (num(t.amount) || 0), 0);
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
    const refunds = cancelled ? 0 : refundOverride ?? (hasTx ? r2(same.refund) : num(o.refund_total) || 0);
    let fees = cancelled ? 0 : num(ov.fee_override) ?? r2(rawFees - (hasTx && refundOverride === null ? same.credit : 0));
    // Without Finances records we can't see eBay's fee credit; for a refund with no purchase assume only the
    // fixed $0.40 per-order fee was kept (what eBay does on a full refund)
    if (!cancelled && refundedNoPurchase && !hasTx && num(ov.fee_override) === null) fees = Math.min(fees, 0.4);
    fees = Math.max(0, fees);
    const adFees = cancelled ? 0 : num(o.ad_fees) || 0;
    const emailRefundSame = r2(same.amazonRefund);
    const emailRefundAll = r2([...byMonth.values()].reduce((s, e) => s + e.amazonRefund, 0));
    const amazonRefund = num(ov.amazon_refund) ?? emailRefundSame;
    const extra = num(ov.extra_cost) || 0;
    const net = r2(revenue - fees - adFees - cost - refunds + amazonRefund - extra);

    // An eBay sale in a sheet month that looks like a sheet row the matcher couldn't pair (reworded title,
    // multi-quantity...) is flagged instead of counted, so a sale can never be counted twice
    const possibleSheetDup = !inSheet && inSheetMonth && (unpairedSheetRows.get(saleMonth) || [])
      .some((l) => sheetTitleMatch(l.title, title) >= 0.34 && sheetTitleMatch(l.title, title) * new Set(l.title.toLowerCase().split(/\s+/)).size >= 2);

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
    else if (!hasCost && mostlyRefunded && inSheetMonth) status = 'returned'; // refunded, and the sheet left it out
    else if (!hasCost) status = 'awaiting_cost';
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
      excluded: inSheet || beforeStart || Boolean(ov.excluded),
      status,
      lag_days: lagDays,
      amazon_orders: amazonOrders,
      returns: rets,
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
    if (beforeStart || ov.excluded || refundOverride !== null || cancelled) continue;
    if (!inSheet && !counted) continue; // the sale itself isn't in the books yet (e.g. awaiting cost)
    for (const [m, e] of byMonth) {
      if (m === saleMonth && !inSheet) continue; // same-month refunds are on the order row
      if (m < saleMonth) continue;
      if (inSheet && sheetMonths.has(m)) continue;
      if (!e.refund && !e.credit && !e.amazonRefund) continue;
      const ovAmazon = num(ov.amazon_refund) !== null; // a manual Amazon refund replaces email-dated ones
      const azr = ovAmazon ? 0 : e.amazonRefund;
      events.push({
        order_id: `REFUND:${o.order_id}:${m}`,
        refund_of: o.order_id,
        created_at: e.last || iso(o.created_at),
        business_month: m,
        buyer: o.buyer_username, ship_name: o.ship_name, ship_city: o.ship_city, ship_state: o.ship_state, ship_zip: o.ship_zip,
        fulfillment_status: null, cancel_state: null,
        title: `Refund · ${title}`,
        item_id: items[0]?.item_id || null,
        items: [],
        units: 0,
        item_subtotal: 0, shipping_charged: 0, discount: 0, tax_collected: 0,
        revenue: 0,
        fees: r2(-e.credit), // eBay's fee credit comes back
        raw_fees: 0, fee_credit: r2(e.credit), raw_refunds: r2(e.refund), ad_fees: 0,
        amazon_cost: 0, amazon_cost_unknown: false, cost: 0,
        refunds: r2(e.refund),
        amazon_refund: r2(azr), email_refund: r2(azr), extra_cost: 0,
        net: r2(-e.refund + e.credit + azr),
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
      status: ov.excluded ? 'excluded' : refund ? 'returned' : net < 0 ? 'loss' : 'profitable',
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
  out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return out;
}

export async function buildBooks() {
  const [expenses, settlements] = await Promise.all([
    q('select id, month, category, amount, note, paid_by, source from expenses order by month, category'),
    q('select * from settlements order by month'),
  ]);
  return {
    expenses: expenses.map((e) => ({ ...e, amount: num(e.amount) })),
    settlements: settlements.map((s) => ({ ...s, paid: num(s.paid), paid_at: s.paid_at instanceof Date ? s.paid_at.toISOString().slice(0, 10) : s.paid_at })),
  };
}
