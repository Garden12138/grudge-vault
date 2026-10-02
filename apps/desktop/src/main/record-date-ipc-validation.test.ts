import { expect, it } from "vitest";
import { recordTimeZoneSchema } from "./record-date-ipc-validation";

it("validates and canonicalizes record query time zones before invoking the application", () => {
  expect(recordTimeZoneSchema.parse("America/Los_Angeles")).toBe("America/Los_Angeles");
  expect(recordTimeZoneSchema.parse("Etc/UTC")).toBe("UTC");
  for (const value of [null, 123, "", "UTC\n", "unknown/zone", " ", "x".repeat(101)]) {
    expect(recordTimeZoneSchema.safeParse(value).success).toBe(false);
  }
});
