import type { ModelUsageTotals, ScreenedZipImportReceipt } from "@grudge-vault/domain";
import { APP_ERROR_CODES, AppError } from "@grudge-vault/shared";

export const DAYONE_IMPORT_RECEIPT_KEY = "redesign.last-dayone-import-v1";
const invalid = (): never => { throw new AppError("VALIDATION_FAILED", "导入批次摘要无效。"); };
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
const count = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : invalid();

/** Explicit projection, not a spread: unknown fields must never reach SQLite or the renderer. */
export function normalizeDayOneImportReceipt(value: unknown): ScreenedZipImportReceipt {
  const input = object(value);
  const { finishedAt, outcome } = input;
  if (typeof finishedAt !== "string" || !Number.isFinite(Date.parse(finishedAt)) ||
      new Date(finishedAt).toISOString() !== finishedAt ||
      outcome !== "completed" && outcome !== "cancelled" && outcome !== "failed") return invalid();
  const result: ScreenedZipImportReceipt = { finishedAt, outcome,
    totalEntries: input.totalEntries === null ? null : count(input.totalEntries),
    included: count(input.included), skipped: count(input.skipped), review: count(input.review),
    failed: count(input.failed), issueCount: count(input.issueCount) };
  const processed = result.included + result.skipped + result.review + result.failed;
  if (!Number.isSafeInteger(processed) || result.totalEntries !== null && processed > result.totalEntries) return invalid();
  if (input.mediaEntries !== undefined || input.missingMedia !== undefined) {
    result.mediaEntries = count(input.mediaEntries); result.missingMedia = count(input.missingMedia);
    if (result.totalEntries !== null && result.mediaEntries > result.totalEntries) return invalid();
  }
  if (outcome === "completed" && (result.totalEntries === null || result.mediaEntries === undefined)) return invalid();
  if (input.errorCode !== undefined) {
    result.errorCode = typeof input.errorCode === "string" && (APP_ERROR_CODES as readonly string[]).includes(input.errorCode)
      ? input.errorCode : "INTERNAL_ERROR";
  }
  if (input.usage !== undefined) {
    const raw = object(input.usage);
    const usage: ModelUsageTotals = { requests: count(raw.requests), responses: count(raw.responses),
      completeUsageResponses: count(raw.completeUsageResponses), promptTokens: count(raw.promptTokens), completionTokens: count(raw.completionTokens) };
    if (usage.responses > usage.requests || usage.completeUsageResponses > usage.responses) return invalid();
    result.usage = usage;
  }
  return result;
}
