// Seeds realistic DEMO data into the LOCAL embedded database only, through the real ingestion
// paths: fake eBay API order payloads -> normalizeOrder/upsertOrder, and two overlapping Amazon
// CSV exports (with personal purchases mixed in) -> importAmazonCsv. Remove it from Settings.
import fs from 'node:fs';
import path from 'node:path';
try { process.loadEnvFile?.(); } catch {}
if (process.env.DATABASE_URL) {
  console.error('Refusing to seed demo data into DATABASE_URL. Unset it to seed the local database.');
  process.exit(1);
}
const { initDb, q, setSetting, closeDb } = await import('../src/db.js');
const { normalizeOrder, upsertOrder } = await import('../src/ebay.js');
const { importAmazonCsv } = await import('../src/amazon.js');
await initDb();

let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const between = (a, b) => a + rnd() * (b - a);

const PRODUCTS = [
  ['Ninja Professional Blender 1000W Total Crushing Pitcher', 'B00NGV4506', 89.99, 1.28],
  ['Keurig K-Mini Single Serve Coffee Maker Black', 'B07GV2S1GS', 79.99, 1.24],
  ['Shark Navigator Lift-Away Upright Vacuum NV352', 'B005KMDV9A', 179.99, 1.2],
  ['LEGO Classic Large Creative Brick Box 10698', 'B00NHQFA1I', 49.99, 1.3],
  ['Instant Pot Duo 7-in-1 Electric Pressure Cooker 6 Quart', 'B00FLYWNYQ', 89.0, 1.27],
  ['Crest 3D Whitestrips Professional Effects Teeth Whitening Kit', 'B00AHAWWO0', 45.99, 1.33],
  ['Hamilton Beach FlexBrew Trio Coffee Maker', 'B07L5DSXQP', 69.99, 1.25],
  ['Lodge Cast Iron Skillet 12 Inch Pre-Seasoned', 'B00006JSUB', 29.9, 1.42],
  ['Anker Portable Charger PowerCore 20000mAh', 'B00X5RV14Y', 39.99, 1.31],
  ['Bissell Little Green Portable Carpet Cleaner 3400', 'B00B8HWK7M', 123.59, 1.22],
  ['Cuisinart 14-Cup Food Processor DFP-14BCNY', 'B01AXM4WV2', 199.95, 1.18],
  ['Nerf Elite 2.0 Commander RD-6 Blaster', 'B08MVQMH6Y', 19.99, 1.45],
  ['Dash Mini Maker Electric Round Griddle Waffle Aqua', 'B01M9I779L', 12.99, 1.6],
  ['KitchenAid Classic Stand Mixer 4.5 Quart K45SS', 'B00005UP2P', 299.99, 1.14],
  ['Ring Video Doorbell Wired Night Vision', 'B08CKHPP52', 64.99, 1.26],
  ['Graco Pack n Play Portable Playard Playard Travel', 'B07NQVW3ZT', 99.99, 1.23],
  ['Hydro Flask Wide Mouth Water Bottle 32 oz', 'B083GBK1C1', 44.95, 1.3],
  ['Weber Original Kettle Premium Charcoal Grill 22 Inch', 'B00FDOONEC', 219.0, 1.16],
  ['Philips Sonicare 4100 Rechargeable Electric Toothbrush', 'B078GVDB19', 49.96, 1.29],
  ['Coleman Sundome Camping Tent 4 Person', 'B004J2GUOU', 89.99, 1.27],
  ['Magic Bullet Blender Small Silver 11 Piece Set', 'B0000CFZ7J', 39.99, 1.34],
  ['Ninja Air Fryer Pro 4-in-1 5 QT AF141', 'B0B2H7D1S3', 99.99, 1.24],
  ['Carhartt Knit Cuffed Beanie Men', 'B002G9UDYG', 19.99, 1.5],
  ['Rubbermaid Brilliance Food Storage Containers 22 Piece', 'B01JPEPW5Q', 44.99, 1.32],
  ['Melissa & Doug Wooden Building Blocks Set 100 Blocks', 'B00005RF5G', 24.99, 1.41],
  ['Vitamix Explorian Blender E310 Professional-Grade', 'B0758JHZM3', 289.95, 1.12],
  ['iRobot Roomba 694 Robot Vacuum Wi-Fi', 'B08SP5GYJP', 274.99, 1.15],
  ['BLACK+DECKER 20V MAX Cordless Drill Driver LDX120C', 'B005NNF0YU', 49.99, 1.3],
];
const FIRST = ['James', 'Maria', 'Robert', 'Linda', 'Michael', 'Jennifer', 'David', 'Patricia', 'Daniel', 'Ashley', 'Kevin', 'Tanya', 'Carlos', 'Megan', 'Andre', 'Priya', 'Tyler', 'Grace', 'Omar', 'Hannah'];
const LAST = ['Johnson', 'Martinez', 'Nguyen', 'Walker', 'Patel', 'Robinson', 'Okafor', 'Kowalski', 'Bennett', 'Hughes', 'Delgado', 'Fischer', 'Brooks', 'Sullivan', 'Reyes', 'Coleman', 'Park', 'Lindqvist', 'Harper', 'Moreno'];
const PLACES = [
  ['Houston', 'TX', '77002'], ['Dallas', 'TX', '75201'], ['Austin', 'TX', '78701'], ['Miami', 'FL', '33130'], ['Orlando', 'FL', '32801'],
  ['Tampa', 'FL', '33602'], ['Phoenix', 'AZ', '85004'], ['Mesa', 'AZ', '85201'], ['Los Angeles', 'CA', '90012'], ['San Diego', 'CA', '92101'],
  ['Sacramento', 'CA', '95814'], ['Chicago', 'IL', '60601'], ['Columbus', 'OH', '43215'], ['Atlanta', 'GA', '30303'], ['Charlotte', 'NC', '28202'],
  ['Seattle', 'WA', '98101'], ['Denver', 'CO', '80202'], ['Nashville', 'TN', '37203'], ['Detroit', 'MI', '48226'], ['Newark', 'NJ', '07102'],
  ['Philadelphia', 'PA', '19107'], ['Las Vegas', 'NV', '89101'], ['Portland', 'OR', '97204'], ['Boise', 'ID', '83702'],
];
const PERSONAL = ['Paper Towels 12 Double Rolls', 'USB-C Cable 6ft 2 Pack', 'Dog Food Chicken Recipe 30 lb', 'Printer Paper 500 Sheets', 'Phone Case Clear', 'AA Batteries 24 Pack', 'Coffee Pods Variety 72 Count', 'Shipping Tape 6 Rolls'];
const REASONS = ['NOT_AS_DESCRIBED', 'NO_LONGER_NEED', 'DEFECTIVE_ITEM', 'ARRIVED_DAMAGED', 'WRONG_SIZE', 'MISSING_PARTS'];

