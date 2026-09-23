// ECharts helpers: one visual system for every chart, read from CSS tokens so light/dark both work.
import { cssVar, moneyShort, money, esc, reducedMotion } from './util.js';

const instances = new Set();

export function colors() {
  return {
    revenue: cssVar('--s-revenue'),
    cost: cssVar('--s-cost'),
    profit: cssVar('--s-profit'),
    fees: cssVar('--s-fees'),
    refunds: cssVar('--s-refunds'),
    ads: cssVar('--s-ads'),
    ops: cssVar('--s-ops'),
    good: cssVar('--good'),
    bad: cssVar('--bad'),
    goodInk: cssVar('--good-ink'),
    badInk: cssVar('--bad-ink'),
    warn: cssVar('--warn'),
    serious: cssVar('--serious'),
    accent: cssVar('--accent'),
    ink: cssVar('--ink'),
    ink2: cssVar('--ink-2'),
    ink3: cssVar('--ink-3'),
    ink4: cssVar('--ink-4'),
    grid: cssVar('--grid'),
    axis: cssVar('--axis'),
    surface: cssVar('--surface'),
    surface2: cssVar('--surface-2'),
    surface3: cssVar('--surface-3'),
    line: cssVar('--line-strong'),
    font: cssVar('--font'),
  };
}

export const isLight = () => document.documentElement.dataset.theme === 'light';

export function tooltipBase() {
  const c = colors();
  return {
    backgroundColor: isLight() ? '#ffffff' : c.surface3,
    borderColor: c.line,
    borderWidth: 1,
    padding: [10, 12],
    textStyle: { color: c.ink, fontFamily: c.font, fontSize: 12.5 },
    extraCssText: 'border-radius:12px;box-shadow:0 24px 50px -20px rgba(0,0,0,.55);backdrop-filter:blur(8px);',
    confine: true,
    transitionDuration: 0.25,
  };
}

// Soft column highlight used by every bar chart's axis pointer
export const shadowPointer = () => ({ type: 'shadow', shadowStyle: { color: 'rgba(127,127,127,.09)' } });

export function axisBase(extra = {}) {
  const c = colors();
  return {
    axisLine: { lineStyle: { color: c.axis } },
    axisTick: { show: false },
    axisLabel: { color: c.ink3, fontFamily: c.font, fontSize: 11, hideOverlap: true, margin: 10 },
    splitLine: { lineStyle: { color: c.grid, width: 1 } },
    ...extra,
  };
}

export function mount(el, option) {
  if (!el) return null;
  const chart = echarts.init(el, null, { renderer: 'canvas' });
  const c = colors();
  chart.setOption({
    animation: !reducedMotion(),
    animationDuration: 700,
    animationEasing: 'cubicOut',
    animationDurationUpdate: 400,
    textStyle: { fontFamily: c.font },
    ...option,
  });
  instances.add(chart);
  return chart;
}

export function disposeAll() {
  for (const c of instances) c.dispose();
  instances.clear();
}

let resizeT;
window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { for (const c of instances) c.resize(); }, 60); });

// Tooltip row helper: colored key + label + value, text stays in ink colors
export const ttRow = (color, label, value, bold = false) =>
  `<div style="display:flex;align-items:center;gap:8px;min-width:180px;margin-top:4px">
     <span style="width:8px;height:8px;border-radius:2px;background:${color};flex:none"></span>
     <span style="opacity:.75">${esc(label)}</span>
     <span style="margin-left:auto;font-variant-numeric:tabular-nums;${bold ? 'font-weight:700' : 'font-weight:600'}">${value}</span>
   </div>`;
export const ttHead = (t) => `<div style="font-weight:650;margin-bottom:6px;letter-spacing:-.01em">${esc(t)}</div>`;
export const ttNote = (t) => `<div style="opacity:.6;margin-top:6px;font-size:11.5px">${t}</div>`;

export function sparkline(el, values, color, { area = true } = {}) {
  return mount(el, {
    animation: !reducedMotion(),
    grid: { left: 0, right: 0, top: 4, bottom: 0 },
    xAxis: { type: 'category', show: false, boundaryGap: false, data: values.map((_, i) => i) },
    yAxis: { type: 'value', show: false, scale: true },
    series: [{
      type: 'line', data: values, smooth: 0.35, symbol: 'none',
      lineStyle: { width: 2, color, cap: 'round' },
      areaStyle: area ? { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
        { offset: 0, color: `${color}4d` }, { offset: 1, color: `${color}00` },
      ]) } : undefined,
    }],
  });
}

export const moneyAxis = (v) => moneyShort(v);
export { money };
