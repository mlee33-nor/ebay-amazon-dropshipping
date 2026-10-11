// What the dashboard shows: pages in the menu, cards on the Overview, alerts across the top. Set in Settings ->
// Customize dashboard and saved on the server (settings.dashboard), so both partners see the same dashboard. Anything
// not saved yet uses its default. A page switched off is only hidden from the menu: links to it still work.

export const PAGE_OPTIONS = [
  { id: 'overview', label: 'Overview', on: true, locked: true, note: 'The home page' },
  { id: 'review', label: 'Review', on: true, note: 'Things to look at, in one list (with a count in the menu)' },
  { id: 'orders', label: 'Orders', on: true, note: 'Every sale and what it made' },
  { id: 'settlement', label: 'Settlement', on: true, locked: true, note: 'What Drew sends Myles each pay period (always shown)' },
  { id: 'reports', label: 'Statements', on: true, note: 'A printable statement for each payment, and the tax export' },
  { id: 'costs', label: 'Monthly costs', on: true, note: 'Subscriptions and tools that come out of profit' },
  { id: 'promotions', label: 'Promotions', on: true, note: 'Promoted listings: ad fees and what they sold' },
  { id: 'ask', label: 'Ask AI', on: true, note: 'Ask about the numbers in your own words' },
  { id: 'trends', label: 'Analytics', on: false, note: 'Charts by day, hour, state and price' },
  { id: 'products', label: 'Products', on: false, note: 'Listings, views and what sells' },
  { id: 'returns', label: 'Returns', on: false, note: 'Refunds and return reasons' },
  { id: 'watch', label: 'Watchlist', on: false, note: 'Money to chase: Amazon refunds, unmatched purchases' },
  { id: 'editor', label: 'Editor', on: false, note: 'Fix a cost or match by hand (spreadsheet view)' },
  { id: 'import', label: 'Monthly sheets', on: false, note: 'Check your sheet against the site' },
  { id: 'settings', label: 'Settings', on: true, locked: true, note: 'Always shown' },
];

export const CARD_OPTIONS = [
  { id: 'profit', label: 'Profit', on: true, note: 'Profit for the time picked, and how it adds up' },
  { id: 'owed', label: 'Settlement', on: true, note: 'What Drew sends Myles, when it is due, and each pay period' },
  { id: 'breakdown', label: 'How the profit adds up', on: true, note: 'Sales money, Amazon costs, ad fees and monthly costs' },
  { id: 'attention', label: 'Needs attention', on: true, note: 'How many things are on the Review page' },
  { id: 'chart', label: 'Profit by day', on: true, note: 'A simple bar chart' },
  { id: 'recent', label: 'Latest sales', on: true, note: 'The newest sales and what each made' },
  { id: 'promo', label: 'Promotions summary', on: true, note: 'Ad fees and promoted sales for the time picked' },
  { id: 'top', label: 'Best sellers', on: false, note: 'Products that made the most' },
];

export const ALERT_OPTIONS = [
  { id: 'sync', label: 'Connection problems', on: true, note: 'eBay or Amazon email stopped working (recommended)' },
  { id: 'due', label: 'Payment due', on: true, note: 'The red bar when a payment is due within 5 days' },
  { id: 'setup', label: 'Setup tips', on: true, note: 'Reminders like “connect your email”' },
];

const GROUPS = { pages: PAGE_OPTIONS, cards: CARD_OPTIONS, alerts: ALERT_OPTIONS };

// The saved choices with every default filled in: { pages: { id: bool }, cards: {...}, alerts: {...} }
export function dashPrefs(settings) {
  const saved = settings?.dashboard || {};
  const out = {};
  for (const [g, list] of Object.entries(GROUPS)) {
    out[g] = {};
    for (const o of list) out[g][o.id] = o.locked ? true : typeof saved[g]?.[o.id] === 'boolean' ? saved[g][o.id] : o.on;
  }
  return out;
}

export const showPage = (settings, id) => dashPrefs(settings).pages[id] !== false;
export const showCard = (settings, id) => dashPrefs(settings).cards[id] !== false;
export const showAlert = (settings, id) => dashPrefs(settings).alerts[id] !== false;

// Everything back to its default
export function defaultPrefs() {
  return Object.fromEntries(Object.entries(GROUPS).map(([g, list]) => [g, Object.fromEntries(list.map((o) => [o.id, o.on]))]));
}
