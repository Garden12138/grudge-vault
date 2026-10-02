// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EventRecord, TimelineFilter, TimelinePage } from "@grudge-vault/domain";
import { useTimelineRecords, type TimelineAccess } from "./use-timeline-records";

const stamp = "2026-10-02T00:00:00Z";
const records = (prefix: string, count: number): EventRecord[] => Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}`,
  title: "合成时间线", summary: "仅供离线生命周期测试", origin: "manual", categories: ["rights"], revision: 1,
  occurredAt: { kind: "unknown" }, recordedAt: stamp, reportState: "complete", sourceUpdated: false,
  sourceReviewRequired: false, attachmentCount: 0, createdAt: stamp, updatedAt: stamp }));
const page = (prefix: string, count: number, nextCursor?: string): TimelinePage => ({ records: records(prefix, count), ...(nextCursor ? { nextCursor } : {}) });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
let root: Root | undefined;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => { if (root) await act(async () => root?.unmount()); root = undefined; document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function fixture(duringSubscribe?: (listener: () => void) => void) {
  const read = vi.fn(async (filter: TimelineFilter): Promise<TimelinePage> => { void filter; return { records: [] }; });
  const listeners = new Set<() => void>(), timeZone = vi.fn(() => "UTC");
  const access: TimelineAccess = { read, subscribe(listener) { listeners.add(listener); duringSubscribe?.(listener); return () => listeners.delete(listener); } };
  let current!: ReturnType<typeof useTimelineRecords>;
  function Harness({ filter }: { filter: TimelineFilter }) { current = useTimelineRecords(access, filter, timeZone); return createElement("span", null, current.records.length); }
  const filter: TimelineFilter = { limit: 60 };
  return { read, listeners, timeZone, get current() { return current; }, async mount(strict = false) {
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root?.render(strict ? createElement(StrictMode, null, createElement(Harness, { filter })) : createElement(Harness, { filter })));
  }, async changed() { await act(async () => listeners.forEach((listener) => listener())); } };
}

it("subscribes before the initial read and only accepts the newest same-filter reply", async () => {
  const test = fixture((listener) => listener()), old = deferred<TimelinePage>();
  test.read.mockReturnValueOnce(old.promise).mockResolvedValueOnce(page("current", 1)); await test.mount();
  await act(async () => old.resolve(page("old", 1)));
  expect(test.current.records[0]?.id).toBe("current-0"); expect(test.read).toHaveBeenCalledTimes(2);
});

it("balances StrictMode subscriptions and discards the first setup's held reply", async () => {
  const test = fixture(), old = deferred<TimelinePage>();
  test.read.mockReturnValueOnce(old.promise).mockResolvedValueOnce(page("current", 1)); await test.mount(true);
  expect(test.listeners.size).toBe(1); expect(test.read).toHaveBeenCalledTimes(2);
  await act(async () => old.resolve(page("old", 1)));
  expect(test.current.records[0]?.id).toBe("current-0");
  await act(async () => root?.unmount()); root = undefined; expect(test.listeners.size).toBe(0);
});

it("refreshes all loaded pages atomically using one captured timezone and keeps pagination on that timezone", async () => {
  const test = fixture(), held = deferred<TimelinePage>();
  test.read.mockResolvedValueOnce(page("first", 60, "first-next")).mockResolvedValueOnce(page("more", 60))
    .mockReturnValueOnce(held.promise).mockResolvedValueOnce(page("refresh-tail", 20, "refresh-next"));
  await test.mount(); await act(async () => { await test.current.loadMore(); });
  test.timeZone.mockReturnValue("Asia/Tokyo"); await test.changed();
  expect(test.current.records).toHaveLength(120); expect(test.current.records[0]?.id).toBe("first-0");
  expect(test.current.refreshing).toBe(true); expect(test.current.timeZone).toBe("UTC");
  test.timeZone.mockReturnValue("America/New_York"); await act(async () => held.resolve(page("refresh", 100, "refresh-middle")));
  expect(test.current.records).toHaveLength(120); expect(test.current.records[0]?.id).toBe("refresh-0");
  expect(test.current.refreshing).toBe(false); expect(test.current.timeZone).toBe("Asia/Tokyo");
  expect(test.read.mock.calls[2]?.[0]).toMatchObject({ limit: 100, timeZone: "Asia/Tokyo" });
  expect(test.read.mock.calls[3]?.[0]).toMatchObject({ limit: 20, timeZone: "Asia/Tokyo", cursor: "refresh-middle" });
  test.read.mockResolvedValueOnce(page("next", 1)); await act(async () => { await test.current.loadMore(); });
  expect(test.read.mock.calls[4]?.[0]).toMatchObject({ timeZone: "Asia/Tokyo", cursor: "refresh-next" });
  expect(test.current.records).toHaveLength(121);
});

it("keeps a failed pagination cursor retryable without incrementing the loaded target or losing the first page", async () => {
  const test = fixture(); test.read.mockResolvedValueOnce(page("first", 60, "next")).mockRejectedValueOnce(new Error("Synthetic page read failed"));
  await test.mount(); await act(async () => { await test.current.loadMore(); });
  expect(test.current.records).toHaveLength(60); expect(test.current.nextCursor).toBe("next"); expect(test.current.loadingMore).toBe(false);
  test.read.mockResolvedValueOnce(page("second", 60)); await act(async () => { await test.current.loadMore(); });
  expect(test.read.mock.calls[2]?.[0].cursor).toBe("next"); expect(test.current.records).toHaveLength(120); expect(test.current.error).toBeUndefined();
  test.read.mockResolvedValueOnce(page("refresh", 100, "tail")).mockResolvedValueOnce(page("tail", 20));
  await act(async () => { await test.current.reload(); }); expect(test.read.mock.calls[4]?.[0].limit).toBe(20);
});

it.each(["empty", "repeated"] as const)("rejects a %s continuing page without requesting indefinitely or replacing a complete snapshot", async (kind) => {
  const test = fixture(); test.read.mockResolvedValueOnce(page("first", 60, "next")).mockResolvedValueOnce(page("second", 60));
  await test.mount(); await act(async () => { await test.current.loadMore(); });
  test.read.mockResolvedValueOnce(page("refresh", 100, "same")).mockResolvedValueOnce(page("invalid", kind === "empty" ? 0 : 5, "same"));
  await act(async () => { await test.current.reload(); });
  expect(test.read).toHaveBeenCalledTimes(4); expect(test.current.records).toHaveLength(120);
  expect(test.current.records[0]?.id).toBe("first-0"); expect(test.current.error?.message).toContain("分页未能继续");
});

it("makes a non-Error failed first read visibly unavailable instead of a successful empty snapshot", async () => {
  const test = fixture(); test.read.mockRejectedValueOnce(undefined); await test.mount();
  expect(test.current.hasRead).toBe(false); expect(test.current.loading).toBe(false); expect(test.current.error).toBeInstanceOf(Error);
  expect(test.current.records).toEqual([]);
});
