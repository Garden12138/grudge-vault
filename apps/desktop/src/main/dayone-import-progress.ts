import { randomUUID } from "node:crypto";
import type { ModelUsageEvent, ScreenedZipImportCounters, ScreenedZipImportProgress, ScreenedZipImportSummary } from "@grudge-vault/domain";
import { APP_ERROR_CODES } from "@grudge-vault/shared";

const terminal = new Set<ScreenedZipImportProgress["phase"]>(["completed", "cancelled", "failed"]);
type ActivePhase = Exclude<ScreenedZipImportProgress["phase"], "completed" | "cancelled" | "failed">;
const validCount = (value: number) => Number.isSafeInteger(value) && value >= 0;
const counters = (value: ScreenedZipImportCounters): ScreenedZipImportCounters => ({
  included: value.included, skipped: value.skipped, review: value.review, failed: value.failed, issueCount: value.issueCount
});
const summary = (value: ScreenedZipImportSummary): ScreenedZipImportSummary => ({ ...counters(value),
  totalEntries: value.totalEntries, mediaEntries: value.mediaEntries, missingMedia: value.missingMedia
});

/** One in-memory aggregate, scoped to the current session without retaining vault keys or input content. */
export class DayOneImportProgress {
  private context: WeakRef<object> | undefined;
  private value: ScreenedZipImportProgress | undefined;

  begin(context: object): string {
    const operationId = randomUUID();
    this.context = new WeakRef(context);
    this.value = { operationId, phase: "selecting", totalEntries: null, included: 0, skipped: 0,
      review: 0, failed: 0, issueCount: 0, updatedAt: new Date().toISOString() };
    return operationId;
  }
  read(context: object | undefined): ScreenedZipImportProgress | null {
    if (!context || this.context?.deref() !== context) { this.clear(); return null; }
    return this.value ? { ...this.value, ...(this.value.summary ? { summary: summary(this.value.summary) } : {}),
      ...(this.value.usage ? { usage: { ...this.value.usage } } : {}) } : null;
  }
  phase(operationId: string, phase: ActivePhase, totalEntries?: number) {
    if (!this.owns(operationId) || totalEntries !== undefined && !validCount(totalEntries)) return;
    if (this.value!.phase === "stopping" && phase !== "stopping") return;
    this.value = { ...this.value!, phase, ...(totalEntries === undefined ? {} : { totalEntries }), updatedAt: new Date().toISOString() };
  }
  update(operationId: string, value: ScreenedZipImportCounters) {
    const next = counters(value);
    if (!this.owns(operationId) || !this.validCounters(next)) return;
    // Late observations must not reduce previously completed work.
    this.value = { ...this.value!, ...next, updatedAt: new Date().toISOString() };
  }
  observeUsage(operationId: string, event: ModelUsageEvent) {
    if (!this.owns(operationId)) return;
    const current = this.value!.usage ?? { requests: 0, responses: 0, completeUsageResponses: 0, promptTokens: 0, completionTokens: 0 };
    if (event.kind === "request-started") {
      if (!validCount(current.requests + 1)) return;
      this.value = { ...this.value!, usage: { ...current, requests: current.requests + 1 }, updatedAt: new Date().toISOString() };
    } else if (event.kind === "response-received" && current.responses < current.requests) {
      const validUsage = (event.promptTokens === undefined || validCount(event.promptTokens)) &&
        (event.completionTokens === undefined || validCount(event.completionTokens)) &&
        validCount(current.promptTokens + (event.promptTokens ?? 0)) && validCount(current.completionTokens + (event.completionTokens ?? 0));
      const complete = validUsage && event.promptTokens !== undefined && event.completionTokens !== undefined;
      this.value = { ...this.value!, usage: { ...current, responses: current.responses + 1,
        completeUsageResponses: current.completeUsageResponses + (complete ? 1 : 0),
        promptTokens: current.promptTokens + (validUsage ? event.promptTokens ?? 0 : 0),
        completionTokens: current.completionTokens + (validUsage ? event.completionTokens ?? 0 : 0)
      }, updatedAt: new Date().toISOString() };
    }
  }
  finish(operationId: string, phase: "completed" | "cancelled" | "failed", value?: ScreenedZipImportSummary, errorCode?: string) {
    if (!this.owns(operationId)) return;
    if (value && (!this.validCounters(counters(value)) ||
      ![value.totalEntries, value.mediaEntries, value.missingMedia].every(validCount))) return;
    if (value) this.update(operationId, value);
    this.value = { ...this.value!, phase, ...(value ? { totalEntries: value.totalEntries, summary: summary(value) } : {}),
      ...(errorCode ? { errorCode: (APP_ERROR_CODES as readonly string[]).includes(errorCode) ? errorCode : "INTERNAL_ERROR" } : {}),
      updatedAt: new Date().toISOString() };
  }
  clear() { this.value = undefined; this.context = undefined; }
  markReceiptSaved(operationId: string, saved: boolean) {
    if (this.value?.operationId !== operationId || !terminal.has(this.value.phase)) return;
    // Metadata persistence must not change the batch's actual end time or outcome.
    this.value = { ...this.value, receiptSaved: saved };
  }
  private validCounters(value: ScreenedZipImportCounters) {
    return Object.entries(value).every(([key, count]) => validCount(count) && count >= this.value![key as keyof ScreenedZipImportCounters]);
  }
  private owns(operationId: string) { return this.value?.operationId === operationId && !terminal.has(this.value.phase); }
}
