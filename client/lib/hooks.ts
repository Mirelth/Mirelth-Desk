import { useCallback, useEffect, useRef, useState } from 'react';
import { getErrorMessage } from './api.ts';

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

  return {
    text, setText, running, setRunning, error, setError, label, setLabel,
    reset: () => { setText(''); setError(''); setLabel(''); },
  };
}
