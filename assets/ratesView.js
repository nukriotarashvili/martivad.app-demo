// © შპს მარტივადი — Elastic License 2.0 (იხ. LICENSE)
/* ============================================================================
   ratesView.js — კურსების ბლოკი და კალკულატორი (მთავარ გვერდზე).

   მდგომარეობა მოდულშია და არა app.js-ის render()-ში: კურსები ქსელიდან
   ასინქრონულად მოდის, ხოლო app.js-ის render() სინქრონულია და ყოველ
   კლავიშზე ეშვება — ერთმანეთში გადახლართვა კურსების თავიდან ჩამოტვირთვას
   გამოიწვევდა ყოველ აკრეფაზე.
   ========================================================================== */

import {
  SHOWN, effectiveRate, fromGel, loadRates, readOverrides,
  setOverride, shortDate, show, toGel,
} from './rates.js';
import { applyI18n, t as tr } from './i18n.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let state = {
  rates: null,          // { date, currencies, source }
  loading: true,
  calc: { amount: '100', code: 'USD', dir: 'toGel', mode: 'today', date: '', manual: '' },
};

const container = () => document.getElementById('ratesCard');

/* ------------------------------------------------------------------ view -- */

function ratesStrip() {
  const { rates } = state;
  if (state.loading) return `<p class="hint" data-i18n="კურსები იტვირთება…">კურსები იტვირთება…</p>`;
  if (!rates || !Object.keys(rates.currencies).length) {
    return `<p class="hint" data-i18n="კურსები მიუწვდომელია — შეიყვანეთ ხელით.">კურსები მიუწვდომელია — შეიყვანეთ ხელით.</p>`;
  }

  const ovr = readOverrides();
  const cells = SHOWN.map((code) => {
    const c = rates.currencies[code];
    const { block, quantity, manual } = effectiveRate(code, rates, ovr);
    // NBG-ის diff ბლოკზეა, კურსივით — ისარი მხოლოდ მიმართულებას აჩვენებს
    const dir = c && c.diff > 0 ? '▲' : c && c.diff < 0 ? '▼' : '·';
    const cls = c && c.diff > 0 ? 'up' : c && c.diff < 0 ? 'down' : '';
    // NBG quotes in blocks — show exactly what nbg.gov.ge shows, so the label
    // and the number always agree (a "100 RUB" label beside a per-unit value
    // reads as a hundredfold error).
    const label = quantity > 1 ? `${quantity} ${code}` : `1 ${code}`;
    return `<div class="rate ${manual ? 'manual' : ''}">
      <span class="c">${esc(label)}</span>
      <span class="v mono">${show(block, 4)} ₾</span>
      <span class="d ${cls}">${dir}</span>
      <input class="ovr num" inputmode="decimal" data-ovr="${code}"
             value="${manual ? block : ''}" placeholder="${show(block, 4)}"
             aria-label="${esc(code)}">
    </div>`;
  }).join('');

  const stamp = rates.source === 'cache'
    ? `<span class="pill err"><span data-i18n="ქეშირებული კურსი">ქეშირებული კურსი</span>: ${esc(shortDate(rates.date))}</span>`
    : `<span class="pill ok"><span data-i18n="კურსი">კურსი</span>: ${esc(shortDate(rates.date))}</span>`;

  return `<div class="rates">${cells}</div>
    <div class="rates-foot">${stamp}
      <button class="sm" data-act="rates-reload" data-i18n="განახლება">განახლება</button></div>`;
}

