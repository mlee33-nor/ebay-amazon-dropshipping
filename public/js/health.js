// Is the data complete? Shared by the banners on every page and the Settle page's check before a payment is recorded.
// Pure (no DOM), so the tests run it directly. Every server field read here is optional: an older server that doesn't
// send them simply gives fewer warnings, and no page breaks.
import { azDay, azStart, addDays, fmtDate, fmtDateTime, money, syncFailed, syncInProgress } from './util.js';
import { settlePeriodRange, CYCLE_START } from './settlement.js';
import { rowMonth, isSale } from './metrics.js';

export const SYNC_STALE_HOURS = 3; // syncs run every 30 minutes; 3 hours without one means something stopped
export const AD_FEE_HOURS = 48; // eBay can post a sale's ad fee up to about a day after the sale
const HOUR = 3600_000;
const STEP_LABEL = { orders: 'Orders', finances: 'Finances (fees, ad fees, refunds)', returns: 'Returns' };
const ms = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : null; };

// How long a step can go without a good run before it is called behind: the server's own `stale_after_minutes` for
// the step, else six of its runs (`interval_minutes`), never less than SYNC_STALE_HOURS
export const staleAfterMs = (s) => {
  const after = Number(s?.stale_after_minutes);
  if (after > 0) return after * 60_000;
  const every = Number(s?.interval_minutes);
  return Math.max(SYNC_STALE_HOURS * HOUR, every > 0 ? every * 6 * 60_000 : 0);
};

// The eBay sync steps that failed, were skipped or haven't run lately. `ebay.steps` is
// { orders, finances, returns }, each { ok, at, message } (ok may also be 'skipped', or a `status` string), and may
// say how often the step runs (interval_minutes / stale_after_minutes). While a sync is running nothing is "behind".
export function ebayStepIssues(ebay, now = Date.now()) {
  const steps = ebay?.steps;
  if (!ebay?.configured || !steps || typeof steps !== 'object') return [];
  const out = [];
  for (const step of ['orders', 'finances', 'returns']) {
    const s = steps[step];
    if (!s || typeof s !== 'object') continue;
    const status = String(s.status || (s.ok === 'skipped' || s.skipped ? 'skipped' : s.ok === false ? 'failed' : s.ok === true ? 'ok' : '')).toLowerCase();
    const message = String(s.message || s.reason || s.error || '').slice(0, 200);
    if (status === 'failed' || status === 'error' || status === 'partial') out.push({ step, label: STEP_LABEL[step], problem: 'failed', message, at: s.at || null });
    else if (status === 'skipped') out.push({ step, label: STEP_LABEL[step], problem: 'skipped', message, at: s.at || null });
    else if (!syncInProgress(ebay)) {
      const last = ms(s.last_ok_at || s.lastOk || s.at);
      if (last !== null && now - last > staleAfterMs(s)) out.push({ step, label: STEP_LABEL[step], problem: 'stale', message, at: new Date(last).toISOString() });
    }
  }
  return out;
}

// Amazon emails the import couldn't read (a cost or refund that is missing from the books)
export const emailFailures = (email) => (Array.isArray(email?.failed) ? email.failed.filter(Boolean) : []);
export const emailFailureText = (f) => {
  if (typeof f === 'string') return f;
  const ids = Array.isArray(f.order_ids) ? f.order_ids.join(' ') : f.amazon_order_id || f.order_id || '';
  const when = f.received_at || f.at;
  return [f.subject || f.kind || 'Amazon email', ids, when ? fmtDate(when) : '', f.note || f.message || f.reason || ''].filter(Boolean).join(' · ');
};

// One line per eBay step problem, for a banner
export function ebayIssueText(issues) {
  return issues.map((i) => (i.problem === 'stale' ? `${i.label} hasn't synced since ${fmtDateTime(i.at)}`
    : `${i.label} ${i.problem === 'skipped' ? 'was skipped' : 'failed'}${i.message ? ` (${i.message})` : ''}`)).join(' · ');
}