const DAYS = 200;
const now = Date.now();
const ebayOrders = [];
const amazonRows = [];
let seqAz = 1000000;
const azId = () => `DEMO-11${Math.floor(rnd() * 9)}-${String(seqAz++).padStart(7, '0')}-${String(Math.floor(rnd() * 9e6) + 1e6)}`;
const fmtUsd = (n) => `$${n.toFixed(2)}`;

for (let d = DAYS; d >= 0; d--) {
  const day = new Date(now - d * 86400_000);
  const growth = 0.6 + (1 - d / DAYS) * 2.2; // business ramps up over time
  const weekday = day.getDay();
  const weekdayBoost = [1.25, 1.0, 0.95, 0.9, 1.0, 1.05, 1.3][weekday];
  const count = Math.max(0, Math.round((rnd() * 2.2 + 0.4) * growth * weekdayBoost));
  for (let i = 0; i < count; i++) {
    const [title, asin, amzPrice, markup] = pick(PRODUCTS);
    const hour = Math.min(23, Math.max(0, Math.round(between(7, 23) + (rnd() < 0.3 ? -4 : 0))));
    const created = new Date(day);
    created.setHours(hour, Math.floor(rnd() * 60), Math.floor(rnd() * 60));
    if (created.getTime() > now) continue;
    const qty = rnd() < 0.08 ? 2 : 1;
    const priceJitter = between(0.96, 1.06);
    const salePrice = Math.round(amzPrice * (markup + 0.3) * priceJitter * 100) / 100 - 0.01;
    const subtotal = Math.round(salePrice * qty * 100) / 100;
    const shippingCharged = rnd() < 0.15 ? 5.99 : 0;
    const buyerTax = Math.round(subtotal * 0.075 * 100) / 100;
    const fvf = Math.round(((subtotal + shippingCharged + buyerTax) * 0.1325 + 0.4) * 100) / 100;
    const [city, state, zip] = pick(PLACES);
    const fullName = `${pick(FIRST)} ${pick(LAST)}`;
    const orderId = `DEMO-${String(10 + Math.floor(rnd() * 89))}-${String(10000 + ebayOrders.length).padStart(5, '0')}-${String(Math.floor(rnd() * 89999) + 10000)}`;
    const cancelled = rnd() < 0.02;
    const tracking = `TBA${Math.floor(rnd() * 9e11 + 1e11)}`;
    const ageDays = (now - created.getTime()) / 86400_000;
    const raw = {
      orderId,
      creationDate: created.toISOString(),
      orderFulfillmentStatus: cancelled ? 'NOT_STARTED' : ageDays > 2 ? 'FULFILLED' : 'NOT_STARTED',
      orderPaymentStatus: 'PAID',
      cancelStatus: { cancelState: cancelled ? 'CANCELED' : 'NONE_REQUESTED' },
      buyer: { username: `${fullName.split(' ')[0].toLowerCase()}_${Math.floor(rnd() * 900 + 100)}` },
      pricingSummary: {
        priceSubtotal: { value: subtotal.toFixed(2), currency: 'USD' },
        deliveryCost: { value: shippingCharged.toFixed(2), currency: 'USD' },
        total: { value: (subtotal + shippingCharged).toFixed(2), currency: 'USD' },
      },
      totalMarketplaceFee: { value: fvf.toFixed(2), currency: 'USD' },
      paymentSummary: { refunds: [] },
      fulfillmentStartInstructions: [{ shippingStep: { shipTo: { fullName, contactAddress: { addressLine1: `${Math.floor(rnd() * 9000 + 100)} Oak St`, city, stateOrProvince: state, postalCode: zip, countryCode: 'US' } } } }],
      lineItems: [{
        lineItemId: `${orderId}-L1`, legacyItemId: String(Math.floor(rnd() * 9e11 + 1e11)), sku: asin, title, quantity: qty,
        lineItemCost: { value: subtotal.toFixed(2) }, total: { value: subtotal.toFixed(2) },
        ebayCollectAndRemitTaxes: [{ amount: { value: buyerTax.toFixed(2) } }],
      }],
    };
    const returned = !cancelled && ageDays > 6 && rnd() < 0.045;
    if (returned) raw.paymentSummary.refunds.push({ refundStatus: 'REFUNDED', amount: { value: (subtotal + shippingCharged).toFixed(2) } });
    const n = normalizeOrder(raw);
    n.order.ad_fees = rnd() < 0.55 ? Math.round(subtotal * 0.03 * 100) / 100 : 0;
    ebayOrders.push({ n, created, qty, asin, title, amzPrice, fullName, city, state, zip, cancelled, tracking, returned, ageDays });
  }
}

