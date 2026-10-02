import { describe, expect, it } from "vitest";
import type { ModelUsageEvent, ScreenedZipImportCounters, ScreenedZipImportSummary } from "@grudge-vault/domain";
import { DayOneImportProgress } from "./dayone-import-progress";

const zero: ScreenedZipImportCounters = { included: 0, skipped: 0, review: 0, failed: 0, issueCount: 0 };
const result: ScreenedZipImportSummary = { ...zero, totalEntries: 4, included: 1, skipped: 1, review: 1, failed: 1,
  mediaEntries: 2, missingMedia: 1, issueCount: 1 };

describe("volatile Day One aggregate progress", () => {
  it("records metadata persistence separately without changing terminal counts or time", () => {
    const progress = new DayOneImportProgress(); const workspace = {}; const id = progress.begin(workspace);
    progress.markReceiptSaved(id, true); expect(progress.read(workspace)?.receiptSaved).toBeUndefined();
    progress.finish(id, "completed", result); const finished = progress.read(workspace)!;
    progress.markReceiptSaved("old-id", false); expect(progress.read(workspace)).toEqual(finished);
    progress.markReceiptSaved(id, false); expect(progress.read(workspace)).toEqual({ ...finished, receiptSaved: false });
    progress.markReceiptSaved(id, true); expect(progress.read(workspace)).toEqual({ ...finished, receiptSaved: true });
    progress.begin(workspace); progress.markReceiptSaved(id, true); expect(progress.read(workspace)?.receiptSaved).toBeUndefined();
  });
  it("scopes snapshots to the current open session and clears them on close or replacement", () => {
    const progress = new DayOneImportProgress(); const workspace = {};
    const id = progress.begin(workspace);
    expect(progress.read(workspace)).toMatchObject({ operationId: id, phase: "selecting", totalEntries: null, ...zero });
    expect(progress.read(undefined)).toBeNull(); expect(progress.read(workspace)).toBeNull();
    progress.begin(workspace); expect(progress.read({})).toBeNull(); expect(progress.read(workspace)).toBeNull();
  });
  it("publishes only whitelisted aggregate fields and returns independent snapshots", () => {
    const progress = new DayOneImportProgress(); const workspace = { secretKey: "synthetic-private-key" };
    const id = progress.begin(workspace);
    progress.update(id, { ...result, body: "synthetic-private-body", path: "/private/synthetic.json" } as ScreenedZipImportCounters);
    progress.finish(id, "completed", { ...result, filename: "private-title.zip" } as ScreenedZipImportSummary);
    const snapshot = progress.read(workspace)!;
    expect(snapshot).toMatchObject({ phase: "completed", totalEntries: 4, summary: result });
    expect(Object.keys(snapshot).sort()).toEqual(["failed", "included", "issueCount", "operationId", "phase", "review", "skipped", "summary", "totalEntries", "updatedAt"].sort());
    expect(JSON.stringify(snapshot)).not.toMatch(/synthetic-private|private-title|\/private/);
    snapshot.included = 99; snapshot.summary!.included = 100;
    expect(progress.read(workspace)?.included).toBe(1); expect(progress.read(workspace)?.summary?.included).toBe(1);
  });
  it("ignores late operations and never revives a terminal or stopping operation", () => {
    const progress = new DayOneImportProgress(); const workspace = {};
    const old = progress.begin(workspace); const id = progress.begin(workspace);
    progress.update(old, result); progress.finish(old, "failed");
    expect(progress.read(workspace)).toMatchObject(zero);
    progress.phase(id, "confirming", 4); progress.phase(id, "screening"); progress.phase(id, "stopping");
    progress.phase(id, "screening"); expect(progress.read(workspace)?.phase).toBe("stopping");
    progress.phase(id, "pausing"); progress.phase(id, "paused");
    expect(progress.read(workspace)?.phase).toBe("stopping");
    progress.update(id, { ...zero, included: 1 }); progress.finish(id, "cancelled", undefined, "IMPORT_CANCELLED");
    const snapshot = progress.read(workspace);
    progress.update(id, result); progress.phase(id, "screening"); progress.finish(id, "completed", result);
    expect(progress.read(workspace)).toEqual(snapshot);
    expect(snapshot).toMatchObject({ phase: "cancelled", included: 1, errorCode: "IMPORT_CANCELLED" });
  });
  it("rejects invalid or regressing counters, totals and completion summaries", () => {
    const progress = new DayOneImportProgress(); const workspace = {}; const id = progress.begin(workspace);
    progress.phase(id, "screening", 4); progress.update(id, { ...zero, included: 1 });
    const snapshot = progress.read(workspace);
    for (const invalid of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      progress.update(id, { ...zero, included: invalid }); progress.phase(id, "screening", invalid);
      progress.finish(id, "completed", { ...result, missingMedia: invalid });
      expect(progress.read(workspace)).toEqual(snapshot);
    }
    progress.update(id, { ...zero, skipped: 2 });
    progress.finish(id, "completed", { ...result, included: 0 });
    expect(progress.read(workspace)).toEqual(snapshot);
  });
  it("preserves counters on failure and allows only known error codes", () => {
    const progress = new DayOneImportProgress(); const workspace = {}; const id = progress.begin(workspace);
    progress.update(id, { ...zero, review: 2 });
    progress.finish(id, "failed", undefined, "synthetic-private-error-body");
    expect(progress.read(workspace)).toMatchObject({ phase: "failed", review: 2, errorCode: "INTERNAL_ERROR" });
    const retry = progress.begin(workspace);
    progress.finish(retry, "failed", undefined, "CLEANUP_FAILED");
    expect(progress.read(workspace)).toMatchObject({ phase: "failed", ...zero, errorCode: "CLEANUP_FAILED" });
  });

  it("keeps only numeric aggregate usage, distinguishes incomplete returns and copies snapshots", () => {
    const progress = new DayOneImportProgress(); const workspace = {}; const id = progress.begin(workspace);
    progress.observeUsage(id, { kind: "response-received", promptTokens: 99, completionTokens: 99 });
    expect(progress.read(workspace)?.usage).toBeUndefined();
    progress.observeUsage(id, { kind: "request-started", privateBody: "synthetic-private" } as ModelUsageEvent);
    progress.observeUsage(id, { kind: "request-started" });
    progress.observeUsage(id, { kind: "response-received", promptTokens: 12, completionTokens: 3 });
    progress.observeUsage(id, { kind: "response-received", promptTokens: 5 });
    const snapshot = progress.read(workspace)!;
    expect(snapshot.usage).toEqual({ requests: 2, responses: 2, completeUsageResponses: 1, promptTokens: 17, completionTokens: 3 });
    expect(JSON.stringify(snapshot)).not.toContain("synthetic-private"); snapshot.usage!.promptTokens = 999;
    expect(progress.read(workspace)?.usage?.promptTokens).toBe(17);
    progress.observeUsage(id, { kind: "response-received", promptTokens: 100, completionTokens: 10 });
    expect(progress.read(workspace)?.usage?.promptTokens).toBe(17);
  });

  it("does not convert absent or invalid usage into a fully measured zero", () => {
    const progress = new DayOneImportProgress(); const workspace = {};
    for (const promptTokens of [undefined, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      const id = progress.begin(workspace); progress.observeUsage(id, { kind: "request-started" });
      progress.observeUsage(id, { kind: "response-received", ...(promptTokens !== undefined ? { promptTokens } : {}) });
      expect(progress.read(workspace)?.usage).toEqual({ requests: 1, responses: 1, completeUsageResponses: 0, promptTokens: 0, completionTokens: 0 });
    }
    const id = progress.begin(workspace); progress.observeUsage(id, { kind: "request-started" });
    progress.observeUsage(id, { kind: "response-received", promptTokens: 0, completionTokens: 0 });
    expect(progress.read(workspace)?.usage?.completeUsageResponses).toBe(1);
  });

  it("keeps sums within safe integer bounds and marks an overflowing response unmeasured", () => {
    const progress = new DayOneImportProgress(); const workspace = {}; const id = progress.begin(workspace);
    progress.observeUsage(id, { kind: "request-started" });
    progress.observeUsage(id, { kind: "response-received", promptTokens: Number.MAX_SAFE_INTEGER, completionTokens: 0 });
    progress.observeUsage(id, { kind: "request-started" });
    progress.observeUsage(id, { kind: "response-received", promptTokens: 1, completionTokens: 1 });
    expect(progress.read(workspace)?.usage).toEqual({ requests: 2, responses: 2, completeUsageResponses: 1,
      promptTokens: Number.MAX_SAFE_INTEGER, completionTokens: 0 });
  });

  it("preserves observed usage while stopping but rejects late, foreign and ended batch events", () => {
    const progress = new DayOneImportProgress(); const workspace = {}; const old = progress.begin(workspace); const id = progress.begin(workspace);
    progress.observeUsage(old, { kind: "request-started" }); expect(progress.read(workspace)?.usage).toBeUndefined();
    progress.observeUsage(id, { kind: "request-started" }); progress.phase(id, "stopping");
    progress.observeUsage(id, { kind: "response-received", promptTokens: 3, completionTokens: 1 });
    progress.finish(id, "cancelled"); const snapshot = progress.read(workspace);
    progress.observeUsage(id, { kind: "request-started" });
    expect(progress.read(workspace)).toEqual(snapshot); expect(snapshot?.usage?.promptTokens).toBe(3);
    expect(progress.read(undefined)).toBeNull(); expect(progress.read(workspace)).toBeNull();
  });
});
