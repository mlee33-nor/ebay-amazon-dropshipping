// Money that rolls digit by digit when it changes (number-flow, MIT, loaded from jsDelivr). If the library can't load
// (offline, blocked CDN) the number is written as plain text, so a figure is never missing.
import { money, countUp } from './util.js';

const SRC = 'https://cdn.jsdelivr.net/npm/number-flow@0.6.2/+esm';
let loading = null;
const load = () => (loading ||= import(SRC).then(() => true).catch(() => false));

const FORMAT = { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 };

// Show `value` in `el` as rolling money. The first time it rolls up from zero; later calls roll from the last value.
export async function flowMoney(el, value) {
  if (!el) return;
  const ok = await load();
  if (!ok || !el.isConnected) { countUp(el, value, (v) => money(v, 2)); return; }
  let nf = el.querySelector('number-flow');
  if (!nf) {
    nf = document.createElement('number-flow');
    nf.locales = 'en-US';
    nf.format = FORMAT;
    el.textContent = '';
    el.appendChild(nf);
    nf.update(0);
    requestAnimationFrame(() => nf.update(value));
    return;
  }
  nf.update(value);
}

// Set a value straight away (dragging across the hero chart): rolls when number-flow is there, plain text otherwise
export function setMoney(el, value) {
  if (!el) return;
  const nf = el.querySelector('number-flow');
  if (nf) nf.update(value);
  else el.textContent = money(value, 2);
}
