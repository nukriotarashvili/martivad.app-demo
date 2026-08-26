// © შპს მარტივადი — Elastic License 2.0 (იხ. LICENSE)
/* ============================================================================
   store.js — ორგანიზაციების საცავი (localStorage).
   ერთ ბრაუზერში რამდენიმე ორგანიზაცია; მონაცემები არსად არ იგზავნება.
   ========================================================================== */
import { COA } from './coa.js';

const KEY = 'martivad.v1';
const uid = () => 'o' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);

/* ---------- ნაგულისხმევი საბანკო წესები (საქართველოს ბანკის ამონაწერი) ---------- */
export const DEFAULT_RULES = {
  accounts: [],                    // [{iban, code, ccy, name}]
  customers: {},                   // ს/ნ → სახელი
  suppliers: {},                   // ს/ნ → {name, acc}
  loans: {},                       // სესხის ნომერი → ანგარიში
  purpose: [
    { frag: 'სესხის გაცემა',        acc: null,       partner: 'ბანკი', typ: 'სესხის გაცემა' },
    { frag: 'პროცენტის დაფარვა',    acc: '8210',     partner: 'ბანკი', typ: 'საპროცენტო ხარჯი' },
    { frag: 'სესხის დაფარვა',       acc: null,       partner: 'ბანკი', typ: 'სესხის ძირის დაფარვა' },
    { frag: 'საპენსიო შენატანი',    acc: '3370-001', partner: 'საპენსიო სააგენტო', typ: 'საპენსიო შენატანის გადახდა' },
    { frag: 'საშემოსავლო გადასახადი', acc: '3320',   partner: 'შემოსავლების სამსახური', typ: 'საშემოსავლო გადასახადის გადახდა' },
    { frag: 'ხელფას',               acc: '3130',     partner: null,    typ: 'ხელფასის გაცემა' },
    { frag: 'საბიუჯეტო გადასახადი', acc: '1490-001', partner: 'შემოსავლების სამსახური', typ: 'გადასახადის გადახდა ხაზინაში' },
    { frag: 'თვის გადასახადები',    acc: '1490-001', partner: 'შემოსავლების სამსახური', typ: 'გადასახადის გადახდა ხაზინაში' },
    { frag: 'მომსახურების საფასური', acc: '7490-009', partner: 'შემოსავლების სამსახური', typ: 'სახელმწიფო მომსახურების საფასური' },
    { frag: 'სატრანსპორტო',         acc: '3110-005', partner: null,    typ: 'გადახდა გადამზიდს' },
    { frag: 'საკომისიო',            acc: '7490-001', partner: 'ბანკი', typ: 'საბანკო საკომისიო' },
  ],
  bankPartner: 'ბანკი',
  vatRate: 18,
  receivable: '1410-001',
  revenue: '6110',
  vatOut: '3330',
  goods: '1610',
  cogs: '7210',
};

export function blankOrg(name, tin, opts = {}) {
  return {
    id: uid(),
    name: name || 'ახალი ორგანიზაცია',
    tin: tin || '',
    created: new Date().toISOString().slice(0, 10),
    settings: {
      currency: 'GEL',
      vatPayer: opts.vatPayer !== false,
      vatRate: opts.vatRate ?? 18,
      periodFrom: opts.periodFrom || (new Date().getFullYear() + '-01-01'),
    },
    coa: COA.map(a => ({ ...a })),
    partners: [],                  // [{name, tin, role}]
    items: [],                     // [{code, name, unit}]
    rules: JSON.parse(JSON.stringify(DEFAULT_RULES)),
    openingStock: {},              // sku → [qty, value]
    entries: [],
    seq: 100000,
  };
}

/* ---------------------------------------------------------------- საცავი */
function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* ბრაუზერს საცავი გამორთული აქვს */ }
  return { orgs: [], active: null };
}

let db = load();

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); return true; }
  catch (e) { return false; }
}

export const store = {
  all: () => db.orgs,
  active: () => db.orgs.find(o => o.id === db.active) || null,
  setActive(id) { db.active = id; save(); },
  add(org) { db.orgs.push(org); db.active = org.id; save(); return org; },
  remove(id) {
    db.orgs = db.orgs.filter(o => o.id !== id);
    if (db.active === id) db.active = db.orgs.length ? db.orgs[0].id : null;
    save();
  },
  save,
  replaceAll(next) { db = next; save(); },
  export() { return JSON.stringify(db, null, 1); },
  import(text) {
    const next = JSON.parse(text);
    if (!next || !Array.isArray(next.orgs)) throw new Error('ფაილის სტრუქტურა არ ემთხვევა');
    db = next; save(); return db.orgs.length;
  },
};

/* ---------------------------------------------------------------- დამხმარე */
export const accMap = org => new Map(org.coa.map(a => [a.c, a]));

export function addEntry(org, e) {
  org.entries.push({ no: org.seq, ...e });
  org.seq += 10;
  org.entries.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.no - b.no);
}

/** პარტნიორის/საქონლის ავტომატური რეგისტრაცია იმპორტისას */
export function ensurePartner(org, name, tin, role) {
  if (!name) return;
  if (!org.partners.some(p => p.name === name)) org.partners.push({ name, tin: tin || '', role: role || '' });
}
export function ensureItem(org, code, name, unit) {
  if (!code) return;
  if (!org.items.some(i => i.code === code)) org.items.push({ code, name: name || code, unit: unit || '' });
}

/** ბრუნვითი უწყისი — ანგარიშების ჭრილში */
export function trialBalance(org, from, to) {
  const t = new Map();
  const get = c => { let v = t.get(c); if (!v) t.set(c, v = { dr: 0, cr: 0 }); return v; };
  for (const e of org.entries) {
    if (from && e.date < from) continue;
    if (to && e.date > to) continue;
    for (const l of e.lines) { const v = get(l.acc); v.dr += +l.dr || 0; v.cr += +l.cr || 0; }
  }
  return t;
}
