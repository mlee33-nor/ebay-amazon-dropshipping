// The assistant's figures must be exactly the dashboard's. Throwaway database with the real monthly sheets.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-ask-'));
process.env.LOCAL_PG_DIR = dir;
process.env.LOCAL_PG_PORT = String(5600 + Number(process.env.TEST_PG_400 || process.env.TEST_PG_OFFSET || 0)); // parallel runs use their own ports
delete process.env.DATABASE_URL;
const { initDb, q, closeDb } = await import('../src/db.js');
const { importLedgerCsv } = await import('../src/ledger.js');
const { ask, _test } = await import('../src/ask.js');
await initDb();
const sheetDir = process.env.LEDGER_SHEETS_DIR || path.resolve('private');
for (const m of ['JUL', 'AUG', 'SEP']) await importLedgerCsv(fs.readFileSync(path.join(sheetDir, `sheet-${m}-26.csv`)), `sheet ${m} 26.csv`);
await q("insert into settlements (month, paid, paid_at) values ('2026-08', 1304.76, '2026-09-01') on conflict (month) do update set paid = excluded.paid, paid_at = excluded.paid_at");

let failed = false;
const check = async (label, fn) => { try { await fn(); console.log(`  PASS  ${label}`); } catch (e) { failed = true; console.log(`  FAIL  ${label}\n        ${e.message}`); } };
const all = (a) => [a.text, ...(a.bullets || []), ...(a.table ? a.table.rows.flat() : [])].join('\n');

