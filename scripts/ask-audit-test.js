// Ask AI audit checks (plan items 24-27 and the review after them): honest "did Drew pay", settlement wording that
// is not a product, date ranges and pay cycles, refund lines that are money but not sales, operating costs by pay
// cycle, and the number guard on the AI model's line. Two sources of data: the production books on Oct 10
// (scripts/fixtures: money, dates and titles only) with the audit's real numbers, and a throwaway database with the
// real monthly sheets.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-ask-audit-'));
process.env.LOCAL_PG_DIR = dir;
process.env.LOCAL_PG_PORT = String(5600 + Number(process.env.TEST_PG_OFFSET || 0)); // TEST_PG_OFFSET lets parallel runs use their own ports
delete process.env.DATABASE_URL;
// A stand-in AI model (only the router's request is looked at here)
const seen = [];
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    seen.push(JSON.parse(body || '{}'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '{"topic":"profit","period":"","compare_to":"","product":""}' } }] }));
  });
});
await new Promise((r) => mock.listen(0, r));
process.env.AI_API_BASE = `http://127.0.0.1:${mock.address().port}/v1/`;
process.env.AI_API_KEY = 'test-key';
process.env.ANTHROPIC_API_KEY = ''; // a real key in .env is never used by tests

const { initDb, q, closeDb } = await import('../src/db.js');
const { importLedgerCsv } = await import('../src/ledger.js');
const { ask, _test } = await import('../src/ask.js');
const { checkReply, routeQuestion } = await import('../src/llm.js');
const { answerParts } = await import('../public/js/ask-answer.js');

let failed = false;
const check = async (label, fn) => { try { await fn(); console.log(`  PASS  ${label}`); } catch (e) { failed = true; console.log(`  FAIL  ${label}\n        ${e.message}`); } };
const all = (a) => [a.text, ...(a.bullets || []), ...(a.table ? a.table.rows.flat() : [])].join('\n');
const cents = (n) => Math.round((Number(n) || 0) * 100);

// ---- The production books on Oct 10: September payment $719.55 with $704.40 paid ($15.15 open), October so far
// $240.87 and −$15.07 business profit
const snap = JSON.parse(fs.readFileSync(path.resolve('scripts/fixtures/ask-snapshot-2026-10-10.json'), 'utf8'));
const data = { orders: snap.orders, books: snap.books, today: snap.today };
const askSnap = (question, prev = null, route = null, extra = {}) => ask(question, prev, route, { modelFirst: Boolean(route), data: { ...data, ...extra } });

