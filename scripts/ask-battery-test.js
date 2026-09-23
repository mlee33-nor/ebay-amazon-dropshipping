// Ask AI question battery: everyday phrasings (typos included) must be read as the right topic and period, with
// no help from the AI model. Throwaway database with the real monthly sheets plus a few eBay sales.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-battery-'));
process.env.LOCAL_PG_DIR = dir;
process.env.LOCAL_PG_PORT = '5444';
delete process.env.DATABASE_URL;
const { initDb, q, closeDb } = await import('../src/db.js');
const { importLedgerCsv } = await import('../src/ledger.js');
const { normalizeOrder, upsertOrder } = await import('../src/ebay.js');
const { ask } = await import('../src/ask.js');
await initDb();
const sheetDir = process.env.LEDGER_SHEETS_DIR || path.resolve('private');
for (const m of ['JUL', 'AUG', 'SEP']) await importLedgerCsv(fs.readFileSync(path.join(sheetDir, `sheet-${m}-26.csv`)), `sheet ${m} 26.csv`);
await q("insert into settlements (month, paid, paid_at) values ('2026-07', 217.63, '2026-07-26'), ('2026-08', 1304.76, '2026-09-01') on conflict (month) do nothing");
// A sale from an hour ago with no Amazon order yet (it must show as waiting, never counted)
await upsertOrder(normalizeOrder({
  orderId: 'WAIT-1', creationDate: new Date(Date.now() - 3600_000).toISOString(), orderFulfillmentStatus: 'NOT_STARTED', cancelStatus: { cancelState: 'NONE_REQUESTED' },
  pricingSummary: { priceSubtotal: { value: '90.24' }, total: { value: '90.24' } }, totalMarketplaceFee: { value: '12.27' },
  fulfillmentStartInstructions: [{ shippingStep: { shipTo: { fullName: 'Pat Doe', contactAddress: { city: 'Mesa', stateOrProvince: 'AZ' } } } }],
  lineItems: [{ lineItemId: 'WAIT-1-1', title: '8 Packs 16 Grit Blue Zirconia Cloth Flap Discs', quantity: 1, lineItemCost: { value: '90.24' }, total: { value: '90.24' } }],
}));

