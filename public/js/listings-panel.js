// Products → Listings: how the eBay store itself is doing. Listings posted per month, active listings over
// time, views and watchers, the listings that pull traffic, and the ones worth refreshing or ending.
import { esc, money, count, fmtDate, ago, api, toast, ICONS, monthLabel } from './util.js';
import { mount, colors, tooltipBase, axisBase, ttRow, ttHead, crosshair, areaFade } from './charts.js';

const n1 = (x, d = 1) => (x === null || x === undefined ? '—' : Number(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const trunc = (s, n) => (String(s || '').length > n ? `${String(s).slice(0, n - 1).trim()}…` : String(s || ''));
const link = (l) => (l.url ? `<a href="${esc(l.url)}" target="_blank" rel="noopener" class="lk">${esc(trunc(l.title, 72))}</a>` : esc(trunc(l.title, 72)));

function kpi(label, value, foot, tip = '') {
  return `<div class="card kpi" ${tip ? `title="${esc(tip)}"` : ''}><div class="kpi-top">${esc(label)}</div><div class="kpi-val num">${value}</div><div class="kpi-foot"><span>${foot}</span></div></div>`;
}

async function refresh(btn, box) {
  btn.disabled = true;
  btn.innerHTML = `${ICONS.refresh} Refreshing…`;
  try {
    const r = await api('/api/listings/sync', { method: 'POST' });
    toast(r.ok ? r.log.join(' · ') : `Listings: ${r.log.at(-1) || 'failed'}`, r.ok ? 'good' : 'bad');
  } catch (e) { toast(e.message, 'bad'); }
  renderListingsPanel(box);
}

export async function renderListingsPanel(box) {
  box.innerHTML = `<div class="kpis five">${'<div class="sk-card"><div class="sk w40"></div><div class="sk w60" style="height:22px"></div></div>'.repeat(5)}</div>`;
  let L;
  try { L = await api('/api/listings'); } catch (e) { box.innerHTML = `<div class="card"><div class="empty"><div class="t">Couldn’t load listings</div><p>${esc(e.message)}</p></div></div>`; return; }
  if (!box.isConnected) return;
  const T = L.totals;
  const sync = L.lastSync;
  const head = `<div class="row listings-head">
      <span class="muted" style="font-size:12.5px">${sync ? `Listings checked ${ago(sync.at)}${sync.ok ? '' : ' · <span class="neg">last check failed</span>'}` : 'Listings haven’t been checked yet'} · refreshed automatically every few hours</span>
      <button class="btn sm" id="ls-refresh" style="margin-left:auto">${ICONS.refresh} Refresh listings</button>
    </div>`;
  const needsTraffic = !L.traffic.available;
  const trafficNote = needsTraffic ? `<div class="banner info" style="margin-bottom:14px">${ICONS.info}<div class="b-text"><b>Views, impressions and conversion need one more eBay permission.</b> Go to Settings → <b>Connect eBay</b> and approve once. Nothing else changes; the next refresh fills in the traffic numbers.</div><a class="btn sm" href="#/settings">Open Settings</a></div>` : '';

  if (!T.activeListings) {
    box.innerHTML = `${head}<div class="card"><div class="empty lg"><div class="ic">${ICONS.package}</div><div class="t">No listing data yet</div><p>Once eBay is connected, every active listing is read here (read-only): how many you have, how many you post each month, views, watchers, and which ones to refresh or remove.${sync && !sync.ok ? `<br><span class="neg">Last check: ${esc(sync.log?.at(-1) || 'failed')}</span>` : ''}</p><div class="actions"><button class="btn primary" id="ls-refresh2">${ICONS.refresh} Check listings now</button><a class="btn" href="#/settings">${ICONS.settings} eBay connection</a></div></div></div>`;
    box.querySelector('#ls-refresh').onclick = (e) => refresh(e.currentTarget, box);
    box.querySelector('#ls-refresh2').onclick = (e) => refresh(e.currentTarget, box);
    return;
  }

  const D = L.drivers;
  const st = L.sellThrough;
  const watchedUnsold = (L.top.byWatchers || []).filter((l) => !l.quantitySold && l.watchers > 0);
  box.innerHTML = `${head}${trafficNote}
    <div class="kpis five">
      ${kpi('Active listings', count(T.activeListings), `<b class="${L.added.last30 >= L.added.endedLast30 ? 'pos' : 'neg'}">+${count(L.added.last30)}</b> posted · ${count(L.added.endedLast30)} ended (30 days)`)}
      ${kpi('Views per listing', T.avgViewsPerListing === null ? '—' : n1(T.avgViewsPerListing), T.viewsSource === 'analytics_30d' ? 'last 30 days' : T.viewsSource === 'hit_count' ? 'lifetime views' : 'needs eBay permission')}
      ${kpi('Watchers per listing', n1(T.avgWatchersPerListing, 2), `${count(T.totalWatchers)} watchers in total`)}
      ${kpi('Listings that have sold', st.pctListingsWithSale === null ? '—' : `${n1(st.pctListingsWithSale)}%`, `${count(st.listingsWithSale)} of ${count(st.activeListings)} active listings`, 'Share of active listings with at least one sale')}
      ${kpi('To refresh or remove', `<span class="${L.stale.count ? 'neg' : ''}">${count(L.stale.count)}</span>`, 'live 30+ days, no sales', 'Live 30+ days, nothing sold, and fewer views than the typical listing')}
    </div>

    <div class="card mt insight-card" id="ls-insight"><div class="card-h"><div><h3>${ICONS.spark} What’s happening</h3><div class="sub">Last 30 days vs the 30 before</div></div></div><div class="card-b" id="ls-insight-b"><div class="sk-rows"><div class="sk"></div><div class="sk"></div></div></div></div>

    <div class="grid g-12 mt">
      <div class="card c-7"><div class="card-h"><div><h3>Active listings over time</h3><div class="sub">${esc(L.listedHistory.approximate ? 'Days before tracking started are estimated from listing start dates' : '')}</div></div></div><div class="card-b"><div class="chart" id="ch-ls-active"></div></div></div>
      <div class="card c-5"><div class="card-h"><div><h3>Listings posted per month</h3><div class="sub">New listings vs listings that ended</div></div></div><div class="card-b"><div class="chart" id="ch-ls-month"></div></div></div>
    </div>
    ${L.traffic.available ? `<div class="card mt"><div class="card-h"><div><h3>Views per day</h3><div class="sub">eBay listing views · hover for impressions and orders per 100 views</div></div></div><div class="card-b"><div class="chart" id="ch-ls-views"></div></div></div>` : ''}

    <div class="grid g-12 mt">
      <div class="card c-7"><div class="card-h"><div><h3>Most viewed listings</h3><div class="sub">${T.viewsSource === 'analytics_30d' ? 'Last 30 days' : T.viewsSource === 'hit_count' ? 'Lifetime views' : 'Needs the eBay analytics permission'}</div></div></div>
        <div class="card-b table-wrap">${L.top.byViews.length ? `<table class="simple"><thead><tr><th>Listing</th><th class="r">Views</th><th class="r">Watchers</th><th class="r">Sold</th><th class="r">Price</th><th></th></tr></thead><tbody>${L.top.byViews.map((l) => `<tr><td>${link(l)}<div class="muted" style="font-size:11px">${count(l.daysLive)} days live</div></td><td class="r">${count(l.views)}</td><td class="r">${count(l.watchers)}</td><td class="r">${count(l.quantitySold)}</td><td class="r">${l.price === null ? '—' : money(l.price, 2)}</td><td class="r">${!l.quantitySold && l.views >= 20 ? `<span class="pill warn" title="Lots of views, no sale yet: usually price or shipping time">${ICONS.info} views, no sale</span>` : l.quantitySold ? `<span class="pill good">${ICONS.check} selling</span>` : ''}</td></tr>`).join('')}</tbody></table>` : `<div class="empty"><p>Views appear after the eBay analytics permission is approved.</p></div>`}</div></div>
      <div class="card c-5"><div class="card-h"><div><h3>Watched but not sold</h3><div class="sub">Buyers are interested: send them an offer from eBay (Seller Hub → Send offers)</div></div></div>
        <div class="card-b table-wrap">${watchedUnsold.length ? `<table class="simple"><thead><tr><th>Listing</th><th class="r">Watchers</th><th class="r">Price</th></tr></thead><tbody>${watchedUnsold.map((l) => `<tr><td>${link(l)}</td><td class="r"><b>${count(l.watchers)}</b></td><td class="r">${l.price === null ? '—' : money(l.price, 2)}</td></tr>`).join('')}</tbody></table>` : `<div class="empty"><p>No unsold listings with watchers right now.</p></div>`}</div></div>
    </div>

    <div class="card mt"><div class="card-h"><div><h3>Listings to refresh or remove</h3><div class="sub">Live 30+ days with no sales${L.stale.criteria.viewsBelowMedian !== null ? ` and fewer than ${n1(L.stale.criteria.viewsBelowMedian, 0)} views (the typical listing)` : ''}. Refresh the title, photos or price, or end them to keep the store focused.</div></div><div class="right"><span class="pill">${count(L.stale.count)} listing${L.stale.count === 1 ? '' : 's'}</span></div></div>
      <div class="card-b table-wrap">${L.stale.listings.length ? `<table class="simple"><thead><tr><th>Listing</th><th class="r">Days live</th><th class="r">Views</th><th class="r">Watchers</th><th class="r">Price</th><th>Suggestion</th></tr></thead><tbody>${L.stale.listings.slice(0, 50).map((l) => `<tr><td>${link(l)}</td><td class="r">${count(l.daysLive)}</td><td class="r">${l.views === null ? '—' : count(l.views)}</td><td class="r">${count(l.watchers)}</td><td class="r">${l.price === null ? '—' : money(l.price, 2)}</td><td class="muted" style="font-size:12.5px">${l.watchers > 0 ? 'Watchers but no sale: lower the price or send an offer' : l.views === 0 ? 'Nobody is seeing it: rewrite the title or end it' : l.daysLive >= 90 ? 'Three months with no sale: end it or relist fresh' : 'Few views: improve the title and main photo'}</td></tr>`).join('')}</tbody></table>${L.stale.count > 50 ? `<div class="muted" style="font-size:12px;padding:10px 14px">Showing the 50 oldest of ${count(L.stale.count)}.</div>` : ''}` : `<div class="empty"><div class="ic">${ICONS.circleCheck}</div><p>No stale listings. Everything live for a month has sold or is getting views.</p></div>`}</div></div>`;

  box.querySelector('#ls-refresh').onclick = (e) => refresh(e.currentTarget, box);
  const c = colors();

  // Active listings over time
  const pts = L.listedHistory.points;
  mount(box.querySelector('#ch-ls-active'), {
    grid: { left: 8, right: 12, top: 16, bottom: 4, containLabel: true },
    tooltip: { ...tooltipBase(), trigger: 'axis', axisPointer: crosshair(), formatter: (ps) => { const p = pts[ps[0].dataIndex]; return ttHead(fmtDate(`${p.day}T12:00`, { month: 'short', day: 'numeric', year: 'numeric' })) + ttRow(c.accent, 'Active listings', count(p.active), true) + (p.source === 'estimate' ? '<div style="opacity:.6;margin-top:3px">estimated from listing start dates</div>' : ''); } },
    xAxis: { type: 'category', boundaryGap: false, data: pts.map((p) => fmtDate(`${p.day}T12:00`, { month: 'short', day: 'numeric' })), ...axisBase({ splitLine: { show: false } }) },
    yAxis: { type: 'value', ...axisBase(), axisLine: { show: false }, minInterval: 1 },
    series: [{ type: 'line', data: pts.map((p) => p.active), smooth: 0.2, symbol: 'none', lineStyle: { width: 2, color: c.accent }, areaStyle: { color: areaFade(c.accent, 0.2) } }],
  });

  // Posted vs ended per month
  const bm = L.byMonth || [];
  mount(box.querySelector('#ch-ls-month'), {
    grid: { left: 8, right: 12, top: 24, bottom: 4, containLabel: true },
    legend: { top: 0, right: 0, textStyle: { color: c.ink3, fontSize: 11 }, itemWidth: 10, itemHeight: 10, data: ['Posted', 'Ended'] },
    tooltip: { ...tooltipBase(), trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: (ps) => { const x = bm[ps[0].dataIndex]; return ttHead(monthLabel(x.month, 'long')) + ttRow(c.profit, 'Posted', count(x.added)) + ttRow(c.ink4, 'Ended', count(x.ended)) + ttRow(c.accent, 'Net change', `${x.added - x.ended >= 0 ? '+' : ''}${count(x.added - x.ended)}`, true); } },
    xAxis: { type: 'category', data: bm.map((x) => monthLabel(x.month)), ...axisBase({ splitLine: { show: false } }) },
    yAxis: { type: 'value', ...axisBase(), axisLine: { show: false }, minInterval: 1 },
    series: [
      { name: 'Posted', type: 'bar', data: bm.map((x) => x.added), barMaxWidth: 22, itemStyle: { color: c.profit, borderRadius: [4, 4, 0, 0] }, label: { show: true, position: 'top', color: c.ink2, fontSize: 11 } },
      { name: 'Ended', type: 'bar', data: bm.map((x) => x.ended), barMaxWidth: 22, itemStyle: { color: c.ink4, borderRadius: [4, 4, 0, 0] } },
    ],
  });

  // Views per day
  if (L.traffic.available) {
    const days = L.traffic.days;
    mount(box.querySelector('#ch-ls-views'), {
      grid: { left: 8, right: 12, top: 16, bottom: 4, containLabel: true },
      tooltip: { ...tooltipBase(), trigger: 'axis', axisPointer: crosshair(), formatter: (ps) => { const x = days[ps[0].dataIndex]; return ttHead(fmtDate(`${x.day}T12:00`, { weekday: 'short', month: 'short', day: 'numeric' })) + ttRow(c.accent, 'Views', count(x.views ?? 0), true) + ttRow(c.ink3, 'Times shown in search', count(x.impressions ?? 0)) + ttRow(c.profit, 'Orders per 100 views', x.views ? n1(((x.transactions || 0) / x.views) * 100, 2) : '—'); } },
      xAxis: { type: 'category', boundaryGap: false, data: days.map((x) => fmtDate(`${x.day}T12:00`, { month: 'short', day: 'numeric' })), ...axisBase({ splitLine: { show: false } }) },
      yAxis: { type: 'value', ...axisBase(), axisLine: { show: false }, minInterval: 1 },
      series: [{ type: 'line', data: days.map((x) => x.views ?? 0), smooth: 0.25, symbol: 'none', lineStyle: { width: 1.75, color: c.accent }, areaStyle: { color: areaFade(c.accent, 0.18) } }],
    });
  }

  // "What's happening": the same explanation the Ask AI chat gives, so the page and the chat always agree
  try {
    const a = await api('/api/ask', { method: 'POST', body: { question: 'why do we have more listings but fewer sales', route: { topic: 'listings_vs_sales', period: '', compare_to: '', product: '' } } });
    const b = box.querySelector('#ls-insight-b');
    if (b) b.innerHTML = `<div class="insight-lead">${esc(a.text).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')}</div>${a.bullets?.length ? `<ul class="insight-list">${a.bullets.map((x) => `<li>${esc(x).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')}</li>`).join('')}</ul>` : ''}<a class="btn sm ghost" href="#/ask" style="margin-top:6px">${ICONS.spark} Ask a follow-up question</a>`;
  } catch {
    box.querySelector('#ls-insight')?.remove();
  }
  void D;
}
