// © შპს მარტივადი — Elastic License 2.0 (იხ. LICENSE)
/* ============================================================================
   backup.js — სარეზერვო ასლის შეხსენება.

   რატომ: მონაცემები localStorage-შია. ბრაუზერის ისტორიის/cache-ის გაწმენდა
   მათ შლის — ექსპორტი კი მანამდე უნდა გაკეთდეს, არა შემდეგ. ეს მოდული
   მხოლოდ *ითვლის*, როდის ღირს შეხსენება; ბანერს app.js ხატავს.

   მდგომარეობა ცალკე გასაღებშია (`martivad.backup.v1`), განზრახ — store.js-ის
   `martivad.v1` მთლიანად იცვლება JSON-იმპორტისას, და შეხსენების ისტორია მასთან
   ერთად რომ იშლებოდეს, იმპორტის შემდეგ მომხმარებელი ისევ „პირველ გახსნაში"
   აღმოჩნდებოდა.
   ========================================================================== */

const KEY = 'martivad.backup.v1';
const DAY = 86400000;

/** რამდენი დღე უნდა გავიდეს ბოლო ექსპორტიდან, რომ შეხსენება გაჩნდეს. */
export const REMIND_AFTER_DAYS = 7;
/** დახურვის შემდეგ ამდენ ხანს აღარ ჩნდება. */
export const SNOOZE_DAYS = 7;

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* საცავი გამორთულია — შეხსენება უბრალოდ არ იმუშავებს */ }
  return {};
}

let st = load();

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) { /* იგნორი */ }
}

const now = () => Date.now();
const ts = v => (v ? Date.parse(v) : NaN);

/** დღეების რაოდენობა ISO თარიღიდან დღემდე (დამრგვალებული ქვევით). */
export function daysSince(iso) {
  const t = ts(iso);
  return Number.isNaN(t) ? null : Math.floor((now() - t) / DAY);
}

/**
 * რა უნდა გამოჩნდეს ახლა.
 *
 * @param {number} entryCount — გატარებების ჯამური რაოდენობა ყველა ორგანიზაციაში
 * @returns {null | {kind:'first'} | {kind:'stale', days:number|null, added:number}}
 */
export function bannerState(entryCount) {
  // 1. პირველი გახსნა — ერთჯერადი, სანამ არ დაიხურება.
  if (!st.seen) return { kind: 'first' };

  // 2. დახურული შეხსენება ისვენებს.
  if (st.snoozeUntil && ts(st.snoozeUntil) > now()) return null;

  // 3. უგატარებო ბაზაზე შესახსენებელი არაფერია.
  if (!entryCount) return null;

  const added = entryCount - (st.entriesAtExport || 0);

  // 4. არასდროს გაუკეთებია ექსპორტი, მაგრამ გატარებები უკვე აქვს.
  if (!st.lastExportAt) return { kind: 'stale', days: daysSince(st.firstSeenAt), added: entryCount };

  // 5. ბოლო ექსპორტიდან ≥7 დღეა და მას შემდეგ ახალი გატარებები დაემატა.
  const days = daysSince(st.lastExportAt);
  if (days !== null && days >= REMIND_AFTER_DAYS && added > 0) return { kind: 'stale', days, added };

  return null;
}

/** პირველი ბანერი ნანახია — მეორედ აღარ გამოჩნდება. */
export function markSeen() {
  st.seen = true;
  if (!st.firstSeenAt) st.firstSeenAt = new Date().toISOString();
  save();
}

/** ექსპორტი გაკეთდა — ათვლა თავიდან იწყება. */
export function noteExport(entryCount) {
  st.seen = true;
  if (!st.firstSeenAt) st.firstSeenAt = new Date().toISOString();
  st.lastExportAt = new Date().toISOString();
  st.entriesAtExport = entryCount || 0;
  st.snoozeUntil = null;
  save();
}

/** შეხსენება დაიხურა — SNOOZE_DAYS დღე ჩუმად. */
export function snooze() {
  st.seen = true;
  if (!st.firstSeenAt) st.firstSeenAt = new Date().toISOString();
  st.snoozeUntil = new Date(now() + SNOOZE_DAYS * DAY).toISOString();
  save();
}

/** ბოლო ექსპორტის დრო (ISO) ან null — ინტერფეისისთვის. */
export const lastExportAt = () => st.lastExportAt || null;

/**
 * ტესტისთვის: ბოლო ექსპორტის თარიღის უკან გადაწევა.
 * კონსოლში — `martivadBackup.rewind(8)` → 8 დღით უკან.
 */
export function rewind(days) {
  if (!st.lastExportAt) st.lastExportAt = new Date().toISOString();
  st.lastExportAt = new Date(ts(st.lastExportAt) - days * DAY).toISOString();
  st.snoozeUntil = null;
  save();
  return st.lastExportAt;
}

/** ტესტისთვის: სრული განულება. */
export function reset() { st = {}; save(); }
