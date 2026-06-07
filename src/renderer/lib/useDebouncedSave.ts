import { useCallback, useEffect, useRef } from 'react';

/**
 * Coalesce a stream of partial saves into one debounced call.
 *
 * - Calls accumulate via Object.assign (shallow merge).
 * - The save function fires `delay` ms after the last call.
 * - Pending changes are flushed on unmount.
 * - Returned `flush()` lets the caller force an immediate save (e.g. before switching contexts).
 */
export function useDebouncedSave<P extends object>(
  save: (patch: P) => Promise<void> | void,
  delay = 300
): { queue: (patch: P) => void; flush: () => void } {
  const pendingRef = useRef<P>({} as P);
  const timerRef = useRef<number | null>(null);
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  }, [save]);

  const flush = useCallback((): void => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (Object.keys(pendingRef.current as object).length === 0) return;
    const p = pendingRef.current;
    pendingRef.current = {} as P;
    void saveRef.current(p);
  }, []);

  const queue = useCallback(
    (patch: P): void => {
      Object.assign(pendingRef.current as object, patch);
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(flush, delay);
    },
    [flush, delay]
  );

  useEffect(() => {
    return () => flush();
  }, [flush]);

  return { queue, flush };
}
