import { useCallback, useEffect, useState } from 'react';

export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'mirelth.theme';

function isMode(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system';
}

function readMode(): ThemeMode {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isMode(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

const systemQuery = (): MediaQueryList | null =>
  typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;

function resolve(mode: ThemeMode): ResolvedTheme {
  if (mode === 'system') return systemQuery()?.matches ? 'dark' : 'light';
  return mode;
}

/** 主题写在 `<html data-theme>` 上，CSS 只认这个属性；`system` 跟随系统并实时响应。 */
function apply(mode: ThemeMode): void {
  document.documentElement.dataset.theme = resolve(mode);
}

/**
 * 外观设置：浅色 / 深色 / 系统，存 localStorage。
 * `system` 模式下监听系统配色变化，切到浅/深色时摘掉监听。
 */
export function useTheme(): { mode: ThemeMode; resolved: ResolvedTheme; setMode: (mode: ThemeMode) => void } {
  const [mode, setModeState] = useState<ThemeMode>(readMode);
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolve(readMode()));

  useEffect(() => {
    apply(mode);
    setResolved(resolve(mode));
    if (mode !== 'system') return;
    const query = systemQuery();
    if (!query) return;
    const onChange = () => {
      apply('system');
      setResolved(resolve('system'));
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [mode]);

  const setMode = useCallback((next: ThemeMode) => {
    try { window.localStorage.setItem(STORAGE_KEY, next); } catch { /* 隐私模式写不进去，跟随本次会话即可 */ }
    setModeState(next);
  }, []);

  return { mode, resolved, setMode };
}
