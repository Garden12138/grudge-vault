import { describe, expect, it } from "vitest";
import { syntheticScreeningCases } from "../../../tests/fixtures/screening-cases";

describe("fictional screening regression cases", () => {
  it("keeps 200 unique cases with the requested label and modality coverage", () => {
    expect(syntheticScreeningCases).toHaveLength(200);
    expect(new Set(syntheticScreeningCases.map(({ id }) => id)).size).toBe(200);
    expect(syntheticScreeningCases.filter(({ expected }) => expected === "include")).toHaveLength(80);
    expect(syntheticScreeningCases.filter(({ expected }) => expected === "skip")).toHaveLength(80);
    expect(syntheticScreeningCases.filter(({ expected }) => expected === "review")).toHaveLength(40);
    expect(syntheticScreeningCases.filter(({ media }) => media)).toHaveLength(60);
    expect(syntheticScreeningCases.filter(({ category }) => category === "danger").length).toBeGreaterThanOrEqual(20);
    expect(syntheticScreeningCases.every(({ text }) => !text.includes("真实姓名"))).toBe(true);
  });
});
