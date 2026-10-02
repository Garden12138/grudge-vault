// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PendingReview, WorkspaceLockState } from "@grudge-vault/domain";
import type { GrudgeVaultApi, IpcResult } from "@grudge-vault/shared";
import { App } from "./App";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve };
}
const stamp = "2026-10-02T00:00:00Z";
const opened: WorkspaceLockState = { status: "open", workspace: { id: "synthetic-workspace", name: "仅供合成会话测试",
  rootPath: "/synthetic/workspace", formatVersion: 3, createdAt: stamp, updatedAt: stamp } };
const locked: WorkspaceLockState = { status: "locked", workspaceId: "synthetic-workspace", workspaceName: "合成锁定工作区" };
const success = <T,>(data: T): IpcResult<T> => ({ ok: true, data });
const unavailable: IpcResult<never> = { ok: false, error: { code: "SOURCE_UNAVAILABLE", message: "Synthetic unavailable read", retryable: true } };
const item = (id: string): PendingReview => ({ id, origin: "manual", categories: ["rights"], reason: "合成不确定来源",
  excerpt: `${id}的合成摘录`, coverage: "complete", sourceVersion: "v1", sessionAvailable: false, createdAt: stamp, updatedAt: stamp });
let root: Root | undefined, original: GrudgeVaultApi;
beforeEach(() => { original = window.grudgeVault; vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); });
afterEach(async () => {
  if (root) await act(async () => root?.unmount()); root = undefined;
  window.grudgeVault = original; document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

async function fixture(initial: WorkspaceLockState = opened) {
  let state = initial;
  const listeners = new Set<() => void>();
  const status = vi.fn(async () => success(state)), list = vi.fn(async () => success<PendingReview[]>([]));
  const api = {
    workspace: { status, onLocked(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
      unlock: vi.fn(async () => { state = opened; return success(undefined); }), lock: vi.fn(async () => success(undefined)) },
    pending: { list }, records: { timeline: vi.fn(async () => success({ records: [] })) },
    jobs: { onChanged: () => () => {} }, intake: { onMediaProgress: () => () => {} }
  };
  window.grudgeVault = api as unknown as GrudgeVaultApi;
  const mount = async () => {
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root?.render(createElement(App)));
  };
  const revoke = async () => { state = locked; await act(async () => listeners.forEach((listener) => listener())); };
  const unlock = async () => { await act(async () => button("解锁工作区").click()); };
  return { api, status, list, mount, revoke, unlock, setState(value: WorkspaceLockState) { state = value; } };
}
function button(text: string): globalThis.HTMLButtonElement {
  const found = Array.from(document.querySelectorAll("button")).find(({ textContent }) => textContent === text);
  if (!found) throw new Error(`Synthetic button missing: ${text}`); return found;
}

it("does not reopen the shell when an initial open-state reply arrives after a lock notification", async () => {
  const test = await fixture(), old = deferred<IpcResult<WorkspaceLockState>>();
  test.status.mockReturnValueOnce(old.promise); await test.mount();
  await test.revoke(); expect(document.querySelector(".app-shell")).toBeNull();
  await act(async () => old.resolve(success(opened)));
  expect(document.querySelector(".app-shell")).toBeNull();
  expect(document.body.textContent).toContain("合成锁定工作区");
  expect(document.body.textContent).not.toContain("仅供合成会话测试");
  expect(test.list).not.toHaveBeenCalled();
});

it("keeps lock-state verification visibly pending instead of claiming the workspace is closed", async () => {
  const test = await fixture(); await test.mount(); const next = deferred<IpcResult<WorkspaceLockState>>();
  test.status.mockReturnValueOnce(next.promise); await test.revoke();
  expect(document.querySelector(".app-shell")).toBeNull();
  expect(document.body.textContent).toContain("正在读取工作区状态");
  expect(document.body.textContent).not.toContain("创建新工作区");
  await act(async () => next.resolve(success(locked)));
  expect(document.body.textContent).toContain("解锁工作区");
});

it.each(["success", "failure"] as const)("discards an old pending %s reply after locking and reopening the same workspace", async (outcome) => {
  const test = await fixture(), old = deferred<IpcResult<PendingReview[]>>();
  test.list.mockReturnValueOnce(old.promise).mockResolvedValue(success([item("当前会话")]));
  await test.mount(); await test.revoke(); await test.unlock();
  expect(document.querySelector(".header-actions b")?.textContent).toBe("1");
  await act(async () => old.resolve(outcome === "success" ? success([item("旧会话一"), item("旧会话二")]) : unavailable));
  expect(document.querySelector(".header-actions b")?.textContent).toBe("1");
  await act(async () => button("待确认1").click());
  expect(document.querySelector(".pending-list")?.textContent).toContain("当前会话的合成摘录");
  expect(document.body.textContent).not.toContain("旧会话");
});

it("does not queue a hidden new-record shortcut while locked and replay it on unlock", async () => {
  const test = await fixture(locked); await test.mount();
  await act(async () => globalThis.dispatchEvent(new globalThis.KeyboardEvent("keydown", { key: "n", metaKey: true, bubbles: true })));
  await test.unlock();
  expect(document.querySelector(".app-shell")).not.toBeNull();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.body.textContent).not.toContain("写下发生了什么");
});

it("shows a failed workspace-state read as unavailable and retries only the read", async () => {
  const test = await fixture({ status: "closed" }); test.status.mockResolvedValueOnce(unavailable);
  await test.mount();
  expect(document.body.textContent).toContain("暂时无法读取工作区状态");
  expect(document.querySelector(".app-shell")).toBeNull();
  await act(async () => button("重新读取状态").click());
  expect(document.body.textContent).toContain("创建新工作区");
  expect(test.status).toHaveBeenCalledTimes(2); expect(test.api.workspace.unlock).not.toHaveBeenCalled();
  expect(test.list).not.toHaveBeenCalled();
});

it("does not disguise a failed pending read as an empty list and can reload without modifying anything", async () => {
  const test = await fixture(); test.list.mockResolvedValueOnce(unavailable);
  await test.mount();
  expect(document.body.textContent).toContain("暂时无法读取待确认");
  await act(async () => button("重新读取待确认").click());
  expect(document.body.textContent).not.toContain("暂时无法读取待确认");
  await act(async () => button("待确认").click());
  expect(document.body.textContent).toContain("没有待确认内容");
  expect(test.api.workspace.lock).not.toHaveBeenCalled();
});
