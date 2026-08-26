// © შპს მარტივადი — Elastic License 2.0 (იხ. LICENSE)
/* ============================================================================
   importers.js — საბანკო ამონაწერი და rs.ge-ს რეალიზაციის რეპორტი → გატარებები.
   ყველა წესი ორგანიზაციის პროფილიდან იკითხება (org.rules, org.settings).
   ========================================================================== */

const txt = v => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim();
const num = v => { const n = +v; return isFinite(n) ? Math.round(n * 100) / 100 : 0; };
const r2 = v => Math.round((v + Number.EPSILON) * 100) / 100;
const iso = v => {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = txt(v);
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{2})[./](\d{2})[./](\d{4})/); if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return '';
};

/* ---------------------------------------------------------------- ამონაწერი */
function readStatement(sheet, rules) {
  const rows = sheet.rows;
  let h = -1;
  for (let i = 0; i < Math.min(rows.length, 40); i++) if (txt(rows[i][0]) === 'თარიღი') { h = i; break; }
  if (h < 0) return null;
  const hdr = rows[h].map(txt);
  const meta = {};
  for (let i = 0; i < h; i++) {
    const k = txt(rows[i][1]).replace(/:$/, '').trim();
    if (k) meta[k] = rows[i][2];
  }
  const out = [];
  for (let i = h + 1; i < rows.length; i++) {
    const r = rows[i]; if (!r || !r[0]) continue;
    const o = {}; hdr.forEach((k, c) => { if (k) o[k] = r[c]; });
    if (o['თარიღი']) out.push(o);
  }
  let ccy = txt(meta['ვალუტა']) || 'GEL';
  if (ccy === 'RUR') ccy = 'RUB';
  const iban = txt(meta['ანგარიში']).match(/GE\w+/);
  const byIban = iban && rules.accounts.find(a => a.iban === iban[0]);
  const byCcy = rules.accounts.find(a => a.ccy === ccy);
  return { meta, rows: out, ccy, iban: iban ? iban[0] : '', acc: (byIban || byCcy || {}).code || null };
}

const isConv = row => {
  const t = txt(row['ოპერაციის ტიპი']);
  const blob = txt(row['დანიშნულება']) + ' ' + txt(row['ოპერაციის შინაარსი']);
  return ['CCO', 'ALR', 'CLN'].includes(t) && /კონვერტაცია|გაცვლ|ხაზინას/.test(blob);
};
function convInfo(row) {
  const t = txt(row['ოპერაციის შინაარსი']) + ' ' + txt(row['დანიშნულება']);
  const mr = t.match(/კურსი\s*:?\s*([\d.]+)/);
  const ma = t.match(/კონტრთანხა\s*:\s*([A-Z]{3})\s*([\d,]+(?:\.\d+)?)/);
  return { rate: mr ? parseFloat(mr[1].replace(/\.$/, '')) : null,
           ccy: ma ? ma[1] : null, amt: ma ? parseFloat(ma[2].replace(/,/g, '')) : null };
}

