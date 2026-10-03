'use client';

import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';

export type Theme = 'dark' | 'light';
export const THEME_STORAGE_KEY = 'bag-protocol:theme';

/**
 * Inline script for <head>: applies a saved light theme before the first
 * paint, so a light-theme visitor never sees a flash of the dark page.
 */
export const THEME_BOOT_SCRIPT = `try{if(localStorage.getItem('${THEME_STORAGE_KEY}')==='light'){document.documentElement.dataset.theme='light'}}catch(e){}`;

function readTheme(): Theme {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

export function applyTheme(theme: Theme): void {
  if (theme === 'light') document.documentElement.dataset.theme = 'light';
  else delete document.documentElement.dataset.theme;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Private mode / storage blocked: the theme still applies for this visit.
  }
}

/** One-click dark / light switch. The choice is remembered in this browser. */
export function ThemeToggle({ className = '' }: { className?: string }) {
  const [theme, setTheme] = useState<Theme>('dark');
  useEffect(() => setTheme(readTheme()), []);

  const next: Theme = theme === 'light' ? 'dark' : 'light';
  return (
    <button
      type="button"
      className={`theme-toggle ${className}`}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      onClick={() => {
        applyTheme(next);
        setTheme(next);
      }}
    >
      {theme === 'light' ? <Moon size={15} /> : <Sun size={15} />}
    </button>
  );
}