for (const e of ebayOrders) {
  await upsertOrder(e.n);
  await q('update ebay_orders set ad_fees = $2, tracking_numbers = $3, tracking_fetched = true where order_id = $1', [
    e.n.order.order_id, e.n.order.ad_fees, e.cancelled ? [] : [e.tracking],
  ]);
  if (e.returned) {
    await q(
      `insert into ebay_returns (return_id, order_id, item_id, state, status, reason, return_type, created_at, refund_amount)
       values ($1,$2,$3,$4,$5,$6,'MONEY_BACK',$7,$8) on conflict do nothing`,
      [`DEMO-R${e.n.order.order_id.slice(-5)}`, e.n.order.order_id, e.n.lines[0].legacy_item_id, rnd() < 0.8 ? 'CLOSED' : 'RETURN_REQUESTED',
        rnd() < 0.8 ? 'REFUND_ISSUED' : 'WAITING_FOR_RETURN_SHIPMENT', pick(REASONS),
        new Date(e.created.getTime() + between(4, 12) * 86400_000).toISOString(), e.n.order.revenue]
    );
  }
  // Amazon side: bought within 0-2 days, except the newest few (not in any CSV yet) and some cancels
  if (e.ageDays < 1.5) continue;
  if (e.cancelled && rnd() < 0.6) continue;
  const lagDays = rnd() < 0.7 ? 0 : rnd() < 0.8 ? 1 : 2;
  const azDate = new Date(e.created.getTime() + lagDays * 86400_000);
  const unit = Math.round(e.amzPrice * (rnd() < 0.1 ? between(1.1, 1.3) : between(0.93, 1.04)) * 100) / 100; // Amazon price drift, occasional spikes
  const tax = Math.round(unit * e.qty * 0.08 * 100) / 100;
  const total = unit * e.qty + tax;
  amazonRows.push({
    'Website': 'Amazon.com', 'Order ID': azId(), 'Order Date': azDate.toISOString(), 'Purchase Order Number': 'Not Applicable', 'Currency': 'USD',
    'Unit Price': unit.toFixed(2), 'Unit Price Tax': (tax / e.qty).toFixed(2), 'Shipping Charge': '0', 'Total Discounts': '0',
    'Total Owed': total.toFixed(2), 'Shipment Item Subtotal': (unit * e.qty).toFixed(2), 'Shipment Item Subtotal Tax': tax.toFixed(2),
    'ASIN': e.asin, 'Product Condition': 'New', 'Quantity': String(e.qty), 'Payment Instrument Type': 'Visa - 4417',
    'Order Status': e.cancelled ? 'Cancelled' : 'Closed', 'Shipment Status': 'Shipped', 'Ship Date': azDate.toISOString(), 'Shipping Option': 'next-1dc',
    'Shipping Address': `${e.fullName} ${Math.floor(rnd() * 9000 + 100)} Oak St ${e.city.toUpperCase()}, ${e.state} ${e.zip}-1234 United States`,
    'Billing Address': 'Home Buyer 1 Home Rd SPRINGFIELD, IL 62701 United States',
    'Carrier Name & Tracking Number': e.cancelled ? 'Not Available' : rnd() < 0.5 ? `AMZN_US(${e.tracking})` : 'Not Available',
    'Product Name': e.title.replace(/ Set$/, ''), 'Gift Message': 'Not Available', 'Gift Sender Name': 'Not Available',
    'Gift Recipient Contact Details': 'Not Available', 'Item Serial Number': 'Not Available', _date: azDate,
  });
}
// Personal purchases shipped to the home address - these must never be counted
for (let i = 0; i < 70; i++) {
  const azDate = new Date(now - between(2, DAYS) * 86400_000);
  const price = Math.round(between(8, 60) * 100) / 100;
  amazonRows.push({
    'Website': 'Amazon.com', 'Order ID': azId(), 'Order Date': azDate.toISOString(), 'Purchase Order Number': 'Not Applicable', 'Currency': 'USD',
    'Unit Price': price.toFixed(2), 'Unit Price Tax': (price * 0.08).toFixed(2), 'Shipping Charge': '0', 'Total Discounts': '0',
    'Total Owed': (price * 1.08).toFixed(2), 'Shipment Item Subtotal': price.toFixed(2), 'Shipment Item Subtotal Tax': (price * 0.08).toFixed(2),
    'ASIN': `B0PERS${String(i).padStart(4, '0')}`, 'Product Condition': 'New', 'Quantity': '1', 'Payment Instrument Type': 'Visa - 4417',
    'Order Status': 'Closed', 'Shipment Status': 'Shipped', 'Ship Date': azDate.toISOString(), 'Shipping Option': 'std-us',
    'Shipping Address': 'Home Buyer 1 Home Rd SPRINGFIELD, IL 62701-0000 United States', 'Billing Address': 'Home Buyer 1 Home Rd SPRINGFIELD, IL 62701 United States',
    'Carrier Name & Tracking Number': 'Not Available', 'Product Name': pick(PERSONAL), 'Gift Message': 'Not Available', 'Gift Sender Name': 'Not Available',
    'Gift Recipient Contact Details': 'Not Available', 'Item Serial Number': 'Not Available', _date: azDate,
  });
}