/* ---------------------------------------------------------------- იმპორტი */
export function importBank(wbs, org) {
  const rules = org.rules;
  const entries = [], unmapped = [], newParties = [], convSeen = new Set();
  const seen = new Set(org.entries.map(e => e.op).filter(Boolean));
  const ibanTo = {}; rules.accounts.forEach(a => { if (a.iban) ibanTo[a.iban] = a.code; });

  const stmts = [];
  for (const wb of wbs) for (const sh of wb.sheets) {
    const st = readStatement(sh, rules);
    if (st && st.rows.length) stmts.push(st);
  }
  if (!stmts.length) return { entries, unmapped, newParties, stmts: [], error: 'ამონაწერის სტრუქტურა ვერ ამოვიცანი' };
  const noAcc = stmts.filter(s => !s.acc);
  if (noAcc.length) return { entries, unmapped, newParties, stmts: [],
    error: `საბანკო ანგარიში ცნობარში არ არის: ${noAcc.map(s => s.iban + ' (' + s.ccy + ')').join(', ')} — დაამატეთ „ცნობარები → საბანკო ანგარიშები"` };

  /* მოძრავი საშუალო კურსის საწყისი ნაშთი ჟურნალიდან */
  const fx = {};
  for (const e of org.entries) for (const l of e.lines || []) {
    const a = rules.accounts.find(x => x.code === l.acc && x.ccy !== 'GEL');
    if (!a) continue;
    const b = fx[l.acc] || (fx[l.acc] = { fc: 0, gel: 0 });
    const sg = l.dr ? 1 : -1;
    b.fc += sg * (+l.fc || 0); b.gel += sg * (+(l.dr || l.cr) || 0);
  }

  /* უცნობი სესხისთვის თავისუფალი 3210-00N */
  const newLoans = {};
  const usedLoan = new Set([...Object.values(rules.loans), ...Object.keys(newLoans)]);
  const loanFor = doc => {
    if (rules.loans[doc]) return rules.loans[doc];
    if (newLoans[doc]) return newLoans[doc];
    let n = 1, code;
    do { code = '3210-' + String(n++).padStart(3, '0'); } while (usedLoan.has(code));
    usedLoan.add(code); newLoans[doc] = code; return code;
  };

  const findParty = row => {
    const tin = txt(row['მიმღების საიდენტიფიკაციო კოდი']) || txt(row['გამგზავნის საიდენტიფიკაციო კოდი']);
    const blob = txt(row['მიმღების დასახელება']) + ' ' + txt(row['გამგზავნის დასახელება']);
    if (tin && rules.suppliers[tin]) return { ...rules.suppliers[tin], tin };
    for (const [k, v] of Object.entries(rules.suppliers))
      if (v.frag && blob.toUpperCase().includes(v.frag.toUpperCase())) return { ...v, tin: k };
    return null;
  };

  const classify = (row, st) => {
    const acc = st.acc, ccy = st.ccy;
    const t = txt(row['ოპერაციის ტიპი']);
    const purpose = txt(row['დანიშნულება']);
    const doc = txt(row['საბუთის N']);
    const dr = num(row['დებეტი']), cr = num(row['კრედიტი']);
    const senderTin = txt(row['გამგზავნის საიდენტიფიკაციო კოდი']);
    const recipient = txt(row['მიმღების დასახელება']);
    const mk = (d, c, p, typ, memo, fc) => ({ dr: d, cr: c, partner: p, typ, memo, fc });

    if (t === 'LND') {
      if (purpose.includes('სესხის გაცემა')) return mk(acc, loanFor(doc), rules.bankPartner, 'სესხის გაცემა', `სესხი N ${doc}`);
      if (purpose.includes('პროცენტის დაფარვა')) return mk('8210', acc, rules.bankPartner, 'საპროცენტო ხარჯი', `სესხი N ${doc}`);
      if (purpose.includes('სესხის დაფარვა')) return mk(loanFor(doc), acc, rules.bankPartner, 'სესხის ძირის დაფარვა', `სესხი N ${doc}`);
      if (purpose.includes('საკომისიო')) return mk('7490-001', acc, rules.bankPartner, 'საბანკო საკომისიო', `სესხი N ${doc}`);
      return null;
    }
    if (t === 'COM' || t === 'FEE' || purpose.includes('საკომისიო'))
      return mk('7490-001', acc, rules.bankPartner, 'საბანკო საკომისიო', purpose.slice(0, 90), ccy !== 'GEL' ? (dr || cr) : null);

    if (t === 'PMI') {
      const s = findParty(row); if (!s) return null;
      return mk(s.acc, acc, s.name, 'გადახდა მომწოდებელს', purpose.slice(0, 110), dr || cr);
    }
    if (t === 'PMD' || t === 'PMC') {
      if (cr > 0) {
        if (rules.customers[senderTin])
          return mk(acc, rules.receivable, rules.customers[senderTin], 'თანხის მიღება მყიდველისგან', purpose.slice(0, 110));
        const nm = txt(row['გამგზავნის დასახელება']);
        if (nm) return mk(acc, rules.receivable, nm, 'თანხის მიღება მყიდველისგან', purpose.slice(0, 110));
        return null;
      }
      if (dr > 0) {
        for (const p of rules.purpose) if (purpose.includes(p.frag))
          return mk(p.acc || acc, acc, p.partner || recipient, p.typ, purpose.slice(0, 110));
        if (/^C\d+$/.test(purpose)) return mk('1490-001', acc, 'შემოსავლების სამსახური', 'გადასახადის გადახდა ხაზინაში', purpose);
        const s = findParty(row);
        if (s) return mk(s.acc, acc, s.name, 'გადახდა მომწოდებელს', purpose.slice(0, 110));
        if (recipient) return mk('3110-001', acc, recipient, 'გადახდა მომწოდებელს', purpose.slice(0, 110));
        return null;
      }
    }
    return null;
  };

  /* ერთი ქრონოლოგიური გავლა */
  const all = [];
  stmts.forEach((st, si) => st.rows.forEach((row, ri) =>
    all.push({ st, row, k: iso(row['თარიღი']) + '|' + String(ri).padStart(5, '0') + '|' + si })));
  all.sort((a, b) => a.k < b.k ? -1 : a.k > b.k ? 1 : 0);

  for (const { st, row } of all) {
    const dr = num(row['დებეტი']), cr = num(row['კრედიტი']);

    if (isConv(row)) {
      const ci = convInfo(row), d = iso(row['თარიღი']);
      const other = ibanTo[txt(row['მოკორესპოდენტო ანგარიში'])] || null;
      if (!other || !ci.amt) continue;
      const key = [d, ci.rate, Math.max(dr, cr), ci.amt].sort().join('|');
      if (convSeen.has(key)) continue;
      convSeen.add(key);
      const fcAcc = st.ccy === 'GEL' ? other : st.acc;
      const gelAcc = st.ccy === 'GEL' ? st.acc : other;
      const fcAmt = st.ccy === 'GEL' ? ci.amt : (dr || cr);
      const gel = st.ccy === 'GEL' ? (dr || cr) : ci.amt;
      const fcIn = st.ccy === 'GEL' ? dr > 0 : cr > 0;
      const drAcc = fcIn ? fcAcc : gelAcc, crAcc = fcIn ? gelAcc : fcAcc;
      const fcCcy = (rules.accounts.find(a => a.code === fcAcc) || {}).ccy || ci.ccy || 'USD';
      const rate = fcAmt ? Math.round(gel / fcAmt * 1e9) / 1e9 : 1;
      const bal = fx[fcAcc] || (fx[fcAcc] = { fc: 0, gel: 0 });
      if (fcIn) { bal.fc += fcAmt; bal.gel += gel; } else { bal.fc -= fcAmt; bal.gel -= gel; }
      entries.push({ date: d, doc: txt(row['საბუთის N']), typ: 'ვალუტის კონვერტაცია',
        desc: `ვალუტის კონვერტაცია — კომერციული კურსი ${ci.rate}`,
        cmt: `${fcCcy} ${fcAmt.toLocaleString('ka-GE')} · კურსი ${ci.rate}`,
        op: txt(row['ოპერაციის იდ']),
        lines: [
          { acc: drAcc, p: rules.bankPartner, it: '', qty: '', cur: drAcc === fcAcc ? fcCcy : 'GEL',
            fc: drAcc === fcAcc ? fcAmt : '', rate: drAcc === fcAcc ? rate : 1, dr: gel, cr: '' },
          { acc: crAcc, p: rules.bankPartner, it: '', qty: '', cur: crAcc === fcAcc ? fcCcy : 'GEL',
            fc: crAcc === fcAcc ? fcAmt : '', rate: crAcc === fcAcc ? rate : 1, dr: '', cr: gel },
        ] });
      continue;
    }

    const opId = txt(row['ოპერაციის იდ']);
    if (opId && seen.has(opId)) continue;
    if (!dr && !cr) continue;
    const c = classify(row, st);
    {
      const tin = txt(row['მიმღების საიდენტიფიკაციო კოდი']) || txt(row['გამგზავნის საიდენტიფიკაციო კოდი']);
      const nm = txt(row['მიმღების დასახელება']) || txt(row['გამგზავნის დასახელება']);
      const known = tin && (rules.customers[tin] || rules.suppliers[tin]);
      if (tin && nm && !known && !newParties.some(x => x.tin === tin))
        newParties.push({ tin, name: nm, side: cr ? 'მყიდველი' : 'მომწოდებელი' });
    }
    if (!c) {
      unmapped.push({
        name: txt(row['მიმღების დასახელება']) || txt(row['გამგზავნის დასახელება']), date: iso(row['თარიღი']), ccy: st.ccy, typ: txt(row['ოპერაციის ტიპი']),
        purpose: purposeOf(row), amount: dr || cr, side: dr ? 'დებეტი' : 'კრედიტი' });
      continue;
    }

    let gel = dr || cr, fcAmt = null, rate = 1;
    if (st.ccy !== 'GEL') {
      const bal = fx[st.acc] || (fx[st.acc] = { fc: 0, gel: 0 });
      fcAmt = dr || cr;
      if (c.cr === st.acc) {
        const mv = bal.fc > 0 ? bal.gel / bal.fc : (num(row['კურსი']) || 0);
        gel = r2(fcAmt * mv); bal.fc -= fcAmt; bal.gel -= gel;
      } else {
        const mv = num(row['კურსი']) || 0;
        gel = r2(fcAmt * mv); bal.fc += fcAmt; bal.gel += gel;
      }
      rate = fcAmt ? Math.round(gel / fcAmt * 1e9) / 1e9 : 1;
    }
    const isFx = a => st.ccy !== 'GEL' && a === st.acc;
    entries.push({ date: iso(row['თარიღი']), doc: txt(row['საბუთის N']), typ: c.typ,
      desc: c.memo || c.typ, cmt: c.memo || '', op: opId,
      lines: [
        { acc: c.dr, p: c.partner, it: '', qty: '', cur: isFx(c.dr) ? st.ccy : 'GEL',
          fc: isFx(c.dr) ? fcAmt : '', rate: isFx(c.dr) ? rate : 1, dr: gel, cr: '' },
        { acc: c.cr, p: c.partner, it: '', qty: '', cur: isFx(c.cr) ? st.ccy : 'GEL',
          fc: isFx(c.cr) ? fcAmt : '', rate: isFx(c.cr) ? rate : 1, dr: '', cr: gel },
      ] });
  }
  entries.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  return { entries, unmapped, newParties, newLoans,
    stmts: stmts.map(s => ({ ccy: s.ccy, acc: s.acc, period: txt(s.meta['პერიოდი']), rows: s.rows.length })) };
}
const purposeOf = row => txt(row['დანიშნულება']).slice(0, 90);

