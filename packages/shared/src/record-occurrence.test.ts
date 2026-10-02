import { describe, expect, it } from "vitest";
import type { AnalysisReportContent, Precision, TemporalValue } from "@grudge-vault/domain";
import { projectRecordOccurrence } from "./record-occurrence";

const unknown: TemporalValue = { kind: "unknown" };
const field = (value: string, precision: Precision = "exact"): AnalysisReportContent["time"] =>
  ({ source: "ai", value: { value, precision } });

describe("read-only occurrence projection from a current report", () => {
  it("uses whole ISO/Chinese dates and months without inventing a day or clock", () => {
    for (const [value, expected] of [["2026-9-2", { kind: "date", value: "2026-09-02" }],
      ["2024年2月29日", { kind: "date", value: "2024-02-29" }], ["2026年9月", { kind: "month", value: "2026-09" }],
      ["2026-09", { kind: "month", value: "2026-09" }]] as const) {
      expect(projectRecordOccurrence(unknown, field(value))).toEqual({ value: expected, source: "ai", precision: "exact" });
    }
  });
  it("preserves explicit instant offsets rather than guessing the timezone of a local clock", () => {
    const value = "2026-09-20T08:30:00+08:00";
    expect(projectRecordOccurrence(unknown, field(value)).value).toEqual({ kind: "instant", value });
    const local = "2026-09-20 08:30";
    expect(projectRecordOccurrence(unknown, field(local)).value).toEqual({ kind: "relative", text: local });
  });
  it("retains reported approximate precision and parses only the explicitly supplied calendar unit", () => {
    expect(projectRecordOccurrence(unknown, field("约 2026年9月", "approximate")))
      .toEqual({ value: { kind: "month", value: "2026-09" }, source: "ai", precision: "approximate" });
    expect(projectRecordOccurrence(unknown, field("大约2026-09-20", "approximate")))
      .toEqual({ value: { kind: "date", value: "2026-09-20" }, source: "ai", precision: "approximate" });
    expect(projectRecordOccurrence(unknown, field("约在九月", "approximate")).value)
      .toEqual({ kind: "relative", text: "约在九月" });
  });
  it("represents reported ranges with full endpoints, including an explicitly open end", () => {
    for (const delimiter of [" — ", "至", " ～ ", " - ", " / "]) {
      expect(projectRecordOccurrence(unknown, field(`2026年9月${delimiter}2026年10月`, "range")).value)
        .toEqual({ kind: "range", from: "2026-09", to: "2026-10" });
    }
    expect(projectRecordOccurrence(unknown, field("? — 2026-09-20", "range")).value).toEqual({ kind: "range", to: "2026-09-20" });
    expect(projectRecordOccurrence(unknown, field("上周一至上周三", "range")).value)
      .toEqual({ kind: "range", from: "上周一", to: "上周三" });
  });
  it("does not extract arbitrary narrative date fragments, choose between multiple dates or roll invalid dates", () => {
    for (const value of ["合同签于2026-09-20，但事发时间不明", "2026-09-20 或 2026-09-21", "2026-02-30", "2026年13月", "上周", "九月"]) {
      expect(projectRecordOccurrence(unknown, field(value)).value).toEqual({ kind: "relative", text: value });
    }
  });
  it("ignores unknown/blank report fields and does not fabricate provenance for legacy source fields", () => {
    const stored: TemporalValue = { kind: "date", value: "2026-09-10" };
    for (const time of [undefined, field("2099-01-01", "unknown"), field("   ")]) {
      expect(projectRecordOccurrence(stored, time)).toEqual({ value: stored });
    }
  });
  it("protects explicit user values, including a user-cleared unknown field, from report replacement", () => {
    for (const stored of [unknown, { kind: "month", value: "2026-08" }] as const) {
      expect(projectRecordOccurrence(stored, field("2026-09-20"), true)).toEqual({ value: stored, source: "user" });
    }
  });
  it("does not mutate retained temporal data or raw report content", () => {
    const stored: TemporalValue = { kind: "unknown" }; const report = field(" 2026年9月20日 ");
    const before = JSON.stringify({ stored, report });
    expect(projectRecordOccurrence(stored, report).value).toEqual({ kind: "date", value: "2026-09-20" });
    expect(JSON.stringify({ stored, report })).toBe(before);
  });
});
