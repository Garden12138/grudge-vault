// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventRecordDetail, PendingReview } from "@grudge-vault/domain";
import type { GrudgeVaultApi } from "@grudge-vault/shared";
import { RecordDetail } from "./App";
import { RecordSupplementDialog } from "./RecordSupplementDialog";
import { PendingReviewDetails } from "./PendingReviewDetails";

const stamp = "2026-10-02T00:00:00Z";
const detail: EventRecordDetail = {
  record: { id: "synthetic-record", title: "奖金未付", summary: "奖金没有到账", origin: "manual", categories: ["rights"],
    revision: 1, occurredAt: { kind: "unknown" }, recordedAt: stamp, reportState: "complete", sourceUpdated: false,
    sourceReviewRequired: false, attachmentCount: 0, createdAt: stamp, updatedAt: stamp },
  source: { id: "synthetic-source", recordId: "synthetic-record", origin: "manual", sourceVersion: "v1",
    contentHash: "a".repeat(64), text: "公司没支付约定的奖金", recordedAt: stamp, createdAt: stamp },
  overrides: [], attachments: []
};
const pending: PendingReview = { id: "pending", origin: "manual", sourceVersion: "v1", excerpt: "开头的摘录", reason: "具体经过不明",
  categories: ["grudge"], coverage: "complete", sessionAvailable: false, createdAt: stamp, updatedAt: stamp };

