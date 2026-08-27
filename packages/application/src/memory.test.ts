import { Readable } from "node:stream";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GrudgeVaultApplication, parseConservativeTemporalValue,
  type EmbeddingAdapterPort, type EventDraftGeneratorPort, type NormalizedDayOneEntry, type ObjectVaultPort,
  type WorkspaceManagerPort, type WorkspaceSession
} from "./index";
import type { ImportRun } from "@grudge-vault/domain";
import {
  runMigrations, SqliteAgentRepository, SqliteAssetRepository, SqliteDayOneRepository, SqliteJobRepository, SqliteMemoryRepository
} from "@grudge-vault/persistence-sqlite";
import { AppError } from "@grudge-vault/shared";

function testContext(generator?: EventDraftGeneratorPort, embeddingAdapter?: EmbeddingAdapterPort) {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  runMigrations(database);
  const vault: ObjectVaultPort = {
    async put() { return { sha256: "a".repeat(64), byteSize: 4, vaultFormat: 1, deduplicated: false }; },
    async putStream() { return { sha256: "a".repeat(64), byteSize: 4, vaultFormat: 1, deduplicated: false }; },
    async open() { return Readable.from(Buffer.from("test")); },
    async verify() { return true; },
    async exists() { return true; },
    async remove() {},
    async cleanupTempFiles() {}
  };
  const memory = new SqliteMemoryRepository(database);
  const session: WorkspaceSession = {
    workspace: {
      id: "00000000-0000-4000-8000-000000000001", name: "Test", rootPath: "/tmp/test",
      formatVersion: 1, createdAt: "2026-08-24T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z"
    },
    key: Buffer.alloc(32),
    assets: new SqliteAssetRepository(database), jobs: new SqliteJobRepository(database),
    memory, agents: new SqliteAgentRepository(database), dayOne: new SqliteDayOneRepository(database, memory), vault,
    async backupDatabase() {}, async close() { database.close(); }
  };
  const manager: WorkspaceManagerPort = {
    current: () => session,
    async create() { return session; }, async open() { return session; },
    async createBackup() { throw new Error("unused"); }, async restoreBackup() { return session; },
    async close() {}
  };
  return { database, session, application: new GrudgeVaultApplication(manager, generator, undefined, embeddingAdapter) };
}

