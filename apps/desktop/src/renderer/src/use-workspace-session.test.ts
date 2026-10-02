// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PendingReview, WorkspaceLockState } from "@grudge-vault/domain";
import { useWorkspaceSession, type WorkspaceSessionAccess } from "./use-workspace-session";

const stamp = "2026-10-02T00:00:00Z";
const opened = (id = "synthetic-a"): WorkspaceLockState => ({ status: "open", workspace: { id, name: "合成工作区",
  rootPath: "/synthetic/workspace", formatVersion: 3, createdAt: stamp, updatedAt: stamp } });
const item = (id: string): PendingReview => ({ id, origin: "manual", categories: ["rights"], excerpt: "合成待确认摘录",
  reason: "合成待确认原因", coverage: "complete", sourceVersion: "v1", sessionAvailable: false, createdAt: stamp, updatedAt: stamp });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject };
}
let root: Root | undefined;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => { if (root) await act(async () => root?.unmount()); root = undefined;
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function fixture(initial: WorkspaceLockState = opened()) {
  const listeners = new Set<() => void>(), revoked = vi.fn();
  const status = vi.fn(async () => initial), pending = vi.fn(async (): Promise<PendingReview[]> => []);
  const access: WorkspaceSessionAccess = { status, pending,
    onLocked(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  let current!: ReturnType<typeof useWorkspaceSession>;
  function Harness() { current = useWorkspaceSession(access, revoked); return createElement("span", null, current.status.status); }
  return { status, pending, listeners, revoked, get current() { return current; },
    async mount(strict = false) { root = createRoot(document.body.appendChild(document.createElement("div")));
      await act(async () => root?.render(strict ? createElement(StrictMode, null, createElement(Harness)) : createElement(Harness))); } };
}

it("balances the production StrictMode replay and discards the first setup's held reply", async () => {
  const test = fixture(), old = deferred<WorkspaceLockState>();
  test.status.mockReturnValueOnce(old.promise).mockResolvedValue(opened("strict-current"));
  await test.mount(true); await act(async () => old.resolve(opened("strict-old")));
  expect(test.current.status).toEqual(opened("strict-current")); expect(test.listeners.size).toBe(1);
  expect(test.status).toHaveBeenCalledTimes(2); expect(test.pending).toHaveBeenCalledTimes(1);
  expect(test.current.isCurrentSession(test.current.session)).toBe(true);
});

it("subscribes before a synchronous lock event during the initial status read", async () => {
  const test = fixture();
  test.status.mockImplementationOnce(async () => {
    expect(test.listeners.size).toBe(1); test.listeners.forEach((listener) => listener()); return opened();
  }).mockResolvedValue({ status: "locked", workspaceId: "synthetic-a", workspaceName: "合成已锁定" });
  await test.mount(); expect(test.current.status.status).toBe("locked"); expect(test.current.ready).toBe(true);
  expect(test.pending).not.toHaveBeenCalled(); expect(test.status).toHaveBeenCalledTimes(2);
});

it.each(["success", "failure"] as const)("ignores an older workspace %s after a newer status read completes", async (outcome) => {
  const test = fixture({ status: "closed" }), old = deferred<WorkspaceLockState>();
  test.status.mockReturnValueOnce(old.promise); await test.mount();
  test.status.mockResolvedValue(opened("synthetic-b")); await act(async () => test.current.refreshWorkspace());
  const current = test.current.session;
  await act(async () => { if (outcome === "success") old.resolve(opened()); else old.reject(new Error("Synthetic old failure")); });
  expect(test.current.status).toEqual(opened("synthetic-b")); expect(test.current.error).toBeUndefined();
  expect(test.current.session).toBe(current); expect(test.pending).toHaveBeenCalledTimes(1);
});

it.each(["success", "failure"] as const)("keeps the latest pending list when an older same-session read returns %s", async (outcome) => {
  const test = fixture(); await test.mount(); const old = deferred<PendingReview[]>();
  test.pending.mockReturnValueOnce(old.promise); await act(async () => { void test.current.refreshPending(); });
  expect(test.current.pendingLoading).toBe(true);
  test.pending.mockResolvedValue([item("latest")]); await act(async () => test.current.refreshPending());
  await act(async () => { if (outcome === "success") old.resolve([item("old")]); else old.reject(new Error("Synthetic old failure")); });
  expect(test.current.pending).toEqual([item("latest")]); expect(test.current.pendingError).toBeUndefined();
  expect(test.current.pendingLoading).toBe(false);
});

it.each(["status", "pending"] as const)("drops a late %s reply after unmount without publishing or issuing a follow-up read", async (kind) => {
  const test = fixture(), oldStatus = deferred<WorkspaceLockState>(), oldPending = deferred<PendingReview[]>();
  if (kind === "status") test.status.mockReturnValueOnce(oldStatus.promise);
  else test.pending.mockReturnValueOnce(oldPending.promise);
  await test.mount(); const before = test.current, revoked = test.revoked.mock.calls.length;
  await act(async () => root?.unmount()); root = undefined;
  await act(async () => { oldStatus.resolve(opened("late")); oldPending.resolve([item("late")]); });
  expect(test.current).toBe(before); expect(test.current.isCurrentSession(before.session)).toBe(false);
  expect(test.revoked).toHaveBeenCalledTimes(revoked); expect(test.current.pending).toEqual([]);
  expect(test.pending).toHaveBeenCalledTimes(kind === "status" ? 0 : 1);
  expect(test.listeners.size).toBe(0);
});

it("replaces ownership and invalidates old callbacks and pending data when workspace identity changes without a pushed event", async () => {
  const test = fixture(), old = deferred<PendingReview[]>(); test.pending.mockReturnValueOnce(old.promise);
  await test.mount(); const scope = test.current.session;
  test.pending.mockResolvedValue([item("workspace-b")]); test.status.mockResolvedValue(opened("synthetic-b"));
  await act(async () => test.current.refreshWorkspace());
  await act(async () => old.resolve([item("workspace-a")]));
  expect(test.current.isCurrentSession(scope)).toBe(false); expect(test.current.isCurrentSession(test.current.session)).toBe(true);
  expect(test.current.pending).toEqual([item("workspace-b")]); expect(test.current.session.version).toBeGreaterThan(scope.version);
  expect(test.revoked).toHaveBeenCalledTimes(2);
});

it("revokes an open scope on a failed status read and never revives its callbacks after a successful read-only retry", async () => {
  const test = fixture(); test.pending.mockResolvedValue([item("old-scope")]); await test.mount(); const old = test.current.session;
  test.status.mockRejectedValueOnce(new Error("Synthetic unavailable status")); await act(async () => test.current.refreshWorkspace());
  expect(test.current.error).toBeInstanceOf(Error); expect(test.current.pending).toEqual([]);
  expect(test.current.isCurrentSession(old)).toBe(false); expect(test.current.status.status).toBe("closed");
  test.status.mockResolvedValue(opened()); await act(async () => test.current.refreshWorkspace());
  expect(test.current.error).toBeUndefined(); expect(test.current.status.status).toBe("open");
  expect(test.current.isCurrentSession(old)).toBe(false); expect(test.current.isCurrentSession(test.current.session)).toBe(true);
});

it.each(["status", "pending"] as const)("keeps a non-Error %s rejection visibly unavailable instead of treating it as success", async (kind) => {
  const test = fixture();
  if (kind === "status") test.status.mockRejectedValueOnce(false);
  else test.pending.mockRejectedValueOnce(undefined);
  await test.mount();
  expect(kind === "status" ? test.current.error : test.current.pendingError).toBeInstanceOf(Error);
  expect(test.current.pending).toEqual([]);
  if (kind === "status") expect(test.current.status.status).toBe("closed");
});
