// © შპს მარტივადი — Elastic License 2.0 (იხ. LICENSE)
/* ============================================================================
   theme.js — ღია / მუქი თემის გადამრთველი.

   სამი მდგომარეობა, არა ორი: `auto` (სისტემას მიჰყვება), `light`, `dark`.
   CSS უკვე ასეა აწყობილი — `prefers-color-scheme` მაშინ მოქმედებს, როცა
   `data-theme` დაყენებული არაა — ამიტომ „auto" ნიშნავს უბრალოდ ატრიბუტის
   მოხსნას. ორმდგომარეობიანი გადამრთველი პირველივე კლიკზე სამუდამოდ
   გაწყვეტდა სისტემასთან კავშირს.

   FOUC: არჩევანი index.html-ის <head>-ში, პირველ დახატვამდე ედება
   <html>-ს; ეს ფაილი მხოლოდ ღილაკს ამუშავებს.
   ========================================================================== */

const KEY = 'martivad.theme';
/** auto → light → dark → auto */
const ORDER = ['auto', 'light', 'dark'];

const ICONS = {
  // sun / moon / monitor — inline, რომ გარე იკონ-ბიბლიოთეკა არ დაგვჭირდეს
  light: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  dark: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  auto: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
};

/** ეტიკეტები — Phase B-ში i18n ჩაანაცვლებს data-i18n გასაღებებით. */
const LABELS = { auto: 'სისტემა', light: 'ღია', dark: 'მუქი' };

export function readTheme() {
  try {
    const v = localStorage.getItem(KEY);
    return ORDER.includes(v) ? v : 'auto';
  } catch (e) {
    return 'auto';
  }
}

export function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
  try { localStorage.setItem(KEY, mode); } catch (e) { /* საცავი გამორთულია */ }
}

/** რომელი თემა ჩანს ფაქტობრივად — ღილაკის aria-ტექსტისთვის. */
export function effectiveTheme(mode = readTheme()) {
  if (mode !== 'auto') return mode;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark' : 'light';
}

function paint(btn, mode) {
  btn.innerHTML = `${ICONS[mode]}<span class="lbl" data-i18n="theme.${mode}">${LABELS[mode]}</span>`;
  btn.setAttribute('data-theme-mode', mode);
  btn.setAttribute('aria-label', `თემა: ${LABELS[mode]}`);
  btn.title = `თემა: ${LABELS[mode]}`;
}

export function initThemeToggle(btn) {
  if (!btn) return;
  let mode = readTheme();
  paint(btn, mode);

  btn.addEventListener('click', () => {
    mode = ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length];
    applyTheme(mode);
    paint(btn, mode);
    // ხელახლა დახატვის საჭიროება არაა — ყველა ფერი ტოკენებიდან მოდის.
    document.dispatchEvent(new CustomEvent('martivad:themechange', { detail: { mode } }));
  });

  // სისტემის თემის ცვლილება მხოლოდ `auto`-ზე უნდა აისახოს ღილაკზე
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (readTheme() === 'auto') paint(btn, 'auto');
    });
  }
}

initThemeToggle(document.getElementById('themeToggle'));
