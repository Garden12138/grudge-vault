import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceLockState } from "@grudge-vault/domain";
import { AppError } from "@grudge-vault/shared";
import { registerIpcHandlers } from "./ipc";

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, input?: unknown) => Promise<unknown>>(),
  showOpenDialog: vi.fn(), send: vi.fn()
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, input?: unknown) => Promise<unknown>) => electron.handlers.set(channel, handler),
    removeHandler: (channel: string) => electron.handlers.delete(channel)
  },
  dialog: { showOpenDialog: electron.showOpenDialog }, shell: {}
}));

const OPEN: WorkspaceLockState = { status: "open", workspace: {
  id: "11111111-1111-4111-8111-111111111111", name: "Synthetic workspace", rootPath: "/synthetic/workspace",
  createdAt: "2026-09-30T00:00:00.000Z", updatedAt: "2026-09-30T00:00:00.000Z", formatVersion: 3
} };

describe("workspace IPC lifecycle", () => {
  let remove: (() => void) | undefined;
  beforeEach(() => { vi.clearAllMocks(); electron.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ["/synthetic/selection"] }); });
  afterEach(() => { remove?.(); remove = undefined; });
  function fixture() {
    let status: WorkspaceLockState = OPEN;
    const order: string[] = [];
    const action = vi.fn(async () => { order.push("change"); return null; });
    const stopAndWait = vi.fn(async () => { order.push("stop"); });
    const resume = vi.fn();
    const closeAll = vi.fn(async () => { order.push("revoke"); });
    const restartRunner = vi.fn(() => { order.push("restart"); if (status.status === "open") resume(); });
    const mainFrame = {};
    const dependencies = {
      window: { isDestroyed: () => false, webContents: { id: 1, mainFrame, send: electron.send } },
      application: { getWorkspaceStatus: () => status, createWorkspace: action, openWorkspace: action,
        recoverWorkspace: action, restoreBackup: action },
      workspaces: {}, agent: {}, restartRunner, getRunner: () => ({ stopAndWait }), lockWorkspace: vi.fn(),
      mediaPreviews: { closeAll, resume }
    } as unknown as Parameters<typeof registerIpcHandlers>[0];
    remove = registerIpcHandlers(dependencies);
    return { order, action, stopAndWait, restartRunner, closeAll, resume,
      setStatus: (value: WorkspaceLockState) => { status = value; },
      invoke: (channel: string, input?: unknown) => electron.handlers.get(channel)!({ sender: { id: 1 }, senderFrame: mainFrame }, input)
    };
  }

  it.each([
    ["workspace:create", "Synthetic candidate"], ["workspace:open", undefined],
    ["workspace:recover", { passphrase: "synthetic recovery phrase" }], ["backups:restore", undefined]
  ])("quiesces jobs and reconciles a fail-closed %s", async (channel, input) => {
    const test = fixture();
    test.action.mockImplementation(async () => {
      test.order.push("change");
      test.setStatus({ status: "locked", workspaceName: "Synthetic workspace", workspaceId: OPEN.workspace.id });
      throw new AppError("CLEANUP_FAILED", "无法安全关闭原工作区；已锁定，请重新打开。");
    });
    expect(await test.invoke(channel as string, input)).toMatchObject({ ok: false, error: { code: "CLEANUP_FAILED" } });
    expect(test.order).toEqual(["revoke", "stop", "change", "restart"]);
    expect(test.resume).not.toHaveBeenCalled();
    expect(electron.send).toHaveBeenCalledWith("workspace:locked");
  });

  it("restarts the preserved session without broadcasting a lock on a rejected selection", async () => {
    const test = fixture();
    test.action.mockRejectedValue(new AppError("VALIDATION_FAILED", "Synthetic invalid selection"));
    expect(await test.invoke("workspace:open")).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(test.stopAndWait).toHaveBeenCalledOnce();
    expect(test.restartRunner).toHaveBeenCalledOnce();
    expect(test.resume).toHaveBeenCalledOnce();
    expect(electron.send).not.toHaveBeenCalled();
  });

  it("restarts exactly once after a successful switch", async () => {
    const test = fixture();
    expect(await test.invoke("workspace:open")).toEqual({ ok: true, data: null });
    expect(test.order).toEqual(["revoke", "stop", "change", "restart"]);
    expect(test.restartRunner).toHaveBeenCalledOnce();
    expect(electron.send).not.toHaveBeenCalled();
  });

  it.each(["cancel", "preview-cleanup"])("does not change the session on %s", async (mode) => {
    const test = fixture();
    if (mode === "cancel") electron.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    else test.closeAll.mockRejectedValue(new AppError("CLEANUP_FAILED", "Synthetic preview cleanup failure"));
    await test.invoke("workspace:open");
    expect(test.action).not.toHaveBeenCalled();
    expect(test.stopAndWait).not.toHaveBeenCalled();
    expect(test.restartRunner).not.toHaveBeenCalled();
    expect(test.resume).not.toHaveBeenCalled();
    expect(electron.send).not.toHaveBeenCalled();
  });
});
