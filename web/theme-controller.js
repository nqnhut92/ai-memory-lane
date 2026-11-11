export const themeOrder = ['system', 'light', 'dark'];
export const themePaths = {
  system: '<rect x="3" y="4" width="18" height="13" rx="3"/><path d="M9 21h6m-3-4v4"/>',
  light: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  dark: '<path d="M20.5 14.3A9 9 0 0 1 9.7 3.5a9 9 0 1 0 10.8 10.8Z"/>',
};
export function themeLabel(preference, locale = 'en') {
  const labels = locale === 'vi' ? {system:'Theo hệ thống',light:'Sáng',dark:'Tối'} : {system:'System',light:'Light',dark:'Dark'};
  const next = themeOrder[(themeOrder.indexOf(preference) + 1) % 3];
  return locale === 'vi' ? `Giao diện: ${labels[preference]}. Chuyển sang ${labels[next]}` : `Appearance: ${labels[preference]}. Switch to ${labels[next]}`;
}
export function paintThemeButton(button, state, locale = 'en') {
  if (!button) return;
  button.dataset.mode = state.preference;
  button.setAttribute('aria-label', themeLabel(state.preference, locale));
  button.setAttribute('title', themeLabel(state.preference, locale));
  button.removeAttribute('aria-pressed');
  button.innerHTML = `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${themePaths[state.preference]}</svg>`;
}
export function createThemeController({storageKey, onChange = () => {}, colors}) {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const normalize = value => themeOrder.includes(value) ? value : 'system';
  const read = () => { try { return normalize(localStorage.getItem(storageKey)); } catch { return 'system'; } };
  let preference = read();
  const state = () => ({preference, resolved: preference === 'system' ? (media.matches ? 'dark' : 'light') : preference});
  function apply() {
    const current = state();
    const root = document.documentElement;
    root.dataset.themePreference = current.preference;
    root.dataset.theme = current.resolved;
    root.style.colorScheme = current.resolved;
    if (colors) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', colors[current.resolved]);
    onChange(current);
  }
  function choose(value) {
    preference = normalize(value);
    try { localStorage.setItem(storageKey, preference); } catch { /* Keep the in-memory choice. */ }
    apply();
  }
  const systemChanged = () => { if (preference === 'system') apply(); };
  const storageChanged = event => { if (event.key === storageKey || event.key === null) { preference = read(); apply(); } };
  media.addEventListener('change', systemChanged);
  window.addEventListener('storage', storageChanged);
  apply();
  return {state, choose, cycle: () => choose(themeOrder[(themeOrder.indexOf(preference) + 1) % 3]), destroy() {
    media.removeEventListener('change', systemChanged);
    window.removeEventListener('storage', storageChanged);
  }};
}