describe("conversation supplements and review details", () => {
  let root: Root; let original: GrudgeVaultApi;
  const supplement = vi.fn(), patchFields = vi.fn(), reanalyze = vi.fn(), getPending = vi.fn(), restoreDetails = vi.fn();
  beforeEach(() => {
    original = window.grudgeVault; vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    supplement.mockReset().mockResolvedValue({ ok: true, data: { message: "当天约定的奖金是多少钱、什么时候支付？", patch: {} } });
    patchFields.mockReset().mockResolvedValue({ ok: true, data: { ...detail, record: { ...detail.record, revision: 2 } } });
    reanalyze.mockReset().mockResolvedValue({ ok: true, data: "job" }); getPending.mockReset(); restoreDetails.mockReset();
    window.grudgeVault = { records: { supplement, patchFields, reanalyze }, pending: { get: getPending, restoreDetails },
      jobs: { onChanged: () => () => {} }, legal: { getDefaultJurisdiction: async () => ({ ok: true, data: "中国大陆" }) } } as unknown as GrudgeVaultApi;
    root = createRoot(document.body.appendChild(document.createElement("div")));
  });
  afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); window.grudgeVault = original; vi.unstubAllGlobals(); });
  const button = (label: string) => [...document.querySelectorAll<globalThis.HTMLButtonElement>("button")].find((item) => item.textContent === label)!;
  const click = async (label: string) => { await act(async () => button(label).click()); };
  const answer = async (value: string) => {
    const input = document.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(globalThis.HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
    await act(async () => input.dispatchEvent(new globalThis.Event("input", { bubbles: true })));
    await click("发送");
  };
  const renderChat = async () => {
    const saved = vi.fn(async () => {});
    await act(async () => root.render(createElement(RecordSupplementDialog, { detail, onClose: vi.fn(), onSaved: saved })));
    return saved;
  };
  it("offers a single conversation entry and asks about the existing event before any answer", async () => {
    await act(async () => root.render(createElement(RecordDetail, { detail, onBack: vi.fn(), onReload: vi.fn() })));
    expect(button("补充时间")).toBeUndefined(); expect(button("补充地点")).toBeUndefined();
    await click("对话补充");
    expect(supplement).toHaveBeenCalledExactlyOnceWith({ recordId: detail.record.id, expectedRevision: 1, messages: [] });
    expect(document.querySelector('[role="log"]')?.textContent).toContain("当天约定的奖金是多少钱");
    expect(patchFields).not.toHaveBeenCalled();
  });
  it("saves each answer verbatim with its question and protects month precision while updating the report", async () => {
    const saved = await renderChat();
    supplement.mockResolvedValueOnce({ ok: true, data: { message: "当时有没有留下聊天记录？", patch: { occurredAt: { kind: "month", value: "2026-09" } } } });
    const raw = "约定五千元，大约2026年9月发生，具体日期记不清。";
    await answer(raw);
    expect(patchFields).not.toHaveBeenCalled();
    expect(supplement.mock.calls[1]![0].messages).toEqual([{ role: "assistant", content: "当天约定的奖金是多少钱、什么时候支付？" }, { role: "user", content: raw }]);
    await click("保存补充并更新报告");
    expect(patchFields).toHaveBeenCalledWith({ recordId: detail.record.id, expectedRevision: 1, patch: {
      occurredAt: { kind: "month", value: "2026-09" }, clarifications: [{ kind: "unknown", topic: expect.stringContaining("当天约定的奖金"), response: raw }]
    } });
    expect(reanalyze).toHaveBeenCalledExactlyOnceWith(detail.record.id, 2); expect(saved).toHaveBeenCalledOnce();
    expect(detail.source.text).toBe("公司没支付约定的奖金");
  });
  it("retains user words if the model fails and can save them without stale model field changes", async () => {
    await renderChat();
    supplement.mockResolvedValueOnce({ ok: false, error: { code: "LLM_REQUEST_FAILED", message: "synthetic failure", retryable: true } });
    await answer("当时只记得口头约定，不知道日期。");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("输入仍保留");
    await click("保存补充并更新报告");
    expect(patchFields.mock.calls[0]![0].patch.clarifications[0].response).toBe("当时只记得口头约定，不知道日期。");
    expect(patchFields.mock.calls[0]![0].patch.occurredAt).toBeUndefined();
  });
  it("retries report updates without writing the same supplement twice", async () => {
    const saved = await renderChat(); await answer("约定五千元。");
    reanalyze.mockResolvedValueOnce({ ok: false, error: { code: "INTERNAL_ERROR", message: "synthetic failure", retryable: true } });
    await click("保存补充并更新报告");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("补充已保存");
    await click("重试更新报告");
    expect(patchFields).toHaveBeenCalledOnce(); expect(reanalyze).toHaveBeenCalledTimes(2); expect(saved).toHaveBeenCalledOnce();
  });
  it("keeps the conversation on revision conflict and never starts analysis", async () => {
    await renderChat(); await answer("约定五千元。");
    patchFields.mockResolvedValueOnce({ ok: false, error: { code: "REVISION_CONFLICT", message: "synthetic conflict", retryable: true } });
    await click("保存补充并更新报告");
    expect(document.querySelector('[role="log"]')?.textContent).toContain("约定五千元");
    expect(reanalyze).not.toHaveBeenCalled();
  });
  it("lazily shows the full pending body including the tail", async () => {
    const text = "正文".repeat(200) + "末尾发生的具体事情";
    getPending.mockResolvedValue({ ok: true, data: { ...pending, text, attachmentNames: ["当天录音.m4a"] } });
    await act(async () => root.render(createElement(PendingReviewDetails, { item: pending })));
    expect(getPending).not.toHaveBeenCalled(); await click("查看详情");
    expect(document.querySelector("pre")?.textContent).toBe(text); expect(document.body.textContent).toContain("当天录音.m4a");
    await click("收起详情"); await click("查看详情"); expect(getPending).toHaveBeenCalledOnce();
  });
  it("recovers old ZIP text before confirmation and keeps the full body after reopening", async () => {
    const item = { ...pending, origin: "zip" as const };
    const text = "完整当天记录".repeat(100) + "末尾的具体经过";
    const changed = vi.fn(async () => {});
    getPending.mockResolvedValue({ ok: true, data: item });
    restoreDetails.mockResolvedValue({ ok: true, data: { restored: 4, detail: { ...item, text } } });
    await act(async () => root.render(createElement(PendingReviewDetails, { item, onChanged: changed })));
    await click("查看详情"); await click("选择原 ZIP，补全全文");
    expect(restoreDetails).toHaveBeenCalledExactlyOnceWith(item.id);
    expect(document.querySelector("pre")?.textContent).toBe(text);
    expect(document.body.textContent).toContain("已补全 4 条");
    expect(changed).toHaveBeenCalledOnce(); expect(patchFields).not.toHaveBeenCalled(); expect(reanalyze).not.toHaveBeenCalled();
    await click("收起详情"); await click("查看详情"); expect(document.querySelector("pre")?.textContent).toBe(text);
  });
  it("keeps an old excerpt on file-picker cancellation and allows a failed detail read to retry", async () => {
    const item = { ...pending, origin: "zip" as const };
    getPending.mockResolvedValueOnce({ ok: false, error: { code: "INTERNAL_ERROR", message: "synthetic failure", retryable: true } })
      .mockResolvedValueOnce({ ok: true, data: item });
    restoreDetails.mockResolvedValue({ ok: true, data: null });
    await act(async () => root.render(createElement(PendingReviewDetails, { item })));
    await click("查看详情"); await click("重新读取详情");
    await click("选择原 ZIP，补全全文");
    expect(document.querySelector("pre")?.textContent).toBe(pending.excerpt);
    expect(document.body.textContent).not.toContain("完整正文无法恢复"); expect(reanalyze).not.toHaveBeenCalled();
  });
  it("shows the event without empty checklists, repeated explanations or expanded suggestions", async () => {
    const value: EventRecordDetail = { ...detail, record: { ...detail.record, reportState: "partial" }, report: {
      id: "report", recordId: detail.record.id, recordRevision: 1, inputHash: "a".repeat(64), promptVersion: "v1",
      modelProfile: "synthetic", state: "partial", createdAt: stamp, updatedAt: stamp,
      content: { summary: "公司尚未支付奖金", time: { source: "ai", value: { value: "", precision: "unknown" } },
        location: { source: "ai" }, people: [], chronology: [], unknowns: ["抽象的待补充问题"], disputes: [],
        suggestions: ["建议保留原始材料"], legalIssues: [], citations: [], coverageNotes: ["合成覆盖限制说明"] }
    } };
    await act(async () => root.render(createElement(RecordDetail, { detail: value, onBack: vi.fn(), onReload: vi.fn() })));
    const titles = [...document.querySelectorAll("summary")].map(item => item.textContent);
    expect(titles).toEqual(["建议"]);
    expect(document.body.textContent).not.toContain("合成覆盖限制说明");
    expect(button("重新整理")).toBeDefined();
    expect(document.body.textContent).not.toContain("抽象的待补充问题");
    expect(document.body.textContent).not.toContain("缺失与争议");
    expect(document.body.textContent).not.toContain("尚未整理出明确经过");
    expect(document.querySelector(".next-steps")?.hasAttribute("open")).toBe(false);
    expect(document.querySelector(".report-tools")).toBeNull();
    expect(button("对话补充")).toBeDefined(); expect(button("继续分析")).toBeDefined();
  });
});
