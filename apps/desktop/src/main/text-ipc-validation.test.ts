import { describe, expect, it } from "vitest";
import { RECORD_QUERY_TEXT_LIMIT, RECORD_TEXT_LIMIT } from "@grudge-vault/shared";
import { boundedTextSchema } from "./text-ipc-validation";

describe("Unicode text IPC validation", () => {
  it.each([RECORD_TEXT_LIMIT, RECORD_QUERY_TEXT_LIMIT])("accepts exactly %i code points and rejects an extra BMP or astral character", (maximum) => {
    const schema = boundedTextSchema(maximum);
    for (const text of ["字".repeat(maximum), "🧾".repeat(maximum), "字𠮷🧾".repeat(Math.floor(maximum / 3)) + "字".repeat(maximum % 3)]) {
      expect(schema.parse(text) === text).toBe(true);
      expect(schema.safeParse(`${text}字`).success).toBe(false);
      expect(schema.safeParse(`${text}𠮷`).success).toBe(false);
    }
  });

  it("rejects non-string and oversized IPC values without truncating valid text", () => {
    const schema = boundedTextSchema(RECORD_QUERY_TEXT_LIMIT);
    for (const input of [undefined, null, 500, {}, [], "x".repeat(100_000)]) expect(schema.safeParse(input).success).toBe(false);
    expect(schema.parse("  𠮷\ne\u0301  ")).toBe("  𠮷\ne\u0301  ");
  });
});
