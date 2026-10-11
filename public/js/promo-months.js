// Sales that came through Promoted Listings, month by month. eBay charges an ad fee on a sale only when the buyer
// clicked a promoted ad, so a counted sale with an ad fee is a promoted sale. The open question for each month is
// how many of those buyers would have bought anyway, so the result is a range: from "none were because of the ad"
// (the fees were wasted) to "all were" (the whole profit on them was gained), plus the break-even point in between.
// Pure module: used by Products → Promotional and by Ask AI, and tested on its own. Money is summed in cents.
const cents = (n) => Math.round((Number(n) || 0) * 100);
const dollars = (c) => c / 100;
const payoutOf = (o) => cents(o.revenue) - cents(o.fees) - cents(o.refunds);
// A refund line or a monthly-sheet refund row is money, not a sale (see metrics.js isSale)
const isSale = (o) => o.source !== 'refund' && !o.ledger?.is_refund;

export function promoMonth(orders, month) {
  const rows = orders.filter((o) => o.counted && o.business_month === month);
  const sales = rows.filter(isSale);
  // A refund line goes with the sale it refunds: an ad sale's refund (and the ad fee eBay gives back) is part of what
  // the ads made. Its money counts there; it is never counted as a sale of its own.
  const adSaleIds = new Set(orders.filter((o) => isSale(o) && cents(o.ad_fees) > 0).map((o) => (o.source === 'ledger' ? o.ebay_order_id : o.order_id)).filter(Boolean));
  const isAd = (o) => (isSale(o) ? cents(o.ad_fees) > 0 : adSaleIds.has(o.source === 'refund' ? o.refund_of : o.ebay_order_id));
  const ad = rows.filter(isAd);
  const other = rows.filter((o) => !isAd(o));
  const adN = ad.filter(isSale).length;
  const otherN = other.filter(isSale).length;
  const sum = (list, f) => list.reduce((t, o) => t + f(o), 0);
  const adFees = sum(ad, (o) => cents(o.ad_fees));
  const adProfit = sum(ad, (o) => cents(o.net)); // after the ad fees
  const otherProfit = sum(other, (o) => cents(o.net));
  const beforeFeesPerSale = adN ? (adProfit + adFees) / adN : 0;
  // How many of the ad sales had to be truly because of the ad for the fees to pay off
  const breakEven = !adFees ? 0 : beforeFeesPerSale > 0 ? Math.min(adN, Math.ceil(adFees / beforeFeesPerSale)) : null;
  return {
    month,
    sales: sales.length,
    adSales: adN,
    otherSales: otherN,
    share: sales.length ? adN / sales.length : null,
    payout: dollars(sum(rows, payoutOf)),
    adPayout: dollars(sum(ad, payoutOf)),
    otherPayout: dollars(sum(other, payoutOf)),
    profit: dollars(adProfit + otherProfit),
    adProfit: dollars(adProfit),
    otherProfit: dollars(otherProfit),
    adFees: dollars(adFees),
    adProfitPerSale: adN ? dollars(Math.round(adProfit / adN)) : null,
    otherProfitPerSale: otherN ? dollars(Math.round(otherProfit / otherN)) : null,
    breakEven,
    worst: adFees ? dollars(-adFees) : 0, // none of the ad buyers needed the ad: the fees were the only effect
    best: dollars(adProfit), // every ad buyer came because of the ad: all of that profit was gained
    list: ad
      .map((o) => ({ title: o.title, date: o.created_at, approxDate: Boolean(o.approx_date), payout: dollars(payoutOf(o)), cost: o.cost, adFee: o.ad_fees, net: o.net }))
      .sort((a, b) => (a.date < b.date ? -1 : 1)),
  };
}

// Every month with counted sales, oldest first
export function promoMonths(orders) {
  const months = [...new Set(orders.filter((o) => o.counted && isSale(o) && o.business_month).map((o) => o.business_month))].sort();
  return months.map((m) => promoMonth(orders, m));
}
