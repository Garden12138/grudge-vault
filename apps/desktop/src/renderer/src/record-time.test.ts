import type { TemporalValue } from "@grudge-vault/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dateLabel, occurrenceTimeLabel, recordTimeSourceLabel, temporalLabel, timelineGroupLabel } from "./record-time";

describe("record time display without invented calendar precision", () => {
  afterEach(() => vi.unstubAllEnvs());
  const record = (occurredAt: TemporalValue) => ({ occurredAt, recordedAt: "2026-09-29T00:00:00.000Z" });

  it("does not move a date-only value to the previous date in a western timezone", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    expect(dateLabel("2026-09-20")).toBe("2026年9月20日");
    expect(timelineGroupLabel(record({ kind: "date", value: "2026-09-20" }))).toBe("2026年9月20日");
  });
  it("does not turn month precision into the first day of that month", () => {
    expect(dateLabel("2026-09")).toBe("2026-09");
    expect(timelineGroupLabel(record({ kind: "range", from: "2026-09", to: "2026-10" })))
      .toBe("2026-09 — 2026-10 · 时间范围");
  });
  it("does not represent an open or textual range as a single concrete date", () => {
    expect(timelineGroupLabel(record({ kind: "range", to: "2026-09-20" }))).toBe("? — 2026-09-20 · 时间范围");
    expect(timelineGroupLabel(record({ kind: "range", from: "上周一", to: "上周三" })))
      .toBe(`上周一 — 上周三 · 时间范围 · ${dateLabel(record({ kind: "unknown" }).recordedAt)} · 记录日期`);
  });
  it("marks recording-date grouping when an occurrence date cannot be resolved", () => {
    for (const time of [{ kind: "unknown" }, { kind: "relative", text: "上周" }, { kind: "range" }] as const) {
      expect(timelineGroupLabel(record(time))).toBe(`${dateLabel(record(time).recordedAt)} · 记录日期`);
    }
  });
  it("retains occurrence labels at their original precision", () => {
    for (const [time, expected] of [
      [{ kind: "date", value: "2026-09-20" }, "2026-09-20"],
      [{ kind: "month", value: "2026-09" }, "2026-09"],
      [{ kind: "relative", text: "上周" }, `上周 · ${dateLabel(record({ kind: "unknown" }).recordedAt)} · 记录日期`],
      [{ kind: "range", from: "2026-09", to: "2026-10" }, "2026-09 — 2026-10"]
    ] as const) expect(temporalLabel(record(time))).toBe(expected);
  });
  it("keeps valid leap dates and formats explicit instants in the current timezone", () => {
    expect(dateLabel("2024-02-29")).toBe("2024年2月29日");
    vi.stubEnv("TZ", "America/Los_Angeles");
    const value = "2026-09-20T00:00:00.000Z";
    expect(dateLabel(value)).toBe("2026年9月19日");
    expect(temporalLabel(record({ kind: "instant", value }))).toBe(
      new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)));
  });
  it("preserves unparseable source text and does not crash on an invalid instant", () => {
    const value = "无法确定的较长时间说明，不应被截掉";
    expect(dateLabel(value)).toBe(value);
    expect(temporalLabel(record({ kind: "instant", value }))).toBe(`${value} · ${dateLabel(record({ kind: "unknown" }).recordedAt)} · 记录日期`);
    expect(dateLabel("2026-02-31")).toBe("2026-02-31");
    expect(dateLabel("2026-02-31T00:00:00.000Z")).toBe("2026-02-31T00:00:00.000Z");
    expect(temporalLabel(record({ kind: "instant", value: "2026-02-31T00:00:00.000Z" })))
      .toBe(`2026-02-31T00:00:00.000Z · ${dateLabel(record({ kind: "unknown" }).recordedAt)} · 记录日期`);
  });
  it("uses the captured query zone for cards, headings and recording dates even if the system zone changes", () => {
    vi.stubEnv("TZ", "Asia/Shanghai");
    const value = "2026-09-20T00:30:00Z";
    const time = record({ kind: "instant", value });
    expect(dateLabel(value, "America/Los_Angeles")).toBe("2026年9月19日");
    expect(timelineGroupLabel(time, "America/Los_Angeles")).toBe("2026年9月19日");
    expect(temporalLabel(time, "America/Los_Angeles")).toContain("2026年9月19日");
    expect(temporalLabel(record({ kind: "unknown" }), "America/Los_Angeles")).toBe("2026年9月28日 · 记录日期");
    expect(dateLabel("2026-09-20", "America/Los_Angeles")).toBe("2026年9月20日");
    expect(dateLabel(value, "invalid/zone")).toBe(value);
  });
  it("keeps a report approximation visible and identifies its source without declaring verification", () => {
    const time = { ...record({ kind: "month", value: "2026-09" }), occurredAtSource: "ai" as const, occurredAtPrecision: "approximate" as const };
    expect(temporalLabel(time)).toBe("2026-09（大约时间）");
    expect(timelineGroupLabel(time)).toBe("2026-09（大约时间）");
    expect(recordTimeSourceLabel(time)).toBe("AI 整理");
    expect(recordTimeSourceLabel({ ...time, occurredAtSource: "user" })).toBe("你已补充");
    expect(recordTimeSourceLabel(record({ kind: "date", value: "2026-09-20" }))).toBeUndefined();
  });
  it("shows recording-date fallback for invalid dates and reversed ranges while retaining raw labels", () => {
    for (const time of [{ kind: "date", value: "2026-02-30" }, { kind: "month", value: "2026-13" },
      { kind: "range", from: "2026-10", to: "2026-09" }] as const) {
      const value = record(time);
      expect(temporalLabel(value, "UTC")).toContain("2026年9月29日 · 记录日期");
      expect(timelineGroupLabel(value, "UTC")).toContain("2026年9月29日 · 记录日期");
      expect(occurrenceTimeLabel(value, "UTC")).not.toContain("记录日期");
    }
    expect(occurrenceTimeLabel(record({ kind: "relative", text: "上周" }))).toBe("上周");
  });
  it("retains a BCE era when a zoned year-zero instant moves to a date before year zero", () => {
    const value = "0000-01-01T00:00:00Z";
    expect(dateLabel(value, "America/Los_Angeles")).toContain("公元前2年12月31日");
    expect(temporalLabel(record({ kind: "instant", value }), "America/Los_Angeles")).toContain("公元前2年12月31日");
  });
});
