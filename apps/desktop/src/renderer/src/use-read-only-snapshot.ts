import { useCallback, useEffect, useRef, useState } from "react";

export type SnapshotRead<T> = { kind: "loaded"; value: T } | { kind: "failed"; error: Error } | { kind: "stale" };
interface Snapshot<T> { value?: T; loading: boolean; error?: Error | undefined; version: number; }
interface Scope { request: number; command: number; }
type Subscribe = (listener: () => void) => () => void;
const asError = (cause: unknown) => cause instanceof Error ? cause : new Error("设置读取未完成，请重新读取。");

/** One read authority for initial, notification and polling reads; no persistence or writes. */
export function useReadOnlySnapshot<T>(read: () => Promise<T>, subscribe?: Subscribe) {
  const [snapshot, setSnapshot] = useState<Snapshot<T>>({ loading: true, version: 0 });
  const active = useRef<Scope | undefined>(undefined);
  const reload = useCallback(async (): Promise<SnapshotRead<T>> => {
    const scope = active.current;
    if (!scope) return { kind: "stale" };
    const request = ++scope.request;
    setSnapshot(previous => ({ ...previous, loading: true, error: undefined }));
    try {
      const value = await read();
      if (active.current !== scope || scope.request !== request) return { kind: "stale" };
      setSnapshot(previous => ({ value, loading: false, version: previous.version + 1 })); return { kind: "loaded", value };
    } catch (cause) {
      if (active.current !== scope || scope.request !== request) return { kind: "stale" };
      const error = asError(cause);
      setSnapshot(previous => ({ ...previous, loading: false, error })); return { kind: "failed", error };
    }
  }, [read]);
  // Capture at the user's command start, not after its reply. Applying the actual command
  // result supersedes all reads started before or during it, but cannot cross a lifetime.
  const captureCommit = useCallback(() => {
    const scope = active.current;
    const command = scope ? ++scope.command : undefined;
    if (scope) { scope.request++; setSnapshot(previous => ({ ...previous, loading: false })); }
    const isCurrent = () => Boolean(scope && active.current === scope && scope.command === command);
    return { isCurrent, publish: (value: T): boolean => {
      if (!scope || !isCurrent()) return false;
      scope.request++; setSnapshot(previous => ({ value, loading: false, version: previous.version + 1 })); return true;
    } };
  }, []);
  useEffect(() => {
    const scope: Scope = { request: 0, command: 0 }; active.current = scope;
    setSnapshot({ loading: true, version: 0 });
    const unsubscribe = subscribe?.(() => { void reload(); });
    void reload();
    return () => { scope.request++; if (active.current === scope) active.current = undefined; unsubscribe?.(); };
  }, [read, reload, subscribe]);
  return { ...snapshot, reload, captureCommit };
}