// -------- "Did Drew pay?"
await check('"did drew pay me for the fishing line": Partly, the Dorisea sale adds $14.85 to the September payment, $15.15 still owed', async () => {
  const a = await askSnap('did drew pay me for the fishing line');
  assert.match(a.text, /^\*\*Partly/);
  assert.match(a.text, /16-15194-64325/);
  assert.match(a.text, /September payment/);
  assert.match(a.text, /\*\*\$14\.85\*\*/);
  assert.match(a.text, /\$15\.15 is still owed/);
});
await check('"drew paid me for that fisihing line" (a statement, with a typo, named after "for") points to the Settle page', async () => {
  const a = await askSnap('drew paid me for that fisihing line');
  assert.match(a.text, /^\*\*Partly/);
  assert.match(a.text, /Dorisea/);
  assert.ok(a.bullets.some((b) => /Settle page/.test(b)));
});
await check('"did drew pay me" with $15.15 open on September says Partly, never Yes', async () => {
  const a = await askSnap('did drew pay me');
  assert.match(a.text, /^\*\*Partly: \$15\.15 still owed\.\*\*/);
  assert.match(a.text, /\$704\.40 on Sep 27 of the \$719\.55/);
});
await check('settlement wording is never a product: "pay me back" (not the "Black" fabric roll), "cover the shortfall" (not the spool cover)', async () => {
  for (const question of ['did drew pay me back', 'did drew pay me back for the proxy', 'did drew cover the shortfall', 'has drew sent the rest', 'did drew pay the balance']) {
    const a = await askSnap(question);
    assert.match(a.text, /^\*\*Partly: \$15\.15 still owed\.\*\*/, `${question}: ${a.text.slice(0, 120)}`);
    assert.ok(!/Ableme|PEHUAP/.test(a.text), `${question} answered about a product`);
    assert.equal(a.understood.product, null, question);
  }
});
await check('"did drew pay for august/october/september": Yes, in full / Not yet / Partly', async () => {
  assert.match((await askSnap('did drew pay me for august')).text, /^\*\*Yes, in full\.\*\*/);
  assert.match((await askSnap('did drew pay for october')).text, /^\*\*Not yet\.\*\*/);
  assert.match((await askSnap('did drew pay me for september')).text, /^\*\*Partly/);
});
await check('"what does drew owe me for the govee" names both payments it is on, not "Yes" about August', async () => {
  const a = await askSnap('what does drew owe me for the govee');
  assert.ok(!/^\*\*Yes/.test(a.text), a.text);
  assert.match(a.text, /^\*\*“Govee[^*]*” is on the August payment \(adds \$49\.32; paid in full\) and the October payment \(1 refund takes off \$49\.31; not due yet\)\.\*\*/);
});
await check('"did drew pay me for the fishing line in october": only the October payment, which it isn\'t on', async () => {
  const a = await askSnap('did drew pay me for the fishing line in october');
  assert.match(a.text, /^\*\*Nothing of “Dorisea[^*]*” is on the October payment/);
  assert.match(a.text, /It is on the September payment/);
});
await check('a payment that comes to less than nothing: Myles owes Drew the difference (not "Drew owes nothing")', async () => {
  // A $1,000 Drew-paid cost in October turns the October payment negative
  const books = { ...snap.books, expenses: [...snap.books.expenses, { month: '2026-10', category: 'Test loss', amount: 1000, paid_by: 'ebay' }] };
  const a = await askSnap('did drew pay for october', null, null, { books });
  assert.match(a.text, /^\*\*No payment due from Drew\.\*\*/);
  assert.match(a.text, /It comes to −\$[\d,.]+ so far, so as things stand Myles would owe Drew \$[\d,.]+ on it/);
  assert.ok(!/owes nothing/.test(all(a)));
});
await check('"what does drew owe me" after a product question is the whole picture, not the product', async () => {
  const first = await askSnap('did drew pay me for the fishing line');
  const a = await askSnap('what does drew owe me', first.context);
  assert.match(a.text, /Drew owes Myles \$15\.15 now/);
});

