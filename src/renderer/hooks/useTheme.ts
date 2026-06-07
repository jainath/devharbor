import { useEffect, useState } from 'react';
import type { SettingsState } from '@shared/ipc';

type Theme = SettingsState['theme'];

/**
 * Read the persisted theme setting and reflect it on `<html>` (Tailwind dark-mode strategy
 * is `class`, so the `dark` class on the root element flips the palette).
 *
 * - On mount, fetch the setting.
 * - On `prefers-color-scheme` change, re-evaluate (when theme=system).
 * - Polls every 2s for setting changes (cheap; avoids a separate event channel just for this).
 */
export function useTheme(): { theme: Theme; setTheme: (t: Theme) => Promise<void> } {
  const [theme, setLocalTheme] = useState<Theme>('system');

  useEffect(() => {
    let cancelled = false;
    const apply = (t: Theme): void => {
      const root = document.documentElement;
      const sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const useDark = t === 'dark' || (t === 'system' && sysDark);
      root.classList.toggle('dark', useDark);
      root.classList.toggle('light', !useDark);
    };

    const refresh = (): void => {
      void window.api.invoke('settings:get', undefined).then((s) => {
        if (cancelled) return;
        setLocalTheme(s.theme);
        apply(s.theme);
      });
    };
    refresh();

    const onSys = (): void => apply(theme);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', onSys);

    // SettingsDrawer dispatches this when any setting is saved.
    const onSettingsChanged = (): void => refresh();
    window.addEventListener('settings-changed', onSettingsChanged);

    return () => {
      cancelled = true;
      mq.removeEventListener('change', onSys);
      window.removeEventListener('settings-changed', onSettingsChanged);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-apply when theme changes locally.
  useEffect(() => {
    const root = document.documentElement;
    const sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const useDark = theme === 'dark' || (theme === 'system' && sysDark);
    root.classList.toggle('dark', useDark);
    root.classList.toggle('light', !useDark);
  }, [theme]);

  const setTheme = async (t: Theme): Promise<void> => {
    const next = await window.api.invoke('settings:set', { patch: { theme: t } });
    setLocalTheme(next.theme);
  };

  return { theme, setTheme };
}
