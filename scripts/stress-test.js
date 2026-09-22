// Adversarial matching test in a throwaway database (never touches real data).
// Simulates a messy month through the real code paths (eBay normalizer, raw MIME Amazon emails ->
// simpleParser -> ingestMessage, matcher, dataset) and scores the result against ground truth:
//   WRONG links (Amazon cost attached to the wrong sale)  -> must be 0
//   profit on every counted sale must equal the true profit to the cent
//   personal purchases / gifts must never be counted
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-stress-'));
process.env.LOCAL_PG_DIR = dir;
process.env.LOCAL_PG_PORT = '5447';
delete process.env.DATABASE_URL;
const { initDb, q, closeDb } = await import('../src/db.js');
const { normalizeOrder, upsertOrder } = await import('../src/ebay.js');
const { ingestMessage } = await import('../src/email.js');
const { runMatcher, getSuggestions } = await import('../src/matcher.js');
const { buildDataset } = await import('../src/dataset.js');
const { simpleParser } = await import('mailparser');
await initDb();

const SEED = Number(process.argv[2] || 7);
let seed = SEED;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const r2 = (n) => Math.round(n * 100) / 100;

// Deliberately tiny pools so first name + city collisions happen constantly
const MODE = process.argv[3] || 'worst';
const FIRST0 = ['Jane', 'John', 'Mike', 'Chris', 'David', 'Sarah', 'Jessica', 'James', 'Robert', 'Ashley', 'Maria', 'Daniel'];
const LAST = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Lopez', 'Wilson'];
const CITIES0 = [['Houston', 'TX'], ['Phoenix', 'AZ'], ['Chicago', 'IL'], ['Miami', 'FL'], ['Dallas', 'TX'], ['Atlanta', 'GA'], ['Denver', 'CO'], ['Tampa', 'FL']];
// 'worst' = 12 first names x 8 cities (collisions everywhere); 'realistic' = ~250 first names x ~120 cities
const SYL = ['an', 'el', 'ja', 'mi', 'ka', 'ro', 'li', 'sa', 'de', 'ty', 'ni', 'mar', 'bri', 'cal', 'ev', 'jo', 'lu', 'ra', 'to', 'vi'];
const STATES = ['TX', 'AZ', 'CA', 'FL', 'IL', 'GA', 'CO', 'NY', 'OH', 'WA', 'NC', 'PA'];
const FIRST = MODE === 'realistic' ? [...new Set(Array.from({ length: 400 }, (_, i) => (SYL[i % 20] + SYL[(i * 7 + 3) % 20] + (i % 3 ? SYL[(i * 13) % 20] : '')).replace(/^./, (c) => c.toUpperCase())))].slice(0, 250) : FIRST0;
const CITIES = MODE === 'realistic' ? Array.from({ length: 120 }, (_, i) => [`${SYL[i % 20]}${SYL[(i * 3 + 1) % 20]}ville`.replace(/^./, (c) => c.toUpperCase()), STATES[i % 12]]) : CITIES0;
const CATS = ['Kitchen', 'Automotive', 'Toys & Games', 'Sports & Outdoors', 'Home Improvement', 'Pet Supplies', 'Beauty', 'Office Products'];
const DAYS = 45;
const start = Date.now() - DAYS * 86400_000;

let azSeq = 1;
const azId = () => `9${String(10 + Math.floor(rnd() * 89))}-${String(1000000 + azSeq++).padStart(7, '0')}-${String(Math.floor(rnd() * 8999999) + 1000000)}`;
const truth = new Map(); // amazon order id -> ebay order id (null = personal/gift)
const cancelled = new Set();
const emails = [];
const trueCost = new Map(); // ebay order id -> true Amazon cost
const ebaySales = [];

const mime = (subject, text, date, id) => Buffer.from([
  'From: "Amazon.com" <auto-confirm@amazon.com>', `Subject: ${subject}`, `Message-ID: <${id}@stress.test>`, `Date: ${new Date(date).toUTCString()}`,
  'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', '', text,
].join('\r\n'));
const orderEmail = (id, first, city, st, total, date) => emails.push(mime(`Ordered 1 item: ${pick(CATS)}`,
  `Your Orders\n\n    Thanks for your order!\nOrdered\n\nArriving Thursday\n\n${first} - ${city.toUpperCase()}, ${st}\n\nOrder #\n‫${id}\n\nView or edit order\n\nGrand Total:\n${total} USD\n\n©2026 Amazon.com`, date, `o-${id}`));
