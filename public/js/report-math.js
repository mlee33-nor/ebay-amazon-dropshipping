// The money behind the documents the partners print, share or give their accountant: the settlement statement, the
// year-end tax panel and the order exports. Pure (no DOM), so the tests check it against the server's own numbers.
import { azDay, orderLabel } from './util.js';
import { settleMonth } from './settlement.js';
import { rowMonth, isSale } from './metrics.js';

const cents = (n) => Math.round((Number(n) || 0) * 100);

// One line's money, exactly as settleMonth() adds it up
export function lineOf(o) {
  const payout = cents(o.revenue) - cents(o.fees) - cents(o.refunds);
  const cogs = cents(o.cost) - cents(o.amazon_refund);
  const ads = cents(o.ad_fees);
  const other = cents(o.extra_cost);
  return { o, payout, cogs, ads, other, net: payout - cogs - ads - other };
}

// A statement lists exactly the lines the payment is made of: rows are picked by the payment they are on (settle_month,
// the same field settleMonth() groups by), never by the calendar month they happened in. A Sep 28 sale is on October's
// statement, and a refund line booked on a later payment is on that payment's statement.
export function statementFor({ orders, books, settings }, month) {
  const s = settleMonth({ month, orders, expenses: books.expenses, settlements: books.settlements, splitAmazon: Number(settings.split_amazon) });
  const lines = orders.filter((o) => o.counted && rowMonth(o) === month).map(lineOf).sort((a, b) => (a.o.created_at < b.o.created_at ? -1 : 1));
  const sum = (k) => lines.reduce((t, l) => t + l[k], 0);
  const tot = { payout: sum('payout'), cogs: sum('cogs'), ads: sum('ads'), other: sum('other'), net: sum('net') };
  const matches = lines.length === s.orders && tot.net === cents(s.orderProfit) && tot.payout === cents(s.collected) && tot.cogs === cents(s.cogs);
  const sales = lines.filter((l) => isSale(l.o)).length;
  return { s, lines, tot, matches, sales, refundLines: lines.length - sales };
}

// ---------------------------------------------------------------- taxes
// Gross sales for a counted line. eBay orders carry the buyer-paid price (excluding sales tax, which eBay collects and
// remits). Monthly-sheet rows only record the payout, so their gross comes from the matched eBay order when there is
// one. A refund line sold nothing: its gross is 0, its fees are the fee credit eBay gave back (negative) and its refund
// is the buyer's refund, so the refund is taken off once and the credit is not lost. A monthly-sheet refund row is
// eBay's refund fee (40 cents), not money returned to a buyer: gross 0, that fee as an eBay fee, no refund.
// Every line keeps gross - fees - refunds = payout.
export const isSheetRefundFee = (o) => o.source === 'ledger' && Boolean(o.ledger?.is_refund || o.ledger?.sale_price < 0);
export function taxLine(o, ebayById) {
  const l = lineOf(o);
  let gross = null;
  let fees = null;
  let refunds = cents(o.refunds);
  if (o.source === 'refund') { gross = 0; fees = cents(o.fees); }
  else if (o.source === 'ebay') gross = cents(o.revenue);
  else if (isSheetRefundFee(o)) { gross = 0; refunds = 0; }
  else if (o.ebay_order_id && ebayById.has(o.ebay_order_id)) gross = cents(ebayById.get(o.ebay_order_id).revenue);
  if (fees === null && gross !== null) fees = gross - refunds - l.payout;
  return { ...l, gross, fees, refunds, month: o.business_month, sale: isSale(o) };
}

// Every counted line of a tax year, by the calendar month it happened (Arizona time)
export function taxRows(orders, year) {
  const ebayById = new Map(orders.filter((o) => o.source === 'ebay').map((o) => [o.order_id, o]));
  return orders.filter((o) => o.counted && (o.business_month || '').startsWith(year)).map((o) => taxLine(o, ebayById));
}

export function taxTotals(rows) {
  const sum = (list, k) => list.reduce((t, r) => t + (r[k] || 0), 0);
  // Only a monthly-sheet sale with no matched eBay order is missing its gross
  const noGross = rows.filter((r) => r.gross === null && r.o.source === 'ledger');
  return {
    sales: rows.filter((r) => r.sale).length,
    gross: sum(rows, 'gross'), fees: sum(rows, 'fees'), refunds: sum(rows, 'refunds'), payout: sum(rows, 'payout'),
    ads: sum(rows, 'ads'), cogs: sum(rows, 'cogs'), other: sum(rows, 'other'), net: sum(rows, 'net'),
    noGross: noGross.length, noGrossPayout: sum(noGross, 'payout'),
  };
}

// ---------------------------------------------------------------- order exports (Orders page, Editor, Settings)
// Every row is listed, but money is filled in only for rows that are counted, so adding up a column gives the books.
// A sale a monthly sheet covers (or one still waiting for its cost) shows why in Counted/Status with blank money, so it
// is never added twice. Dates are the Arizona day.
const ifCounted = (f) => (o) => (o.counted ? f(o) : '');
export const ORDER_EXPORT = [
  { title: 'Date', get: (o) => azDay(o.created_at) },
  { title: 'eBay order', get: (o) => (o.source === 'ledger' ? orderLabel(o) : o.source === 'refund' ? o.refund_of : o.order_id) },
  { title: 'Item', get: (o) => o.title },
  { title: 'Units', get: (o) => (isSale(o) ? o.units : 0) }, { title: 'Buyer', get: (o) => o.buyer }, { title: 'State', get: (o) => o.ship_state },
  { title: 'Counted', get: (o) => (o.counted ? 'yes' : 'no') },
  { title: 'Settles in', get: ifCounted((o) => rowMonth(o)) },
  { title: 'Revenue', get: ifCounted((o) => o.revenue) }, { title: 'Amazon cost', get: ifCounted((o) => o.cost) }, { title: 'eBay fees', get: ifCounted((o) => o.fees) },
  { title: 'Ad fees', get: ifCounted((o) => o.ad_fees) }, { title: 'Refunds', get: ifCounted((o) => o.refunds) }, { title: 'Amazon refund', get: ifCounted((o) => o.amazon_refund) },
  { title: 'Extra cost', get: ifCounted((o) => o.extra_cost) }, { title: 'Net profit', get: ifCounted((o) => o.net) }, { title: 'Status', get: (o) => o.status },
  { title: 'Amazon orders', get: (o) => (o.amazon_orders || []).map((a) => a.amazon_order_id).join(' ') }, { title: 'Notes', get: (o) => o.overrides?.notes || '' },
];

// ---------------------------------------------------------------- payments
// What is left to pay on a payment, signed exactly as the server works it out for "Pay the remaining" and as
// settlement_payments.amount is stored: sellerSends - paid. Positive: the eBay partner still owes the Amazon partner;
// negative: a month where the Amazon partner pays the eBay partner (stored as negative payments), or an overpayment.
export const remainingFor = (s) => Math.round((cents(s.sellerSends) - cents(s.paid || 0))) / 100;
