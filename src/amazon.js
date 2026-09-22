// Amazon CSV import. Accepts the common Amazon order exports (Request-Your-Data "Retail.OrderHistory",
// Amazon Business order reports, the legacy Items report, order-history browser extensions) by
// matching header aliases. Dedupe key is the Amazon order number (+ ASIN/title + occurrence),
// so overlapping weekly uploads update existing rows and never double-count.
import { parse } from 'csv-parse/sync';
import { q } from './db.js';
import { runMatcher } from './matcher.js';

const norm = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const ALIASES = {
  orderId: ['orderid', 'amazonorderid', 'ordernumber', 'orderno', 'order'],
  orderDate: ['orderdate', 'orderplaceddate', 'purchasedate', 'date', 'orderdateutc'],
  asin: ['asin', 'asinisbn', 'productid', 'isbn'],
  title: ['productname', 'title', 'itemname', 'itemtitle', 'items', 'item', 'description', 'productdescription'],
  quantity: ['quantity', 'itemquantity', 'qty', 'originalquantity', 'orderquantity'],
  unitPrice: ['unitprice', 'purchaseppu', 'purchasepriceperunit', 'listedppu', 'itemprice', 'price', 'priceperunit'],
  unitTax: ['unitpricetax'],
  itemSubtotal: ['itemsubtotal', 'shipmentitemsubtotal', 'itemnetsubtotal', 'subtotal'],
  tax: ['itemsubtotaltax', 'itemtax', 'shipmentitemsubtotaltax', 'tax', 'totaltax', 'salestax'],
  shipping: ['shippingcharge', 'shipping', 'shippingcost', 'shippingandhandling'],
  discount: ['totaldiscounts', 'discount', 'discounts', 'itempromotion', 'promotion'],
  total: ['totalowed', 'itemtotal', 'itemnettotal', 'total', 'ordertotal', 'grandtotal', 'totalcharged', 'amount', 'amountcharged'],
  shipName: ['shippingaddressname', 'shiptoname', 'recipientname', 'recipient', 'shipto', 'to', 'shiptoaddressname'],
  shipAddress: ['shippingaddress', 'shiptoaddress', 'deliveryaddress', 'address'],
  shipStreet: ['shippingaddressstreet1', 'shippingaddressstreet', 'shiptostreet', 'street'],
  shipCity: ['shippingaddresscity', 'shiptocity', 'city'],
  shipState: ['shippingaddressstate', 'shiptostate', 'state'],
  shipZip: ['shippingaddresszip', 'shippingaddresspostalcode', 'shiptozip', 'shiptopostalcode', 'postalcode', 'zipcode', 'zip'],
  status: ['orderstatus', 'shipmentstatus', 'status', 'itemstatus'],
  tracking: ['carriernametrackingnumber', 'carriertracking', 'carriertrackingnumber', 'trackingnumber', 'tracking', 'trackingnumbers'],
  payment: ['paymentinstrumenttype', 'paymentinstrument', 'paymentmethod', 'payments', 'paymenttype'],
};

function mapHeaders(headers) {
  const normalized = headers.map(norm);
  const map = {};
  for (const [field, aliases] of Object.entries(ALIASES)) {
    for (const a of aliases) {
      const idx = normalized.indexOf(a);
      if (idx !== -1 && !Object.values(map).includes(headers[idx])) {
        map[field] = headers[idx];
        break;
      }
    }
  }
  return map;
}

function detectFormat(map, headers) {
  const h = headers.map(norm);
  if (h.includes('totalowed') && h.includes('shippingaddress')) return 'Amazon Request-Your-Data (Retail.OrderHistory)';
  if (h.includes('purchaseppu') || h.includes('itemnettotal')) return 'Amazon Business order report';
  if (h.includes('purchasepriceperunit')) return 'Amazon legacy Items report';
  if (map.orderId && map.total && !map.asin) return 'Order-level export';
  return 'Generic (header-matched)';
}

