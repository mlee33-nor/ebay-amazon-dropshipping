// "Check a sheet": compares a hand-kept monthly sheet with what the site computed for that payment, line by line,
// without writing anything. From October 2026 sheets are a check on the site, never an input.
import { parse } from 'csv-parse/sync';
import { parseLedgerCsv } from './ledger.js';
import { buildDataset, buildBooks } from './dataset.js';
import { getSetting } from './db.js';
import { settleMonth } from '../public/js/settlement.js';
import { parseMoney } from './amazon.js';

const c = (n) => Math.round((Number(n) || 0) * 100);
const d = (x) => Math.round(x) / 100;
const words = (t) => new Set(String(t || '').toLowerCase().replace(/^refund\s*·\s*/, '').match(/[a-z0-9]{3,}/g) || []);
const overlap = (a, b) => { const A = words(a), B = words(b); let n = 0; for (const w of A) if (B.has(w)) n++; return A.size && B.size ? n / Math.min(A.size, B.size) : 0; };

// A site row in the sheet's terms: payout after eBay's fees (and refunds), Amazon cost net of Amazon refunds, ad fees
const siteLine = (o) => ({
  id: o.order_id, title: o.title, date: o.created_at, source: o.source,
  payout: d(c(o.revenue) - c(o.fees) - c(o.refunds)), cost: d(c(o.cost) - c(o.amazon_refund)), ad: d(c(o.ad_fees)), net: d(c(o.net)),
});

