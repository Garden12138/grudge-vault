import { useCallback, useEffect, useRef, useState } from "react";
import type { EventRecordDetail } from "@grudge-vault/domain";

export interface RecordDetailAccess {
  read(recordId: string): Promise<EventRecordDetail>;
  subscribe(onChanged: () => void): () => void;
}

/** Subscribe before opening a detail, and let only the latest live selection read publish. */
export function useRecordSelection(access: RecordDetailAccess) {
  const [selected, setSelected] = useState<EventRecordDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const recordId = useRef<string | undefined>(undefined);
  const snapshot = useRef<EventRecordDetail | null>(null);
  const readVersion = useRef(0);
  const mounted = useRef(false);

  const refresh = useCallback(async (): Promise<boolean> => {
    const id = recordId.current;
    if (!mounted.current || !id) return false;
    const version = ++readVersion.current;
    try {
      const detail = await access.read(id);
      if (!mounted.current || recordId.current !== id || version !== readVersion.current) return false;
      if (detail.record.id !== id) throw new Error("记录读取结果不匹配，请重新载入。");
      if (snapshot.current && detail.record.revision < snapshot.current.record.revision) return false;
      snapshot.current = detail;
      setSelected(detail); setError(null);
      return true;
    } catch (cause) {
      if (mounted.current && recordId.current === id && version === readVersion.current) setError(cause);
      return false;
    }
  }, [access]);

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = access.subscribe(() => { void refresh(); });
    return () => {
      mounted.current = false;
      recordId.current = undefined;
      readVersion.current += 1;
      unsubscribe();
    };
  }, [access, refresh]);

  const open = useCallback(async (id: string): Promise<boolean> => {
    if (!mounted.current) return false;
    recordId.current = id;
    readVersion.current += 1;
    snapshot.current = null;
    setSelected(null); setError(null);
    return refresh();
  }, [refresh]);

  const close = useCallback(() => {
    recordId.current = undefined;
    readVersion.current += 1;
    snapshot.current = null;
    setSelected(null); setError(null);
  }, []);

  const reload = useCallback(async (detail?: EventRecordDetail): Promise<boolean> => {
    if (!mounted.current || !recordId.current) return false;
    if (detail) {
      if (detail.record.id !== recordId.current ||
        (snapshot.current && detail.record.revision < snapshot.current.record.revision)) return false;
      readVersion.current += 1;
      snapshot.current = detail;
      setSelected(detail); setError(null);
    }
    // A task can finish while a user edit response is in flight. Always catch up
    // after applying that response, even if its completion notification was seen earlier.
    return refresh();
  }, [refresh]);

  return { selected, error, open, close, reload };
}