describe("Phase 1 event recording application", () => {
  let contexts: Array<{ database: Database.Database }>;

  beforeEach(() => { contexts = []; });
  afterEach(() => {
    for (const { database } of contexts) if (database.open) database.close();
  });

  it("preserves fuzzy time instead of inventing a precise date", () => {
    expect(parseConservativeTemporalValue("事情大约 9 月发生")).toEqual({ kind: "relative", text: "大约 9 月" });
    expect(parseConservativeTemporalValue("发生于 2026年9月12日")).toEqual({ kind: "date", value: "2026-09-12" });
    expect(parseConservativeTemporalValue("错误日期 2026年99月99日")).toEqual({ kind: "unknown" });
    expect(parseConservativeTemporalValue("没有时间信息")).toEqual({ kind: "unknown" });
  });

  it("keeps the raw message when record generation fails", async () => {
    const failing: EventDraftGeneratorPort = {
      identity: "test.failure", version: 1,
      async generate() { throw new AppError("INTERNAL_ERROR", "generator unavailable", true); }
    };
    const context = testContext(failing);
    contexts.push(context);
    const conversation = context.application.createConversation("Inbox");
    const result = await context.application.sendMessage({
      conversationId: conversation.id, content: "A durable raw message", intent: "record"
    });
    expect(result.event).toBeUndefined();
    expect(result.eventError?.code).toBe("INTERNAL_ERROR");
    expect(context.application.listMessages(conversation.id)[0]?.content).toBe("A durable raw message");
    expect(context.application.searchEvents({})).toEqual([]);
  });

  it("saves source intent without creating an event", async () => {
    const context = testContext();
    contexts.push(context);
    const conversation = context.application.createConversation("Inbox");
    const result = await context.application.sendMessage({
      conversationId: conversation.id, content: "Keep this original text", intent: "source"
    });
    expect(result.event).toBeUndefined();
    expect(result.eventError).toBeUndefined();
    expect(context.application.listMessages(conversation.id)[0]?.content).toBe("Keep this original text");
    expect(context.application.searchEvents({})).toEqual([]);
  });

  it("creates a sourced confirmed record and resolves its clarification with a revision", async () => {
    const context = testContext();
    contexts.push(context);
    const conversation = context.application.createConversation("Inbox");
    const result = await context.application.sendMessage({
      conversationId: conversation.id, content: "Someone removed my name from the report", intent: "record"
    });
    expect(result.event?.status).toBe("confirmed");
    expect(result.event?.occurredAt).toEqual({ kind: "unknown" });
    expect(result.event?.sourceRefs).toEqual([result.message.sourceItemId]);
    const clarification = context.application.listClarifications(result.event!.id)[0]!;
    const updated = context.application.answerClarification({
      clarificationId: clarification.id, answer: "Around September", expectedRevision: 1
    });
    expect(updated.currentRevision).toBe(2);
    expect(updated.completeness.openClarificationCount).toBe(0);
    expect(context.application.listEventRevisions(updated.id)).toHaveLength(2);
    expect(context.database.prepare("SELECT content FROM source_items WHERE id = ?").get(updated.sourceRefs.at(-1))).toEqual({
      content: "Around September"
    });
  });

  it("rejects stale edits without overwriting the current projection", async () => {
    const context = testContext();
    contexts.push(context);
    const conversation = context.application.createConversation("Inbox");
    const recorded = await context.application.sendMessage({ conversationId: conversation.id, content: "Event text", intent: "record" });
    const event = recorded.event!;
    const fields = {
      title: "Edited once", status: event.status, occurredAt: event.occurredAt,
      facts: event.facts, interpretations: event.interpretations, emotions: event.emotions,
      interests: event.interests, participants: event.participants,
      sourceRefs: event.sourceRefs, assetRefs: event.assetRefs
    };
    context.application.updateEvent({ eventId: event.id, expectedRevision: 1, reason: "first edit", ...fields });
    expect(() => context.application.updateEvent({
      eventId: event.id, expectedRevision: 1, reason: "stale edit", ...fields, title: "Stale"
    })).toThrow(/changed/);
    expect(context.application.getEvent(event.id).event.title).toBe("Edited once");
  });

  it("previews only allowlisted assets within the memory limit", async () => {
    const context = testContext();
    contexts.push(context);
    const now = "2026-08-24T00:00:00.000Z";
    context.session.assets.upsert({
      id: "asset-text", sha256: "a".repeat(64), byteSize: 4, mimeType: "text/plain",
      originalFileName: "note.txt", vaultFormat: 1, integrityStatus: "verified", availabilityStatus: "available", createdAt: now
    });
    expect(Buffer.from((await context.application.previewAsset("asset-text")).bytes).toString("utf8")).toBe("test");
    context.session.assets.upsert({
      id: "asset-html", sha256: "b".repeat(64), byteSize: 4, mimeType: "text/html",
      originalFileName: "unsafe.html", vaultFormat: 1, integrityStatus: "verified", availabilityStatus: "available", createdAt: now
    });
    await expect(context.application.previewAsset("asset-html")).rejects.toMatchObject({
      code: "ASSET_PREVIEW_UNAVAILABLE"
    });
    context.session.assets.upsert({
      id: "asset-large", sha256: "c".repeat(64), byteSize: 64 * 1024 * 1024 + 1, mimeType: "video/mp4",
      originalFileName: "large.mp4", vaultFormat: 1, integrityStatus: "verified", availabilityStatus: "available", createdAt: now
    });
    await expect(context.application.previewAsset("asset-large")).rejects.toMatchObject({
      code: "ASSET_PREVIEW_UNAVAILABLE"
    });
  });
});