const cancelEmail = (id, date) => emails.push(mime(`Your Amazon.com order #${id} has been canceled`, `Hello, your order ${id} has been canceled. You have not been charged.`, date, `c-${id}`));
const refundEmail = (id, amount, date) => emails.push(mime('Refund issued for Something...', `Your refund was issued.\n\nRefund subtotal $${amount.toFixed(2)}\nTotal refund $${amount.toFixed(2)}\n\nQuantity: 1 Order # ${id} Reason for return: Not as Expected`, date, `r-${id}`));

const stats = { sales: 0, noEmail: 0, cancelReorder: 0, multi: 0, returns: 0, personal: 0, gifts: 0, lag: [0, 0, 0, 0, 0, 0] };
for (let i = 0; i < 320; i++) {
  const at = new Date(start + rnd() * (DAYS - 1) * 86400_000);
  const first = pick(FIRST);
  const [city, st] = pick(CITIES);
  const qty = rnd() < 0.04 ? 2 : 1;
  const unit = r2(15 + rnd() * 135);
  const revenue = r2(unit * qty);
  const orderId = `99-${String(10000 + i)}-${String(10000 + Math.floor(rnd() * 89999))}`;
  const fee = r2((revenue * 1.08) * 0.136 + 0.4);
  const ad = rnd() < 0.5 ? r2(revenue * 0.03) : 0;
  const returned = rnd() < 0.04;
  const raw = {
    orderId, creationDate: at.toISOString(), orderFulfillmentStatus: 'FULFILLED', orderPaymentStatus: 'PAID', cancelStatus: { cancelState: 'NONE_REQUESTED' },
    buyer: { username: `${first.toLowerCase()}${i}` },
    pricingSummary: { priceSubtotal: { value: String(revenue) }, deliveryCost: { value: '0' }, total: { value: String(revenue) } },
    totalMarketplaceFee: { value: String(fee) },
    paymentSummary: { refunds: returned ? [{ refundStatus: 'REFUNDED', amount: { value: String(revenue) } }] : [] },
    fulfillmentStartInstructions: [{ shippingStep: { shipTo: { fullName: `${first} ${pick(LAST)}`, contactAddress: { city, stateOrProvince: st, postalCode: '00000', countryCode: 'US' } } } }],
    lineItems: [{ lineItemId: `${orderId}-1`, legacyItemId: '1', title: `Item ${i}`, quantity: qty, lineItemCost: { value: String(revenue) }, total: { value: String(revenue) } }],
  };
  const n = normalizeOrder(raw);
  await upsertOrder(n);
  await q('update ebay_orders set ad_fees = $2 where order_id = $1', [orderId, ad]);
  stats.sales++;
  const sale = { orderId, revenue, fee, ad, returned, amazonRefund: 0 };
  ebaySales.push(sale);

  if (rnd() < 0.04) { stats.noEmail++; continue; } // purchase email never arrives (yet)
  const lag = rnd() < 0.7 ? 0 : rnd() < 0.67 ? 1 : rnd() < 0.8 ? Math.floor(2 + rnd() * 2) : 5;
  stats.lag[Math.min(5, lag)]++;
  const buyAt = new Date(at.getTime() + lag * 86400_000 + rnd() * 3 * 3600_000);
  const unitCost = r2(unit * (0.55 + rnd() * 0.37));
  let cost = 0;
  const orders = qty === 2 && rnd() < 0.7 ? [unitCost, unitCost] : [r2(unitCost * qty)];
  if (orders.length === 2) stats.multi++;
  for (const c of orders) {
    if (rnd() < 0.03) { // first attempt cancelled, then re-ordered
      const bad = azId();
      truth.set(bad, orderId); cancelled.add(bad);
      orderEmail(bad, first, city, st, c.toFixed(2), buyAt);
      cancelEmail(bad, new Date(buyAt.getTime() + 3600_000));
      stats.cancelReorder++;
    }
    const id = azId();
    truth.set(id, orderId);
    orderEmail(id, first, city, st, c.toFixed(2), new Date(buyAt.getTime() + 2 * 3600_000));
    cost += c;
    if (returned && rnd() < 0.6) { refundEmail(id, c, new Date(at.getTime() + 12 * 86400_000)); sale.amazonRefund += c; }
  }
  if (returned) stats.returns++;
  trueCost.set(orderId, r2(cost));
}
// Personal purchases to the home address
for (let i = 0; i < 80; i++) {
  const id = azId(); truth.set(id, null); stats.personal++;
  orderEmail(id, 'Sam', 'Springfield', 'IL', r2(8 + rnd() * 140).toFixed(2), new Date(start + rnd() * DAYS * 86400_000));
}
// Gifts shipped to people who share a first name + city with eBay buyers (the nastiest case)
for (let i = 0; i < 15; i++) {
  const id = azId(); truth.set(id, null); stats.gifts++;
  const [city, st] = pick(CITIES);
  orderEmail(id, pick(FIRST), city, st, r2(15 + rnd() * 90).toFixed(2), new Date(start + rnd() * DAYS * 86400_000));
}

