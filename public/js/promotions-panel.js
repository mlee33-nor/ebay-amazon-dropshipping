// Products → Promotional: how much of the store is on eBay Promoted Listings, at what ad rate and cost, and whether
// promoted listings actually get seen and bought more than the rest.
import { esc, money, count, ago, api, toast, ICONS, monthLabel, fmtDate } from './util.js';
import { promoMonths } from './promo-months.js';
import { state } from './app.js';

const n = (x, d = 0) => (x === null || x === undefined ? '—' : Number(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const pctTxt = (x, d = 1) => (x === null || x === undefined ? '—' : `${n(x, d)}%`);

function kpi(label, value, foot, tip = '') {
  return `<div class="card kpi" ${tip ? `title="${esc(tip)}"` : ''}><div class="kpi-top">${esc(label)}</div><div class="kpi-val num">${value}</div><div class="kpi-foot"><span>${foot}</span></div></div>`;
}

// One comparison row: which group does better on this measure, and by how much
function compareRow(label, a, b, fmt, help) {
  const better = a !== null && b !== null && a !== b ? (a > b ? 'a' : 'b') : null;
  const times = a && b && a !== b ? (Math.max(a, b) / Math.min(a, b)) : null;
  return `<tr><td>${esc(label)}${help ? `<div class="muted" style="font-size:11px">${esc(help)}</div>` : ''}</td>
    <td class="r num ${better === 'a' ? 'pos' : ''}">${fmt(a)}</td><td class="r num ${better === 'b' ? 'pos' : ''}">${fmt(b)}</td>
    <td class="r muted" style="font-size:12px">${times && times >= 1.1 ? `${n(times, 1)}× ${better === 'a' ? 'promoted' : 'not promoted'}` : better ? 'about the same' : ''}</td></tr>`;
}

// Promoted sales by month: a sale counts as promoted when eBay charged an ad fee on it
function monthsCard() {
  const months = promoMonths(state.data?.orders || []).reverse();
  if (!months.length) return '';
  const cur = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  const verdict = (m) => {
    if (!m.adSales) return '<span class="muted">No promoted sales</span>';
    if (m.breakEven === null) return `<span class="pill bad">${ICONS.alert} Lost money</span>`;
    const txt = `${m.breakEven} of ${m.adSales} ${m.adSales === 1 ? 'buyer' : 'buyers'} came because of the ad`;
    const cls = m.breakEven <= 1 ? 'good' : m.breakEven <= m.adSales / 2 ? 'info' : 'warn';
    const lbl = m.breakEven <= 1 ? 'Very likely paid off' : m.breakEven <= m.adSales / 2 ? 'Likely paid off' : 'Uncertain';
    return `<span class="pill ${cls}" title="Pays off if at least ${txt}">${cls === 'good' ? ICONS.check : ICONS.info} ${lbl}</span><div class="muted" style="font-size:11px;margin-top:3px">pays off if ${txt}</div>`;
  };
  const detail = (m) => `<tr class="promo-detail" data-for="${m.month}" hidden><td colspan="7"><div class="promo-detail-in">
      ${m.adSales ? `<table class="simple"><thead><tr><th>Date</th><th>Item</th><th class="r">Payout</th><th class="r">Amazon</th><th class="r">Ad fee</th><th class="r">Profit</th></tr></thead><tbody>
        ${m.list.map((x) => `<tr><td style="white-space:nowrap">${x.approxDate ? monthLabel(m.month) : fmtDate(x.date)}</td><td>${esc(String(x.title).slice(0, 70))}</td><td class="r">${money(x.payout, 2)}</td><td class="r">${money(x.cost, 2)}</td><td class="r">${money(x.adFee, 2)}</td><td class="r ${x.net < 0 ? 'neg' : ''}">${money(x.net, 2)}</td></tr>`).join('')}
      </tbody></table>
      <div class="muted" style="font-size:12px;margin-top:8px">Other sales that month: ${count(m.otherSales)}, ${money(m.otherProfit, 2)} profit (${m.otherProfitPerSale === null ? '—' : money(m.otherProfitPerSale, 2)} each) vs ${m.adProfitPerSale === null ? '—' : money(m.adProfitPerSale, 2)} each on the promoted ones.</div>` : '<div class="muted">No sale this month came through a promoted ad.</div>'}
    </div></td></tr>`;
  return `<div class="card mt"><div class="card-h"><div><h3>Promoted sales by month</h3><div class="sub">A sale counts as promoted when eBay charged an ad fee on it, meaning the buyer clicked a promoted ad. The open question is how many of them would have bought anyway, so the effect is a range. Click a month for its sales.</div></div></div>
    <div class="card-b table-wrap"><table class="simple promo-months"><thead><tr><th>Month</th><th class="r">Sales</th><th class="r">Via promoted ads</th><th class="r">Ad fees</th><th class="r">Profit on them</th><th>Did it pay off?</th><th class="r">Effect of promoting</th></tr></thead><tbody>
      ${months.map((m) => `<tr class="promo-row" data-month="${m.month}" tabindex="0" role="button" aria-expanded="false"><td style="white-space:nowrap"><span class="chev">${ICONS.chevronDown}</span><b>${monthLabel(m.month, 'long')}</b>${m.month === cur ? ' <span class="muted">so far</span>' : ''}</td>
        <td class="r">${count(m.sales)}</td>
        <td class="r">${count(m.adSales)}${m.share !== null ? ` <span class="muted">(${Math.round(m.share * 100)}%)</span>` : ''}</td>
        <td class="r">${money(m.adFees, 2)}</td>
        <td class="r">${m.adSales ? money(m.adProfit, 2) : '—'}</td>
        <td>${verdict(m)}</td>
        <td class="r" style="white-space:nowrap">${m.adSales ? `${money(m.worst, 2)} to +${money(m.best, 2)}` : money(0, 2)}</td></tr>${detail(m)}`).join('')}
    </tbody></table></div></div>`;
}
function bindMonths(box) {
  box.querySelectorAll('.promo-row').forEach((tr) => {
    const toggle = () => {
      const d = box.querySelector(`.promo-detail[data-for="${tr.dataset.month}"]`);
      d.hidden = !d.hidden;
      tr.setAttribute('aria-expanded', String(!d.hidden));
      tr.classList.toggle('open', !d.hidden);
    };
    tr.addEventListener('click', toggle);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  });
}

async function refresh(btn, box) {
  btn.disabled = true;
  btn.innerHTML = `${ICONS.refresh} Refreshing… (about a minute)`;
  try {
    const r = await api('/api/listings/sync', { method: 'POST' });
    const line = r.log.find((l) => l.startsWith('promotions')) || r.log.at(-1);
    toast(line || 'Refreshed', /skipped|couldn/.test(line || '') ? 'bad' : 'good');
  } catch (e) { toast(e.message, 'bad'); }
  renderPromotionsPanel(box);
}

export async function renderPromotionsPanel(box) {
  box.innerHTML = `<div class="kpis five">${'<div class="sk-card"><div class="sk w40"></div><div class="sk w60" style="height:22px"></div></div>'.repeat(5)}</div>`;
  let P;
  try { P = await api('/api/promotions'); } catch (e) { box.innerHTML = `<div class="card"><div class="empty"><div class="t">Couldn’t load promotions</div><p>${esc(e.message)}</p></div></div>`; return; }
  if (!box.isConnected) return;
  const sync = P.lastSync;
  const head = `<div class="row listings-head">
      <span class="muted" style="font-size:12.5px">${sync ? `Promotions checked ${ago(sync.at)}${sync.status === 'partial' ? ' · <span class="neg">some campaigns couldn’t be read</span>' : ''}` : 'Promotions haven’t been checked yet'} · refreshed with the listings every few hours</span>
      <button class="btn sm" id="pr-refresh" style="margin-left:auto">${ICONS.refresh} Refresh now</button>
    </div>`;

  // No permission yet (or never read): say exactly what to do, don't show made-up zeros
  if (!P.available) {
    const why = sync?.log?.at(-1) || '';
    box.innerHTML = `${head}<div class="card"><div class="empty lg"><div class="ic">${ICONS.target}</div><div class="t">Connect Promoted Listings</div>
      <p>To see which of your ${count(P.activeListings)} listings are promoted, eBay needs one more read-only permission. Go to <b>Settings → Reconnect eBay</b> and approve, then press <b>Refresh now</b> here.${why && /skipped/.test(why) ? `<br><span class="muted" style="font-size:12px">${esc(why)}</span>` : ''}</p>
      <div class="actions"><a class="btn primary" href="#/settings">${ICONS.settings} Open Settings</a></div></div></div>${monthsCard()}`;
    box.querySelector('#pr-refresh').onclick = (e) => refresh(e.currentTarget, box);
    bindMonths(box);
    return;
  }

  const pf = P.performance;
  const promotedShare = P.activeListings ? (P.promoted / P.activeListings) * 100 : 0;
  const campaignsLive = P.campaigns.filter((c) => c.status === 'RUNNING');
  box.innerHTML = `${head}
    <div class="kpis five">
      ${kpi('Promoted', `${count(P.promoted)}`, `${pctTxt(P.pctPromoted)} of ${count(P.activeListings)} active listings`)}
      ${kpi('Not promoted', `<span class="${P.notPromoted ? 'neg' : ''}">${count(P.notPromoted)}</span>`, `${pctTxt(P.pctNotPromoted)} of active listings${P.paused ? ` · ${count(P.paused)} in paused campaigns` : ''}`)}
      ${kpi('Average ad rate', P.rate ? `${n(P.rate.avg, 1)}%` : '—', P.rate ? `from ${n(P.rate.min, 1)}% to ${n(P.rate.max, 1)}%` : 'no running promotions')}
      ${kpi('Ad fees, last 30 days', money(P.adFees.last30, 2), P.adFees.pctOfSales !== null ? `${pctTxt(P.adFees.pctOfSales, 1)} of ${money(P.adFees.salesLast30, 0)} sales` : 'no sales in the last 30 days', 'Promoted Listings fees eBay charged, minus credits')}
      ${kpi('New listings not promoted', `<span class="${P.newListings.notPromoted ? 'neg' : ''}">${count(P.newListings.notPromoted)}</span>`, `of ${count(P.newListings.last30)} posted in the last 30 days${P.newListings.pctNotPromoted !== null ? ` (${pctTxt(P.newListings.pctNotPromoted, 0)})` : ''}`)}
    </div>

    <div class="card mt promo-meter-card">
      <div class="card-h"><div><h3>${ICONS.target} Share of listings promoted</h3><div class="sub">Active listings with an active ad in a running campaign</div></div>
        <div class="right"><a class="btn sm" href="/api/promotions/not-promoted.csv">${ICONS.down} Not-promoted listings (CSV)</a></div></div>
      <div class="card-b">
        <div class="promo-meter" role="img" aria-label="${n(promotedShare, 1)}% promoted"><div class="seg-a" style="width:${promotedShare.toFixed(2)}%"></div><div class="seg-b" style="width:${(100 - promotedShare).toFixed(2)}%"></div></div>
        <div class="promo-legend"><span><i class="sw a"></i>Promoted <b>${count(P.promoted)}</b> (${pctTxt(P.pctPromoted)})</span><span><i class="sw b"></i>Not promoted <b>${count(P.notPromoted)}</b> (${pctTxt(P.pctNotPromoted)})</span></div>
        <div class="muted" style="font-size:12px;margin-top:10px">The CSV lists every active listing that isn't promoted, newest first, with its views. Use it to add listings to a campaign in Seller Hub (Marketing → Promoted Listings).</div>
      </div>
    </div>

    <div class="grid g-12 mt">
      <div class="card c-7"><div class="card-h"><div><h3>Do promoted listings do better?</h3><div class="sub">Per listing, last 30 days${pf.trafficAvailable ? '' : ' · views need the eBay analytics permission'}</div></div></div>
        <div class="card-b table-wrap"><table class="simple"><thead><tr><th></th><th class="r">Promoted</th><th class="r">Not promoted</th><th class="r">Difference</th></tr></thead><tbody>
          ${compareRow('Listings', pf.promoted.listings, pf.notPromoted.listings, (v) => count(v))}
          ${compareRow('Times shown in search', pf.promoted.shownPerListing, pf.notPromoted.shownPerListing, (v) => n(v, 0), 'per listing')}
          ${compareRow('Views', pf.promoted.viewsPerListing, pf.notPromoted.viewsPerListing, (v) => n(v, 2), 'per listing')}
          ${compareRow('Listings with any views', pf.promoted.pctWithViews, pf.notPromoted.pctWithViews, (v) => pctTxt(v, 0))}
          ${compareRow('Orders', pf.promoted.ordersPer1000, pf.notPromoted.ordersPer1000, (v) => n(v, 1), 'per 1,000 listings')}
        </tbody></table>
        <div class="muted" style="font-size:12px;padding:10px 14px">Promoted listings are often chosen because they already sell, so a gap here is a hint, not proof that promoting causes it.</div></div></div>
      <div class="card c-5"><div class="card-h"><div><h3>Campaigns</h3><div class="sub">${count(campaignsLive.length)} running of ${count(P.campaigns.length)}</div></div></div>
        <div class="card-b table-wrap">${P.campaigns.length ? `<table class="simple"><thead><tr><th>Campaign</th><th>Status</th><th class="r">Listings</th><th class="r">Ad rate</th></tr></thead><tbody>
          ${P.campaigns.map((c) => `<tr><td>${esc(c.name || c.id)}<div class="muted" style="font-size:11px">${esc(c.type)}${c.rulesBased ? ' · rule-based' : ''}</div></td><td>${c.status === 'RUNNING' ? `<span class="pill good">${ICONS.check} Running</span>` : c.status === 'PAUSED' ? `<span class="pill warn">${ICONS.clock} Paused</span>` : `<span class="pill">${esc((c.status || '').toLowerCase())}</span>`}</td><td class="r">${count(c.liveAds)}</td><td class="r">${c.rate === null ? '—' : `${n(c.rate, 1)}%`}</td></tr>`).join('')}
        </tbody></table>` : `<div class="empty"><p>No Promoted Listings campaigns on this account yet.</p></div>`}</div></div>
    </div>
    ${monthsCard()}`;

  box.querySelector('#pr-refresh').onclick = (e) => refresh(e.currentTarget, box);
  bindMonths(box);
}