describe("Phase 2 historical backfill application", () => {
  function importedEntry(
    content: string,
    modifiedDate = "2026-01-02T00:00:00.000Z",
    id = "DAYONE-ENTRY-1",
    tags = ["work"]
  ): NormalizedDayOneEntry {
    return {
      externalId: `uuid:${id.toLocaleLowerCase("en-US")}`, entryUuid: id, fingerprint: "f".repeat(64),
      creationDate: "2026-01-01T00:00:00.000Z", journalDate: "2026-01-01", modifiedDate, timeZone: "Asia/Shanghai",
      text: content, tags, media: [], contentHash: Buffer.from(`${content}:${modifiedDate}`).toString("hex").padEnd(64, "0").slice(0, 64),
      raw: { uuid: id, creationDate: "2026-01-01T00:00:00.000Z", modifiedDate, text: content, tags }
    };
  }

  it("keeps repeated imports idempotent and appends a source version for changes", () => {
    const context = testContext();
    const now = "2026-08-24T00:00:00.000Z";
    context.session.assets.upsert({
      id: "archive-asset", sha256: "d".repeat(64), byteSize: 10, mimeType: "application/zip",
      originalFileName: "DayOne.zip", vaultFormat: 1, integrityStatus: "verified", availabilityStatus: "available", createdAt: now
    });
    const run: ImportRun = {
      id: "import-run-1", archiveAssetId: "archive-asset", archiveFileName: "DayOne.zip", state: "succeeded", progress: 1,
      counts: { totalEntries: 1, newEntries: 1, updatedEntries: 0, skippedEntries: 0, mediaImported: 0, mediaMissing: 0, errorCount: 0 },
      createdAt: now, updatedAt: now, finishedAt: now
    };
    context.session.dayOne.createImportRun(run);
    const first = context.session.dayOne.upsertEntry(run.id, importedEntry("First version"), now);
    const repeated = context.session.dayOne.upsertEntry(run.id, importedEntry("First version"), now);
    const updated = context.session.dayOne.upsertEntry(run.id, importedEntry("Changed version", "2026-01-03T00:00:00.000Z"), now);
    expect(first.outcome).toBe("new");
    expect(repeated.outcome).toBe("skipped");
    expect(updated.outcome).toBe("updated");
    expect(updated.sourceVersion.version).toBe(2);
    expect(context.database.prepare("SELECT count(*) AS count FROM source_versions").get()).toEqual({ count: 2 });
    expect(context.database.prepare("SELECT count(*) AS count FROM source_search_documents").get()).toEqual({ count: 1 });
    expect(context.database.prepare("SELECT content FROM source_search_documents").get()).toEqual({ content: "Changed version" });

    const repeatedRun = { ...run, id: "import-run-1-repeat", counts: { ...run.counts, newEntries: 0, skippedEntries: 1 } };
    context.session.dayOne.createImportRun(repeatedRun);
    expect(context.session.dayOne.upsertEntry(
      repeatedRun.id, importedEntry("Changed version", "2026-01-03T00:00:00.000Z"), now
    ).outcome).toBe("skipped");
    const scoped = context.application.startBackfill({ importRunId: repeatedRun.id, tags: [], batchSize: 25 });
    expect(scoped.totalItems).toBe(1);
    context.database.close();
  });

  it("creates a traceable candidate, preserves relative time, and supports review and merge", async () => {
    const context = testContext();
    const now = "2026-08-24T00:00:00.000Z";
    context.session.assets.upsert({
      id: "archive-asset", sha256: "e".repeat(64), byteSize: 10, mimeType: "application/zip",
      originalFileName: "DayOne.zip", vaultFormat: 1, integrityStatus: "verified", availabilityStatus: "available", createdAt: now
    });
    const run: ImportRun = {
      id: "import-run-2", archiveAssetId: "archive-asset", archiveFileName: "DayOne.zip", state: "succeeded", progress: 1,
      counts: { totalEntries: 3, newEntries: 3, updatedEntries: 0, skippedEntries: 0, mediaImported: 0, mediaMissing: 0, errorCount: 0 },
      createdAt: now, updatedAt: now, finishedAt: now
    };
    context.session.dayOne.createImportRun(run);
    context.session.dayOne.upsertEntry(run.id, importedEntry("上次那件事让我很在意"), now);
    context.session.dayOne.upsertEntry(run.id, importedEntry(
      "2026年1月2日明确发生的记录", "2026-01-03T00:00:00.000Z", "DAYONE-ENTRY-CONFIRM"
    ), now);
    context.session.dayOne.upsertEntry(run.id, importedEntry(
      "Ordinary journal record", "2026-01-04T00:00:00.000Z", "DAYONE-ENTRY-IGNORE"
    ), now);
    const backfill = context.application.startBackfill({ importRunId: run.id, tags: ["work"], batchSize: 25 });
    await context.application.runBackfill(backfill.id, { signal: new AbortController().signal, reportProgress() {} });
    const allCandidates = context.application.listCandidates();
    const candidate = allCandidates.find(({ event }) => event.title.includes("上次"))!;
    expect(candidate.event.occurredAt).toEqual({ kind: "relative", text: "上次" });
    expect(candidate.extraction.temporalBasis).toBe("relative");
    expect(candidate.event.facts).toEqual([]);
    expect(context.application.getCandidate(candidate.event.id).excerpt).toContain("那件事");
    expect(context.application.getEvent(candidate.event.id).clarifications).toHaveLength(1);

    const confirmable = allCandidates.find(({ event }) => event.title.includes("明确发生"))!;
    expect(confirmable.event.occurredAt).toEqual({ kind: "date", value: "2026-01-02" });
    expect(confirmable.extraction.temporalBasis).toBe("source-text");
    expect(() => context.application.updateEvent({
      eventId: confirmable.event.id, expectedRevision: 1, reason: "bypass review",
      title: confirmable.event.title, status: "confirmed", occurredAt: confirmable.event.occurredAt,
      ...(confirmable.event.narrative ? { narrative: confirmable.event.narrative } : {}),
      facts: [], interpretations: [], emotions: [], interests: [],
      participants: [], sourceRefs: confirmable.event.sourceRefs, assetRefs: []
    })).toThrowError(expect.objectContaining({ code: "CANDIDATE_STATE_CONFLICT" }));
    expect(context.application.confirmCandidate(confirmable.event.id, 1).status).toBe("confirmed");
    expect(context.application.getCandidate(confirmable.event.id).extraction.reviewState).toBe("confirmed");
    expect(() => context.application.confirmCandidate(confirmable.event.id, 2)).toThrowError(
      expect.objectContaining({ code: "CANDIDATE_STATE_CONFLICT" })
    );

    const ignorable = allCandidates.find(({ event }) => event.title.includes("Ordinary"))!;
    expect(ignorable.extraction.temporalBasis).toBe("journal-date");
    expect(context.application.ignoreCandidate(ignorable.event.id, 1).status).toBe("archived");
    expect(context.application.getCandidate(ignorable.event.id).extraction.reviewState).toBe("ignored");
    expect(() => context.application.confirmEvent(ignorable.event.id, 2)).toThrowError(
      expect.objectContaining({ code: "CANDIDATE_STATE_CONFLICT" })
    );

    const target = context.application.createEvent({
      title: "Existing event", status: "confirmed", occurredAt: { kind: "date", value: "2026-01-01" },
      facts: [], interpretations: [], emotions: [], interests: [], participants: [], sourceRefs: [], assetRefs: [], reason: "test"
    });
    const merged = context.application.mergeCandidate({
      candidateEventId: candidate.event.id, candidateExpectedRevision: 1,
      targetEventId: target.id, targetExpectedRevision: 1
    });
    expect(merged.candidate.status).toBe("archived");
    expect(merged.target.sourceRefs).toContain(candidate.journalEntry.sourceItemId);
    expect(context.application.listCandidates()).toEqual([]);
    context.database.close();
  });

  it("does not create a candidate for an entry containing only media placeholders", async () => {
    const context = testContext();
    const now = "2026-08-24T00:00:00.000Z";
    context.session.assets.upsert({
      id: "archive-placeholders", sha256: "3".repeat(64), byteSize: 10, mimeType: "application/zip",
      originalFileName: "DayOne.zip", vaultFormat: 1, integrityStatus: "verified", availabilityStatus: "available", createdAt: now
    });
    const run: ImportRun = {
      id: "import-placeholders", archiveAssetId: "archive-placeholders", archiveFileName: "DayOne.zip", state: "succeeded", progress: 1,
      counts: { totalEntries: 1, newEntries: 1, updatedEntries: 0, skippedEntries: 0, mediaImported: 0, mediaMissing: 0, errorCount: 0 },
      createdAt: now, updatedAt: now, finishedAt: now
    };
    context.session.dayOne.createImportRun(run);
    context.session.dayOne.upsertEntry(run.id, importedEntry(
      "![](dayone-moment://PHOTO-1)\n{% photo PHOTO-1 %}\n[{attachment}]", undefined, "PLACEHOLDERS"
    ), now);
    const backfill = context.application.startBackfill({ importRunId: run.id, tags: [], batchSize: 25 });
    await context.application.runBackfill(backfill.id, { signal: new AbortController().signal, reportProgress() {} });
    expect(context.session.dayOne.getBackfillRun(backfill.id)).toMatchObject({ state: "completed", candidateCount: 0 });
    expect(context.application.listCandidates()).toEqual([]);
    context.database.close();
  });

  it("supersedes an unreviewed candidate when a newer source version arrives", async () => {
    const context = testContext();
    const now = "2026-08-24T00:00:00.000Z";
    context.session.assets.upsert({
      id: "archive-supersede", sha256: "1".repeat(64), byteSize: 10, mimeType: "application/zip",
      originalFileName: "DayOne.zip", vaultFormat: 1, integrityStatus: "verified", availabilityStatus: "available", createdAt: now
    });
    const run: ImportRun = {
      id: "import-supersede", archiveAssetId: "archive-supersede", archiveFileName: "DayOne.zip", state: "succeeded", progress: 1,
      counts: { totalEntries: 1, newEntries: 1, updatedEntries: 0, skippedEntries: 0, mediaImported: 0, mediaMissing: 0, errorCount: 0 },
      createdAt: now, updatedAt: now, finishedAt: now
    };
    context.session.dayOne.createImportRun(run);
    context.session.dayOne.upsertEntry(run.id, importedEntry("Original candidate"), now);
    const backfill = context.application.startBackfill({ importRunId: run.id, tags: [], batchSize: 25 });
    await context.application.runBackfill(backfill.id, { signal: new AbortController().signal, reportProgress() {} });
    const candidate = context.application.listCandidates()[0]!;

    context.session.dayOne.upsertEntry(
      run.id, importedEntry("Revised candidate", "2026-01-03T00:00:00.000Z"), "2026-08-24T01:00:00.000Z"
    );
    expect(context.application.listCandidates()).toEqual([]);
    expect(context.application.getEvent(candidate.event.id).event.status).toBe("archived");
    expect(context.application.getCandidate(candidate.event.id).extraction.reviewState).toBe("superseded");
    expect(context.application.listEventRevisions(candidate.event.id)).toHaveLength(2);
    context.database.close();
  });

  it("processes bounded batches and pauses after the current item before resuming from its cursor", async () => {
    const context = testContext();
    const now = "2026-08-24T00:00:00.000Z";
    context.session.assets.upsert({
      id: "archive-batches", sha256: "2".repeat(64), byteSize: 10, mimeType: "application/zip",
      originalFileName: "DayOne.zip", vaultFormat: 1, integrityStatus: "verified", availabilityStatus: "available", createdAt: now
    });
    const run: ImportRun = {
      id: "import-batches", archiveAssetId: "archive-batches", archiveFileName: "DayOne.zip", state: "succeeded", progress: 1,
      counts: { totalEntries: 26, newEntries: 26, updatedEntries: 0, skippedEntries: 0, mediaImported: 0, mediaMissing: 0, errorCount: 0 },
      createdAt: now, updatedAt: now, finishedAt: now
    };
    context.session.dayOne.createImportRun(run);
    for (let index = 0; index < 26; index += 1) {
      context.session.dayOne.upsertEntry(run.id, importedEntry(`Entry ${index}`, undefined, `ENTRY-${index}`), now);
    }
    const backfill = context.application.startBackfill({ importRunId: run.id, tags: [], batchSize: 25 });
    await context.application.runBackfill(backfill.id, { signal: new AbortController().signal, reportProgress() {} });
    expect(context.session.dayOne.getBackfillRun(backfill.id)).toMatchObject({ state: "queued", processedItems: 25 });
    await context.application.runBackfill(backfill.id, { signal: new AbortController().signal, reportProgress() {} });
    expect(context.session.dayOne.getBackfillRun(backfill.id)).toMatchObject({ state: "completed", processedItems: 26 });
    expect(context.application.listCandidates()).toHaveLength(26);

    const paused = context.application.startBackfill({ importRunId: run.id, tags: [], batchSize: 25 });
    let requestedPause = false;
    await context.application.runBackfill(paused.id, {
      signal: new AbortController().signal,
      reportProgress() {
        if (!requestedPause) {
          requestedPause = true;
          context.application.pauseBackfill(paused.id);
        }
      }
    });
    expect(context.session.dayOne.getBackfillRun(paused.id)).toMatchObject({ state: "paused", processedItems: 1 });
    context.application.resumeBackfill(paused.id);
    await context.application.runBackfill(paused.id, { signal: new AbortController().signal, reportProgress() {} });
    expect(context.session.dayOne.getBackfillRun(paused.id)).toMatchObject({ state: "completed", processedItems: 26 });
    expect(context.application.listCandidates()).toHaveLength(26);
    context.database.close();
  });
});