// The sheet's own summary figures (labels as the partners' template writes them)
function sheetSummary(buffer) {
  let text = buffer.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = parse(text, { relax_column_count: true, relax_quotes: true, skip_empty_lines: true });
  const find = (re) => { const r = rows.find((x) => re.test(String(x[0] || ''))); const v = r ? String(r[1] || '').trim() : ''; return v && v !== '-' ? parseMoney(v) : null; };
  return {
    opex: find(/^total operating expenses/i),
    profit: find(/^net business profit/i),
    reimburse: find(/reimbursement/i),
    share: find(/profit share/i),
    sends: find(/sends\s+myles|sends\s+\w+\s*\(/i),
  };
}

export async function checkSheet(buffer, filename) {
  const sheet = parseLedgerCsv(buffer, filename);
  const month = sheet.month;
  const [orders, books] = await Promise.all([buildDataset(), buildBooks()]);
  const split = Number((await getSetting('split_amazon')) ?? 50);
  const site = settleMonth({ month, orders, expenses: books.expenses, settlements: books.settlements, splitAmazon: split });
  const rows = orders.filter((o) => o.counted && o.settle_month === month).map(siteLine);
  const waiting = orders.filter((o) => o.status === 'awaiting_cost' && o.settle_month === month);

  // Pair each sheet line with the site line it describes: by name, then by exact amounts
  const pairs = [];
  for (const e of sheet.entries) for (const r of rows) {
    const name = overlap(e.title, r.title);
    const exact = (Math.abs(c(e.amazon_cost) - c(r.cost)) < 1 ? 0.3 : 0) + (Math.abs(c(e.sale_price) - c(r.payout)) < 1 || Math.abs(c(e.sale_price) - c(r.payout - r.ad)) < 1 ? 0.3 : 0);
    if (name >= 0.34 || (name > 0 && exact >= 0.6)) pairs.push({ e, r, score: name + exact });
  }
  pairs.sort((a, b) => b.score - a.score);
  const usedE = new Set(); const usedR = new Set(); const matched = [];
  for (const p of pairs) { if (usedE.has(p.e) || usedR.has(p.r)) continue; usedE.add(p.e); usedR.add(p.r); matched.push(p); }

  const lines = [];
  for (const e of sheet.entries) {
    const p = matched.find((m) => m.e === e);
    const sheetNet = e.sheet_net ?? d(c(e.sale_price) - c(e.amazon_cost) - c(e.ad_fees));
    const sheetLine = { title: e.title, cost: e.amazon_cost, sale: e.sale_price, ad: e.ad_fees, net: sheetNet, note: e.note };
    if (!p) { lines.push({ status: 'only_on_sheet', sheet: sheetLine, why: ['Not on this payment on the site. It may be awaiting its Amazon cost, on another payment, or not a sale at all.'] }); continue; }
    const r = p.r; const why = [];
    const refundLine = r.source === 'refund';
    // Refund lines: the sheet must enter them as negatives, or its totals add them as a new sale
    if (refundLine && (e.amazon_cost > 0 || e.sale_price > 0)) why.push(`Entered with positive amounts, so the sheet's totals add it as a new sale (cost $${e.amazon_cost.toFixed(2)}, sale $${e.sale_price.toFixed(2)}). Enter a refund as negatives: cost = what Amazon refunded (−$${Math.abs(r.cost).toFixed(2)}), sale = what eBay took back net of any ad fee returned (−${Math.abs(r.payout - r.ad).toFixed(2)}).`);
    const adNetted = !e.ad_fees && r.ad > 0 && Math.abs(c(e.sale_price) - c(r.payout - r.ad)) < 1;
    if (!refundLine) {
      if (Math.abs(c(e.amazon_cost) - c(r.cost)) >= 1) why.push(`Amazon cost: sheet $${e.amazon_cost.toFixed(2)}, site $${r.cost.toFixed(2)}${r.cost === 0 ? '' : ' (from the Amazon order linked to this sale)'}.`);
      if (!adNetted && Math.abs(c(e.sale_price) - c(r.payout)) >= 1) why.push(`eBay payout: sheet $${e.sale_price.toFixed(2)}, site $${r.payout.toFixed(2)} (sale price minus eBay's fees).`);
      if (!adNetted && Math.abs(c(e.ad_fees) - c(r.ad)) >= 1) why.push(e.ad_fees ? `Ad fee: sheet $${e.ad_fees.toFixed(2)}, eBay charged $${r.ad.toFixed(2)}.` : `Ad fee missing: eBay charged a $${r.ad.toFixed(2)} promoted-listing fee.`);
    } else if (!why.length && Math.abs(c(sheetNet) - c(r.net)) >= 1) {
      why.push(`Refund line: sheet $${sheetNet.toFixed(2)}, site $${r.net.toFixed(2)} (what eBay took back${r.ad < 0 ? `, the $${(-r.ad).toFixed(2)} ad fee eBay returned` : ''}${r.cost < 0 ? `, and the $${(-r.cost).toFixed(2)} Amazon refunded Myles` : ''}).`);
    }
    if (refundLine && (e.amazon_cost || 0) === 0 && r.cost < 0) why.push(`The $${(-r.cost).toFixed(2)} Amazon refunded Myles isn't taken off his reimbursement (he was already reimbursed for that purchase).`);
    const note = adNetted ? `Ad fee ($${r.ad.toFixed(2)}) taken out of the sale price instead of the ad column; same profit.` : null;
    lines.push({ status: why.length ? 'differs' : 'matches', sheet: sheetLine, site: r, why, note });
  }
  // Two lines for the same item whose numbers match once swapped: the sheet paired the costs with the wrong orders
  const near = (a, b) => Math.abs(c(a) - c(b)) < 1;
  const fitsSale = (e, r) => (near(e.sale_price, r.payout) || near(e.sale_price, r.payout - r.ad)) && (!e.ad_fees || near(e.ad_fees, r.ad));
  // Each line's sale and ad fee belong to one order and its cost to the other (or the whole lines are swapped)
  const fitsRow = (e, r, other, eo) => (fitsSale(e, r) && near(e.amazon_cost, r.cost)) || (fitsSale(e, r) && near(e.amazon_cost, other.cost) && near(eo.amazon_cost, r.cost));
  const diffs = lines.filter((l) => l.status === 'differs' && l.site && l.site.source !== 'refund');
  for (let i = 0; i < diffs.length; i++) for (let j = i + 1; j < diffs.length; j++) {
    const a = diffs[i], b = diffs[j];
    const ea = sheet.entries.find((e) => e.title === a.sheet.title && e.amazon_cost === a.sheet.cost);
    const eb = sheet.entries.find((e) => e.title === b.sheet.title && e.amazon_cost === b.sheet.cost);
    if (ea && eb && fitsRow(ea, b.site, a.site, eb) && fitsRow(eb, a.site, b.site, ea) && overlap(a.sheet.title, b.sheet.title) >= 0.5) {
      const msg = 'Same item sold twice: the sheet has the two orders\' Amazon costs the other way round (matched here by buyer). The total is the same.';
      for (const l of [a, b]) { l.status = 'matches'; l.why = []; l.note = msg; }
    }
  }
  const onlySite = rows.filter((r) => !usedR.has(r)).map((r) => ({ status: 'only_on_site', site: r, why: [r.source === 'refund' ? 'A refund on this payment that the sheet leaves out.' : 'A sale on this payment that the sheet leaves out.'] }));

  // The sheet's own arithmetic
  const sum = sheetSummary(buffer);
  const structural = [];
  const colNet = d(sheet.entries.reduce((t, e) => t + c(e.sheet_net ?? (e.sale_price - e.amazon_cost - e.ad_fees)), 0));
  const totalsNet = d(c(sheet.computed.sale) - c(sheet.computed.cost) - c(sheet.computed.ad));
  if (Math.abs(c(colNet) - c(totalsNet)) >= 1) structural.push(`The sheet disagrees with itself: its line profits add up to $${colNet.toFixed(2)}, but its totals (sale − cost − ad) give $${totalsNet.toFixed(2)}. Usually a refund line typed with positive amounts.`);
  for (const ch of sheet.checks.filter((x) => !x.ok)) structural.push(`"Total Transactions" ${ch.field}: the sheet says $${Number(ch.sheet).toFixed(2)} but its lines add up to $${ch.computed.toFixed(2)}.`);
  if (sum.opex !== null && Math.abs(c(sum.opex) - c(site.opex)) >= 1) structural.push(`Operating costs: sheet $${sum.opex.toFixed(2)}, site $${site.opex.toFixed(2)}.`);

  const sheetSends = sum.sends;
  return {
    month, filename,
    site: { orders: site.orders, collected: site.collected, cogs: site.cogs, adFees: site.adFees, opex: site.opex, businessProfit: site.businessProfit, sellerSends: site.sellerSends, paid: site.paid },
    sheet: { lines: sheet.entries.length, cost: sheet.computed.cost, sale: sheet.computed.sale, ad: sheet.computed.ad, opex: sum.opex, profit: sum.profit, sends: sheetSends },
    difference: sheetSends === null ? null : d(c(sheetSends) - c(site.sellerSends)),
    counts: { matches: lines.filter((l) => l.status === 'matches').length, differs: lines.filter((l) => l.status === 'differs').length, onlyOnSheet: lines.filter((l) => l.status === 'only_on_sheet').length, onlyOnSite: onlySite.length },
    lines: [...lines, ...onlySite],
    structural,
    waiting: waiting.map((o) => ({ id: o.order_id, title: o.title, date: o.created_at })),
  };
}
