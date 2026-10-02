import { describe, expect, it } from "vitest";
import { normalizeReportTime, userReportTime } from "./report-time";

describe("unresolved report time projection", () => {
  it("removes a concrete model value explicitly marked unknown instead of persisting it as a fact", () => {
    const result = normalizeReportTime({ source: "ai", value: { value: "2099-01-01 12:34 synthetic-time-marker", precision: "unknown" } });
    expect(result).toEqual({ droppedValue: true, time: { source: "ai", prompt: "待补充：大约何时发生？" } });
    expect(JSON.stringify(result)).not.toContain("synthetic-time-marker");
  });
  it("keeps useful prompts and provenance while removing blank or contradictory values", () => {
    expect(normalizeReportTime({ source: "source", prompt: "请核对原始记录中的日期。", value: { value: " ", precision: "exact" } }))
      .toEqual({ droppedValue: true, time: { source: "source", prompt: "请核对原始记录中的日期。" } });
    expect(normalizeReportTime({ source: "ai" })).toEqual({ droppedValue: false, time: { source: "ai" } });
  });
  it("preserves known precision without filling missing clock parts and returns an independent value", () => {
    for (const precision of ["exact", "approximate", "range"] as const) {
      const input = { source: "source" as const, value: { value: "2026-09", precision } };
      const result = normalizeReportTime(input);
      expect(result).toEqual({ droppedValue: false, time: input });
      result.time.value!.value = "changed"; expect(input.value.value).toBe("2026-09");
    }
  });
  it("keeps a user-cleared or empty time unresolved instead of indexing internal temporal JSON", () => {
    for (const value of [{ kind: "unknown" }, { kind: "range" }, { kind: "relative", text: " " }, { kind: "date", value: " " }] as const) {
      expect(userReportTime(value)).toEqual({ source: "user", prompt: "待补充：大约何时发生？" });
    }
  });
  it("renders user calendar units, relative descriptions and open ranges at their given precision", () => {
    expect(userReportTime({ kind: "month", value: "2026-09" })).toEqual({ source: "user", value: { value: "2026-09", precision: "exact" } });
    expect(userReportTime({ kind: "relative", text: "上周" })).toEqual({ source: "user", value: { value: "上周", precision: "approximate" } });
    expect(userReportTime({ kind: "range", to: "2026-09" })).toEqual({ source: "user", value: { value: "? — 2026-09", precision: "range" } });
  });
});
