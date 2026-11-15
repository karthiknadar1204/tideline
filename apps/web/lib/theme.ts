export const themePreferences = ["system", "light", "dark"] as const;
export type ThemePreference = (typeof themePreferences)[number];
export const themeStorageKey = "tideline-theme";
export const themeChangeEvent = "tideline-theme-change";

export const themeScript = `(() => {
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  const update = () => {
    let preference;
    try { preference = localStorage.getItem('${themeStorageKey}'); } catch {}
    document.documentElement.dataset.theme = preference === 'light' || preference === 'dark'
      ? preference : system.matches ? 'dark' : 'light';
  };
  update();
  system.addEventListener('change', update);
  window.addEventListener('storage', update);
  window.addEventListener('${themeChangeEvent}', update);
})();`;
