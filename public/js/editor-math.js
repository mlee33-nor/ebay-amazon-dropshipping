// The Editor's money rules, kept pure (no DOM) so the tests can check them: how a typed or pasted cell is read, which
// rows can be edited, and the live net shown while edits are staged. The live net starts from the server's own numbers
// for the row (fees after eBay's fee credit, refunds and Amazon refunds on this payment, ad fees) and changes only what
// is staged, so with nothing staged it is exactly the net the server counts.

const blank = (v) => v === '' || v === null || v === undefined;
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// Money fields in the Editor's sheets. None of them may be negative except an operating-cost credit (amount).
export const MONEY_FIELDS = new Set(['cost_override', 'fee_override', 'refund_override', 'extra_cost', 'amazon_refund', 'amount']);
const NON_NEGATIVE = new Set(['cost_override', 'fee_override', 'refund_override', 'extra_cost', 'amazon_refund']);

// A typed or pasted amount, the way a person writes it: "$16.19", "1,234", "1,234.50", "(12.50)" (accounting
// negative), "-$5", "16.19 USD". Blank is null (no value). Anything else is NaN, so the caller can refuse it instead
// of silently clearing the cell.
export function parseMoney(v) {
  if (blank(v)) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? r2(v) : NaN;
  let s = String(v).trim().replace(/[−‒–]/g, '-').replace(/\s+/g, ' ');
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1).trim(); }
  s = s.replace(/^usd\s*/i, '').replace(/\s*usd$/i, '');
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1).trim(); }
  s = s.replace(/^\$\s*/, '');
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1).trim(); }
  if (!/^(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?$/.test(s) || !/\d/.test(s)) return NaN;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? r2(neg ? -n : n) : NaN;
}

// Normalise an edited cell value so "12", 12 and 12.0 compare equal and a cleared cell means "no override".
// Money that can't be read comes back as NaN (see moneyError).
export const normVal = (f, v) => {
  if (f === 'excluded' || f === 'ignored') return v === true || v === 'true' || v === 1 || v === '1';
  if (f === 'notes' || f === 'note' || f === 'category' || f === 'month' || f === 'paid_by') return blank(v) ? '' : String(v);
  if (MONEY_FIELDS.has(f)) return parseMoney(v);
  return blank(v) || Number.isNaN(Number(v)) ? null : Number(v);
};

// Why an edited money cell can't be saved, or null when it can
export function moneyError(f, v) {
  if (!MONEY_FIELDS.has(f) || v === null) return null;
  if (Number.isNaN(v)) return 'isn’t an amount. Type a number like 16.19 or $16.19';
  if (v < 0 && NON_NEGATIVE.has(f)) return 'can’t be negative. Amazon refunds go in “Amazon refund”, not as a negative cost';
  if (Math.abs(v) >= 1e6) return 'is too large';
  return null;
}

// A "Refund · …" line is computed from the refund records of its sale; it has nothing of its own to override (the
// server never reads an override saved on it). Change the sale instead.
export const isReadOnlyRow = (o) => o.source === 'refund' || String(o.order_id || '').startsWith('REFUND:');

