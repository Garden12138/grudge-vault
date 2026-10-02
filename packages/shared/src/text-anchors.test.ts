import { describe, expect, it, vi } from "vitest";
import { findCaseInsensitiveTextRange } from "./text-anchors";

describe("original code-point text anchors after case conversion", () => {
  it.each([
    ["prefix TARGET tail", "target", [7, 13], "TARGET"],
    ["😀𠮷合成目标尾部", "目标", [4, 6], "目标"],
    ["İ😀合成目标尾部", "目标", [4, 6], "目标"],
    ["İİ😀合成目标尾部", "目标", [5, 7], "目标"],
    ["İ😀TARGET尾部", "i\u0307😀target", [0, 8], "İ😀TARGET"],
    ["İ目标", "i", [0, 1], "İ"],
    ["İ目标", "\u0307", [0, 1], "İ"],
    ["ΟΣ 目标", "ος", [0, 2], "ΟΣ"],
    ["e\u0301😀目标", "目标", [3, 5], "目标"],
    ["甲\ud800目标\udc00", "目标", [2, 4], "目标"]
  ] as const)("maps %j / %j to the unchanged original span", (source, query, expected, original) => {
    const range = findCaseInsensitiveTextRange(source, query);
    expect(range).toEqual(expected);
    expect(Array.from(source).slice(range![0], range![1]).join("")).toBe(original);
  });
  it("does not produce an anchor for empty or absent matches", () => {
    expect(findCaseInsensitiveTextRange("synthetic", "")).toBeUndefined();
    expect(findCaseInsensitiveTextRange("", "x")).toBeUndefined();
    expect(findCaseInsensitiveTextRange("synthetic", "absent")).toBeUndefined();
  });
  it("omits a precise range when character widths do not align with whole-string casing", () => {
    const changedRuntime = vi.spyOn(String.prototype, "toLowerCase").mockReturnValue("xx");
    try { expect(findCaseInsensitiveTextRange("目标", "目标")).toBeUndefined(); }
    finally { changedRuntime.mockRestore(); }
  });
  it("keeps the 50,000-code-point input intact and locates its tail", () => {
    const source = `İ${"😀".repeat(49_997)}目标`;
    expect(findCaseInsensitiveTextRange(source, "目标")).toEqual([49_998, 50_000]);
    expect(Array.from(source).length).toBe(50_000);
  });
});
