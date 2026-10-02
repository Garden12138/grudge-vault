// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventRecordDetail, TemporalValue } from "@grudge-vault/domain";
import type { GrudgeVaultApi, IpcResult } from "@grudge-vault/shared";
import { RecordDetail } from "./App";
import { timeEditorDraft, timeEditorValue } from "./record-time-input";

const stamp = "2026-10-02T00:00:00Z";
const fixture = (occurredAt: TemporalValue = { kind: "unknown" }): EventRecordDetail => ({
  record: { id: "synthetic-time-record", title: "合成时间补充", summary: "合成权益争议", origin: "manual", categories: ["rights"],
    revision: 1, occurredAt, recordedAt: stamp, reportState: "complete", sourceUpdated: false,
    sourceReviewRequired: false, attachmentCount: 0, createdAt: stamp, updatedAt: stamp },
  source: { id: "synthetic-source", recordId: "synthetic-time-record", origin: "manual", sourceVersion: "v1",
    contentHash: "a".repeat(64), text: "合成原文，不因补充时间改写", recordedAt: stamp, createdAt: stamp },
  overrides: [], attachments: []
});

describe("detail occurrence-time editing without invented precision", () => {
  let root: Root | undefined; let original: GrudgeVaultApi;
  beforeEach(() => { original = window.grudgeVault; vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); });
  afterEach(async () => { if (root) await act(async () => root?.unmount()); root = undefined;
    window.grudgeVault = original; document.body.replaceChildren(); vi.unstubAllGlobals(); });
  const render = async (detail = fixture()) => {
    const patchFields = vi.fn(async (): Promise<IpcResult<EventRecordDetail>> => ({ ok: true, data: detail }));
    const reanalyze = vi.fn(async () => ({ ok: true, data: "synthetic-job" }));
    window.grudgeVault = { records: { patchFields, reanalyze }, jobs: { onChanged: () => () => {} },
      legal: { getDefaultJurisdiction: async () => ({ ok: true, data: "中国大陆" }) } } as unknown as GrudgeVaultApi;
    const container = document.body.appendChild(document.createElement("div")); root = createRoot(container);
    const reload = vi.fn(async () => {});
    await act(async () => root?.render(createElement(RecordDetail, { detail, onBack: vi.fn(), onReload: reload })));
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "补充时间")!.click());
    return { container, patchFields, reanalyze, reload };
  };
  const input = async (container: globalThis.HTMLElement, label: string, value: string) => {
    const control = container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
    expect(control).not.toBeNull();
    Object.getOwnPropertyDescriptor(globalThis.HTMLInputElement.prototype, "value")!.set!.call(control, value);
    await act(async () => control.dispatchEvent(new globalThis.Event("input", { bubbles: true })));
  };
  const selectKind = async (container: globalThis.HTMLElement, kind: TemporalValue["kind"]) => {
    const select = container.querySelector<globalThis.HTMLSelectElement>('[aria-label="时间填写方式"]')!;
    await act(async () => { select.value = kind; select.dispatchEvent(new globalThis.Event("change", { bubbles: true })); });
  };
  it.each([
    ["month", { kind: "month", value: "2026-09" }, [["发生月份", "2026-09"]]],
    ["range", { kind: "range", from: "2026-09", to: "2026-10" }, [["范围起点", "2026-09"], ["范围终点", "2026-10"]]],
    ["relative", { kind: "relative", text: "大约上周，具体日期记不清" }, [["时间描述", "大约上周，具体日期记不清"]]],
    ["unknown", { kind: "unknown" }, []],
    ["instant", { kind: "instant", value: "2026-10-02T07:30:00.000Z" }, [["具体时刻（含时区）", "2026-10-02T15:30:00+08:00"]]]
  ] as const)("submits %s using its own representation rather than a forced date", async (kind, expected, values) => {
    const detail = fixture(), before = JSON.stringify(detail);
    const { container, patchFields, reanalyze, reload } = await render(detail);
    const select = container.querySelector<globalThis.HTMLSelectElement>('[aria-label="时间填写方式"]');
    expect(select).not.toBeNull();
    await act(async () => { select!.value = kind; select!.dispatchEvent(new globalThis.Event("change", { bubbles: true })); });
    for (const [label, value] of values) await input(container, label, value);
    const save = [...container.querySelectorAll<globalThis.HTMLButtonElement>(".supplement button")].find((button) => button.textContent === "保存")!;
    expect(save.disabled).toBe(false); await act(async () => save.click());
    expect(patchFields).toHaveBeenCalledExactlyOnceWith({ recordId: "synthetic-time-record", expectedRevision: 1,
      patch: { occurredAt: expected } });
    expect(reload).toHaveBeenCalledOnce(); expect(reanalyze).not.toHaveBeenCalled();
    expect(JSON.stringify(detail)).toBe(before);
  });
  it("loads an existing month without coercing it into a date, and cancellation does not write", async () => {
    const { container, patchFields, reload } = await render(fixture({ kind: "month", value: "2026-09" }));
    expect(container.querySelector<globalThis.HTMLSelectElement>('[aria-label="时间填写方式"]')?.value).toBe("month");
    expect(container.querySelector<HTMLInputElement>('[aria-label="发生月份"]')?.value).toBe("2026-09");
    await selectKind(container, "relative"); await input(container, "时间描述", "大约上周");
    await act(async () => [...container.querySelectorAll(".time-editor button")].find((button) => button.textContent === "取消")!.dispatchEvent(
      new globalThis.MouseEvent("click", { bubbles: true })));
    expect(patchFields).not.toHaveBeenCalled(); expect(reload).not.toHaveBeenCalled();
    expect(container.querySelector(".time-editor")).toBeNull();
  });
  it("retains overlong input and does not submit or silently truncate it", async () => {
    const { container, patchFields } = await render();
    await selectKind(container, "relative"); await input(container, "时间描述", "界".repeat(201));
    expect(container.querySelector<HTMLInputElement>('[aria-label="时间描述"]')?.value).toHaveLength(201);
    expect(container.querySelector(".time-editor [role=alert]")?.textContent).toContain("200");
    const save = container.querySelector<globalThis.HTMLButtonElement>(".time-editor .primary")!;
    expect(save.disabled).toBe(true);
    await act(async () => container.querySelector(".time-editor")!.dispatchEvent(new globalThis.Event("submit", { bubbles: true, cancelable: true })));
    expect(patchFields).not.toHaveBeenCalled();
  });
  it("retains the selected precision and input after a revision conflict", async () => {
    const { container, patchFields, reload } = await render();
    patchFields.mockResolvedValueOnce({ ok: false, error: { code: "REVISION_CONFLICT", message: "fixed synthetic conflict", retryable: true } });
    await selectKind(container, "month"); await input(container, "发生月份", "2026-09");
    await act(async () => container.querySelector<globalThis.HTMLButtonElement>(".time-editor .primary")!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("记录已在其他位置更新");
    expect(container.querySelector<globalThis.HTMLSelectElement>('[aria-label="时间填写方式"]')?.value).toBe("month");
    expect(container.querySelector<HTMLInputElement>('[aria-label="发生月份"]')?.value).toBe("2026-09");
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("time editor representation boundaries", () => {
  const draft = (kind: TemporalValue["kind"], patch: Partial<ReturnType<typeof timeEditorDraft>> = {}) => ({ ...timeEditorDraft(), kind, ...patch });
  it.each([
    { kind: "date", value: "2024-02-29" }, { kind: "month", value: "2026-09" },
    { kind: "instant", value: "2026-10-02T07:30:00.123456Z" },
    { kind: "range", from: "2026-09", to: "2026-10" },
    { kind: "range", to: "上周三" }, { kind: "range", from: "2026-09" },
    { kind: "relative", text: "大约九月，具体哪天记不清", anchorRef: "synthetic-source" }
  ] satisfies TemporalValue[])("round-trips known $kind precision and explicit source references", (value) => {
    const before = JSON.stringify(value);
    expect(timeEditorValue(timeEditorDraft(value))).toEqual({ value });
    expect(JSON.stringify(value)).toBe(before);
  });
  it.each([
    draft("date", { value: "2026-02-30" }), draft("month", { value: "2026-13" }),
    draft("instant", { value: "2026-10-02T15:30:00" }),
    draft("instant", { value: "2026-02-30T15:30:00Z" }),
    draft("instant", { value: "2026-10-02T15:30:00.123456+08:00" }),
    draft("relative", { text: " " }), draft("relative", { text: "界".repeat(201) }),
    draft("range"), draft("range", { from: "2026-10", to: "2026-09" }),
    draft("range", { from: "2026-09-21", to: "2026-09-20" }),
    draft("range", { from: "2026-10-02T15:31:00+08:00", to: "2026-10-02T07:30:00Z" }),
    draft("range", { to: "界".repeat(201) })
  ])("rejects invalid or lossy input without producing a patch ($kind)", (value) => {
    expect(timeEditorValue(value)).toEqual({ error: expect.any(String) });
  });
  it("keeps a whole end month possible rather than narrowing it to its first day", () => {
    expect(timeEditorValue(draft("range", { from: "2026-09-21", to: "2026-09" })))
      .toEqual({ value: { kind: "range", from: "2026-09-21", to: "2026-09" } });
  });
  it("stores unknown explicitly rather than reviving the previous date", () => {
    expect(timeEditorValue(draft("unknown", { value: "2026-09-21", text: "old" }))).toEqual({ value: { kind: "unknown" } });
  });
  it("preserves a 200-character relative description without estimating a calendar date", () => {
    expect(timeEditorValue(draft("relative", { text: "界".repeat(200) })))
      .toEqual({ value: { kind: "relative", text: "界".repeat(200) } });
  });
});
