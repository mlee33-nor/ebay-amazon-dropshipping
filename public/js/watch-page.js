// Watchlist: money to chase and things to fix.
//   1. Amazon refunds to chase: eBay refunded the buyer, but Amazon hasn't refunded what was paid for the item
//   2. Amazon purchases with no eBay sale: missed matches, or purchases that aren't for the business
//   3. Products to reconsider: losing money, refunded often, or too thin to be worth listing
// Layout: one header card (the verdict + three tiles that jump to their section), then one card per list.
// Empty lists collapse to a single "all clear" row; long lists show the first SHOW_FIRST rows with a toggle.
import { esc, money, pct, count, fmtDate, api, toast, ICONS, DAY, reducedMotion } from './util.js';
import { byProduct, productKey } from './metrics.js';
import { state, loadData, renderPage, openOrder, skeletonRows } from './app.js';

const CHASE_AFTER_DAYS = 14;
const SHOW_FIRST = 10;
const cents = (n) => Math.round((Number(n) || 0) * 100);

export function refundsToChase(orders) {
  return orders
    .filter((o) => o.source === 'ebay' && !o.cancelled && o.status !== 'not_dropship' && (o.raw_refunds || 0) > 0 && o.amazon_orders.length && (o.cost_source === 'amazon' || o.cost_source === 'override') && o.cost > 0)
    .map((o) => {
      const got = Math.max(o.email_refund || 0, o.amazon_refund || 0, o.overrides?.amazon_refund || 0);
      const missing = Math.round((cents(o.cost) - cents(got))) / 100;
      const since = o.last_refund_at || o.created_at;
      return { o, got, missing, days: Math.floor((Date.now() - new Date(since)) / DAY), since };
    })
    .filter((x) => x.missing > 0.009)
    .sort((a, b) => b.days - a.days);
}