// -------- Dates and pay cycles
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
await check('a bare "from <day>" is that one day: "orders from sep 14" / "orders from sep 15" (3 sales, the same as "what sold on sep 15")', async () => {
  const p = _test.parsePeriods('show me the orders from sep 14', '2026-10-10');
  assert.deepEqual([p.length, p[0].from, p[0].to], [1, '2026-09-14', '2026-09-14']);
  const a = await askSnap('orders from sep 15');
  assert.equal(a.understood.topic, 'recent');
  assert.match(a.text, /^\*\*3 sales on Sep 15:\*\*/);
  assert.equal(a.table.rows.length, (await askSnap('what sold on sep 15')).table.rows.length);
});
await check('"from <day> on", "<day> to now", "since <day>" and "after <day>" run to today', async () => {
  for (const question of ['profit from sep 27 on', 'profit from sep 27 onwards', 'profit sep 27 to now', 'profit since sep 27', 'profit sep 27 to today']) {
    const p = _test.parsePeriods(question, '2026-10-10');
    assert.equal(p.length, 1, `${question}: ${p.map((x) => x.label).join(' / ')}`);
    assert.deepEqual([p[0].from, p[0].to, p[0].cycle], ['2026-09-27', '2026-10-10', '2026-10'], question);
  }
  assert.equal(_test.parsePeriods('profit after sep 26', '2026-10-10')[0].from, '2026-09-27');
  const a = await askSnap('sales from sep 27 to now');
  assert.equal(a.understood.topic, 'recent');
  assert.match(a.text, /^\*\*19 sales since Sep 27/);
});
await check('"profit since sep 27 vs last month" compares the October cycle so far with September (not the single day Sep 27)', async () => {
  const a = await askSnap('profit since sep 27 vs last month');
  assert.equal(a.understood.topic, 'compare');
  assert.match(a.text, /\$167\.87 in September 2026 → −\$15\.07 in the October pay cycle so far/);
  assert.ok(!/35 → 0/.test(all(a)));
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
  assert.equal(_test.parsePeriods('compare sep 27 to oct 10', '2026-10-10').length, 2, '"compare" keeps two days');
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
await check('pay cycles follow the settlement_day setting (due the 25th: the October cycle is Sep 26–Oct 25)', async () => {
  const p = _test.parsePeriods('profit since sep 26', '2026-10-10', 25);
  assert.deepEqual([p[0].from, p[0].cycle], ['2026-09-26', '2026-10']);
  assert.equal(_test.parsePeriods('profit since sep 26', '2026-10-10')[0].cycle, undefined, 'with the 26th it is not a whole cycle');
  const a = await askSnap('profit for the october pay cycle', null, null, { s: { dueDay: 25 } });
  assert.match(a.understood.period, /Sep 26–Oct 25/);
});

// -------- Follow-ups
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
await check('the router hears the previous product, so a follow-up keeps it', async () => {
  await routeQuestion('and in september?', { prev: { intent: 'product', period: { label: 'all time' }, product: ['hhlpro'] } });
  assert.match(seen.at(-1).messages[0].content, /product "hhlpro"/);
});

// -------- Products and refund lines
await check('"fishing lines" is the Dorisea fishing line only, not the "Baitcasting Fishing Reel Holder"', async () => {
  const a = await askSnap('how many fishing lines did we sell');
  assert.match(a.text, /^\*\*1 sale of “Dorisea/);
  assert.equal(a.understood.product, 'fishing line');
});
await check('refund lines are not sales: October so far is 14 sales, no "Refund ·" product', async () => {
  assert.match((await askSnap('how many sales in october')).text, /14 counted in profit/);
  const w = await askSnap('worst products');
  assert.ok(!all(w).includes('Refund ·'));
  const h = w.table.rows.find((r) => /^HHLPRO/.test(r[0]));
  assert.deepEqual([h[1], h[3]], ['1', '−$3.10']); // the $16.53 sale and the −$19.63 refund line together
  assert.ok(!all(await askSnap('what sold in october')).includes('Refund ·'));
});
await check('average sale in October is over its own 14 sales (refund lines on September sales left out of the money too)', async () => {
  const own = snap.orders.filter((o) => o.counted && o.business_month === '2026-10' && o.source !== 'refund' && !(o.source === 'ledger' && o.ledger?.is_refund));
  assert.equal(own.length, 14);
  const payout = own.reduce((t, o) => t + cents(o.revenue) - cents(o.fees) - cents(o.refunds), 0);
  const avg = `$${(Math.round(payout / 14) / 100).toFixed(2)}`;
  const a = await askSnap('average sale in october');
  assert.ok(a.text.includes(`${avg} payout`), `${a.text} (expected ${avg})`);
  assert.ok(!a.text.includes('$23.94'));
  assert.match(a.text, /across 14 sales\. 2 refunds on earlier sales \(−\$[\d,.]+ payout, −\$[\d,.]+ profit\) are not in this average\./);
});

// -------- Operating costs
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
  const b = await askSnap('how much are proxies costing us', null, null, { books });
  assert.match(b.text, /Myles paid it, and Drew pays \$4\.00 back in the settlement/);
});
await check('a named cost that isn\'t in the period says so, never the period\'s total ("proxies in the september pay cycle")', async () => {
  const a = await askSnap('how much did we spend on proxies in the september pay cycle');
  assert.match(a.text, /^\*\*No Proxy cost on the September payment\.\*\*/);
  assert.ok(!/\$116\.07/.test(a.text));
});

