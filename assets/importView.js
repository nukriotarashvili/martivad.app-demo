// © შპს მარტივადი — Elastic License 2.0 (იხ. LICENSE)
/* ============================================================================
   importView.js — იმპორტის ოპერაციების პანელი.

   მდგომარეობა მოდულშია (როგორც კურსების ბლოკში): პანელი ცოცხლად ითვლის
   ყოველ აკრეფაზე და მისი შენახვა app.js-ის draft-ში ჟურნალის ფორმას
   აურევდა.

   დღგ-ს სტატუსი პროფილიდან იკითხება და აქ არ იცვლება — ის ორგანიზაციის
   თვისებაა, არა ამ დოკუმენტის.
   ========================================================================== */

import { calcImport, buildImportEntry, IMPORT_ACCOUNTS, round2 } from './importCalc.js';
import { store, addEntry } from './store.js';
import { applyI18n, t as tr } from './i18n.js';
import { effectiveRate, fetchRates, show } from './rates.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const num = (v) => Number(String(v ?? '').replace(',', '.')) || 0;

export const impState = {
  date: new Date().toISOString().slice(0, 10),
  doc: '',
  supplier: '',
  carrier: '',
  currency: 'USD',
  rate: '',
  rateMode: 'date',              // 'date' | 'manual'
  lines: [{ name: '', qty: '', price: '' }],
  transport: '', transportCur: 'USD', transportRate: '',
  transportInCustoms: false,
  dutyMode: 'percent', dutyValue: '12',
  otherCosts: '',
  allocation: 'value',
  msg: null,
};

function result() {
  const org = store.active();
  return calcImport({
    lines: impState.lines.map((l) => ({ name: l.name, qty: num(l.qty), price: num(l.price) })),
    rate: num(impState.rate),
    transport: num(impState.transport),
    transportRate: impState.transportCur === 'GEL' ? 1 : num(impState.transportRate),
    transportInCustoms: impState.transportInCustoms,
    dutyMode: impState.dutyMode,
    dutyValue: num(impState.dutyValue),
    otherCosts: num(impState.otherCosts),
    vatRate: org ? (Number(org.settings.vatRate) || 18) : 18,
    vatPayer: org ? !!org.settings.vatPayer : false,
    allocation: impState.allocation,
  });
}

/* ------------------------------------------------------------------ view -- */