// One dataset row as an Editor row. `nat_*` are the row's numbers without any of its overrides, worked out from what
// the server sent (exact when the row has no override; a close estimate after an existing override is cleared).
export function editorRow(o) {
  const ov = o.overrides || {};
  const has = (v) => v !== null && v !== undefined;
  const linked = (o.amazon_orders || []).length > 0;
  const costOv = has(ov.cost_override);
  // Costed without a typed cost: a usable linked Amazon order, a sheet row, or (server only) refunded with no purchase
  const natHasCost = o.source === 'refund' || o.source === 'ledger' || (!costOv ? Boolean(o.has_cost) : (linked && !o.amazon_cost_unknown && !o.amazon_cost_partial) || Boolean(o.ledger));
  const natCost = !costOv ? o.cost : o.source === 'ledger' || linked ? o.amazon_cost : o.ledger?.amazon_cost ?? 0;
  const rawFees = o.cancelled ? 0 : Math.max(0, o.raw_fees || 0);
  // eBay keeps the fee credit off the fees unless a refund is typed in by hand (then the whole refund sits on the sale)
  const feesNoRefundOv = !has(ov.fee_override) && !has(ov.refund_override) ? o.fees : Math.max(0, r2(rawFees - (o.fee_credit || 0)));
  return {
    order_id: o.order_id, source: o.source, ebay_order_id: o.ebay_order_id || null, refund_of: o.refund_of || null,
    created_at: o.created_at, title: o.title, revenue: o.revenue, status: o.status, cancelled: o.cancelled,
    read_only: isReadOnlyRow(o),
    server_net: o.net, server_has_cost: Boolean(o.has_cost),
    ad_fees: o.cancelled ? 0 : o.ad_fees || 0, has_returns: (o.returns || []).length > 0, return_open: Boolean(o.return_open),
    total_refund: o.raw_refunds || 0, // every refund of the sale, including ones booked on a later payment
    amazon_cost: natCost, nat_has_cost: Boolean(natHasCost),
    nat_fees: feesNoRefundOv, fees_with_refund_ov: o.source === 'ebay' ? rawFees : 0,
    nat_refunds: has(ov.refund_override) ? o.raw_refunds || 0 : o.refunds,
    nat_amazon_refund: has(ov.amazon_refund) ? (o.source === 'ebay' ? o.email_refund || 0 : 0) : o.amazon_refund || 0,
    cost_origin: o.source === 'ledger' ? 'sheet' : (o.amazon_orders || []).length ? 'amazon' : null,
    amazon_ids: (o.amazon_orders || []).map((a) => a.amazon_order_id).join(', '),
    cost_override: ov.cost_override ?? null, fee_override: ov.fee_override ?? null, refund_override: ov.refund_override ?? null,
    extra_cost: ov.extra_cost ?? null, amazon_refund: ov.amazon_refund ?? null, excluded: Boolean(ov.excluded), notes: ov.notes || '',
    edited: Object.entries(ov).some(([k, v]) => (k === 'excluded' || k === 'confirmed_separate' ? v : k === 'notes' ? Boolean(v) : v !== null && v !== undefined)),
  };
}

// The live net and status for an Editor row with its staged edits. With nothing staged it equals the server.
export function recompute(d) {
  const has = (v) => v !== null && v !== undefined && v !== '' && !Number.isNaN(v);
  // The Fees and Refunds columns show what counts right now, overrides included
  if (d.read_only) {
    d.net = d.server_net;
    d.base_fees = d.nat_fees;
    d.base_refunds = d.nat_refunds;
    d.live_counted = true;
    d.view_status = d.status;
    return d;
  }
  const cost = has(d.cost_override) ? Number(d.cost_override) : d.amazon_cost;
  const refundOv = has(d.refund_override);
  const fees = d.cancelled ? 0 : has(d.fee_override) ? Number(d.fee_override) : refundOv ? d.fees_with_refund_ov : d.nat_fees;
  const refunds = d.cancelled ? 0 : refundOv ? Number(d.refund_override) : d.nat_refunds;
  const amazonRefund = has(d.amazon_refund) ? Number(d.amazon_refund) : d.nat_amazon_refund;
  const extra = has(d.extra_cost) ? Number(d.extra_cost) : 0;
  const hasCost = d.nat_has_cost || has(d.cost_override);
  const rev = d.cancelled ? 0 : d.revenue;
  d.base_fees = fees;
  d.base_refunds = refunds;
  d.net = hasCost ? r2(rev - fees - d.ad_fees - cost - refunds + amazonRefund - extra) : null;
  // Same rule as the server's `counted`: sheet-covered and pre-partnership sales never count, nor do exclusions
  const notCounted = d.status === 'in_sheet' || d.status === 'before_start';
  const keep = notCounted || ((d.status === 'not_dropship' || d.status === 'needs_review') && !hasCost) || d.status === 'check_sheet' || d.status === 'cancelled' || d.status === 'cancelled_after_purchase';
  d.live_counted = !notCounted && !d.excluded && hasCost && !(d.cancelled && !cost) && d.status !== 'check_sheet';
  d.view_status = keep && !(d.status === 'check_sheet' && hasCost) ? d.status
    : d.excluded ? 'excluded' : !hasCost ? (d.amazon_ids ? 'awaiting_cost' : 'awaiting_email') : d.return_open && !(refunds > 0) ? 'return_open'
    : refunds > 0 || d.total_refund > 0 || d.has_returns ? 'returned' : d.net < 0 ? 'loss' : 'profitable';
  return d;
}
