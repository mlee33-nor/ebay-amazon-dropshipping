// Monthly partner settlement sheets ("AMAZON-TO-EBAY PARTNERSHIP SETTLEMENT"): one row per sale with
// Amazon cost, eBay payout (after eBay's final value fee) and ad fees, plus the month's operating
// expenses. Rows are keyed month|title|occurrence so re-uploading an edited sheet updates, never duplicates.
// Until the eBay API has the real order, each row stands in as a sale; once eBay syncs, the row is
// matched to its eBay order (title + price, same month) and supplies that order's Amazon cost.
import { parse } from 'csv-parse/sync';
import { q, one } from './db.js';
import { parseMoney } from './amazon.js';
import { titleSimilarity } from './matcher.js';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

export function isLedgerCsv(buffer) {
  const head = buffer.toString('utf8', 0, 3000);
  return /TRANSACTION LOG/i.test(head) || (/^\s*"?Item Name"?\s*,/im.test(head) && /Amazon Cost/i.test(head));
}

export function monthFrom(filename, rows) {
  const m = String(filename).toUpperCase().match(/\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\s*'?(\d{2}|\d{4})\b/);
  if (m) {
    const y = m[2].length === 2 ? `20${m[2]}` : m[2];
    return `${y}-${String(MONTHS.indexOf(m[1]) + 1).padStart(2, '0')}`;
  }
  const t = (rows[0] || []).join(' ').toUpperCase().match(/(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\s+(\d{4})/);
  if (t) return `${t[2]}-${String(MONTHS.indexOf(t[1]) + 1).padStart(2, '0')}`;
  return null;
}

const normTitle = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 90);
const money = (v) => {
  const s = String(v ?? '').trim();
  if (!s || s === '-' || s === '—') return null;
  return parseMoney(s);
};

export function parseLedgerCsv(buffer, filename) {
  let text = buffer.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = parse(text, { relax_column_count: true, relax_quotes: true, skip_empty_lines: false });
  const month = monthFrom(filename, rows);
  if (!month) {
    const err = new Error('Could not tell which month this sheet is for. Put the month in the file name, e.g. "SEP 26".');
    err.status = 400;
    throw err;
  }
  const hi = rows.findIndex((r) => /^item name$/i.test(String(r[0]).trim()));
  if (hi === -1) throw Object.assign(new Error('No "Item Name" header row found'), { status: 400 });
  const header = rows[hi].map((h) => String(h).trim());
  const col = (re) => header.findIndex((h) => re.test(h));
  const cCost = col(/amazon cost/i);
  const cSale = col(/ebay sale/i);
  const cAd = col(/ad fee/i);
  const cNet = col(/net item profit/i);
  const known = new Set([0, cCost, cSale, cAd, cNet]);

  const entries = [];
  const occ = new Map();
  let totals = null;
  let i = hi + 1;
  for (; i < rows.length; i++) {
    const r = rows[i];
    const title = String(r[0] || '').trim();
    if (/^total transactions/i.test(title)) {
      totals = { cost: money(r[cCost]), sale: money(r[cSale]), ad: money(r[cAd]), net: money(r[cNet]) };
      break;
    }
    if (/^\d+\.\s/.test(title) && /operating|summary|settlement/i.test(title)) break;
    if (!title) continue;
    const cost = money(r[cCost]) ?? 0;
    const sale = money(r[cSale]) ?? 0;
    const ad = money(r[cAd]) ?? 0;
    // Free-text notes live in the unlabeled columns; skip the margin % helper column
    const notes = r
      .map((v, idx) => (known.has(idx) || idx >= 10 ? '' : String(v || '').trim()))
      .filter((v) => v && !/^-?[\d.,]+%$/.test(v))
      .join(' ');
    const isRefund = /\brefund\b/i.test(notes) && !/possible refund/i.test(notes) ? true : sale < 0;
    const key = `${month}|${normTitle(title)}`;
    const n = (occ.get(key) || 0) + 1;
    occ.set(key, n);
    entries.push({
      entry_key: `${key}|${n}`,
      month,
      title,
      amazon_cost: cost,
      sale_price: sale,
      ad_fees: ad,
      sheet_net: money(r[cNet]),
      note: notes || null,
      is_refund: isRefund,
    });
  }
  entries.forEach((e, idx) => { e.row_no = idx + 1; e.row_count = entries.length; });

  const expenses = [];
  const ei = rows.findIndex((r, idx) => idx > i && /^expense category$/i.test(String(r[0]).trim()));
  if (ei !== -1) {
    for (let j = ei + 1; j < rows.length; j++) {
      const cat = String(rows[j][0] || '').trim();
      if (!cat) continue;
      if (/^total operating/i.test(cat) || /^\d+\.\s/.test(cat)) break;
      const amount = money(rows[j][1]);
      const note = rows[j].slice(2).map((v) => String(v || '').trim()).filter(Boolean).join(' ') || null;
      if (amount === null || amount === 0) continue;
      expenses.push({ category: cat, amount, note });
    }
  }

  // "👉 Drew Paid, $1,304.76" = the settlement transfer already happened
  let paid = null;
  for (const r of rows) {
    const label = String(r[0] || '');
    if (/\bpaid\b/i.test(label) && !/sends|paid by|reimburse/i.test(label)) {
      const v = money(r[1]);
      if (v !== null) paid = v;
    }
  }

  const sum = (f) => Math.round(entries.reduce((s, e) => s + (e[f] || 0), 0) * 100) / 100;
  const computed = { cost: sum('amazon_cost'), sale: sum('sale_price'), ad: sum('ad_fees') };
  computed.net = Math.round((computed.sale - computed.cost - computed.ad) * 100) / 100;
  const checks = totals
    ? ['cost', 'sale', 'ad', 'net'].map((k) => ({ field: k, sheet: totals[k], computed: computed[k], ok: totals[k] === null || Math.abs((totals[k] || 0) - computed[k]) < 0.02 }))
    : [];
  return { month, entries, expenses, totals, computed, checks, paid };
}

export async function importLedgerCsv(buffer, filename) {
  const p = parseLedgerCsv(buffer, filename);
  let fresh = 0;
  let updated = 0;
  let unchanged = 0;
  const keys = [];
  for (const e of p.entries) {
    keys.push(e.entry_key);
    const ex = await one('select * from ledger_entries where entry_key = $1', [e.entry_key]);
    const vals = [e.entry_key, e.month, e.row_no, e.row_count, e.title, e.amazon_cost, e.sale_price, e.ad_fees, e.sheet_net, e.note, e.is_refund, filename];
    if (!ex) {
      await q(
        `insert into ledger_entries (entry_key, month, row_no, row_count, title, amazon_cost, sale_price, ad_fees, sheet_net, note, is_refund, source_file)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, vals);
      fresh++;
    } else {
      const same = Number(ex.amazon_cost) === e.amazon_cost && Number(ex.sale_price) === e.sale_price && Number(ex.ad_fees) === e.ad_fees &&
        (ex.note || null) === e.note && ex.is_refund === e.is_refund && ex.row_no === e.row_no && ex.row_count === e.row_count;
      if (same) { unchanged++; continue; }
      await q(
        `update ledger_entries set month=$2, row_no=$3, row_count=$4, title=$5, amazon_cost=$6, sale_price=$7, ad_fees=$8, sheet_net=$9,
           note=$10, is_refund=$11, source_file=$12, updated_at=now() where entry_key=$1`, vals);
      updated++;
    }
  }
  // Rows deleted from the sheet since the last upload of this month disappear here too
  const removed = await q(
    `delete from ledger_entries where month = $1 and not (entry_key = any($2)) and not manual returning entry_key`, [p.month, keys]);
  for (const x of p.expenses) {
    await q(
      `insert into expenses (month, category, amount, note, source) values ($1,$2,$3,$4,'sheet')
       on conflict (month, category) do update set amount = excluded.amount, note = excluded.note, updated_at = now()`,
      [p.month, x.category, x.amount, x.note]
    );
  }
  if (p.paid !== null) {
    await q(`insert into settlements (month, paid, note) values ($1, $2, 'from monthly sheet')
             on conflict (month) do update set paid = excluded.paid, updated_at = now()`, [p.month, p.paid]);
  }
  const matched = await matchLedger();
  return {
    kind: 'ledger',
    month: p.month,
    rows: p.entries.length,
    linesNew: fresh,
    linesUpdated: updated,
    linesUnchanged: unchanged,
    removed: removed.length,
    expenses: p.expenses.length,
    expenseTotal: Math.round(p.expenses.reduce((s, x) => s + x.amount, 0) * 100) / 100,
    checks: p.checks,
    computed: p.computed,
    matchedToEbay: matched,
    settlementPaid: p.paid,
  };
}

// Pair ledger rows with real eBay orders once the API has them: same month (±3 days), similar title,
// and the sheet's payout must look like this order's price after eBay fees.
export async function matchLedger() {
  const entries = await q('select * from ledger_entries where ebay_order_id is null and not is_refund');
  if (!entries.length) return 0;
  const taken = new Set((await q('select ebay_order_id from ledger_entries where ebay_order_id is not null')).map((r) => r.ebay_order_id));
  const orders = await q(
    `select o.order_id, o.created_at, o.revenue, string_agg(li.title, ' | ') as title
     from ebay_orders o left join ebay_line_items li on li.order_id = o.order_id
     where o.order_id not like 'DEMO-%' group by o.order_id`
  );
  const pairs = [];
  for (const e of entries) {
    const [y, m] = e.month.split('-').map(Number);
    const from = Date.UTC(y, m - 1, 1) - 3 * 86400_000;
    const to = Date.UTC(y, m, 1) + 3 * 86400_000;
    for (const o of orders) {
      const t = new Date(o.created_at).getTime();
      if (t < from || t > to || taken.has(o.order_id)) continue;
      const sim = titleSimilarity(e.title, o.title);
      if (sim < 0.5) continue;
      const ratio = Number(o.revenue) > 0 ? Number(e.sale_price) / Number(o.revenue) : 0;
      if (ratio < 0.7 || ratio > 1.02) continue;
      pairs.push({ e, o, score: sim * 100 - Math.abs(0.87 - ratio) * 50 });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  const usedE = new Set();
  let n = 0;
  for (const p of pairs) {
    if (usedE.has(p.e.entry_key) || taken.has(p.o.order_id)) continue;
    await q('update ledger_entries set ebay_order_id = $2, match_method = $3 where entry_key = $1', [p.e.entry_key, p.o.order_id, 'auto']);
    usedE.add(p.e.entry_key);
    taken.add(p.o.order_id);
    n++;
  }
  return n;
}