export function vImport(org) {
  const r = result();
  const vatPayer = !!org.settings.vatPayer;
  const A = IMPORT_ACCOUNTS;

  const lineRows = impState.lines.map((l, i) => {
    const c = r.lines[i] || {};
    return `<tr>
      <td class="mono">${i + 1}</td>
      <td><input data-imp-line="${i}" data-f="name" value="${esc(l.name)}"></td>
      <td><input class="num" inputmode="decimal" data-imp-line="${i}" data-f="qty" value="${esc(l.qty)}"></td>
      <td><input class="num" inputmode="decimal" data-imp-line="${i}" data-f="price" value="${esc(l.price)}"></td>
      <td class="num mono">${show(c.valueGelR || 0)}</td>
      <td class="num mono">${show(c.allocatedR || 0)}</td>
      <td class="num mono"><b>${show(c.totalCost || 0)}</b></td>
      <td class="num mono">${show(c.unitCost || 0, 4)}</td>
      <td><button class="ghost sm" data-act="imp-del" data-i="${i}">✕</button></td>
    </tr>`;
  }).join('');

  const kv = (labelKey, value, cls = '') =>
    `<div class="cell ${cls}"><span class="k" data-i18n="${esc(labelKey)}">${esc(labelKey)}</span>
       <span class="v mono">${show(value)} ₾</span></div>`;

  return `
  <div class="card">
    <h2 data-i18n="იმპორტის ოპერაცია">იმპორტის ოპერაცია</h2>
    <p class="note" data-i18n="თვითღირებულება იყინება მიღებისას; გადახდის დღის კურსის სხვაობა თვითღირებულებაში არ შედის.">თვითღირებულება იყინება მიღებისას; გადახდის დღის კურსის სხვაობა თვითღირებულებაში არ შედის.</p>

    <div class="row r4">
      <div><label data-i18n="თარიღი">თარიღი</label>
        <input type="date" data-imp="date" value="${esc(impState.date)}"></div>
      <div><label data-i18n="დოკუმენტი">დოკუმენტი</label>
        <input data-imp="doc" value="${esc(impState.doc)}" data-i18n-ph="ს/ფ, დეკლარაცია, დავალება" placeholder="ს/ფ, დეკლარაცია, დავალება"></div>
      <div><label data-i18n="მომწოდებელი">მომწოდებელი</label>
        <input data-imp="supplier" value="${esc(impState.supplier)}" list="dl-p"></div>
      <div><label data-i18n="გადამზიდი">გადამზიდი</label>
        <input data-imp="carrier" value="${esc(impState.carrier)}" list="dl-p"></div>
    </div>

    <div class="row r4">
      <div><label data-i18n="ვალუტა">ვალუტა</label>
        <select data-imp="currency">${['USD', 'EUR', 'RUB', 'TRY', 'CNY'].map((c) =>
          `<option ${impState.currency === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
      <div><label data-i18n="კურსი">კურსი</label>
        <input class="num" inputmode="decimal" data-imp="rate" value="${esc(impState.rate)}"></div>
      <div><label data-i18n="საბაჟო გადასახადი">საბაჟო გადასახადი</label>
        <div style="display:flex;gap:6px">
          <select data-imp="dutyMode" style="width:auto">
            <option value="percent" ${impState.dutyMode === 'percent' ? 'selected' : ''}>%</option>
            <option value="amount" ${impState.dutyMode === 'amount' ? 'selected' : ''}>₾</option>
          </select>
          <input class="num" inputmode="decimal" data-imp="dutyValue" value="${esc(impState.dutyValue)}"></div></div>
      <div><label data-i18n="სხვა პირდაპირი ხარჯები">სხვა პირდაპირი ხარჯები</label>
        <input class="num" inputmode="decimal" data-imp="otherCosts" value="${esc(impState.otherCosts)}"></div>
    </div>

    <div class="row r4">
      <div><label data-i18n="ტრანსპორტი">ტრანსპორტი</label>
        <input class="num" inputmode="decimal" data-imp="transport" value="${esc(impState.transport)}"></div>
      <div><label data-i18n="ტრანსპორტის ვალუტა">ტრანსპორტის ვალუტა</label>
        <select data-imp="transportCur">${['USD', 'EUR', 'GEL'].map((c) =>
          `<option ${impState.transportCur === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
      <div><label data-i18n="ტრანსპორტის კურსი">ტრანსპორტის კურსი</label>
        <input class="num" inputmode="decimal" data-imp="transportRate" value="${esc(impState.transportRate)}"
               ${impState.transportCur === 'GEL' ? 'disabled' : ''}></div>
      <div><label data-i18n="განაწილება">განაწილება</label>
        <select data-imp="allocation">
          <option value="value" ${impState.allocation === 'value' ? 'selected' : ''} data-i18n="ღირებულების პროპორციით">ღირებულების პროპორციით</option>
          <option value="quantity" ${impState.allocation === 'quantity' ? 'selected' : ''} data-i18n="რაოდენობით">რაოდენობით</option>
        </select></div>
    </div>

    <div class="imp-flags">
      <label class="chk"><input type="checkbox" data-imp="transportInCustoms"
        ${impState.transportInCustoms ? 'checked' : ''}>
        <span data-i18n="ტრანსპორტი საბაჟო ღირებულებაში (საზღვრამდე, დეკლარირებული)">ტრანსპორტი საბაჟო ღირებულებაში (საზღვრამდე, დეკლარირებული)</span></label>
      <span class="pill ${vatPayer ? 'ok' : ''}">
        <span data-i18n="დღგ-ს სტატუსი">დღგ-ს სტატუსი</span>:
        <span data-i18n="${vatPayer ? 'გადამხდელი' : 'არაგადამხდელი'}">${vatPayer ? 'გადამხდელი' : 'არაგადამხდელი'}</span></span>
    </div>

    <div class="tw"><table class="lines">
      <thead><tr>
        <th></th><th data-i18n="დასახელება">დასახელება</th>
        <th class="num" data-i18n="რაოდენობა">რაოდენობა</th>
        <th class="num" data-i18n="ფასი ვალუტაში">ფასი ვალუტაში</th>
        <th class="num" data-i18n="ღირებულება ₾">ღირებულება ₾</th>
        <th class="num" data-i18n="განაწილებული">განაწილებული</th>
        <th class="num" data-i18n="თვითღირებულება">თვითღირებულება</th>
        <th class="num" data-i18n="ერთეულის">ერთეულის</th><th></th>
      </tr></thead>
      <tbody>${lineRows}</tbody>
    </table></div>
    <div class="actions"><button class="sm" data-act="imp-add" data-i18n="+ ხაზის დამატება">+ ხაზის დამატება</button></div>

    <div class="kpi imp-kpi">
      ${kv('საქონელი', r.goodsGel)}
      ${kv('ტრანსპორტი', r.transportGel)}
      ${kv('საბაჟო ღირებულება', r.customsValue)}
      ${kv('საბაჟო გადასახადი', r.dutyGel)}
      ${kv('იმპორტის დღგ', r.importVat, vatPayer ? 'ok' : 'warn')}
      ${kv('თვითღირებულება', r.capitalisedTotal)}
    </div>
    <p class="hint" data-i18n="${vatPayer ? 'დღგ ჩასათვლელია — თვითღირებულებაში არ შედის.' : 'დღგ თვითღირებულებაში შედის — ორგანიზაცია დღგ-ს გადამხდელი არ არის.'}">${vatPayer ? 'დღგ ჩასათვლელია — თვითღირებულებაში არ შედის.' : 'დღგ თვითღირებულებაში შედის — ორგანიზაცია დღგ-ს გადამხდელი არ არის.'}</p>

    <div class="msg ${r.checks.balances ? 'ok' : 'err'}">
      <span data-i18n="ხაზების ჯამი">ხაზების ჯამი</span>: <b class="mono">${show(r.checks.sumLines)} ₾</b> ·
      <span data-i18n="მთლიანი">მთლიანი</span>: <b class="mono">${show(r.capitalisedTotal)} ₾</b>
      ${r.checks.balances ? '· <span data-i18n="იკვრება">იკვრება</span>' : `· <span data-i18n="სხვაობა">სხვაობა</span> ${show(r.checks.diff)}`}
    </div>

    ${impState.msg ? `<div class="msg ${impState.msg.cls}">${esc(impState.msg.text)}</div>` : ''}

    <div class="actions">
      <button class="primary" data-act="imp-post" data-i18n="გატარებების შექმნა">გატარებების შექმნა</button>
      <span class="spacer"></span>
      <button class="sm" data-act="imp-csv" data-i18n="გაანგარიშების CSV">გაანგარიშების CSV</button>
    </div>

    <details class="imp-preview"><summary data-i18n="გატარების გადახედვა">გატარების გადახედვა</summary>
      ${entryPreview(r, vatPayer)}
    </details>
  </div>`;
}

function entryPreview(r, vatPayer) {
  const e = buildImportEntry(r, { ...impState, vatPayer });
  const rows = e.lines.map((l) => `<tr><td class="mono">${esc(l.acc)}</td><td>${esc(l.it || l.p || '')}</td>
    <td class="num mono">${l.dr ? show(l.dr) : ''}</td><td class="num mono">${l.cr ? show(l.cr) : ''}</td></tr>`).join('');
  return `<div class="tw"><table>
    <thead><tr><th data-i18n="ანგარიში">ანგარიში</th><th></th>
      <th class="num" data-i18n="დებეტი">დებეტი</th><th class="num" data-i18n="კრედიტი">კრედიტი</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><td colspan="2" data-i18n="ჯამი">ჯამი</td>
      <td class="num mono">${show(e.totals.dr)}</td><td class="num mono">${show(e.totals.cr)}</td></tr></tfoot>
  </table></div>`;
}

/* ---------------------------------------------------------------- actions -- */

export function impCsv() {
  const r = result();
  const h = ['დასახელება', 'რაოდენობა', 'ფასი ვალუტაში', 'ღირებულება GEL', 'განაწილებული', 'თვითღირებულება', 'ერთეულის'];
  const rows = [h, ...r.lines.map((l) => [l.name, l.qty, l.price, l.valueGelR, l.allocatedR, l.totalCost, round2(l.unitCost)])];
  rows.push([]);
  rows.push(['საბაჟო ღირებულება', r.customsValue]);
  rows.push(['საბაჟო გადასახადი', r.dutyGel]);
  rows.push(['დღგ-ს ბაზა', r.vatBase]);
  rows.push(['იმპორტის დღგ', r.importVat]);
  rows.push(['დღგ ჩასათვლელი', r.vatCreditable]);
  rows.push(['დღგ თვითღირებულებაში', r.vatInCost]);
  rows.push(['სულ თვითღირებულება', r.capitalisedTotal]);
  return '﻿' + rows.map((row) => row.map((v) => {
    const s = String(v ?? '');
    return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(';')).join('\r\n');
}

/** ჟურნალში ჩაწერა არსებული მექანიზმით (დებეტი=კრედიტი უკვე შემოწმებულია). */
export function impPost(org) {
  const r = result();
  if (!r.lines.length || r.capitalisedTotal === 0) {
    impState.msg = { cls: 'err', text: tr('გატარების თანხა ნულია.') };
    return false;
  }
  const e = buildImportEntry(r, { ...impState, vatPayer: !!org.settings.vatPayer });
  if (!e.totals.balanced) {
    impState.msg = { cls: 'err', text: tr('ვერ ბალანსდება') };
    return false;
  }
  addEntry(org, { date: e.date, doc: e.doc, typ: e.typ, desc: e.desc, cmt: '', lines: e.lines });
  store.save();
  impState.msg = { cls: 'ok', text: `${tr('გატარება შენახულია')} — ${show(e.totals.dr)} ₾` };
  return true;
}
