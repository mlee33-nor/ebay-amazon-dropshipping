// The assistant's figures must be exactly the dashboard's. Throwaway database with the real monthly sheets.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-ask-'));
process.env.LOCAL_PG_DIR = dir;
process.env.LOCAL_PG_PORT = '5445';
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
  assert.match(a.text, /listings grew faster than sales/);
  assert.match(a.text, /13.8 → 9.0 orders per 1,000 listings|13.8 → 8.9 orders per 1,000 listings/);
  assert.ok(!/steady/.test(a.text), 'never claims traffic is steady without traffic data');
  assert.ok(a.bullets.some((b) => /4,?246 listings/.test(b)));
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
await closeDb();
fs.rmSync(dir, { recursive: true, force: true });
console.log(failed ? '\nASK: FAILED' : '\nASK: ALL CHECKS PASSED');
process.exitCode = failed ? 1 : 0;
