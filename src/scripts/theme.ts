import { announce } from './announce';
import { site } from '../data/site';

type Theme = 'dark' | 'light';

const THEME_COLOR: Record<Theme, string> = { dark: '#16181a', light: '#fbf1c7' };
const root = document.documentElement;
const themeColorMeta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
const toggles = document.querySelectorAll<HTMLButtonElement>('[data-theme-toggle]');

const currentTheme = (): Theme => (root.dataset.theme === 'light' ? 'light' : 'dark');

function sync() {
  const theme = currentTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  themeColorMeta?.setAttribute('content', THEME_COLOR[theme]);
  toggles.forEach((button) => button.setAttribute('aria-label', `Switch to ${next} theme`));
}

toggles.forEach((button) => {
  button.addEventListener('click', () => {
    const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    try {
      localStorage.setItem(site.themeStorageKey, next);
    } catch {
      // Storage can be unavailable (private mode, blocked cookies); the choice just won't persist.
    }
    sync();
    announce(`${next === 'dark' ? 'Dark' : 'Light'} theme`);
  });
});

sync();