export function parseMoney(v) {
  if (v === null || v === undefined) return null;
  let s = String(v).trim();
  if (!s || /^(n\/?a|not available|none|-)$/i.test(s)) return null;
  const neg = /^\(.*\)$/.test(s) || /^-/.test(s);
  s = s.replace(/[^0-9.]/g, '');
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

export function parseDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

export function extractZip(text) {
  if (!text) return null;
  const all = String(text).match(/\b\d{5}(?:-\d{4})?\b/g);
  return all ? all[all.length - 1].slice(0, 5) : null;
}

const US_STATES = new Set(
  'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC PR'.split(' ')
);
function extractState(text) {
  if (!text) return null;
  const m = String(text).toUpperCase().match(/\b([A-Z]{2})\s+\d{5}/);
  return m && US_STATES.has(m[1]) ? m[1] : null;
}

export function parseAmazonCsv(buffer) {
  let text = buffer.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const records = parse(text, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
    trim: true,
  });
  if (!records.length) throw new Error('The CSV has no rows.');
  const headers = Object.keys(records[0]);
  const map = mapHeaders(headers);
  if (!map.orderId) {
    const err = new Error(`Couldn't find an order-number column. Headers found: ${headers.join(', ')}`);
    err.status = 400;
    throw err;
  }
  const get = (r, f) => (map[f] ? r[map[f]] : undefined);
  const occurrences = new Map();
  const lines = [];
  for (const r of records) {
    const orderId = String(get(r, 'orderId') || '').trim();
    if (!orderId || /^order/i.test(orderId)) continue;
    const asin = (get(r, 'asin') || '').trim() || null;
    const title = (get(r, 'title') || '').trim() || null;
    const qty = Math.max(1, Math.round(parseMoney(get(r, 'quantity')) || 1));
    const unitPrice = parseMoney(get(r, 'unitPrice'));
    const unitTax = parseMoney(get(r, 'unitTax'));
    const itemSubtotal = parseMoney(get(r, 'itemSubtotal'));
    const tax = parseMoney(get(r, 'tax')) ?? (unitTax !== null ? unitTax * qty : null);
    const shipping = parseMoney(get(r, 'shipping'));
    const discount = parseMoney(get(r, 'discount'));
    let total = parseMoney(get(r, 'total'));
    if (total === null) {
      const base = itemSubtotal ?? (unitPrice !== null ? unitPrice * qty : 0);
      total = base + (tax || 0) + (shipping || 0) - Math.abs(discount || 0);
    }
    const addressParts = [get(r, 'shipName'), get(r, 'shipAddress'), get(r, 'shipStreet'), get(r, 'shipCity'), get(r, 'shipState'), get(r, 'shipZip')]
      .filter(Boolean)
      .join(' ');
    const identity = asin || (title ? title.toLowerCase().slice(0, 80) : 'item');
    const occKey = `${orderId}|${identity}`;
    const occ = (occurrences.get(occKey) || 0) + 1;
    occurrences.set(occKey, occ);
    lines.push({
      line_key: `${occKey}|${occ}`,
      amazon_order_id: orderId,
      order_date: parseDate(get(r, 'orderDate')),
      asin,
      title,
      quantity: qty,
      unit_price: unitPrice,
      item_subtotal: itemSubtotal,
      tax,
      shipping,
      discount,
      line_total: Math.round(total * 100) / 100,
      ship_name: (get(r, 'shipName') || '').trim() || null,
      ship_address: addressParts || null,
      ship_zip: (get(r, 'shipZip') || '').slice(0, 5) || extractZip(addressParts),
      ship_state: (get(r, 'shipState') || '').trim().toUpperCase().slice(0, 2) || extractState(addressParts),
      order_status: (get(r, 'status') || '').trim() || null,
      tracking: (get(r, 'tracking') || '').trim() || null,
      payment: (get(r, 'payment') || '').trim() || null,
      raw: r,
    });
  }
  return { lines, format: detectFormat(map, headers), mapped: map, rowsInFile: records.length };
}

export async function importAmazonCsv(buffer, filename) {
  const parsed = parseAmazonCsv(buffer);
  const [{ id: importId }] = await q(
    'insert into amazon_imports (filename, format, rows_in_file) values ($1, $2, $3) returning id',
    [filename, parsed.format, parsed.rowsInFile]
  );
  // A CSV row is more precise than a parsed email, so it replaces any email-sourced rows for the same order
  const fileOrderIds = [...new Set(parsed.lines.map((l) => l.amazon_order_id))];
  if (fileOrderIds.length) await q("delete from amazon_lines where source = 'email' and amazon_order_id = any($1)", [fileOrderIds]);
  let fresh = 0;
  let updated = 0;
  let unchanged = 0;
  const fields = ['order_date', 'asin', 'title', 'quantity', 'unit_price', 'item_subtotal', 'tax', 'shipping', 'discount',
    'line_total', 'ship_name', 'ship_address', 'ship_zip', 'ship_state', 'order_status', 'tracking', 'payment'];
  for (const l of parsed.lines) {
    const existing = (await q('select * from amazon_lines where line_key = $1', [l.line_key]))[0];
    if (!existing) {
      await q(
        `insert into amazon_lines (line_key, amazon_order_id, ${fields.join(', ')}, raw, first_import, last_import)
         values ($1, $2, ${fields.map((_, i) => `$${i + 3}`).join(', ')}, $${fields.length + 3}::jsonb, $${fields.length + 4}, $${fields.length + 4})`,
        [l.line_key, l.amazon_order_id, ...fields.map((f) => l[f]), JSON.stringify(l.raw), importId]
      );
      fresh++;
      continue;
    }
    const changed = fields.some((f) => {
      const a = existing[f] instanceof Date ? existing[f].toISOString().slice(0, 10) : existing[f];
      const b = l[f];
      if (a === null || a === undefined) return b !== null && b !== undefined && b !== '';
      if (typeof b === 'number') return Math.abs(Number(a) - b) > 0.004;
      return String(a) !== String(b ?? '');
    });
    if (changed) {
      await q(
        `update amazon_lines set ${fields.map((f, i) => `${f} = coalesce($${i + 2}, ${f})`).join(', ')},
           raw = $${fields.length + 2}::jsonb, last_import = $${fields.length + 3}, updated_at = now()
         where line_key = $1`,
        [l.line_key, ...fields.map((f) => l[f]), JSON.stringify(l.raw), importId]
      );
      updated++;
    } else {
      await q('update amazon_lines set last_import = $2 where line_key = $1', [l.line_key, importId]);
      unchanged++;
    }
  }
  const orderIds = [...new Set(parsed.lines.map((l) => l.amazon_order_id))];
  const match = await runMatcher();
  const linked = orderIds.length
    ? (await q('select count(*)::int as n from order_links where amazon_order_id = any($1)', [orderIds]))[0].n
    : 0;
  await q(
    `update amazon_imports set lines_new = $2, lines_updated = $3, lines_unchanged = $4, orders_in_file = $5, orders_linked = $6
     where id = $1`,
    [importId, fresh, updated, unchanged, orderIds.length, linked]
  );
  return {
    importId,
    format: parsed.format,
    mappedColumns: parsed.mapped,
    rowsInFile: parsed.rowsInFile,
    linesNew: fresh,
    linesUpdated: updated,
    linesUnchanged: unchanged,
    ordersInFile: orderIds.length,
    ordersLinked: linked,
    ordersIgnored: orderIds.length - linked,
    newLinks: match.linked,
    suggestions: match.suggestions,
  };
}
