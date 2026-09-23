// ECharts helpers: one visual system for every chart, read from CSS tokens so light/dark both work.
// Rules: thin lines, one value axis, recessive gridlines, no axis ticks, a dashed crosshair, card-like tooltips.
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

// Hex series colour + alpha (0..1) -> 8-digit hex, for gradients and soft fills
export const alpha = (hex, a) => `${hex}${Math.round(Math.min(1, Math.max(0, a)) * 255).toString(16).padStart(2, '0')}`;
// Vertical fade used under every line: strong at the line, transparent at the baseline
export const areaFade = (hex, top = 0.22) => new echarts.graphic.LinearGradient(0, 0, 0, 1, [
  { offset: 0, color: alpha(hex, top) }, { offset: 1, color: alpha(hex, 0) },
]);

export function tooltipBase() {
  const c = colors();
  return {
    backgroundColor: isLight() ? 'rgba(255,255,255,.96)' : 'rgba(32,32,36,.94)',
    borderColor: c.line,
    borderWidth: 1,
    padding: [10, 12],
    textStyle: { color: c.ink, fontFamily: c.font, fontSize: 12.5 },
    extraCssText: 'border-radius:12px;box-shadow:0 24px 50px -20px rgba(0,0,0,.55),0 2px 6px -2px rgba(0,0,0,.3);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);font-variant-numeric:tabular-nums;',
    confine: true,
    transitionDuration: 0.18,
  };
}

// Soft column highlight used by every bar chart's axis pointer
export const shadowPointer = () => ({ type: 'shadow', shadowStyle: { color: 'rgba(127,127,127,.08)' } });
// Dashed vertical crosshair used by every line chart
export const crosshair = () => ({ type: 'line', lineStyle: { color: colors().axis, type: [3, 3], width: 1 }, z: 0, label: { show: false } });

export function axisBase(extra = {}) {
  const c = colors();
  return {
    axisLine: { show: true, lineStyle: { color: c.grid } },
    axisTick: { show: false },
    axisLabel: { color: c.ink3, fontFamily: c.font, fontSize: 11, hideOverlap: true, margin: 10 },
    splitLine: { lineStyle: { color: c.grid, width: 1, type: [3, 4] } },
    splitNumber: 4,
    ...extra,
  };
}

export function mount(el, option) {
  if (!el) return null;
  const chart = echarts.init(el, null, { renderer: 'canvas' });
  const c = colors();
  chart.setOption({
    animation: !reducedMotion(),
    animationDuration: 650,
    animationEasing: 'cubicOut',
    animationDurationUpdate: 350,
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
  `<div style="display:flex;align-items:center;gap:8px;min-width:190px;margin-top:4px">
     <span style="width:8px;height:8px;border-radius:2px;background:${color};flex:none"></span>
     <span style="opacity:.72">${esc(label)}</span>
     <span style="margin-left:auto;font-variant-numeric:tabular-nums;${bold ? 'font-weight:650' : 'font-weight:550'}">${value}</span>
   </div>`;
export const ttHead = (t) => `<div style="font-weight:600;margin-bottom:6px;letter-spacing:-.01em">${esc(t)}</div>`;
export const ttNote = (t) => `<div style="opacity:.6;margin-top:6px;font-size:11.5px">${t}</div>`;

export function sparkline(el, values, color, { area = true } = {}) {
  return mount(el, {
    animation: !reducedMotion(),
    grid: { left: 0, right: 0, top: 4, bottom: 0 },
    xAxis: { type: 'category', show: false, boundaryGap: false, data: values.map((_, i) => i) },
    yAxis: { type: 'value', show: false, scale: true },
    series: [{
      type: 'line', data: values, smooth: 0.35, symbol: 'none',
      lineStyle: { width: 1.75, color, cap: 'round', join: 'round' },
      areaStyle: area ? { color: areaFade(color, 0.28) } : undefined,
    }],
  });
}

export const moneyAxis = (v) => moneyShort(v);
export { money };
