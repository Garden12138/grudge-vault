import { describe, expect, it } from "vitest";
import { AppError } from "@grudge-vault/shared";
import { normalizeDayOneImportReceipt } from "./dayone-import-receipt";

const receipt = { finishedAt: "2026-09-29T08:30:00.000Z", outcome: "completed", totalEntries: 3,
  included: 0, skipped: 3, review: 0, failed: 0, issueCount: 0, mediaEntries: 0, missingMedia: 0 };
describe("terminal Day One receipt whitelist", () => {
  it("projects only aggregate fields and makes independent usage copies", () => {
    const usage = { requests: 3, responses: 2, completeUsageResponses: 1, promptTokens: 20, completionTokens: 5 };
    const input = { ...receipt, body: "private-synthetic-body", operationId: "private-source-id", filename: "private.zip",
      usage: { ...usage, apiKey: "synthetic-secret", rawUsage: { privateBody: "private" } }, errorCode: "private-error" };
    const result = normalizeDayOneImportReceipt(input);
    expect(result).toEqual({ ...receipt, usage, errorCode: "INTERNAL_ERROR" });
    expect(JSON.stringify(result)).not.toMatch(/private|synthetic-secret|operationId/);
    result.usage!.promptTokens = 99; expect(input.usage.promptTokens).toBe(20);
  });
  it("keeps unknown totals and media separate from legitimate zero and permits partial outcomes", () => {
    const partial = { finishedAt: receipt.finishedAt, outcome: "cancelled", totalEntries: null,
      included: 0, skipped: 0, review: 0, failed: 0, issueCount: 0 };
    expect(normalizeDayOneImportReceipt(partial)).toEqual(partial);
    expect(normalizeDayOneImportReceipt({ ...receipt, totalEntries: 0, skipped: 0 })).toMatchObject({ totalEntries: 0, missingMedia: 0 });
    expect(normalizeDayOneImportReceipt({ ...partial, outcome: "failed", totalEntries: 5, skipped: 2 }))
      .toMatchObject({ outcome: "failed", skipped: 2 });
  });
  it("rejects malformed timestamps, active outcomes and a completed batch without a final media summary", () => {
    for (const finishedAt of ["synthetic-private-date", "2026-02-30T00:00:00.000Z", "2026-09-29T08:30:00Z", 123]) {
      expect(() => normalizeDayOneImportReceipt({ ...receipt, finishedAt })).toThrowError(AppError);
    }
    for (const outcome of ["screening", "paused", "stopping", "private-outcome", null]) {
      expect(() => normalizeDayOneImportReceipt({ ...receipt, outcome })).toThrowError(AppError);
    }
    expect(() => normalizeDayOneImportReceipt({ ...receipt, totalEntries: null })).toThrowError(AppError);
    expect(() => normalizeDayOneImportReceipt({ ...receipt, mediaEntries: undefined })).toThrowError(AppError);
    expect(() => normalizeDayOneImportReceipt({ ...receipt, missingMedia: undefined })).toThrowError(AppError);
  });
  it("rejects invalid counters, aggregate overflow and totals inconsistent with known work", () => {
    for (const count of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "3"])
      expect(() => normalizeDayOneImportReceipt({ ...receipt, skipped: count })).toThrowError(AppError);
    expect(() => normalizeDayOneImportReceipt({ ...receipt, included: 1 })).toThrowError(AppError);
    expect(() => normalizeDayOneImportReceipt({ ...receipt, mediaEntries: 4 })).toThrowError(AppError);
    expect(() => normalizeDayOneImportReceipt({ ...receipt, totalEntries: Number.MAX_SAFE_INTEGER,
      included: Number.MAX_SAFE_INTEGER, skipped: 1 })).toThrowError(AppError);
  });
  it("rejects impossible usage without turning missing measurements into complete zero", () => {
    expect(normalizeDayOneImportReceipt(receipt).usage).toBeUndefined();
    const usage = { requests: 2, responses: 1, completeUsageResponses: 0, promptTokens: 0, completionTokens: 0 };
    expect(normalizeDayOneImportReceipt({ ...receipt, usage }).usage).toEqual(usage);
    for (const next of [{ ...usage, responses: 3 }, { ...usage, completeUsageResponses: 2 }, { ...usage, promptTokens: -1 }, null])
      expect(() => normalizeDayOneImportReceipt({ ...receipt, usage: next })).toThrowError(AppError);
  });
});