/* ---------------------------------------------------------------- რეალიზაცია */
export function importSales(wbs, org) {
  const rules = org.rules, vat = (org.settings.vatPayer ? (org.settings.vatRate ?? 18) : 0) / 100;
  const rows = [];
  for (const wb of wbs) for (const sh of wb.sheets) {
    const rr = sh.rows; if (!rr.length) continue;
    let h = -1;
    for (let i = 0; i < Math.min(rr.length, 10); i++) if (txt(rr[i][0]) === 'საქონლის კოდი') { h = i; break; }
    if (h < 0) continue;
    const hdr = rr[h].map(txt);
    for (let i = h + 1; i < rr.length; i++) {
      const r = rr[i]; if (!r || !r[0]) continue;
      const o = {}; hdr.forEach((k, c) => { if (k) o[k] = r[c]; });
      if (o['საქონლის კოდი']) rows.push(o);
    }
  }
  if (!rows.length) return { entries: [], newParties: [], newItems: [], error: 'რეალიზაციის რეპორტის სტრუქტურა ვერ ამოვიცანი' };

  const byDoc = new Map();
  for (const o of rows) {
    const doc = txt(o['ზედნადების ნომერი']);
    const g = byDoc.get(doc) || { doc, date: iso(o['თარიღი']), buyer: txt(o['მყიდველი']), lines: [] };
    g.lines.push({ sku: txt(o['საქონლის კოდი']), name: txt(o['საქონლის დასახელება']),
                   unit: txt(o['ზომის ერთეული']), qty: +o['რაოდ.'] || 0, amt: num(o['საქონლის ფასი']) });
    byDoc.set(doc, g);
  }
  const seen = new Set(org.entries.map(e => e.op).filter(Boolean));
  const entries = [], newParties = [], newItems = [];
  for (const g of byDoc.values()) {
    if (seen.has('SALE:' + g.doc)) continue;
    const m = g.buyer.match(/\((\d{9})/);
    const tin = m ? m[1] : '';
    const buyer = rules.customers[tin] || g.buyer.replace(/^\([^)]*\)\s*/, '');
    if (tin && !rules.customers[tin] && !newParties.some(p => p.tin === tin))
      newParties.push({ tin, name: buyer, side: 'მყიდველი' });
    for (const l of g.lines)
      if (!org.items.some(i => i.code === l.sku) && !newItems.some(i => i.code === l.sku))
        newItems.push({ code: l.sku, name: l.name, unit: l.unit });
    const net = r2(g.lines.reduce((a, l) => a + l.amt, 0));
    const v = r2(net * vat), gross = r2(net + v);
    const lines = [{ acc: rules.receivable, p: buyer, it: '', qty: '', cur: 'GEL', fc: '', rate: 1, dr: gross, cr: '' },
      ...g.lines.map(l => ({ acc: rules.revenue, p: buyer, it: l.sku, qty: l.qty, cur: 'GEL', fc: '', rate: 1, dr: '', cr: l.amt }))];
    if (v) lines.push({ acc: rules.vatOut, p: buyer, it: '', qty: '', cur: 'GEL', fc: '', rate: 1, dr: '', cr: v });
    entries.push({ date: g.date, doc: g.doc, typ: 'რეალიზაცია',
      desc: `საქონლის რეალიზაცია — ს/ფ ${g.doc}, ${buyer}`,
      cmt: v ? `დღგ-ს გარეშე ${net.toFixed(2)} + დღგ ${(vat * 100).toFixed(0)}% ${v.toFixed(2)} = ${gross.toFixed(2)}`
             : `დღგ-ს გარეშე ${net.toFixed(2)}`,
      op: 'SALE:' + g.doc, lines });
  }
  entries.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  return { entries, newParties, newItems, docs: byDoc.size };
}

