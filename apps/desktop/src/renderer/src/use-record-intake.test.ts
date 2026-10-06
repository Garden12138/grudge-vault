// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ScreenAndSaveResult } from "@grudge-vault/domain";
import type { GrudgeVaultApi, IpcResult } from "@grudge-vault/shared";
import { useRecordIntake } from "./use-record-intake";
const ok = <T,>(data: T) => ({ ok: true as const, data });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
let root: Root | undefined, original: GrudgeVaultApi;
beforeEach(() => { original = window.grudgeVault; vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); });
afterEach(async () => { if (root) await act(async () => root?.unmount()); root = undefined; window.grudgeVault = original; document.body.replaceChildren(); vi.unstubAllGlobals(); });
async function fixture(initialPendingId?: string) {
  const prepare = vi.fn(async () => ok({ sessionId: "session", textLength: 4 }));
  const screenAndSave = vi.fn(async (): Promise<IpcResult<ScreenAndSaveResult>> => ok({ kind: "needs_review", pendingId: "returned-id" }));
  const rescreenManual = vi.fn(async () => ok({ kind: "skipped" }));
  const resolve = vi.fn(async () => ok({ kind: "saved", recordId: "saved-id" }));
  const list = vi.fn(async () => ok([{ id: "returned-id", reason: "需要本人确认", sessionAvailable: true }]));
  const abandon = vi.fn(async () => ok(null)), abandonPreparation = vi.fn(async () => ok(null));
  window.grudgeVault = { intake: { prepare, screenAndSave, abandon, abandonPreparation, onMediaProgress: () => () => {} },
    pending: { list, resolve, rescreenManual } } as unknown as GrudgeVaultApi;
  let current!: ReturnType<typeof useRecordIntake>;
  const onSaved = vi.fn(), onPendingChanged = vi.fn(), onRescreenSettled = vi.fn();
  function Probe() { current = useRecordIntake({ ...(initialPendingId ? { initialPendingId } : {}), onSaved, onPendingChanged, onRescreenSettled }); return null; }
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root?.render(createElement(Probe)));
  return { current: () => current, prepare, screenAndSave, rescreenManual, resolve, list, abandon, abandonPreparation, onSaved };
}
it("uses the returned pending ID and complete input when supplementing instead of persisting its excerpt", async () => {
  const f = await fixture(); const complete = "完整全文".repeat(100);
  await act(async () => f.current().submit(complete, []));
  expect(f.current().state).toBe("review"); expect(f.current().pendingItem?.id).toBe("returned-id");
  await act(async () => { f.current().resetFeedback(); });
  await act(async () => f.current().submit(`${complete}新事实`, []));
  expect(f.rescreenManual).toHaveBeenCalledWith("returned-id", "session");
  expect(f.prepare).toHaveBeenLastCalledWith(expect.objectContaining({ text: `${complete}新事实` }));
  expect(f.screenAndSave).toHaveBeenCalledOnce(); expect(f.current().state).toBe("skipped");
});
it("serializes repeated submit and confirmation clicks", async () => {
  const f = await fixture(), held = deferred<Awaited<ReturnType<typeof f.prepare>>>(); f.prepare.mockReturnValueOnce(held.promise);
  let submitted!: Promise<void>; await act(async () => { submitted = f.current().submit("全文", []); void f.current().submit("全文", []); });
  expect(f.prepare).toHaveBeenCalledOnce(); await act(async () => { held.resolve(ok({ sessionId: "session", textLength: 2 })); await submitted; });
  const confirmation = deferred<Awaited<ReturnType<typeof f.resolve>>>(); f.resolve.mockReturnValueOnce(confirmation.promise);
  let confirmed!: Promise<boolean>; await act(async () => { confirmed = f.current().resolve("keep"); void f.current().resolve("keep"); });
  expect(f.resolve).toHaveBeenCalledOnce(); await act(async () => { confirmation.resolve(ok({ kind: "saved", recordId: "saved-id" })); await confirmed; });
  expect(f.onSaved).toHaveBeenCalledExactlyOnceWith("saved-id");
});
it.each(["release", "unmount"] as const)("abandons late prepared input after %s and never starts screening", async action => {
  const f = await fixture(), held = deferred<Awaited<ReturnType<typeof f.prepare>>>(); f.prepare.mockReturnValueOnce(held.promise);
  let pending!: Promise<void>; await act(async () => { pending = f.current().submit("敏感全文", []); });
  await act(async () => { if (action === "release") await f.current().release(); else { root?.unmount(); root = undefined; } });
  expect(f.abandonPreparation).toHaveBeenCalledOnce();
  await act(async () => { held.resolve(ok({ sessionId: "late-session", textLength: 4 })); await pending; });
  expect(f.abandon).toHaveBeenCalledWith("late-session"); expect(f.screenAndSave).not.toHaveBeenCalled(); expect(f.onSaved).not.toHaveBeenCalled();
});
it("ignores a late saved result after leaving the editor", async () => {
  const f = await fixture(), held = deferred<Awaited<ReturnType<typeof f.screenAndSave>>>(); f.screenAndSave.mockReturnValueOnce(held.promise);
  let pending!: Promise<void>; await act(async () => { pending = f.current().submit("敏感全文", []); });
  await act(async () => { root?.unmount(); root = undefined; });
  await act(async () => { held.resolve(ok({ kind: "saved", recordId: "late", reportState: "queued" })); await pending; });
  expect(f.onSaved).not.toHaveBeenCalled(); expect(f.list).not.toHaveBeenCalled(); expect(f.abandon).toHaveBeenCalledWith("session");
});
it("does not confirm an expired session and keeps an actionable resolve failure", async () => {
  const f = await fixture(); f.list.mockResolvedValueOnce(ok([{ id: "returned-id", reason: "过期", sessionAvailable: false }]));
  await act(async () => f.current().submit("全文", [])); await act(async () => f.current().resolve("keep")); expect(f.resolve).not.toHaveBeenCalled();
  await act(async () => f.current().readPending());
  f.resolve.mockRejectedValueOnce(new Error("暂时失败")); await act(async () => f.current().resolve("keep"));
  expect(f.current().pendingReadError).toBe("暂时失败"); expect(f.current().busy).toBe(false); expect(f.current().state).toBe("review");
});
it("ignoring clears the current session and pending association before a new input", async () => {
  const f = await fixture(); await act(async () => f.current().submit("全文", []));
  await act(async () => { expect(await f.current().resolve("ignore")).toBe(true); });
  expect(f.current().pendingItem).toBeUndefined(); expect(f.abandon).toHaveBeenCalledWith("session");
  await act(async () => f.current().submit("新的全文", [])); expect(f.rescreenManual).not.toHaveBeenCalled(); expect(f.screenAndSave).toHaveBeenCalledTimes(2);
});