// Emails arrive in time order, mixed together, through the real MIME path
const parsed = [];
for (const raw of emails) parsed.push(await simpleParser(raw));
parsed.sort((a, b) => a.date - b.date);
for (const m of parsed) await ingestMessage({ messageId: m.messageId, subject: m.subject, text: m.text, date: m.date });
const m = await runMatcher();

// ---------------- score ----------------
const links = await q('select amazon_order_id, ebay_order_id, reasons, score from order_links');
let wrong = 0; let right = 0; let personalLinked = 0;
const wrongList = [];
for (const l of links) {
  const t = truth.get(l.amazon_order_id);
  if (t === l.ebay_order_id) right++;
  else { wrong++; if (t === null) personalLinked++; wrongList.push({ ...l, truth: t }); }
}
const shouldLink = [...truth.values()].filter(Boolean).length;
const data = await buildDataset();
let profitMismatch = 0; let countedWrongCost = 0; let counted = 0; let computedProfit = 0; let trueProfit = 0;
const mismatches = [];
for (const o of data) {
  const s = ebaySales.find((x) => x.orderId === o.order_id);
  const tc = trueCost.get(o.order_id);
  if (!o.counted) continue;
  counted++;
  const refunds = s.returned ? s.revenue : 0;
  const expected = r2(s.revenue - s.fee - s.ad - tc - refunds + s.amazonRefund);
  computedProfit += o.net; trueProfit += expected;
  if (Math.abs(o.cost - tc) > 0.005) countedWrongCost++;
  if (Math.abs(o.net - expected) > 0.005) { profitMismatch++; mismatches.push({ order: o.order_id, net: o.net, expected, cost: o.cost, trueCost: tc }); }
}
const awaiting = data.filter((o) => o.status === 'awaiting_cost').length;
const review = (await getSuggestions(1000)).length;
const partial = data.filter((o) => o.counted && trueCost.get(o.order_id) !== undefined && Math.abs(o.cost - trueCost.get(o.order_id)) > 0.005).length;

console.log(`seed ${SEED}  mode ${MODE}  (${FIRST.length} first names x ${CITIES.length} cities)`);
console.log('scenario:', JSON.stringify(stats));
console.log(`emails: ${emails.length}  matcher: ${m.linked} auto-links, ${review} Amazon orders sent to Match review`);
console.log(`\nLINKS   right ${right}  WRONG ${wrong}  (personal/gift linked: ${personalLinked})  of ${shouldLink} that should link`);
console.log(`SALES   ${counted} counted in profit · ${awaiting} awaiting cost (excluded, not guessed)`);
console.log(`PROFIT  computed $${r2(computedProfit)} vs true $${r2(trueProfit)} on counted sales · ${profitMismatch} per-sale mismatches · ${countedWrongCost} counted with wrong cost (${partial} partial multi-order)`);
if (wrongList.length) console.log('wrong links:', wrongList.slice(0, 8));
if (mismatches.length) console.log('profit mismatches:', mismatches.slice(0, 8));
const pass = wrong === 0 && profitMismatch === 0;
console.log(pass ? '\nSTRESS: PASS (no wrong links, every counted sale exact)' : '\nSTRESS: FAIL');
await closeDb();
fs.rmSync(dir, { recursive: true, force: true });
process.exitCode = pass ? 0 : 1;