function calcBlock() {
  const { calc, rates } = state;
  const ovr = readOverrides();

  let rate = 0, rateNote = '';
  if (calc.mode === 'manual') {
    rate = Number(calc.manual) || 0;
    rateNote = tr('ხელით');
  } else if (calc.mode === 'date' && state.histRate != null) {
    rate = state.histRate;
    rateNote = shortDate(state.histDate);
  } else {
    rate = effectiveRate(calc.code, rates, ovr).unit;
    rateNote = rates ? shortDate(rates.date) : '';
  }

  const amt = Number(String(calc.amount).replace(',', '.')) || 0;
  // სრული სიზუსტით — დამრგვალება მხოლოდ ქვემოთ, show()-ში
  const result = calc.dir === 'toGel' ? toGel(amt, rate) : fromGel(amt, rate);
  const outCode = calc.dir === 'toGel' ? 'GEL' : calc.code;
  const inCode = calc.dir === 'toGel' ? calc.code : 'GEL';

  return `<div class="calc">
    <div class="row r3">
      <div><label data-i18n="თანხა">თანხა</label>
        <input class="num" inputmode="decimal" data-calc="amount" value="${esc(calc.amount)}"></div>
      <div><label data-i18n="ვალუტა">ვალუტა</label>
        <select data-calc="code">${SHOWN.map((c) =>
          `<option ${calc.code === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
      <div><label data-i18n="მიმართულება">მიმართულება</label>
        <select data-calc="dir">
          <option value="toGel" ${calc.dir === 'toGel' ? 'selected' : ''}>${esc(calc.code)} → GEL</option>
          <option value="fromGel" ${calc.dir === 'fromGel' ? 'selected' : ''}>GEL → ${esc(calc.code)}</option>
        </select></div>
    </div>
    <div class="row r3">
      <div><label data-i18n="კურსი">კურსი</label>
        <select data-calc="mode">
          <option value="today" ${calc.mode === 'today' ? 'selected' : ''} data-i18n="დღევანდელი">დღევანდელი</option>
          <option value="date" ${calc.mode === 'date' ? 'selected' : ''} data-i18n="არჩეული თარიღის">არჩეული თარიღის</option>
          <option value="manual" ${calc.mode === 'manual' ? 'selected' : ''} data-i18n="ხელით">ხელით</option>
        </select></div>
      <div><label data-i18n="თარიღი">თარიღი</label>
        <input type="date" data-calc="date" value="${esc(calc.date)}" ${calc.mode === 'date' ? '' : 'disabled'}></div>
      <div><label data-i18n="კურსი ხელით">კურსი ხელით</label>
        <input class="num" inputmode="decimal" data-calc="manual" value="${esc(calc.manual)}"
               ${calc.mode === 'manual' ? '' : 'disabled'}></div>
    </div>
    <div class="calc-out">
      <span class="mono in">${show(amt, 2)} ${esc(inCode)}</span>
      <span class="arrow">→</span>
      <span class="mono res" id="calcRes">${show(result, 2)} ${esc(outCode)}</span>
      <span class="hint">@ ${show(rate, 4)} ${rateNote ? `· ${esc(rateNote)}` : ''}</span>
      <span class="spacer"></span>
      <button class="sm" data-act="calc-copy" data-i18n="შედეგის კოპირება">შედეგის კოპირება</button>
    </div>
  </div>`;
}

export function renderRates() {
  const el = container();
  if (!el) return;
  el.innerHTML = `<div class="card">
    <h2 data-i18n="ვალუტის კურსები">ვალუტის კურსები</h2>
    <p class="note" data-i18n="ეროვნული ბანკის ოფიციალური კურსი. ხელით შეყვანილი მნიშვნელობა ჩამოტვირთულს ანაცვლებს.">ეროვნული ბანკის ოფიციალური კურსი. ხელით შეყვანილი მნიშვნელობა ჩამოტვირთულს ანაცვლებს.</p>
    ${ratesStrip()}
    <h3 class="calc-h" data-i18n="ვალუტის კონვერტაცია">ვალუტის კონვერტაცია</h3>
    ${calcBlock()}
  </div>`;
  applyI18n(el);
}

/* ---------------------------------------------------------------- events -- */

document.addEventListener('input', (ev) => {
  const t = ev.target;
  if (t.dataset.ovr !== undefined) {
    setOverride(t.dataset.ovr, t.value.trim());
    renderRates();
    const again = document.querySelector(`[data-ovr="${t.dataset.ovr}"]`);
    if (again) { again.focus(); try { again.setSelectionRange(again.value.length, again.value.length); } catch (e) {} }
    return;
  }
  if (t.dataset.calc) {
    state.calc[t.dataset.calc] = t.value;
    if (t.dataset.calc === 'date' && t.value) loadHistorical(t.value);
    else renderRates();
    const again = document.querySelector(`[data-calc="${t.dataset.calc}"]`);
    if (again && again !== document.activeElement) {
      again.focus();
      try { again.setSelectionRange(again.value.length, again.value.length); } catch (e) {}
    }
  }
});

document.addEventListener('change', (ev) => {
  const t = ev.target;
  if (t.dataset.calc) {
    state.calc[t.dataset.calc] = t.value;
    if (t.dataset.calc === 'date' && t.value) loadHistorical(t.value);
    else renderRates();
  }
});

document.addEventListener('click', async (ev) => {
  const b = ev.target.closest('[data-act]');
  if (!b) return;
  if (b.dataset.act === 'rates-reload') { await refresh(); return; }
  if (b.dataset.act === 'calc-copy') {
    const txt = document.getElementById('calcRes')?.textContent?.trim();
    if (!txt) return;
    try { await navigator.clipboard.writeText(txt); b.classList.add('copied'); setTimeout(() => b.classList.remove('copied'), 1200); }
    catch (e) { /* clipboard დაბლოკილია — ჩუმად */ }
  }
});

document.addEventListener('martivad:langchange', () => renderRates());

/* ----------------------------------------------------------------- load --- */

async function loadHistorical(date) {
  try {
    const { fetchRates } = await import('./rates.js');
    const r = await fetchRates(date);
    const c = r.currencies[state.calc.code];
    state.histRate = c ? c.unit : null;
    state.histDate = r.date;
  } catch (e) {
    state.histRate = null;
    state.histDate = null;
  }
  renderRates();
}

async function refresh() {
  state.loading = true; renderRates();
  state.rates = await loadRates();
  state.loading = false;
  renderRates();
}

export async function initRates() {
  if (!container()) return;
  if (state.rates) { renderRates(); return; }   // უკვე ჩამოტვირთულია
  renderRates();
  await refresh();
}

window.martivadRates = { state, refresh, renderRates };
