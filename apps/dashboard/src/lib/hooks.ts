import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

/** Load data, optionally polling. Errors surface as toasts (once per distinct message). */
export function useLoader<T>(fn: () => Promise<T>, deps: unknown[] = [], pollMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const lastError = useRef<string | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const reload = useCallback(async () => {
    try {
      const d = await fnRef.current();
      setData(d);
      lastError.current = null;
    } catch (e) {
      const msg = (e as Error).message;
      if (msg !== lastError.current) toast.error(msg);
      lastError.current = msg;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void reload();
    if (!pollMs) return;
    const t = setInterval(() => void reload(), pollMs);
    return () => clearInterval(t);
  }, [reload, pollMs, ...deps]);

  return { data, loading, reload, setData };
}

/** Run a mutation with toast feedback. Returns true on success. */
export async function act(fn: () => Promise<unknown>, success?: string): Promise<boolean> {
  try {
    await fn();
    if (success) toast.success(success);
    return true;
  } catch (e) {
    toast.error((e as Error).message);
    return false;
  }
}

export async function copy(text: string, what = "Copied to clipboard") {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(what);
  } catch {
    toast.error("Clipboard unavailable — select and copy manually");
  }
}
