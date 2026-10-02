// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LlmSettings, RecordSearchIndexStatus } from "@grudge-vault/domain";
import type { GrudgeVaultApi, IpcResult } from "@grudge-vault/shared";
import { SettingsView } from "./App";

const ok = <T,>(data: T): IpcResult<T> => ({ ok: true, data });
const failure: IpcResult<never> = { ok: false, error: { code: "WORKSPACE_INVALID", message: "合成设置读取失败", retryable: true } };
const configured: LlmSettings = { activeProvider: "bailian", providers: { bailian: { provider: "bailian", model: "qwen3.8-omni-flash",
  credentialConfigured: true, region: "cn-beijing", status: "ready" } } };
const paused: LlmSettings = { providers: configured.providers };
const index = (state: RecordSearchIndexStatus["state"]): RecordSearchIndexStatus => ({ state, available: true,
  enabled: state !== "paused", inputModalities: ["text", "image"], queryModalities: ["text", "image"], fragmentCount: 23 });
function deferred<T>() { let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
let root: Root | undefined, original: GrudgeVaultApi;
beforeEach(() => { original = window.grudgeVault; vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); });
afterEach(async () => { if (root) await act(async () => root?.unmount()); root = undefined;
  window.grudgeVault = original; document.body.replaceChildren(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function button(name: string) {
  const found = [...document.querySelectorAll("button")].find(x => x.textContent === name);
  if (!found) throw new Error("Synthetic button missing: " + name); return found;
}
function fixture() {
  const listeners = new Set<() => void>();
  const settings = vi.fn(async (): Promise<IpcResult<LlmSettings>> => ok(configured));
  const status = vi.fn(async (): Promise<IpcResult<RecordSearchIndexStatus>> => ok(index("ready")));
  const jurisdiction = vi.fn(async (): Promise<IpcResult<string>> => ok("合成法域"));
  const write = vi.fn(async () => ok(undefined));
  const pause = vi.fn(async () => ok(paused));
  const pauseIndex = vi.fn(async () => ok(index("paused")));
  const saveJurisdiction = vi.fn(async (value: string) => ok(value));
  window.grudgeVault = { llm: { getSettings: settings, listModels: async () => ok([]), pause, connect: write },
    records: { searchIndexStatus: status, setSearchIndexEnabled: pauseIndex, rebuildSearchIndex: write },
    intake: { dayOneImportProgress: async () => ok(null), lastDayOneImportReceipt: async () => ok(null),
      chooseDayOneZip: write, chooseLegacyWorkspace: write }, legal: { getDefaultJurisdiction: jurisdiction, setDefaultJurisdiction: saveJurisdiction },
    workspace: { getSecuritySettings: async () => ok({ autoLockMinutes: 15, integrityScanIntervalDays: 30 }) },
    jobs: { onChanged(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; } }
  } as unknown as GrudgeVaultApi;
  const mount = async () => { root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root?.render(createElement(SettingsView, { onDataChanged: vi.fn() }))); };
  const changed = () => act(async () => listeners.forEach(x => x()));
  const indexCard = () => [...document.querySelectorAll(".settings-card")].find(x => x.querySelector("h2")?.textContent === "多模态搜索索引")!;
  return { settings, status, jurisdiction, write, pause, pauseIndex, saveJurisdiction, mount, changed, indexCard };
}

it("does not display unknown settings and index reads as unconfigured or an empty index", async () => {
  const f = fixture(), settings = deferred<IpcResult<LlmSettings>>(), status = deferred<IpcResult<RecordSearchIndexStatus>>();
  f.settings.mockReturnValue(settings.promise); f.status.mockReturnValue(status.promise); await f.mount();
  expect(f.indexCard().textContent).not.toContain("未建立"); expect(f.indexCard().textContent).not.toContain("请先连接百炼");
  expect(f.indexCard().textContent).toContain("正在读取索引状态");
  expect(button("选择 Day One 导出 ZIP").disabled).toBe(true); expect(f.write).not.toHaveBeenCalled();
});

it("offers read-only retries after settings and index failures without claiming unavailable capabilities", async () => {
  const f = fixture(); f.settings.mockResolvedValueOnce(failure); f.status.mockResolvedValueOnce(failure); await f.mount();
  expect(document.body.textContent).toContain("暂时无法读取模型设置"); expect(f.indexCard().textContent).toContain("暂时无法读取索引状态");
  expect(f.indexCard().textContent).not.toContain("未建立"); expect(f.indexCard().textContent).not.toContain("请先连接百炼");
  await act(async () => button("重新读取模型设置").click()); await act(async () => button("重新读取索引状态").click());
  expect(f.settings).toHaveBeenCalledTimes(2); expect(f.status).toHaveBeenCalledTimes(2);
  expect(f.indexCard().querySelector(".status")?.textContent).toBe("已就绪");
  expect(document.body.textContent).not.toContain("暂时无法读取模型设置");
  expect(f.write).not.toHaveBeenCalled(); expect(f.pause).not.toHaveBeenCalled(); expect(f.pauseIndex).not.toHaveBeenCalled();
});

it("rejects an older full settings refresh after a newer notification publishes paused", async () => {
  const f = fixture(), old = deferred<IpcResult<RecordSearchIndexStatus>>(); await f.mount();
  f.status.mockReturnValueOnce(old.promise).mockResolvedValueOnce(ok(index("paused")));
  await f.changed(); await f.changed(); expect(f.indexCard().querySelector(".status")?.textContent).toBe("已暂停");
  await act(async () => old.resolve(ok(index("ready"))));
  expect(f.indexCard().querySelector(".status")?.textContent).toBe("已暂停");
});

it("does not let an in-flight read overwrite an explicit index pause result", async () => {
  const f = fixture(), old = deferred<IpcResult<RecordSearchIndexStatus>>(); await f.mount();
  f.status.mockReturnValueOnce(old.promise); await f.changed();
  await act(async () => button("暂停语义查询与自动更新").click());
  expect(f.indexCard().querySelector(".status")?.textContent).toBe("已暂停");
  await act(async () => old.resolve(ok(index("ready"))));
  expect(f.indexCard().querySelector(".status")?.textContent).toBe("已暂停"); expect(f.pauseIndex).toHaveBeenCalledOnce();
});

it("shares read ownership between job refreshes and checking polls", async () => {
  const f = fixture(), old = deferred<IpcResult<RecordSearchIndexStatus>>();
  f.status.mockResolvedValueOnce(ok(index("checking"))).mockReturnValueOnce(old.promise).mockResolvedValueOnce(ok(index("ready")));
  await f.mount(); await f.changed();
  await act(async () => vi.advanceTimersByTimeAsync(500)); expect(f.indexCard().querySelector(".status")?.textContent).toBe("已就绪");
  await act(async () => old.resolve(ok(index("checking")))); expect(f.indexCard().querySelector(".status")?.textContent).toBe("已就绪");
  await act(async () => vi.advanceTimersByTimeAsync(2000)); expect(f.status).toHaveBeenCalledTimes(3);
});

it("does not revive the old enabled model after pause and a newer refresh", async () => {
  const f = fixture(), old = deferred<IpcResult<LlmSettings>>(); await f.mount();
  f.settings.mockReturnValueOnce(old.promise).mockResolvedValueOnce(ok(paused)); await f.changed();
  await act(async () => button("暂停全部模型外发").click());
  expect(button("选择 Day One 导出 ZIP").disabled).toBe(true);
  await act(async () => old.resolve(ok(configured))); expect(button("选择 Day One 导出 ZIP").disabled).toBe(true);
});

it("does not replace an unread legal setting with a saveable China default", async () => {
  const f = fixture(); f.jurisdiction.mockResolvedValueOnce(failure); await f.mount();
  const input = document.querySelector<HTMLInputElement>('.settings-card input[maxlength="200"]')!;
  expect(input.value).toBe(""); expect(button("保存默认地域").disabled).toBe(true);
  expect(document.body.textContent).toContain("暂时无法读取默认地域");
  await act(async () => button("重新读取默认地域").click());
  expect(input.value).toBe("合成法域"); expect(f.saveJurisdiction).not.toHaveBeenCalled();
});

it("bounds failed checking polls and restarts them after a successful explicit read", async () => {
  const f = fixture(); f.status.mockResolvedValueOnce(ok(index("checking")))
    .mockResolvedValueOnce(failure).mockResolvedValueOnce(failure).mockResolvedValueOnce(failure)
    .mockResolvedValueOnce(ok(index("checking"))).mockResolvedValueOnce(ok(index("ready")));
  await f.mount(); await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(f.status).toHaveBeenCalledTimes(4); expect(f.indexCard().textContent).toContain("暂时无法读取索引状态");
  await act(async () => button("重新读取索引状态").click());
  await act(async () => vi.advanceTimersByTimeAsync(500));
  expect(f.indexCard().querySelector(".status")?.textContent).toBe("已就绪"); expect(f.status).toHaveBeenCalledTimes(6);
  expect(f.write).not.toHaveBeenCalled();
});

it("keeps the legal input disabled while its explicit save is pending", async () => {
  const f = fixture(), saved = deferred<IpcResult<string>>(); f.saveJurisdiction.mockReturnValue(saved.promise);
  await f.mount(); const input = document.querySelector<HTMLInputElement>('.settings-card input[maxlength="200"]')!;
  await act(async () => button("保存默认地域").click());
  expect(input.disabled).toBe(true); expect(f.saveJurisdiction).toHaveBeenCalledWith("合成法域");
  await act(async () => saved.resolve(ok("合成法域")));
  expect(input.disabled).toBe(false); expect(input.value).toBe("合成法域"); expect(f.jurisdiction).toHaveBeenCalledOnce();
});