await check('periods: months, typos-free words, relative ranges (Arizona days)', async () => {
  const p = _test.parsePeriods('profit in august vs september', '2026-09-22');
  assert.equal(p[0].month, '2026-08');
  assert.equal(p[1].month, '2026-09');
  assert.equal(_test.parsePeriods('last 7 days', '2026-09-22')[0].from, '2026-09-16');
  assert.equal(_test.parsePeriods('last month', '2026-09-22')[0].month, '2026-08');
  assert.equal(_test.parsePeriods('in december', '2026-09-22')[0].month, '2025-12');
  assert.equal(_test.parsePeriods('we may have sold more', '2026-09-22').length, 0);
});
await check('"how much profit did we make in august" = sheet business profit $129.49', async () => {
  const a = await ask('how much profit did we make in august');
  assert.match(a.text, /\$129\.49/);
});
await check('typos: "how much proft in agust" still answers August', async () => {
  const a = await ask('how much proft did we make in agust');
  assert.match(a.text, /\$129\.49/);
});
await check('follow-up: "what about july?" keeps the topic', async () => {
  const first = await ask('profit in august');
  const a = await ask('what about july?', first.context);
  assert.match(a.text, /−\$27\.56/);
});
await check('settlement for August: $1,304.76 and paid', async () => {
  const a = await ask('what did drew owe myles for august');
  assert.match(a.text, /\$1,304\.76/);
  assert.match(a.text, /Paid/);
});
await check('settlement is due the 26th of the same month', async () => {
  const a = await ask('what does drew owe for september');
  assert.match(a.text, /\$625\.65/);
  assert.match(a.text, /due Sep 26/);
});
await check('route from the local model: {topic: settlement, period: august}', async () => {
  const a = await ask('did he pay for that month', null, { topic: 'settlement', period: 'august', compare_to: '', product: '' });
  assert.match(a.text, /\$1,304\.76/);
});
await check('compare August vs September: business profit row matches the sheets', async () => {
  const a = await ask('compare august vs september');
  const row = a.table.rows.find((r) => r[0] === 'Business profit');
  assert.equal(row[1], '$129.49');
  assert.equal(row[2], '$104.88');
});
await check('why: the two drivers add up to the change exactly', async () => {
  const a = await ask('why was september worse than august', null, { topic: 'why_change', period: 'september', compare_to: '', product: '' });
  const m = all(a).match(/, (?:up|down) \$([\d,.]+)/);
  assert.ok(m, all(a));
  const drivers = [...all(a).matchAll(/that's \*\*([+−])\$([\d,.]+)\*\*|worth \*\*([+−])\$([\d,.]+)\*\*/g)]
    .map((x) => (x[1] || x[3]) === '−' ? -Number((x[2] || x[4]).replace(/,/g, '')) : Number((x[2] || x[4]).replace(/,/g, '')));
  const change = Number(m[1].replace(/,/g, ''));
  assert.equal(Math.round(Math.abs(drivers.reduce((t, x) => t + x, 0)) * 100), Math.round(change * 100));
});
await check('a wrong assumption is corrected first: "why are we up in september" when September is down', async () => {
  const a = await ask('why are we up in september', null, { topic: 'why_change', period: 'september', compare_to: '', product: '' });
  assert.match(a.text, /^\*\*We're actually down, not up\./);
  assert.equal(a.trend, 'down');
});
await check('listings vs sales without eBay views: listings grew faster than orders (live numbers from Sep 22)', async () => {
  const a = _test.listingsVsSales({
    totals: { activeListings: 7355 }, stale: { count: 4246, criteria: { viewsBelowMedian: null } },
    drivers: { listings: { current: 5474.97, previous: 2033.87 }, newListings: { current: 3062, previous: 3630 }, orders: { current: 49, previous: 28 },
      impressions: { current: null, previous: null }, views: { current: null, previous: null }, viewsPerListing: { current: null, previous: null } },
  });
  assert.match(a.text, /listings grew faster than sales/i);
  assert.match(a.text, /13.8 → 9.0 orders per 1,000 listings|13.8 → 8.9 orders per 1,000 listings/);
  assert.ok(!/steady/.test(a.text), 'never claims traffic is steady without traffic data');
  assert.ok(a.bullets.some((b) => /4,?246 listings/.test(b)));
});
await check('listings vs sales with eBay views: the funnel names visibility as the problem (live numbers from Sep 23)', async () => {
  const a = _test.listingsVsSales({
    totals: { activeListings: 7376 }, stale: { count: 3900, criteria: { viewsRule: 'no views at all' } },
    drivers: { listings: { current: 5577.73, previous: 2154.77 }, newListings: { current: 3106, previous: 3627 }, impressions: { current: 421990, previous: 383425 },
      views: { current: 3639, previous: 2251 }, viewsPerListing: { current: 0.65, previous: 1.04 }, orders: { current: 48, previous: 30 } },
  });
  assert.match(a.text, /eBay is barely showing the new listings/);
  assert.match(a.text, /159% more listings on average, but they were shown in search only 10% more/);
  assert.match(a.text, /178 → 76 times shown per listing/);
  assert.match(a.text, /buy at the same rate/);
  assert.ok(!/same views/.test(a.text), 'never claims views stayed the same when they rose');
  assert.ok(a.bullets.some((b) => /3,900 listings have been live 30\+ days with no sales and no views at all/.test(b)));
});
await check('top products all time: a table with profit per product', async () => {
  const a = await ask('what are our best products');
  assert.ok(a.table.rows.length >= 3);
});
await check('product lookup: "how much did we make on the ukulele"', async () => {
  const a = await ask('how much did we make on the ukulele');
  assert.match(a.text, /Ukulele/i);
});
await check('unknown question gets help, not a made-up number', async () => {
  const a = await ask('what colour is the sky');
  assert.ok(!/\$\d/.test(a.text));
});

// ---- The production books on Oct 10 (scripts/fixtures: money, dates and titles only), with the audit's real numbers:
// September payment $719.55 with $704.40 paid ($15.15 open), October so far $240.87 and −$15.07 business profit
const snap = JSON.parse(fs.readFileSync(path.resolve('scripts/fixtures/ask-snapshot-2026-10-10.json'), 'utf8'));
const data = { orders: snap.orders, books: snap.books, today: snap.today };
const askSnap = (q, prev = null, route = null) => ask(q, prev, route, { modelFirst: Boolean(route), data });

await check('"did drew pay me for the fishing line": Partly, the Dorisea sale adds $14.85 to the September payment, $15.15 still owed', async () => {
  const a = await askSnap('did drew pay me for the fishing line');
  assert.match(a.text, /^\*\*Partly/);
  assert.match(a.text, /16-15194-64325/);
  assert.match(a.text, /September payment/);
  assert.match(a.text, /\*\*\$14\.85\*\*/);
  assert.match(a.text, /\$15\.15 is still owed/);
  assert.ok(!/^\*\*Yes/.test(a.text));
});
await check('"drew paid me for that fisihing line" (a statement, with a typo) points to the Settle page', async () => {
  const a = await askSnap('drew paid me for that fisihing line');
  assert.match(a.text, /^\*\*Partly/);
  assert.ok(a.bullets.some((b) => /Settle page/.test(b)));
});
await check('"did drew pay me" with $15.15 open on September says Partly, never Yes', async () => {
  const a = await askSnap('did drew pay me');
  assert.match(a.text, /^\*\*Partly: \$15\.15 still owed\.\*\*/);
  assert.match(a.text, /\$704\.40 on Sep 27 of the \$719\.55/);
});
await check('"did drew pay for august/october": Yes, in full / Not yet', async () => {
  assert.match((await askSnap('did drew pay me for august')).text, /^\*\*Yes, in full\.\*\*/);
  assert.match((await askSnap('did drew pay for october')).text, /^\*\*Not yet\.\*\*/);
  assert.match((await askSnap('did drew pay me for september')).text, /^\*\*Partly/);
});
await check('"what does drew owe me" after a product question is the whole picture, not the product', async () => {
  const first = await askSnap('did drew pay me for the fishing line');
  const a = await askSnap('what does drew owe me', first.context);
  assert.match(a.text, /Drew owes Myles \$15\.15 now/);
});
await check('"profit since sept 27" is the October pay cycle so far: −$15.07 (not the single day Sep 27)', async () => {
  const a = await askSnap('profit since sept 27');
  assert.equal(a.understood.topic, 'profit');
  assert.match(a.text, /−\$15\.07/);
  assert.match(a.understood.period, /October pay cycle/);
});
await check('"profit from sep 27 to oct 10" is one span, not a comparison', async () => {
  const a = await askSnap('profit from sep 27 to oct 10');
  assert.equal(a.understood.topic, 'profit');
  assert.match(a.text, /−\$15\.07/);
});
await check('"how many sales between 9/27 and 10/10": 19 sales (18 counted + 1 waiting); the 2 refund lines are not sales', async () => {
  const a = await askSnap('how many sales between 9/27 and 10/10');
  assert.equal(a.understood.topic, 'count');
  assert.match(a.text, /^\*\*19 sales/);
  assert.match(a.text, /18 counted in profit/);
  assert.match(a.text, /2 refunds on earlier sales/);
});
await check('a span that is not a whole cycle stays a plain date range ("Oct 1 to Oct 5")', async () => {
  const p = _test.parsePeriods('profit from oct 1 to oct 5', '2026-10-10');
  assert.equal(p.length, 1);
  assert.deepEqual([p[0].from, p[0].to, p[0].cycle], ['2026-10-01', '2026-10-05', undefined]);
  const c = _test.parsePeriods('compare sep 27 to oct 10', '2026-10-10');
  assert.equal(c.length, 2, '"compare" keeps two days');
  const m = _test.parsePeriods('profit from july to september', '2026-10-10');
  assert.deepEqual([m.length, m[0].from, m[0].to], [1, '2026-07-01', '2026-09-30']);
});
await check('"september pay cycle" / "october pay period" are those pay cycles ($131.95, not the calendar month\'s $167.87)', async () => {
  const s = await askSnap('profit for the september pay cycle');
  assert.match(s.text, /\$131\.95/);
  assert.ok(!/\$167\.87/.test(s.text));
  assert.match((await askSnap('how much did we make in the october pay period')).text, /−\$15\.07/);
  assert.equal(_test.parsePeriods('pay cycle for august', '2026-10-10')[0].cycle, '2026-08');
});
await check('model-routed follow-up keeps the period: "what about refunds" after September = 4 refunds, $11.49', async () => {
  const first = await askSnap('how much did we make in september');
  const a = await askSnap('what about refunds', first.context, { topic: 'refunds', period: '', compare_to: '', product: '' });
  assert.match(a.text, /4 refunds in September 2026: \$11\.49 lost/);
});
await check('model-routed follow-up keeps the product: "and in september?" after the HHLPRO = its September sale', async () => {
  const first = await askSnap('how is the hhlpro doing');
  assert.match(first.text, /−\$3\.10 profit all time/);
  const a = await askSnap('and in september?', first.context, { topic: 'product', period: 'september', compare_to: '', product: '' });
  assert.match(a.text, /HHLPRO/);
  assert.match(a.text, /\$16\.53/);
});
await check('"fishing lines" is the Dorisea fishing line only, not the "Baitcasting Fishing Reel Holder"', async () => {
  const a = await askSnap('how many fishing lines did we sell');
  assert.match(a.text, /^\*\*1 sale of “Dorisea/);
  assert.equal(a.understood.product, 'fishing line');
});
await check('refund lines are not sales: October so far is 14 sales, average over 14, no "Refund ·" product', async () => {
  const c = await askSnap('how many sales in october');
  assert.match(c.text, /14 counted in profit/);
  assert.match((await askSnap('average sale in october')).text, /across 14 sales/);
  const w = await askSnap('worst products');
  assert.ok(!all(w).includes('Refund ·'));
  const h = w.table.rows.find((r) => /^HHLPRO/.test(r[0]));
  assert.deepEqual([h[1], h[3]], ['1', '−$3.10']); // the $16.53 sale and the −$19.63 refund line together
  assert.ok(!all(await askSnap('what sold in october')).includes('Refund ·'));
});
await check('operating costs with no period are this pay cycle, listed with who paid them', async () => {
  const a = await askSnap('what are our operating costs');
  assert.match(a.understood.period, /^this pay cycle/);
  assert.match(a.text, /\$208\.95/);
  assert.deepEqual(a.table.head, ['Month', 'Expense', 'Paid by', 'Amount']);
  assert.equal(a.table.rows.length, 4);
  assert.ok(a.table.rows.every((r) => r[0] === 'Oct 2026' && r[2] === 'Drew'));
});
await check('"operating costs last pay cycle" lists only that payment\'s month', async () => {
  const a = await askSnap('operating costs last pay cycle');
  assert.match(a.text, /\$116\.07/);
  assert.ok(a.table.rows.every((r) => r[0] === 'Sep 2026'));
});
await check('"how much are proxies costing us" finds the "Proxy" cost; a Myles-paid cost says Drew pays it back', async () => {
  const a = await askSnap('how much are proxies costing us');
  assert.match(a.text, /^\*\*Proxy this pay cycle .*: \$4\.00\.\*\* Drew paid it\./);
  const books = { ...snap.books, expenses: snap.books.expenses.map((e) => (e.category === 'Proxy' ? { ...e, paid_by: 'amazon' } : e)) };
  const b = await ask('how much are proxies costing us', null, null, { data: { ...data, books } });
  assert.match(b.text, /Myles paid it, and Drew pays \$4\.00 back in the settlement/);
});
await closeDb();
fs.rmSync(dir, { recursive: true, force: true });
console.log(failed ? '\nASK: FAILED' : '\nASK: ALL CHECKS PASSED');
process.exitCode = failed ? 1 : 0;
