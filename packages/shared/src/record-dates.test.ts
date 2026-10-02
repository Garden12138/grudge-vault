import { describe, expect, it } from "vitest";
import type { EventRecord } from "@grudge-vault/domain";
import { calendarDateDay, projectRecordDate, recordDateMatches, recordTimeZone, resolveRecordDateFilter } from "./record-dates";

const recordedAt = "2026-11-03T02:00:00Z";
const record = (occurredAt: EventRecord["occurredAt"]) => ({ occurredAt, recordedAt });
const project = (time: EventRecord["occurredAt"], zone = "Asia/Shanghai") => projectRecordDate(record(time), zone)!;
const matches = (time: EventRecord["occurredAt"], from: string, to = from, zone = "Asia/Shanghai") =>
  recordDateMatches(project(time, zone), resolveRecordDateFilter({ from, to, timeZone: zone })!);

describe("record calendar intervals", () => {
  it("matches every possible date of a month, including its final day", () => {
    const time = { kind: "month", value: "2026-09" } as const;
    expect(matches(time, "2026-09-01")).toBe(true);
    expect(matches(time, "2026-09-15")).toBe(true);
    expect(matches(time, "2026-09-30")).toBe(true);
    expect(matches(time, "2026-08-31")).toBe(false);
    expect(matches(time, "2026-10-01")).toBe(false);
  });
  it("uses Gregorian month boundaries including leap years and December", () => {
    expect(project({ kind: "month", value: "2024-02" }).upperDay).toBe(calendarDateDay("2024-02-29"));
    expect(project({ kind: "month", value: "2026-02" }).upperDay).toBe(calendarDateDay("2026-02-28"));
    expect(project({ kind: "month", value: "9999-12" }).upperDay).toBe(calendarDateDay("9999-12-31"));
  });
  it("matches closed ranges inclusively and expands month endpoints without rewriting them", () => {
    const time = { kind: "range", from: "2026-09", to: "2026-10" } as const;
    const original = { ...time };
    expect(matches(time, "2026-09-15")).toBe(true);
    expect(matches(time, "2026-10-31")).toBe(true);
    expect(matches(time, "2026-11-01")).toBe(false);
    expect(time).toEqual(original);
  });
  it("treats a missing or unparseable range endpoint as open, not as a guessed date", () => {
    expect(matches({ kind: "range", from: "2026-09-10" }, "9999-12-31")).toBe(true);
    expect(matches({ kind: "range", to: "2026-09" }, "0000-01-01")).toBe(true);
    expect(matches({ kind: "range", from: "很久以前", to: "2026-09-20" }, "2026-08-01")).toBe(true);
    expect(matches({ kind: "range", from: "2026-09-10", to: "待补充" }, "2026-09-09")).toBe(false);
  });
  it("falls back to the recorded date for unknown, relative and wholly unparseable times", () => {
    for (const time of [{ kind: "unknown" }, { kind: "relative", text: "几年前" }, { kind: "range" },
      { kind: "range", from: "很久以前", to: "后来" }, { kind: "date", value: "2026-02-30" }] as const) {
      expect(project(time).basis).toBe("recorded");
      expect(matches(time, "2026-11-03")).toBe(true);
      expect(matches(time, "2026-09-15")).toBe(false);
    }
  });
  it("does not reverse contradictory bounds or invent an interval between them", () => {
    expect(project({ kind: "range", from: "2026-10", to: "2026-09" }).basis).toBe("recorded");
    expect(project({ kind: "range", from: "2026-09-10T10:00:00Z", to: "2026-09-10T09:00:00Z" }).basis).toBe("recorded");
  });
  it("keeps calendar dates and months invariant in western and eastern zones", () => {
    for (const zone of ["America/Los_Angeles", "Asia/Shanghai", "UTC"]) {
      expect(matches({ kind: "date", value: "2026-09-20" }, "2026-09-20", undefined, zone)).toBe(true);
      expect(matches({ kind: "month", value: "2026-09" }, "2026-09-30", undefined, zone)).toBe(true);
    }
  });
  it("maps explicit instants and the recording-date fallback to the requested local date", () => {
    const time = { kind: "instant", value: "2026-09-20T00:30:00Z" } as const;
    expect(matches(time, "2026-09-19", undefined, "America/Los_Angeles")).toBe(true);
    expect(matches(time, "2026-09-20", undefined, "America/Los_Angeles")).toBe(false);
    expect(matches(time, "2026-09-20", undefined, "Asia/Shanghai")).toBe(true);
    expect(matches({ kind: "unknown" }, "2026-11-02", undefined, "America/Los_Angeles")).toBe(true);
  });
  it("normalizes offset-equivalent instants for sorting", () => {
    expect(project({ kind: "instant", value: "2026-09-20T00:30:00Z" }).sortKey)
      .toBe(project({ kind: "instant", value: "2026-09-20T08:30:00+08:00" }).sortKey);
    expect(project({ kind: "instant", value: "2026-09-19T23:30:00Z" }).sortKey <
      project({ kind: "instant", value: "2026-09-20T00:30:00Z" }).sortKey).toBe(true);
  });
  it("sorts the repeated DST hour by actual instant, not its repeated clock text", () => {
    const early = project({ kind: "instant", value: "2026-11-01T01:50:00-07:00" }, "America/Los_Angeles");
    const later = project({ kind: "instant", value: "2026-11-01T01:10:00-08:00" }, "America/Los_Angeles");
    expect(early.lowerDay).toBe(later.lowerDay);
    expect(early.sortKey < later.sortKey).toBe(true);
  });
  it("handles year zero and local dates before year zero without lexical date mistakes", () => {
    expect(calendarDateDay("0000-01-01")).toBe(-719528);
    const early = project({ kind: "instant", value: "0000-01-01T00:00:00Z" }, "America/Los_Angeles");
    expect(early.upperDay).toBe(calendarDateDay("0000-01-01")! - 1);
    expect(early.sortKey).toMatch(/^\d{9}:\d{15}$/);
    expect(matches({ kind: "instant", value: "0000-01-01T00:00:00Z" }, "0000-01-01", undefined, "America/Los_Angeles")).toBe(false);
  });
  it("rejects invalid and reversed filters rather than ignoring them", () => {
    for (const input of [{ from: "2026-02-29" }, { from: "2026-09" }, { from: "2026-09-20", to: "2026-09-19" },
      { timeZone: "unknown/zone" }, { timeZone: "" }, { timeZone: "UTC\n" }]) {
      expect(resolveRecordDateFilter(input)).toBeUndefined();
    }
    expect(resolveRecordDateFilter({ from: "2024-02-29", timeZone: "UTC" })).toBeDefined();
    expect(recordTimeZone()).toBeTruthy();
    expect(recordTimeZone("Etc/UTC")).toBe(recordTimeZone("UTC"));
  });
  it("does not infer timezone-less clock values or roll invalid calendar dates", () => {
    expect(project({ kind: "instant", value: "2026-09-20T10:00:00" }).basis).toBe("recorded");
    expect(project({ kind: "range", from: "2026-02-30T00:00:00Z", to: "2026-03-01" }).lowerDay).toBeUndefined();
    expect(projectRecordDate({ occurredAt: { kind: "unknown" }, recordedAt: "invalid" }, "UTC")).toBeUndefined();
  });
});
