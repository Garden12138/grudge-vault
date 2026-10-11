import { describe, expect, it } from "vitest";
import type { TemporalValue } from "@grudge-vault/domain";
import { timeEditorDraft, timeEditorValue } from "./record-time-input";

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
