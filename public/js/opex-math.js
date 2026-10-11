// Operating-cost rules, kept pure (no DOM) so the tests can check them. A cost's month is the payment it goes on: from
// September 2026 each payment covers the 27th of the month before through the 26th (Arizona time), so on the 27th-31st
// a new cost belongs to next month's payment. A payment that has been made is closed and never changes.
import { azDay } from './util.js';
import { settlePeriodOf } from './settlement.js';

export const shiftMonth = (m, n) => { const [y, mo] = m.split('-').map(Number); const t = y * 12 + (mo - 1) + n; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`; };

// An amount rounded to cents: "$16.19", "1,234" and "(8.00)" read as written. A negative amount is a credit (a
// refunded subscription, a proxy credit). Returns null for blank, zero or junk.
export const parseAmount = (raw) => {
  const s = String(raw ?? '').trim().replace(/^\((.*)\)$/, '-$1').replace(/^(-?)\s*\$\s*/, '$1').replace(/,(?=\d{3}(\D|$))/g, '');
  if (!s || !/^-?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && Math.abs(n) >= 0.005 ? Math.round(n * 100) / 100 : null;
};

// Payments already made (any recorded payment, a closed period, or a paid amount on the month)
export const paidMonthsOf = (books = {}) => new Set([
  ...(books.payments || []).map((p) => p.month),
  ...(books.closed || []).map((c) => c.month),
  ...(books.settlements || []).filter((s) => s.paid !== null && s.paid !== undefined && Math.abs(Number(s.paid)) >= 0.005).map((s) => s.month),
]);

// The first payment from `month` on that hasn't been made yet
export const nextOpenMonth = (month, paid) => { let m = month; while (paid.has(m)) m = shiftMonth(m, 1); return m; };

// The payment a cost entered now goes on: the one being built today (Arizona), or the next open one
export const defaultCostMonth = ({ books, dueDay = 26, now = Date.now() } = {}) => nextOpenMonth(settlePeriodOf(azDay(now), dueDay), paidMonthsOf(books));

// Why a new cost can't be saved as entered, or null. A credit needs a note and an open payment.
export function costProblem({ month, amount, note, paidBy }, paid) {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return 'amount';
  if (paidBy !== 'seller' && paidBy !== 'amazon') return 'paid_by';
  if (amount < 0 && !String(note || '').trim()) return 'note';
  if (paid.has(month)) return 'paid';
  return null;
}

// A cost on a payment that has been made can't be changed, deleted or moved, and no cost can be moved or added onto
// one: the payment would no longer match what was sent. Returns the paid month that blocks it, or null. `was` is the
// saved cost (null for a new one), `now` what it would become (null when it is deleted).
export function closedCostMonth({ was = null, now = null }, paid) {
  if (was && paid.has(was.month)) return was.month;
  if (now && paid.has(now.month)) return now.month;
  return null;
}

// "Copy last month" onto the payment `into` (the next open one): the costs of the payment before it whose names aren't
// on `into` yet. Names are matched the way a person reads them (trimmed, case-insensitive, spaces collapsed).
const normName = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
export function copyPlan(expenses, into) {
  const last = shiftMonth(into, -1);
  const lastList = expenses.filter((e) => e.month === last);
  const have = new Set(expenses.filter((e) => e.month === into).map((e) => normName(e.category)));
  const toCopy = [];
  for (const e of lastList) if (!have.has(normName(e.category))) { toCopy.push(e); have.add(normName(e.category)); }
  const skipped = lastList.filter((e) => !toCopy.includes(e));
  return { into, last, lastList, toCopy, skipped, total: Math.round(toCopy.reduce((s, e) => s + Math.round(e.amount * 100), 0)) / 100 };
}