const headers = Object.keys(amazonRows[0]).filter((h) => h !== '_date');
const toCsv = (rows) =>
  [headers.join(','), ...rows.map((r) => headers.map((h) => `"${String(r[h]).replace(/"/g, '""')}"`).join(','))].join('\n');
// Two weekly-style exports that overlap by ~3 weeks -> exercises dedupe
const cut1 = now - 20 * 86400_000;
const cut2 = now - 45 * 86400_000;
const fileA = amazonRows.filter((r) => r._date.getTime() < cut1);
const fileB = amazonRows.filter((r) => r._date.getTime() >= cut2);
const outDir = path.resolve('demo');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'demo-amazon-export-1.csv'), toCsv(fileA));
fs.writeFileSync(path.join(outDir, 'demo-amazon-export-2.csv'), toCsv(fileB));

await setSetting('home_zips', ['62701']);
await setSetting('monthly_goal', 2500);
const r1 = await importAmazonCsv(Buffer.from(toCsv(fileA)), 'demo-amazon-export-1.csv');
const r2 = await importAmazonCsv(Buffer.from(toCsv(fileB)), 'demo-amazon-export-2.csv');
// A few manual adjustments so the editor has something to show
const some = ebayOrders.filter((e) => e.returned).slice(0, 4);
for (const e of some)
  await q(`insert into order_overrides (order_id, amazon_refund, notes) values ($1,$2,'Returned to Amazon, refund received') on conflict do nothing`, [
    e.n.order.order_id, Math.round(e.amzPrice * 1.08 * 100) / 100,
  ]);

console.log(`eBay orders: ${ebayOrders.length}  Amazon rows: ${amazonRows.length} (70 personal)`);
console.log('Import 1:', { new: r1.linesNew, updated: r1.linesUpdated, unchanged: r1.linesUnchanged, linked: r1.ordersLinked, ignored: r1.ordersIgnored });
console.log('Import 2:', { new: r2.linesNew, updated: r2.linesUpdated, unchanged: r2.linesUnchanged, linked: r2.ordersLinked, ignored: r2.ordersIgnored });
const [{ n }] = await q('select count(*)::int as n from amazon_lines');
const [{ l }] = await q('select count(*)::int as l from order_links');
const [{ bad }] = await q(`select count(*)::int as bad from order_links k join amazon_lines a on a.amazon_order_id = k.amazon_order_id where a.asin like 'B0PERS%'`);
console.log(`amazon_lines total: ${n} (file rows ${fileA.length + fileB.length})  links: ${l}  personal purchases linked: ${bad}`);
await closeDb();
