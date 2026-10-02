// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeMediaProgress, PreparedSearchQuery, RecordSearchPage } from "@grudge-vault/domain";
import type { GrudgeVaultApi, IpcResult } from "@grudge-vault/shared";
import { SearchView } from "./App";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve };
}
const sessionId = "00000000-0000-4000-8000-000000000001";
const progress: NativeMediaProgress & { sessionId: string } = { sessionId, mediaId: "00000000-0000-4000-8000-000000000002",
  mediaNumber: 1, mediaCount: 1, stage: "understanding", segmentNumber: 1, checkedDurationMs: 0, sourceDurationMs: 48_000 };
const prepared: IpcResult<PreparedSearchQuery> = { ok: true, data: { sessionId, textLength: 0, attachments: [], expiresAt: "2099-01-01T00:00:00Z" } };
const page: IpcResult<RecordSearchPage> = { ok: true, data: { hits: [], capabilities: { keyword: "ready", semantic: "ready", media: "ready" } } };

describe("search media progress and explicit cancellation", () => {
  let root: Root | undefined; let original: GrudgeVaultApi;
  beforeEach(() => { original = window.grudgeVault; vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); });
  afterEach(async () => { if (root) await act(async () => root?.unmount()); root = undefined;
    window.grudgeVault = original; document.body.replaceChildren(); vi.unstubAllGlobals(); });

  it.each(["preparation", "model", "keyword"] as const)("does not claim an empty result or unavailable capability while %s is pending", async (phase) => {
    const prepare = deferred<IpcResult<PreparedSearchQuery>>(), execute = deferred<IpcResult<RecordSearchPage>>();
    const records = { onSearchMediaProgress: () => () => {}, prepareSearch: vi.fn(() => prepare.promise),
      executeSearch: vi.fn(() => execute.promise), search: vi.fn(() => execute.promise),
      abandonSearchPreparation: vi.fn(async () => ({ ok: true, data: undefined })),
      abandonSearch: vi.fn(async () => ({ ok: true, data: undefined })) };
    window.grudgeVault = { records, jobs: { onChanged: () => () => {} } } as unknown as GrudgeVaultApi;
    const container = document.body.appendChild(document.createElement("div")); root = createRoot(container);
    await act(async () => root?.render(createElement(SearchView)));
    if (phase !== "keyword") {
      const file = container.querySelector<HTMLInputElement>('input[type="file"]')!;
      Object.defineProperty(file, "files", { configurable: true, value: [new File(["synthetic"], "query.png", { type: "image/png" })] });
      await act(async () => file.dispatchEvent(new globalThis.Event("change", { bubbles: true })));
    }
    await act(async () => container.querySelector("form")!.dispatchEvent(new globalThis.Event("submit", { bubbles: true, cancelable: true })));
    if (phase === "model") await act(async () => prepare.resolve(prepared));
    expect(container.querySelector(".stage-progress")?.textContent).toContain("正在处理本次查询");
    expect(container.querySelector(".empty-state")).toBeNull();
    expect(container.querySelector(".search-capabilities")).toBeNull();
    await act(async () => { prepare.resolve(prepared); execute.resolve(page); });
    expect(container.querySelector(".stage-progress")).toBeNull();
    expect(container.querySelector(".empty-state h2")?.textContent).toBe("没有找到相关正式记录");
  });

  it.each(["hits", "empty"] as const)("clears previous %s feedback immediately on a new submission, including while old-session cleanup waits", async (previous) => {
    const now = "2026-10-02T00:00:00Z", prepareAgain = deferred<IpcResult<PreparedSearchQuery>>();
    const abandon = deferred<IpcResult<void>>();
    const first: IpcResult<RecordSearchPage> = { ok: true, data: { capabilities: { keyword: "ready", semantic: "ready", media: "ready" },
      ...(previous === "hits" ? { nextCursor: "synthetic-next-page" } : {}), hits: previous === "hits" ? [{ explanation: "旧查询命中", record: {
        id: "old-query-record", title: "仅属于旧查询的合成命中", summary: "合成摘要", origin: "manual", categories: ["rights"], revision: 1,
        occurredAt: { kind: "unknown" }, recordedAt: now, reportState: "complete", sourceUpdated: false,
        sourceReviewRequired: false, attachmentCount: 0, createdAt: now, updatedAt: now } }] : [] } };
    const records = { onSearchMediaProgress: () => () => {},
      prepareSearch: vi.fn().mockResolvedValueOnce(prepared).mockReturnValueOnce(prepareAgain.promise),
      executeSearch: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(page),
      abandonSearchPreparation: vi.fn(async () => ({ ok: true, data: undefined })),
      abandonSearch: vi.fn(() => abandon.promise) };
    window.grudgeVault = { records, jobs: { onChanged: () => () => {} } } as unknown as GrudgeVaultApi;
    const container = document.body.appendChild(document.createElement("div")); root = createRoot(container);
    await act(async () => root?.render(createElement(SearchView)));
    const addFile = async () => {
      const file = container.querySelector<HTMLInputElement>('input[type="file"]')!;
      Object.defineProperty(file, "files", { configurable: true, value: [new File(["synthetic"], "query.png", { type: "image/png" })] });
      await act(async () => file.dispatchEvent(new globalThis.Event("change", { bubbles: true })));
    };
    const submit = () => container.querySelector("form")!.dispatchEvent(new globalThis.Event("submit", { bubbles: true, cancelable: true }));
    await addFile(); await act(async () => { submit(); });
    expect(container.querySelector(previous === "hits" ? ".search-results" : ".empty-state")).not.toBeNull();
    await addFile(); await act(async () => { submit(); });
    expect(container.querySelector(".stage-progress")).not.toBeNull();
    expect(container.querySelector(".search-results")).toBeNull();
    expect(container.querySelector(".empty-state")).toBeNull();
    expect(container.querySelector(".search-capabilities")).toBeNull();
    expect(container.textContent).not.toContain("载入更多");
    if (previous === "hits") {
      expect(records.prepareSearch).toHaveBeenCalledOnce();
      await act(async () => abandon.resolve({ ok: true, data: undefined }));
    }
    await act(async () => prepareAgain.resolve(prepared));
    expect(container.querySelector(".stage-progress")).toBeNull();
    expect(container.textContent).not.toContain("仅属于旧查询的合成命中");
    expect(container.querySelector(".empty-state h2")?.textContent).toBe("没有找到相关正式记录");
  });

  it("keeps the current page visible while loading more rather than treating pagination as a new submission", async () => {
    const now = "2026-10-02T00:00:00Z", next = deferred<IpcResult<RecordSearchPage>>();
    const first: IpcResult<RecordSearchPage> = { ok: true, data: { nextCursor: "synthetic-next-page",
      capabilities: { keyword: "ready", semantic: "ready", media: "ready" }, hits: [{ explanation: "合成命中", record: {
        id: "current-page-record", title: "仍属于本次查询的合成命中", summary: "合成摘要", origin: "manual", categories: ["rights"],
        revision: 1, occurredAt: { kind: "unknown" }, recordedAt: now, reportState: "complete", sourceUpdated: false,
        sourceReviewRequired: false, attachmentCount: 0, createdAt: now, updatedAt: now } }] } };
    const records = { onSearchMediaProgress: () => () => {}, prepareSearch: vi.fn(async () => prepared),
      executeSearch: vi.fn().mockResolvedValueOnce(first).mockReturnValueOnce(next.promise),
      abandonSearch: vi.fn(async () => ({ ok: true, data: undefined })) };
    window.grudgeVault = { records, jobs: { onChanged: () => () => {} } } as unknown as GrudgeVaultApi;
    const container = document.body.appendChild(document.createElement("div")); root = createRoot(container);
    await act(async () => root?.render(createElement(SearchView)));
    const file = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(file, "files", { configurable: true, value: [new File(["synthetic"], "query.png", { type: "image/png" })] });
    await act(async () => file.dispatchEvent(new globalThis.Event("change", { bubbles: true })));
    await act(async () => container.querySelector("form")!.dispatchEvent(new globalThis.Event("submit", { bubbles: true, cancelable: true })));
    const more = container.querySelector<HTMLInputElement>(".load-more")!;
    await act(async () => more.click());
    expect(container.querySelector(".stage-progress")).not.toBeNull();
    expect(container.querySelector(".search-results")?.textContent).toContain("仍属于本次查询的合成命中");
    expect(container.querySelector(".empty-state")).toBeNull(); expect(more.disabled).toBe(true);
    await act(async () => next.resolve(page));
    expect(container.querySelector(".stage-progress")).toBeNull();
    expect(container.querySelector(".search-results article")).not.toBeNull();
    expect(container.querySelector(".load-more")).toBeNull();
  });

  it.each(["preparation", "model"] as const)("cancels during %s, rejects late delivery and can retry", async (phase) => {
    const prepare = deferred<IpcResult<PreparedSearchQuery>>(); const execute = deferred<IpcResult<RecordSearchPage>>();
    const listeners = new Set<(value: typeof progress) => void>();
    const records = {
      onSearchMediaProgress(listener: (value: typeof progress) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      prepareSearch: vi.fn(() => prepare.promise), executeSearch: vi.fn(() => execute.promise),
      abandonSearchPreparation: vi.fn(async () => ({ ok: true, data: undefined })),
      abandonSearch: vi.fn(async () => ({ ok: true, data: undefined }))
    };
    window.grudgeVault = { records, jobs: { onChanged: () => () => {} } } as unknown as GrudgeVaultApi;
    const container = document.body.appendChild(document.createElement("div")); root = createRoot(container);
    await act(async () => root?.render(createElement(SearchView)));
    const file = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(file, "files", { configurable: true, value: [new File(["synthetic"], "synthetic.wav", { type: "audio/wav" })] });
    await act(async () => file.dispatchEvent(new globalThis.Event("change", { bubbles: true })));
    const submit = () => container.querySelector("form")!.dispatchEvent(new globalThis.Event("submit", { bubbles: true, cancelable: true }));
    await act(async () => { submit(); }); expect(records.prepareSearch).toHaveBeenCalledOnce();
    if (phase === "model") {
      await act(async () => prepare.resolve(prepared)); expect(records.executeSearch).toHaveBeenCalledOnce();
      await act(async () => listeners.forEach((listener) => listener({ ...progress, sessionId: "old" })));
      expect(container.textContent).not.toContain("第 1 段");
      await act(async () => listeners.forEach((listener) => listener(progress)));
      expect(container.textContent).toContain("正在检查第 1 段；已检查 0.0 / 48.0 秒");
    }
    const cancel = [...container.querySelectorAll("button")].find((button) => button.textContent === "取消搜索")!;
    await act(async () => cancel.click()); expect(container.textContent).toContain("本次搜索已取消");
    if (phase === "preparation") {
      expect(records.abandonSearchPreparation).toHaveBeenCalledOnce();
      await act(async () => prepare.resolve(prepared)); expect(records.executeSearch).not.toHaveBeenCalled();
    } else {
      expect(records.abandonSearch).toHaveBeenCalledWith(sessionId);
      await act(async () => execute.resolve(page));
    }
    await act(async () => listeners.forEach((listener) => listener({ ...progress, segmentNumber: 9 })));
    expect(container.textContent).not.toContain("第 9 段"); expect(container.textContent).not.toContain("没有找到相关正式记录");
    expect(container.querySelector(".stage-progress")).toBeNull();
    const fileAgain = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(fileAgain, "files", { configurable: true, value: [new File(["retry"], "retry.wav", { type: "audio/wav" })] });
    await act(async () => fileAgain.dispatchEvent(new globalThis.Event("change", { bubbles: true })));
    records.prepareSearch.mockResolvedValue(prepared); records.executeSearch.mockResolvedValue(page);
    await act(async () => { submit(); }); expect(container.textContent).toContain("没有找到相关正式记录");
    await act(async () => root?.unmount()); root = undefined; expect(listeners.size).toBe(0);
  });

  it.each(["LLM_CONFIGURATION_CHANGED", "REVISION_CONFLICT"] as const)("clears cached hits and its cursor when pagination returns %s", async (code) => {
    const now = "2026-09-28T00:00:00Z";
    const cached: IpcResult<RecordSearchPage> = { ok: true, data: { nextCursor: "synthetic-next-page", capabilities: { keyword: "ready", semantic: "ready", media: "ready" }, hits: [{
      explanation: "合成语义命中", record: { id: "synthetic-old-record", title: "合成旧搜索命中", summary: "合成摘要", origin: "manual", categories: ["rights"],
        revision: 1, occurredAt: { kind: "unknown" }, recordedAt: now, reportState: "complete", sourceUpdated: false, sourceReviewRequired: false,
        attachmentCount: 0, createdAt: now, updatedAt: now }
    }] } };
    const records = {
      onSearchMediaProgress: () => () => {}, prepareSearch: vi.fn(async () => prepared),
      executeSearch: vi.fn().mockResolvedValueOnce(cached).mockResolvedValueOnce({ ok: false,
        error: { code, message: "记录或配置已更新，请重新搜索。", retryable: true } }),
      abandonSearch: vi.fn(async () => ({ ok: true, data: undefined }))
    };
    window.grudgeVault = { records, jobs: { onChanged: () => () => {} } } as unknown as GrudgeVaultApi;
    const container = document.body.appendChild(document.createElement("div")); root = createRoot(container);
    await act(async () => root?.render(createElement(SearchView)));
    const file = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(file, "files", { configurable: true, value: [new File(["synthetic"], "synthetic.png", { type: "image/png" })] });
    await act(async () => file.dispatchEvent(new globalThis.Event("change", { bubbles: true })));
    await act(async () => container.querySelector("form")!.dispatchEvent(new globalThis.Event("submit", { bubbles: true, cancelable: true })));
    expect(container.textContent).toContain("合成旧搜索命中");
    const more = [...container.querySelectorAll("button")].find((button) => button.textContent === "载入更多")!;
    await act(async () => more.click());
    expect(records.abandonSearch).toHaveBeenCalledWith(sessionId);
    expect(container.textContent).not.toContain("合成旧搜索命中"); expect(container.textContent).not.toContain("载入更多");
    expect(container.textContent).toContain("重新搜索"); expect(container.textContent).not.toContain("没有找到相关正式记录");
  });

  it.each([false, true])("shows incomplete current projection coverage without claiming a complete empty result (matches=%s)", async (matches) => {
    const now = "2026-09-29T00:00:00Z";
    const incomplete: IpcResult<RecordSearchPage> = { ok: true, data: { capabilities: {
      keyword: "ready", semantic: "ready", media: "ready", indexCoverage: { currentFragments: 3, expectedFragments: 4, outdatedFragments: 1 }
    }, hits: matches ? [{ explanation: "仍有效的合成语义命中", record: { id: "synthetic-current-record", title: "当前来源命中", summary: "合成摘要",
      origin: "manual", categories: ["rights"], revision: 1, occurredAt: { kind: "unknown" }, recordedAt: now, reportState: "complete",
      sourceUpdated: false, sourceReviewRequired: false, attachmentCount: 0, createdAt: now, updatedAt: now } }] : [] } };
    const records = { onSearchMediaProgress: () => () => {}, prepareSearch: vi.fn(async () => prepared),
      executeSearch: vi.fn(async () => incomplete), abandonSearch: vi.fn(async () => ({ ok: true, data: undefined })) };
    window.grudgeVault = { records, jobs: { onChanged: () => () => {} } } as unknown as GrudgeVaultApi;
    const container = document.body.appendChild(document.createElement("div")); root = createRoot(container);
    await act(async () => root?.render(createElement(SearchView)));
    const file = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(file, "files", { configurable: true, value: [new File(["synthetic"], "synthetic.png", { type: "image/png" })] });
    await act(async () => file.dispatchEvent(new globalThis.Event("change", { bubbles: true })));
    await act(async () => container.querySelector("form")!.dispatchEvent(new globalThis.Event("submit", { bubbles: true, cancelable: true })));
    expect(container.textContent).toContain("3／4 个片段，1 个过期片段已排除");
    expect(container.textContent).toContain("仍有效的语义匹配");
    expect(container.textContent).not.toContain("没有找到相关正式记录");
    if (matches) expect(container.textContent).toContain("当前来源命中");
    else expect(container.querySelector(".empty-state h2")?.textContent).toBe("当前可搜索范围内未找到匹配");
  });
});
