import { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient, getErrorMessage } from './api.ts';
import type { Paged } from './types.ts';

export function useLoad<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await loaderRef.current();
      setData(result);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, loading, error, reload, setData };
}

export function useStream() {
  const [text, setText] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [label, setLabel] = useState('');
  const controllerRef = useRef<AbortController | null>(null);

  return {
    text, setText, running, setRunning, error, setError, label, setLabel,
    /** 传给 streamTask 的中断信号；上一次已 abort 时自动换新的。 */
    get signal(): AbortSignal {
      if (!controllerRef.current || controllerRef.current.signal.aborted) controllerRef.current = new AbortController();
      return controllerRef.current.signal;
    },
    /** 切换选中项或离开页面时调用，否则旧对象的流会继续写进新对象的面板。 */
    cancel: () => { controllerRef.current?.abort(); controllerRef.current = null; },
    /** 清空面板，同时中止在跑的生成——切换对象时必须调用。 */
    reset: () => { controllerRef.current?.abort(); controllerRef.current = null; setText(''); setError(''); setLabel(''); },
  };
}

/**
 * 分页列表（「加载更多」形态）。
 * `path` 里可以带查询串（如 `/api/papers?q=…`），hook 自己追加 `limit` / `offset`。
 * `reload()` 回到第一页并替换，`loadMore()` 追加下一页。
 */
export function usePaged<T>(path: string, pageSize = 20) {
  const [items, setItems] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (offset: number) => {
    setLoading(true);
    setError('');
    try {
      const separator = path.includes('?') ? '&' : '?';
      const result = await apiClient.get<Paged<T>>(`${path}${separator}limit=${pageSize}&offset=${offset}`);
      setItems((previous) => (offset === 0 ? result.items : [...previous, ...result.items]));
      setTotal(result.total);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [path, pageSize]);

  useEffect(() => { void load(0); }, [load]);

  return {
    items, total, loading, error,
    hasMore: items.length < total,
    loadMore: () => load(items.length),
    reload: () => load(0),
  };
}