// [question, topic it must be read as, text the period label must contain (or null for "no period")]
const CASES = [
  // profit
  ['how much did we make this month', 'profit', 'this month'],
  ['whats our profit so far', 'profit', 'this month'],
  ['how are we doing', 'profit', 'this month'],
  ['how much money did we make in august', 'profit', 'August 2026'],
  ['total profit since we started', 'profit', 'all time'],
  ['profit last week', 'profit', 'last week'],
  ['how much did we make yesterday', 'profit', 'yesterday'],
  ['net profit for july', 'profit', 'July 2026'],
  ['hows business', 'profit', 'this month'],
  ['how much have we made overall', 'profit', 'all time'],
  ['profit this year', 'profit', 'this year'],
  ['what was our profit in the last 30 days', 'profit', 'last 30 days'],
  ['profit past two weeks', 'profit', 'last 2 weeks'],
  ['how much proft did we make in agust', 'profit', 'August 2026'],
  ['what did we clear in september', 'profit', 'September 2026'],
  ['whats the bottom line for july', 'profit', 'July 2026'],
  // counts
  ['how many sales did we get today', 'count', 'today'],
  ['how many orders this month', 'count', 'this month'],
  ['number of sales in august', 'count', 'August 2026'],
  ['how many items did we sell last week', 'count', 'last week'],
  ['did we sell anything today', 'count', 'today'],
  ['how many sales yesterday', 'count', 'yesterday'],
  // revenue
  ['whats our revenue this month', 'revenue', 'this month'],
  ['how much did ebay pay us in september', 'revenue', 'September 2026'],
  ['total sales in august', 'revenue', 'August 2026'],
  ['gross sales this year', 'revenue', 'this year'],
  ['how much did we bring in last month', 'revenue', 'last month'],
  // settlement
  ['what does drew owe me', 'settlement', null],
  ['how much does drew owe myles', 'settlement', null],
  ['did drew pay for august', 'settlement', 'August 2026'],
  ['when is the next payment due', 'settlement', null],
  ['how much has drew paid me in total', 'settlement', null],
  ['is september settled', 'settlement', 'September 2026'],
  ['what do i owe drew', 'settlement', null],
  ['has drew sent the money for july', 'settlement', 'July 2026'],
  ['whats owed', 'settlement', null],
  // Amazon cost
  ['how much did we spend on amazon this month', 'cogs', 'this month'],
  ['amazon costs in august', 'cogs', 'August 2026'],
  ['what did myles spend on amazon in september', 'cogs', 'September 2026'],
  ['cost of goods for july', 'cogs', 'July 2026'],
  // fees
  ['how much are we paying in ad fees', 'fees', 'this month'],
  ['ebay fees this month', 'fees', 'this month'],
  ['promoted listing fees in august', 'fees', 'August 2026'],
  // margin / average
  ['whats our margin', 'margin', 'this month'],
  ['roi this month', 'margin', 'this month'],
  ['profit margin in august', 'margin', 'August 2026'],
  ['average profit per sale', 'aov', 'this month'],
  ['whats our average order value in july', 'aov', 'July 2026'],
  // refunds
  ['how many returns this month', 'refunds', 'this month'],
  ['refunds in august', 'refunds', 'August 2026'],
  ['which orders got refunded in september', 'refunds', 'September 2026'],
  ['how much have we lost to returns', 'refunds', 'this month'],
  ['any cancellations this month', 'refunds', 'this month'],
  // operating costs
  ['what are our operating costs', 'expenses', 'this month'],
  ['how much do we spend on software', 'expenses', 'this month'],
  ['what subscriptions do we pay for', 'expenses', 'this month'],
  ['expenses in august', 'expenses', 'August 2026'],
  ['how much are proxies costing us', 'expenses', 'this month'],
  // products
  ['best selling product', 'top', 'all time'],
  ['whats our most profitable item', 'top', 'all time'],
  ['top products this month', 'top', 'this month'],
  ['worst products', 'worst', 'all time'],
  ['which products lose money', 'worst', 'all time'],
  ['what should we stop selling', 'worst', 'all time'],
  ['which item made the most money in august', 'top', 'August 2026'],
  ['how is the ukulele doing', 'product', 'all time'],
  ['how much did we make on the kala ukulele', 'product', 'all time'],
  ['how many vitaliq serums did we sell', 'count', 'all time'],
  // comparisons
  ['august vs september', 'compare', 'August 2026 vs September 2026'],
  ['compare this month to last month', 'compare', 'vs'],
  ['is september better than august', 'compare', 'vs'],
  ['how does september compare to august', 'compare', 'vs'],
  ['july and august profit', 'compare', 'vs'],
  // why
  ['why are we down this month', 'why', 'this month'],
  ['why is profit low', 'why', 'this month'],
  ['why did august do better than july', 'why', 'August 2026'],
  ['what happened this month', 'why', 'this month'],
  ['why are sales so slow', 'why', 'this month'],
  ['explain septembers numbers', 'why', 'September 2026'],
  // listings
  ['how many listings do we have', 'listings', null],
  ['why do we have more listings but fewer sales', 'listings_vs_sales', null],
  ['which listings get the most views', 'listings', null],
  ['what should we delist', 'listings', null],
  ['how many listings did we post this month', 'listings', 'this month'],
  ['how many watchers do we have', 'listings', null],
  // lists of sales
  ['last sale', 'recent', null],
  ['what sold today', 'recent', 'today'],
  ['show me the latest orders', 'recent', null],
  ['last 10 sales', 'recent', null],
  ['what did we sell on sep 14', 'recent', 'Sep 14'],
  ['what sold 9/12', 'recent', 'Sep 12'],
  // waiting for Amazon
  ['which sales are waiting for amazon', 'awaiting', null],
  ['any orders not ordered on amazon yet', 'awaiting', null],
  ['what havent we bought yet', 'awaiting', null],
  ['unmatched sales', 'awaiting', null],
  ['what still needs to be ordered', 'awaiting', null],
  // best / worst periods
  ['what was our best day', 'best_period', 'all time'],
  ['worst month', 'best_period', 'all time'],
  ['best week in september', 'best_period', 'September 2026'],
  // promotions
  ['how many items are promoted', 'promotions', null],
  ['what percent of our listings are not promoted', 'promotions', null],
  ['which campaigns are running', 'promotions', null],
  ['are we promoting enough', 'promotions', null],
  ['whats our average ad rate', 'promotions', null],
  // help
  ['what can you do', 'help', null],
  ['hi', 'help', null],
];

