import { useCallback, useEffect, useRef, useState } from "react";
import type { EventRecord, TimelineFilter, TimelinePage } from "@grudge-vault/domain";

export interface TimelineAccess {
  read(filter: TimelineFilter): Promise<TimelinePage>;
  subscribe(listener: () => void): () => void;
}
interface TimelineState {
  filter: TimelineFilter; records: EventRecord[]; nextCursor?: string | undefined; timeZone: string;
  hasRead: boolean; loading: boolean; refreshing: boolean; loadingMore: boolean; error?: Error | undefined;
}
interface TimelineScope { state: TimelineState; request: number; loadedCount: number; more: boolean; }
const localTimeZone = () => new Intl.DateTimeFormat().resolvedOptions().timeZone;
const readFailure = (cause: unknown): Error => cause instanceof Error ? cause : new Error("时间线读取未完成，请重新载入。");
const initialState = (filter: TimelineFilter): TimelineState => ({ filter, records: [], timeZone: "UTC",
  hasRead: false, loading: true, refreshing: false, loadingMore: false });

/** Read-only list ownership; failed/new-filter reads are not empty successful snapshots. */
export function useTimelineRecords(access: TimelineAccess, filter: TimelineFilter, readTimeZone = localTimeZone) {
  const [state, setState] = useState<TimelineState>(() => initialState(filter));
  const active = useRef<TimelineScope | undefined>(undefined);
  const isCurrent = useCallback((scope: TimelineScope, request: number) => active.current === scope && scope.request === request, []);
  const publish = useCallback((scope: TimelineScope, value: TimelineState) => {
    if (active.current !== scope) return;
    scope.state = value; setState(value);
  }, []);
  const reload = useCallback(async (): Promise<boolean> => {
    const scope = active.current;
    if (!scope) return false;
    const request = ++scope.request, target = scope.loadedCount;
    scope.more = false;
    publish(scope, { ...scope.state, loading: !scope.state.hasRead, refreshing: scope.state.hasRead,
      loadingMore: false, error: undefined });
    try {
      const timeZone = readTimeZone(), records: EventRecord[] = [], cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        if (!isCurrent(scope, request)) return false;
        if (cursor) cursors.add(cursor);
        const query: TimelineFilter = { ...scope.state.filter, timeZone, limit: Math.min(100, target - records.length) };
        delete query.cursor; if (cursor) query.cursor = cursor;
        const page = await access.read(query);
        if (!isCurrent(scope, request)) return false;
        if (page.nextCursor && (!page.records.length || cursors.has(page.nextCursor))) {
          throw new Error("时间线分页未能继续，请重新载入。");
        }
        records.push(...page.records); cursor = page.nextCursor;
      } while (cursor && records.length < target);
      publish(scope, { ...scope.state, records, nextCursor: cursor, timeZone, hasRead: true,
        loading: false, refreshing: false, loadingMore: false, error: undefined });
      return true;
    } catch (cause) {
      if (isCurrent(scope, request)) publish(scope, { ...scope.state, loading: false, refreshing: false,
        loadingMore: false, error: readFailure(cause) });
      return false;
    }
  }, [access, isCurrent, publish, readTimeZone]);
  const loadMore = useCallback(async (): Promise<boolean> => {
    const scope = active.current;
    if (!scope || scope.more || scope.state.loading || scope.state.refreshing || !scope.state.nextCursor) return false;
    const snapshot = scope.state, cursor = snapshot.nextCursor!, request = ++scope.request;
    scope.more = true; publish(scope, { ...snapshot, loadingMore: true, error: undefined });
    try {
      const page = await access.read({ ...snapshot.filter, timeZone: snapshot.timeZone, cursor });
      if (!isCurrent(scope, request)) return false;
      if (page.nextCursor && (!page.records.length || page.nextCursor === cursor)) throw new Error("时间线分页未能继续，请重新载入。");
      scope.loadedCount += page.records.length;
      publish(scope, { ...snapshot, records: [...snapshot.records, ...page.records], nextCursor: page.nextCursor,
        loadingMore: false, error: undefined });
      return true;
    } catch (cause) {
      if (isCurrent(scope, request)) publish(scope, { ...snapshot, loadingMore: false, error: readFailure(cause) });
      return false;
    } finally { if (isCurrent(scope, request)) scope.more = false; }
  }, [access, isCurrent, publish]);
  useEffect(() => {
    const scope: TimelineScope = { state: initialState(filter), request: 0,
      loadedCount: Math.max(1, Math.min(filter.limit ?? 60, 100)), more: false };
    active.current = scope; publish(scope, scope.state);
    // Subscribe before the first request; a push during that request must supersede it.
    const unsubscribe = access.subscribe(() => { void reload(); });
    void reload();
    return () => { scope.request++; scope.more = false; if (active.current === scope) active.current = undefined; unsubscribe(); };
  }, [access, filter, publish, reload]);
  // Hide the old filter synchronously, before the effect establishes the next scope.
  const visible = state.filter === filter ? state : initialState(filter);
  return { ...visible, reload, loadMore };
}
