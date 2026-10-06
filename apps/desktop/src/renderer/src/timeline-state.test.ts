// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EventRecord, TimelinePage, TimelineFilter } from "@grudge-vault/domain";
import type { GrudgeVaultApi, IpcResult } from "@grudge-vault/shared";
import { TimelineView } from "./App";

const stamp = "2026-10-02T00:00:00Z";
const record = (id: string): EventRecord => ({ id, title: id, summary: "仅供时间线合成回归", origin: "manual", categories: ["rights"],
  revision: 1, occurredAt: { kind: "unknown" }, recordedAt: stamp, reportState: "complete", sourceUpdated: false,
  sourceReviewRequired: false, attachmentCount: 0, createdAt: stamp, updatedAt: stamp });
const success = (records: EventRecord[], nextCursor?: string): IpcResult<TimelinePage> => ({ ok: true,
  data: { records, ...(nextCursor ? { nextCursor } : {}) } });
const failed: IpcResult<TimelinePage> = { ok: false, error: { code: "WORKSPACE_INVALID", message: "合成读取失败", retryable: true } };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
let root: Root | undefined, original: GrudgeVaultApi;
beforeEach(() => { original = window.grudgeVault; vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); });
afterEach(async () => { if (root) await act(async () => root?.unmount()); root = undefined;
  window.grudgeVault = original; document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function fixture() {
  const listeners = new Set<() => void>();
  const read = vi.fn(async () => success([]));
  const onNew = vi.fn(), onSettings = vi.fn();
  window.grudgeVault = { records: { timeline: (filter: TimelineFilter) => filter.limit === 1 ? Promise.resolve(success([])) : read() }, jobs: { onChanged(listener: () => void) {
    listeners.add(listener); return () => listeners.delete(listener);
  } } } as unknown as GrudgeVaultApi;
  return { read, onNew, onSettings, async mount() {
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root?.render(createElement(TimelineView, { onNew, onSettings, pendingCount: 0,
      onPending: vi.fn(), onRecordOpened: vi.fn() })));
  }, async changed() { await act(async () => listeners.forEach((listener) => listener())); } };
}
function button(label: string): globalThis.HTMLButtonElement {
  const result = Array.from(document.querySelectorAll("button")).find(({ textContent }) => textContent === label);
  if (!result) throw new Error(`Synthetic button missing: ${label}`); return result;
}
async function category(value: string) {
  const select = document.querySelector<globalThis.HTMLSelectElement>(".filter-bar select")!;
  await act(async () => { select.value = value; select.dispatchEvent(new globalThis.Event("change", { bubbles: true })); });
}

it("does not call a failed first read empty and retries only the timeline read", async () => {
  const test = await fixture(); test.read.mockResolvedValueOnce(failed); await test.mount();
  expect(document.querySelector(".empty-state")).toBeNull();
  expect(document.body.textContent).toContain("暂时无法读取时间线");
  await act(async () => button("重新载入时间线").click());
  expect(document.querySelector(".empty-state")).not.toBeNull();
  expect(test.read).toHaveBeenCalledTimes(2); expect(test.onNew).not.toHaveBeenCalled(); expect(test.onSettings).not.toHaveBeenCalled();
});

it("does not show an old list under a new failed filter or treat the new filter as empty", async () => {
  const test = await fixture(); test.read.mockResolvedValueOnce(success([record("旧条件合成记录")])).mockResolvedValueOnce(failed);
  await test.mount(); expect(document.querySelector(".timeline-groups")?.textContent).toContain("旧条件合成记录");
  await category("danger");
  expect(document.querySelector(".timeline-groups")).toBeNull(); expect(document.querySelector(".empty-state")).toBeNull();
  expect(document.body.textContent).toContain("暂时无法读取时间线");
});

it.each(["success", "failure"] as const)("releases old pagination on a filter change and ignores its late %s without clearing the new pagination state", async (outcome) => {
  const test = await fixture(), old = deferred<IpcResult<TimelinePage>>(), current = deferred<IpcResult<TimelinePage>>();
  const records = (prefix: string) => Array.from({ length: 60 }, (_, i) => record(`${prefix}-${i}`));
  test.read.mockResolvedValueOnce(success(records("旧条件第一页"), "old-cursor")).mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce(success(records("当前条件第一页"), "current-cursor")).mockReturnValueOnce(current.promise);
  await test.mount(); await act(async () => button("载入更多").click()); await category("danger");
  const more = button("载入更多"); expect(more.disabled).toBe(false);
  await act(async () => more.click());
  await act(async () => old.resolve(outcome === "success" ? success([record("迟到的旧页")]) : failed));
  expect(button("正在载入…").disabled).toBe(true); expect(document.body.textContent).not.toContain("迟到的旧页");
  expect(document.body.textContent).not.toContain("合成读取失败");
  await act(async () => current.resolve(success([record("当前条件第二页")])));
  expect(document.querySelector(".timeline-groups")?.textContent).toContain("当前条件第二页");
});

it("labels a failed background refresh while retaining only the last successful same-filter list", async () => {
  const test = await fixture(); test.read.mockResolvedValueOnce(success([record("上次成功的合成记录")])).mockResolvedValueOnce(failed);
  await test.mount(); await test.changed();
  expect(document.querySelector(".timeline-groups")?.textContent).toContain("上次成功的合成记录");
  expect(document.body.textContent).toContain("上次成功读取");
  expect(document.querySelector(".empty-state")).toBeNull();
  await act(async () => button("重新载入时间线").click());
  expect(document.querySelector(".empty-state")).not.toBeNull();
});

it("does not request a follow-up refresh page when a held first page arrives after unmount", async () => {
  const test = await fixture(), held = deferred<IpcResult<TimelinePage>>();
  const records = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => record(`${prefix}-${i}`));
  test.read.mockResolvedValueOnce(success(records("first", 60), "first-next"))
    .mockResolvedValueOnce(success(records("more", 60))).mockReturnValueOnce(held.promise);
  await test.mount(); await act(async () => button("载入更多").click()); await test.changed();
  expect(test.read).toHaveBeenCalledTimes(3);
  await act(async () => root?.unmount()); root = undefined;
  await act(async () => held.resolve(success(records("held", 100), "held-next")));
  expect(test.read).toHaveBeenCalledTimes(3);
});