let failed = 0;
const rows = [];
for (const [question, topic, period] of CASES) {
  let a;
  try { a = await ask(question); } catch (e) { failed++; rows.push(`  FAIL  "${question}": threw ${e.message}`); continue; }
  if (process.env.ASK_PRINT && (!process.env.ASK_PRINT.length || process.env.ASK_PRINT === '1' || question.includes(process.env.ASK_PRINT))) console.log(`
> ${question}
  [${a.understood ? `${a.understood.label} · ${a.understood.period || '-'}` : 'help'}]
  ${a.text}${(a.bullets || []).map((b) => `
   - ${b}`).join('')}${a.table ? `
   | ${a.table.head.join(' | ')}${a.table.rows.slice(0, 4).map((r) => `
   | ${r.join(' | ')}`).join('')}` : ''}`);
  const got = a.understood?.topic || 'help';
  const gotPeriod = a.understood?.period || null;
  const okTopic = got === topic;
  const okPeriod = period === null ? true : Boolean(gotPeriod && gotPeriod.includes(period));
  if (!okTopic || !okPeriod) { failed++; rows.push(`  FAIL  "${question}": read as ${got} · ${gotPeriod || 'no period'} (wanted ${topic} · ${period || 'any'})`); }
}

// Answers that must carry specific facts
const must = async (question, re, label) => {
  const a = await ask(question);
  const all = [a.text, ...(a.bullets || []), ...(a.table ? a.table.rows.flat() : [])].join('\n');
  if (!re.test(all)) { failed++; rows.push(`  FAIL  ${label}\n        ${all.slice(0, 300)}`); }
};
await must('how many sales did we get today', /awaiting the Amazon email/, 'today counts the new sale as awaiting the Amazon email (not counted)');
await must('which sales are waiting for amazon', /Zirconia/, 'the waiting list shows the new sale');
await must('how much has drew paid me in total', /paid Myles \$1,522\.39 so far/, 'total paid is July + August ($217.63 + $1,304.76)');
await must('what does drew owe me', /Drew owes Myles \$625\.65/, 'owed is September only');
await must('is september better than august', /^\*\*No: September 2026 so far is behind/, 'a yes/no question gets a yes/no first');
await must('last sale', /^\*\*Latest sale: /, '"last sale" is one sale');
await must('worst products', /lost money/, 'worst products only lists products that lost money');
await must('how many sales did we get today', /^\*\*1 sale today\.\*\* 0 counted in profit, 1 awaiting the Amazon email/, 'the new sale is counted as waiting');
await must('did drew pay for august', /Paid in full/, 'August shows paid in full');
await must('how much did ebay pay us in august', /eBay payouts/, 'eBay payouts, not the settlement');
await must('how much money did we make in august', /\$129\.49/, 'August business profit equals the sheet');
await must('what did we clear in july', /−\$27\.56/, 'July business profit equals the sheet');

console.log(rows.join('\n'));
console.log(`\n${CASES.length - rows.filter((r) => r.includes('" read as') || r.includes('": threw') || r.includes('": read')).length}/${CASES.length} questions read correctly`);
await closeDb();
fs.rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\nASK BATTERY: ${failed} FAILED` : '\nASK BATTERY: ALL CHECKS PASSED');
process.exitCode = failed ? 1 : 0;