// -------- The number guard on the AI model's line, against the dashboard's real answers on Oct 10
const pay = await askSnap('did drew pay me');
const owe = await askSnap('what does drew owe me');
const month = await askSnap('how much did we make this month');
const fishing = await askSnap('did drew pay me for the fishing line');
const rejected = (reply, facts, why) => { const p = checkReply(reply, facts); assert.ok(p.length, `not caught: ${reply}`); if (why) assert.match(p.join('; '), why, reply); };
const kept = (reply, facts) => assert.deepEqual(checkReply(reply, facts), [], reply);
await check('guard: a loss is never shown as a gain, and a loose loss word elsewhere doesn\'t excuse it', async () => {
  rejected('This month the business made **$50.99** in profit.', month, /wrong sign/);
  rejected('We made $15.07 on the October payment so far, a bit off the pace.', month, /wrong sign/);
  rejected('Profit is $50.99 so far — not a loss.', month, /wrong sign/);
  kept('This month the business is down **$50.99** after operating costs.', month);
  kept('Business profit is **−$50.99** this month, from 14 sales.', month);
  kept('Profit is -$50.99 so far.', month);
  kept('We lost $15.07 on the October payment so far.', month);
});
await check('guard: payer and payee must match, however it is worded (and "you" may be either partner)', async () => {
  for (const facts of [pay, owe]) {
    rejected('You still owe Drew $15.15 for September.', facts);
    rejected('Myles still owes $15.15 to Drew.', facts, /myles pays drew/);
    rejected('Myles owes $15.15 to Drew.', facts, /myles pays drew/);
    rejected('Drew is owed $15.15 by Myles.', facts, /myles pays drew/);
  }
  rejected('Myles owes Drew **$15.15** right now.', owe, /myles pays drew/);
  rejected('Myles needs to send Drew $15.15.', owe, /myles pays drew/);
  rejected('Drew gets $15.15 from Myles.', owe, /myles pays drew/);
  rejected('$15.15 is owed by you.', owe, /"you"/);
  kept('Drew owes Myles **$15.15** right now.', owe);
  kept('Drew owes you **$15.15** right now.', owe);
});
await check('guard: an amount keeps its role (paid / owed / so far) and its payment', async () => {
  rejected('Drew paid $15.15 and still owes $704.40.', pay, /called paid|called owed/);
  rejected('Drew paid $719.55 on Sep 27.', pay, /called paid/);
  rejected('Drew owes Myles $240.87 now.', owe, /called owed/);
  rejected('The September payment is at $240.87 so far.', owe, /different month/);
  rejected('For October, Drew still owes **$15.15**.', owe, /different month/);
  rejected('The fishing line adds $14.85 to the October payment.', fishing, /different month/);
  kept('The September payment still has $15.15 owed, and October is at $240.87 so far.', owe);
  kept('Drew paid $704.40 on Sep 27, so $15.15 is still owed on September.', pay);
  kept('Drew has paid $2,226.79 so far.', owe);
  kept('The October payment comes to $240.87 so far for Drew to send Myles.', month);
});
await check('guard: money only in the question, a product title or the instructions is never allowed', async () => {
  rejected('Yes, we made $500 this month.', month, /\$500 isn't in the facts/);
  assert.match(checkReply('Yes, we made $500 this month.', month, 'did we make $500 this month?').join(), /\$500 isn't in the facts/);
  assert.match(checkReply('The Dorisea line is a $300 item.', fishing, 'did drew pay me for the fishing line').join(), /\$300 isn't in the facts/);
  rejected('Drew sends you $50 on the 26th.', owe, /\$50 isn't in the facts/);
  rejected('Drew paid 704.40, so 15.07 is left.', fishing, /15\.07 isn't in the facts/);
  kept('That fishing line is order 16-15194-64325 and adds **$14.85**.', fishing);
});
await check('guard: "did Drew pay" can\'t be answered Yes when the dashboard says Partly', async () => {
  rejected('Yes, Drew paid you for the fishing line.', fishing, /"yes" where the dashboard says "partly"/);
  rejected('Drew is all paid up on the September payment.', fishing, /paid up/);
  kept('Partly. The fishing line adds **$14.85** to the September payment, which still has $15.15 owed.', fishing);
});

// -------- The Ask page layout
await check('the page always shows the dashboard\'s answer as the headline, the model\'s words under it', async () => {
  const p = answerParts({ text: 'Rough month.', facts: { text: month.text, bullets: month.bullets, table: null }, bullets: [], table: null, writtenBy: 'model' });
  assert.equal(p.headline, month.text);
  assert.equal(p.friendly, 'Rough month.');
  assert.deepEqual(p.folded.bullets, month.bullets);
  assert.equal(answerParts({ ...month, writtenBy: 'dashboard' }).headline, month.text);
  assert.equal(answerParts({ ...month, writtenBy: 'dashboard' }).friendly, null);
  assert.equal(answerParts({ ...month, friendly: 'Rough month.' }).headline, month.text);
});
await check('a Partly answer keeps "record it on the Settle page" and "In all, Drew owes" in the open, not folded away', async () => {
  const bullets = [...pay.bullets, 'In all, Drew owes Myles $15.15 on payments that have come due.'];
  const p = answerParts({ text: 'Partly.', facts: { text: pay.text, bullets, table: null }, writtenBy: 'model' });
  assert.ok(p.bullets.some((b) => /Settle page/.test(b)));
  assert.ok(p.bullets.some((b) => /^In all, Drew owes/.test(b)));
  assert.ok(!p.folded.bullets.some((b) => /Settle page|In all/.test(b)));
  assert.ok(p.folded.bullets.some((b) => /^October payment/.test(b)));
});

// ---- The real monthly sheets in a throwaway database (July and August paid, September not)
await initDb();
const sheetDir = process.env.LEDGER_SHEETS_DIR || path.resolve('private');
for (const m of ['JUL', 'AUG', 'SEP']) await importLedgerCsv(fs.readFileSync(path.join(sheetDir, `sheet-${m}-26.csv`)), `sheet ${m} 26.csv`);
await q("insert into settlements (month, paid, paid_at) values ('2026-07', 217.63, '2026-07-26'), ('2026-08', 1304.76, '2026-09-01') on conflict (month) do nothing");

await check('everyday ranges and pay cycles are read as one period (sheets)', async () => {
  const CASES = [
    ['operating costs for the august pay period', 'expenses', 'August pay cycle'],
    ['profit since sep 27', 'profit', 'since Sep 27'],
    ['profit from sep 1 to sep 14', 'profit', 'Sep 1–Sep 14'],
    ['how many sales between 9/1 and 9/14', 'count', 'Sep 1–Sep 14'],
    ['what sold from 9/10 through 9/12', 'recent', 'Sep 10–Sep 12'],
    ['profit from july to august', 'profit', 'July 2026 to August 2026'],
    ['profit for the september pay cycle', 'profit', 'September pay cycle'],
    ['how many sales in the august pay period', 'count', 'August pay cycle'],
    ['what did we sell from sep 14', 'recent', 'Sep 14'],
  ];
  const wrong = [];
  for (const [question, topic, period] of CASES) {
    const a = await ask(question);
    if (a.understood?.topic !== topic || !(a.understood?.period || '').includes(period)) wrong.push(`"${question}": ${a.understood?.topic} · ${a.understood?.period}`);
  }
  assert.deepEqual(wrong, []);
});
await check('settlement answers from the sheets: July and August Yes, in full; "did drew pay me" with September unpaid is never Yes', async () => {
  assert.match((await ask('did drew pay for july')).text, /^\*\*Yes, in full\./);
  assert.match((await ask('did drew pay for august')).text, /^\*\*Yes, in full\./);
  assert.match((await ask('did drew pay me')).text, /^\*\*(No|Not yet)\./);
  assert.match((await ask('did drew pay me back')).text, /^\*\*(No|Not yet)\./);
});
await check('the August pay cycle (a calendar month before September 2026) is the sheet\'s $129.49', async () => {
  assert.match(all(await ask('profit for the august pay period')), /\$129\.49/);
});
await check('plural product words: "fishing reel holders" finds it, "fishing lines" never counts the reel holder (sheets)', async () => {
  assert.match((await ask('how many fishing reel holders did we sell')).text, /^\*\*1 sale of “Baitcasting Fishing Reel Holder/);
  assert.match((await ask('how many fishing lines did we sell')).text, /^\*\*0 sales of “fishing line”/);
});

await closeDb();
mock.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(failed ? '\nASK AUDIT: FAILED' : '\nASK AUDIT: ALL CHECKS PASSED');
process.exitCode = failed ? 1 : 0;
