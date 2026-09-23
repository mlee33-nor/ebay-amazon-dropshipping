// Partner settlement, same logic as the monthly sheet:
//   Net business profit = eBay payouts - Amazon COGS - eBay/ad fees - operating expenses
//   Amazon partner (pays Amazon COGS) is reimbursed COGS (+ any expenses they paid) plus their profit share.
//   eBay partner (collects eBay payouts, pays operating expenses) sends that amount.
// Pure module: used by the dashboard and by the tests. Money is summed in cents to match the sheet's rounding.

const cents = (n) => Math.round((Number(n) || 0) * 100);
const dollars = (c) => c / 100;

export const monthKey = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

// The server decides each row's business month (Arizona time), so every viewer settles the same way
const rowMonth = (o) => o.business_month || monthKey(o.created_at);

export function settleMonth({ month, orders, expenses, settlements = [], splitAmazon = 50 }) {
  const rows = orders.filter((o) => o.counted && rowMonth(o) === month);
  let collected = 0; // what the eBay partner actually received: revenue - eBay final value fees - buyer refunds
  let cogs = 0; // what the Amazon partner paid Amazon, net of Amazon refunds
  let adFees = 0;
  let otherCosts = 0; // per-order extra costs entered in the Editor (paid by the eBay partner)
  let finalValueFees = 0;
  for (const o of rows) {
    collected += cents(o.revenue) - cents(o.fees) - cents(o.refunds);
    finalValueFees += cents(o.fees);
    cogs += cents(o.cost) - cents(o.amazon_refund);
    adFees += cents(o.ad_fees);
    otherCosts += cents(o.extra_cost);
  }
  const monthExpenses = expenses.filter((e) => e.month === month);
  const opexSeller = monthExpenses.filter((e) => e.paid_by !== 'amazon').reduce((s, e) => s + cents(e.amount), 0);
  const opexAmazon = monthExpenses.filter((e) => e.paid_by === 'amazon').reduce((s, e) => s + cents(e.amount), 0);
  const orderProfit = collected - cogs - adFees - otherCosts;
  const businessProfit = orderProfit - opexSeller - opexAmazon;
  const shareAmazon = Math.round((businessProfit * splitAmazon) / 100);
  const shareSeller = businessProfit - shareAmazon;
  const sellerSends = cogs + opexAmazon + shareAmazon;
  const st = settlements.find((s) => s.month === month);
  const paid = st?.paid === null || st?.paid === undefined ? null : cents(st.paid);
  return {
    month,
    orders: rows.length,
    collected: dollars(collected),
    finalValueFees: dollars(finalValueFees),
    cogs: dollars(cogs),
    adFees: dollars(adFees),
    otherCosts: dollars(otherCosts),
    orderProfit: dollars(orderProfit),
    opexSeller: dollars(opexSeller),
    opexAmazon: dollars(opexAmazon),
    opex: dollars(opexSeller + opexAmazon),
    businessProfit: dollars(businessProfit),
    shareAmazon: dollars(shareAmazon),
    shareSeller: dollars(shareSeller),
    sellerSends: dollars(sellerSends),
    paid: paid === null ? null : dollars(paid),
    paidAt: st?.paid_at || null,
    note: st?.note || '',
    balance: dollars(sellerSends - (paid || 0)),
    expenses: monthExpenses,
  };
}

export function allMonths(orders, expenses) {
  const set = new Set([...orders.filter((o) => o.counted).map(rowMonth), ...expenses.map((e) => e.month)]);
  return [...set].sort();
}