// What still might change a payment that is about to be recorded. Each warning is { key, title, items[] }.
// (a) sales on this payment still waiting for their Amazon cost, or flagged as maybe on a sheet: not in the total yet;
// (b) sales on it less than 48 hours old with no ad fee yet: eBay may still charge one;
// (c) the eBay Finances / returns sync or the Amazon email import failed, or last ran before the newest sale;
// (d) returns still open: a refund would come off a payment;
// (e) the period isn't over yet (it runs through the 26th, Arizona time; the last ad fees post by about 7am on the 27th).
export function paymentWarnings({ month, orders, ebay, email, now = Date.now(), dueDay = 26 }) {
  const out = [];
  const label = (o) => `${String(o.title || '').replace(/^Refund · /, '').slice(0, 50)} (${o.source === 'ledger' ? 'monthly sheet' : o.refund_of || o.order_id})`;
  const onIt = orders.filter((o) => rowMonth(o) === month);
  const waiting = onIt.filter((o) => ['awaiting_cost', 'check_sheet', 'needs_review'].includes(o.status));
  if (waiting.length) {
    out.push({ key: 'waiting', title: `${waiting.length} sale${waiting.length === 1 ? ' is' : 's are'} not in this payment yet (waiting for the Amazon cost or a check)`,
      items: waiting.map((o) => `${label(o)}: ${o.status === 'awaiting_cost' ? 'needs its Amazon cost' : 'needs a check'}, ${money(o.revenue, 2)} sale`) });
  }
  const recent = onIt.filter((o) => o.counted && o.source === 'ebay' && isSale(o) && !(o.ad_fees > 0) && now - Date.parse(o.created_at) < AD_FEE_HOURS * HOUR);
  if (recent.length) {
    out.push({ key: 'ad_fees', title: `${recent.length} sale${recent.length === 1 ? ' is' : 's are'} less than ${AD_FEE_HOURS} hours old: eBay may still charge an ad fee`,
      items: recent.map((o) => `${label(o)}: sold ${fmtDateTime(o.created_at)}`) });
  }
  // Newest sale on this payment: a sync that last ran before it can't have its fees or refunds yet
  const newest = Math.max(0, ...onIt.filter((o) => o.source === 'ebay').map((o) => Date.parse(o.created_at) || 0));
  const sync = [];
  const steps = ebayStepIssues(ebay, now);
  for (const i of steps.filter((x) => x.step !== 'orders' || x.problem !== 'stale')) sync.push(ebayIssueText([i]));
  const fin = ebay?.steps?.finances;
  const finAt = ms(fin?.last_ok_at || fin?.lastOk || (fin && fin.ok !== false ? fin.at : null));
  if (!steps.some((x) => x.step === 'finances') && finAt !== null && newest && finAt < newest) sync.push(`Finances last synced ${fmtDateTime(finAt)}, before the newest sale on this payment`);
  if (ebay?.configured && !ebay.steps) {
    if (syncFailed(ebay)) sync.push(`The last eBay sync failed${ebay.last?.message ? ` (${String(ebay.last.message).slice(0, 120)})` : ''}`);
    else if (!syncInProgress(ebay) && ebay.lastSuccess && now - Date.parse(ebay.lastSuccess) > SYNC_STALE_HOURS * HOUR) sync.push(`eBay hasn't synced since ${fmtDateTime(ebay.lastSuccess)}`);
  }
  if (email?.configured && !email.running && email.last) {
    if (!email.last.ok) sync.push('The last Amazon email check failed');
    else if (newest && Date.parse(email.last.at) < newest) sync.push(`Amazon email was last checked ${fmtDateTime(email.last.at)}, before the newest sale on this payment`);
  }
  for (const f of emailFailures(email)) sync.push(`Amazon email not read: ${emailFailureText(f)}`);
  if (sync.length) out.push({ key: 'sync', title: 'Some data may be missing (a sync failed or is behind)', items: sync });
  const open = orders.filter((o) => o.counted && o.return_open);
  if (open.length) {
    out.push({ key: 'returns', title: `${open.length} return${open.length === 1 ? ' is' : 's are'} still open (not refunded yet)`,
      items: open.map((o) => `${label(o)}: ${money(o.return_open.amount, 2)} on hold since ${fmtDate(o.return_open.since)}${o.return_open.profit_hit ? `, a refund would take about ${money(o.return_open.profit_hit, 2)} off the profit` : ''}`) });
  }
  if (month >= CYCLE_START) {
    const { to } = settlePeriodRange(month, dueDay);
    const settled = azStart(addDays(to, 1)).getTime() + 7 * HOUR; // 7am Arizona on the day after the period ends
    if (now < settled) {
      out.push({ key: 'early', title: azDay(now) <= to ? `This period isn't over: it runs through ${fmtDate(to, { month: 'short', day: 'numeric' })} (Arizona time)` : 'eBay may still be posting the last ad fees for this period',
        items: [`Sales until the end of ${fmtDate(to, { month: 'short', day: 'numeric' })} still belong to this payment, and eBay posts the last ad fees by about 7am Arizona time on ${fmtDate(addDays(to, 1), { month: 'short', day: 'numeric' })}. Recording the payment after that is safest.`] });
    }
  }
  return out;
}

// The warnings as plain text for a confirm() box
export function warningsText(list, max = 4) {
  return list.map((w) => `• ${w.title}${w.items.length ? `\n${w.items.slice(0, max).map((i) => `    - ${i}`).join('\n')}${w.items.length > max ? `\n    - and ${w.items.length - max} more` : ''}` : ''}`).join('\n\n');
}

// Why a payment date can't be recorded, or null: a date is needed, as YYYY-MM-DD, and never after today in Arizona
export function paymentDateProblem(paidAt, now = Date.now()) {
  const d = String(paidAt || '');
  if (!d) return 'missing';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(`${d}T12:00:00Z`))) return 'format';
  if (d > azDay(now)) return 'future';
  return null;
}