describe("Phase 3 relations, retrieval, and review application", () => {
  it("merges duplicate identities without rewriting events and can revert the merge", () => {
    const context = testContext();
    const first = context.application.createPerson("Alexander Zhang");
    const second = context.application.createPerson("Alex");
    const alias = context.application.addPersonAlias({ personId: first.id, value: "Alex" });
    const event = context.application.createEvent({
      title: "Attribution conversation", status: "confirmed", occurredAt: { kind: "date", value: "2026-01-04" },
      narrative: "Alex discussed attribution.", facts: [], interpretations: [], emotions: [], interests: [],
      participants: [{ personId: first.id }], sourceRefs: [], assetRefs: [], reason: "test"
    });
    const suggestion = context.application.listPersonMergeSuggestions().find(({ status }) => status === "pending")!;
    expect(suggestion.basis.join(" ")).toContain("Alex");
    const merge = context.application.mergePeople({
      sourcePersonId: first.id, targetPersonId: second.id, suggestionId: suggestion.id
    });
    const identity = context.application.getPersonIdentity(second.id);
    expect(identity.identities.map(({ id }) => id).sort()).toEqual([first.id, second.id].sort());
    expect(identity.events.map(({ id }) => id)).toContain(event.id);
    expect(context.application.getEvent(event.id).event.participants).toEqual([{ personId: first.id }]);
    expect(() => context.application.mergePeople({ sourcePersonId: second.id, targetPersonId: first.id }))
      .toThrow(/already resolve/);
    context.application.revertPersonMerge(merge.id);
    expect(context.application.getPersonIdentity(first.id).identities).toHaveLength(1);
    expect(context.application.getPersonIdentity(first.id).aliases.find(({ id }) => id === alias.id)?.status).toBe("active");
    context.database.close();
  });

  it("preserves rejected relation decisions and grounds reviews in event revisions and sources", () => {
    const context = testContext();
    const person = context.application.createPerson("Alex");
    const create = (title: string, date: string) => context.application.createEvent({
      title, status: "confirmed", occurredAt: { kind: "date", value: date }, narrative: `${title} about report attribution`,
      facts: [], interpretations: [], emotions: [],
      interests: [{ id: `interest-${date}`, label: "Attribution", sourceRefs: [] }],
      participants: [{ personId: person.id }], sourceRefs: [], assetRefs: [], reason: "test"
    });
    const first = create("First report issue", "2026-01-04");
    const second = create("Second report issue", "2026-01-20");
    const suggestions = context.application.refreshRelationSuggestions();
    const similar = suggestions.find(({ kind }) => kind === "similar")!;
    context.application.rejectEventRelation(similar.id);
    context.application.updateEvent({
      eventId: first.id, expectedRevision: first.currentRevision, title: `${first.title} updated`, status: first.status,
      occurredAt: first.occurredAt, ...(first.narrative ? { narrative: first.narrative } : {}), facts: first.facts,
      interpretations: first.interpretations, emotions: first.emotions, interests: first.interests,
      participants: first.participants, sourceRefs: first.sourceRefs, assetRefs: first.assetRefs, reason: "reorder events"
    });
    context.application.refreshRelationSuggestions();
    expect(context.session.memory.getEventRelation(similar.id)?.status).toBe("rejected");
    expect(context.session.memory.listEventRelations(undefined, true).filter(({ kind }) => kind === "similar")).toHaveLength(1);

    const review = context.application.generateReview({ from: "2026-01-01", to: "2026-01-31" });
    expect(review.patterns.some(({ kind }) => kind === "person")).toBe(true);
    expect(review.patterns.every(({ eventRevisionRefs, sourceRefs }) => eventRevisionRefs.length >= 2 && sourceRefs.length >= 2)).toBe(true);
    expect(review.eventIds.sort()).toEqual([first.id, second.id].sort());
    expect(review.patterns.some(({ kind, title }) => kind === "relation" && title.includes("similar"))).toBe(false);
    const timeline = context.application.queryTimeline({ personId: person.id, from: "2026-01-01", to: "2026-01-31" });
    expect(timeline.total).toBe(2);
    expect(timeline.groups[0]?.key).toBe("2026-01");
    context.database.close();
  });

  it("sorts and updates the global clarification inbox by explicit priority", async () => {
    const context = testContext();
    const conversation = context.application.createConversation("Clarifications");
    const first = await context.application.sendMessage({ conversationId: conversation.id, content: "First unknown event", intent: "record" });
    const second = await context.application.sendMessage({ conversationId: conversation.id, content: "Second unknown event", intent: "record" });
    const firstClarification = context.application.listClarifications(first.event!.id)[0]!;
    const secondClarification = context.application.listClarifications(second.event!.id)[0]!;
    context.application.setClarificationPriority(firstClarification.id, "important");
    context.application.setClarificationPriority(secondClarification.id, "rights_related");
    expect(context.application.listClarifications().slice(0, 2).map(({ id }) => id))
      .toEqual([secondClarification.id, firstClarification.id]);
    context.database.close();
  });

  it("unifies Event and current Day One source search with traceable source details", async () => {
    const context = testContext();
    const event = context.application.createEvent({
      title: "Unique event memory", status: "confirmed", occurredAt: { kind: "date", value: "2026-01-01" },
      narrative: "A uniquely searchable event.", facts: [], interpretations: [], emotions: [], interests: [],
      participants: [], sourceRefs: [], assetRefs: [], reason: "test"
    });
    const now = "2026-08-24T00:00:00.000Z";
    context.session.assets.upsert({
      id: "phase3-archive", sha256: "3".repeat(64), byteSize: 10, mimeType: "application/zip",
      originalFileName: "DayOne.zip", vaultFormat: 1, integrityStatus: "verified", availabilityStatus: "available", createdAt: now
    });
    const run: ImportRun = {
      id: "phase3-import", archiveAssetId: "phase3-archive", archiveFileName: "DayOne.zip", state: "succeeded", progress: 1,
      counts: { totalEntries: 1, newEntries: 1, updatedEntries: 0, skippedEntries: 0, mediaImported: 0, mediaMissing: 0, errorCount: 0 },
      createdAt: now, updatedAt: now, finishedAt: now
    };
    context.session.dayOne.createImportRun(run);
    const imported = context.session.dayOne.upsertEntry(run.id, {
      externalId: "uuid:phase3", entryUuid: "PHASE3", fingerprint: "4".repeat(64),
      creationDate: "2026-01-02T00:00:00.000Z", journalDate: "2026-01-02", tags: [], media: [],
      text: "Historical unique journal memory", contentHash: "5".repeat(64), raw: { text: "Historical unique journal memory" }
    }, now);
    const hits = await context.application.unifiedSearch({ text: "unique", semantic: false });
    expect(hits.map(({ kind }) => kind)).toEqual(expect.arrayContaining(["event", "journal_entry"]));
    expect(hits.find(({ eventId }) => eventId === event.id)).toBeDefined();
    const source = context.application.getSourceReference(imported.sourceVersion.sourceItemId);
    expect(source).toMatchObject({ kind: "journal_entry", sourceVersion: 1, contentHash: "5".repeat(64) });
    expect(source.excerpt).toContain("Historical unique");
    context.database.close();
  });

  it("builds embedding generations atomically and keeps the active generation after a failed rebuild", async () => {
    let fail = false;
    const adapter: EmbeddingAdapterPort = {
      identity: "test.embedding", version: 1, dimensions: 3,
      async embed(texts) {
        if (fail) throw new Error("adapter failed");
        return texts.map((text) => new Float32Array([
          text.toLocaleLowerCase().includes("unique") ? 1 : 0,
          text.toLocaleLowerCase().includes("other") ? 1 : 0,
          0.25
        ]));
      }
    };
    const context = testContext(undefined, adapter);
    const event = context.application.createEvent({
      title: "Unique semantic memory", status: "confirmed", occurredAt: { kind: "date", value: "2026-01-01" },
      narrative: "A semantic document", facts: [], interpretations: [], emotions: [], interests: [],
      participants: [], sourceRefs: [], assetRefs: [], reason: "test"
    });
    context.application.setSemanticEnabled(true);
    const firstJob = context.application.rebuildEmbeddings();
    const firstGenerationId = (firstJob.payload as { generationId: string }).generationId;
    await context.application.runEmbeddingRebuild(firstGenerationId, {
      signal: new AbortController().signal, reportProgress() {}
    });
    expect(context.application.getEmbeddingStatus()).toMatchObject({ state: "ready", activeGenerationId: firstGenerationId });
    const hits = await context.application.unifiedSearch({ text: "unique", semantic: true });
    expect(hits[0]?.eventId).toBe(event.id);

    fail = true;
    const secondJob = context.application.rebuildEmbeddings();
    await expect(context.application.runEmbeddingRebuild(
      (secondJob.payload as { generationId: string }).generationId,
      { signal: new AbortController().signal, reportProgress() {} }
    )).rejects.toThrow("adapter failed");
    expect(context.application.getEmbeddingStatus()).toMatchObject({ state: "ready", activeGenerationId: firstGenerationId });
    context.database.close();
  });
});
