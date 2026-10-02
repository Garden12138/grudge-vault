// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalysisReportContent, ReportPerson } from "@grudge-vault/domain";
import { ReportField, ReportPeopleField, ReportTimeField } from "./report-fields";

describe("report field precision and provenance", () => {
  let root: Root | undefined;
  beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
  afterEach(async () => { if (root) await act(async () => root?.unmount()); root = undefined;
    document.body.replaceChildren(); vi.unstubAllGlobals(); });
  const render = async (element: ReturnType<typeof createElement>) => {
    root ??= createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root?.render(element));
  };
  it("displays all known time precision without inventing missing calendar or clock parts", async () => {
    for (const [precision, value, expected] of [
      ["exact", "2026-09-20", "2026-09-20（明确时间）"],
      ["approximate", "约在九月", "约在九月（大约时间）"],
      ["range", "周一到周三", "周一到周三（时间范围）"]
    ] as const) {
      await render(createElement(ReportTimeField, { field: { source: "source", value: { value, precision } } }));
      expect(document.querySelector("strong")?.textContent).toBe(expected);
      expect(document.querySelector("em")?.textContent).toBe("来自原始材料");
    }
  });
  it("shows a prompt for absent, blank or unknown time even when a conflicting value is present", async () => {
    const fields: AnalysisReportContent["time"][] = [
      { source: "ai" }, { source: "ai", value: { value: " ", precision: "exact" } },
      { source: "ai", value: { value: "2099-01-01 12:34", precision: "unknown" }, prompt: "待补充发生时间" }
    ];
    for (const field of fields) {
      await render(createElement(ReportTimeField, { field }));
      expect(document.querySelector("strong")?.textContent).toContain("待补充");
      expect(document.body.textContent).not.toContain("2099");
    }
  });
  it("uses the user's time rather than a model value and keeps an unknown user override unknown", async () => {
    const field: AnalysisReportContent["time"] = { source: "ai", value: { value: "model-time", precision: "exact" } };
    await render(createElement(ReportTimeField, { field, userSupplied: true, userValue: "2026-09" }));
    expect(document.querySelector("strong")?.textContent).toBe("2026-09");
    expect(document.querySelector("em")?.textContent).toBe("你已补充");
    await render(createElement(ReportTimeField, { field, userSupplied: true }));
    expect(document.querySelector("strong")?.textContent).toContain("待补充");
    expect(document.body.textContent).not.toContain("model-time");
  });
  it("labels user date precision without filling in absent days or clock time", async () => {
    const field: AnalysisReportContent["time"] = { source: "ai" };
    for (const [userKind, userValue, expected] of [
      ["month", "2026-09", "2026-09（月份）"], ["date", "2026-09-21", "2026-09-21（日期）"],
      ["relative", "上周", "上周（相对时间）"], ["range", "周一 — 周三", "周一 — 周三（时间范围）"]
    ] as const) {
      await render(createElement(ReportTimeField, { field, userSupplied: true, userKind, userValue }));
      expect(document.querySelector("strong")?.textContent).toBe(expected);
      expect(document.querySelector("em")?.textContent).toBe("你已补充");
    }
  });
  it("marks each person's source separately, renders text safely and does not guess absent roles", async () => {
    const people: ReportPerson[] = [{ name: "合成人物甲", role: "同事", source: "source" },
      { name: "<img src=private onerror=alert(1)>", source: "ai" }, { name: "合成人物丙", source: "user" }];
    await render(createElement(ReportPeopleField, { people, onSupplement: vi.fn() }));
    expect(Array.from(document.querySelectorAll("li em"), (element) => element.textContent))
      .toEqual(["来自原始材料", "AI 整理", "你已补充"]);
    expect(document.querySelector("li strong")?.textContent).toBe("合成人物甲（同事）");
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelectorAll("li strong")[1]?.textContent).toBe(people[1]!.name);
  });
  it("provides an accessible supplement action for absent or blank people and respects busy state", async () => {
    const supplement = vi.fn();
    await render(createElement(ReportPeopleField, { people: [{ name: " ", source: "ai" }], onSupplement: supplement }));
    expect(document.body.textContent).toContain("待补充：有哪些相关人物？");
    expect(document.querySelectorAll("li")).toHaveLength(0);
    const button = document.querySelector("button")!;
    expect(button.textContent).toBe("补充人物信息"); await act(async () => button.click());
    expect(supplement).toHaveBeenCalledOnce();
    await render(createElement(ReportPeopleField, { people: [], onSupplement: supplement, disabled: true }));
    await act(async () => document.querySelector("button")!.click()); expect(supplement).toHaveBeenCalledOnce();
  });
  it("does not treat a blank value as a confirmed field", async () => {
    await render(createElement(ReportField, { label: "地点", value: " ", prompt: "待补充地点", source: "ai" }));
    expect(document.querySelector("strong")?.textContent).toBe("待补充地点");
    expect(document.querySelector("em")?.getAttribute("title")).toContain("不等于事实已核实");
  });
});
