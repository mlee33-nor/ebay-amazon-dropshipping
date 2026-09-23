// Builds the per-order profit dataset the dashboard renders. All money math lives here so the
// dashboard, the editor and CSV exports always agree.
import { q, num, getSetting } from './db.js';

// Business calendar month (sheets are calendar months in the partners' timezone)
const TZ = process.env.BUSINESS_TZ || 'America/Phoenix';
const monthFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit' });
const businessMonth = (d) => { const p = monthFmt.formatToParts(new Date(d)); return `${p.find((x) => x.type === 'year').value}-${p.find((x) => x.type === 'month').value}`; };

const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const iso = (d) => (d instanceof Date ? d.toISOString() : d);
const isoDate = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);

export async function buildDataset() {
  const [orders, lines, returns, links, overrides, amazonLines, azRefunds, ledger] = await Promise.all([
    q(`select order_id, created_at, buyer_username, ship_name, ship_city, ship_state, ship_zip, ship_country,
              fulfillment_status, payment_status, cancel_state, item_subtotal, shipping_charged, discount,
              tax_collected, revenue, ebay_fees, ad_fees, refund_total, tracking_numbers
       from ebay_orders order by created_at desc`),
    q('select * from ebay_line_items'),
    q('select return_id, order_id, item_id, state, status, reason, return_type, created_at, refund_amount from ebay_returns'),
    q('select * from order_links'),
    q('select * from order_overrides'),
    q(`select l.line_key, l.amazon_order_id, l.order_date, l.asin, l.title, l.quantity, l.line_total, l.tax, l.shipping,
              l.order_status, l.tracking, l.cost_override, l.ignored, l.ship_name, l.ship_zip
       from amazon_lines l join order_links k on k.amazon_order_id = l.amazon_order_id`),
    q('select amazon_order_id, sum(amount) as amount from amazon_refunds group by amazon_order_id'),
    q('select * from ledger_entries order by month, row_no'),
  ]);
  const refundBy = new Map(azRefunds.map((r) => [r.amazon_order_id, num(r.amount)]));
  const ledgerByEbay = new Map(ledger.filter((l) => l.ebay_order_id).map((l) => [l.ebay_order_id, l]));
  // A month with an uploaded settlement sheet is settled by the sheet: its rows are the source of truth for
  // profit and settlement (so the dashboard equals the sheet to the cent). Real eBay orders in those months
  // stay visible but aren't counted again; when matched to a sheet row they give that row its real date.
  const sheetMonths = new Set(ledger.map((l) => l.month));
  // Sales before the partnership started (default: the first sheet month) are not part of this business
  const startMonth = (await getSetting('business_start')) || [...sheetMonths].sort()[0] || null;
  const ebayById = new Map(orders.map((o) => [o.order_id, o]));

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
  const ovBy = new Map(overrides.map((o) => [o.order_id, o]));

  const out = orders.map((o) => {
    const ov = ovBy.get(o.order_id) || {};
    const items = (linesBy.get(o.order_id) || []).map((li) => ({
      title: li.title,
      sku: li.sku,
      item_id: li.legacy_item_id,
      quantity: li.quantity,
      unit_price: num(li.unit_price),
      line_total: num(li.line_total),
    }));
    const amazonOrders = (linksBy.get(o.order_id) || []).map((lk) => {
      const azLines = (azBy.get(lk.amazon_order_id) || []).map((l) => {
        const cancelled = /cancel/i.test(l.order_status || '');
        const cost = l.ignored || cancelled ? 0 : num(l.cost_override) ?? num(l.line_total) ?? 0;
        return {
          line_key: l.line_key,
          asin: l.asin,
          title: l.title,
          quantity: l.quantity,
          line_total: num(l.line_total),
          cost_override: num(l.cost_override),
          ignored: l.ignored,
          status: l.order_status,
          tracking: l.tracking,
          cost,
        };
      });
      return {
        amazon_order_id: lk.amazon_order_id,
        method: lk.method,
        score: num(lk.score),
        reasons: lk.reasons,
        order_date: isoDate((azBy.get(lk.amazon_order_id) || [])[0]?.order_date),
        lines: azLines,
        cost: r2(azLines.reduce((s, l) => s + l.cost, 0)),
      };
    });
    const rets = (returnsBy.get(o.order_id) || []).map((r) => ({ ...r, created_at: iso(r.created_at), refund_amount: num(r.refund_amount) }));

    const cancelled = /CANCELED|CANCELLED/i.test(o.cancel_state || '') && !/NONE_REQUESTED|IN_PROGRESS/i.test(o.cancel_state || '');
    const amazonCost = r2(amazonOrders.reduce((s, a) => s + a.cost, 0));
    const led = ledgerByEbay.get(o.order_id);
    const costSource = num(ov.cost_override) !== null ? 'override' : amazonOrders.length ? 'amazon' : led ? 'ledger' : null;
    const hasCost = costSource !== null;
    const cost = num(ov.cost_override) ?? (amazonOrders.length ? amazonCost : led ? num(led.amazon_cost) : 0);
    const revenue = cancelled ? 0 : num(o.revenue) || 0;
    const fees = cancelled ? 0 : num(ov.fee_override) ?? (num(o.ebay_fees) || 0);
    const adFees = cancelled ? 0 : num(o.ad_fees) || 0;
    const refunds = cancelled ? 0 : num(ov.refund_override) ?? (num(o.refund_total) || 0);
    const emailRefund = r2(amazonOrders.reduce((t, a) => t + (refundBy.get(a.amazon_order_id) || 0), 0));
    const amazonRefund = num(ov.amazon_refund) ?? emailRefund;
    const extra = num(ov.extra_cost) || 0;
    const net = r2(revenue - fees - adFees - cost - refunds + amazonRefund - extra);
    const firstAz = amazonOrders.map((a) => a.order_date).filter(Boolean).sort()[0];
    const lagDays = firstAz
      ? Math.round((new Date(`${firstAz}T12:00:00Z`) - new Date(new Date(o.created_at).toISOString().slice(0, 10) + 'T12:00:00Z')) / 86400_000)
      : null;
    const units = items.reduce((s, i) => s + (i.quantity || 0), 0) || 1;

    // Only sales matched to a sheet row are covered by the sheet; any other sale stays visible (and needs a cost)
    const inSheet = Boolean(led);
    const beforeStart = Boolean(startMonth) && businessMonth(o.created_at) < startMonth;
    let status = 'profitable';
    if (beforeStart) status = 'before_start';
    else if (inSheet) status = 'in_sheet';
    else if (ov.excluded) status = 'excluded';
    else if (cancelled) status = hasCost && cost > 0 ? 'cancelled_after_purchase' : 'cancelled';
    else if (!hasCost) status = 'awaiting_cost';
    else if (refunds > 0 || rets.length) status = 'returned';
    else if (net < 0) status = 'loss';

    return {
      order_id: o.order_id,
      created_at: iso(o.created_at),
      buyer: o.buyer_username,
      ship_name: o.ship_name,
      ship_city: o.ship_city,
      ship_state: o.ship_state,
      ship_zip: o.ship_zip,
      fulfillment_status: o.fulfillment_status,
      cancel_state: o.cancel_state,
      title: items[0]?.title || '(no title)',
      item_id: items[0]?.item_id || null,
      items,
      units,
      item_subtotal: num(o.item_subtotal),
      shipping_charged: num(o.shipping_charged),
      discount: num(o.discount),
      tax_collected: num(o.tax_collected),
      revenue,
      fees,
      raw_fees: num(o.ebay_fees) || 0,
      raw_refunds: num(o.refund_total) || 0,
      ad_fees: adFees,
      amazon_cost: amazonCost,
      cost,
      refunds,
      amazon_refund: amazonRefund,
      email_refund: emailRefund,
      extra_cost: extra,
      net,
      margin: revenue > 0 ? net / revenue : null,
      roi: cost > 0 ? net / cost : null,
      has_cost: hasCost,
      cost_source: costSource,
      source: 'ebay',
      ledger: led ? { entry_key: led.entry_key, month: led.month, title: led.title, sale_price: num(led.sale_price), amazon_cost: num(led.amazon_cost) } : null,
      counted: !inSheet && !beforeStart && !ov.excluded && hasCost && !(cancelled && cost === 0),
      cancelled,
      in_sheet: inSheet,
      before_start: beforeStart,
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
      },
    };
  });
  // Ledger rows (monthly settlement sheets) with no eBay order yet stand in as sales.
  // Dates are approximate: the sheet only gives the month, so rows are spread across it in sheet order.
  const now = new Date();
  for (const l of ledger) {
    const eb = l.ebay_order_id ? ebayById.get(l.ebay_order_id) : null;
    const ebInMonth = eb && businessMonth(eb.created_at) === l.month;
    const ov = ovBy.get(`LEDGER:${l.entry_key}`) || {};
    const [y, m] = l.month.split('-').map(Number);
    const start = Date.UTC(y, m - 1, 1, 12);
    const monthEnd = Date.UTC(y, m, 0, 12);
    const end = Math.min(monthEnd, Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12));
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
      approx_date: !ebInMonth,
      ebay_order_id: eb ? eb.order_id : null,
      buyer: eb?.buyer_username || null, ship_name: eb?.ship_name || null, ship_city: eb?.ship_city || null, ship_state: eb?.ship_state || null, ship_zip: eb?.ship_zip || null,
      fulfillment_status: null, cancel_state: null,
      title: l.title,
      item_id: null,
      items: [{ title: l.title, sku: null, item_id: null, quantity: 1, unit_price: sale, line_total: sale }],
      units: 1,
      item_subtotal: sale, shipping_charged: 0, discount: 0, tax_collected: 0,
      revenue, fees, raw_fees: 0, raw_refunds: refundFee, ad_fees: adFees,
      amazon_cost: num(l.amazon_cost) || 0, cost, refunds,
      amazon_refund: amazonRefund, email_refund: 0, extra_cost: extra, net,
      margin: revenue > 0 ? net / revenue : null,
      roi: cost > 0 ? net / cost : null,
      has_cost: true, cost_source: 'ledger', source: 'ledger',
      ledger: { entry_key: l.entry_key, month: l.month, title: l.title, sale_price: sale, amazon_cost: num(l.amazon_cost), note: l.note, source_file: l.source_file },
      counted: !ov.excluded,
      cancelled: false,
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
