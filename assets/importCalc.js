// © შპს მარტივადი — Elastic License 2.0 (იხ. LICENSE)
/* ============================================================================
   importCalc.js — იმპორტის თვითღირებულების გაანგარიშება. სუფთა ფუნქციები,
   DOM-ის გარეშე, რომ ბუღალტრული ლოგიკა ცალკე იყოს შესამოწმებელი.

   წესები (დამკვეთის მიერ განსაზღვრული — არ იცვლება გამოცნობით):

   1. თვითღირებულება იყინება მიღებისას. გადახდის დღის კურსის სხვაობა
      თვითღირებულებაში არ შედის — ის საკურსო სხვაობის ხარჯია.
   2. ავანსი (§30.9 — არამონეტარული, გადახდის კურსით) ამ ეტაპზე პანელს
      განზრახ არ აქვს: დამკვეთმა დაადასტურა, რომ ჯერ არ სჭირდება. წილობრივი
      ავანსის შერეული კურსი აქ იყო აწყობილი და მოიხსნა — უსარგებლო სირთულე
      ბუღალტრულ ბირთვში საშიშია. დამატებისას ერთადერთი ცვლილება ხაზის
      ღირებულების კურსია, დანარჩენი გაანგარიშება უცვლელი რჩება.
   3. საბაჟო ღირებულება = საქონლის ღირებულება დეკლარაციის თარიღის კურსით,
      პლუს ტრანსპორტი საზღვრამდე — მხოლოდ თუ ასეა დეკლარირებული.
   4. თვითღირებულებაში: საქონლის ფასი + საბაჟო გადასახადი + ტრანსპორტი +
      სხვა პირდაპირი ხარჯები.
   5. იმპორტის დღგ = განაკვეთი × (საბაჟო ღირებულება + საბაჟო გადასახადი).
      დღგ-ს გადამხდელისთვის ჩასათვლელია და თვითღირებულებაში არ შედის;
      არაგადამხდელისთვის — შედის.
   6. განაწილება ღირებულების პროპორციით ან რაოდენობით; დამრგვალების ნაშთს
      ბოლო ხაზი იღებს, რომ Σხაზები ზუსტად უდრიდეს ჯამს.
   ========================================================================== */

export const round2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;

/**
 * @param {object} inp
 * @param {{name:string, qty:number, price:number}[]} inp.lines  ფასი ვალუტაში
 * @param {number} inp.rate            საქონლის კურსი (1 ერთეული → GEL)
 * @param {number} inp.transport       ტრანსპორტი ვალუტაში (ან GEL-ში, თუ rate=1)
 * @param {number} inp.transportRate   ტრანსპორტის კურსი
 * @param {boolean} inp.transportInCustoms  საზღვრამდე და დეკლარირებული?
 * @param {'percent'|'amount'} inp.dutyMode
 * @param {number} inp.dutyValue
 * @param {number} inp.otherCosts      GEL
 * @param {number} inp.vatRate         მაგ. 18
 * @param {boolean} inp.vatPayer
 * @param {'value'|'quantity'} inp.allocation
 */
export function calcImport(inp) {
  const {
    lines = [], rate = 0, transport = 0, transportRate = 1, transportInCustoms = false,
    dutyMode = 'percent', dutyValue = 0, otherCosts = 0,
    vatRate = 18, vatPayer = false, allocation = 'value',
  } = inp;

  // ── ხაზების ღირებულება ლარში ─────────────────────────────────────────────
  // ერთი კურსი: მიღების/დეკლარაციის თარიღისა (წესი 1 — თვითღირებულება
  // მიღებისას იყინება).
  const priced = lines.map((l) => {
    const qty = Number(l.qty) || 0;
    const fx = Number(l.price) || 0;
    return { name: l.name || '', qty, price: fx, valueGel: qty * fx * rate };
  });

  const goodsGel = priced.reduce((s, l) => s + l.valueGel, 0);
  const transportGel = (Number(transport) || 0) * (Number(transportRate) || 0);

  // ── საბაჟო ────────────────────────────────────────────────────────────────
  const customsValue = goodsGel + (transportInCustoms ? transportGel : 0);
  const dutyGel = dutyMode === 'percent'
    ? customsValue * ((Number(dutyValue) || 0) / 100)
    : (Number(dutyValue) || 0);

  const vatBase = customsValue + dutyGel;
  const importVat = vatBase * ((Number(vatRate) || 0) / 100);

  // წესი 5 — სტატუსი წყვეტს, დღგ ჩაითვლება თუ თვითღირებულებაში ჩაჯდება
  const vatCreditable = vatPayer ? importVat : 0;
  const vatInCost = vatPayer ? 0 : importVat;

  // ── კაპიტალიზებადი ჯამი (წესი 4 + 5) ─────────────────────────────────────
  const extras = dutyGel + transportGel + (Number(otherCosts) || 0) + vatInCost;
  const capitalisedTotal = goodsGel + extras;

  // ── განაწილება ხაზებზე ───────────────────────────────────────────────────
  const basis = allocation === 'quantity'
    ? priced.map((l) => l.qty)
    : priced.map((l) => l.valueGel);
  const basisSum = basis.reduce((s, v) => s + v, 0);

  const outLines = priced.map((l, i) => {
    const w = basisSum > 0 ? basis[i] / basisSum : (priced.length ? 1 / priced.length : 0);
    return { ...l, weight: w, allocated: extras * w };
  });

  // დამრგვალება: ყველა ხაზი round2, ბოლო იღებს ნაშთს — ჯამი ზუსტად იკვრება
  const targetTotal = round2(capitalisedTotal);
  let running = 0;
  outLines.forEach((l, i) => {
    if (i < outLines.length - 1) {
      l.totalCost = round2(l.valueGel + l.allocated);
      running += l.totalCost;
    } else {
      l.totalCost = round2(targetTotal - running);
    }
    l.unitCost = l.qty > 0 ? l.totalCost / l.qty : 0;
    l.valueGelR = round2(l.valueGel);
    l.allocatedR = round2(l.totalCost - l.valueGelR);
  });

  const sumLines = round2(outLines.reduce((s, l) => s + l.totalCost, 0));

  return {
    rate,
    goodsGel: round2(goodsGel),
    transportGel: round2(transportGel),
    customsValue: round2(customsValue),
    dutyGel: round2(dutyGel),
    vatBase: round2(vatBase),
    importVat: round2(importVat),
    vatCreditable: round2(vatCreditable),
    vatInCost: round2(vatInCost),
    otherCosts: round2(Number(otherCosts) || 0),
    capitalisedTotal: targetTotal,
    lines: outLines,
    checks: { sumLines, balances: sumLines === targetTotal, diff: round2(sumLines - targetTotal) },
  };
}

