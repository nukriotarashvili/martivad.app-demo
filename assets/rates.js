// © შპს მარტივადი — Elastic License 2.0 (იხ. LICENSE)
/* ============================================================================
   rates.js — ეროვნული ბანკის კურსები + ვალუტის კალკულატორი.

   ორი წესი, რომელზეც ყველაფერი დგას:

   1. NBG კურსს ბლოკებით აქვს მოცემული. RUB-ს `quantity: 100`, CNY-ს `10`.
      ანუ `rate` არის ფასი *quantity* ერთეულზე, არა ერთზე. ერთი ერთეულის
      კურსი = rate / quantity. ამის უგულებელყოფა 100-ჯერ შეცდომას ნიშნავს
      რუბლზე — ამიტომ ნორმალიზაცია ერთ ადგილას, `unitRate()`-ში ხდება და
      დანარჩენი კოდი მხოლოდ მას იყენებს.

   2. დამრგვალება მხოლოდ ჩვენებაზეა. კონვერტაცია სრული სიზუსტით ითვლება,
      რომ 100 USD → GEL → USD წრემ თანხა არ „აცდინოს". დამრგვალებული
      შუალედური მნიშვნელობა ჯაჭვში არასდროს შედის.

   ქსელი: CORS ცოცხლად შემოწმდა — nbg.gov.ge origin-ს აირეკლავს, ანუ
   პირდაპირი fetch მუშაობს, proxy არ სჭირდება. ქსელის გარეშე ბოლო
   წარმატებული კურსი ქეშიდან ჩნდება, თარიღის მკაფიო მითითებით.
   ========================================================================== */

const API = 'https://nbg.gov.ge/gw/api/ct/monetarypolicy/currencies/ka/json';
const CACHE_KEY = 'martivad.rates.v1';
export const SHOWN = ['USD', 'EUR', 'RUB', 'TRY', 'CNY'];

/* ------------------------------------------------------------------ pure -- */

/** ერთი ერთეულის კურსი ლარში. NBG-ის ბლოკური კოტირების ერთადერთი გამსწორებელი. */
export function unitRate(c) {
  const q = Number(c && c.quantity) || 1;
  const r = Number(c && c.rate) || 0;
  return q === 0 ? 0 : r / q;
}

/**
 * ვალუტა → GEL. სრული სიზუსტით, დამრგვალების გარეშე.
 * @param {number} amount ვალუტის თანხა
 * @param {number} rate   ერთი ერთეულის კურსი (unitRate)
 */
export const toGel = (amount, rate) => (Number(amount) || 0) * (Number(rate) || 0);

/** GEL → ვალუტა. ასევე დამრგვალების გარეშე. */
export const fromGel = (gel, rate) => {
  const r = Number(rate) || 0;
  return r === 0 ? 0 : (Number(gel) || 0) / r;
};

/** ჩვენებისთვის — და მხოლოდ ჩვენებისთვის. */
export const show = (v, dp = 2) =>
  new Intl.NumberFormat('ka-GE', { minimumFractionDigits: dp, maximumFractionDigits: dp })
    .format(Number(v) || 0);

/** „2026-08-27T00:00:00.000Z" → „27.08" */
export function shortDate(iso) {
  if (!iso) return '';
  const d = String(iso).slice(0, 10).split('-');
  return d.length === 3 ? `${d[2]}.${d[1]}` : String(iso).slice(0, 10);
}

/* ----------------------------------------------------------------- cache -- */

export function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function writeCache(payload) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(payload)); } catch (e) { /* იგნორი */ }
}

/* ---------------------------------------------------------------- network -- */

/**
 * კურსები NBG-დან. `date` — ISO (YYYY-MM-DD) ისტორიულისთვის, ან undefined
 * დღევანდელისთვის.
 *
 * წარმატება ქეშირდება მხოლოდ დღევანდელისთვის: ისტორიული მოთხოვნა ერთჯერადია
 * და ქეშში „ბოლო კურსად" ჩაწერა თარიღს გააყალბებდა.
 */
export async function fetchRates(date) {
  const url = date ? `${API}/?date=${encodeURIComponent(date)}` : API;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`NBG ${res.status}`);

  const body = await res.json();
  const block = Array.isArray(body) ? body[0] : body;
  if (!block || !Array.isArray(block.currencies)) throw new Error('NBG: unexpected shape');

  const out = { date: block.date, currencies: {} };
  for (const c of block.currencies) {
    out.currencies[c.code] = {
      code: c.code, name: c.name,
      rate: Number(c.rate), quantity: Number(c.quantity) || 1,
      unit: unitRate(c), diff: Number(c.diff) || 0,
    };
  }
  if (!date) writeCache({ ...out, fetchedAt: new Date().toISOString() });
  return out;
}

/** დღევანდელი კურსები, ქსელის ჩავარდნისას — ქეში. */
export async function loadRates() {
  try {
    return { ...(await fetchRates()), source: 'network' };
  } catch (e) {
    const cached = readCache();
    if (cached) return { ...cached, source: 'cache', error: e.message };
    return { date: null, currencies: {}, source: 'none', error: e.message };
  }
}

/* -------------------------------------------------------------- overrides -- */
/* ხელით შეყვანილი კურსი ყოველთვის სჯობს ჩამოტვირთულს — API-ის პრობლემა
   ბუღალტრის სამუშაოს ვერ აჩერებს. */

const OVR_KEY = 'martivad.rates.manual';

export function readOverrides() {
  try { return JSON.parse(localStorage.getItem(OVR_KEY) || '{}'); } catch (e) { return {}; }
}

export function setOverride(code, value) {
  const o = readOverrides();
  if (value === null || value === '' || !Number.isFinite(Number(value))) delete o[code];
  else o[code] = Number(value);
  try { localStorage.setItem(OVR_KEY, JSON.stringify(o)); } catch (e) { /* იგნორი */ }
  return o;
}

/**
 * საბოლოო კურსი: ხელით > ჩამოტვირთული.
 *
 * ხელით შეყვანილი მნიშვნელობა BLOCK-კურსად იკითხება — ბუღალტერი nbg.gov.ge-ზე
 * „100 RUB = 3.1118" ხედავს და სწორედ 3.1118-ს აკრეფს. ერთეულზე გადაყვანა აქ
 * ხდება, რომ დანარჩენმა კოდმა ისევ მხოლოდ ერთეულის კურსი იცოდეს.
 *
 * @returns {{unit:number, block:number, quantity:number, manual:boolean}}
 */
export function effectiveRate(code, rates, overrides = readOverrides()) {
  const c = rates && rates.currencies ? rates.currencies[code] : null;
  const q = c ? (Number(c.quantity) || 1) : 1;

  if (Object.prototype.hasOwnProperty.call(overrides, code)) {
    const block = Number(overrides[code]) || 0;
    return { unit: block / q, block, quantity: q, manual: true };
  }
  return { unit: c ? c.unit : 0, block: c ? Number(c.rate) : 0, quantity: q, manual: false };
}
