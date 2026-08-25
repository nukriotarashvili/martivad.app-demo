/* ============================================================================
   app.js — ინტერფეისი. ჩანართები: ორგანიზაცია · გატარებები · ატვირთვა ·
            ცნობარები · უწყისი
   ========================================================================== */
import SR from './sheetread.js';
import { store, blankOrg, accMap, addEntry, ensurePartner, ensureItem, trialBalance } from './store.js';
import { importBank, importSales, closeMonth } from './importers.js';

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
               ref: 'ცნობარები', tb: 'უწყისი' };

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
  <div class="card">
    <h2>ორგანიზაციები</h2>
    <p class="note">ერთ ბრაუზერში რამდენიმე ორგანიზაციის წარმოება შეიძლება. მონაცემები ინახება მხოლოდ
      ამ მოწყობილობაზე — სერვერზე არაფერი იგზავნება. სარეზერვო ასლისთვის გამოიყენეთ ექსპორტი.</p>
    ${orgs.length ? `<div class="tw"><table>
      <thead><tr><th>დასახელება</th><th>ს/ნ</th><th>დღგ</th><th class="num">გატარება</th><th>შექმნილია</th><th></th></tr></thead>
      <tbody>${orgs.map(o => `<tr>
        <td><b>${esc(o.name)}</b>${o.id === (org && org.id) ? ' <span class="pill ok">აქტიური</span>' : ''}</td>
        <td class="mono">${esc(o.tin)}</td>
        <td>${o.settings.vatPayer ? o.settings.vatRate + '%' : '—'}</td>
        <td class="num">${o.entries.length}</td>
        <td class="mono">${dmy(o.created)}</td>
        <td style="text-align:right">
          ${o.id === (org && org.id) ? '' : `<button class="sm" data-act="pick" data-id="${o.id}">გახსნა</button>`}
          <button class="ghost sm" data-act="delorg" data-id="${o.id}">✕</button></td></tr>`).join('')}
      </tbody></table></div>` : `
    <div class="empty"><h3>ჯერ არცერთი ორგანიზაცია არ არის</h3>
      <p>დაიწყეთ ახლის შექმნით — ანგარიშთა გეგმა (114 ანგარიში, საქართველოს სტანდარტი) ავტომატურად ჩაიტვირთება.</p></div>`}
  </div>

  <div class="card">
    <h2>ახალი ორგანიზაცია</h2>
    <p class="note">დასახელება და საიდენტიფიკაციო კოდი აუცილებელია; დანარჩენი შემდეგაც შეიცვლება.</p>
    <div class="row r4">
      <div style="grid-column:span 2"><label>დასახელება</label><input id="nOrg" placeholder="შპს „..."></div>
      <div><label>საიდენტიფიკაციო კოდი</label><input id="nTin" class="mono" placeholder="9 ციფრი"></div>
      <div><label>საანგარიშო წლის დასაწყისი</label><input id="nFrom" type="date" value="${new Date().getFullYear()}-01-01"></div>
    </div>
    <div class="row r3">
      <div><label>დღგ-ს გადამხდელი</label>
        <select id="nVat"><option value="1">კი</option><option value="0">არა</option></select></div>
      <div><label>დღგ-ს განაკვეთი, %</label><input id="nRate" class="num" value="18"></div>
      <div><label>საბაზისო ვალუტა</label><input value="GEL (ლარი)" disabled></div>
    </div>
    <div class="actions">
      <button class="primary" data-act="neworg">ორგანიზაციის შექმნა</button>
      <span class="spacer"></span>
      <button class="sm" data-act="expall">ყველაფრის ექსპორტი (JSON)</button>
      <label style="text-transform:none;letter-spacing:0;font-weight:600;font-size:13px;margin:0;display:inline-flex;align-items:center;gap:8px">
        იმპორტი: <input type="file" id="impAll" accept=".json" style="width:auto"></label>
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
     <td style="width:88px"><input value="${esc(l.qty)}" data-i="${i}" data-f="qty" class="num" placeholder="—"></td>
     <td style="width:74px"><select data-i="${i}" data-f="cur">${['GEL', 'USD', 'EUR', 'RUB'].map(c => `<option ${l.cur === c ? 'selected' : ''}>${c}</option>`).join('')}</select></td>
     <td style="width:110px"><input value="${esc(l.fc)}" data-i="${i}" data-f="fc" class="num" placeholder="—" ${l.cur === 'GEL' ? 'disabled' : ''}></td>
     <td style="width:96px"><input value="${esc(l.rate)}" data-i="${i}" data-f="rate" class="num" placeholder="—" ${l.cur === 'GEL' ? 'disabled' : ''}></td>
     <td style="width:118px"><input value="${esc(l.dr)}" data-i="${i}" data-f="dr" class="num" placeholder="0.00"></td>
     <td style="width:118px"><input value="${esc(l.cr)}" data-i="${i}" data-f="cr" class="num" placeholder="0.00"></td>
     <td style="width:30px"><button class="ghost" data-act="delline" data-i="${i}" title="ხაზის წაშლა">✕</button></td></tr>`;
  };

  return `
  <div class="card">
    <h2>ახალი გატარება</h2>
    <p class="note">შენახვა შესაძლებელია მხოლოდ მაშინ, როცა დებეტი კრედიტს უტოლდება და ყველა სავალდებულო ველი შევსებულია.</p>
    <div class="row r4">
      <div><label>თარიღი</label><input type="date" value="${esc(draft.date)}" data-d="date"></div>
      <div><label>დოკუმენტი</label><input value="${esc(draft.doc)}" data-d="doc" placeholder="ს/ფ, დეკლარაცია, დავალება"></div>
      <div><label>ოპერაციის ტიპი</label><select data-d="typ">${TYPES.map(t => `<option ${draft.typ === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>
      <div><label>შაბლონი</label><select data-d="tpl">${Object.entries(TPL).map(([k, t]) => `<option value="${k}" ${draft.tpl === k ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select></div>
    </div>
    <div class="row r1"><div><label>შინაარსი</label><input value="${esc(draft.desc)}" data-d="desc" placeholder="რას ასახავს გატარება"></div></div>
    <div class="row r1"><div><label>კომენტარი</label><input value="${esc(draft.cmt)}" data-d="cmt" placeholder="გაანგარიშება, დოკუმენტის დეტალები, სტანდარტის მუხლი"></div></div>
    <div class="tw"><table class="lines">
      <thead><tr><th></th><th>ანგარიში</th><th>პარტნიორი</th><th>საქონელი</th><th class="num">რაოდ.</th>
        <th>ვალუტა</th><th class="num">თანხა ვალ.</th><th class="num">კურსი</th><th class="num">დებეტი</th><th class="num">კრედიტი</th><th></th></tr></thead>
      <tbody>${draft.lines.map(lineRow).join('')}</tbody>
      <tfoot><tr class="tot"><td colspan="8">სულ</td><td class="num">${f2(v.dr)}</td><td class="num">${f2(v.cr)}</td><td></td></tr></tfoot>
    </table></div>
    <div class="actions">
      <button data-act="addline" class="sm">+ ხაზის დამატება</button>
      <span class="pill ${!touched ? '' : (v.errs.length ? 'err' : 'ok')}">${!touched ? 'ცარიელი ფორმა' : (v.errs.length ? 'ვერ ბალანსდება' : 'ბალანსდება — ' + f2(v.dr) + ' ₾')}</span>
      <span class="spacer"></span>
      <button data-act="clear" class="sm">გასუფთავება</button>
      <button data-act="save" class="primary" ${v.errs.length ? 'disabled' : ''}>გატარების შენახვა</button>
    </div>
    ${touched && v.errs.length ? `<div class="msg err"><b>შესამოწმებელია:</b><ul>${v.errs.map(e => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}
  </div>

  <div class="card">
    <h2>ჟურნალი</h2>
    <div class="filters">
      <div><label>თვე</label><select data-f2="m"><option value="">ყველა</option>${months.map(m => `<option value="${m}" ${filter.m === m ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
      <div><label>ანგარიში (პრეფიქსი)</label><input value="${esc(filter.acc)}" data-f2="acc" class="mono" placeholder="მაგ. 1410"></div>
      <div><label>პარტნიორი</label><input list="dl-p" value="${esc(filter.p)}" data-f2="p" placeholder="ყველა"></div>
      <div style="flex:1;text-align:right;min-width:140px"><label>ნაჩვენები ბრუნვა</label>
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
          <thead><tr><th>ანგარიში</th><th>პარტნიორი</th><th>საქონელი</th><th class="num">რაოდ.</th><th>ვალ.</th>
            <th class="num">თანხა ვალ.</th><th class="num">კურსი</th><th class="num">დებეტი</th><th class="num">კრედიტი</th></tr></thead>
          <tbody>${e.lines.map(l => `<tr><td class="mono">${esc(l.acc)}<div class="hint">${esc((A.get(l.acc) || {}).n || '')}</div></td>
            <td>${esc(l.p)}</td><td class="mono">${esc(l.it)}</td><td class="num">${esc(l.qty)}</td><td>${esc(l.cur)}</td>
            <td class="num">${l.fc ? f2(l.fc) : ''}</td><td class="num">${esc(l.rate)}</td>
            <td class="num">${l.dr ? f2(l.dr) : ''}</td><td class="num">${l.cr ? f2(l.cr) : ''}</td></tr>`).join('')}</tbody>
        </table></div>${e.cmt ? `<div class="hint" style="margin-top:8px">${esc(e.cmt)}</div>` : ''}</div>` : ''}
      </div>`; }).join('') : '<div class="msg">ჯერ არცერთი გატარება არ არის შენახული.</div>'}
    <div class="actions">
      <button data-act="csv" class="sm">CSV ჩამოტვირთვა</button>
      <button data-act="json" class="sm">JSON ჩამოტვირთვა</button>
    </div>
  </div>${datalists(org)}`;
}

function vUpload(org) {
  const noAcc = !org.rules.accounts.length;
  return `
  <div class="card">
    <h2>დოკუმენტის ატვირთვა</h2>
    <p class="note">საბანკო ამონაწერი (.xlsx) და rs.ge-ს რეალიზაციის რეპორტი (.xls / .xlsx / .csv).
      ფაილი ბრაუზერშივე იშიფრება — არსად არ იგზავნება. ერთდროულად რამდენიმე ფაილიც შეიძლება.</p>
    ${noAcc ? `<div class="msg warn">საბანკო ამონაწერის ასატვირთად ჯერ დაამატეთ ანგარიში:
      <b>ცნობარები → საბანკო ანგარიშები</b> (IBAN, ვალუტა და ბუღალტრული კოდი).</div>` : ''}
    <div class="actions">
      <input type="file" id="fileIn" multiple accept=".xlsx,.xls,.csv" style="width:auto">
      <span class="spacer"></span>
      <button data-act="closemonth" class="sm">თვის დახურვა — თვითღირებულება</button>
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
    <thead><tr><th style="width:26px"></th><th>თარიღი</th><th>დოკუმენტი</th><th>ტიპი</th><th>შინაარსი</th>
      <th>ანგარიშები</th><th class="num">თანხა</th></tr></thead>
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
    <button data-act="impall" class="sm">ყველას მონიშვნა</button>
    <button data-act="impnone" class="sm">მონიშვნის მოხსნა</button>
    <span class="spacer"></span>
    <button data-act="impcancel" class="sm">გაუქმება</button>
    <button data-act="impsave" class="primary" ${on.length ? '' : 'disabled'}>ჟურნალში დამატება (${on.length})</button>
  </div>`;
}

function vRef(org) {
  return `
  <div class="grid2">
    <div class="card" style="margin-top:0">
      <h2>საბანკო ანგარიშები</h2>
      <p class="note">ამონაწერის ამოსაცნობად: IBAN, ვალუტა და ბუღალტრული ანგარიშის კოდი.</p>
      <div class="tw"><table><thead><tr><th>IBAN</th><th>ვალუტა</th><th>ანგარიში</th><th></th></tr></thead>
        <tbody>${org.rules.accounts.map((a, i) => `<tr><td class="mono">${esc(a.iban)}</td><td>${esc(a.ccy)}</td>
          <td class="mono">${esc(a.code)}</td><td style="text-align:right"><button class="ghost sm" data-act="delacc" data-i="${i}">✕</button></td></tr>`).join('')
          || '<tr><td colspan="4" class="hint">ჯერ არაფერია</td></tr>'}</tbody></table></div>
      <div class="row r3" style="margin-top:12px">
        <div><label>IBAN</label><input id="bIban" class="mono" placeholder="GE00XX..."></div>
        <div><label>ვალუტა</label><select id="bCcy"><option>GEL</option><option>USD</option><option>EUR</option><option>RUB</option></select></div>
        <div><label>ანგარიში</label><input id="bCode" list="dl-acc" class="mono" placeholder="1210-001"></div>
      </div>
      <div class="actions"><button data-act="addacc" class="sm">დამატება</button></div>
    </div>

    <div class="card" style="margin-top:0">
      <h2>პარტნიორები</h2>
      <p class="note">მყიდველები და მომწოდებლები. იმპორტისას ავტომატურადაც ემატება.</p>
      <div class="tw tall"><table><thead><tr><th>დასახელება</th><th>ს/ნ</th><th>როლი</th><th></th></tr></thead>
        <tbody>${org.partners.map((p, i) => `<tr><td>${esc(p.name)}</td><td class="mono">${esc(p.tin)}</td>
          <td>${esc(p.role)}</td><td style="text-align:right"><button class="ghost sm" data-act="delp" data-i="${i}">✕</button></td></tr>`).join('')
          || '<tr><td colspan="4" class="hint">ჯერ არაფერია</td></tr>'}</tbody></table></div>
      <div class="row r3" style="margin-top:12px">
        <div><label>დასახელება</label><input id="pName"></div>
        <div><label>ს/ნ</label><input id="pTin" class="mono"></div>
        <div><label>როლი</label><select id="pRole"><option>მყიდველი</option><option>მომწოდებელი</option><option>სხვა</option></select></div>
      </div>
      <div class="actions"><button data-act="addp" class="sm">დამატება</button></div>
    </div>

    <div class="card" style="margin-top:0">
      <h2>საქონელი</h2>
      <p class="note">კოდი (შტრიხკოდი ან შიდა), დასახელება და ზომის ერთეული.</p>
      <div class="tw tall"><table><thead><tr><th>კოდი</th><th>დასახელება</th><th>ერთ.</th><th></th></tr></thead>
        <tbody>${org.items.map((it, i) => `<tr><td class="mono">${esc(it.code)}</td><td>${esc(it.name)}</td>
          <td>${esc(it.unit)}</td><td style="text-align:right"><button class="ghost sm" data-act="deli" data-i="${i}">✕</button></td></tr>`).join('')
          || '<tr><td colspan="4" class="hint">ჯერ არაფერია</td></tr>'}</tbody></table></div>
      <div class="row r3" style="margin-top:12px">
        <div><label>კოდი</label><input id="iCode" class="mono"></div>
        <div><label>დასახელება</label><input id="iName"></div>
        <div><label>ერთეული</label><input id="iUnit" placeholder="ცალი / კგ"></div>
      </div>
      <div class="actions"><button data-act="addi" class="sm">დამატება</button></div>
    </div>

    <div class="card" style="margin-top:0">
      <h2>ანგარიშთა გეგმა</h2>
      <p class="note">საქართველოს სტანდარტი, ${org.coa.length} ანგარიში. „პ" — პარტნიორი სავალდებულოა, „ს" — საქონლის კოდი.</p>
      <div class="tw tall"><table><thead><tr><th>კოდი</th><th>დასახელება</th><th>ჯგუფი</th><th>პ</th><th>ს</th></tr></thead>
        <tbody>${org.coa.map(a => `<tr><td class="mono">${esc(a.c)}</td><td>${esc(a.n)}</td>
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
    <div class="cell"><span class="code">6xxx</span><div class="k">შემოსავალი</div><div class="v">${f0(rev)}</div></div>
    <div class="cell"><span class="code">7xxx</span><div class="k">ხარჯი</div><div class="v">${f0(cogs)}</div></div>
    <div class="cell"><span class="code">6−7</span><div class="k">შედეგი</div><div class="v">${f0(rev - cogs)}</div></div>
    <div class="cell"><span class="code">1410</span><div class="k">დებიტორები</div><div class="v">${f0(recv)}</div></div>
    <div class="cell"><span class="code">12xx</span><div class="k">ფული</div><div class="v">${f0(cash)}</div></div>
    <div class="cell"><span class="code">3110</span><div class="k">კრედიტორები</div><div class="v">${f0(pay)}</div></div>
  </div>

  <div class="card">
    <h2>ბრუნვითი უწყისი</h2>
    <p class="note">პერიოდის ბრუნვა და ნაშთი ანგარიშების ჭრილში. საწყისი ნაშთი ჟურნალის გატარებებიდან ითვლება.</p>
    <div class="filters">
      <div><label>დან</label><input type="date" value="${tbRange.from}" data-tb="from"></div>
      <div><label>მდე</label><input type="date" value="${tbRange.to}" data-tb="to"></div>
      <div style="min-width:200px"><label>ანგარიშის ბარათი</label>
        <input list="dl-acc" value="${esc(cardAcc)}" data-tb="card" class="mono" placeholder="მაგ. 1410-001"></div>
      <div style="flex:1;text-align:right"><label>საქონლის ნაშთი</label>
        <div class="mono" style="font-size:16px">${f2(stock)} ₾</div></div>
    </div>
    ${codes.length ? `<div class="tw tall"><table>
      <thead><tr><th>ანგარიში</th><th>დასახელება</th><th class="num">ბრუნვა დტ</th><th class="num">ბრუნვა კტ</th>
        <th class="num">ნაშთი დტ</th><th class="num">ნაშთი კტ</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td colspan="2">ჯამი</td><td class="num">${f2(tdr)}</td><td class="num">${f2(tcr)}</td>
        <td class="num" colspan="2">${Math.abs(tdr - tcr) < 0.005 ? '<span class="pill ok">ბალანსდება</span>' : '<span class="pill err">სხვაობა ' + f2(tdr - tcr) + '</span>'}</td></tr></tfoot>
    </table></div>` : '<div class="msg">ჟურნალი ცარიელია.</div>'}
    <div class="actions"><button data-act="tbcsv" class="sm">უწყისის CSV</button></div>
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
      <thead><tr><th>თარიღი</th><th>დოკუმენტი</th><th>ოპერაცია</th><th>პარტნიორი</th><th>საქონელი</th>
        <th class="num">დებეტი</th><th class="num">კრედიტი</th><th class="num">ნაშთი</th></tr></thead>
      <tbody>${rows.map(r => `<tr><td class="mono">${dmy(r.e.date)}</td><td class="mono">${esc(r.e.doc)}</td>
        <td>${esc(r.e.typ)}</td><td>${esc(r.l.p)}</td><td class="mono">${esc(r.l.it)}</td>
        <td class="num">${r.l.dr ? f2(r.l.dr) : ''}</td><td class="num">${r.l.cr ? f2(r.l.cr) : ''}</td>
        <td class="num">${f2(r.bal)}</td></tr>`).join('')}</tbody></table></div>`
      : '<div class="msg">ამ ანგარიშზე ჩანაწერი არ არის.</div>'}
  </div>`;
}

function datalists(org) {
  return `<datalist id="dl-acc">${org.coa.map(a => `<option value="${esc(a.c)}">${esc(a.n)}</option>`).join('')}</datalist>
  <datalist id="dl-p">${org.partners.map(p => `<option value="${esc(p.name)}">${esc(p.tin)}</option>`).join('')}</datalist>
  <datalist id="dl-i">${org.items.map(i => `<option value="${esc(i.code)}">${esc(i.name)}</option>`).join('')}</datalist>`;
}

/* ================================================================ RENDER */
function render() {
  const org = store.active();
  const orgs = store.all();

  $('#orgbox').innerHTML = `
    ${orgs.length ? `<select id="orgSel">${orgs.map(o => `<option value="${o.id}" ${org && o.id === org.id ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select>` : ''}
    <span class="status ${status.cls}"><span class="dot"></span>${esc(status.txt)}</span>`;

  $('#tabs').innerHTML = Object.entries(TABS).map(([k, v]) =>
    `<button role="tab" data-tab="${k}" aria-selected="${tab === k}" ${!org && k !== 'org' ? 'disabled' : ''}>${esc(v)}</button>`).join('');

  if (!org) { tab = 'org'; $('#view').innerHTML = vOrg(); return; }
  $('#view').innerHTML = tab === 'org' ? vOrg()
    : tab === 'journal' ? vJournal(org)
    : tab === 'upload' ? vUpload(org)
    : tab === 'ref' ? vRef(org)
    : vTB(org);
}

/* ================================================================ EVENTS */
document.addEventListener('input', ev => {
  const t = ev.target, org = store.active();
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

document.addEventListener('change', async ev => {
  const t = ev.target, org = store.active();
  if (t.id === 'orgSel') { store.setActive(t.value); pending = null; draft = newDraft(); return render(); }
  if (t.id === 'fileIn' && t.files && t.files.length) { const fs = [...t.files]; t.value = ''; return handleFiles(org, fs); }
  if (t.id === 'impAll' && t.files && t.files[0]) {
    try { const n = store.import(await t.files[0].text()); setStatus('ok', `იმპორტი: ${n} ორგანიზაცია`); }
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
  if (a === 'expall') { download('martivad-backup.json', store.export(), 'application/json'); return; }

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
  pending = null; store.save();
  setStatus('ok', `${label}: დაემატა ${n} გატარება`);
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

render();