/* ============================================================================
   გატარებების აწყობა.

   ანგარიშების რუკა დამკვეთმა დაადასტურა:
     Dr 1610       საქონელი (საწყობი) — კაპიტალიზებადი თვითღირებულება
     Dr 3340-002   გადახდილი დღგ — იმპორტი (საბაჟოზე) — მხოლოდ გადამხდელს
     Cr 3110-002   ვალდებულება მიმწოდებლის მიმართ — საქონელი
     Cr 3110-004   ვალდებულება გადამზიდის მიმართ — ტრანსპორტი
     Cr 3110-001   სხვა პირდაპირი ხარჯები (GEL მიმწოდებელი)
     Cr 1485       საბაჟოსთვის გადახდილი ავანსი — საბაჟო გადასახადი + იმპორტის დღგ

   1485 იმიტომ, რომ ტიპურ ქართულ პრაქტიკაში საბაჟოსთან ანგარიშსწორება
   წინასწარ ირიცხება და დეკლარაციისას იფარება — ანუ საბაჟოს გადახდები ამ
   ავანსს ამცირებს, ახალ ვალდებულებას არ ქმნის.

   არაგადამხდელისთვის დღგ თვითღირებულებაშია (1610-ში უკვე შედის), ამიტომ
   3340-002 საერთოდ არ ჩნდება — მაგრამ 1485-ის კრედიტი იგივე რჩება: ფული
   საბაჟოში ორივე შემთხვევაში გადის.
   ========================================================================== */

export const IMPORT_ACCOUNTS = {
  goods: '1610',
  vatImport: '3340-002',
  supplierGoods: '3110-002',
  carrier: '3110-004',
  supplierOther: '3110-001',
  customs: '1485',
};

/**
 * @param {ReturnType<calcImport>} r
 * @param {{date:string, doc:string, supplier:string, carrier:string, vatPayer:boolean}} meta
 * @returns {{date,doc,typ,desc,lines:Array}} ჟურნალის გატარება
 */
export function buildImportEntry(r, meta = {}) {
  const A = IMPORT_ACCOUNTS;
  const lines = [];
  const dr = (acc, amount, p, it) => { if (round2(amount) !== 0) lines.push({ acc, p: p || '', it: it || '', dr: round2(amount), cr: '' }); };
  const cr = (acc, amount, p) => { if (round2(amount) !== 0) lines.push({ acc, p: p || '', it: '', dr: '', cr: round2(amount) }); };

  // საქონელი — თითო ხაზი ცალკე, რომ საწყობის ბარათი ერთეულებს ინახავდეს
  r.lines.forEach((l) => dr(A.goods, l.totalCost, meta.supplier, l.name));

  if (meta.vatPayer) dr(A.vatImport, r.vatCreditable);

  cr(A.supplierGoods, r.goodsGel, meta.supplier);
  cr(A.carrier, r.transportGel, meta.carrier);
  cr(A.supplierOther, r.otherCosts, meta.supplier);
  // საბაჟოში გასული ფული: გადასახადი + დღგ (სტატუსის მიუხედავად)
  cr(A.customs, r.dutyGel + r.importVat);

  const totDr = round2(lines.reduce((s, l) => s + (Number(l.dr) || 0), 0));
  const totCr = round2(lines.reduce((s, l) => s + (Number(l.cr) || 0), 0));

  return {
    date: meta.date || new Date().toISOString().slice(0, 10),
    doc: meta.doc || '',
    typ: 'საქონლის მიღება',
    desc: 'იმპორტი — თვითღირებულების ფორმირება',
    lines,
    totals: { dr: totDr, cr: totCr, balanced: totDr === totCr },
  };
}