/* ---------------------------------------------------------------- თვის დახურვა */
/** საშუალო შეწონილი, პერიოდული (IFRS for SMEs §13.18) */
export function closeMonth(org, month) {
  const rules = org.rules;
  const stock = {};
  const add = (s, q, v) => { const b = stock[s] = stock[s] || [0, 0]; b[0] += q; b[1] += v; };
  for (const [sku, b] of Object.entries(org.openingStock || {})) add(sku, b[0], b[1]);

  const sales = [];
  for (const e of org.entries) {
    const m = (e.date || '').slice(0, 7);
    for (const l of e.lines || []) {
      if (l.acc !== rules.goods) continue;
      const q = +l.qty || 0, dr = +l.dr || 0, cr = +l.cr || 0;
      if (m < month) add(l.it, dr ? q : -q, dr ? dr : -cr);
      else if (m === month && dr) add(l.it, q, dr);
    }
    if (m === month && e.typ === 'რეალიზაცია')
      sales.push({ doc: e.doc, date: e.date,
        items: (e.lines || []).filter(l => l.acc === rules.revenue).map(l => ({ sku: l.it, qty: +l.qty || 0 })) });
  }
  const wac = {}; for (const [s, b] of Object.entries(stock)) wac[s] = b[0] ? b[1] / b[0] : 0;
  const left = {}; for (const [s, b] of Object.entries(stock)) left[s] = b[0];
  const seen = new Set(org.entries.map(e => e.op).filter(Boolean));
  const entries = [], short = [];
  for (const s of sales) {
    if (seen.has('COGS:' + s.doc)) continue;
    const lines = []; let tot = 0;
    for (const it of s.items) {
      const cost = Math.round(it.qty * (wac[it.sku] || 0) * 100) / 100;
      if ((left[it.sku] || 0) < it.qty - 1e-9)
        short.push(`${it.sku}: გაყიდულია ${it.qty}, ხელმისაწვდომია ${(left[it.sku] || 0).toFixed(0)}`);
      left[it.sku] = (left[it.sku] || 0) - it.qty; tot += cost;
      lines.push({ acc: rules.cogs, p: '', it: it.sku, qty: it.qty, cur: 'GEL', fc: '', rate: 1, dr: cost, cr: '' });
    }
    for (const it of s.items) {
      const cost = Math.round(it.qty * (wac[it.sku] || 0) * 100) / 100;
      lines.push({ acc: rules.goods, p: '', it: it.sku, qty: it.qty, cur: 'GEL', fc: '', rate: 1, dr: '', cr: cost });
    }
    if (!lines.length || !tot) continue;
    entries.push({ date: s.date, doc: s.doc, typ: 'თვითღირებულების ჩამოწერა',
      desc: `რეალიზებული საქონლის თვითღირებულება — ს/ფ ${s.doc}`,
      cmt: `საშუალო შეწონილი, პერიოდული (${month}) · სულ ${tot.toFixed(2)}`,
      op: 'COGS:' + s.doc, lines });
  }
  return { entries, wac, short: [...new Set(short)] };
}
