import { describe, expect, it } from "vitest";
import { codePointLength, RECORD_QUERY_TEXT_LIMIT, RECORD_TEXT_LIMIT } from "./text-limits";

describe("record Unicode text limits", () => {
  it.each([
    ["", 0], ["中文 ABC", 6], ["𠮷🧾", 2], ["e\u0301", 2], ["👨‍👩‍👧‍👦", 7], ["\ud800x\udc00", 3]
  ])("counts code points for %j without normalizing or treating a grapheme as one point", (value, expected) => {
    expect(codePointLength(value as string)).toBe(expected);
  });

  it("keeps the documented manual and search limits", () => {
    expect(RECORD_TEXT_LIMIT).toBe(50_000);
    expect(RECORD_QUERY_TEXT_LIMIT).toBe(500);
    expect(codePointLength("𠮷🧾".repeat(RECORD_TEXT_LIMIT / 2))).toBe(RECORD_TEXT_LIMIT);
  });
});