export function productsToReconsider(orders) {
  const counted = orders.filter((o) => o.counted);
  // byProduct's summary replaces the order list with a count, so keep each product's orders here
  const lists = new Map();
  for (const o of counted) { const k = productKey(o); if (!lists.has(k)) lists.set(k, []); lists.get(k).push(o); }
  return byProduct(counted)
    .map((p) => {
      const mine = lists.get(p.key) || [];
      const refunds = mine.filter((o) => (o.refunds || 0) > 0 || o.status === 'returned').length;
      const n = p.countedOrders;
      const margin = p.revenue ? p.net / p.revenue : null;
      let verdict = null;
      if (n >= 2 && p.net < 0) verdict = { cls: 'bad', t: 'Stop listing', why: `lost ${money(-p.net, 2)} over ${n} sales` };
      else if (refunds >= 2 && refunds / n >= 0.3) verdict = { cls: 'warn', t: 'Check quality', why: `${refunds} of ${n} sales refunded` };
      else if (n >= 3 && margin !== null && margin < 0.05) verdict = { cls: 'warn', t: 'Raise price', why: `only ${pct(margin)} margin` };
      else if (n === 1 && p.net < -5) verdict = { cls: 'warn', t: 'Watch', why: `one sale lost ${money(-p.net, 2)}` };
      // Display only: the product's most recent counted sale, where "Review in Editor" lands
      const last = mine.reduce((a, o) => (!a || String(o.created_at) > String(a.created_at) ? o : a), null);
      return verdict ? { ...p, n, refunds, margin, verdict, lastOrderId: last?.order_id || null } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.net - b.net);
}

// ---------------------------------------------------------------- presentation
const plural = (n, one, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`;
const TONE_ICON = { good: ICONS.circleCheck, warn: ICONS.circleAlert, bad: ICONS.alert, pending: ICONS.clock };
const VERDICT_ICON = { 'Stop listing': ICONS.circleX, 'Check quality': ICONS.return, 'Raise price': ICONS.arrowUp, Watch: ICONS.info };
const infoTip = (text) => `<button type="button" class="w-i" title="${esc(text)}" aria-label="${esc(`About this list: ${text}`)}">${ICONS.info}</button>`;
const extraCls = (i) => (i >= SHOW_FIRST ? 'w-extra' : '');
const btnLabel = (long, short) => `<span class="l-long">${long}</span><span class="l-short">${short}</span>`;
const actionTh = '<th class="r"><span class="sr-only">Action</span></th>';
const moreFoot = (n) => (n > SHOW_FIRST
  ? `<div class="wsec-f"><button type="button" class="btn sm ghost w-more" data-more="${n}" aria-expanded="false">${ICONS.chevronDown}<span>Show all ${count(n)}</span></button><span class="muted">Showing ${SHOW_FIRST} of ${count(n)}</span></div>`
  : '');

function tile({ goto, tone, icon, label, value, foot, ok = false }) {
  return `<button type="button" class="wtile ${tone}" data-goto="${goto}" title="Jump to ${esc(label)}">
    <span class="wtile-top"><span class="wtile-ic" aria-hidden="true">${icon}</span><span class="wtile-l">${label}</span>${ICONS.chevron}</span>
    <span class="wtile-v num">${value}</span>
    <span class="wtile-f ${ok ? 'ok' : ''}">${foot}</span>
  </button>`;
}

// One section card. n === 0 collapses it to a single row; n === null is the loading state; `error` is a failed
// load (one row with a Retry button); otherwise it carries `body`.
function section({ id, tone, icon, title, n, sub, tip = '', right = '', clearText, body = '', error = '' }) {
  const mode = error ? 'error' : n === 0 ? 'clear' : n === null ? 'pending' : 'has';
  const ic = mode === 'clear' ? 'good' : mode === 'pending' ? 'pending' : mode === 'error' ? 'warn' : tone;
  const status = mode === 'clear' ? `<span class="pill good">${ICONS.check} ${btnLabel('All clear', 'Clear')}</span>`
    : mode === 'pending' ? `<span class="pill">${ICONS.clock} Checking…</span>`
    : mode === 'error' ? `<button type="button" class="btn sm" data-retry="1">${ICONS.refresh} Retry</button>`
    : right;
  const line = mode === 'clear' ? clearText : mode === 'error' ? `Couldn't load Amazon purchases: ${esc(error)}` : sub;
  return `<section class="card wsec ${mode} ${mode === 'has' ? tone : ''}" id="${id}" aria-labelledby="${id}-t" aria-busy="${mode === 'pending'}">
    <div class="wsec-h">
      <span class="wsec-ic ${ic}" aria-hidden="true">${mode === 'clear' ? ICONS.circleCheck : mode === 'error' ? ICONS.circleAlert : icon}</span>
      <div class="wsec-tt">
        <h3 id="${id}-t">${title}${mode === 'has' ? `<span class="wsec-n">${count(n)}</span>` : ''}</h3>
        <div class="wsec-s"><span>${line}</span>${tip && mode !== 'error' ? infoTip(tip) : ''}</div>
      </div>
      <div class="wsec-r">${status}</div>
    </div>
    ${mode === 'has' || mode === 'pending' ? `<div class="wsec-b">${mode === 'pending' ? skeletonRows(3) : body}</div>` : ''}
  </section>`;
}

export async function renderWatch(el) {
  const d = state.data;
  const A = d.settings.partner_amazon;
  const chase = refundsToChase(d.orders);
  const chaseTotal = chase.reduce((t, x) => t + cents(x.missing), 0) / 100;
  const late = chase.filter((x) => x.days >= CHASE_AFTER_DAYS);
  const recon = productsToReconsider(d.orders);
  const losing = recon.filter((r) => r.verdict.cls === 'bad').length;
  let unmatched = null; // null while /api/amazon loads, then { list, spent } or { error }

  const chaseTone = late.length ? 'bad' : chase.length ? 'warn' : 'good';
  const reconTone = losing ? 'bad' : recon.length ? 'warn' : 'good';
  const unmTone = () => (unmatched === null ? 'pending' : unmatched.error ? 'warn' : unmatched.list.length ? 'info' : 'good');

  // ---- header: verdict + tiles
  const verdict = () => {
    const parts = [];
    if (chase.length) parts.push(`<b>${money(chaseTotal, 2)}</b> to recover from Amazon${late.length ? ` (${late.length} over ${CHASE_AFTER_DAYS} days)` : ''}`);
    if (unmatched?.list?.length) parts.push(`<b>${plural(unmatched.list.length, 'purchase')}</b> not tied to a sale`);
    if (recon.length) parts.push(`<b>${plural(recon.length, 'product')}</b> to reconsider`);
    const n = parts.length;
    const pending = unmatched === null;
    const failed = Boolean(unmatched?.error);
    const tone = late.length ? 'bad' : n ? 'warn' : pending ? 'pending' : failed ? 'warn' : 'good';
    const title = n ? `${n === 1 ? '1 thing needs' : `${n} things need`} attention` : pending ? 'Checking Amazon purchases…' : failed ? "Couldn't check Amazon purchases" : 'All clear';
    let sub;
    if (n) sub = parts.join(' · ') + (pending ? ' · checking Amazon purchases…' : failed ? " · Amazon purchases couldn't be checked" : '');
    else if (pending || failed) sub = 'Nothing to chase and no product needs a second look.';
    else sub = 'Nothing to chase, every Amazon purchase is matched, and no product needs a second look.';
    return { tone, title, sub };
  };

  const tiles = () => {
    const u = unmatched;
    const unmValue = u === null ? '<span class="sk wtile-sk" aria-label="Loading"></span>' : u.error ? '—' : count(u.list.length);
    const unmFoot = u === null ? 'checking…' : u.error ? "couldn't load" : u.list.length ? `${money(u.spent, 2)} not tied to a sale` : `${ICONS.check} All matched`;
    const others = recon.length - losing;
    return tile({ goto: 'w-chase', tone: chaseTone, icon: ICONS.return, label: 'Refunds to chase', value: `<span class="${chaseTotal ? 'neg' : ''}">${money(chaseTotal, 2)}</span>`, ok: !chase.length,
      foot: chase.length ? `${plural(chase.length, 'order')}${late.length ? ` · <b class="neg">${late.length} over ${CHASE_AFTER_DAYS} days</b>` : ''}` : `${ICONS.check} Nothing to chase` })
      + tile({ goto: 'w-unmatched', tone: unmTone(), icon: ICONS.package, label: 'Unmatched purchases', value: unmValue, foot: unmFoot, ok: Boolean(u && !u.error && !u.list.length) })
      + tile({ goto: 'w-recon', tone: reconTone, icon: ICONS.trendDown, label: 'Products to reconsider', value: count(recon.length), ok: !recon.length,
        foot: recon.length ? [losing ? `${losing} losing money` : '', others ? `${others} to watch` : ''].filter(Boolean).join(' · ') : `${ICONS.check} No problem products` });
  };

  const hero = () => {
    const v = verdict();
    return { tone: v.tone, html: `<div class="wv ${v.tone}" role="status"><div class="wv-ic" aria-hidden="true">${TONE_ICON[v.tone]}</div><div class="wv-tt"><div class="wv-lbl"><span class="live"></span>Watchlist</div><h2 class="wv-t">${v.title}</h2><div class="wv-s">${v.sub}</div></div></div><div class="wtiles">${tiles()}</div>` };
  };

  // ---- 1. refunds to chase
  const chaseSection = () => section({
    id: 'w-chase', tone: chaseTone, icon: ICONS.return, title: 'Amazon refunds to chase', n: chase.length,
    sub: `eBay refunded the buyer, but Amazon hasn't refunded what ${esc(A)} paid.`,
    tip: `Once Amazon refunds, the refund email is picked up automatically and the row disappears. If Amazon won't refund, enter what was recovered in the Editor's “Amazon refund” column. Rows turn red after ${CHASE_AFTER_DAYS} days.`,
    clearText: 'Every refunded eBay sale has its Amazon refund recorded.',
    right: late.length ? `<span class="pill bad">${ICONS.alert} ${late.length} over ${CHASE_AFTER_DAYS} days</span>` : '',
    body: chase.length ? `<div class="wtable-wrap"><table class="simple wtable">
      <thead><tr><th class="hide-m">Sold</th><th>Item</th><th class="r hide-m">Refunded to buyer</th><th class="r hide-m">Amazon cost</th><th class="r hide-m">Amazon refunded</th><th class="r">Still to recover</th><th class="r">Waiting</th>${actionTh}</tr></thead>
      <tbody>${chase.map((x, i) => {
        const isLate = x.days >= CHASE_AFTER_DAYS;
        const ids = x.o.amazon_orders.map((a) => a.amazon_order_id).join(', ');
        return `<tr class="${isLate ? 'late' : ''} ${extraCls(i)}">
          <td class="c-date hide-m nowrap">${fmtDate(x.o.created_at)}</td>
          <td class="wt-item c-item"><div class="wt-title" title="${esc(x.o.title)}">${esc(x.o.title)}</div><div class="wt-sub"><span class="mono">${esc(ids)}</span><span class="only-m"> · sold ${fmtDate(x.o.created_at)}</span></div></td>
          <td class="r num hide-m">${money(x.o.raw_refunds, 2)}</td>
          <td class="r num hide-m">${money(x.o.cost, 2)}</td>
          <td class="r num hide-m ${x.got ? '' : 'dim'}">${money(x.got, 2)}</td>
          <td class="r num c-amt"><b class="neg">${money(x.missing, 2)}</b><span class="wt-lbl only-m">to recover</span></td>
          <td class="r nowrap c-pill">${isLate
            ? `<span class="pill bad" title="Over ${CHASE_AFTER_DAYS} days without an Amazon refund">${ICONS.alert} ${x.days} days</span>`
            : `<span class="pill" title="Days since the buyer was refunded">${ICONS.clock} ${x.days} day${x.days === 1 ? '' : 's'}</span>`}</td>
          <td class="r nowrap c-act"><button type="button" class="btn sm" data-open="${esc(x.o.order_id)}" aria-label="Open order ${esc(x.o.order_id)}">${btnLabel('Open order', 'Open')}</button></td>
        </tr>`;
      }).join('')}</tbody></table></div>${moreFoot(chase.length)}` : '',
  });

  // ---- 2. Amazon purchases with no eBay sale (fetched separately: the list of Amazon lines isn't in the main data)
  const unmatchedSection = () => {
    const u = unmatched;
    const list = u?.list || [];
    return section({
      id: 'w-unmatched', tone: unmTone(), icon: ICONS.package, title: 'Amazon purchases with no eBay sale', n: u === null ? null : list.length, error: u?.error || '',
      sub: 'Not tied to any eBay sale, so they never count toward profit.',
      tip: "Usually a match the matcher wasn't sure about (review it in the Editor), or a purchase that isn't for the business (mark it Not business).",
      clearText: 'Every Amazon purchase from the email import is tied to an eBay sale.',
      right: `<a class="btn sm" href="#/editor?tab=matches">${ICONS.link} Review matches</a>`,
      body: list.length ? `<div class="wtable-wrap"><table class="simple wtable">
        <thead><tr><th class="hide-m">Ordered</th><th class="hide-m">Amazon order</th><th class="hide-m">Ship to</th><th>What</th><th class="r">Total</th><th class="r hide-m">Age</th>${actionTh}</tr></thead>
        <tbody>${list.map((x, i) => {
          const age = x.date ? Math.floor((Date.now() - new Date(x.date)) / DAY) : null;
          return `<tr class="${extraCls(i)}">
            <td class="hide-m nowrap">${x.date ? fmtDate(x.date) : '—'}</td>
            <td class="hide-m nowrap"><span class="mono">${esc(x.id)}</span></td>
            <td class="hide-m">${esc(x.who || '—')}</td>
            <td class="wt-item c-item"><div class="wt-title" title="${esc(x.title || '')}">${x.title ? esc(x.title) : '<span class="muted">No item title</span>'}</div><div class="wt-sub only-m"><span class="mono">${esc(x.id)}</span>${x.date ? ` · ${fmtDate(x.date)}` : ''}${x.who ? ` · ${esc(x.who)}` : ''}</div></td>
            <td class="r num c-amt">${x.known ? money(x.total, 2) : '<span class="muted">unknown</span>'}</td>
            <td class="r num hide-m dim">${age === null ? '—' : `${age}d`}</td>
            <td class="r nowrap c-act"><button type="button" class="btn sm" data-ignore="${esc(x.id)}" title="Mark as not for the business">${ICONS.eyeOff} Not business</button></td>
          </tr>`;
        }).join('')}</tbody></table></div>${moreFoot(list.length)}` : '',
    });
  };

  // ---- 3. products to reconsider
  const reconSection = () => section({
    id: 'w-recon', tone: reconTone, icon: ICONS.trendDown, title: 'Products to reconsider', n: recon.length,
    sub: 'All-time counted sales: losing money, refunded often, or margin under 5%.',
    tip: 'Stop listing: 2+ sales and a net loss. Check quality: 2+ refunds and at least 30% of sales refunded. Raise price: 3+ sales under 5% margin. Watch: a single sale that lost more than $5.',
    clearText: 'Nothing is losing money, refunded often or selling on a razor-thin margin.',
    right: losing ? `<span class="pill bad">${ICONS.trendDown} ${losing} losing money</span>` : '',
    body: recon.length ? `<div class="wtable-wrap"><table class="simple wtable">
      <thead><tr><th>Product</th><th class="r hide-m">Sold</th><th class="r">Profit</th><th class="r hide-m">Margin</th><th class="r hide-m">Refunds</th><th>Suggestion</th>${actionTh}</tr></thead>
      <tbody>${recon.map((p, i) => `<tr class="${extraCls(i)}">
          <td class="wt-item c-item"><div class="wt-title" title="${esc(p.title)}">${esc(p.title)}</div><div class="wt-sub only-m">${plural(p.n, 'sale')} · ${pct(p.margin)} margin · ${plural(p.refunds, 'refund')}</div></td>
          <td class="r num hide-m">${count(p.n)}</td>
          <td class="r num c-amt"><b class="${p.net < 0 ? 'neg' : ''}">${money(p.net, 2)}</b><span class="wt-lbl only-m">net profit</span></td>
          <td class="r num hide-m">${pct(p.margin)}</td>
          <td class="r num hide-m ${p.refunds ? '' : 'dim'}">${count(p.refunds)}</td>
          <td class="c-pill"><span class="wt-verdict"><span class="pill ${p.verdict.cls}">${VERDICT_ICON[p.verdict.t] || ICONS.info} ${p.verdict.t}</span><span class="wt-why">${esc(p.verdict.why)}</span></span></td>
          <td class="r nowrap c-act"><a class="btn sm" href="${p.lastOrderId ? `#/editor?order=${encodeURIComponent(p.lastOrderId)}` : '#/editor'}" title="Opens the Editor on this product's latest sale">${ICONS.editor} ${btnLabel('Review in Editor', 'Review')}</a></td>
        </tr>`).join('')}</tbody></table></div>${moreFoot(recon.length)}` : '',
  });

  const h = hero();
  el.innerHTML = `<div class="watch">
    <div class="card watch-hero ${h.tone}" id="w-hero">${h.html}</div>
    ${chaseSection()}
    ${unmatchedSection()}
    ${reconSection()}
  </div>`;
  const root = el.firstElementChild;

  const paintHeader = () => {
    const box = root.querySelector('#w-hero');
    if (!box) return;
    const x = hero();
    box.className = `card watch-hero ${x.tone}`;
    box.innerHTML = x.html;
  };
  const paintUnmatched = () => {
    const sec = root.querySelector('#w-unmatched');
    if (sec) sec.outerHTML = unmatchedSection();
  };

  const load = async () => {
    try {
      const lines = await api('/api/amazon');
      const byOrder = new Map();
      for (const l of lines) {
        if (l.ebay_order_id || l.ignored || /cancel/i.test(l.order_status || '')) continue;
        if (!byOrder.has(l.amazon_order_id)) byOrder.set(l.amazon_order_id, { id: l.amazon_order_id, date: l.order_date, total: 0, known: true, who: [l.ship_name, l.ship_state].filter(Boolean).join(', '), title: l.title });
        const x = byOrder.get(l.amazon_order_id);
        if (l.line_total === null) x.known = false; else x.total += Number(l.line_total) || 0;
      }
      const list = [...byOrder.values()].sort((a, b) => String(b.date).localeCompare(String(a.date)));
      unmatched = { list, spent: list.filter((x) => x.known).reduce((t, x) => t + x.total, 0) };
    } catch (e) {
      unmatched = { error: e.message };
    }
    if (!root.isConnected) return; // navigated away
    paintUnmatched();
    paintHeader();
  };

  // One listener for the whole page: tiles jump to their section, rows open / ignore, footers expand
  root.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-goto],[data-open],[data-more],[data-ignore],[data-retry]');
    if (!b || !root.contains(b)) return;
    if (b.dataset.retry) {
      unmatched = null;
      paintUnmatched();
      paintHeader();
      return load();
    }
    if (b.dataset.goto) {
      const sec = root.querySelector(`#${b.dataset.goto}`);
      if (!sec) return;
      sec.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
      sec.classList.remove('flash');
      void sec.offsetWidth;
      sec.classList.add('flash');
      sec.addEventListener('animationend', () => sec.classList.remove('flash'), { once: true });
      return;
    }
    if (b.dataset.open) return openOrder(b.dataset.open);
    if (b.dataset.more) {
      const sec = b.closest('.wsec');
      const n = Number(b.dataset.more);
      const on = sec.classList.toggle('expanded');
      b.setAttribute('aria-expanded', String(on));
      b.querySelector('span').textContent = on ? `Show first ${SHOW_FIRST}` : `Show all ${count(n)}`;
      const note = sec.querySelector('.wsec-f .muted');
      if (note) note.textContent = on ? `Showing all ${count(n)}` : `Showing ${SHOW_FIRST} of ${count(n)}`;
      if (!on) sec.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
      return;
    }
    if (b.dataset.ignore) {
      if (!confirm(`Mark Amazon order ${b.dataset.ignore} as not for the business? It will stay out of the numbers and off this list.`)) return;
      b.disabled = true;
      try {
        await api('/api/links/reject', { method: 'POST', body: { amazon_order_id: b.dataset.ignore, ignore_amazon: true } });
        toast('Marked as not for the business', 'good');
        await loadData();
        renderPage();
      } catch (err) {
        b.disabled = false;
        toast(`Couldn't update: ${err.message}`, 'bad');
      }
    }
  });

  await load();
}
