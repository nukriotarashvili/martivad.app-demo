// © შპს მარტივადი — Elastic License 2.0 (იხ. LICENSE)
/* ============================================================================
   app.js — ინტერფეისი. ჩანართები: ორგანიზაცია · გატარებები · ატვირთვა ·
            ცნობარები · უწყისი
   ========================================================================== */
import SR from './sheetread.js';
import { store, blankOrg, accMap, addEntry, ensurePartner, ensureItem, trialBalance } from './store.js';
import { importBank, importSales, closeMonth } from './importers.js';
import * as backup from './backup.js';
import { applyI18n, t as tr } from './i18n.js';
import { initRates } from './ratesView.js';
import { vImport, impState, impCsv, impPost } from './importView.js';

/* ---------------------------------------------------------------- helpers */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat('ka-GE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const f2 = v => nf.format(+v || 0);
const f0 = v => new Intl.NumberFormat('ka-GE', { maximumFractionDigits: 0 }).format(+v || 0);
const round2 = v => Math.round((+v + Number.EPSILON) * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
const dmy = d => (d || '').split('-').reverse().join('.');

let tab = 'org';
let status = { cls: '', txt: 'მზადაა' };
const setStatus = (cls, txt) => { status = { cls, txt }; };

const TABS = { org: 'ორგანიზაცია', journal: 'გატარებები', upload: 'ატვირთვა',
               imp: 'იმპორტი', ref: 'ცნობარები', tb: 'უწყისი' };

/* ---------------------------------------------------------------- state */
let draft = newDraft();
let pending = null;
let filter = { m: '', acc: '', p: '' };
const open = {};
let tbRange = { from: '', to: '' };
let cardAcc = '';

function newDraft() {
  return { date: today(), doc: '', typ: 'რეალიზაცია', desc: '', cmt: '', tpl: '',
           lines: [line(), line()] };
}
function line(acc = '', p = '', it = '', qty = '', cur = 'GEL', fc = '', rate = '', dr = '', cr = '', sd = 'd') {
  return { acc, p, it, qty, cur, fc, rate, dr, cr, sd };
}

const TYPES = ['რეალიზაცია', 'თვითღირებულების ჩამოწერა', 'საქონლის მიღება', 'გადახდა მომწოდებელს',
  'თანხის მიღება მყიდველისგან', 'ხელფასის დარიცხვა', 'გადასახადის გადახდა ხაზინაში',
  'ვალუტის კონვერტაცია', 'საკურსო სხვაობა', 'საბანკო საკომისიო', 'სხვა'];

const TPL = {
  '': { label: '— ცარიელი —', lines: [line(), line()] },
  sale: { label: 'რეალიზაცია', typ: 'რეალიზაცია', d: 'საქონლის რეალიზაცია — ს/ფ ',
    f: o => [line(o.rules.receivable), line(o.rules.revenue, '', '', '', 'GEL', '', '', '', '', 'c'),
             line(o.rules.vatOut, '', '', '', 'GEL', '', '', '', '', 'c')] },
  cogs: { label: 'თვითღირებულების ჩამოწერა', typ: 'თვითღირებულების ჩამოწერა', d: 'თვითღირებულება — ს/ფ ',
    f: o => [line(o.rules.cogs), line(o.rules.goods, '', '', '', 'GEL', '', '', '', '', 'c')] },
  recv: { label: 'ჩარიცხვა მყიდველისგან', typ: 'თანხის მიღება მყიდველისგან', d: 'პროდუქციის საფასური',
    f: o => [line(bankAcc(o)), line(o.rules.receivable, '', '', '', 'GEL', '', '', '', '', 'c')] },
  pay: { label: 'გადახდა მომწოდებელს', typ: 'გადახდა მომწოდებელს', d: 'ინვოისის დაფარვა',
    f: o => [line('3110-001'), line(bankAcc(o), '', '', '', 'GEL', '', '', '', '', 'c')] },
  goods: { label: 'საქონლის მიღება', typ: 'საქონლის მიღება', d: 'საქონლის მიღება საწყობში',
    f: o => [line(o.rules.goods), line('3110-001', '', '', '', 'GEL', '', '', '', '', 'c')] },
  wage: { label: 'ხელფასის დარიცხვა', typ: 'ხელფასის დარიცხვა', d: 'ხელფასის დარიცხვა — ',
    f: () => [line('7410'), line('7415'), line('3130', '', '', '', 'GEL', '', '', '', '', 'c'),
              line('3320', '', '', '', 'GEL', '', '', '', '', 'c'), line('3370-001', '', '', '', 'GEL', '', '', '', '', 'c')] },
  fee: { label: 'საბანკო საკომისიო', typ: 'საბანკო საკომისიო', d: 'საბანკო მომსახურების საკომისიო',
    f: o => [line('7490-001'), line(bankAcc(o), '', '', '', 'GEL', '', '', '', '', 'c')] },
};
const bankAcc = o => (o.rules.accounts.find(a => a.ccy === 'GEL') || {}).code || '1210-001';

/* ---------------------------------------------------------------- validation */
function validate(org, d) {
  const A = accMap(org), errs = [];
  if (!d.date) errs.push('თარიღი არ არის მითითებული.');
  if (!d.desc.trim()) errs.push('შინაარსი არ არის შევსებული.');
  let dr = 0, cr = 0, filled = 0;
  d.lines.forEach((l, i) => {
    if (!(l.acc || l.dr || l.cr)) return;
    filled++;
    const n = i + 1, a = A.get(l.acc);
    if (!a) { errs.push(`ხაზი ${n}: ანგარიშის კოდი „${l.acc || '—'}" გეგმაში არ არის.`); return; }
    const D = +l.dr || 0, C = +l.cr || 0;
    if (D && C) errs.push(`ხაზი ${n}: ერთ ხაზზე ერთდროულად დებეტიც და კრედიტიც არ შეიძლება.`);
    if (!D && !C) errs.push(`ხაზი ${n}: თანხა არ არის მითითებული.`);
    if (D < 0 || C < 0) errs.push(`ხაზი ${n}: თანხა უარყოფითი ვერ იქნება.`);
    if (a.p && !l.p) errs.push(`ხაზი ${n} (${a.c}): პარტნიორი სავალდებულოა.`);
    if (a.i && !l.it) errs.push(`ხაზი ${n} (${a.c}): საქონლის კოდი სავალდებულოა.`);
    if (l.cur && l.cur !== 'GEL') {
      const fc = +l.fc || 0, r = +l.rate || 0;
      if (!fc) errs.push(`ხაზი ${n}: ${l.cur}-ის თანხა არ არის მითითებული.`);
      if (!r) errs.push(`ხაზი ${n}: კურსი არ არის მითითებული.`);
      if (fc && r && Math.abs(round2(fc * r) - (D || C)) > 0.01)
        errs.push(`ხაზი ${n}: ${fc} × ${r} = ${f2(round2(fc * r))}, ხაზზე კი ${f2(D || C)}.`);
    }
    dr += D; cr += C;
  });
  if (!filled) errs.push('ჟურნალის ხაზები ცარიელია.');
  else if (Math.abs(round2(dr) - round2(cr)) > 0.004)
    errs.push(`დებეტი ${f2(dr)} ≠ კრედიტი ${f2(cr)} — სხვაობა ${f2(dr - cr)}.`);
  else if (!dr) errs.push('გატარების თანხა ნულია.');
  return { errs, dr: round2(dr), cr: round2(cr) };
}

/* ---------------------------------------------------------------- export */
function csv(org) {
  const h = ['ნომერი', 'თარიღი', 'დოკუმენტი', 'ტიპი', 'შინაარსი', 'ანგარიში', 'პარტნიორი', 'საქონელი',
             'რაოდენობა', 'ვალუტა', 'თანხა ვალუტაში', 'კურსი', 'დებეტი', 'კრედიტი', 'კომენტარი'];
  const rows = [h];
  org.entries.forEach(e => e.lines.forEach(l =>
    rows.push([e.no, e.date, e.doc, e.typ, e.desc, l.acc, l.p, l.it, l.qty, l.cur, l.fc, l.rate, l.dr, l.cr, e.cmt])));
  return '﻿' + rows.map(r => r.map(v => {
    const s = String(v ?? ''); return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(';')).join('\r\n');
}
function download(name, text, mime = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type: mime + ';charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 500);
}

/* ================================================================ VIEWS */
function vOrg() {
  const orgs = store.all(), org = store.active();
  return `
  <div id="ratesCard"></div>

  <div class="card">
    <h2 data-i18n="ორგანიზაციები">ორგანიზაციები</h2>
    <p class="note" data-i18n="ერთ ბრაუზერში რამდენიმე ორგანიზაციის წარმოება შეიძლება. მონაცემები ინახება მხოლოდ
      ამ მოწყობილობაზე — სერვერზე არაფერი იგზავნება. სარეზერვო ასლისთვის გამოიყენეთ ექსპორტი.">ერთ ბრაუზერში რამდენიმე ორგანიზაციის წარმოება შეიძლება. მონაცემები ინახება მხოლოდ
      ამ მოწყობილობაზე — სერვერზე არაფერი იგზავნება. სარეზერვო ასლისთვის გამოიყენეთ ექსპორტი.</p>
    ${orgs.length ? `<div class="tw"><table>
      <thead><tr><th data-i18n="დასახელება">დასახელება</th><th data-i18n="ს/ნ">ს/ნ</th><th data-i18n="დღგ">დღგ</th><th class="num" data-i18n="გატარება">გატარება</th><th data-i18n="შექმნილია">შექმნილია</th><th></th></tr></thead>
      <tbody>${orgs.map(o => `<tr>
        <td><b>${esc(o.name)}</b>${o.id === (org && org.id) ? ' <span class="pill ok" data-i18n="აქტიური">აქტიური</span>' : ''}</td>
        <td class="mono">${esc(o.tin)}</td>
        <td>${o.settings.vatPayer ? o.settings.vatRate + '%' : '—'}</td>
        <td class="num">${o.entries.length}</td>
        <td class="mono">${dmy(o.created)}</td>
        <td style="text-align:right">
          ${o.id === (org && org.id) ? '' : `<button class="sm" data-act="pick" data-id="${o.id}" data-i18n="გახსნა">გახსნა</button>`}
          <button class="ghost sm" data-act="delorg" data-id="${o.id}">✕</button></td></tr>`).join('')}
      </tbody></table></div>` : `
    <div class="empty"><h3 data-i18n="ჯერ არცერთი ორგანიზაცია არ არის">ჯერ არცერთი ორგანიზაცია არ არის</h3>
      <p data-i18n="დაიწყეთ ახლის შექმნით — ანგარიშთა გეგმა (114 ანგარიში, საქართველოს სტანდარტი) ავტომატურად ჩაიტვირთება.">დაიწყეთ ახლის შექმნით — ანგარიშთა გეგმა (114 ანგარიში, საქართველოს სტანდარტი) ავტომატურად ჩაიტვირთება.</p></div>`}
  </div>

  <div class="card">
    <h2 data-i18n="ახალი ორგანიზაცია">ახალი ორგანიზაცია</h2>
    <p class="note" data-i18n="დასახელება და საიდენტიფიკაციო კოდი აუცილებელია; დანარჩენი შემდეგაც შეიცვლება.">დასახელება და საიდენტიფიკაციო კოდი აუცილებელია; დანარჩენი შემდეგაც შეიცვლება.</p>
    <div class="row r4">
      <div style="grid-column:span 2"><label data-i18n="დასახელება">დასახელება</label><input id="nOrg" placeholder="შპს „..." data-i18n-ph="შპს „..."></div>
      <div><label data-i18n="საიდენტიფიკაციო კოდი">საიდენტიფიკაციო კოდი</label><input id="nTin" class="mono" placeholder="9 ციფრი" data-i18n-ph="9 ციფრი"></div>
      <div><label data-i18n="საანგარიშო წლის დასაწყისი">საანგარიშო წლის დასაწყისი</label><input id="nFrom" type="date" value="${new Date().getFullYear()}-01-01"></div>
    </div>
    <div class="row r3">
      <div><label data-i18n="დღგ-ს გადამხდელი">დღგ-ს გადამხდელი</label>
        <select id="nVat"><option value="1" data-i18n="კი">კი</option><option value="0" data-i18n="არა">არა</option></select></div>
      <div><label data-i18n="დღგ-ს განაკვეთი, %">დღგ-ს განაკვეთი, %</label><input inputmode="decimal" id="nRate" class="num" value="18"></div>
      <div><label data-i18n="საბაზისო ვალუტა">საბაზისო ვალუტა</label><input value="GEL (ლარი)" disabled></div>
    </div>
    <div class="actions">
      <button class="primary" data-act="neworg" data-i18n="ორგანიზაციის შექმნა">ორგანიზაციის შექმნა</button>
      <span class="spacer"></span>
      <button class="sm" data-act="expall" data-i18n="ყველაფრის ექსპორტი (JSON)">ყველაფრის ექსპორტი (JSON)</button>
      <label style="text-transform:none;letter-spacing:0;font-weight:600;font-size:13px;margin:0;display:inline-flex;align-items:center;gap:8px">
        <span data-i18n="იმპორტი:">იმპორტი:</span> <input type="file" id="impAll" accept=".json" style="width:auto"></label>
    </div>
  </div>`;
}

function vJournal(org) {
  const v = validate(org, draft);
  const A = accMap(org);
  const touched = !!(draft.desc || draft.doc || draft.cmt || draft.lines.some(l => l.acc || l.dr || l.cr || l.p || l.it));
  const months = [...new Set(org.entries.map(e => e.date.slice(0, 7)))].sort();
  const shown = org.entries.filter(e =>
    (!filter.m || e.date.slice(0, 7) === filter.m) &&
    (!filter.acc || e.lines.some(l => l.acc.startsWith(filter.acc))) &&
    (!filter.p || e.lines.some(l => (l.p || '').includes(filter.p))));
  const tot = shown.reduce((a, e) => a + e.lines.reduce((s, l) => s + (+l.dr || 0), 0), 0);

  const lineRow = (l, i) => {
    const a = A.get(l.acc);
    const needP = a && a.p, needI = a && a.i;
    return `<tr>
     <td>${i + 1}</td>
     <td style="min-width:120px"><input list="dl-acc" value="${esc(l.acc)}" data-i="${i}" data-f="acc" class="mono ${l.acc && !a ? 'bad' : ''}" placeholder="1410-001"></td>
     <td style="min-width:170px"><input list="dl-p" value="${esc(l.p)}" data-i="${i}" data-f="p" placeholder="${needP ? 'სავალდებულო' : '—'}" ${needP && !l.p ? 'class="bad"' : ''}></td>
     <td style="min-width:130px"><input list="dl-i" value="${esc(l.it)}" data-i="${i}" data-f="it" class="mono ${needI && !l.it ? 'bad' : ''}" placeholder="${needI ? 'სავალდებულო' : '—'}"></td>
     <td style="width:88px"><input inputmode="decimal" value="${esc(l.qty)}" data-i="${i}" data-f="qty" class="num" placeholder="—"></td>
     <td style="width:74px"><select data-i="${i}" data-f="cur">${['GEL', 'USD', 'EUR', 'RUB'].map(c => `<option ${l.cur === c ? 'selected' : ''}>${c}</option>`).join('')}</select></td>
     <td style="width:110px"><input inputmode="decimal" value="${esc(l.fc)}" data-i="${i}" data-f="fc" class="num" placeholder="—" ${l.cur === 'GEL' ? 'disabled' : ''}></td>
     <td style="width:96px"><input inputmode="decimal" value="${esc(l.rate)}" data-i="${i}" data-f="rate" class="num" placeholder="—" ${l.cur === 'GEL' ? 'disabled' : ''}></td>
     <td style="width:118px"><input inputmode="decimal" value="${esc(l.dr)}" data-i="${i}" data-f="dr" class="num" placeholder="0.00"></td>
     <td style="width:118px"><input inputmode="decimal" value="${esc(l.cr)}" data-i="${i}" data-f="cr" class="num" placeholder="0.00"></td>
     <td style="width:30px"><button class="ghost" data-act="delline" data-i="${i}" title="ხაზის წაშლა">✕</button></td></tr>`;
  };

  return `
  <div class="card">
    <h2 data-i18n="ახალი გატარება">ახალი გატარება</h2>
    <p class="note" data-i18n="შენახვა შესაძლებელია მხოლოდ მაშინ, როცა დებეტი კრედიტს უტოლდება და ყველა სავალდებულო ველი შევსებულია.">შენახვა შესაძლებელია მხოლოდ მაშინ, როცა დებეტი კრედიტს უტოლდება და ყველა სავალდებულო ველი შევსებულია.</p>
    <div class="row r4">
      <div><label data-i18n="თარიღი">თარიღი</label><input type="date" value="${esc(draft.date)}" data-d="date"></div>
      <div><label data-i18n="დოკუმენტი">დოკუმენტი</label><input value="${esc(draft.doc)}" data-d="doc" placeholder="ს/ფ, დეკლარაცია, დავალება" data-i18n-ph="ს/ფ, დეკლარაცია, დავალება"></div>
      <div><label data-i18n="ოპერაციის ტიპი">ოპერაციის ტიპი</label><select data-d="typ">${TYPES.map(t => `<option ${draft.typ === t ? 'selected' : ''} data-i18n="${esc(t)}">${esc(t)}</option>`).join('')}</select></div>
      <div><label data-i18n="შაბლონი">შაბლონი</label><select data-d="tpl">${Object.entries(TPL).map(([k, t]) => `<option value="${k}" ${draft.tpl === k ? 'selected' : ''} data-i18n="${esc(t.label)}">${esc(t.label)}</option>`).join('')}</select></div>
    </div>
    <div class="row r1"><div><label data-i18n="შინაარსი">შინაარსი</label><input value="${esc(draft.desc)}" data-d="desc" placeholder="რას ასახავს გატარება" data-i18n-ph="რას ასახავს გატარება"></div></div>
    <div class="row r1"><div><label data-i18n="კომენტარი">კომენტარი</label><input value="${esc(draft.cmt)}" data-d="cmt" placeholder="გაანგარიშება, დოკუმენტის დეტალები, სტანდარტის მუხლი" data-i18n-ph="გაანგარიშება, დოკუმენტის დეტალები, სტანდარტის მუხლი"></div></div>
    <div class="tw"><table class="lines">
      <thead><tr><th></th><th data-i18n="ანგარიში">ანგარიში</th><th data-i18n="პარტნიორი">პარტნიორი</th><th data-i18n="საქონელი">საქონელი</th><th class="num" data-i18n="რაოდ.">რაოდ.</th>
        <th data-i18n="ვალუტა">ვალუტა</th><th class="num" data-i18n="თანხა ვალ.">თანხა ვალ.</th><th class="num" data-i18n="კურსი">კურსი</th><th class="num" data-i18n="დებეტი">დებეტი</th><th class="num" data-i18n="კრედიტი">კრედიტი</th><th></th></tr></thead>
      <tbody>${draft.lines.map(lineRow).join('')}</tbody>
      <tfoot><tr class="tot"><td colspan="8" data-i18n="სულ">სულ</td><td class="num">${f2(v.dr)}</td><td class="num">${f2(v.cr)}</td><td></td></tr></tfoot>
    </table></div>
    <div class="actions">
      <button data-act="addline" class="sm" data-i18n="+ ხაზის დამატება">+ ხაზის დამატება</button>
      <span class="pill ${!touched ? '' : (v.errs.length ? 'err' : 'ok')}">${!touched ? '<span data-i18n="ცარიელი ფორმა">ცარიელი ფორმა</span>' : (v.errs.length ? '<span data-i18n="ვერ ბალანსდება">ვერ ბალანსდება</span>' : '<span data-i18n="ბალანსდება —">ბალანსდება —</span> ' + f2(v.dr) + ' ₾')}</span>
      <span class="spacer"></span>
      <button data-act="clear" class="sm" data-i18n="გასუფთავება">გასუფთავება</button>
      <button data-act="save" class="primary" ${v.errs.length ? 'disabled' : ''} data-i18n="გატარების შენახვა">გატარების შენახვა</button>
    </div>
    ${touched && v.errs.length ? `<div class="msg err"><b>შესამოწმებელია:</b><ul>${v.errs.map(e => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}
  </div>

  <div class="card">
    <h2 data-i18n="ჟურნალი">ჟურნალი</h2>
    <div class="filters">
      <div><label data-i18n="თვე">თვე</label><select data-f2="m"><option value="" data-i18n="ყველა">ყველა</option>${months.map(m => `<option value="${m}" ${filter.m === m ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
      <div><label data-i18n="ანგარიში (პრეფიქსი)">ანგარიში (პრეფიქსი)</label><input value="${esc(filter.acc)}" data-f2="acc" class="mono" placeholder="მაგ. 1410" data-i18n-ph="მაგ. 1410"></div>
      <div><label data-i18n="პარტნიორი">პარტნიორი</label><input list="dl-p" value="${esc(filter.p)}" data-f2="p" placeholder="ყველა" data-i18n-ph="ყველა"></div>
      <div style="flex:1;text-align:right;min-width:140px"><label data-i18n="ნაჩვენები ბრუნვა">ნაჩვენები ბრუნვა</label>
        <div class="mono" style="font-size:16px;font-variant-numeric:tabular-nums">${f2(tot)} ₾</div></div>
    </div>
    ${shown.length ? shown.slice().reverse().map(e => {
      const t = e.lines.reduce((s, l) => s + (+l.dr || 0), 0);
      return `<div class="jent">
        <div class="jhd" data-act="toggle" data-no="${e.no}">
          <span class="d">${dmy(e.date)}</span><span class="pill">${esc(e.typ)}</span>
          <span class="t">${esc(e.desc)}</span><span class="d">${esc(e.doc)}</span>
          <span class="a">${f2(t)} ₾</span>
          <button class="ghost sm" data-act="del" data-no="${e.no}" title="წაშლა">✕</button>
        </div>
        ${open[e.no] ? `<div class="jbody"><div class="tw"><table>
          <thead><tr><th data-i18n="ანგარიში">ანგარიში</th><th data-i18n="პარტნიორი">პარტნიორი</th><th data-i18n="საქონელი">საქონელი</th><th class="num" data-i18n="რაოდ.">რაოდ.</th><th data-i18n="ვალ.">ვალ.</th>
            <th class="num" data-i18n="თანხა ვალ.">თანხა ვალ.</th><th class="num" data-i18n="კურსი">კურსი</th><th class="num" data-i18n="დებეტი">დებეტი</th><th class="num" data-i18n="კრედიტი">კრედიტი</th></tr></thead>
          <tbody>${e.lines.map(l => `<tr><td class="mono">${esc(l.acc)}<div class="hint">${esc((A.get(l.acc) || {}).n || '')}</div></td>
            <td>${esc(l.p)}</td><td class="mono">${esc(l.it)}</td><td class="num">${esc(l.qty)}</td><td>${esc(l.cur)}</td>
            <td class="num">${l.fc ? f2(l.fc) : ''}</td><td class="num">${esc(l.rate)}</td>
            <td class="num">${l.dr ? f2(l.dr) : ''}</td><td class="num">${l.cr ? f2(l.cr) : ''}</td></tr>`).join('')}</tbody>
        </table></div>${e.cmt ? `<div class="hint" style="margin-top:8px">${esc(e.cmt)}</div>` : ''}</div>` : ''}
      </div>`; }).join('') : '<div class="msg" data-i18n="ჯერ არცერთი გატარება არ არის შენახული.">ჯერ არცერთი გატარება არ არის შენახული.</div>'}
    <div class="actions">
      <button data-act="csv" class="sm" data-i18n="CSV ჩამოტვირთვა">CSV ჩამოტვირთვა</button>
      <button data-act="json" class="sm" data-i18n="JSON ჩამოტვირთვა">JSON ჩამოტვირთვა</button>
    </div>
  </div>${datalists(org)}`;
}

function vUpload(org) {
  const noAcc = !org.rules.accounts.length;
  return `
  <div class="card">
    <h2 data-i18n="დოკუმენტის ატვირთვა">დოკუმენტის ატვირთვა</h2>
    <p class="note" data-i18n="საბანკო ამონაწერი (.xlsx) და rs.ge-ს რეალიზაციის რეპორტი (.xls / .xlsx / .csv).
      ფაილი ბრაუზერშივე იშიფრება — არსად არ იგზავნება. ერთდროულად რამდენიმე ფაილიც შეიძლება.">საბანკო ამონაწერი (.xlsx) და rs.ge-ს რეალიზაციის რეპორტი (.xls / .xlsx / .csv).
      ფაილი ბრაუზერშივე იშიფრება — არსად არ იგზავნება. ერთდროულად რამდენიმე ფაილიც შეიძლება.</p>
    ${noAcc ? `<div class="msg warn"><span data-i18n="საბანკო ამონაწერის ასატვირთად ჯერ დაამატეთ ანგარიში:">საბანკო ამონაწერის ასატვირთად ჯერ დაამატეთ ანგარიში:</span>
      <b data-i18n="ცნობარები → საბანკო ანგარიშები">ცნობარები → საბანკო ანგარიშები</b> <span data-i18n="(IBAN, ვალუტა და ბუღალტრული კოდი).">(IBAN, ვალუტა და ბუღალტრული კოდი).</span></div>` : ''}
    <div class="actions">
      <input type="file" id="fileIn" multiple accept=".xlsx,.xls,.csv" style="width:auto">
      <span class="spacer"></span>
      <button data-act="closemonth" class="sm" data-i18n="თვის დახურვა — თვითღირებულება">თვის დახურვა — თვითღირებულება</button>
    </div>
    <div id="impOut">${impHtml()}</div>
  </div>`;
}

function impHtml() {
  if (!pending) return '';
  const p = pending, on = p.entries.filter(e => e._on);
  const tot = on.reduce((a, e) => a + e.lines.reduce((s, l) => s + (+l.dr || 0), 0), 0);
  return `
  <div class="msg ok" style="margin-top:14px">
    <b>${esc(p.kind)}:</b> ${p.entries.length} გატარება · მონიშნულია ${on.length} · ჯამი ${f2(tot)} ₾
    ${p.info && p.info.length ? ' · ' + p.info.map(esc).join(' · ') : ''}
    ${p.warn && p.warn.length ? `<ul>${p.warn.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
  </div>
  ${p.newParties && p.newParties.length ? `<div class="msg warn">
    <b>ახალი კონტრაგენტი: ${p.newParties.length}</b> — დარეგისტრირდება ავტომატურად, თუ მონიშნავთ.
    <ul>${p.newParties.slice(0, 12).map(x => `<li>${esc(x.name)} · ${esc(x.tin)} · ${esc(x.side)}</li>`).join('')}</ul>
    <label style="text-transform:none;letter-spacing:0;margin-top:6px;display:flex;align-items:center;gap:8px;font-weight:600">
      <input type="checkbox" id="regParties" checked> ცნობარში დამატება</label></div>` : ''}
  <div class="tw tall" style="margin-top:10px"><table>
    <thead><tr><th style="width:26px"></th><th data-i18n="თარიღი">თარიღი</th><th data-i18n="დოკუმენტი">დოკუმენტი</th><th data-i18n="ტიპი">ტიპი</th><th data-i18n="შინაარსი">შინაარსი</th>
      <th data-i18n="ანგარიშები">ანგარიშები</th><th class="num" data-i18n="თანხა">თანხა</th></tr></thead>
    <tbody>${p.entries.map((e, i) => {
      const t = e.lines.reduce((s, l) => s + (+l.dr || 0), 0);
      return `<tr><td><input type="checkbox" data-imp="${i}" ${e._on ? 'checked' : ''}></td>
        <td class="mono">${dmy(e.date)}</td><td class="mono">${esc(e.doc)}</td><td>${esc(e.typ)}</td>
        <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis">${esc(e.desc)}</td>
        <td class="mono">${esc(e.lines.map(l => l.acc).join(' / '))}</td>
        <td class="num">${f2(t)}</td></tr>`; }).join('')}
    </tbody></table></div>
  ${p.unmapped && p.unmapped.length ? `<div class="msg" style="margin-top:12px">
    <b>ვერ დავაკლასიფიცირე ${p.unmapped.length} ოპერაცია</b> — შეიყვანეთ ხელით ან დაამატეთ წესი ცნობარებში:
    <ul>${p.unmapped.slice(0, 15).map(u => `<li>${u.date} · ${esc(u.typ)} · ${f2(u.amount)} ${esc(u.ccy)} · ${esc(u.purpose)}</li>`).join('')}</ul></div>` : ''}
  <div class="actions">
    <button data-act="impall" class="sm" data-i18n="ყველას მონიშვნა">ყველას მონიშვნა</button>
    <button data-act="impnone" class="sm" data-i18n="მონიშვნის მოხსნა">მონიშვნის მოხსნა</button>
    <span class="spacer"></span>
    <button data-act="impcancel" class="sm" data-i18n="გაუქმება">გაუქმება</button>
    <button data-act="impsave" class="primary" ${on.length ? '' : 'disabled'}>ჟურნალში დამატება (${on.length})</button>
  </div>`;
}

function vRef(org) {
  return `
  <div class="grid2">
    <div class="card" style="margin-top:0">
      <h2 data-i18n="საბანკო ანგარიშები">საბანკო ანგარიშები</h2>
      <p class="note" data-i18n="ამონაწერის ამოსაცნობად: IBAN, ვალუტა და ბუღალტრული ანგარიშის კოდი.">ამონაწერის ამოსაცნობად: IBAN, ვალუტა და ბუღალტრული ანგარიშის კოდი.</p>
      <div class="tw"><table><thead><tr><th>IBAN</th><th data-i18n="ვალუტა">ვალუტა</th><th data-i18n="ანგარიში">ანგარიში</th><th></th></tr></thead>
        <tbody>${org.rules.accounts.map((a, i) => `<tr><td class="mono">${esc(a.iban)}</td><td>${esc(a.ccy)}</td>
          <td class="mono">${esc(a.code)}</td><td style="text-align:right"><button class="ghost sm" data-act="delacc" data-i="${i}">✕</button></td></tr>`).join('')
          || '<tr><td colspan="4" class="hint" data-i18n="ჯერ არაფერია">ჯერ არაფერია</td></tr>'}</tbody></table></div>
      <div class="row r3" style="margin-top:12px">
        <div><label>IBAN</label><input id="bIban" class="mono" placeholder="GE00XX..."></div>
        <div><label data-i18n="ვალუტა">ვალუტა</label><select id="bCcy"><option>GEL</option><option>USD</option><option>EUR</option><option>RUB</option></select></div>
        <div><label data-i18n="ანგარიში">ანგარიში</label><input id="bCode" list="dl-acc" class="mono" placeholder="1210-001"></div>
      </div>
      <div class="actions"><button data-act="addacc" class="sm" data-i18n="დამატება">დამატება</button></div>
    </div>

    <div class="card" style="margin-top:0">
      <h2 data-i18n="პარტნიორები">პარტნიორები</h2>
      <p class="note" data-i18n="მყიდველები და მომწოდებლები. იმპორტისას ავტომატურადაც ემატება.">მყიდველები და მომწოდებლები. იმპორტისას ავტომატურადაც ემატება.</p>
      <div class="tw tall"><table><thead><tr><th data-i18n="დასახელება">დასახელება</th><th data-i18n="ს/ნ">ს/ნ</th><th data-i18n="როლი">როლი</th><th></th></tr></thead>
        <tbody>${org.partners.map((p, i) => `<tr><td>${esc(p.name)}</td><td class="mono">${esc(p.tin)}</td>
          <td>${esc(p.role)}</td><td style="text-align:right"><button class="ghost sm" data-act="delp" data-i="${i}">✕</button></td></tr>`).join('')
          || '<tr><td colspan="4" class="hint" data-i18n="ჯერ არაფერია">ჯერ არაფერია</td></tr>'}</tbody></table></div>
      <div class="row r3" style="margin-top:12px">
        <div><label data-i18n="დასახელება">დასახელება</label><input id="pName"></div>
        <div><label data-i18n="ს/ნ">ს/ნ</label><input id="pTin" class="mono"></div>
        <div><label data-i18n="როლი">როლი</label><select id="pRole"><option data-i18n="მყიდველი">მყიდველი</option><option data-i18n="მომწოდებელი">მომწოდებელი</option><option data-i18n="სხვა">სხვა</option></select></div>
      </div>
      <div class="actions"><button data-act="addp" class="sm" data-i18n="დამატება">დამატება</button></div>
    </div>

    <div class="card" style="margin-top:0">
      <h2 data-i18n="საქონელი">საქონელი</h2>
      <p class="note" data-i18n="კოდი (შტრიხკოდი ან შიდა), დასახელება და ზომის ერთეული.">კოდი (შტრიხკოდი ან შიდა), დასახელება და ზომის ერთეული.</p>
      <div class="tw tall"><table><thead><tr><th data-i18n="კოდი">კოდი</th><th data-i18n="დასახელება">დასახელება</th><th data-i18n="ერთ.">ერთ.</th><th></th></tr></thead>
        <tbody>${org.items.map((it, i) => `<tr><td class="mono">${esc(it.code)}</td><td>${esc(it.name)}</td>
          <td>${esc(it.unit)}</td><td style="text-align:right"><button class="ghost sm" data-act="deli" data-i="${i}">✕</button></td></tr>`).join('')
          || '<tr><td colspan="4" class="hint" data-i18n="ჯერ არაფერია">ჯერ არაფერია</td></tr>'}</tbody></table></div>
      <div class="row r3" style="margin-top:12px">
        <div><label data-i18n="კოდი">კოდი</label><input id="iCode" class="mono"></div>
        <div><label data-i18n="დასახელება">დასახელება</label><input id="iName"></div>
        <div><label data-i18n="ერთეული">ერთეული</label><input id="iUnit" placeholder="ცალი / კგ" data-i18n-ph="ცალი / კგ"></div>
      </div>
      <div class="actions"><button data-act="addi" class="sm" data-i18n="დამატება">დამატება</button></div>
    </div>

    <div class="card" style="margin-top:0">
      <h2 data-i18n="ანგარიშთა გეგმა">ანგარიშთა გეგმა</h2>
      <p class="note"><span data-i18n="საქართველოს სტანდარტი">საქართველოს სტანდარტი</span>, ${org.coa.length} <span data-i18n="ანგარიში. „პ“ — პარტნიორი სავალდებულოა, „ს“ — საქონლის კოდი.">ანგარიში. „პ“ — პარტნიორი სავალდებულოა, „ს“ — საქონლის კოდი.</span></p>
      <div class="tw tall"><table><thead><tr><th data-i18n="კოდი">კოდი</th><th data-i18n="დასახელება">დასახელება</th><th data-i18n="ჯგუფი">ჯგუფი</th><th data-i18n="პ">პ</th><th data-i18n="ს">ს</th></tr></thead>
        <tbody data-no-i18n>${org.coa.map(a => `<tr><td class="mono">${esc(a.c)}</td><td>${esc(a.n)}</td>
          <td class="hint">${esc(a.g)}</td><td>${a.p ? '●' : ''}</td><td>${a.i ? '●' : ''}</td></tr>`).join('')}</tbody></table></div>
    </div>
  </div>${datalists(org)}`;
}

function vTB(org) {
  const A = accMap(org);
  const t = trialBalance(org, tbRange.from, tbRange.to);
  const codes = [...t.keys()].sort();
  let tdr = 0, tcr = 0;
  const rows = codes.map(c => {
    const v = t.get(c); tdr += v.dr; tcr += v.cr;
    const bal = v.dr - v.cr;
    return `<tr><td class="mono">${esc(c)}</td><td>${esc((A.get(c) || {}).n || '?')}</td>
      <td class="num">${v.dr ? f2(v.dr) : ''}</td><td class="num">${v.cr ? f2(v.cr) : ''}</td>
      <td class="num">${bal > 0.004 ? f2(bal) : ''}</td><td class="num">${bal < -0.004 ? f2(-bal) : ''}</td></tr>`;
  }).join('');

  const rev = [...t].filter(([c]) => c.startsWith('6')).reduce((a, [, v]) => a + v.cr - v.dr, 0);
  const cogs = [...t].filter(([c]) => c.startsWith('7')).reduce((a, [, v]) => a + v.dr - v.cr, 0);
  const recv = [...t].filter(([c]) => c.startsWith('141')).reduce((a, [, v]) => a + v.dr - v.cr, 0);
  const cash = [...t].filter(([c]) => c.startsWith('121') || c.startsWith('122')).reduce((a, [, v]) => a + v.dr - v.cr, 0);
  const stock = [...t].filter(([c]) => c === org.rules.goods).reduce((a, [, v]) => a + v.dr - v.cr, 0);
  const pay = [...t].filter(([c]) => c.startsWith('311')).reduce((a, [, v]) => a + v.cr - v.dr, 0);

  const card = cardAcc ? accountCard(org, cardAcc) : '';
  return `
  <div class="kpi">
    <div class="cell"><span class="code">6xxx</span><div class="k" data-i18n="შემოსავალი">შემოსავალი</div><div class="v">${f0(rev)}</div></div>
    <div class="cell"><span class="code">7xxx</span><div class="k" data-i18n="ხარჯი">ხარჯი</div><div class="v">${f0(cogs)}</div></div>
    <div class="cell"><span class="code">6−7</span><div class="k" data-i18n="შედეგი">შედეგი</div><div class="v">${f0(rev - cogs)}</div></div>
    <div class="cell"><span class="code">1410</span><div class="k" data-i18n="დებიტორები">დებიტორები</div><div class="v">${f0(recv)}</div></div>
    <div class="cell"><span class="code">12xx</span><div class="k" data-i18n="ფული">ფული</div><div class="v">${f0(cash)}</div></div>
    <div class="cell"><span class="code">3110</span><div class="k" data-i18n="კრედიტორები">კრედიტორები</div><div class="v">${f0(pay)}</div></div>
  </div>

  <div class="card">
    <h2 data-i18n="ბრუნვითი უწყისი">ბრუნვითი უწყისი</h2>
    <p class="note" data-i18n="პერიოდის ბრუნვა და ნაშთი ანგარიშების ჭრილში. საწყისი ნაშთი ჟურნალის გატარებებიდან ითვლება.">პერიოდის ბრუნვა და ნაშთი ანგარიშების ჭრილში. საწყისი ნაშთი ჟურნალის გატარებებიდან ითვლება.</p>
    <div class="filters">
      <div><label data-i18n="დან">დან</label><input type="date" value="${tbRange.from}" data-tb="from"></div>
      <div><label data-i18n="მდე">მდე</label><input type="date" value="${tbRange.to}" data-tb="to"></div>
      <div style="min-width:200px"><label data-i18n="ანგარიშის ბარათი">ანგარიშის ბარათი</label>
        <input list="dl-acc" value="${esc(cardAcc)}" data-tb="card" class="mono" placeholder="მაგ. 1410-001" data-i18n-ph="მაგ. 1410-001"></div>
      <div style="flex:1;text-align:right"><label data-i18n="საქონლის ნაშთი">საქონლის ნაშთი</label>
        <div class="mono" style="font-size:16px">${f2(stock)} ₾</div></div>
    </div>
    ${codes.length ? `<div class="tw tall"><table>
      <thead><tr><th data-i18n="ანგარიში">ანგარიში</th><th data-i18n="დასახელება">დასახელება</th><th class="num" data-i18n="ბრუნვა დტ">ბრუნვა დტ</th><th class="num" data-i18n="ბრუნვა კტ">ბრუნვა კტ</th>
        <th class="num" data-i18n="ნაშთი დტ">ნაშთი დტ</th><th class="num" data-i18n="ნაშთი კტ">ნაშთი კტ</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td colspan="2" data-i18n="ჯამი">ჯამი</td><td class="num">${f2(tdr)}</td><td class="num">${f2(tcr)}</td>
        <td class="num" colspan="2">${Math.abs(tdr - tcr) < 0.005 ? '<span class="pill ok" data-i18n="ბალანსდება">ბალანსდება</span>' : '<span class="pill err" data-i18n="სხვაობა ' + f2(tdr - tcr) + '">სხვაობა ' + f2(tdr - tcr) + '</span>'}</td></tr></tfoot>
    </table></div>` : '<div class="msg" data-i18n="ჟურნალი ცარიელია.">ჟურნალი ცარიელია.</div>'}
    <div class="actions"><button data-act="tbcsv" class="sm" data-i18n="უწყისის CSV">უწყისის CSV</button></div>
  </div>
  ${card}${datalists(org)}`;
}

function accountCard(org, code) {
  const A = accMap(org);
  const rows = [];
  let bal = 0;
  for (const e of org.entries) {
    if (tbRange.from && e.date < tbRange.from) continue;
    if (tbRange.to && e.date > tbRange.to) continue;
    for (const l of e.lines) {
      if (l.acc !== code) continue;
      bal += (+l.dr || 0) - (+l.cr || 0);
      rows.push({ e, l, bal });
    }
  }
  return `<div class="card">
    <h2>ბარათი ${esc(code)} — ${esc((A.get(code) || {}).n || '?')}</h2>
    ${rows.length ? `<div class="tw tall"><table>
      <thead><tr><th data-i18n="თარიღი">თარიღი</th><th data-i18n="დოკუმენტი">დოკუმენტი</th><th data-i18n="ოპერაცია">ოპერაცია</th><th data-i18n="პარტნიორი">პარტნიორი</th><th data-i18n="საქონელი">საქონელი</th>
        <th class="num" data-i18n="დებეტი">დებეტი</th><th class="num" data-i18n="კრედიტი">კრედიტი</th><th class="num" data-i18n="ნაშთი">ნაშთი</th></tr></thead>
      <tbody>${rows.map(r => `<tr><td class="mono">${dmy(r.e.date)}</td><td class="mono">${esc(r.e.doc)}</td>
        <td>${esc(r.e.typ)}</td><td>${esc(r.l.p)}</td><td class="mono">${esc(r.l.it)}</td>
        <td class="num">${r.l.dr ? f2(r.l.dr) : ''}</td><td class="num">${r.l.cr ? f2(r.l.cr) : ''}</td>
        <td class="num">${f2(r.bal)}</td></tr>`).join('')}</tbody></table></div>`
      : '<div class="msg" data-i18n="ამ ანგარიშზე ჩანაწერი არ არის.">ამ ანგარიშზე ჩანაწერი არ არის.</div>'}
  </div>`;
}

function datalists(org) {
  return `<datalist id="dl-acc" data-no-i18n>${org.coa.map(a => `<option value="${esc(a.c)}">${esc(a.n)}</option>`).join('')}</datalist>
  <datalist id="dl-p" data-no-i18n>${org.partners.map(p => `<option value="${esc(p.name)}">${esc(p.tin)}</option>`).join('')}</datalist>
  <datalist id="dl-i" data-no-i18n>${org.items.map(i => `<option value="${esc(i.code)}">${esc(i.name)}</option>`).join('')}</datalist>`;
}

/* ============================================================== BACKUP UI
   მონაცემები localStorage-შია — cache-ის გაწმენდა მათ შლის. ბანერი ერთადერთი
   ადგილია, სადაც ამას ვახსენებთ თავიდან; დანარჩენი მხოლოდ ექსპორტის შემდეგ
   ჩუმდება. ლოგიკა backup.js-შია, აქ მხოლოდ ხატვაა.                          */

/** გატარებების ჯამი ყველა ორგანიზაციაში — „ახალი გატარებების" სიგნალი. */
const totalEntries = () => store.all().reduce((n, o) => n + (o.entries ? o.entries.length : 0), 0);

/** ერთჯერადი შეტყობინება ხედის თავზე (თვის დახურვა და მისთანანი). */
let flash = null;

const MARTIVAD_URL = 'https://www.martivad.app/?utm_source=demo-app&utm_medium=bridge';
const martivadLink = (content, label) =>
  `<a href="${MARTIVAD_URL}&utm_content=${content}" target="_blank" rel="noopener">${label}</a>`;

function bannerHtml() {
  const parts = [];

  if (flash) {
    parts.push(`<div class="msg ${flash.cls}">${flash.html}</div>`);
  }

  const b = backup.bannerState(totalEntries());
  if (b && b.kind === 'first') {
    parts.push(`<div class="bnr info">
      <p class="txt">მონაცემები ინახება <b>მხოლოდ ამ ბრაუზერში</b>. რეგულარულად გადმოწერეთ სარეზერვო
        ასლი (ექსპორტი → JSON) — ბრაუზერის ისტორიის გაწმენდა მონაცემებს წაშლის.</p>
      <span class="acts">
        <button class="sm primary" data-act="bkexport" data-i18n="ექსპორტი">ექსპორტი</button>
        <button class="x" data-act="bkdismiss" title="დახურვა" aria-label="დახურვა">✕</button>
      </span></div>`);
  } else if (b && b.kind === 'stale') {
    const when = b.days === null || b.days === undefined
      ? 'ჯერ არ გაგიკეთებიათ სარეზერვო ასლი'
      : `ბოლო სარეზერვო ასლიდან ${b.days} დღე გავიდა`;
    parts.push(`<div class="bnr">
      <p class="txt"><b>${when}</b> — მას შემდეგ ${f0(b.added)} გატარება დაემატა. გადმოწერეთ ასლი,
        სანამ ბრაუზერი მონაცემებს გაასუფთავებს.</p>
      <span class="acts">
        <button class="sm primary" data-act="bkexport" data-i18n="ექსპორტი">ექსპორტი</button>
        <button class="x" data-act="bkdismiss" title="დახურვა" aria-label="დახურვა">✕</button>
      </span></div>`);
  }

  return parts.join('');
}

/** სრული სარეზერვო ასლი + ათვლის განულება. */
function doBackup() {
  download('martivad-backup.json', store.export(), 'application/json');
  backup.noteExport(totalEntries());
}

/* ================================================================ RENDER */
function render() {
  const org = store.active();
  const orgs = store.all();

  $('#orgbox').innerHTML = `
    ${orgs.length ? `<select id="orgSel">${orgs.map(o => `<option value="${o.id}" ${org && o.id === org.id ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select>` : ''}
    <span class="status ${status.cls}"><span class="dot"></span><span data-i18n="${esc(status.txt)}">${esc(status.txt)}</span></span>`;

  $('#tabs').innerHTML = Object.entries(TABS).map(([k, v]) =>
    `<button role="tab" data-tab="${k}" aria-selected="${tab === k}" ${!org && k !== 'org' ? 'disabled' : ''} data-i18n="${esc(v)}">${esc(v)}</button>`).join('');

  const bnr = $('#banner');
  if (bnr) bnr.innerHTML = bannerHtml();
  applyI18n(); // header, tab strip and banner are outside #view

  if (!org) { tab = 'org'; $('#view').innerHTML = vOrg(); applyI18n(); initRates(); return; }
  $('#view').innerHTML = tab === 'org' ? vOrg()
    : tab === 'journal' ? vJournal(org)
    : tab === 'upload' ? vUpload(org)
    : tab === 'imp' ? vImport(org) + datalists(org)
    : tab === 'ref' ? vRef(org)
    : vTB(org);

  // The views are rebuilt from template strings on every render, so the
  // translation has to be re-applied to the fresh nodes each time.
  applyI18n();

  // The rates card owns its own async state; render() only gives it a home.
  if (tab === 'org') initRates();
}

/* ================================================================ EVENTS */
document.addEventListener('input', ev => {
  const t = ev.target, org = store.active();
  if (impInput(t)) {
    render();
    // keep the caret where the accountant left it — the whole panel is redrawn
    const sel = t.dataset.impLine !== undefined
      ? document.querySelector(`[data-imp-line="${t.dataset.impLine}"][data-f="${t.dataset.f}"]`)
      : document.querySelector(`[data-imp="${t.dataset.imp}"]`);
    if (sel) { sel.focus(); try { sel.setSelectionRange(sel.value.length, sel.value.length); } catch (e) {} }
    return;
  }
  if (t.dataset.d) {
    if (t.dataset.d === 'tpl') return applyTpl(org, t.value);
    draft[t.dataset.d] = t.value;
    if (['desc', 'cmt', 'doc'].includes(t.dataset.d)) return;
    return render();
  }
  if (t.dataset.f2) { filter[t.dataset.f2] = t.value; return render(); }
  if (t.dataset.tb) {
    if (t.dataset.tb === 'card') cardAcc = t.value; else tbRange[t.dataset.tb] = t.value;
    return render();
  }
  if (t.dataset.i !== undefined && t.dataset.f) {
    const i = +t.dataset.i, f = t.dataset.f, l = draft.lines[i];
    l[f] = t.value;
    if (f === 'cur' && t.value === 'GEL') { l.fc = ''; l.rate = ''; }
    if ((f === 'fc' || f === 'rate') && l.cur !== 'GEL') {
      const fc = +l.fc || 0, r = +l.rate || 0;
      if (fc && r) {
        const g = round2(fc * r).toFixed(2);
        const toCr = l.cr ? true : (l.dr ? false : l.sd === 'c');
        if (toCr) { l.cr = g; l.dr = ''; } else { l.dr = g; l.cr = ''; }
      }
    }
    render();
    const sel = document.querySelector(`[data-i="${i}"][data-f="${f}"]`);
    if (sel) { sel.focus(); try { sel.setSelectionRange(sel.value.length, sel.value.length); } catch (e) {} }
  }
});

function impInput(t) {
  if (t.dataset.imp !== undefined) {
    const k = t.dataset.imp;
    impState[k] = t.type === 'checkbox' ? t.checked : t.value;
    impState.msg = null;
    return true;
  }
  if (t.dataset.impLine !== undefined) {
    const i = +t.dataset.impLine;
    if (impState.lines[i]) impState.lines[i][t.dataset.f] = t.value;
    impState.msg = null;
    return true;
  }
  return false;
}

document.addEventListener('change', async ev => {
  const t = ev.target, org = store.active();
  if (impInput(t)) return render();
  if (t.id === 'orgSel') { store.setActive(t.value); pending = null; draft = newDraft(); return render(); }
  if (t.id === 'fileIn' && t.files && t.files.length) { const fs = [...t.files]; t.value = ''; return handleFiles(org, fs); }
  if (t.id === 'impAll' && t.files && t.files[0]) {
    try { const n = store.import(await t.files[0].text()); setStatus('ok', `${tr('იმპორტი:')} ${n}`); }
    catch (e) { setStatus('err', 'იმპორტი ვერ მოხერხდა: ' + e.message); }
    t.value = ''; return render();
  }
  if (t.dataset.imp !== undefined && pending) {
    pending.entries[+t.dataset.imp]._on = t.checked;
    $('#impOut').innerHTML = impHtml(); return;
  }
  if (t.dataset.d === 'typ') { draft.typ = t.value; return render(); }
  if (t.dataset.f2 === 'm') { filter.m = t.value; return render(); }
});

document.addEventListener('click', async ev => {
  const b = ev.target.closest('[data-act],[data-tab]');
  if (!b) return;
  const org = store.active();
  // the flash is one-shot: any further interaction dismisses it
  if (b.dataset.tab || (b.dataset.act && b.dataset.act !== 'bkexport')) flash = null;
  if (b.dataset.tab) { tab = b.dataset.tab; pending = tab === 'upload' ? pending : null; return render(); }
  const a = b.dataset.act;

  /* ---- ორგანიზაცია ---- */
  if (a === 'neworg') {
    const name = $('#nOrg').value.trim(), tin = $('#nTin').value.trim();
    if (!name) { setStatus('err', 'დასახელება შეავსეთ'); return render(); }
    const o = blankOrg(name, tin, {
      vatPayer: $('#nVat').value === '1', vatRate: +$('#nRate').value || 18,
      periodFrom: $('#nFrom').value });
    store.add(o); tab = 'ref';
    setStatus('ok', `„${name}" შეიქმნა`); return render();
  }
  if (a === 'pick') { store.setActive(b.dataset.id); draft = newDraft(); pending = null; return render(); }
  if (a === 'delorg') {
    const o = store.all().find(x => x.id === b.dataset.id);
    if (o && confirm(`„${o.name}" და მისი ${o.entries.length} გატარება წაიშალოს?`)) {
      store.remove(b.dataset.id); setStatus('warn', 'წაიშალა'); return render();
    } return;
  }
  if (a === 'imp-add') { impState.lines.push({ name: '', qty: '', price: '' }); return render(); }
  if (a === 'imp-del') { impState.lines.splice(+b.dataset.i, 1); if (!impState.lines.length) impState.lines.push({ name: '', qty: '', price: '' }); return render(); }
  if (a === 'imp-csv') { download('importi-gaangarisheba.csv', impCsv(), 'text/csv'); return; }
  if (a === 'imp-post') { impPost(org); return render(); }
  if (a === 'expall') { doBackup(); return render(); }
  if (a === 'bkexport') { doBackup(); return render(); }
  if (a === 'bkdismiss') { backup.snooze(); backup.markSeen(); flash = null; return render(); }

  if (!org) return;

  /* ---- გატარება ---- */
  if (a === 'addline') { draft.lines.push(line()); return render(); }
  if (a === 'delline') { draft.lines.splice(+b.dataset.i, 1); if (!draft.lines.length) draft.lines.push(line()); return render(); }
  if (a === 'clear') { draft = newDraft(); return render(); }
  if (a === 'save') {
    const v = validate(org, draft); if (v.errs.length) return;
    const lines = draft.lines.filter(l => l.acc && (l.dr || l.cr)).map(({ sd, ...l }) => ({
      ...l, dr: l.dr ? round2(l.dr) : '', cr: l.cr ? round2(l.cr) : '' }));
    lines.forEach(l => { if (l.p) ensurePartner(org, l.p); if (l.it) ensureItem(org, l.it); });
    addEntry(org, { date: draft.date, doc: draft.doc, typ: draft.typ,
      desc: draft.desc.trim(), cmt: draft.cmt.trim(), op: '', lines });
    store.save(); draft = newDraft();
    setStatus('ok', 'გატარება შენახულია'); return render();
  }
  if (a === 'toggle' && !ev.target.closest('[data-act="del"]')) { const n = b.dataset.no; open[n] = !open[n]; return render(); }
  if (a === 'del') {
    ev.stopPropagation();
    if (confirm('გატარება წაიშალოს?')) {
      org.entries = org.entries.filter(e => String(e.no) !== b.dataset.no);
      store.save(); setStatus('warn', 'წაიშალა'); return render();
    } return;
  }
  if (a === 'csv') return download(`${org.name}-gatarebebi.csv`, csv(org), 'text/csv');
  if (a === 'json') return download(`${org.name}.json`, JSON.stringify(org, null, 1), 'application/json');
  if (a === 'tbcsv') {
    const A = accMap(org), t = trialBalance(org, tbRange.from, tbRange.to);
    const rows = [['ანგარიში', 'დასახელება', 'ბრუნვა დებეტი', 'ბრუნვა კრედიტი', 'ნაშთი დებეტი', 'ნაშთი კრედიტი']];
    [...t.keys()].sort().forEach(c => { const v = t.get(c), bal = v.dr - v.cr;
      rows.push([c, (A.get(c) || {}).n || '', v.dr, v.cr, bal > 0 ? bal : '', bal < 0 ? -bal : '']); });
    return download(`${org.name}-brunviti.csv`, '﻿' + rows.map(r => r.join(';')).join('\r\n'), 'text/csv');
  }

  /* ---- ცნობარები ---- */
  if (a === 'addacc') {
    const iban = $('#bIban').value.trim(), code = $('#bCode').value.trim(), ccy = $('#bCcy').value;
    if (!code) { setStatus('err', 'ანგარიშის კოდი შეავსეთ'); return render(); }
    org.rules.accounts.push({ iban, ccy, code }); store.save(); setStatus('ok', 'დაემატა'); return render();
  }
  if (a === 'delacc') { org.rules.accounts.splice(+b.dataset.i, 1); store.save(); return render(); }
  if (a === 'addp') {
    const name = $('#pName').value.trim(); if (!name) return;
    const tin = $('#pTin').value.trim(), role = $('#pRole').value;
    ensurePartner(org, name, tin, role);
    if (tin) { if (role === 'მყიდველი') org.rules.customers[tin] = name;
               else org.rules.suppliers[tin] = { name, acc: '3110-001' }; }
    store.save(); setStatus('ok', 'დაემატა'); return render();
  }
  if (a === 'delp') { org.partners.splice(+b.dataset.i, 1); store.save(); return render(); }
  if (a === 'addi') {
    const code = $('#iCode').value.trim(); if (!code) return;
    ensureItem(org, code, $('#iName').value.trim(), $('#iUnit').value.trim());
    store.save(); setStatus('ok', 'დაემატა'); return render();
  }
  if (a === 'deli') { org.items.splice(+b.dataset.i, 1); store.save(); return render(); }

  /* ---- იმპორტი ---- */
  if (a === 'impall' || a === 'impnone') { if (pending) { pending.entries.forEach(e => e._on = a === 'impall'); render(); } return; }
  if (a === 'impcancel') { pending = null; setStatus('', 'ატვირთვა გაუქმდა'); return render(); }
  if (a === 'impsave' && pending) return commit(org);
  if (a === 'closemonth') {
    const months = [...new Set(org.entries.filter(e => e.typ === 'რეალიზაცია').map(e => e.date.slice(0, 7)))].sort();
    if (!months.length) { setStatus('err', 'ჟურნალში რეალიზაცია არ არის'); return render(); }
    const m = prompt('რომელი თვე დაიხუროს? (YYYY-MM)', months[months.length - 1]);
    if (!m) return;
    const res = closeMonth(org, m.trim());
    if (!res.entries.length) { setStatus('warn', m + ': ახალი ჩამოსაწერი არაფერია'); return render(); }
    pending = { kind: `თვითღირებულება ${m}`, entries: res.entries.map(e => ({ ...e, _on: true })),
      info: [`${res.entries.length} ზედნადები`],
      warn: res.short.length ? ['ნაშთი არ ჰყოფნის: ' + res.short.slice(0, 6).join('; ')] : [] };
    setStatus('', `${m}: ${res.entries.length} ჩამოწერა მზადაა`); return render();
  }
});

/* ---------------------------------------------------------------- import flow */
async function handleFiles(org, files) {
  pending = null; setStatus('warn', 'ფაილი მუშავდება…'); render();
  const wbs = [];
  for (const f of files) {
    try { wbs.push(await SR.read(f)); }
    catch (e) { setStatus('err', `${f.name}: ${e.message}`); return render(); }
  }
  const isSales = wbs.some(w => w.sheets.some(sh => sh.rows.slice(0, 10).some(r => String(r[0] || '').trim() === 'საქონლის კოდი')));
  const isBank = wbs.some(w => w.sheets.some(sh => sh.rows.slice(0, 40).some(r => String(r[0] || '').trim() === 'თარიღი')));
  try {
    if (isBank) {
      const res = importBank(wbs, org);
      if (res.error) { setStatus('err', res.error); return render(); }
      pending = { kind: 'ამონაწერი', entries: res.entries.map(e => ({ ...e, _on: true })),
        unmapped: res.unmapped, newParties: res.newParties, newLoans: res.newLoans,
        info: res.stmts.map(x => `${x.ccy} · ${x.period} · ${x.rows} ოპერაცია`), warn: [] };
    } else if (isSales) {
      const res = importSales(wbs, org);
      if (res.error) { setStatus('err', res.error); return render(); }
      pending = { kind: 'რეალიზაცია', entries: res.entries.map(e => ({ ...e, _on: true })),
        unmapped: [], newParties: res.newParties, newItems: res.newItems,
        info: [`${res.docs} ზედნადები`], warn: [] };
    } else { setStatus('err', 'ფაილის ტიპი ვერ ვიცანი'); return render(); }
  } catch (e) { setStatus('err', 'დამუშავების შეცდომა: ' + e.message); return render(); }
  setStatus('', `${files.map(f => f.name).join(', ')} — ${pending.entries.length} გატარება მზადაა`);
  render();
}

function commit(org) {
  const reg = document.getElementById('regParties');
  if (reg && reg.checked) {
    (pending.newParties || []).forEach(x => {
      ensurePartner(org, x.name, x.tin, x.side);
      if (x.side === 'მყიდველი') org.rules.customers[x.tin] = x.name;
      else if (!org.rules.suppliers[x.tin]) org.rules.suppliers[x.tin] = { name: x.name, acc: '3110-001' };
    });
    (pending.newItems || []).forEach(i => ensureItem(org, i.code, i.name, i.unit));
    Object.entries(pending.newLoans || {}).forEach(([doc, code]) => { org.rules.loans[doc] = code; });
  }
  let n = 0;
  for (const e of pending.entries.filter(x => x._on)) {
    const lines = e.lines.filter(l => l.acc && (l.dr || l.cr));
    const d = lines.reduce((s, l) => s + (+l.dr || 0), 0), c = lines.reduce((s, l) => s + (+l.cr || 0), 0);
    if (!lines.length || Math.abs(d - c) > 0.004) continue;
    lines.forEach(l => { if (l.p) ensurePartner(org, l.p); if (l.it) ensureItem(org, l.it); });
    addEntry(org, { date: e.date, doc: e.doc, typ: e.typ, desc: e.desc, cmt: e.cmt || '', op: e.op || '', lines });
    n++;
  }
  const label = pending.kind;
  const wasMonthClose = /^თვითღირებულება/.test(label);
  pending = null; store.save();
  setStatus('ok', `${label}: დაემატა ${n} გატარება`);

  if (wasMonthClose) {
    // თვის დახურვა ბუნებრივი გაჩერების წერტილია — ერთადერთი ადგილი (footer-ის
    // გარდა), სადაც Martivad-ზე ბმული ჩნდება. popup არ არის, ფუნქცია არ იბლოკება.
    flash = { cls: 'ok', html:
      `<b>${esc(label)}: დაემატა ${n} გატარება.</b> გირჩევთ ასლის გადმოწერას — თვის დახურვის შემდეგ
       ეს საუკეთესო მომენტია.
       <span class="after">მრავალმომხმარებლიანი მუშაობა და ავტომატური გატარებები POS-იდან —
         ${martivadLink('month-close', 'Martivad.app-ში')}</span>
       <div class="inline-act">
         <button class="sm primary" data-act="bkexport" data-i18n="სარეზერვო ასლის გადმოწერა">სარეზერვო ასლის გადმოწერა</button>
       </div>` };
  }
  render();
}

function applyTpl(org, k) {
  const t = TPL[k] || TPL[''];
  draft.tpl = k;
  if (t.typ) draft.typ = t.typ;
  if (t.d && !draft.desc) draft.desc = t.d;
  draft.lines = (t.f ? t.f(org) : t.lines.map(l => ({ ...l })));
  render();
}

/* ტესტისთვის: martivadBackup.rewind(8) — ბოლო ექსპორტი 8 დღით უკან; .reset() — განულება */
window.martivadBackup = backup;

document.addEventListener('martivad:langchange', () => render());

render();
