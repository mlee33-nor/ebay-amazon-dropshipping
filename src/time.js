// One business calendar for every money decision: the partners' time zone (Arizona, no DST).
// A sale's month is decided here on the server, so every viewer sees the same settlement.
export const BUSINESS_TZ = process.env.BUSINESS_TZ || 'America/Phoenix';

const monthFmt = new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TZ, year: 'numeric', month: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

const part = (parts, type) => parts.find((x) => x.type === type).value;

export function businessMonth(d) {
  const p = monthFmt.formatToParts(new Date(d));
  return `${part(p, 'year')}-${part(p, 'month')}`;
}

export function businessDay(d) {
  const p = dayFmt.formatToParts(new Date(d));
  return `${part(p, 'year')}-${part(p, 'month')}-${part(p, 'day')}`;
}

export function prevMonth(m) {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y, mo - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
