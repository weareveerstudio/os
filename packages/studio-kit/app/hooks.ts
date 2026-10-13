import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "./ui-client.js";

/** The state of a polled read. */
export type Polled<T> = {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  /** Reloads now, outside the polling interval. */
  refresh(): Promise<void>;
};

/**
 * Loads data and reloads it on an interval while the page is visible. The host has no live push, so
 * an app polls to see other people's and agents' changes.
 *
 * A response that arrives after a newer request was started is dropped, so a slow poll never
 * overwrites a fresh refresh.
 * @param load Reads the data, usually one `ui` call.
 * @param options `intervalMs` (default 15 s, 0 to disable) and `deps`, which restart the load.
 * @returns The latest data, error and loading flag.
 */
export function usePolled<T>(
  load: () => Promise<T>,
  options: { intervalMs?: number; deps?: readonly unknown[] } = {},
): Polled<T> {
  const { intervalMs = 15_000, deps = [] } = options;
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const latest = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  const refresh = useCallback(async () => {
    const request = ++latest.current;
    try {
      const value = await loadRef.current();
      if (request !== latest.current) return;
      setData(value);
      setError(null);
    } catch (caught) {
      if (request !== latest.current) return;
      setError(errorMessage(caught));
    } finally {
      if (request === latest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void refresh();
    if (!intervalMs) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      // Invalidate whatever is in flight for the previous deps.
      latest.current++;
    };
    // `deps` is the caller's dependency list; `refresh` is stable.
  }, [refresh, intervalMs, ...deps]);

  return { data, error, loading, refresh };
}

/** A write in progress, and its failure. */
export type Mutation = {
  pending: boolean;
  error: string | null;
  /** Runs `write`, recording pending state and a failure message. Resolves undefined on failure. */
  run<T>(write: () => Promise<T>): Promise<T | undefined>;
  clearError(): void;
};

/**
 * Tracks one kind of write: a form submit, an archive button.
 * @returns The mutation state and runner.
 */
export function useMutation(): Mutation {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(write: () => Promise<T>): Promise<T | undefined> => {
    setPending(true);
    setError(null);
    try {
      return await write();
    } catch (caught) {
      setError(errorMessage(caught));
      return undefined;
    } finally {
      setPending(false);
    }
  }, []);
  const clearError = useCallback(() => setError(null), []);
  return { pending, error, run, clearError };
}
