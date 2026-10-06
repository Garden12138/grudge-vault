import { createHash, randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Worker } from "node:worker_threads";
import { AppError } from "@grudge-vault/shared";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScreenedZipImportCounters, TemporalValue } from "@grudge-vault/domain";
import {
  runMigrations, SqliteAssetRepository, SqliteJobRepository, SqliteRecordRepository
} from "@grudge-vault/persistence-sqlite";
import {
  RedesignService,
  type DayOneScreeningImporterPort,
  type LegacyMigrationEntry,
  type NormalizedDayOneEntry,
  type ObjectVaultPort,
  type NativeImageConversionPort,
  type RecordEmbeddingPort,
  type RecordMediaQueryDescriptionPort,
  type ReportAnalysisPort,
  type RedesignSession,
  type ScreeningPort
} from "./index";

describe("redesigned intake boundary", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

  async function context(embedding?: RecordEmbeddingPort, mediaDescription?: RecordMediaQueryDescriptionPort, nativeImage?: NativeImageConversionPort) {
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    runMigrations(database);
    const directory = await mkdtemp(join(tmpdir(), "grudge-vault-redesign-"));
    const path = join(directory, "evidence.png");
    await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x73, 0x79, 0x6e, 0x74, 0x68]));
    const stored = new Map<string, Buffer>();
    const vault: ObjectVaultPort = {
      async put(inputPath) {
        const bytes = await readFile(inputPath); const sha256 = createHash("sha256").update(bytes).digest("hex");
        const deduplicated = stored.has(sha256); stored.set(sha256, bytes);
        return { sha256, byteSize: bytes.length, vaultFormat: 2, deduplicated };
      },
      async putStream(input) {
        const chunks: Buffer[] = [];
        for await (const chunk of input) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const bytes = Buffer.concat(chunks); const sha256 = createHash("sha256").update(bytes).digest("hex");
        const deduplicated = stored.has(sha256); stored.set(sha256, bytes);
        return { sha256, byteSize: bytes.length, vaultFormat: 2, deduplicated };
      }, async open(sha256) { return Readable.from(stored.get(sha256) ? [stored.get(sha256)!] : []); },
      async verify() { return true; }, async exists(sha256) { return stored.has(sha256); },
      async remove(sha256) { stored.delete(sha256); }, async cleanupTempFiles() {}
    };
    const records = new SqliteRecordRepository(database, () => Buffer.alloc(32));
    const assets = new SqliteAssetRepository(database);
    const service = new RedesignService(() => ({
      key: Buffer.alloc(32), assets, jobs: new SqliteJobRepository(database), records, vault
    }), embedding, mediaDescription, undefined, nativeImage);
    cleanups.push(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
    return { database, directory, path, assets, records, service, stored, vault };
  }

  const screening = (value: Awaited<ReturnType<ScreeningPort["screen"]>>): ScreeningPort => ({ async screen() { return value; } });

  async function searchWorkspacePair(embedding?: RecordEmbeddingPort, description?: RecordMediaQueryDescriptionPort) {
    const first = await context(embedding, description), second = await context(embedding, description);
    const sessionFor = (value: typeof first): RedesignSession => ({ key: Buffer.alloc(32), records: value.records,
      jobs: new SqliteJobRepository(value.database), assets: value.assets, vault: value.vault });
    for (const [workspace, count] of [[first, 2], [second, 1]] as const) {
      for (let index = 0; index < count; index++) {
        const draft = await workspace.service.prepareDraft({ text: `合成工作区隔离检索 ${index}` });
        expect((await workspace.service.screenAndSave(draft.sessionId, randomUUID(), screening({
          decision: "include", categories: ["rights"], reason: "合成搜索工作区隔离", anchors: [],
          coverage: "complete", policyVersion: "test-v1"
        }))).kind).toBe("saved");
      }
      if (embedding) { workspace.service.setSearchIndexEnabled(true); await workspace.service.rebuildSearchIndex(); }
    }
    let active: RedesignSession | undefined = sessionFor(first);
    const service = new RedesignService(() => {
      if (!active) throw new AppError("WORKSPACE_LOCKED", "Synthetic workspace is locked.", true);
      return active;
    }, embedding, description);
    const before = [first, second].map(({ database }) => database.serialize());
    const assertUnchanged = () => {
      [first, second].forEach(({ database, stored }, index) => {
        expect(database.serialize().equals(before[index]!)).toBe(true); expect(stored.size).toBe(0);
      });
    };
    return { first, second, service, assertUnchanged,
      activate(value?: typeof first) { active = value ? sessionFor(value) : undefined; } };
  }
  const timeAnalysis = (value: string): ReportAnalysisPort => ({ async analyze() { return {
    content: { summary: "合成检索报告", time: { source: "source", value: { value, precision: "exact" } },
      location: { source: "ai" }, people: [], chronology: [], unknowns: [], disputes: [], suggestions: [],
      legalIssues: [], citations: [], coverageNotes: [] },
    state: "complete", promptVersion: "synthetic-time-v1", modelProfile: "synthetic:model"
  }; } });

  async function dateRecord(service: RedesignService, occurredAt: TemporalValue,
    options: { origin?: "manual" | "zip"; sourceRecordedAt?: string; categories?: Array<"rights" | "danger"> } = {}) {
    const draft = await service.prepareDraft({ text: "合成日期边界奖金记录", ...options });
    const saved = await service.screenAndSave(draft.sessionId, randomUUID(), screening({ decision: "include",
      categories: options.categories ?? ["rights"], reason: "合成权益事件", anchors: [], coverage: "complete", policyVersion: "test-v1" }));
    if (saved.kind !== "saved") throw new Error("expected synthetic saved record");
    return (await service.patchFields(saved.recordId, 1, { occurredAt })).record;
  }

  it("reports ZIP outcome counters without source data and isolates mutating or throwing observers", async () => {
    const { service } = await context();
    const observed: ScreenedZipImportCounters[] = [];
    const importer: DayOneScreeningImporterPort = { async scanArchive(_path, _root, consumer) {
      for (const [index, text] of ["合成权益事件", "合成普通日常", "合成需要确认"].entries()) {
        await consumer.onEntry({ externalId: `uuid:progress-${index}`, fingerprint: "f".repeat(64),
          creationDate: "2026-01-02T00:00:00Z", journalDate: "2026-01-02", text, tags: [], media: [],
          contentHash: String(index).repeat(64), raw: { privateTitle: "synthetic-private-title" } }, [], false);
      }
      await consumer.onIssue({ severity: "error", code: "DAYONE_ENTRY_INVALID", message: "synthetic-private-diagnostic" });
      return { totalEntries: 4, mediaEntries: 0, missingMedia: 0 };
    } };
    const result = await service.importDayOneZip(join(tmpdir(), "synthetic-progress.zip"), importer, {
      async screen(input) {
        const decision = input.text.includes("普通日常") ? "skip" : input.text.includes("需要确认") ? "review" : "include";
        return { decision, categories: decision === "skip" ? [] : ["rights"], reason: "合成判断", anchors: [],
          coverage: "complete", policyVersion: "test-v1" };
      }
    }, undefined, (counts) => { observed.push({ ...counts }); counts.included = 999; throw new Error("synthetic observer failure"); });
    expect(observed).toEqual([
      { included: 0, skipped: 0, review: 0, failed: 0, issueCount: 0 },
      { included: 1, skipped: 0, review: 0, failed: 0, issueCount: 0 },
      { included: 1, skipped: 1, review: 0, failed: 0, issueCount: 0 },
      { included: 1, skipped: 1, review: 1, failed: 0, issueCount: 0 },
      { included: 1, skipped: 1, review: 1, failed: 1, issueCount: 1 }
    ]);
    expect(result).toMatchObject({ included: 1, skipped: 1, review: 1, failed: 1, issueCount: 1 });
    expect(JSON.stringify(observed)).not.toMatch(/synthetic|uuid|text|path|private/);
    expect(service.listTimeline({ limit: 10 }).records).toHaveLength(1); expect(service.listPending()).toHaveLength(1);
  });

  it("retains aggregate progress for committed entries but does not count or save a cancelled late result", async () => {
    const { service, database } = await context(); const controller = new AbortController();
    const observed: ScreenedZipImportCounters[] = []; let calls = 0;
    const importer: DayOneScreeningImporterPort = { async scanArchive(_path, _root, consumer) {
      for (let index = 0; index < 2; index++) await consumer.onEntry({ externalId: `uuid:cancel-progress-${index}`,
        fingerprint: "f".repeat(64), creationDate: "2026-01-02T00:00:00Z", journalDate: "2026-01-02",
        text: `合成待取消权益事件 ${index}`, tags: [], media: [], contentHash: String(index).repeat(64), raw: {} }, [], false);
      return { totalEntries: 2, mediaEntries: 0, missingMedia: 0 };
    } };
    await expect(service.importDayOneZip(join(tmpdir(), "synthetic-cancel-progress.zip"), importer, {
      async screen() {
        if (++calls === 2) controller.abort();
        return { decision: "include", categories: ["rights"], reason: "合成判断", anchors: [], coverage: "complete", policyVersion: "test-v1" };
      }
    }, controller.signal, (counts) => observed.push(counts))).rejects.toMatchObject({ code: "IMPORT_CANCELLED" });
    expect(observed.at(-1)).toEqual({ included: 1, skipped: 0, review: 0, failed: 0, issueCount: 0 });
    expect(database.prepare("SELECT count(*) FROM redesign_records").pluck().get()).toBe(1);
    expect(service.listPending()).toHaveLength(0);
  });

  it("waits before an issue as well as an entry, then continues the same ZIP without repeating skipped work", async () => {
    const { service } = await context(); let transientRoot = ""; let boundaries = 0;
    let reached!: () => void; const paused = new Promise<void>((resolve) => { reached = resolve; });
    let release!: () => void; const continued = new Promise<void>((resolve) => { release = resolve; });
    const observed: ScreenedZipImportCounters[] = []; const screened: string[] = [];
    const importer: DayOneScreeningImporterPort = { async scanArchive(_path, root, consumer) {
      transientRoot = root;
      const entry = (index: number): NormalizedDayOneEntry => ({ externalId: `uuid:pause-${index}`,
        fingerprint: "f".repeat(64), creationDate: "2026-01-02T00:00:00Z", journalDate: "2026-01-02",
        text: index === 0 ? "合成普通日常" : "合成权益事件", tags: [], media: [], contentHash: String(index).repeat(64), raw: {} });
      await consumer.onEntry(entry(0), [], false);
      await consumer.onIssue({ severity: "error", code: "DAYONE_ENTRY_INVALID", message: "synthetic invalid" });
      await consumer.onEntry(entry(1), [], false);
      return { totalEntries: 3, mediaEntries: 0, missingMedia: 0 };
    } };
    const pending = service.importDayOneZip(join(tmpdir(), "synthetic-pause.zip"), importer, {
      async screen(input) {
        screened.push(input.text); const decision = input.text.includes("普通") ? "skip" : "include";
        return { decision, categories: decision === "skip" ? [] : ["rights"], reason: "合成判断",
          anchors: [], coverage: "complete", policyVersion: "test-v1" };
      }
    }, undefined, (value) => observed.push(value), async (signal) => {
      signal.throwIfAborted();
      if (++boundaries === 2) { reached(); await continued; }
    });
    await paused;
    expect(screened).toEqual(["合成普通日常"]);
    expect(observed.at(-1)).toEqual({ included: 0, skipped: 1, review: 0, failed: 0, issueCount: 0 });
    expect(service.listTimeline({}).records).toHaveLength(0); expect(service.listPending()).toHaveLength(0);
    release(); expect(await pending).toMatchObject({ included: 1, skipped: 1, failed: 1, issueCount: 1 });
    expect(boundaries).toBe(3); expect(screened).toEqual(["合成普通日常", "合成权益事件"]);
    await expect(access(transientRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["stop", "workspace lock"] as const)("releases a paused ZIP on %s, preserves prior records and cleans temporary files", async (action) => {
    const { service } = await context(); const controller = new AbortController(); let transientRoot = "";
    let boundaries = 0; let calls = 0; let reached!: () => void;
    const paused = new Promise<void>((resolve) => { reached = resolve; });
    const observed: ScreenedZipImportCounters[] = [];
    const importer: DayOneScreeningImporterPort = { async scanArchive(_path, root, consumer) {
      transientRoot = root;
      for (let index = 0; index < 2; index++) await consumer.onEntry({ externalId: `uuid:stop-pause-${index}`,
        fingerprint: "f".repeat(64), creationDate: "2026-01-02T00:00:00Z", journalDate: "2026-01-02",
        text: `合成暂停后待停止权益事件 ${index}`, tags: [], media: [], contentHash: String(index).repeat(64), raw: {} }, [], false);
      return { totalEntries: 2, mediaEntries: 0, missingMedia: 0 };
    } };
    const pending = service.importDayOneZip(join(tmpdir(), "synthetic-stop-pause.zip"), importer, {
      async screen() { calls++;
        return { decision: "include", categories: ["rights"], reason: "合成判断", anchors: [], coverage: "complete", policyVersion: "test-v1" };
      }
    }, controller.signal, (value) => observed.push(value), async (signal) => {
      if (++boundaries !== 2) return;
      await new Promise<void>((_resolve, reject) => {
        const aborted = () => { signal.removeEventListener("abort", aborted); reject(signal.reason); };
        signal.addEventListener("abort", aborted, { once: true }); if (signal.aborted) aborted(); reached();
      });
    });
    await paused; expect(calls).toBe(1); expect(service.listTimeline({}).records).toHaveLength(1);
    const failure = expect(pending).rejects.toMatchObject({ code: "IMPORT_CANCELLED" });
    if (action === "stop") controller.abort(); else service.clearTransientSessions();
    await failure; expect(calls).toBe(1); expect(service.listTimeline({}).records).toHaveLength(1);
    expect(service.listPending()).toHaveLength(0);
    expect(observed.at(-1)).toEqual({ included: 1, skipped: 0, review: 0, failed: 0, issueCount: 0 });
    await expect(access(transientRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists nothing for an unrelated manual input", async () => {
    const { database, service } = await context();
    const draft = await service.prepareDraft({ text: "午饭后散步，下午工作顺利" });
    const result = await service.screenAndSave(draft.sessionId, randomUUID(), screening({
      decision: "skip", categories: [], reason: "普通日常", anchors: [], coverage: "complete", policyVersion: "test-v1"
    }));
    expect(result).toEqual({ kind: "skipped", message: "不属于收录范围" });
    for (const table of ["redesign_records", "redesign_sources", "redesign_pending_reviews", "redesign_operations", "assets", "jobs"]) {
      expect(database.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
  });

  it("passes 50,000 Unicode code points to screening unchanged and leaves a skipped input unpersisted", async () => {
    const { database, service } = await context();
    const text = "𠮷🧾".repeat(25_000);
    const draft = await service.prepareDraft({ text });
    expect(draft.textLength).toBe(50_000);
    let screenedIntact = false;
    const result = await service.screenAndSave(draft.sessionId, randomUUID(), {
      async screen(input) {
        screenedIntact = input.text === text;
        return { decision: "skip", categories: [], reason: "合成普通输入", anchors: [], coverage: "complete", policyVersion: "test-v1" };
      }
    });
    expect(screenedIntact).toBe(true);
    expect(result).toMatchObject({ kind: "skipped" });
    for (const table of ["redesign_records", "redesign_sources", "redesign_pending_reviews", "redesign_operations", "assets", "jobs"]) {
      expect(database.prepare(`SELECT count(*) FROM ${table}`).pluck().get()).toBe(0);
    }
  });

  it("rejects a 50,001-character manual input before preparing or persisting it", async () => {
    const { service } = await context();
    for (const text of ["字".repeat(50_001), "𠮷🧾".repeat(25_000) + "字", "🧾".repeat(50_001)]) {
      await expect(service.prepareDraft({ text })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
    expect(service.listTimeline({}).records).toHaveLength(0);
    expect(service.listPending()).toHaveLength(0);
  });

  it("prepares a 500-code-point search unchanged but rejects the next character", async () => {
    const { service } = await context();
    const text = "𠮷🧾".repeat(250);
    const query = await service.prepareSearchQuery({ text });
    expect(query.textLength).toBe(500);
    service.abandonSearchQuery(query.sessionId);
    for (const extra of ["字", "🧾"]) {
      await expect(service.prepareSearchQuery({ text: text + extra })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
    expect(service.listTimeline({}).records).toHaveLength(0);
    expect(service.listPending()).toHaveLength(0);
  });

  it.each(["editor close", "workspace lock"] as const)("cancels manual input preparation on %s before any session is created", async (action) => {
    const { database, path, service } = await context();
    const requestId = randomUUID();
    const pending = service.prepareDraft({ text: "合成输入", paths: [path], requestId });
    const duplicate = service.prepareDraft({ text: "合成输入", paths: [path], requestId });
    if (action === "editor close") service.abandonDraftPreparation(requestId);
    else service.clearTransientSessions();
    await expect(duplicate).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(pending).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    for (const table of ["redesign_records", "redesign_sources", "redesign_pending_reviews", "assets", "jobs"]) {
      expect(database.prepare(`SELECT count(*) FROM ${table}`).pluck().get()).toBe(0);
    }
    const next = await service.prepareDraft({ text: "重新提供的合成输入", paths: [path], requestId });
    expect(next.attachments).toHaveLength(1);
    service.abandonDraft(next.sessionId);
  });

  it("screens a pasted image from memory without a plaintext temporary file", async () => {
    const { database, service, stored } = await context();
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lV8AAAAASUVORK5CYII=",
      "base64"
    );
    const inlineMedia = [{ fileName: "pasted.png", mimeType: "image/png", bytes }];
    const ordinary = await service.prepareDraft({ text: "午饭后散步", inlineMedia });
    expect(ordinary.attachments[0]).toMatchObject({ fileName: "pasted.png", kind: "image" });
    const skipped = await service.screenAndSave(ordinary.sessionId, randomUUID(), {
      async screen(input) {
        expect(Buffer.from(input.media[0]!.bytes!)).toEqual(bytes);
        return {
          decision: "skip", categories: [], reason: "合成普通日常", anchors: [{
            sourceVersion: input.sourceVersion, temporaryMediaRef: input.media[0]!.id
          }], coverage: "complete", policyVersion: "test-v1"
        };
      }
    });
    expect(skipped).toEqual({ kind: "skipped", message: "不属于收录范围" });
    expect(stored.size).toBe(0);
    expect(database.prepare("SELECT count(*) FROM redesign_records").pluck().get()).toBe(0);

    const relevant = await service.prepareDraft({ text: "合成工资凭证", inlineMedia, sourceVersion: "pasted-relevant-v1" });
    const saved = await service.screenAndSave(relevant.sessionId, randomUUID(), screening({
      decision: "include", categories: ["rights"], reason: "图片是工资凭证", anchors: [{
        sourceVersion: "pasted-relevant-v1", temporaryMediaRef: relevant.attachments[0]!.id
      }], coverage: "complete", policyVersion: "test-v1"
    }));
    expect(saved.kind).toBe("saved");
    if (saved.kind !== "saved") throw new Error("expected saved record");
    expect(service.getRecord(saved.recordId).attachments[0]?.originalFileName).toBe("pasted.png");
    expect([...stored.values()]).toEqual([bytes]);
  });

  it("rejects forged or oversized pasted image bytes before creating a session", async () => {
    const { service } = await context();
    await expect(service.prepareDraft({ inlineMedia: [{
      fileName: "forged.png", mimeType: "image/png", bytes: Buffer.from("not a PNG")
    }] })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(service.prepareDraft({ inlineMedia: [{
      fileName: "large.png", mimeType: "image/png", bytes: Buffer.alloc(20 * 1024 * 1024 + 1)
    }] })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects a skip when media coverage is partial", async () => {
    const { database, path, service } = await context();
    const draft = await service.prepareDraft({ text: "今天正常下班", paths: [path] });
    const result = await service.screenAndSave(draft.sessionId, randomUUID(), screening({
      decision: "skip", categories: [], reason: "没有风险", anchors: [], coverage: "partial", policyVersion: "test-v1"
    }));
    expect(result).toEqual({ kind: "failed", code: "SCREENING_FAILED", retryable: true });
    expect(database.prepare("SELECT count(*) AS count FROM redesign_records").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT count(*) AS count FROM assets").get()).toEqual({ count: 0 });
  });

  it("does not commit the current ZIP entry when import stops during screening", async () => {
    const { database, service } = await context();
    const draft = await service.prepareDraft({ text: "合成薪酬争议", origin: "zip", sourceVersion: "cancel-screen-v1" });
    const controller = new AbortController();
    await expect(service.screenAndSave(draft.sessionId, randomUUID(), {
      async screen(_input, receivedSignal) {
        expect(receivedSignal).toBe(controller.signal);
        controller.abort();
        return {
          decision: "include", categories: ["rights"], reason: "与薪酬有关",
          anchors: [], coverage: "complete", policyVersion: "test-v1"
        };
      }
    }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    for (const table of ["redesign_records", "redesign_sources", "assets", "jobs"]) {
      expect(database.prepare(`SELECT count(*) FROM ${table}`).pluck().get()).toBe(0);
    }
  });

  it("invalidates an in-flight screening session before it can save after workspace lock", async () => {
    const { database, service, stored } = await context();
    const draft = await service.prepareDraft({ text: "合成的待筛选争议" });
    let releaseModel!: () => void;
    let modelStarted!: () => void;
    const gate = new Promise<void>((resolve) => { releaseModel = resolve; });
    const started = new Promise<void>((resolve) => { modelStarted = resolve; });
    const pending = service.screenAndSave(draft.sessionId, randomUUID(), {
      async screen() {
        modelStarted();
        await gate;
        return {
          decision: "include" as const, categories: ["rights" as const], reason: "模拟权益争议",
          anchors: [], coverage: "complete" as const, policyVersion: "test-v1"
        };
      }
    });
    await started;
    service.clearTransientSessions();
    releaseModel();
    expect(await pending).toEqual({ kind: "failed", code: "SOURCE_UNAVAILABLE", retryable: true });
    expect(database.prepare("SELECT count(*) FROM redesign_records").pluck().get()).toBe(0);
    expect(database.prepare("SELECT count(*) FROM assets").pluck().get()).toBe(0);
    expect(stored.size).toBe(0);
  });

  it("does not save or skip a media input changed while the model is screening it", async () => {
    const { database, path, service, stored } = await context();
    const draft = await service.prepareDraft({ text: "图片中的薪酬凭证", paths: [path], sourceVersion: "changing-media-v1" });
    const result = await service.screenAndSave(draft.sessionId, randomUUID(), {
      async screen(input) {
        expect(input.media[0]?.screenedSha256)
          .toBe(createHash("sha256").update(await readFile(path)).digest("hex"));
        const changed = Buffer.from(await readFile(path));
        changed[changed.length - 1] = (changed.at(-1) ?? 0) ^ 1;
        await writeFile(path, changed);
        return {
          decision: "include", categories: ["rights"], reason: "模拟权益证据",
          anchors: [{ sourceVersion: "changing-media-v1", temporaryMediaRef: draft.attachments[0]!.id }],
          coverage: "complete", policyVersion: "test-v1"
        };
      }
    });
    expect(result).toEqual({ kind: "failed", code: "SOURCE_UNAVAILABLE", retryable: true });
    for (const table of ["redesign_records", "redesign_pending_reviews", "redesign_operations", "assets"]) {
      expect(database.prepare(`SELECT count(*) FROM ${table}`).pluck().get()).toBe(0);
    }
    expect(stored.size).toBe(0);
  });

  it("does not screen a same-size file changed after it was selected", async () => {
    const { database, path, service, stored } = await context();
    const draft = await service.prepareDraft({ text: "合成图片争议", paths: [path] });
    const changed = Buffer.from(await readFile(path));
    changed[changed.length - 1] = (changed.at(-1) ?? 0) ^ 1;
    await writeFile(path, changed);
    let modelCalls = 0;
    const result = await service.screenAndSave(draft.sessionId, randomUUID(), {
      async screen() {
        modelCalls += 1;
        return { decision: "skip", categories: [], reason: "不应调用模型",
          anchors: [], coverage: "complete", policyVersion: "test-v1" };
      }
    });
    expect(result).toEqual({ kind: "failed", code: "SOURCE_UNAVAILABLE", retryable: true });
    expect(modelCalls).toBe(0);
    expect(database.prepare("SELECT count(*) FROM redesign_records").pluck().get()).toBe(0);
    expect(stored.size).toBe(0);
  });

  it("removes the uploaded object if an included attachment changes after screening", async () => {
    const { database, path, service, stored, vault } = await context();
    const draft = await service.prepareDraft({ text: "图片中的薪酬凭证", paths: [path], sourceVersion: "post-screen-change-v1" });
    const originalPut = vault.put.bind(vault);
    vi.spyOn(vault, "put").mockImplementation(async (...args) => {
      const changed = Buffer.from(await readFile(path));
      changed[changed.length - 1] = (changed.at(-1) ?? 0) ^ 1;
      await writeFile(path, changed);
      return originalPut(...args);
    });
    const result = await service.screenAndSave(draft.sessionId, randomUUID(), screening({
      decision: "include", categories: ["rights"], reason: "模拟权益证据",
      anchors: [{ sourceVersion: "post-screen-change-v1", temporaryMediaRef: draft.attachments[0]!.id }],
      coverage: "complete", policyVersion: "test-v1"
    }));
    expect(result).toEqual({ kind: "failed", code: "SOURCE_UNAVAILABLE", retryable: true });
    expect(database.prepare("SELECT count(*) FROM redesign_records").pluck().get()).toBe(0);
    expect(database.prepare("SELECT count(*) FROM assets").pluck().get()).toBe(0);
    expect(stored.size).toBe(0);
  });

  it("keeps a review pending and removes the newly stored object if its media changes before confirmation", async () => {
    const { database, path, service, stored } = await context();
    const draft = await service.prepareDraft({ text: "图片需人工确认", paths: [path], sourceVersion: "review-media-v1" });
    const review = await service.screenAndSave(draft.sessionId, randomUUID(), screening({
      decision: "review", categories: ["rights"], reason: "需要人工确认",
      anchors: [], coverage: "partial", policyVersion: "test-v1"
    }));
    if (review.kind !== "needs_review") throw new Error("expected pending review");
    const changed = Buffer.from(await readFile(path));
    changed[changed.length - 1] = (changed.at(-1) ?? 0) ^ 1;
    await writeFile(path, changed);
    await expect(service.resolvePending(review.pendingId, "keep", randomUUID()))
      .rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    expect(service.listPending()).toHaveLength(1);
    expect(database.prepare("SELECT count(*) FROM redesign_records").pluck().get()).toBe(0);
    expect(database.prepare("SELECT count(*) FROM assets").pluck().get()).toBe(0);
    expect(stored.size).toBe(0);
  });

  it("cleans a just-written encrypted attachment when its draft is invalidated before commit", async () => {
    const { database, path, service, stored, vault } = await context();
    const draft = await service.prepareDraft({ text: "合成图片争议", paths: [path], sourceVersion: "lock-before-commit-v1" });
    const originalPut = vault.put.bind(vault);
    vi.spyOn(vault, "put").mockImplementation(async (...args) => {
      const result = await originalPut(...args);
      service.clearTransientSessions();
      return result;
    });
    const result = await service.screenAndSave(draft.sessionId, randomUUID(), screening({
      decision: "include", categories: ["rights"], reason: "模拟权益争议", coverage: "complete", policyVersion: "test-v1",
      anchors: [{ sourceVersion: "lock-before-commit-v1", temporaryMediaRef: draft.attachments[0]!.id }]
    }));
    expect(result).toEqual({ kind: "failed", code: "SOURCE_UNAVAILABLE", retryable: true });
    expect(stored.size).toBe(0);
    expect(database.prepare("SELECT count(*) FROM redesign_records").pluck().get()).toBe(0);
    expect(database.prepare("SELECT count(*) FROM assets").pluck().get()).toBe(0);
  });

  it("removes a newly encrypted object when import stops before its database commit", async () => {
    const { database, path, service, stored, vault } = await context();
    const draft = await service.prepareDraft({
      text: "合成薪酬争议与图片", paths: [path], origin: "zip", sourceVersion: "cancel-commit-v1"
    });
    const controller = new AbortController();
    const originalPut = vault.put.bind(vault);
    vi.spyOn(vault, "put").mockImplementation(async (...args) => {
      const result = await originalPut(...args);
      controller.abort();
      return result;
    });
    await expect(service.screenAndSave(draft.sessionId, randomUUID(), screening({
      decision: "include", categories: ["rights"], reason: "与薪酬有关", coverage: "complete", policyVersion: "test-v1",
      anchors: [{ sourceVersion: "cancel-commit-v1", temporaryMediaRef: draft.attachments[0]!.id }]
    }), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(stored.size).toBe(0);
    for (const table of ["redesign_records", "redesign_sources", "assets", "jobs"]) {
      expect(database.prepare(`SELECT count(*) FROM ${table}`).pluck().get()).toBe(0);
    }
  });

  it("isolates review items and removes their minimal excerpt when ignored", async () => {
    const { database, service } = await context();
    const draft = await service.prepareDraft({ text: "他又这样说了，我有些不安" });
    const result = await service.screenAndSave(draft.sessionId, randomUUID(), screening({
      decision: "review", categories: ["danger"], reason: "无法确定是否与用户有关", anchors: [], coverage: "complete", policyVersion: "test-v1"
    }));
    expect(result.kind).toBe("needs_review");
    expect(database.prepare("SELECT count(*) AS count FROM redesign_records").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT count(*) AS count FROM redesign_record_fts").get()).toEqual({ count: 0 });
    if (result.kind !== "needs_review") throw new Error("unexpected");
    expect(service.listPending()[0]?.sessionAvailable).toBe(true);
    await service.resolvePending(result.pendingId, "ignore", randomUUID());
    expect(database.prepare("SELECT count(*) AS count FROM redesign_pending_reviews").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT count(*) AS count FROM redesign_operations").get()).toEqual({ count: 0 });
  });

  it("binds each pending review to its exact transient session, not a shared source version", async () => {
    const { service } = await context();
    const first = await service.prepareDraft({ text: "第一条待核对的工资争议", sourceVersion: "shared-version" });
    const second = await service.prepareDraft({ text: "第二条待核对的邻里纠纷", sourceVersion: "shared-version" });
    const unclear = screening({ decision: "review", categories: ["rights"], reason: "需要确认",
      anchors: [], coverage: "complete", policyVersion: "test-v1" });
    const firstReview = await service.screenAndSave(first.sessionId, randomUUID(), unclear);
    const secondReview = await service.screenAndSave(second.sessionId, randomUUID(), unclear);
    if (firstReview.kind !== "needs_review" || secondReview.kind !== "needs_review") throw new Error("expected reviews");
    expect(service.listPending().every(({ sessionAvailable }) => sessionAvailable)).toBe(true);
    const saved = await service.resolvePending(firstReview.pendingId, "keep", randomUUID());
    expect(saved?.kind).toBe("saved");
    expect(service.listPending()[0]?.sessionAvailable).toBe(true);
    const record = service.listTimeline({ limit: 10 }).records[0]!;
    expect(service.getRecord(record.id).source.text).toBe("第一条待核对的工资争议");
    service.abandonDraft(second.sessionId);
    expect(service.listPending()[0]?.sessionAvailable).toBe(false);
  });

  it("does not let an unrelated saved operation satisfy a pending confirmation", async () => {
    const { service } = await context();
    const reusedOperationId = randomUUID();
    const unrelated = await service.prepareDraft({ text: "第一条已保存的奖金事实" });
    const first = await service.screenAndSave(unrelated.sessionId, reusedOperationId, screening({
      decision: "include", categories: ["rights"], reason: "相关", anchors: [],
      coverage: "complete", policyVersion: "test-v1"
    }));
    expect(first.kind).toBe("saved");
    const draft = await service.prepareDraft({ text: "第二条需要本人核对的奖金事实" });
    const review = await service.screenAndSave(draft.sessionId, randomUUID(), screening({
      decision: "review", categories: ["rights"], reason: "需要本人确认", anchors: [],
      coverage: "complete", policyVersion: "test-v1"
    }));
    if (first.kind !== "saved" || review.kind !== "needs_review") throw new Error("expected saved and reviewed results");
    const kept = await service.resolvePending(review.pendingId, "keep", reusedOperationId);
    expect(kept?.kind).toBe("saved");
    expect(kept).not.toEqual(first);
    expect(service.listPending()).toHaveLength(0);
    expect(service.listTimeline({ limit: 10 }).records).toHaveLength(2);
    expect(await service.resolvePending(review.pendingId, "keep", reusedOperationId)).toEqual(kept);
  });

  it("scopes manual commit operations to their input sessions", async () => {
    const { database, service } = await context();
    const reusedOperationId = randomUUID();
    const include = screening({
      decision: "include", categories: ["rights"], reason: "合成权益事件",
      anchors: [], coverage: "complete", policyVersion: "test-v1"
    });
    const firstDraft = await service.prepareDraft({ text: "第一份独立的工资记录" });
    const first = await service.screenAndSave(firstDraft.sessionId, reusedOperationId, include);
    const secondDraft = await service.prepareDraft({ text: "第二份独立的工资记录" });
    const second = await service.screenAndSave(secondDraft.sessionId, reusedOperationId, include);
    if (first.kind !== "saved" || second.kind !== "saved") throw new Error("expected saved records");
    expect(second.recordId).not.toBe(first.recordId);
    expect(service.getRecord(first.recordId).source.text).toBe("第一份独立的工资记录");
    expect(service.getRecord(second.recordId).source.text).toBe("第二份独立的工资记录");
    expect(await service.screenAndSave(firstDraft.sessionId, reusedOperationId, include)).toEqual(first);
    expect(await service.screenAndSave(secondDraft.sessionId, reusedOperationId, include)).toEqual(second);

    const reviewDraft = await service.prepareDraft({ text: "第三份需要本人确认的独立输入" });
    const review = await service.screenAndSave(reviewDraft.sessionId, reusedOperationId, screening({
      decision: "review", categories: [], reason: "需要核对", anchors: [], coverage: "complete", policyVersion: "test-v1"
    }));
    expect(review.kind).toBe("needs_review");
    expect(service.listPending()).toHaveLength(1);
    expect(database.prepare("SELECT count(*) FROM redesign_operations").pluck().get()).toBe(3);
    expect(database.prepare("SELECT count(*) FROM redesign_records").pluck().get()).toBe(2);
  });

  it("rejects import-origin sessions through the public manual save boundary", async () => {
    const { database, service } = await context();
    const draft = await service.prepareDraft({
      text: "合成 ZIP 来源内容", origin: "zip", sourceVersion: "zip-v1",
      sourceLocator: { connectorId: "dayone-zip", journalId: "synthetic", entryId: "entry-1" }
    });
    const screen = vi.fn(async () => ({
      decision: "include" as const, categories: ["rights" as const], reason: "不应触发",
      anchors: [], coverage: "complete" as const, policyVersion: "test-v1"
    }));
    await expect(service.screenManualAndSave(draft.sessionId, randomUUID(), { screen }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(screen).not.toHaveBeenCalled();
    expect(database.prepare("SELECT count(*) FROM redesign_records").pluck().get()).toBe(0);
  });

  it("allows only one in-flight screening for an input session even with different operation ids", async () => {
    const { database, service } = await context();
    const draft = await service.prepareDraft({ text: "同一草稿中的项目奖金争议" });
    let releaseModel!: () => void;
    let modelStarted!: () => void;
    const gate = new Promise<void>((resolve) => { releaseModel = resolve; });
    const started = new Promise<void>((resolve) => { modelStarted = resolve; });
    const first = service.screenAndSave(draft.sessionId, randomUUID(), {
      async screen() {
        modelStarted();
        await gate;
        return {
          decision: "include" as const, categories: ["rights" as const], reason: "奖金权益事件",
          anchors: [], coverage: "complete" as const, policyVersion: "test-v1"
        };
      }
    });
    await started;
    await expect(service.screenAndSave(draft.sessionId, randomUUID(), screening({
      decision: "include", categories: ["rights"], reason: "另一次请求",
      anchors: [], coverage: "complete", policyVersion: "test-v1"
    }))).rejects.toMatchObject({ code: "REVISION_CONFLICT", retryable: true });
    releaseModel();
    expect((await first).kind).toBe("saved");
    expect(database.prepare("SELECT count(*) FROM redesign_records").pluck().get()).toBe(1);
    expect(database.prepare("SELECT count(*) FROM redesign_operations").pluck().get()).toBe(1);
  });

  it("permits only one in-flight confirmation for a pending item", async () => {
    const { service } = await context();
    const draft = await service.prepareDraft({ text: "这条工资争议需要本人确认" });
    const review = await service.screenAndSave(draft.sessionId, randomUUID(), screening({
      decision: "review", categories: ["rights"], reason: "需要确认", anchors: [],
      coverage: "complete", policyVersion: "test-v1"
    }));
    if (review.kind !== "needs_review") throw new Error("expected review");
    const first = service.resolvePending(review.pendingId, "keep", randomUUID());
    await expect(service.resolvePending(review.pendingId, "keep", randomUUID()))
      .rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect((await first)?.kind).toBe("saved");
    expect(service.listTimeline({ limit: 10 }).records).toHaveLength(1);
    expect(service.listPending()).toHaveLength(0);
  });

  it("serializes competing full-content replacements of one expired pending item", async () => {
    const { service } = await context();
    const original = await service.prepareDraft({ text: "他又这样说了，我有些不安" });
    const review = await service.screenAndSave(original.sessionId, randomUUID(), screening({
      decision: "review", categories: ["danger"], reason: "信息不足", anchors: [],
      coverage: "complete", policyVersion: "test-v1"
    }));
    if (review.kind !== "needs_review") throw new Error("expected review");
    service.abandonDraft(original.sessionId);
    const firstDraft = await service.prepareDraft({ text: "完整事实甲：有人威胁我" });
    const secondDraft = await service.prepareDraft({ text: "完整事实乙：有人威胁我" });
    let releaseScreen!: () => void;
    let screeningStarted!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseScreen = resolve; });
    const started = new Promise<void>((resolve) => { screeningStarted = resolve; });
    const first = service.rescreenPendingFromManual(review.pendingId, firstDraft.sessionId, {
      async screen() {
        screeningStarted();
        await blocked;
        return { decision: "include", categories: ["danger"], reason: "明确威胁", anchors: [],
          coverage: "complete", policyVersion: "test-v2" };
      }
    });
    await started;
    await expect(service.rescreenPendingFromManual(review.pendingId, secondDraft.sessionId, screening({
      decision: "include", categories: ["danger"], reason: "明确威胁", anchors: [],
      coverage: "complete", policyVersion: "test-v2"
    }))).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    releaseScreen();
    expect((await first).kind).toBe("saved");
    const records = service.listTimeline({ limit: 10 }).records;
    expect(records).toHaveLength(1);
    expect(service.getRecord(records[0]!.id).source.text).toBe("完整事实甲：有人威胁我");
    expect(service.listPending()).toHaveLength(0);
  });

  it("requires full manual input to rescreen an expired review and retains it on failure", async () => {
    const { database, path, service } = await context();
    const original = await service.prepareDraft({ text: "他又这样说了，我有些不安" });
    const review = await service.screenAndSave(original.sessionId, randomUUID(), screening({
      decision: "review", categories: ["danger"], reason: "无法判断具体风险", anchors: [],
      coverage: "complete", policyVersion: "test-v1"
    }));
    if (review.kind !== "needs_review") throw new Error("expected review");
    service.abandonDraft(original.sessionId);
    expect(service.listPending()[0]?.sessionAvailable).toBe(false);
    const fullInput = "公司迟迟未支付约定奖金，我保留了付款邮件";
    const replacement = await service.prepareDraft({ text: fullInput, paths: [path] });
    const failed = await service.rescreenPendingFromManual(review.pendingId, replacement.sessionId, {
      async screen() { throw new Error("synthetic model failure"); }
    });
    expect(failed.kind).toBe("failed");
    expect(service.listPending()).toHaveLength(1);
    expect(database.prepare("SELECT count(*) FROM redesign_records").pluck().get()).toBe(0);
    const saved = await service.rescreenPendingFromManual(review.pendingId, replacement.sessionId, screening({
      decision: "include", categories: ["rights"], reason: "重新提供的完整事实涉及劳动报酬",
      anchors: [], coverage: "complete", policyVersion: "test-v2"
    }));
    expect(saved.kind).toBe("saved");
    expect(service.listPending()).toHaveLength(0);
    const record = service.listTimeline({ limit: 10 }).records[0]!;
    expect(service.getRecord(record.id).source.text).toBe(fullInput);
    expect(record.attachmentCount).toBe(1);
    expect(await service.rescreenPendingFromManual(review.pendingId, replacement.sessionId, screening({
      decision: "include", categories: ["danger"], reason: "不应重新筛选",
      anchors: [], coverage: "complete", policyVersion: "test-v3"
    }))).toEqual(saved);
    expect(database.prepare("SELECT count(*) FROM redesign_records").pluck().get()).toBe(1);
  });

  it("replaces an expired manual review with only the new review when facts remain unclear", async () => {
    const { service } = await context();
    const original = await service.prepareDraft({ text: "他又这样说了，我有些不安" });
    const old = await service.screenAndSave(original.sessionId, randomUUID(), screening({
      decision: "review", categories: ["danger"], reason: "信息不足", anchors: [],
      coverage: "complete", policyVersion: "test-v1"
    }));
    if (old.kind !== "needs_review") throw new Error("expected review");
    service.abandonDraft(original.sessionId);
    const replacement = await service.prepareDraft({ text: "他在门口又说了类似的话，但我没看清是谁" });
    const fresh = await service.rescreenPendingFromManual(old.pendingId, replacement.sessionId, screening({
      decision: "review", categories: ["danger"], reason: "仍需确认身份与行为", anchors: [],
      coverage: "complete", policyVersion: "test-v2"
    }));
    expect(fresh.kind).toBe("needs_review");
    expect(service.listPending()).toHaveLength(1);
    expect(service.listPending()[0]?.id).not.toBe(old.pendingId);
    expect(service.listTimeline({ limit: 10 }).records).toHaveLength(0);
  });

  it("cleans the old manual review when fully re-provided content screens as ordinary", async () => {
    const { database, service } = await context();
    const original = await service.prepareDraft({ text: "他又这样说了，我有些不安" });
    const review = await service.screenAndSave(original.sessionId, randomUUID(), screening({
      decision: "review", categories: ["danger"], reason: "信息不足", anchors: [],
      coverage: "complete", policyVersion: "test-v1"
    }));
    if (review.kind !== "needs_review") throw new Error("expected review");
    service.abandonDraft(original.sessionId);
    const marker = `ordinary-reprovided-${randomUUID()}`;
    const replacement = await service.prepareDraft({ text: `午饭后散步 ${marker}` });
    const result = await service.rescreenPendingFromManual(review.pendingId, replacement.sessionId, screening({
      decision: "skip", categories: [], reason: "普通日常", anchors: [],
      coverage: "complete", policyVersion: "test-v2"
    }));
    expect(result.kind).toBe("skipped");
    expect(service.listPending()).toHaveLength(0);
    expect(service.listTimeline({ limit: 10 }).records).toHaveLength(0);
    expect(database.prepare("SELECT count(*) FROM redesign_operations").pluck().get()).toBe(0);
    expect(database.serialize().includes(Buffer.from(marker))).toBe(false);
  });

  it.each(["zip", "dayone"] as const)("lets an expired %s review be supplemented without restoring an archive or using its excerpt as source", async origin => {
    const { service, path } = await context();
    const original = await service.prepareDraft({ text: "原日记里他又这样说了，我有些不安", origin,
      sourceLocator: { connectorId: "synthetic-import", journalId: "journal", entryId: "entry" }, sourceVersion: "original-v1" });
    const review = await service.screenAndSave(original.sessionId, randomUUID(), screening({
      decision: "review", categories: ["danger"], reason: "需核对具体行为及与本人的关系", anchors: [],
      coverage: "partial", policyVersion: "test-v1"
    }));
    if (review.kind !== "needs_review") throw new Error("expected review");
    service.abandonDraft(original.sessionId);
    const text = "补充核对：同事在公司门口直接威胁我，附件是我收到的消息";
    const replacement = await service.prepareDraft({ text, paths: [path] });
    const failed = await service.rescreenPendingFromManual(review.pendingId, replacement.sessionId, {
      async screen() { throw new Error("synthetic connection failure"); }
    });
    expect(failed.kind).toBe("failed");
    expect(service.listPending().map(item => item.id)).toEqual([review.pendingId]);
    const screen = vi.fn(async () => ({ decision: "include" as const, categories: ["danger" as const],
      reason: "补充明确本人遭遇的威胁", anchors: [], coverage: "complete" as const, policyVersion: "test-v2" }));
    const saved = await service.rescreenPendingFromManual(review.pendingId, replacement.sessionId, { screen });
    expect(screen).toHaveBeenCalledWith(expect.objectContaining({ text, origin: "manual" }), undefined);
    expect(saved.kind).toBe("saved");
    expect(service.listPending()).toHaveLength(0);
    const record = service.listTimeline({ limit: 10 }).records[0]!;
    expect(record).toMatchObject({ origin: "manual", attachmentCount: 1 });
    expect(service.getRecord(record.id).source.text).toBe(text);
    expect(await service.rescreenPendingFromManual(review.pendingId, replacement.sessionId, { screen })).toEqual(saved);
    expect(screen).toHaveBeenCalledOnce();
  });

  it.each(["skip", "review"] as const)("replaces an expired ZIP review with its supplemented %s outcome", async decision => {
    const { service } = await context();
    const original = await service.prepareDraft({ text: "原日记含糊描述", origin: "zip" });
    const old = await service.screenAndSave(original.sessionId, randomUUID(), screening({
      decision: "review", categories: [], reason: "需补充本人关系", anchors: [], coverage: "complete", policyVersion: "test-v1"
    }));
    if (old.kind !== "needs_review") throw new Error("expected review");
    service.abandonDraft(original.sessionId);
    const replacement = await service.prepareDraft({ text: "这是我补充的具体经过" });
    const result = await service.rescreenPendingFromManual(old.pendingId, replacement.sessionId, screening({
      decision, categories: [], reason: "补充后的判断", anchors: [], coverage: "complete", policyVersion: "test-v2"
    }));
    expect(result.kind).toBe(decision === "skip" ? "skipped" : "needs_review");
    expect(service.listPending().some(item => item.id === old.pendingId)).toBe(false);
    expect(service.listPending()).toHaveLength(decision === "skip" ? 0 : 1);
    expect(service.listTimeline({ limit: 10 }).records).toHaveLength(0);
  });

  it("lets an expired migration review be re-provided as a clearly manual record", async () => {
    const { service } = await context();
    const migrated = await service.migrateLegacyWorkspace({
      sourceWorkspaceId: "synthetic-old-workspace",
      async scan(consumer) {
        await consumer({
          legacyEntityId: "old-event-1", title: "旧记录", occurredAt: { kind: "unknown" },
          text: "旧工作区里一条说不清的记录", paths: [], fileNames: [], incompleteMedia: false,
          sourceVersion: "old-v1", recordedAt: "2024-01-02T00:00:00.000Z", revisions: []
        });
        return 1;
      },
      async close() {}
    }, screening({
      decision: "review", categories: ["grudge"], reason: "事实仍不明确",
      anchors: [], coverage: "complete", policyVersion: "test-v1"
    }));
    expect(migrated.review).toBe(1);
    const pending = service.listPending()[0]!;
    expect(pending).toMatchObject({ origin: "migration", sessionAvailable: false });
    const replacement = await service.prepareDraft({ text: "重新提供的完整事实：有人威胁了我" });
    const saved = await service.rescreenPendingFromManual(pending.id, replacement.sessionId, screening({
      decision: "include", categories: ["danger"], reason: "存在明确威胁",
      anchors: [], coverage: "complete", policyVersion: "test-v2"
    }));
    expect(saved.kind).toBe("saved");
    expect(service.listPending()).toHaveLength(0);
    const record = service.listTimeline({ limit: 10 }).records[0]!;
    expect(record.origin).toBe("manual");
    expect(service.getRecord(record.id).source.text).toBe("重新提供的完整事实：有人威胁了我");
  });

  it("reopens the same legacy source version and retains its origin, revisions and attachment", async () => {
    const { database, path, service } = await context();
    const entry: LegacyMigrationEntry = {
      legacyEntityId: "old-event-with-image", title: "旧工作区原始标题",
      occurredAt: { kind: "date", value: "2024-01-02" }, text: "旧记录中的工资凭证",
      paths: [path], fileNames: ["evidence.png"], incompleteMedia: false,
      sourceVersion: "legacy-image-v1", recordedAt: "2024-01-02T00:00:00.000Z",
      revisions: [{ revision: 1, snapshot: { title: "旧工作区原始标题" }, actor: "user",
        reason: "原始记录", createdAt: "2024-01-02T00:00:00.000Z" }]
    };
    const sourceFor = (close = vi.fn(async () => undefined)) => ({
      sourceWorkspaceId: "synthetic-old-workspace",
      async scan(consumer: (value: LegacyMigrationEntry) => Promise<void>) { await consumer(entry); return 1; },
      close
    });
    await service.migrateLegacyWorkspace(sourceFor(), screening({
      decision: "review", categories: ["rights"], reason: "需要确认凭证归属",
      anchors: [], coverage: "complete", policyVersion: "test-v1"
    }));
    const pending = service.listPending()[0]!;
    expect(pending).toMatchObject({ origin: "migration", sessionAvailable: false });
    const close = vi.fn(async () => undefined);
    const result = await service.resolvePendingFromLegacyWorkspace(pending.id, sourceFor(close), {
      async screen() { throw new Error("Unchanged source must not be rescreened."); }
    }, randomUUID());
    expect(result.kind).toBe("saved");
    expect(close).toHaveBeenCalledOnce();
    expect(service.listPending()).toHaveLength(0);
    const record = service.listTimeline({ limit: 10 }).records[0]!;
    expect(record).toMatchObject({ origin: "migration", title: "旧工作区原始标题", attachmentCount: 1 });
    expect(service.getRecord(record.id).source).toMatchObject({
      connectorId: "legacy:synthetic-old-workspace", journalId: "events", entryId: entry.legacyEntityId,
      sourceVersion: entry.sourceVersion, text: entry.text
    });
    expect(database.prepare("SELECT count(*) FROM redesign_legacy_revisions").pluck().get()).toBe(1);
  });

  it("rejects a different legacy workspace and rescreens a changed source instead of keeping an old decision", async () => {
    const { database, service } = await context();
    const entry: LegacyMigrationEntry = {
      legacyEntityId: "old-event-changing", title: "旧记录", occurredAt: { kind: "unknown" },
      text: "旧的模糊描述", paths: [], fileNames: [], incompleteMedia: false,
      sourceVersion: "legacy-v1", recordedAt: "2024-01-02T00:00:00.000Z", revisions: []
    };
    const sourceFor = (sourceWorkspaceId: string, candidate: LegacyMigrationEntry, close = vi.fn(async () => undefined)) => ({
      sourceWorkspaceId,
      async scan(consumer: (value: LegacyMigrationEntry) => Promise<void>) { await consumer(candidate); return 1; },
      close
    });
    await service.migrateLegacyWorkspace(sourceFor("correct-workspace", entry), screening({
      decision: "review", categories: ["danger"], reason: "事实不明确",
      anchors: [], coverage: "complete", policyVersion: "test-v1"
    }));
    const pending = service.listPending()[0]!;
    const wrongClose = vi.fn(async () => undefined);
    await expect(service.resolvePendingFromLegacyWorkspace(pending.id,
      sourceFor("another-workspace", entry, wrongClose), screening({
        decision: "include", categories: ["danger"], reason: "不应使用错误来源",
        anchors: [], coverage: "complete", policyVersion: "test-v2"
      }), randomUUID())).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    expect(wrongClose).toHaveBeenCalledOnce();
    expect(service.listPending()).toHaveLength(1);
    const revised: LegacyMigrationEntry = { ...entry, text: "今天天气晴朗", sourceVersion: "legacy-v2" };
    let screened = 0;
    const result = await service.resolvePendingFromLegacyWorkspace(pending.id,
      sourceFor("correct-workspace", revised), {
        async screen(input) {
          screened += 1;
          expect(input.text).toBe(revised.text);
          return { decision: "skip", categories: [], reason: "普通日常",
            anchors: [], coverage: "complete", policyVersion: "test-v2" };
        }
      }, randomUUID());
    expect(result.kind).toBe("skipped");
    expect(screened).toBe(1);
    expect(service.listPending()).toHaveLength(0);
    expect(service.listTimeline({ limit: 10 }).records).toHaveLength(0);
    expect(database.serialize().includes(Buffer.from(revised.text))).toBe(false);
  });

  it("does not confirm an unchanged legacy review while its media is still incomplete", async () => {
    const { service } = await context();
    const entry: LegacyMigrationEntry = {
      legacyEntityId: "old-incomplete-event", title: "缺少旧附件", occurredAt: { kind: "unknown" },
      text: "旧记录需要图片才能确认", paths: [], fileNames: [], incompleteMedia: true,
      sourceVersion: "legacy-incomplete-v1", recordedAt: "2024-01-02T00:00:00.000Z", revisions: []
    };
    const sourceFor = () => ({
      sourceWorkspaceId: "synthetic-old-workspace",
      async scan(consumer: (value: LegacyMigrationEntry) => Promise<void>) { await consumer(entry); return 1; },
      async close() {}
    });
    await service.migrateLegacyWorkspace(sourceFor(), screening({
      decision: "skip", categories: [], reason: "文字不足以证明相关性",
      anchors: [], coverage: "complete", policyVersion: "test-v1"
    }));
    const pending = service.listPending()[0]!;
    await expect(service.resolvePendingFromLegacyWorkspace(pending.id, sourceFor(), screening({
      decision: "include", categories: ["rights"], reason: "不应沿用旧判断",
      anchors: [], coverage: "complete", policyVersion: "test-v2"
    }), randomUUID())).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    expect(service.listPending()).toHaveLength(1);
    expect(service.listTimeline({ limit: 10 }).records).toHaveLength(0);
  });

  it("closes a competing legacy source while one pending item is already being resolved", async () => {
    const { service } = await context();
    const entry: LegacyMigrationEntry = {
      legacyEntityId: "old-concurrent-event", title: "待确认旧记录", occurredAt: { kind: "unknown" },
      text: "旧记录的工资争议", paths: [], fileNames: [], incompleteMedia: false,
      sourceVersion: "legacy-concurrent-v1", recordedAt: "2024-01-02T00:00:00.000Z", revisions: []
    };
    await service.migrateLegacyWorkspace({
      sourceWorkspaceId: "synthetic-old-workspace",
      async scan(consumer) { await consumer(entry); return 1; },
      async close() {}
    }, screening({
      decision: "review", categories: ["rights"], reason: "需确认", anchors: [],
      coverage: "complete", policyVersion: "test-v1"
    }));
    const pending = service.listPending()[0]!;
    let startScan!: () => void;
    let releaseScan!: () => void;
    const started = new Promise<void>((resolve) => { startScan = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseScan = resolve; });
    const first = service.resolvePendingFromLegacyWorkspace(pending.id, {
      sourceWorkspaceId: "synthetic-old-workspace",
      async scan(consumer) { startScan(); await blocked; await consumer(entry); return 1; },
      async close() {}
    }, screening({
      decision: "include", categories: ["rights"], reason: "不应重新筛选",
      anchors: [], coverage: "complete", policyVersion: "test-v2"
    }), randomUUID());
    await started;
    const closeCompeting = vi.fn(async () => undefined);
    await expect(service.resolvePendingFromLegacyWorkspace(pending.id, {
      sourceWorkspaceId: "synthetic-old-workspace",
      async scan() { throw new Error("A competing scan must not start."); },
      close: closeCompeting
    }, screening({
      decision: "include", categories: ["rights"], reason: "不应重新筛选",
      anchors: [], coverage: "complete", policyVersion: "test-v2"
    }), randomUUID())).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(closeCompeting).toHaveBeenCalledOnce();
    releaseScan();
    expect((await first).kind).toBe("saved");
    expect(service.listTimeline({ limit: 10 }).records).toHaveLength(1);
  });

  it("does not commit a migrated record after its screening is cancelled", async () => {
    const { database, service } = await context();
    const controller = new AbortController();
    const close = vi.fn(async () => undefined);
    await expect(service.migrateLegacyWorkspace({
      sourceWorkspaceId: "synthetic-old-workspace",
      async scan(consumer) {
        await consumer({
          legacyEntityId: "old-event-2", title: "旧记录", occurredAt: { kind: "unknown" },
          text: "迁移中取消的事实", paths: [], fileNames: [], incompleteMedia: false,
          sourceVersion: "old-v1", recordedAt: "2024-01-02T00:00:00.000Z", revisions: []
        });
        return 1;
      },
      close
    }, {
      async screen() {
        controller.abort();
        return { decision: "include", categories: ["rights"], reason: "合成收录",
          anchors: [], coverage: "complete", policyVersion: "test-v1" };
      }
    }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(close).toHaveBeenCalledOnce();
    expect(database.prepare("SELECT count(*) FROM redesign_records").pluck().get()).toBe(0);
    expect(service.listPending()).toHaveLength(0);
  });

  it.each(["invalid input", "missing attachment"] as const)("does not persist a late migration fallback after explicit cancellation of %s", async (failure) => {
    const { service, database, directory } = await context();
    const controller = new AbortController();
    const close = vi.fn(async () => undefined), screen = vi.fn();
    const stopped = new AppError("IMPORT_CANCELLED", "Synthetic migration stopped.", true);
    const operation = service.migrateLegacyWorkspace({ sourceWorkspaceId: "synthetic-cancelled-legacy",
      async scan(consumer) {
        await consumer({ legacyEntityId: "old-late-fallback", title: "合成取消后的旧来源", occurredAt: { kind: "unknown" },
          text: failure === "invalid input" ? "" : "合成附件无法读取的记录",
          paths: failure === "invalid input" ? [] : [join(directory, "not-created.png")], fileNames: [], incompleteMedia: false,
          sourceVersion: "old-late-v1", recordedAt: "2024-01-02T00:00:00.000Z", revisions: [] });
        return 1;
      }, close
    }, { screen }, controller.signal);
    const rejected = expect(operation).rejects.toBe(stopped);
    controller.abort(stopped); await rejected;
    expect(close).toHaveBeenCalledOnce(); expect(screen).not.toHaveBeenCalled();
    for (const table of ["redesign_records", "redesign_pending_reviews", "redesign_operations", "jobs"]) {
      expect(database.prepare(`SELECT count(*) FROM ${table}`).pluck().get()).toBe(0);
    }
  });

  it.each(["invalid input", "missing attachment"] as const)("does not turn a cleared migration session into a pending fallback for %s", async (failure) => {
    const { service, database, directory } = await context();
    const close = vi.fn(async () => undefined), screen = vi.fn();
    const operation = service.migrateLegacyWorkspace({ sourceWorkspaceId: "synthetic-cleared-legacy",
      async scan(consumer) {
        await consumer({ legacyEntityId: "old-cleared-fallback", title: "合成失效后的旧来源", occurredAt: { kind: "unknown" },
          text: failure === "invalid input" ? "" : "合成附件无法读取的记录",
          paths: failure === "invalid input" ? [] : [join(directory, "not-created.png")], fileNames: [], incompleteMedia: false,
          sourceVersion: "old-cleared-v1", recordedAt: "2024-01-02T00:00:00.000Z", revisions: [] });
        return 1;
      }, close
    }, { screen });
    const rejected = expect(operation).rejects.toMatchObject({ code: "IMPORT_CANCELLED" });
    service.clearTransientSessions(); await rejected;
    expect(close).toHaveBeenCalledOnce(); expect(screen).not.toHaveBeenCalled();
    for (const table of ["redesign_records", "redesign_pending_reviews", "redesign_operations", "jobs"]) {
      expect(database.prepare(`SELECT count(*) FROM ${table}`).pluck().get()).toBe(0);
    }
  });

  it("does not write a migration fallback into a replacement workspace after attachment preparation fails", async () => {
    const first = await context(), second = await context();
    const sessionFor = (value: typeof first): RedesignSession => ({ key: Buffer.alloc(32), records: value.records,
      jobs: new SqliteJobRepository(value.database), assets: value.assets, vault: value.vault });
    let active = sessionFor(first);
    const service = new RedesignService(() => active), close = vi.fn(async () => undefined), screen = vi.fn();
    const operation = service.migrateLegacyWorkspace({ sourceWorkspaceId: "synthetic-original-legacy",
      async scan(consumer) {
        await consumer({ legacyEntityId: "old-replacement-fallback", title: "合成不能跨工作区的来源", occurredAt: { kind: "unknown" },
          text: "合成附件无法读取的记录", paths: [join(first.directory, "not-created.png")], fileNames: [], incompleteMedia: false,
          sourceVersion: "old-replacement-v1", recordedAt: "2024-01-02T00:00:00.000Z", revisions: [] });
        return 1;
      }, close
    }, { screen });
    const rejected = expect(operation).rejects.toMatchObject({ code: "IMPORT_CANCELLED" });
    active = sessionFor(second); await rejected;
    expect(close).toHaveBeenCalledOnce(); expect(screen).not.toHaveBeenCalled();
    for (const value of [first, second]) for (const table of ["redesign_records", "redesign_pending_reviews", "redesign_operations", "jobs"]) {
      expect(value.database.prepare(`SELECT count(*) FROM ${table}`).pluck().get()).toBe(0);
    }
  });

  it("closes an already-cancelled empty migration source without starting its scan", async () => {
    const { service } = await context(); const controller = new AbortController();
    const stopped = new AppError("IMPORT_CANCELLED", "Synthetic migration stopped before scanning.", true);
    controller.abort(stopped);
    const scan = vi.fn(async () => 0), close = vi.fn(async () => undefined), screen = vi.fn();
    await expect(service.migrateLegacyWorkspace({ sourceWorkspaceId: "synthetic-empty-legacy", scan, close },
      { screen }, controller.signal)).rejects.toBe(stopped);
    expect(scan).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce(); expect(screen).not.toHaveBeenCalled();
  });

  it("does not report a cancelled empty scan as completed", async () => {
    const { service } = await context(); const controller = new AbortController();
    const stopped = new AppError("IMPORT_CANCELLED", "Synthetic migration stopped during scanning.", true);
    const close = vi.fn(async () => undefined), screen = vi.fn();
    await expect(service.migrateLegacyWorkspace({ sourceWorkspaceId: "synthetic-empty-legacy",
      async scan() { controller.abort(stopped); return 0; }, close }, { screen }, controller.signal)).rejects.toBe(stopped);
    expect(close).toHaveBeenCalledOnce(); expect(screen).not.toHaveBeenCalled();
  });

  it.each(["include", "review"] as const)("does not commit a late migration %s result into a replacement workspace", async (decision) => {
    const first = await context(), second = await context();
    const sessionFor = (value: typeof first): RedesignSession => ({ key: Buffer.alloc(32), records: value.records,
      jobs: new SqliteJobRepository(value.database), assets: value.assets, vault: value.vault });
    let active = sessionFor(first);
    const service = new RedesignService(() => active), close = vi.fn(async () => undefined);
    await expect(service.migrateLegacyWorkspace({ sourceWorkspaceId: "synthetic-late-model-legacy",
      async scan(consumer) {
        await consumer({ legacyEntityId: "old-late-model", title: "合成不能迟到收录的来源", occurredAt: { kind: "unknown" },
          text: "合成奖金争议", paths: [], fileNames: [], incompleteMedia: false,
          sourceVersion: "old-late-model-v1", recordedAt: "2024-01-02T00:00:00.000Z", revisions: [] });
        return 1;
      }, close
    }, { async screen() {
      active = sessionFor(second);
      return { decision, categories: ["rights"], reason: "合成迟到结果", anchors: [], coverage: "complete", policyVersion: "test-v1" };
    } })).rejects.toMatchObject({ code: "IMPORT_CANCELLED" });
    expect(close).toHaveBeenCalledOnce();
    for (const value of [first, second]) for (const table of ["redesign_records", "redesign_sources", "redesign_pending_reviews", "redesign_operations", "assets", "jobs"]) {
      expect(value.database.prepare(`SELECT count(*) FROM ${table}`).pluck().get()).toBe(0);
    }
  });

  it("cleans an in-flight migration upload without committing after its workspace changes", async () => {
    const first = await context(), second = await context();
    const sessionFor = (value: typeof first): RedesignSession => ({ key: Buffer.alloc(32), records: value.records,
      jobs: new SqliteJobRepository(value.database), assets: value.assets, vault: value.vault });
    let active = sessionFor(first);
    const service = new RedesignService(() => active), close = vi.fn(async () => undefined);
    const put = first.vault.put.bind(first.vault);
    vi.spyOn(first.vault, "put").mockImplementation(async (path, key) => {
      const result = await put(path, key); active = sessionFor(second); return result;
    });
    await expect(service.migrateLegacyWorkspace({ sourceWorkspaceId: "synthetic-late-upload-legacy",
      async scan(consumer) {
        await consumer({ legacyEntityId: "old-late-upload", title: "合成不能跨工作区上传的来源", occurredAt: { kind: "unknown" },
          text: "合成奖金争议", paths: [first.path], fileNames: ["synthetic-evidence.png"], incompleteMedia: false,
          sourceVersion: "old-late-upload-v1", recordedAt: "2024-01-02T00:00:00.000Z", revisions: [] });
        return 1;
      }, close
    }, { async screen(input) { return { decision: "include", categories: ["rights"], reason: "合成相关结果",
      anchors: [{ sourceVersion: input.sourceVersion, temporaryMediaRef: input.media[0]!.id }],
      coverage: "complete", policyVersion: "test-v1" }; } })).rejects.toMatchObject({ code: "IMPORT_CANCELLED" });
    expect(close).toHaveBeenCalledOnce(); expect(first.stored.size).toBe(0); expect(second.stored.size).toBe(0);
    for (const value of [first, second]) for (const table of ["redesign_records", "redesign_sources", "redesign_pending_reviews", "redesign_operations", "assets", "jobs"]) {
      expect(value.database.prepare(`SELECT count(*) FROM ${table}`).pluck().get()).toBe(0);
    }
  });

  it.each(["invalid input", "missing attachment"] as const)("still creates a minimal review for a genuinely unreadable migration %s", async (failure) => {
    const { service, database, directory } = await context();
    const close = vi.fn(async () => undefined), screen = vi.fn();
    const result = await service.migrateLegacyWorkspace({ sourceWorkspaceId: "synthetic-unreadable-legacy",
      async scan(consumer) {
        await consumer({ legacyEntityId: "old-unreadable", title: "合成需要重新提供的旧来源", occurredAt: { kind: "unknown" },
          text: failure === "invalid input" ? "" : "合成附件无法读取的记录",
          paths: failure === "invalid input" ? [] : [join(directory, "not-created.png")], fileNames: [], incompleteMedia: false,
          sourceVersion: "old-unreadable-v1", recordedAt: "2024-01-02T00:00:00.000Z", revisions: [] });
        return 1;
      }, close
    }, { screen });
    expect(result).toEqual({ total: 1, included: 0, skipped: 0, review: 1, failed: 0 });
    expect(close).toHaveBeenCalledOnce(); expect(screen).not.toHaveBeenCalled();
    expect(service.listPending()).toEqual([expect.objectContaining({ origin: "migration", coverage: "partial", sessionAvailable: false })]);
    for (const table of ["redesign_records", "redesign_sources", "assets", "jobs"]) {
      expect(database.prepare(`SELECT count(*) FROM ${table}`).pluck().get()).toBe(0);
    }
    expect(database.serialize().includes(Buffer.from("合成需要重新提供的旧来源"))).toBe(false);
    expect(database.serialize().includes(Buffer.from("合成附件无法读取的记录"))).toBe(false);
  });

  it("keeps earlier committed migration records but discards a later unreadable cancelled entry", async () => {
    const { service, database, directory } = await context(); const controller = new AbortController();
    const stopped = new AppError("IMPORT_CANCELLED", "Synthetic migration stopped after its first record.", true);
    const close = vi.fn(async () => undefined), screen = vi.fn(async () => ({ decision: "include" as const,
      categories: ["rights" as const], reason: "合成权益事件", anchors: [], coverage: "complete" as const, policyVersion: "test-v1" }));
    await expect(service.migrateLegacyWorkspace({ sourceWorkspaceId: "synthetic-partially-committed-legacy",
      async scan(consumer) {
        const base: LegacyMigrationEntry = { legacyEntityId: "old-first", title: "合成已完成迁移的奖金记录", occurredAt: { kind: "unknown" },
          text: "合成已完成迁移的奖金记录", paths: [], fileNames: [], incompleteMedia: false,
          sourceVersion: "old-first-v1", recordedAt: "2024-01-02T00:00:00.000Z", revisions: [] };
        await consumer(base);
        const late = consumer({ ...base, legacyEntityId: "old-second", title: "合成取消后不能待确认", text: "合成取消后不能待确认",
          paths: [join(directory, "not-created.png")], sourceVersion: "old-second-v1" });
        controller.abort(stopped); await late; return 2;
      }, close
    }, { screen }, controller.signal)).rejects.toBe(stopped);
    expect(close).toHaveBeenCalledOnce(); expect(screen).toHaveBeenCalledOnce();
    expect(service.listTimeline({}).records).toEqual([expect.objectContaining({ title: "合成已完成迁移的奖金记录" })]);
    expect(service.listPending()).toHaveLength(0);
    for (const table of ["redesign_records", "redesign_sources", "redesign_operations", "jobs"]) {
      expect(database.prepare(`SELECT count(*) FROM ${table}`).pluck().get()).toBe(1);
    }
    expect(database.serialize().includes(Buffer.from("合成取消后不能待确认"))).toBe(false);
  });

  it("releases the completed migration controller instead of cancelling its closed source on a later lock", async () => {
    const { service } = await context(); let scanSignal: AbortSignal | undefined;
    const close = vi.fn(async () => undefined);
    expect(await service.migrateLegacyWorkspace({ sourceWorkspaceId: "synthetic-completed-empty-legacy",
      async scan(_consumer, signal) { scanSignal = signal; return 0; }, close
    }, { screen: vi.fn() })).toEqual({ total: 0, included: 0, skipped: 0, review: 0, failed: 0 });
    service.clearTransientSessions(); expect(scanSignal?.aborted).toBe(false); expect(close).toHaveBeenCalledOnce();
  });

  it("reopens a reviewed ZIP entry only after matching its locator and version", async () => {
    const { database, service } = await context();
    const entry: NormalizedDayOneEntry = {
      externalId: "uuid:reviewed-zip", entryUuid: "REVIEWED-ZIP", fingerprint: "f".repeat(64),
      creationDate: "2026-01-02T00:00:00.000Z", journalDate: "2026-01-02", text: "他又这样说了，我有些不安",
      tags: [], media: [], contentHash: "a".repeat(64), raw: { journal: { uuid: "private-journal" } }
    };
    const importer = (entries: NormalizedDayOneEntry[]): DayOneScreeningImporterPort => ({
      async scanArchive(_path, _root, consumer) {
        for (const candidate of entries) await consumer.onEntry(candidate, [], false);
        return { totalEntries: entries.length, mediaEntries: 0, missingMedia: 0 };
      }
    });
    const archive = join(tmpdir(), "fictional-review.zip");
    const initial = await service.importDayOneZip(archive, importer([entry]), screening({
      decision: "review", categories: ["danger"], reason: "需要本人确认", anchors: [],
      coverage: "complete", policyVersion: "test-v1"
    }));
    expect(initial.review).toBe(1);
    const pending = service.listPending()[0]!;
    expect(pending.sessionAvailable).toBe(false);
    await expect(service.resolvePendingFromDayOneZip(pending.id, archive, importer([]), screening({
      decision: "include", categories: ["danger"], reason: "不应调用", anchors: [], coverage: "complete", policyVersion: "test-v1"
    }), randomUUID())).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    expect(service.listPending()).toHaveLength(1);

    const diagnosticId = `uuid-hash:${createHash("sha256").update("reviewed-zip").digest("hex")}`;
    await expect(service.resolvePendingFromDayOneZip(pending.id, archive, {
      async scanArchive(_path, _root, consumer) {
        await consumer.onIssue({
          severity: "error", code: "DAYONE_ENTRY_INVALID", entryExternalId: diagnosticId,
          message: "The journal entry is invalid or uses unsupported fields."
        });
        return { totalEntries: 1, mediaEntries: 0, missingMedia: 0 };
      }
    }, screening({
      decision: "include", categories: ["danger"], reason: "不应调用", anchors: [], coverage: "complete", policyVersion: "test-v1"
    }), randomUUID())).rejects.toMatchObject({ code: "IMPORT_INVALID_ARCHIVE" });
    expect(service.listPending()).toHaveLength(1);

    const result = await service.resolvePendingFromDayOneZip(pending.id, archive, importer([entry]), {
      async screen() { throw new Error("Unchanged reviewed source must not call the model again."); }
    }, randomUUID());
    expect(result.kind).toBe("saved");
    expect(service.listPending()).toHaveLength(0);
    expect(service.listTimeline({ limit: 10 }).records).toHaveLength(1);
    expect(database.prepare("SELECT count(*) FROM redesign_sources WHERE journal_id = 'private-journal'").pluck().get()).toBe(1);
  });

  it("rescreens a changed reviewed ZIP entry and never keeps its old verdict", async () => {
    const { database, service } = await context();
    const entry: NormalizedDayOneEntry = {
      externalId: "uuid:changed-review", entryUuid: "CHANGED-REVIEW", fingerprint: "f".repeat(64),
      creationDate: "2026-01-02T00:00:00.000Z", journalDate: "2026-01-02", text: "他又这样说了，我有些不安",
      tags: [], media: [], contentHash: "a".repeat(64), raw: {}
    };
    const importer = (candidate: NormalizedDayOneEntry): DayOneScreeningImporterPort => ({
      async scanArchive(_path, _root, consumer) {
        await consumer.onEntry(candidate, [], false);
        return { totalEntries: 1, mediaEntries: 0, missingMedia: 0 };
      }
    });
    const archive = join(tmpdir(), "fictional-changed-review.zip");
    await service.importDayOneZip(archive, importer(entry), screening({
      decision: "review", categories: ["danger"], reason: "需要本人确认", anchors: [],
      coverage: "complete", policyVersion: "test-v1"
    }));
    const pending = service.listPending()[0]!;
    const updated = { ...entry, contentHash: "b".repeat(64), text: "午饭后散步，下午工作顺利" };
    let screened = 0;
    const result = await service.resolvePendingFromDayOneZip(pending.id, archive, importer(updated), {
      async screen(input) {
        screened += 1;
        expect(input.text).toBe(updated.text);
        return { decision: "skip", categories: [], reason: "普通日常", anchors: [],
          coverage: "complete", policyVersion: "test-v2" };
      }
    }, randomUUID());
    expect(result.kind).toBe("skipped");
    expect(screened).toBe(1);
    expect(service.listPending()).toHaveLength(0);
    expect(service.listTimeline({ limit: 10 }).records).toHaveLength(0);
    expect(database.serialize().includes(Buffer.from(updated.text))).toBe(false);
  });

  it("commits a formal record, encrypted-object metadata, FTS and report job once", async () => {
    const { database, path, service } = await context();
    const draft = await service.prepareDraft({ text: "项目奖金迟迟未结清，公司仍未支付", paths: [path], sourceVersion: "v1" });
    const operationId = randomUUID();
    const model = screening({
      decision: "include", categories: ["rights"], reason: "与用户报酬权益有关",
      anchors: [{ sourceVersion: "v1", temporaryMediaRef: draft.attachments[0]!.id }],
      coverage: "complete", policyVersion: "test-v1"
    });
    const first = await service.screenAndSave(draft.sessionId, operationId, model);
    const repeated = await service.screenAndSave(draft.sessionId, operationId, model);
    expect(first).toEqual(repeated);
    expect(first.kind).toBe("saved");
    expect(database.prepare("SELECT count(*) AS count FROM redesign_records").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT count(*) AS count FROM redesign_sources").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT count(*) AS count FROM assets").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT count(*) AS count FROM jobs WHERE type = 'record.analyze'").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT max_attempts FROM jobs WHERE type = 'record.analyze'").get()).toEqual({ max_attempts: 4 });
    expect(database.prepare("SELECT count(*) AS count FROM jobs WHERE type = 'asset.verify'").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT count(*) AS count FROM redesign_record_fts").get()).toEqual({ count: 1 });
    expect(service.search({ text: "奖金" }).hits).toHaveLength(1);
  });

  it("deduplicates equal attachments without leaving a screening anchor on a transient id", async () => {
    const { database, path, service } = await context();
    const draft = await service.prepareDraft({
      text: "同一份工资凭证被选择了两次", paths: [path, path], sourceVersion: "duplicate-asset-v1"
    });
    const result = await service.screenAndSave(draft.sessionId, randomUUID(), screening({
      decision: "include", categories: ["rights"], reason: "与工资权益有关",
      anchors: [{ sourceVersion: "duplicate-asset-v1", temporaryMediaRef: draft.attachments[1]!.id }],
      coverage: "complete", policyVersion: "test-v1"
    }));
    expect(result.kind).toBe("saved");
    expect(database.prepare("SELECT count(*) FROM assets").pluck().get()).toBe(1);
    expect(database.prepare("SELECT count(*) FROM redesign_record_assets").pluck().get()).toBe(1);
    const assetId = String(database.prepare("SELECT id FROM assets").pluck().get());
    const anchors = JSON.parse(String(database.prepare(
      "SELECT anchors_json FROM redesign_screening_results"
    ).pluck().get())) as Array<{ assetId?: string }>;
    expect(anchors).toEqual([{ sourceVersion: "duplicate-asset-v1", assetId }]);
    expect(database.prepare("SELECT count(*) FROM jobs WHERE type = 'asset.verify'").pluck().get()).toBe(1);
  });

  it("saves attachment anchors without scanning every asset, even if the hash lookup is stale", async () => {
    const { assets, database, path, service } = await context();
    const save = async (sourceVersion: string) => {
      const draft = await service.prepareDraft({ text: `同一图片的${sourceVersion}`, paths: [path], sourceVersion });
      const result = await service.screenAndSave(draft.sessionId, randomUUID(), screening({
        decision: "include", categories: ["rights"], reason: "图片证据", coverage: "complete",
        anchors: [{ sourceVersion, temporaryMediaRef: draft.attachments[0]!.id }], policyVersion: "test-v1"
      }));
      expect(result.kind).toBe("saved");
    };
    await save("first-version");
    const actualAssetId = String(database.prepare("SELECT id FROM assets").pluck().get());
    vi.spyOn(assets, "list").mockImplementation(() => { throw new Error("full asset scan must not run"); });
    vi.spyOn(assets, "findBySha256").mockReturnValue(undefined);
    await save("second-version");
    expect(database.prepare("SELECT count(*) FROM assets").pluck().get()).toBe(1);
    expect(database.prepare("SELECT count(*) FROM redesign_record_assets").pluck().get()).toBe(2);
    const anchorRows = database.prepare(
      "SELECT anchors_json FROM redesign_screening_results ORDER BY rowid"
    ).all() as Array<{ anchors_json: string }>;
    expect(anchorRows.map(({ anchors_json }) => (JSON.parse(anchors_json) as Array<{ assetId: string }>)[0]?.assetId))
      .toEqual([actualAssetId, actualAssetId]);
  });

  it("rejects search text above the renderer and IPC limit", async () => {
    const { service } = await context();
    await expect(service.prepareSearchQuery({ text: "查".repeat(501) }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects changed image and audio query files before either model receives their bytes", async () => {
    let embeddingCalls = 0;
    let descriptionCalls = 0;
    const embedding: RecordEmbeddingPort = {
      identity: "test.query-media-integrity", version: 1, dimensions: 2,
      inputModalities: ["text", "image"], maxInputBytes: 1024,
      async embed(inputs) {
        embeddingCalls += 1;
        return inputs.map(() => new Float32Array([1, 0]));
      }
    };
    const mediaDescription: RecordMediaQueryDescriptionPort = {
      inputModalities: ["audio"], maxInputBytes: 1024,
      async describe(inputs) {
        descriptionCalls += 1;
        return inputs.map(({ id }) => ({ id, text: "合成音频描述" }));
      }
    };
    const { database, directory, path, records, service } = await context(embedding, mediaDescription);
    records.setSearchIndexEnabled(true, "2026-09-21T00:00:00.000Z");
    records.createSearchGeneration({
      id: "query-media-generation", adapterIdentity: embedding.identity, adapterVersion: embedding.version,
      dimensions: embedding.dimensions, normalization: "l2", inputModalities: ["text", "image"],
      state: "building", fragmentCount: 0, createdAt: "2026-09-21T00:00:00.000Z"
    });
    records.activateSearchGeneration("query-media-generation", 0, "2026-09-21T00:01:00.000Z");
    const audioPath = join(directory, "query.wav");
    await writeFile(audioPath, Buffer.from("RIFF1234WAVEdata"));
    for (const mediaPath of [path, audioPath]) {
      const query = await service.prepareSearchQuery({ paths: [mediaPath] });
      const changed = Buffer.from(await readFile(mediaPath));
      changed[changed.length - 1] = (changed.at(-1) ?? 0) ^ 1;
      await writeFile(mediaPath, changed);
      await expect(service.executeSearchQuery(query.sessionId, { limit: 5 }))
        .rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    }
    expect(embeddingCalls).toBe(0);
    expect(descriptionCalls).toBe(0);
    for (const table of ["redesign_records", "redesign_pending_reviews", "assets", "redesign_search_embeddings"]) {
      expect(database.prepare(`SELECT count(*) FROM ${table}`).pluck().get()).toBe(0);
    }
  });

  it("keeps keyword pagination when a prepared semantic query falls back to local search", async () => {
    const { database, service } = await context();
    const now = "2026-09-21T00:00:00.000Z";
    const insertRecord = database.prepare(`
      INSERT INTO redesign_records(id, origin, categories_json, title, summary, revision,
        occurred_at_json, recorded_at, report_state, source_updated, created_at, updated_at)
      VALUES (?, 'manual', '["rights"]', ?, '', 1, '{"kind":"date","value":"2026-09-21"}',
        ?, 'complete', 0, ?, ?)
    `);
    const insertSource = database.prepare(`
      INSERT INTO redesign_sources(id, record_id, origin, source_version, content_hash, text, recorded_at, created_at)
      VALUES (?, ?, 'manual', 'v1', ?, ?, ?, ?)
    `);
    const insertFts = database.prepare(`
      INSERT INTO redesign_record_fts(record_id, title, source_text, report_text, user_text)
      VALUES (?, ?, ?, '', '')
    `);
    database.transaction(() => {
      for (let index = 0; index < 105; index += 1) {
        const id = `keyword-page-${String(index).padStart(3, "0")}`;
        const title = `奖金分页记录 ${index}`;
        insertRecord.run(id, title, now, now, now);
        insertSource.run(`source-${id}`, id, "a".repeat(64), title, now, now);
        insertFts.run(id, title, title);
      }
    })();
    const query = await service.prepareSearchQuery({ text: "奖金" });
    const first = await service.executeSearchQuery(query.sessionId, { limit: 30 });
    expect(first.capabilities.semantic).toBe("unavailable");
    expect(first.hits).toHaveLength(30);
    const ids = first.hits.map(({ record }) => record.id);
    let cursor = first.nextCursor;
    while (cursor) {
      const page = service.search({ text: "奖金", limit: 30, cursor });
      ids.push(...page.hits.map(({ record }) => record.id));
      cursor = page.nextCursor;
    }
    expect(ids).toHaveLength(105);
    expect(new Set(ids).size).toBe(105);
  });

  it("removes newly encrypted objects when the database transaction cannot commit", async () => {
    const { database, path, records, service, stored } = await context();
    vi.spyOn(records, "commitRecord").mockImplementation(() => { throw new Error("simulated database failure"); });
    const draft = await service.prepareDraft({
      text: "项目奖金迟迟未结清，公司仍未支付", paths: [path], sourceVersion: "commit-failure-v1"
    });
    const result = await service.screenAndSave(draft.sessionId, randomUUID(), screening({
      decision: "include", categories: ["rights"], reason: "与用户报酬权益有关",
      anchors: [{ sourceVersion: "commit-failure-v1", temporaryMediaRef: draft.attachments[0]!.id }],
      coverage: "complete", policyVersion: "test-v1"
    }));
    expect(result).toEqual({ kind: "failed", code: "INTERNAL_ERROR", retryable: false });
    expect(stored.size).toBe(0);
    for (const table of ["redesign_records", "redesign_sources", "redesign_screening_results", "assets", "jobs"]) {
      expect(database.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
  });

  it("reports an orphan cleanup failure instead of hiding encrypted residue", async () => {
    const { path, records, service, stored, vault } = await context();
    vi.spyOn(records, "commitRecord").mockImplementation(() => { throw new Error("simulated database failure"); });
    vi.spyOn(vault, "remove").mockRejectedValue(new Error("simulated object cleanup failure"));
    const draft = await service.prepareDraft({
      text: "项目奖金迟迟未结清，公司仍未支付", paths: [path], sourceVersion: "cleanup-failure-v1"
    });
    const result = await service.screenAndSave(draft.sessionId, randomUUID(), screening({
      decision: "include", categories: ["rights"], reason: "与用户报酬权益有关",
      anchors: [{ sourceVersion: "cleanup-failure-v1", temporaryMediaRef: draft.attachments[0]!.id }],
      coverage: "complete", policyVersion: "test-v1"
    }));
    expect(result).toEqual({ kind: "failed", code: "CLEANUP_FAILED", retryable: true });
    expect(stored.size).toBe(1);
  });

  it("keeps a committed record and its object when derived-index queueing fails", async () => {
    const { database, path, service, stored } = await context();
    vi.spyOn(service, "ensureSearchIndexJob").mockImplementation(() => { throw new Error("simulated index queue failure"); });
    const draft = await service.prepareDraft({
      text: "项目奖金迟迟未结清，公司仍未支付", paths: [path], sourceVersion: "post-commit-failure-v1"
    });
    const result = await service.screenAndSave(draft.sessionId, randomUUID(), screening({
      decision: "include", categories: ["rights"], reason: "与用户报酬权益有关",
      anchors: [{ sourceVersion: "post-commit-failure-v1", temporaryMediaRef: draft.attachments[0]!.id }],
      coverage: "complete", policyVersion: "test-v1"
    }));
    expect(result.kind).toBe("saved");
    expect(stored.size).toBe(1);
    expect(database.prepare("SELECT count(*) AS count FROM redesign_records").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT count(*) AS count FROM assets").get()).toEqual({ count: 1 });
  });

  it.each(["report", "override"] as const)("keeps a committed %s successful when asynchronous index queueing rejects", async (kind) => {
    const { service, database } = await context();
    const draft = await service.prepareDraft({ text: "合成报酬争议材料" });
    const saved = await service.screenAndSave(draft.sessionId, randomUUID(), screening({ decision: "include", categories: ["rights"],
      reason: "合成权益测试", anchors: [], coverage: "complete", policyVersion: "synthetic-post-commit-v1" }));
    if (saved.kind !== "saved") throw new Error("Expected synthetic saved record");
    const before = JSON.stringify(database.prepare("SELECT * FROM redesign_sources ORDER BY rowid").all());
    const queue = vi.spyOn(service, "ensureSearchIndexJob").mockRejectedValue(new AppError("REVISION_CONFLICT", "Synthetic derived queue failure", true));
    if (kind === "override") {
      const edited = await service.patchFields(saved.recordId, 1, { location: "合成用户补充地点" });
      expect(edited.record.revision).toBe(2); expect(service.getRecord(saved.recordId).overrides)
        .toEqual(expect.arrayContaining([expect.objectContaining({ fieldKey: "location", value: "合成用户补充地点" })]));
    } else {
      const reported = await service.runAnalysis(saved.recordId, 1, { async analyze() { return {
        state: "complete", promptVersion: "synthetic-post-commit-v1", modelProfile: "synthetic:no-network",
        content: { summary: "合成保存成功报告", time: { source: "ai" }, location: { source: "ai" }, people: [], chronology: [],
          unknowns: [], disputes: [], suggestions: [], legalIssues: [], citations: [], coverageNotes: [] }
      }; } });
      expect(reported.record.reportState).toBe("complete");
      expect(service.getRecord(saved.recordId).report?.state).toBe("complete");
    }
    expect(queue).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(database.prepare("SELECT * FROM redesign_sources ORDER BY rowid").all())).toBe(before);
  });

  it("does not publish a late changed-source skip after its scheduling session is cleared", async () => {
    const { service, database } = await context();
    const locator = { connectorId: "dayone-zip", journalId: "synthetic", entryId: "synthetic-scope-skip" };
    const original = await service.prepareDraft({ text: "合成报酬争议", origin: "zip", sourceVersion: "synthetic-v1", sourceLocator: locator });
    const saved = await service.screenAndSave(original.sessionId, randomUUID(), screening({ decision: "include", categories: ["rights"],
      reason: "合成权益材料", anchors: [], coverage: "complete", policyVersion: "synthetic-scope-v1" }));
    if (saved.kind !== "saved") throw new Error("Expected synthetic saved record");
    const before = JSON.stringify(database.prepare("SELECT * FROM redesign_sources ORDER BY rowid").all());
    let started!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(service, "ensureSearchIndexJob").mockImplementation(async () => { started(); await gate; return undefined; });
    const changed = await service.prepareDraft({ text: "合成无关日常", origin: "zip", sourceVersion: "synthetic-v2", sourceLocator: locator });
    const pending = service.screenAndSave(changed.sessionId, randomUUID(), screening({ decision: "skip", categories: [],
      reason: "合成无关材料", anchors: [], coverage: "complete", policyVersion: "synthetic-scope-v1" }));
    await entered; service.clearTransientSessions(); release();
    expect(await pending).toMatchObject({ kind: "failed", code: "SOURCE_UNAVAILABLE" });
    expect(service.getRecord(saved.recordId).record).toMatchObject({ revision: 2, sourceReviewRequired: true });
    expect(JSON.stringify(database.prepare("SELECT * FROM redesign_sources ORDER BY rowid").all())).toBe(before);
    expect(database.prepare("SELECT count(*) FROM redesign_records").pluck().get()).toBe(1);
  });

  it("versions a changed ZIP source without duplicating the formal record", async () => {
    const { database, service } = await context();
    const locator = { connectorId: "dayone-zip", journalId: "default", entryId: "uuid:stable-entry" };
    const model = screening({
      decision: "include", categories: ["rights"], reason: "与用户权益有关",
      anchors: [], coverage: "complete", policyVersion: "test-v1"
    });
    const firstDraft = await service.prepareDraft({
      text: "公司尚未支付奖金", origin: "zip", sourceVersion: "version-one", sourceLocator: locator,
      sourceRecordedAt: "2025-01-02T00:00:00.000Z"
    });
    const first = await service.screenAndSave(firstDraft.sessionId, randomUUID(), model);
    expect(first.kind).toBe("saved");

    const changedDraft = await service.prepareDraft({
      text: "公司仍未支付奖金，并拒绝回复", origin: "zip", sourceVersion: "version-two", sourceLocator: locator,
      sourceRecordedAt: "2025-01-02T00:00:00.000Z"
    });
    const changed = await service.screenAndSave(changedDraft.sessionId, randomUUID(), model);
    if (first.kind !== "saved" || changed.kind !== "saved") throw new Error("expected saved records");
    expect(changed.recordId).toBe(first.recordId);
    expect(database.prepare("SELECT count(*) AS count FROM redesign_records").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT count(*) AS count FROM redesign_sources").get()).toEqual({ count: 2 });
    expect(database.prepare("SELECT count(*) AS count FROM jobs WHERE type = 'record.analyze'").get()).toEqual({ count: 2 });
    expect(database.prepare("SELECT revision, source_updated FROM redesign_records").get()).toEqual({ revision: 2, source_updated: 1 });

    const replayDraft = await service.prepareDraft({
      text: "公司仍未支付奖金，并拒绝回复", origin: "zip", sourceVersion: "version-two", sourceLocator: locator
    });
    await service.screenAndSave(replayDraft.sessionId, randomUUID(), model);
    expect(database.prepare("SELECT count(*) AS count FROM redesign_sources").get()).toEqual({ count: 2 });
    expect(database.prepare("SELECT count(*) AS count FROM jobs WHERE type = 'record.analyze'").get()).toEqual({ count: 2 });

    const unrelatedUpdate = await service.prepareDraft({
      text: "后来补充的内容只是普通日常", origin: "zip", sourceVersion: "version-three", sourceLocator: locator
    });
    const skipped = await service.screenAndSave(unrelatedUpdate.sessionId, randomUUID(), screening({
      decision: "skip", categories: [], reason: "新版本与收录范围无关",
      anchors: [], coverage: "complete", policyVersion: "test-v1"
    }));
    expect(skipped.kind).toBe("skipped");
    expect(database.prepare("SELECT count(*) AS count FROM redesign_sources").get()).toEqual({ count: 2 });
    expect(database.prepare("SELECT source_updated, report_state FROM redesign_records").get())
      .toEqual({ source_updated: 1, report_state: "stale" });
  });

  it("keeps an unretained source update visible after reanalyzing the old source", async () => {
    const { service } = await context();
    const locator = { connectorId: "dayone-zip", journalId: "work", entryId: "uuid:unretained-update" };
    const include = screening({
      decision: "include", categories: ["rights"], reason: "涉及报酬", anchors: [],
      coverage: "complete", policyVersion: "test-v1"
    });
    const analyzer: ReportAnalysisPort = {
      async analyze() {
        return {
          content: {
            summary: "旧版来源的报告", time: { source: "ai" }, location: { source: "ai" },
            people: [], chronology: [], unknowns: [], disputes: [], suggestions: [],
            legalIssues: [], citations: [], coverageNotes: []
          }, state: "complete", promptVersion: "test-unretained", modelProfile: "test:model"
        };
      }
    };
    const firstDraft = await service.prepareDraft({
      text: "工资尚未发放", origin: "zip", sourceVersion: "retained-v1", sourceLocator: locator
    });
    const first = await service.screenAndSave(firstDraft.sessionId, randomUUID(), include);
    if (first.kind !== "saved") throw new Error("expected saved record");
    expect((await service.runAnalysis(first.recordId, 1, analyzer)).record).toMatchObject({
      sourceUpdated: false, sourceReviewRequired: false
    });

    const unrelatedDraft = await service.prepareDraft({
      text: "新版本只有普通日常", origin: "zip", sourceVersion: "unretained-v2", sourceLocator: locator
    });
    expect((await service.screenAndSave(unrelatedDraft.sessionId, randomUUID(), screening({
      decision: "skip", categories: [], reason: "新版本无关", anchors: [],
      coverage: "complete", policyVersion: "test-v1"
    }))).kind).toBe("skipped");
    expect(service.getRecord(first.recordId).record).toMatchObject({
      revision: 2, sourceUpdated: true, sourceReviewRequired: true, reportState: "stale"
    });
    expect((await service.runAnalysis(first.recordId, 2, analyzer)).record).toMatchObject({
      sourceUpdated: true, sourceReviewRequired: true, reportState: "complete"
    });

    const relevantDraft = await service.prepareDraft({
      text: "新版本又有工资争议", origin: "zip", sourceVersion: "retained-v3", sourceLocator: locator
    });
    const relevant = await service.screenAndSave(relevantDraft.sessionId, randomUUID(), include);
    expect(relevant.kind).toBe("saved");
    expect(service.getRecord(first.recordId).record).toMatchObject({
      revision: 3, sourceUpdated: true, sourceReviewRequired: false, reportState: "queued"
    });
    expect((await service.runAnalysis(first.recordId, 3, analyzer)).record).toMatchObject({
      sourceUpdated: false, sourceReviewRequired: false, reportState: "complete"
    });
  });

  it("keeps historical source assets while exposing only the latest source revision", async () => {
    const { database, directory, path, service } = await context();
    const nextPath = join(directory, "updated-evidence.png");
    await writeFile(nextPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x6e, 0x65, 0x77]));
    const locator = { connectorId: "dayone-zip", journalId: "work", entryId: "uuid:asset-revision" };
    const firstDraft = await service.prepareDraft({
      text: "第一版工资凭证", paths: [path], origin: "zip", sourceVersion: "asset-source-v1", sourceLocator: locator
    });
    const first = await service.screenAndSave(firstDraft.sessionId, randomUUID(), screening({
      decision: "include", categories: ["rights"], reason: "第一版权益材料",
      anchors: [{ sourceVersion: "asset-source-v1", temporaryMediaRef: firstDraft.attachments[0]!.id }],
      coverage: "complete", policyVersion: "test-v1"
    }));
    if (first.kind !== "saved") throw new Error("expected first saved record");

    const nextDraft = await service.prepareDraft({
      text: "第二版工资凭证", paths: [nextPath], origin: "zip", sourceVersion: "asset-source-v2", sourceLocator: locator
    });
    const next = await service.screenAndSave(nextDraft.sessionId, randomUUID(), screening({
      decision: "include", categories: ["rights"], reason: "第二版权益材料",
      anchors: [{ sourceVersion: "asset-source-v2", temporaryMediaRef: nextDraft.attachments[0]!.id }],
      coverage: "complete", policyVersion: "test-v1"
    }));
    if (next.kind !== "saved") throw new Error("expected updated saved record");
    expect(next.recordId).toBe(first.recordId);

    const detail = service.getRecord(first.recordId);
    expect(detail.source.sourceVersion).toBe("asset-source-v2");
    expect(detail.attachments.map(({ originalFileName }) => originalFileName)).toEqual(["updated-evidence.png"]);
    expect(detail.record.attachmentCount).toBe(1);
    expect(database.prepare("SELECT count(*) FROM redesign_record_assets").pluck().get()).toBe(2);
    expect(database.prepare("SELECT count(DISTINCT source_id) FROM redesign_record_assets").pluck().get()).toBe(2);
  });

  it("keeps user fields and the current projection when an older report finishes late", async () => {
    const { database, service } = await context();
    const draft = await service.prepareDraft({ text: "公司拒绝支付约定奖金", sourceVersion: "report-source-v1" });
    const saved = await service.screenAndSave(draft.sessionId, randomUUID(), screening({
      decision: "include", categories: ["rights"], reason: "涉及用户报酬权益",
      anchors: [], coverage: "complete", policyVersion: "test-v1"
    }));
    if (saved.kind !== "saved") throw new Error("expected saved record");

    let finish!: (value: Awaited<ReturnType<ReportAnalysisPort["analyze"]>>) => void;
    const analyzer: ReportAnalysisPort = {
      analyze: () => new Promise((resolve) => { finish = resolve; })
    };
    const late = service.runAnalysis(saved.recordId, 1, analyzer);
    const edited = await service.patchFields(saved.recordId, 1, {
      location: "上海市浦东新区",
      jurisdiction: "中国大陆"
    });
    expect(edited.record).toMatchObject({ revision: 2, reportState: "stale" });

    finish({
      content: {
        summary: "迟到的旧版分析摘要",
        time: { source: "ai", prompt: "待补充时间" },
        location: { value: "模型猜测地点", source: "ai" },
        people: [], chronology: [], unknowns: [], disputes: [], suggestions: [],
        legalIssues: ["待核验劳动报酬规则"], citations: [], coverageNotes: []
      },
      state: "complete", promptVersion: "test-report-v1", modelProfile: "test:model"
    });
    const current = await late;
    expect(current.record).toMatchObject({ revision: 2, reportState: "stale" });
    expect(current.record.summary).not.toBe("迟到的旧版分析摘要");
    expect(current.overrides).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldKey: "location", value: "上海市浦东新区" }),
      expect.objectContaining({ fieldKey: "jurisdiction", value: "中国大陆" })
    ]));
    expect(database.prepare("SELECT count(*) AS count FROM redesign_reports WHERE record_revision = 1").get())
      .toEqual({ count: 1 });

    await service.runAnalysis(saved.recordId, 2, {
      async analyze() {
        return {
          content: {
            summary: "新版核验摘要仅出现在报告中",
            time: { source: "ai", prompt: "待补充时间" },
            location: { value: "上海市浦东新区", source: "user" },
            people: [], chronology: [], unknowns: [], disputes: [], suggestions: [],
            legalIssues: [], citations: [], coverageNotes: []
          },
          state: "complete", promptVersion: "test-report-v2", modelProfile: "test:model"
        };
      }
    });
    expect(service.search({ text: "新版核验摘要" }).hits[0]?.anchor).toMatchObject({
      surface: "report", sourceVersion: "report-source-v1"
    });
    expect(service.search({ text: "上海市浦东新区" }).hits[0]?.anchor).toMatchObject({
      surface: "user", fieldKey: "location", sourceVersion: "report-source-v1"
    });
  });

  it("keeps months and closed ranges that overlap a selected day across timeline, keyword and semantic search", async () => {
    const embedding: RecordEmbeddingPort = { identity: "test.date-overlap", version: 1, dimensions: 2, inputModalities: ["text"],
      async embed(inputs) { return inputs.map(() => new Float32Array([1, 0])); } };
    const { service } = await context(embedding);
    const ids: string[] = [];
    for (const time of [{ kind: "month", value: "2026-09" }, { kind: "range", from: "2026-09-10", to: "2026-09-20" },
      { kind: "month", value: "2026-10" }] as const) {
      const draft = await service.prepareDraft({ text: "合成日期边界奖金记录" });
      const saved = await service.screenAndSave(draft.sessionId, randomUUID(), screening({ decision: "include", categories: ["rights"],
        reason: "合成权益事件", anchors: [], coverage: "complete", policyVersion: "test-v1" }));
      if (saved.kind !== "saved") throw new Error("expected synthetic saved record");
      await service.patchFields(saved.recordId, 1, { occurredAt: time }); ids.push(saved.recordId);
    }
    const filters = { from: "2026-09-15", to: "2026-09-15", timeZone: "Asia/Shanghai", limit: 100 };
    expect(service.listTimeline(filters).records.map(({ id }) => id).sort()).toEqual(ids.slice(0, 2).sort());
    expect(service.search({ text: "合成日期边界", ...filters }).hits.map(({ record }) => record.id).sort()).toEqual(ids.slice(0, 2).sort());
    service.setSearchIndexEnabled(true); await service.rebuildSearchIndex();
    const query = await service.prepareSearchQuery({ text: "不在原文中的日期语义描述" });
    const semantic = await service.executeSearchQuery(query.sessionId, filters);
    expect(semantic.capabilities.semantic).toBe("ready");
    expect(semantic.hits.map(({ record }) => record.id).sort()).toEqual(ids.slice(0, 2).sort());
  });

  it("uses the same local date for instants and recorded-date fallbacks across all three paths", async () => {
    const embedding: RecordEmbeddingPort = { identity: "test.date-zone", version: 1, dimensions: 2, inputModalities: ["text"],
      async embed(inputs) { return inputs.map(() => new Float32Array([1, 0])); } };
    const { service } = await context(embedding);
    const instant = await dateRecord(service, { kind: "instant", value: "2026-09-20T00:30:00Z" });
    const calendar = await dateRecord(service, { kind: "date", value: "2026-09-20" });
    const fallback = await dateRecord(service, { kind: "unknown" }, { sourceRecordedAt: "2026-09-20T00:30:00Z" });
    service.setSearchIndexEnabled(true); await service.rebuildSearchIndex();
    for (const [timeZone, day, expected] of [
      ["America/Los_Angeles", "2026-09-19", [instant.id, fallback.id]],
      ["America/Los_Angeles", "2026-09-20", [calendar.id]],
      ["Asia/Shanghai", "2026-09-20", [instant.id, calendar.id, fallback.id]]
    ] as const) {
      const filter = { from: day, to: day, timeZone, limit: 100 };
      expect(service.listTimeline(filter).records.map(({ id }) => id).sort()).toEqual([...expected].sort());
      expect(service.search({ text: "合成日期边界", ...filter }).hits.map(({ record }) => record.id).sort()).toEqual([...expected].sort());
      const query = await service.prepareSearchQuery({ text: "不在原文中的日期语义描述" });
      expect((await service.executeSearchQuery(query.sessionId, filter)).hits.map(({ record }) => record.id).sort()).toEqual([...expected].sort());
    }
  });

  it("combines open-bound overlap with category and origin filters without changing retained fields", async () => {
    const { service } = await context();
    const openFrom = await dateRecord(service, { kind: "range", from: "2026-09-10" }, { origin: "zip" });
    const openTo = await dateRecord(service, { kind: "range", to: "2026-09-20" }, { origin: "zip" });
    await dateRecord(service, { kind: "month", value: "2026-09" }, { categories: ["danger"], origin: "zip" });
    await dateRecord(service, { kind: "date", value: "2026-09-15" });
    const before = service.getRecord(openFrom.id);
    const filter = { from: "2026-09-15", to: "2026-09-15", category: "rights", origin: "zip", timeZone: "UTC" } as const;
    expect(service.listTimeline(filter).records.map(({ id }) => id).sort()).toEqual([openFrom.id, openTo.id].sort());
    expect(service.search({ text: "合成日期边界", ...filter }).hits.map(({ record }) => record.id).sort()).toEqual([openFrom.id, openTo.id].sort());
    expect(service.getRecord(openFrom.id)).toEqual(before);
  });

  it("sorts actual instants through the repeated DST hour and paginates calendar units without duplication", async () => {
    const { service } = await context();
    const times: TemporalValue[] = [{ kind: "month", value: "2026-10" },
      { kind: "range", from: "2026-10-02", to: "2026-11-10" }, { kind: "date", value: "2026-11-01" },
      { kind: "instant", value: "2026-11-01T01:50:00-07:00" }, { kind: "instant", value: "2026-11-01T01:10:00-08:00" }];
    const records = [];
    for (const time of times) records.push(await dateRecord(service, time));
    const expected = records.map(({ id }) => id).reverse();
    const timeZone = "America/Los_Angeles";
    expect(service.listTimeline({ timeZone }).records.map(({ id }) => id)).toEqual(expected);
    const collected: string[] = []; let cursor: string | undefined;
    do {
      const page = service.search({ text: "合成日期边界", timeZone, limit: 1, ...(cursor ? { cursor } : {}) });
      collected.push(...page.hits.map(({ record }) => record.id)); cursor = page.nextCursor;
    } while (cursor);
    expect(collected).toEqual(expected);
    const first = service.listTimeline({ timeZone, limit: 1 });
    expect(() => service.listTimeline({ cursor: first.nextCursor!, timeZone: "UTC", limit: 1 })).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(() => service.search({ text: "合成日期边界", cursor: first.nextCursor!, timeZone: "UTC", limit: 1 })).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(() => service.listTimeline({ cursor: Buffer.from("2026-11-01\0obsolete").toString("base64url"), timeZone })).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("rejects invalid dates and changed semantic-page zones before additional model work", async () => {
    let calls = 0;
    const embedding: RecordEmbeddingPort = { identity: "test.date-validation", version: 1, dimensions: 2, inputModalities: ["text"],
      async embed(inputs) { calls += 1; return inputs.map(() => new Float32Array([1, 0])); } };
    const { service } = await context(embedding);
    for (let index = 0; index < 3; index++) await dateRecord(service, { kind: "month", value: "2026-09" });
    service.setSearchIndexEnabled(true); await service.rebuildSearchIndex(); const before = calls;
    for (const filter of [{ from: "2026-02-29" }, { timeZone: "unknown/zone" }, { from: "2026-09-20", to: "2026-09-19" }]) {
      expect(() => service.listTimeline(filter)).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
      expect(() => service.search({ text: "合成日期边界", ...filter })).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
      const query = await service.prepareSearchQuery({ text: "合成日期语义" });
      await expect(service.executeSearchQuery(query.sessionId, filter)).rejects.toMatchObject({ code: "INVALID_INPUT" });
      service.abandonSearchQuery(query.sessionId);
    }
    expect(calls).toBe(before);
    const query = await service.prepareSearchQuery({ text: "不在原文中的日期语义描述" });
    const first = await service.executeSearchQuery(query.sessionId, { limit: 1, timeZone: "UTC" });
    expect(first.nextCursor).toBeTruthy(); const after = calls;
    await expect(service.executeSearchQuery(query.sessionId, { limit: 1, timeZone: "Asia/Shanghai", cursor: first.nextCursor! }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(calls).toBe(after);
    expect((await service.executeSearchQuery(query.sessionId, { limit: 1, timeZone: "Etc/UTC", cursor: first.nextCursor! })).hits).toHaveLength(1);
    expect(calls).toBe(after);
  });

  it("searches known report time and citation text and keeps their report provenance", async () => {
    const { service } = await context();
    const draft = await service.prepareDraft({ text: "合成奖金争议", sourceVersion: "report-text-coverage-v1" });
    const saved = await service.screenAndSave(draft.sessionId, randomUUID(), screening({
      decision: "include", categories: ["rights"], reason: "合成权益事件", anchors: [],
      coverage: "complete", policyVersion: "test-v1"
    }));
    if (saved.kind !== "saved") throw new Error("expected synthetic saved record");
    await service.runAnalysis(saved.recordId, 1, {
      async analyze() { return { content: {
        summary: "合成事件报告", time: { source: "source", value: { value: "2041-08-21", precision: "exact" } },
        location: { source: "ai" }, people: [], chronology: [], unknowns: [], disputes: [], suggestions: [],
        legalIssues: [], citations: [{ id: randomUUID(), title: "CITATIONTITLEONLY", publisher: "CITATIONPUBLISHERONLY",
          url: "https://www.gov.cn/synthetic", retrievedAt: "2026-09-29T00:00:00.000Z", jurisdiction: "中国大陆",
          effectiveInfo: "EFFECTIVEINFOONLY", supportingExcerpt: "CITATIONEXCERPTONLY", claimId: "synthetic-claim-id",
          verificationStatus: "pending" }], coverageNotes: []
      }, state: "complete", promptVersion: "report-coverage-v1", modelProfile: "synthetic:model" }; }
    });
    for (const text of ["2041-08-21", "CITATIONTITLEONLY", "CITATIONPUBLISHERONLY", "EFFECTIVEINFOONLY", "CITATIONEXCERPTONLY"]) {
      expect(service.search({ text }).hits).toMatchObject([{ record: { id: saved.recordId },
        anchor: { surface: "report", sourceVersion: "report-text-coverage-v1" } }]);
    }
  });

  it.each(["manual", "zip"] as const)("does not promote dates mentioned in %s source text to an occurrence fact", async (origin) => {
    const { service, database } = await context();
    const text = "2020-01-02 是合同签订日期。引用规则于 2019年3月1日 发布。2026年9月15日 对方拒付约定款项。";
    const include = screening({ decision: "include", categories: ["rights"], reason: "合成权益事件", anchors: [],
      coverage: "complete", policyVersion: "synthetic-context-time-v1" });
    const recordedAt = "2026-09-29T00:00:00Z";
    let recordId: string;
    if (origin === "zip") {
      const importer: DayOneScreeningImporterPort = { async scanArchive(_path, _root, consumer) {
        await consumer.onEntry({ externalId: "uuid:synthetic-context-date", fingerprint: "f".repeat(64), creationDate: recordedAt,
          journalDate: "2026-09-29", text, tags: [], media: [], contentHash: "a".repeat(64), raw: {} }, [], false);
        return { totalEntries: 1, mediaEntries: 0, missingMedia: 0 };
      } };
      expect(await service.importDayOneZip(join(tmpdir(), "synthetic-context-date.zip"), importer, include))
        .toMatchObject({ included: 1, failed: 0 });
      recordId = service.listTimeline({}).records[0]!.id;
    } else {
      const draft = await service.prepareDraft({ text, sourceRecordedAt: recordedAt });
      const result = await service.screenAndSave(draft.sessionId, randomUUID(), include);
      if (result.kind !== "saved") throw new Error("Expected synthetic record");
      recordId = result.recordId;
    }
    const before = service.getRecord(recordId);
    expect(before.record.occurredAt).toEqual({ kind: "unknown" });
    expect(before.source.text).toBe(text);
    expect(service.listTimeline({ from: "2020-01-02", to: "2020-01-02", timeZone: "UTC" }).records).toEqual([]);
    expect(service.search({ text: "合同", from: "2026-09-29", to: "2026-09-29", timeZone: "UTC" }).hits)
      .toMatchObject([{ record: { id: recordId, occurredAt: { kind: "unknown" } } }]);
    const resolved = await service.runAnalysis(recordId, 1, timeAnalysis("2026-09-15"));
    expect(resolved.record.occurredAt).toEqual({ kind: "date", value: "2026-09-15" });
    expect(resolved.source).toEqual(before.source);
    expect(database.prepare("SELECT occurred_at_json FROM redesign_records WHERE id = ?").pluck().get(recordId))
      .toBe('{"kind":"unknown"}');
  });

  it("uses a current known report date as a reversible timeline projection, not a source rewrite", async () => {
    const { service, database } = await context();
    const draft = await service.prepareDraft({ text: "合成奖金事件，没有具体日期", sourceRecordedAt: "2026-09-29T00:00:00Z" });
    const saved = await service.screenAndSave(draft.sessionId, randomUUID(), screening({ decision: "include", categories: ["rights"],
      reason: "合成权益事件", anchors: [], coverage: "complete", policyVersion: "test-v1" }));
    if (saved.kind !== "saved") throw new Error("Expected synthetic record");
    const before = service.getRecord(saved.recordId);
    await service.runAnalysis(saved.recordId, 1, timeAnalysis("2026-09-12"));
    expect(service.getRecord(saved.recordId).record.occurredAt).toEqual({ kind: "date", value: "2026-09-12" });
    expect(service.listTimeline({ from: "2026-09-12", to: "2026-09-12", timeZone: "UTC" }).records).toHaveLength(1);
    expect(service.search({ text: "合成奖金", from: "2026-09-12", to: "2026-09-12", timeZone: "UTC" }).hits).toHaveLength(1);
    expect(database.prepare("SELECT occurred_at_json FROM redesign_records WHERE id = ?").pluck().get(saved.recordId))
      .toBe(JSON.stringify(before.record.occurredAt));
    expect(service.getRecord(saved.recordId).source).toEqual(before.source);
  });

  it("projects report months, ranges and zoned instants consistently through all search paths", async () => {
    const embedding: RecordEmbeddingPort = { identity: "test.report-occurrence", version: 1, dimensions: 2, inputModalities: ["text"],
      async embed(inputs) { return inputs.map(() => new Float32Array([1, 0])); } };
    const { service } = await context(embedding); const ids: string[] = [];
    for (const [value, precision] of [["约2026年9月", "approximate"], ["2026-09-10至2026-09-20", "range"],
      ["2026-09-20T00:30:00Z", "exact"]] as const) {
      const draft = await service.prepareDraft({ text: "合成报告日期奖金事件", sourceRecordedAt: "2026-09-29T00:00:00Z" });
      const saved = await service.screenAndSave(draft.sessionId, randomUUID(), screening({ decision: "include", categories: ["rights"],
        reason: "合成权益事件", anchors: [], coverage: "complete", policyVersion: "test-v1" }));
      if (saved.kind !== "saved") throw new Error("Expected synthetic record");
      await service.runAnalysis(saved.recordId, 1, { async analyze(input) {
        const result = await timeAnalysis(value).analyze(input);
        result.content.time = { source: "ai", value: { value, precision } }; return result;
      } }); ids.push(saved.recordId);
    }
    service.setSearchIndexEnabled(true); await service.rebuildSearchIndex();
    for (const [day, expected] of [["2026-09-15", ids.slice(0, 2)], ["2026-09-19", ids], ["2026-09-20", ids.slice(0, 2)]] as const) {
      const filter = { from: day, to: day, timeZone: "America/Los_Angeles", limit: 100 };
      expect(service.listTimeline(filter).records.map(({ id }) => id).sort()).toEqual([...expected].sort());
      expect(service.search({ text: "合成报告日期", ...filter }).hits.map(({ record }) => record.id).sort()).toEqual([...expected].sort());
      const query = await service.prepareSearchQuery({ text: "不在原文中的日期语义描述" });
      expect((await service.executeSearchQuery(query.sessionId, filter)).hits.map(({ record }) => record.id).sort()).toEqual([...expected].sort());
    }
    expect(service.getRecord(ids[0]!).record).toMatchObject({ occurredAt: { kind: "month", value: "2026-09" },
      occurredAtSource: "ai", occurredAtPrecision: "approximate" });
  });

  it("keeps user occurrence overrides and an explicit unknown across newer report dates", async () => {
    const { service } = await context();
    const row = await dateRecord(service, { kind: "date", value: "2026-09-15" }, { sourceRecordedAt: "2026-09-29T00:00:00Z" });
    await service.runAnalysis(row.id, 2, timeAnalysis("2026-09-12"));
    expect(service.getRecord(row.id).record).toMatchObject({ occurredAt: row.occurredAt, occurredAtSource: "user" });
    await service.patchFields(row.id, 2, { occurredAt: { kind: "unknown" } });
    await service.runAnalysis(row.id, 3, timeAnalysis("2026-09-12"));
    expect(service.getRecord(row.id).record).toMatchObject({ occurredAt: { kind: "unknown" }, occurredAtSource: "user" });
    expect(service.listTimeline({ from: "2026-09-12", to: "2026-09-12", timeZone: "UTC" }).records).toHaveLength(0);
    expect(service.listTimeline({ from: "2026-09-29", to: "2026-09-29", timeZone: "UTC" }).records).toHaveLength(1);
  });

  it("does not copy report-derived time into the source field during other edits or use stale reports", async () => {
    const { service, database } = await context();
    const draft = await service.prepareDraft({ text: "合成奖金事件", sourceRecordedAt: "2026-09-29T00:00:00Z" });
    const saved = await service.screenAndSave(draft.sessionId, randomUUID(), screening({ decision: "include", categories: ["rights"],
      reason: "合成权益事件", anchors: [], coverage: "complete", policyVersion: "test-v1" }));
    if (saved.kind !== "saved") throw new Error("Expected synthetic record");
    await service.runAnalysis(saved.recordId, 1, timeAnalysis("2026-09-12"));
    const edited = await service.patchFields(saved.recordId, 1, { title: "用户改了标题，但没有补充发生日期" });
    expect(edited.record.occurredAt).toEqual({ kind: "unknown" }); expect(edited.report?.recordRevision).toBe(1);
    expect(database.prepare("SELECT occurred_at_json FROM redesign_records WHERE id = ?").pluck().get(saved.recordId)).toBe('{"kind":"unknown"}');
    expect(service.listTimeline({ from: "2026-09-12", to: "2026-09-12", timeZone: "UTC" }).records).toHaveLength(0);
    await service.runAnalysis(saved.recordId, 2, timeAnalysis("2026-09-20"));
    expect(service.getRecord(saved.recordId).record.occurredAt).toEqual({ kind: "date", value: "2026-09-20" });
    const snapshot = service.getRecord(saved.recordId);
    await expect(service.runAnalysis(saved.recordId, 1, timeAnalysis("2099-01-01"))).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(service.getRecord(saved.recordId)).toEqual(snapshot);
  });

  it("selects the same current report for detail and dates, retracts unknown dates and protects partial downgrades", async () => {
    const { service } = await context();
    const draft = await service.prepareDraft({ text: "合成奖金事件", sourceRecordedAt: "2026-09-29T00:00:00Z" });
    const saved = await service.screenAndSave(draft.sessionId, randomUUID(), screening({ decision: "include", categories: ["rights"],
      reason: "合成权益事件", anchors: [], coverage: "complete", policyVersion: "test-v1" }));
    if (saved.kind !== "saved") throw new Error("Expected synthetic record");
    await service.runAnalysis(saved.recordId, 1, timeAnalysis("2026-09-12"), false, randomUUID());
    await service.runAnalysis(saved.recordId, 1, { async analyze(input) {
      const result = await timeAnalysis("2099-01-01").analyze(input); result.state = "partial"; return result;
    } }, false, randomUUID());
    expect(service.getRecord(saved.recordId).record.occurredAt).toEqual({ kind: "date", value: "2026-09-12" });
    await service.runAnalysis(saved.recordId, 1, { async analyze(input) {
      const result = await timeAnalysis("2099-01-01").analyze(input);
      result.content.time = { source: "ai", value: { value: "2099-01-01", precision: "unknown" } }; return result;
    } }, false, randomUUID());
    expect(service.getRecord(saved.recordId).record.occurredAt).toEqual({ kind: "unknown" });
    expect(service.listTimeline({ from: "2026-09-12", to: "2026-09-12", timeZone: "UTC" }).records).toHaveLength(0);
  });

  it("repairs old keyword projections once without changing retained records, reports or jobs", async () => {
    const { service, records, database } = await context();
    const draft = await service.prepareDraft({ text: "合成旧版本奖金记录" });
    const saved = await service.screenAndSave(draft.sessionId, randomUUID(), screening({
      decision: "include", categories: ["rights"], reason: "合成权益事件", anchors: [],
      coverage: "complete", policyVersion: "test-v1"
    }));
    if (saved.kind !== "saved") throw new Error("expected synthetic saved record");
    await service.runAnalysis(saved.recordId, 1, timeAnalysis("2042-05-06"));
    const before = service.getRecord(saved.recordId);
    const jobsBefore = database.prepare("SELECT count(*) AS count FROM jobs").get();
    database.prepare("UPDATE redesign_record_fts SET report_text = '' WHERE record_id = ?").run(saved.recordId);
    expect(service.search({ text: "2042-05-06" }).hits).toHaveLength(0);
    records.ensureKeywordProjection();
    expect(service.search({ text: "2042-05-06" }).hits).toMatchObject([{ record: { id: saved.recordId }, anchor: { surface: "report" } }]);
    expect(service.getRecord(saved.recordId)).toEqual(before);
    expect(database.prepare("SELECT count(*) AS count FROM jobs").get()).toEqual(jobsBefore);
    expect(database.prepare("SELECT value_json FROM workspace_settings WHERE key = 'redesign.keyword-projection-v2'").get())
      .toEqual({ value_json: "2" });
    const changes = database.prepare("SELECT total_changes() AS count").get();
    records.ensureKeywordProjection();
    expect(database.prepare("SELECT total_changes() AS count").get()).toEqual(changes);
    await service.patchFields(saved.recordId, 1, { location: "合成新补充地点" });
    database.prepare("DELETE FROM workspace_settings WHERE key = 'redesign.keyword-projection-v2'").run();
    records.ensureKeywordProjection();
    expect(service.search({ text: "2042-05-06" }).hits).toHaveLength(0);
  });

  it("repairs more than one bounded page without dropping later formal records", async () => {
    const { service, records, database } = await context();
    for (let index = 0; index < 257; index++) {
      const draft = await service.prepareDraft({ text: `${"合成奖金争议".repeat(35)} 后段分页标记${index}` });
      expect((await service.screenAndSave(draft.sessionId, randomUUID(), screening({
        decision: "include", categories: ["rights"], reason: "合成权益事件", anchors: [],
        coverage: "complete", policyVersion: "test-v1"
      }))).kind).toBe("saved");
    }
    database.prepare("UPDATE redesign_record_fts SET source_text = ''").run();
    expect(service.search({ text: "后段分页标记256" }).hits).toHaveLength(0);
    records.ensureKeywordProjection();
    expect(database.prepare("SELECT count(*) AS count FROM redesign_record_fts WHERE source_text LIKE '%后段分页标记%'").get())
      .toEqual({ count: 257 });
    expect(service.search({ text: "后段分页标记256" }).hits).toHaveLength(1);
  });

  it("rolls back a keyword repair and its marker together after a post-write failure, then retries safely", async () => {
    const { service, records, database } = await context();
    const draft = await service.prepareDraft({ text: "合成索引写失败奖金记录" });
    const saved = await service.screenAndSave(draft.sessionId, randomUUID(), screening({
      decision: "include", categories: ["rights"], reason: "合成权益事件", anchors: [],
      coverage: "complete", policyVersion: "test-v1"
    }));
    if (saved.kind !== "saved") throw new Error("expected synthetic saved record");
    await service.runAnalysis(saved.recordId, 1, timeAnalysis("2043-05-06"));
    const before = service.getRecord(saved.recordId);
    database.prepare("UPDATE redesign_record_fts SET report_text = 'OLDKEYWORDPROJECTION' WHERE record_id = ?").run(saved.recordId);
    database.exec(`CREATE TRIGGER fail_keyword_marker AFTER INSERT ON workspace_settings
      WHEN NEW.key = 'redesign.keyword-projection-v2' BEGIN SELECT RAISE(FAIL, 'synthetic-private-failure'); END;`);
    expect(() => records.ensureKeywordProjection()).toThrowError(expect.objectContaining({ code: "WORKSPACE_INVALID",
      message: "无法更新本地关键词索引，请重试打开工作区。" }));
    expect(database.prepare("SELECT report_text FROM redesign_record_fts WHERE record_id = ?").get(saved.recordId))
      .toEqual({ report_text: "OLDKEYWORDPROJECTION" });
    expect(database.prepare("SELECT count(*) AS count FROM workspace_settings WHERE key = 'redesign.keyword-projection-v2'").get())
      .toEqual({ count: 0 });
    expect(service.getRecord(saved.recordId)).toEqual(before);
    database.exec("DROP TRIGGER fail_keyword_marker"); records.ensureKeywordProjection();
    expect(service.search({ text: "2043-05-06" }).hits).toHaveLength(1);
    expect(service.getRecord(saved.recordId)).toEqual(before);
  });

  it("keeps an older report for review but removes its text from current search after a field revision", async () => {
    const embedding: RecordEmbeddingPort = {
      identity: "test.current-report-only", version: 1, dimensions: 2, inputModalities: ["text"],
      async embed(inputs) { return inputs.map(() => new Float32Array([1, 0])); }
    };
    const { database, service } = await context(embedding);
    const draft = await service.prepareDraft({ text: "公司扣留了我的奖金" });
    const saved = await service.screenAndSave(draft.sessionId, randomUUID(), screening({
      decision: "include", categories: ["rights"], reason: "报酬争议", anchors: [],
      coverage: "complete", policyVersion: "test-v1"
    }));
    if (saved.kind !== "saved") throw new Error("expected saved record");
    const analysis = (legalIssue: string): ReportAnalysisPort => ({
      async analyze() {
        return {
          content: {
            summary: "奖金争议", time: { source: "ai", prompt: "待补充时间" },
            location: { source: "ai", prompt: "待补充地点" }, people: [], chronology: [],
            unknowns: [], disputes: [], suggestions: [], legalIssues: [legalIssue], citations: [], coverageNotes: []
          }, state: "complete", promptVersion: "search-revision-v1", modelProfile: "test:model"
        };
      }
    });
    await service.runAnalysis(saved.recordId, 1, analysis("LEGACYLEGALMARKER"));
    expect(service.search({ text: "LEGACYLEGALMARKER" }).hits).toHaveLength(1);

    const edited = await service.patchFields(saved.recordId, 1, { jurisdiction: "日本" });
    expect(edited.record).toMatchObject({ revision: 2, reportState: "stale" });
    expect(edited.report?.recordRevision).toBe(1);
    expect(service.search({ text: "LEGACYLEGALMARKER" }).hits).toHaveLength(0);
    service.setSearchIndexEnabled(true);
    await service.rebuildSearchIndex();
    const indexedText = database.prepare(`
      SELECT text_content FROM redesign_search_embeddings WHERE record_id = ? AND modality = 'text'
    `).all(saved.recordId) as Array<{ text_content: string | null }>;
    expect(indexedText.some(({ text_content }) => text_content?.includes("LEGACYLEGALMARKER"))).toBe(false);

    await service.runAnalysis(saved.recordId, 2, analysis("CURRENTLEGALMARKER"));
    expect(service.search({ text: "CURRENTLEGALMARKER" }).hits).toHaveLength(1);
    expect(service.search({ text: "LEGACYLEGALMARKER" }).hits).toHaveLength(0);
  });

  it("retains per-issue user clarifications for report retries and rejects malformed direct patches", async () => {
    const { service } = await context();
    const draft = await service.prepareDraft({ text: "公司拖欠约定奖金", sourceVersion: "clarification-source-v1" });
    const saved = await service.screenAndSave(draft.sessionId, randomUUID(), screening({
      decision: "include", categories: ["rights"], reason: "涉及报酬争议", anchors: [],
      coverage: "complete", policyVersion: "test-v1"
    }));
    if (saved.kind !== "saved") throw new Error("expected saved record");
    const value = [{ kind: "unknown" as const, topic: "奖金约定的金额？", response: "我记得是五千元，合同待核对。" }];
    const updated = await service.patchFields(saved.recordId, 1, { clarifications: value });
    expect(updated.record).toMatchObject({ revision: 2, reportState: "stale" });
    expect(updated.overrides).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldKey: "clarifications", value })
    ]));
    await service.runAnalysis(saved.recordId, 2, {
      async analyze(input) {
        expect(input.overrides).toEqual(expect.arrayContaining([
          expect.objectContaining({ fieldKey: "clarifications", value })
        ]));
        return {
          content: {
            summary: "奖金争议仍待核对", time: { source: "ai", prompt: "时间待补充" },
            location: { source: "ai", prompt: "地点待补充" }, people: [], chronology: [],
            unknowns: ["合同原件是否支持金额？"], disputes: [],
            speculations: ["未经证实的裁员猜测"], suggestions: [],
            legalIssues: [], citations: [], coverageNotes: []
          },
          state: "complete", promptVersion: "test-report-v1", modelProfile: "test:model"
        };
      }
    });
    expect(service.getRecord(saved.recordId).overrides).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldKey: "clarifications", value })
    ]));
    expect(service.search({ text: "未经证实的裁员猜测" }).hits[0]?.record.id).toBe(saved.recordId);
    await expect(service.patchFields(saved.recordId, 2, { clarifications: [{
      kind: "unknown", topic: "x", response: ""
    }] })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("replays the same report job idempotently after a post-commit interruption", async () => {
    const { database, service } = await context();
    const draft = await service.prepareDraft({ text: "公司拒绝支付约定奖金", sourceVersion: "report-replay-v1" });
    const saved = await service.screenAndSave(draft.sessionId, randomUUID(), screening({
      decision: "include", categories: ["rights"], reason: "涉及用户报酬权益",
      anchors: [], coverage: "complete", policyVersion: "test-v1"
    }));
    if (saved.kind !== "saved") throw new Error("expected saved record");
    let attempt = 0;
    const analyzer: ReportAnalysisPort = {
      async analyze() {
        attempt += 1;
        return {
          content: {
            summary: attempt === 1 ? "首次已经提交的报告" : "重放时模型给出的不同文本",
            time: { source: "ai" as const, prompt: "待补充时间" }, location: { source: "ai" as const },
            people: [], chronology: [], unknowns: [], disputes: [], suggestions: [], legalIssues: [], citations: [], coverageNotes: []
          },
          state: "complete" as const, promptVersion: "idempotent-report-v1", modelProfile: "test:same-model"
        };
      }
    };
    await service.runAnalysis(saved.recordId, 1, analyzer);
    const replayed = await service.runAnalysis(saved.recordId, 1, analyzer);
    expect(replayed.report?.content.summary).toBe("首次已经提交的报告");
    expect(replayed.record.summary).toBe("首次已经提交的报告");
    expect(database.prepare("SELECT count(*) FROM redesign_reports").pluck().get()).toBe(1);
  });

  it("upgrades a partial report after retry without letting a later partial result replace the complete one", async () => {
    const { database, service } = await context();
    const draft = await service.prepareDraft({ text: "合成的附件分析待补齐", sourceVersion: "partial-retry-v1" });
    const saved = await service.screenAndSave(draft.sessionId, randomUUID(), screening({
      decision: "include", categories: ["rights"], reason: "涉及用户权益",
      anchors: [], coverage: "complete", policyVersion: "test-v1"
    }));
    if (saved.kind !== "saved") throw new Error("expected saved record");
    const analyze = (summary: string, state: "partial" | "complete"): ReportAnalysisPort => ({
      async analyze() {
        return {
          content: {
            summary, time: { source: "ai" }, location: { source: "ai" }, people: [], chronology: [],
            unknowns: [], disputes: [], suggestions: [], legalIssues: [], citations: [], coverageNotes: []
          }, state, promptVersion: "retry-coverage-v1", modelProfile: "test:same-model"
        };
      }
    });
    const partial = await service.runAnalysis(saved.recordId, 1, analyze("首轮只完成部分分析", "partial"));
    expect(partial.record.reportState).toBe("partial");
    const reportId = partial.report?.id;
    expect(reportId).toBeDefined();

    database.prepare("UPDATE jobs SET state = 'succeeded' WHERE type = 'record.analyze'").run();
    const retryJobId = service.reanalyze(saved.recordId, 1);
    expect(database.prepare("SELECT state FROM jobs WHERE id = ?").get(retryJobId)).toEqual({ state: "queued" });
    const complete = await service.runAnalysis(saved.recordId, 1, analyze("重试补齐了全部分析", "complete"));
    expect(complete.record).toMatchObject({ reportState: "complete", summary: "重试补齐了全部分析" });
    expect(complete.report).toMatchObject({ id: reportId, state: "complete", content: { summary: "重试补齐了全部分析" } });
    expect(service.search({ text: "重试补齐了全部分析" }).hits[0]?.record.id).toBe(saved.recordId);
    expect(database.prepare("SELECT count(*) FROM redesign_reports").pluck().get()).toBe(1);

    const stalePartial = await service.runAnalysis(saved.recordId, 1, analyze("迟到的部分分析", "partial"));
    expect(stalePartial.record).toMatchObject({ reportState: "complete", summary: "重试补齐了全部分析" });
    expect(stalePartial.report?.content.summary).toBe("重试补齐了全部分析");
    expect(database.prepare("SELECT count(*) FROM redesign_reports").pluck().get()).toBe(1);
  });

  it("keeps a job replay idempotent while a user-requested reanalysis can publish a new report", async () => {
    const { database, service } = await context();
    const draft = await service.prepareDraft({ text: "合成的奖金事实", sourceVersion: "manual-reanalysis-v1" });
    const saved = await service.screenAndSave(draft.sessionId, randomUUID(), screening({
      decision: "include", categories: ["rights"], reason: "奖金权益事件",
      anchors: [], coverage: "complete", policyVersion: "test-v1"
    }));
    if (saved.kind !== "saved") throw new Error("expected saved record");
    const analyze = (summary: string, state: "partial" | "complete" = "complete"): ReportAnalysisPort => ({
      async analyze() {
        return {
          content: {
            summary, time: { source: "ai" }, location: { source: "ai" }, people: [], chronology: [],
            unknowns: [], disputes: [], suggestions: [], legalIssues: [], citations: [], coverageNotes: []
          }, state, promptVersion: "same-report-v1", modelProfile: "test:same-model"
        };
      }
    });
    const initialJobId = String(database.prepare("SELECT id FROM jobs WHERE type = 'record.analyze'").pluck().get());
    const first = await service.runAnalysis(saved.recordId, 1, analyze("首次完成的报告"), false, initialJobId);
    expect(first.report?.analysisRunId).toBe(initialJobId);
    const replayed = await service.runAnalysis(saved.recordId, 1, analyze("同一任务迟到的另一份报告"), false, initialJobId);
    expect(replayed.report?.content.summary).toBe("首次完成的报告");
    expect(database.prepare("SELECT count(*) FROM redesign_reports").pluck().get()).toBe(1);

    database.prepare("UPDATE jobs SET state = 'succeeded' WHERE id = ?").run(initialJobId);
    const secondJobId = service.reanalyze(saved.recordId, 1);
    expect(secondJobId).not.toBe(initialJobId);
    const second = await service.runAnalysis(saved.recordId, 1, analyze("主动重跑更新的报告"), false, secondJobId);
    expect(second.record).toMatchObject({ summary: "主动重跑更新的报告", reportState: "complete" });
    expect(second.report?.analysisRunId).toBe(secondJobId);
    expect(database.prepare("SELECT count(*) FROM redesign_reports").pluck().get()).toBe(2);
    expect(service.search({ text: "主动重跑更新的报告" }).hits[0]?.record.id).toBe(saved.recordId);

    database.prepare("UPDATE jobs SET state = 'succeeded' WHERE id = ?").run(secondJobId);
    const thirdJobId = service.reanalyze(saved.recordId, 1);
    const partial = await service.runAnalysis(saved.recordId, 1, analyze("未完成的新尝试", "partial"), false, thirdJobId);
    expect(partial.record).toMatchObject({ summary: "主动重跑更新的报告", reportState: "complete" });
    expect(partial.report?.content.summary).toBe("主动重跑更新的报告");
    expect(database.prepare("SELECT count(*) FROM redesign_reports").pluck().get()).toBe(3);
    expect(service.search({ text: "未完成的新尝试" }).hits).toHaveLength(0);
    const completedRetry = await service.runAnalysis(saved.recordId, 1, analyze("第三次尝试补齐的报告"), false, thirdJobId);
    expect(completedRetry.record).toMatchObject({ summary: "第三次尝试补齐的报告", reportState: "complete" });
    expect(completedRetry.report?.analysisRunId).toBe(thirdJobId);
    expect(database.prepare("SELECT count(*) FROM redesign_reports").pluck().get()).toBe(3);
    expect(service.search({ text: "第三次尝试补齐的报告" }).hits[0]?.record.id).toBe(saved.recordId);
  });

  it("keeps analysis running between automatic retries and marks failure only when finalized", async () => {
    const { service } = await context();
    const draft = await service.prepareDraft({ text: "公司拒绝支付约定奖金", sourceVersion: "report-retry-v1" });
    const saved = await service.screenAndSave(draft.sessionId, randomUUID(), screening({
      decision: "include", categories: ["rights"], reason: "涉及用户报酬权益",
      anchors: [], coverage: "complete", policyVersion: "test-v1"
    }));
    if (saved.kind !== "saved") throw new Error("expected saved record");
    await expect(service.runAnalysis(saved.recordId, 1, {
      async analyze() { throw new Error("temporary model outage"); }
    }, true)).rejects.toThrow("temporary model outage");
    expect(service.getRecord(saved.recordId).record.reportState).toBe("running");
    expect(service.failAnalysis(saved.recordId, 1, "AGENT_MODEL_UNAVAILABLE").record.reportState).toBe("failed");
  });

  it("does not publish a report when its analysis job is cancelled before saving", async () => {
    const { database, service } = await context();
    const draft = await service.prepareDraft({ text: "合成奖金争议", sourceVersion: "cancel-analysis-v1" });
    const saved = await service.screenAndSave(draft.sessionId, randomUUID(), screening({
      decision: "include", categories: ["rights"], reason: "合成权益争议",
      anchors: [], coverage: "complete", policyVersion: "test-v1"
    }));
    if (saved.kind !== "saved") throw new Error("expected saved record");
    const controller = new AbortController();
    let analysisStarted!: () => void;
    const started = new Promise<void>((resolve) => { analysisStarted = resolve; });
    let releaseAnalysis!: () => void;
    const hold = new Promise<void>((resolve) => { releaseAnalysis = resolve; });
    const analyzer: ReportAnalysisPort = {
      async analyze(_input, signal) {
        expect(signal).toBe(controller.signal);
        analysisStarted();
        await hold;
        return {
          content: {
            summary: "不应发布的迟到报告", time: { source: "ai" }, location: { source: "ai" },
            people: [], chronology: [], unknowns: [], disputes: [], suggestions: [],
            legalIssues: [], citations: [], coverageNotes: []
          }, state: "complete", promptVersion: "cancel-analysis-test", modelProfile: "test:model"
        };
      }
    };
    const runId = randomUUID();
    const pending = service.runAnalysis(saved.recordId, 1, analyzer, true, runId, controller.signal);
    await started;
    controller.abort();
    releaseAnalysis();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(database.prepare("SELECT count(*) FROM redesign_reports").pluck().get()).toBe(0);
    expect(service.getRecord(saved.recordId).record.reportState).toBe("running");
    const retried = await service.runAnalysis(saved.recordId, 1, {
      async analyze() {
        return {
          content: {
            summary: "解锁后成功的报告", time: { source: "ai" }, location: { source: "ai" },
            people: [], chronology: [], unknowns: [], disputes: [], suggestions: [],
            legalIssues: [], citations: [], coverageNotes: []
          }, state: "complete", promptVersion: "cancel-analysis-test", modelProfile: "test:model"
        };
      }
    }, true, runId);
    expect(retried.record.reportState).toBe("complete");
    expect(retried.report?.content.summary).toBe("解锁后成功的报告");
    expect(database.prepare("SELECT count(*) FROM redesign_reports").pluck().get()).toBe(1);
  });

  it("recalls an image-backed record beyond the first 200 entries without persisting query media", async () => {
    const batchSizes: number[] = [];
    const embedding: RecordEmbeddingPort = {
      identity: "test.multimodal", version: 1, dimensions: 2,
      inputModalities: ["text", "image"], maxInputBytes: 1024, maxBatchSize: 32,
      async embed(inputs) {
        batchSizes.push(inputs.length);
        return inputs.map((input) => input.modality === "image" || input.text?.includes("蓝色收据")
          ? new Float32Array([1, 0]) : new Float32Array([0, 1]));
      }
    };
    const { database, path, service } = await context(embedding);
    const include = screening({
      decision: "include", categories: ["rights"], reason: "测试正式记录",
      anchors: [], coverage: "complete", policyVersion: "test-v1"
    });
    for (let index = 0; index < 205; index += 1) {
      const draft = await service.prepareDraft({ text: `普通相关记录 ${String(index).padStart(3, "0")}` });
      expect((await service.screenAndSave(draft.sessionId, randomUUID(), include)).kind).toBe("saved");
    }
    const targetDraft = await service.prepareDraft({ text: "附件中是目标证据", paths: [path], sourceVersion: "image-target-v1" });
    const target = await service.screenAndSave(targetDraft.sessionId, randomUUID(), screening({
      decision: "include", categories: ["rights"], reason: "图片包含目标证据",
      anchors: [{ sourceVersion: "image-target-v1", temporaryMediaRef: targetDraft.attachments[0]!.id }],
      coverage: "complete", policyVersion: "test-v1"
    }));
    if (target.kind !== "saved") throw new Error("expected target record");

    service.setSearchIndexEnabled(true);
    const status = await service.rebuildSearchIndex();
    expect(status).toMatchObject({ state: "ready", fragmentCount: 413, inputModalities: ["text", "image"] });
    expect(Math.max(...batchSizes)).toBeLessThanOrEqual(32);
    expect(batchSizes.length).toBeGreaterThan(6);
    const query = await service.prepareSearchQuery({ text: "蓝色收据" });
    const textResult = await service.executeSearchQuery(query.sessionId, { limit: 5 });
    expect(textResult.hits[0]?.record.id).toBe(target.recordId);
    expect(textResult.hits).toHaveLength(1);
    expect(textResult.hits[0]?.matches).toHaveLength(1);
    expect(textResult.capabilities).toMatchObject({ semantic: "ready", media: "ready" });

    const mediaQuery = await service.prepareSearchQuery({ paths: [path] });
    const before = {
      records: database.prepare("SELECT count(*) FROM redesign_records").pluck().get(),
      pending: database.prepare("SELECT count(*) FROM redesign_pending_reviews").pluck().get(),
      embeddings: database.prepare("SELECT count(*) FROM redesign_search_embeddings").pluck().get()
    };
    const mediaResult = await service.executeSearchQuery(mediaQuery.sessionId, { limit: 5 });
    expect(mediaResult.hits[0]?.record.id).toBe(target.recordId);
    expect({
      records: database.prepare("SELECT count(*) FROM redesign_records").pluck().get(),
      pending: database.prepare("SELECT count(*) FROM redesign_pending_reviews").pluck().get(),
      embeddings: database.prepare("SELECT count(*) FROM redesign_search_embeddings").pluck().get()
    }).toEqual(before);
    await expect(service.executeSearchQuery(mediaQuery.sessionId, { limit: 5 }))
      .rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    const detail = service.getRecord(target.recordId);
    await service.patchFields(target.recordId, detail.record.revision, { title: "用户修改后的目标证据" });
    expect(database.prepare(
      "SELECT count(*) FROM jobs WHERE type = 'record.search-index-rebuild' AND state = 'queued'"
    ).pluck().get()).toBe(1);
    expect(service.getSearchIndexStatus()).toMatchObject({
      state: "building", activeGenerationId: status.activeGenerationId
    });
    const callsBeforePause = batchSizes.length;
    service.setSearchIndexEnabled(false);
    const pausedQuery = await service.prepareSearchQuery({ text: "蓝色收据" });
    const pausedResult = await service.executeSearchQuery(pausedQuery.sessionId, { limit: 5 });
    expect(pausedResult).toMatchObject({ hits: [], capabilities: { semantic: "unavailable", media: "unavailable" } });
    expect(batchSizes).toHaveLength(callsBeforePause);
  });

  it("indexes and queries converted HEIC images without saving raster copies or query contents", async () => {
    const original = Buffer.alloc(64); original.write("ftyp", 4); original.write("heic", 8); original.write("synthetic-private-HEIC-metadata", 16);
    const converted = Buffer.from("synthetic-raster-for-model-adapter-only");
    const convert = vi.fn(async (input: { bytes: Uint8Array }) => {
      expect(Buffer.from(input.bytes).equals(original)).toBe(true);
      return { bytes: converted, width: 96, height: 64, mimeType: "image/png" as const };
    });
    const embedding: RecordEmbeddingPort = { identity: "test.heic-representations", version: 1, dimensions: 2,
      inputModalities: ["text", "image"], maxInputBytes: 1024,
      async embed(inputs) {
        for (const input of inputs) if (input.modality === "image") {
          expect(input.mimeType).toBe("image/png"); expect(Buffer.from(input.bytes!).equals(converted)).toBe(true);
          expect(input.contentHash).toBe(createHash("sha256").update(original).digest("hex"));
        }
        return inputs.map(() => new Float32Array([1, 0]));
      }
    };
    const { database, directory, stored, service } = await context(embedding, undefined, { convert });
    const path = join(directory, "synthetic.heic"); await writeFile(path, original);
    const draft = await service.prepareDraft({ text: "合成图片记录", paths: [path], sourceVersion: "heic-index-v1" });
    const saved = await service.screenAndSave(draft.sessionId, randomUUID(), screening({
      decision: "include", categories: ["rights"], reason: "合成图片相关", anchors: [{
        sourceVersion: "heic-index-v1", temporaryMediaRef: draft.attachments[0]!.id
      }], coverage: "complete", policyVersion: "test-v1"
    }));
    if (saved.kind !== "saved") throw new Error("Expected synthetic HEIC record");
    service.setSearchIndexEnabled(true); expect((await service.rebuildSearchIndex()).state).toBe("ready");
    expect([...stored.values()].every((bytes) => !bytes.equals(converted))).toBe(true);
    expect([...stored.values()].some((bytes) => bytes.equals(original))).toBe(true);
    const tables = ["redesign_records", "redesign_sources", "redesign_pending_reviews", "assets", "redesign_search_embeddings", "jobs"];
    const counts = () => tables.map((table) => database.prepare(`SELECT count(*) FROM ${table}`).pluck().get());
    const before = counts();
    const query = await service.prepareSearchQuery({ paths: [path] });
    const result = await service.executeSearchQuery(query.sessionId, { limit: 5 });
    expect(result.hits[0]?.record.id).toBe(saved.recordId);
    expect(counts()).toEqual(before); expect(convert).toHaveBeenCalledTimes(2);
    expect((await readFile(path)).equals(original)).toBe(true);
    expect(service.getRecord(saved.recordId).attachments[0]?.mimeType).toBe("image/heic");
  });

  it.each(["changed source", "cancel", "workspace change"] as const)("rejects HEIC query %s without embedding or formal writes", async (mode) => {
    const original = Buffer.alloc(64); original.write("ftyp", 4); original.write("heic", 8);
    let started!: () => void; let release!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const embed = vi.fn(async (inputs: import("./index").RecordEmbeddingInput[]) => inputs.map(() => new Float32Array([1, 0])));
    const embedding: RecordEmbeddingPort = { identity: "test.heic-query-only", version: 1, dimensions: 2,
      inputModalities: ["text", "image"], maxInputBytes: 1024, embed };
    const convert = vi.fn(async (_input: unknown, signal?: AbortSignal) => {
      started(); await gate;
      if (mode === "cancel" || mode === "workspace change") expect(signal?.aborted).toBe(true);
      return { bytes: Buffer.from("synthetic-raster"), width: 96, height: 64, mimeType: "image/png" as const };
    });
    const { database, directory, records, service } = await context(embedding, undefined, { convert });
    service.setSearchIndexEnabled(true);
    records.createSearchGeneration({ id: "heic-query-generation", adapterIdentity: embedding.identity, adapterVersion: embedding.version,
      dimensions: 2, normalization: "l2", inputModalities: ["text", "image"], state: "building", fragmentCount: 0, createdAt: "2026-09-28T00:00:00Z" });
    records.activateSearchGeneration("heic-query-generation", 0, "2026-09-28T00:00:00Z");
    const path = join(directory, "synthetic-query.heic"); await writeFile(path, original);
    const query = await service.prepareSearchQuery({ paths: [path] });
    if (mode === "changed source") await writeFile(path, Buffer.from(original).fill(1, 16));
    const pending = service.executeSearchQuery(query.sessionId, { limit: 5 });
    if (mode !== "changed source") {
      await began;
      if (mode === "cancel") service.abandonSearchQuery(query.sessionId); else service.clearTransientSessions();
      release();
    }
    await expect(pending).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    expect(embed).not.toHaveBeenCalled();
    if (mode === "changed source") expect(convert).not.toHaveBeenCalled();
    for (const table of ["redesign_records", "redesign_sources", "redesign_pending_reviews", "assets", "redesign_search_embeddings"]) {
      expect(database.prepare(`SELECT count(*) FROM ${table}`).pluck().get()).toBe(0);
    }
  });

  it.each([
    { kind: "audio" as const, extension: "mp3", mimeType: "audio/mpeg", bytes: Buffer.from("ID3synthetic-audio-test") },
    { kind: "video" as const, extension: "mp4", mimeType: "video/mp4",
      bytes: Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(12)]) }
  ])("uses a temporary $kind description to recall a report step anchored to the original media", async ({
    kind, extension, mimeType, bytes
  }) => {
    const description = kind === "audio" ? "录音中的加班安排" : "录像中的加班安排";
    const sourceVersion = `${kind}-v1`;
    const embedding: RecordEmbeddingPort = {
      identity: `test.${kind}-description`, version: 1, dimensions: 2, inputModalities: ["text"],
      async embed(inputs) {
        return inputs.map(({ text }) => text?.includes(description)
          ? new Float32Array([1, 0]) : new Float32Array([0, 1]));
      }
    };
    const describe = vi.fn(async (inputs: Parameters<RecordMediaQueryDescriptionPort["describe"]>[0]) =>
      inputs.map(({ id }) => ({ id, text: description })));
    const mediaDescription: RecordMediaQueryDescriptionPort = {
      inputModalities: [kind], maxInputBytes: 7_000_000, describe
    };
    const { database, directory, service } = await context(embedding, mediaDescription);
    const mediaPath = join(directory, `synthetic.${extension}`);
    await writeFile(mediaPath, bytes);
    const draft = await service.prepareDraft({ text: "用户提交了一段工作安排材料", paths: [mediaPath], sourceVersion });
    const saved = await service.screenAndSave(draft.sessionId, randomUUID(), screening({
      decision: "include", categories: ["rights"], reason: "有关工作安排",
      anchors: [], coverage: "complete", policyVersion: "test-v1"
    }));
    if (saved.kind !== "saved") throw new Error("expected saved record");
    const assetId = service.getRecord(saved.recordId).attachments[0]!.id;
    await service.runAnalysis(saved.recordId, 1, {
      async analyze() {
        return {
          content: {
            summary: "工作材料摘要", time: { source: "ai" }, location: { source: "ai" }, people: [],
            chronology: [], mediaSegments: [{ id: randomUUID(), description, anchor: {
              sourceVersion, assetId, intervalMs: [1_000, 2_000]
            } }],
            unknowns: [], disputes: [], suggestions: [], legalIssues: [], citations: [], coverageNotes: []
          }, state: "complete", promptVersion: `test-${kind}-report`, modelProfile: `test:${kind}`
        };
      }
    });
    expect(service.search({ text: description }).hits[0]?.record.id).toBe(saved.recordId);
    service.setSearchIndexEnabled(true);
    await service.rebuildSearchIndex();
    expect(service.getSearchIndexStatus().queryModalities).toEqual(["text", kind]);
    const query = await service.prepareSearchQuery({ paths: [mediaPath] });
    const tables = ["redesign_records", "redesign_sources", "redesign_pending_reviews", "assets", "redesign_search_embeddings"];
    const counts = () => tables.map((table) => database.prepare(`SELECT count(*) FROM ${table}`).pluck().get());
    const before = counts();
    const result = await service.executeSearchQuery(query.sessionId, { limit: 5 });
    expect(describe).toHaveBeenCalledOnce();
    expect(describe.mock.calls[0]?.[0]).toMatchObject([{ modality: kind, mimeType }]);
    expect(Buffer.from(describe.mock.calls[0]![0][0]!.bytes)).toEqual(bytes);
    expect(result.hits[0]?.record.id).toBe(saved.recordId);
    expect(result.hits[0]?.anchor).toMatchObject({ sourceVersion, assetId, intervalMs: [1_000, 2_000] });
    expect(result.capabilities.media).toBe("ready");
    expect(counts()).toEqual(before);
    expect(await readFile(mediaPath)).toEqual(bytes);
  });

  it.each(["unchanged", "changed", "cancelled"] as const)("streams a large media query without formal writes when %s", async (mode) => {
    let described = 0; let activeSessionId = ""; let abandon: () => void = () => {};
    const embedding: RecordEmbeddingPort = { identity: "test.streamed-description", version: 1, dimensions: 2,
      inputModalities: ["text"], async embed(inputs) { return inputs.map(() => new Float32Array([1, 0])); } };
    const describe = vi.fn(async () => { throw new Error("Large query must never use the buffering adapter"); });
    const mediaDescription: RecordMediaQueryDescriptionPort = { inputModalities: ["audio"], maxInputBytes: 7_000_000,
      supportsStreamingInput: true, describe,
      async describeStreamed(inputs, signal) {
        const source = inputs[0]!.source; const hash = createHash("sha256"); let size = 0;
        for await (const chunk of await source.open(signal)) {
          expect(chunk.length).toBeLessThanOrEqual(64 * 1024); hash.update(chunk); size += chunk.length;
          if (mode === "cancelled") abandon();
        }
        if (hash.digest("hex") !== source.sha256 || size !== source.byteSize) throw new AppError("SOURCE_UNAVAILABLE", "synthetic changed source");
        described++;
        return inputs.map(({ id }) => ({ id, text: "仅保留在本次内存的查询描述" }));
      }
    };
    const { database, directory, service, stored } = await context(embedding, mediaDescription);
    abandon = () => service.abandonSearchQuery(activeSessionId);
    const draft = await service.prepareDraft({ text: "正式合成记录" });
    const saved = await service.screenAndSave(draft.sessionId, randomUUID(), screening({ decision: "include", categories: ["rights"],
      reason: "合成权益事件", anchors: [], coverage: "complete", policyVersion: "test-v1" }));
    if (saved.kind !== "saved") throw new Error("Expected formal record");
    service.setSearchIndexEnabled(true); await service.rebuildSearchIndex();
    const bytes = Buffer.alloc(7_000_100); bytes.write("RIFF", 0); bytes.write("WAVE", 8);
    const audioPath = join(directory, "large-query.wav"); await writeFile(audioPath, bytes);
    const query = await service.prepareSearchQuery({ paths: [audioPath] }); activeSessionId = query.sessionId;
    const tables = ["redesign_records", "redesign_sources", "redesign_pending_reviews", "assets", "redesign_search_embeddings", "jobs"];
    const counts = () => tables.map((table) => database.prepare(`SELECT count(*) FROM ${table}`).pluck().get());
    const before = counts(); const beforeStored = stored.size;
    if (mode === "changed") { bytes[bytes.length - 1] = 1; await writeFile(audioPath, bytes); }
    const result = service.executeSearchQuery(query.sessionId, { limit: 5 });
    if (mode === "unchanged") {
      const page = await result; expect(page.hits[0]?.record.id).toBe(saved.recordId);
      expect(page.hits[0]?.matches?.[0]?.explanation).toContain("音视频模型描述匹配");
      expect(described).toBe(1);
    } else { await expect(result).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" }); expect(described).toBe(0); }
    expect(describe).not.toHaveBeenCalled(); expect(counts()).toEqual(before); expect(stored.size).toBe(beforeStored);
    await expect(service.executeSearchQuery(query.sessionId, { limit: 5 })).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
  });

  it.each(["abandon", "clear", "replace", "record edit"] as const)("rejects a search result when %s happens during numeric worker processing", async (action) => {
    const embedding: RecordEmbeddingPort = { identity: "test.worker-query-cancellation", version: 1, dimensions: 2,
      inputModalities: ["text"], async embed(inputs) { return inputs.map(() => new Float32Array([1, 0])); } };
    const { first, second, service, activate, assertUnchanged } = await searchWorkspacePair(embedding);
    const query = await service.prepareSearchQuery({ text: "合成工作区隔离检索" });
    const workers: Worker[] = [], post = Worker.prototype.postMessage;
    const edits: Promise<unknown>[] = [];
    const spy = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (this: Worker, ...args) {
      workers.push(this); post.apply(this, args);
      if (action === "abandon") service.abandonSearchQuery(query.sessionId);
      else if (action === "clear") service.clearTransientSessions();
      else if (action === "replace") activate(second);
      else edits.push(service.patchFields(first.service.listTimeline({}).records[0]!.id, 1, { jurisdiction: "日本" }));
    });
    try {
      await expect(service.executeSearchQuery(query.sessionId, { limit: 1 })).rejects.toMatchObject({
        code: action === "record edit" ? "REVISION_CONFLICT" : "SOURCE_UNAVAILABLE"
      });
      expect(workers).toHaveLength(1); expect(workers[0]!.threadId).toBe(-1);
      await expect(service.executeSearchQuery(query.sessionId, { limit: 1 })).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
      if (action !== "record edit") assertUnchanged();
    } finally { spy.mockRestore(); await Promise.all(edits); }
  });

  it.each(["clear", "replace", "record edit"] as const)("rejects a search result when %s happens while its worker finishes cleanup", async (action) => {
    const embedding: RecordEmbeddingPort = { identity: "test.worker-cleanup-boundary", version: 1, dimensions: 2,
      inputModalities: ["text"], async embed(inputs) { return inputs.map(() => new Float32Array([1, 0])); } };
    const { first, second, service, activate, assertUnchanged } = await searchWorkspacePair(embedding);
    const query = await service.prepareSearchQuery({ text: "合成工作区隔离检索" });
    const workers: Worker[] = [], terminate = Worker.prototype.terminate;
    const edits: Promise<unknown>[] = [];
    const spy = vi.spyOn(Worker.prototype, "terminate").mockImplementation(function (this: Worker) {
      workers.push(this);
      return terminate.call(this).then((exitCode) => {
        if (action === "clear") service.clearTransientSessions();
        else if (action === "replace") activate(second);
        else edits.push(service.patchFields(first.service.listTimeline({}).records[0]!.id, 1, { jurisdiction: "日本" }));
        return exitCode;
      });
    });
    try {
      await expect(service.executeSearchQuery(query.sessionId, { limit: 1 })).rejects.toMatchObject({
        code: action === "record edit" ? "REVISION_CONFLICT" : "SOURCE_UNAVAILABLE"
      });
      expect(workers).toHaveLength(1); expect(workers[0]!.threadId).toBe(-1);
      await expect(service.executeSearchQuery(query.sessionId, { limit: 1 })).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
      if (action !== "record edit") assertUnchanged();
    } finally { spy.mockRestore(); await Promise.all(edits); }
  });

  it("does not publish keyword fallback or keep the query when numeric-worker cleanup fails", async () => {
    const embedding: RecordEmbeddingPort = { identity: "test.worker-cleanup-failure", version: 1, dimensions: 2,
      inputModalities: ["text"], async embed(inputs) { return inputs.map(() => new Float32Array([1, 0])); } };
    const { service, assertUnchanged } = await searchWorkspacePair(embedding);
    const query = await service.prepareSearchQuery({ text: "合成工作区隔离检索" });
    const workers: Worker[] = [], terminate = Worker.prototype.terminate;
    const spy = vi.spyOn(Worker.prototype, "terminate").mockImplementation(function (this: Worker) {
      workers.push(this);
      return terminate.call(this).then(() => { throw new Error("SYNTHETIC_PRIVATE_CLEANUP_DIAGNOSTIC"); });
    });
    try {
      await expect(service.executeSearchQuery(query.sessionId, { limit: 1 })).rejects.toMatchObject({
        code: "EMBEDDING_UNAVAILABLE", message: "本地语义计算未完成，请重新搜索。"
      });
      expect(workers).toHaveLength(1); expect(workers[0]!.threadId).toBe(-1);
      await expect(service.executeSearchQuery(query.sessionId, { limit: 1 })).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
      assertUnchanged();
    } finally { spy.mockRestore(); }
  });

  it.each(["text", "image"] as const)("rejects a %s query prepared across a workspace replacement", async (kind) => {
    const { first, second, service, activate, assertUnchanged } = await searchWorkspacePair();
    const requestId = randomUUID();
    const pending = service.prepareSearchQuery({ requestId, text: "合成工作区隔离检索",
      ...(kind === "image" ? { paths: [first.path] } : {}) });
    const rejected = expect(pending).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    activate(second); await rejected;
    const sessions = (service as unknown as { searchSessions: Map<string, unknown> }).searchSessions;
    expect(sessions.size).toBe(0);
    const fresh = await service.prepareSearchQuery({ requestId, text: "合成工作区隔离检索" });
    expect((await service.executeSearchQuery(fresh.sessionId, {})).hits.map(({ record }) => record.id))
      .toEqual(second.service.listTimeline({}).records.map(({ id }) => id));
    assertUnchanged();
  });

  it("rejects an old prepared keyword query before reading the replacement workspace", async () => {
    const { first, second, service, activate, assertUnchanged } = await searchWorkspacePair();
    const query = await service.prepareSearchQuery({ text: "合成工作区隔离检索" });
    const oldSearch = vi.spyOn(first.records, "search"), newSearch = vi.spyOn(second.records, "search");
    activate(second);
    await expect(service.executeSearchQuery(query.sessionId, {})).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    expect(oldSearch).not.toHaveBeenCalled(); expect(newSearch).not.toHaveBeenCalled();
    activate(first);
    await expect(service.executeSearchQuery(query.sessionId, {})).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    assertUnchanged();
  });

  it("rejects an old prepared media query before uploading it in the replacement workspace", async () => {
    const embed = vi.fn(async (inputs: Parameters<RecordEmbeddingPort["embed"]>[0]) =>
      inputs.map(() => new Float32Array([1, 0])));
    const embedding: RecordEmbeddingPort = { identity: "test.query-owner-before-upload", version: 1, dimensions: 2,
      inputModalities: ["text", "image"], embed };
    const { first, second, service, activate, assertUnchanged } = await searchWorkspacePair(embedding);
    const query = await service.prepareSearchQuery({ paths: [first.path] }); embed.mockClear();
    activate(second);
    await expect(service.executeSearchQuery(query.sessionId, {})).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    expect(embed).not.toHaveBeenCalled(); assertUnchanged();
  });

  it.each(["success", "outage"] as const)("discards a late search embedding %s after its workspace changes without local fallback", async (outcome) => {
    let delayQuery = false, entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const embed = vi.fn(async (inputs: Parameters<RecordEmbeddingPort["embed"]>[0]) => {
      if (delayQuery) {
        entered(); await new Promise<void>((resolve) => { release = resolve; });
        if (outcome === "outage") throw new Error("Synthetic old query network outage.");
      }
      return inputs.map(() => new Float32Array([1, 0]));
    });
    const embedding: RecordEmbeddingPort = { identity: "test.query-owner-late-embedding", version: 1, dimensions: 2,
      inputModalities: ["text"], embed };
    const { first, second, service, activate, assertUnchanged } = await searchWorkspacePair(embedding);
    const query = await service.prepareSearchQuery({ text: "合成工作区隔离检索" }); delayQuery = true; embed.mockClear();
    const pending = service.executeSearchQuery(query.sessionId, { limit: 1 });
    const rejected = expect(pending).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    await started;
    const oldSearch = vi.spyOn(first.records, "search"), newSearch = vi.spyOn(second.records, "search");
    activate(second); release(); await rejected;
    expect(embed).toHaveBeenCalledOnce(); expect(oldSearch).not.toHaveBeenCalled(); expect(newSearch).not.toHaveBeenCalled();
    activate(first);
    await expect(service.executeSearchQuery(query.sessionId, { limit: 1 })).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    assertUnchanged();
  });

  it.each(["audio", "video"] as const)("does not embed a late %s description after its search workspace changes", async (kind) => {
    let entered!: () => void, release!: () => void, requestSignal: AbortSignal | undefined;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const embed = vi.fn(async (inputs: Parameters<RecordEmbeddingPort["embed"]>[0]) =>
      inputs.map(() => new Float32Array([1, 0])));
    const embedding: RecordEmbeddingPort = { identity: "test.query-owner-late-description", version: 1, dimensions: 2,
      inputModalities: ["text"], embed };
    const description: RecordMediaQueryDescriptionPort = { inputModalities: [kind], maxInputBytes: 1024,
      async describe(inputs, signal) {
        requestSignal = signal; entered(); await new Promise<void>((resolve) => { release = resolve; });
        return inputs.map(({ id }) => ({ id, text: "合成仅属于原工作区的临时描述" }));
      } };
    const { first, second, service, activate, assertUnchanged } = await searchWorkspacePair(embedding, description);
    const bytes = kind === "audio" ? Buffer.from("ID3synthetic-owner-audio")
      : Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(12)]);
    const path = join(first.directory, kind === "audio" ? "owner-query.mp3" : "owner-query.mp4");
    await writeFile(path, bytes);
    const query = await service.prepareSearchQuery({ paths: [path] }); embed.mockClear();
    const pending = service.executeSearchQuery(query.sessionId, {});
    const rejected = expect(pending).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    await started; activate(second); release(); await rejected;
    expect(requestSignal?.aborted).toBe(true); expect(embed).not.toHaveBeenCalled();
    expect(await readFile(path)).toEqual(bytes); assertUnchanged();
  });

  it.each(["stream open", "progress"] as const)("rejects late streamed-query %s after its workspace changes", async (boundary) => {
    let entered!: () => void, release!: () => void, requestSignal: AbortSignal | undefined;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const embed = vi.fn(async (inputs: Parameters<RecordEmbeddingPort["embed"]>[0]) =>
      inputs.map(() => new Float32Array([1, 0])));
    const embedding: RecordEmbeddingPort = { identity: "test.query-owner-stream", version: 1, dimensions: 2,
      inputModalities: ["text"], embed };
    const describe = vi.fn(async () => { throw new Error("Synthetic streaming fixture cannot use buffered description."); });
    const description: RecordMediaQueryDescriptionPort = { inputModalities: ["audio"], maxInputBytes: 16,
      supportsStreamingInput: true, describe,
      async describeStreamed(inputs, signal, onProgress) {
        requestSignal = signal; entered(); await new Promise<void>((resolve) => { release = resolve; });
        if (boundary === "stream open") await inputs[0]!.source.open(signal);
        else onProgress?.({ mediaId: inputs[0]!.id, mediaNumber: 1, mediaCount: 1, stage: "understanding",
          segmentNumber: 1, checkedDurationMs: 0, sourceDurationMs: 1000 });
        return inputs.map(({ id }) => ({ id, text: "合成跨工作区迟到流式描述" }));
      } };
    const { first, second, service, activate, assertUnchanged } = await searchWorkspacePair(embedding, description);
    const bytes = Buffer.from("ID3synthetic-owner-streamed-audio-query");
    const path = join(first.directory, "owner-stream-query.mp3"); await writeFile(path, bytes);
    const query = await service.prepareSearchQuery({ paths: [path] }); embed.mockClear();
    const progress = vi.fn(), pending = service.executeSearchQuery(query.sessionId, {}, progress);
    const rejected = expect(pending).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    await started; activate(second); release(); await rejected;
    expect(requestSignal?.aborted).toBe(true); expect(embed).not.toHaveBeenCalled();
    expect(describe).not.toHaveBeenCalled(); expect(progress).not.toHaveBeenCalled();
    expect(await readFile(path)).toEqual(bytes); assertUnchanged();
  });

  it.each(["replace", "lock"] as const)("revokes cached semantic pages on workspace %s and does not revive them on return", async (action) => {
    const embed = vi.fn(async (inputs: Parameters<RecordEmbeddingPort["embed"]>[0]) =>
      inputs.map(() => new Float32Array([1, 0])));
    const embedding: RecordEmbeddingPort = { identity: "test.query-owner-cached-page", version: 1, dimensions: 2,
      inputModalities: ["text"], embed };
    const { first, second, service, activate, assertUnchanged } = await searchWorkspacePair(embedding);
    const query = await service.prepareSearchQuery({ text: "合成工作区隔离检索" }); embed.mockClear();
    const page = await service.executeSearchQuery(query.sessionId, { limit: 1 });
    expect(page.hits).toHaveLength(1); expect(page.nextCursor).toBeTypeOf("string");
    if (!page.nextCursor) throw new Error("Expected synthetic workspace-isolation cursor.");
    const retained = (service as unknown as { searchSessions: Map<string, { result?: unknown }> }).searchSessions.get(query.sessionId);
    expect(retained?.result).toBeDefined();
    const oldProjection = vi.spyOn(first.records, "getSearchProjectionVersion"), newSearch = vi.spyOn(second.records, "search");
    activate(action === "replace" ? second : undefined);
    await expect(service.executeSearchQuery(query.sessionId, { limit: 1, cursor: page.nextCursor }))
      .rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    expect(retained?.result).toBeUndefined(); expect(oldProjection).not.toHaveBeenCalled(); expect(newSearch).not.toHaveBeenCalled();
    activate(first);
    await expect(service.executeSearchQuery(query.sessionId, { limit: 1, cursor: page.nextCursor }))
      .rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    expect(embed).toHaveBeenCalledOnce(); assertUnchanged();
  });

  it.each(["abandon", "workspace lock"] as const)("cancels an in-flight search embedding on %s without keyword fallback", async (action) => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let blockQuery = false;
    let requestSignal: AbortSignal | undefined;
    const embedding: RecordEmbeddingPort = {
      identity: "test.cancelled-query", version: 1, dimensions: 2, inputModalities: ["text"],
      async embed(inputs, signal) {
        if (!blockQuery) return inputs.map(() => new Float32Array([1, 0]));
        if (!signal) throw new Error("query embedding requires a cancellation signal");
        requestSignal = signal;
        entered();
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
    };
    const { database, service } = await context(embedding);
    const draft = await service.prepareDraft({ text: "合成搜索关键词" });
    expect((await service.screenAndSave(draft.sessionId, randomUUID(), screening({
      decision: "include", categories: ["rights"], reason: "取消搜索测试", anchors: [],
      coverage: "complete", policyVersion: "test-v1"
    }))).kind).toBe("saved");
    service.setSearchIndexEnabled(true);
    await service.rebuildSearchIndex();
    blockQuery = true;
    const query = await service.prepareSearchQuery({ text: "合成搜索关键词" });
    const pending = service.executeSearchQuery(query.sessionId, { limit: 5 });
    await started;
    if (action === "abandon") service.abandonSearchQuery(query.sessionId);
    else service.clearTransientSessions();
    expect(requestSignal?.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    await expect(service.executeSearchQuery(query.sessionId, { limit: 5 }))
      .rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    expect(database.prepare("SELECT count(*) FROM redesign_records").pluck().get()).toBe(1);
  });

  it.each(["abandon", "workspace lock"] as const)("stops local query preparation on %s before creating a session", async (action) => {
    const { database, path, service } = await context();
    const requestId = randomUUID();
    const pending = service.prepareSearchQuery({ paths: [path], requestId });
    const duplicate = service.prepareSearchQuery({ paths: [path], requestId });
    if (action === "abandon") service.abandonSearchPreparation(requestId);
    else service.clearTransientSessions();
    await expect(duplicate).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(pending).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    expect(database.prepare("SELECT count(*) FROM redesign_records").pluck().get()).toBe(0);
    expect(database.prepare("SELECT count(*) FROM redesign_search_embeddings").pluck().get()).toBe(0);
    const next = await service.prepareSearchQuery({ paths: [path], requestId });
    expect(next.attachments).toHaveLength(1);
    service.abandonSearchQuery(next.sessionId);
  });

  it("cancels an in-flight audio description when its search session is abandoned", async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let requestSignal: AbortSignal | undefined;
    const embedding: RecordEmbeddingPort = {
      identity: "test.cancelled-audio-query", version: 1, dimensions: 2, inputModalities: ["text"],
      async embed(inputs) { return inputs.map(() => new Float32Array([1, 0])); }
    };
    const mediaDescription: RecordMediaQueryDescriptionPort = {
      inputModalities: ["audio"], maxInputBytes: 7_000_000,
      async describe(_inputs, signal) {
        requestSignal = signal;
        entered();
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
    };
    const { directory, service } = await context(embedding, mediaDescription);
    const draft = await service.prepareDraft({ text: "合成音频记录" });
    expect((await service.screenAndSave(draft.sessionId, randomUUID(), screening({
      decision: "include", categories: ["rights"], reason: "取消音频查询测试", anchors: [],
      coverage: "complete", policyVersion: "test-v1"
    }))).kind).toBe("saved");
    service.setSearchIndexEnabled(true);
    await service.rebuildSearchIndex();
    const audioPath = join(directory, "cancel-query.mp3");
    await writeFile(audioPath, Buffer.from("ID3synthetic-audio-query"));
    const query = await service.prepareSearchQuery({ paths: [audioPath] });
    const pending = service.executeSearchQuery(query.sessionId, { limit: 5 });
    await started;
    service.abandonSearchQuery(query.sessionId);
    expect(requestSignal?.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
  });

  it.each([
    {
      kind: "image" as const, extension: "png", mimeType: "image/png",
      bytes: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lV8AAAAASUVORK5CYII=",
        "base64"
      )
    },
    {
      kind: "audio" as const, extension: "mp3", mimeType: "audio/mpeg",
      bytes: Buffer.from("ID3synthetic-audio-evidence")
    },
    {
      kind: "video" as const, extension: "mp4", mimeType: "video/mp4",
      bytes: Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(12)])
    }
  ])("takes a synthetic pure $kind input through screening, retention, and an anchored report", async ({
    kind, extension, mimeType, bytes
  }) => {
    const { database, directory, service, stored } = await context();
    const mediaPath = join(directory, `synthetic.${extension}`);
    await writeFile(mediaPath, bytes);
    const skippedDraft = await service.prepareDraft({ paths: [mediaPath], sourceVersion: `${kind}-ordinary-v1` });
    expect(skippedDraft.attachments).toMatchObject([{ kind, mimeType }]);
    const skipped = await service.screenAndSave(skippedDraft.sessionId, randomUUID(), {
      async screen(input) {
        expect(input.text).toBe("");
        expect(input.media[0]?.screenedSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
        return {
          decision: "skip", categories: [], reason: "合成普通日常", coverage: "complete",
          anchors: [{ sourceVersion: input.sourceVersion, temporaryMediaRef: input.media[0]!.id }],
          policyVersion: "test-media-v1"
        };
      }
    });
    expect(skipped).toEqual({ kind: "skipped", message: "不属于收录范围" });
    for (const table of [
      "redesign_records", "redesign_sources", "redesign_screening_results", "redesign_reports",
      "redesign_record_assets", "redesign_pending_reviews", "redesign_operations", "assets", "jobs"
    ]) {
      expect(database.prepare(`SELECT count(*) FROM ${table}`).pluck().get()).toBe(0);
    }
    expect(stored.size).toBe(0);

    const sourceVersion = `${kind}-relevant-v1`;
    const draft = await service.prepareDraft({ paths: [mediaPath], sourceVersion });
    const saved = await service.screenAndSave(draft.sessionId, randomUUID(), {
      async screen(input) {
        expect(input.media[0]).toMatchObject({ kind, mimeType, byteSize: bytes.length });
        expect(await readFile(input.media[0]!.path!)).toEqual(bytes);
        return {
          decision: "include", categories: ["rights"], reason: "合成媒体中有关权益的事实",
          anchors: [{ sourceVersion, temporaryMediaRef: input.media[0]!.id, intervalMs: [1_000, 2_000] as [number, number] }],
          coverage: "complete", policyVersion: "test-media-v1"
        };
      }
    });
    if (saved.kind !== "saved") throw new Error("expected saved record");
    const detail = service.getRecord(saved.recordId);
    expect(detail.record).toMatchObject({ reportState: "queued", attachmentCount: 1 });
    expect(detail.source).toMatchObject({ sourceVersion });
    expect(detail.source.text).toBeUndefined();
    expect(detail.attachments[0]).toMatchObject({ mimeType, byteSize: bytes.length });
    expect(stored.get(detail.attachments[0]!.sha256)).toEqual(bytes);
    expect(JSON.parse(String(database.prepare("SELECT anchors_json FROM redesign_screening_results").pluck().get())))
      .toEqual([{ sourceVersion, assetId: detail.attachments[0]!.id, intervalMs: [1_000, 2_000] }]);

    const analyzed = await service.runAnalysis(saved.recordId, 1, {
      async analyze(input) {
        expect(input.source.sourceVersion).toBe(sourceVersion);
        expect(input.attachments.map(({ id }) => id)).toEqual([detail.attachments[0]!.id]);
        return {
          content: {
            summary: "合成媒体事实摘要", time: { source: "ai" }, location: { source: "ai" }, people: [],
            chronology: [{ id: randomUUID(), text: "媒体中的具体事实", anchor: {
              sourceVersion, assetId: detail.attachments[0]!.id, intervalMs: [1_000, 2_000]
            } }],
            unknowns: [], disputes: [], suggestions: [], legalIssues: [], citations: [], coverageNotes: []
          }, state: "complete", promptVersion: "test-media-report", modelProfile: "test:synthetic-media"
        };
      }
    });
    expect(analyzed.record.reportState).toBe("complete");
    expect(analyzed.report?.content.chronology[0]?.anchor).toEqual({
      sourceVersion, assetId: detail.attachments[0]!.id, intervalMs: [1_000, 2_000]
    });
  });

  it("keeps the active search generation when a replacement build fails", async () => {
    let fail = false;
    const privateFailure = "private-media-filename-simulated-embedding-outage";
    const embedding: RecordEmbeddingPort = {
      identity: "test.generation", version: 1, dimensions: 2, inputModalities: ["text"],
      async embed(inputs) {
        if (fail) throw new Error(privateFailure);
        return inputs.map(() => new Float32Array([1, 0]));
      }
    };
    const { database, service } = await context(embedding);
    const draft = await service.prepareDraft({ text: "需要进入语义索引的权益事件" });
    await service.screenAndSave(draft.sessionId, randomUUID(), screening({
      decision: "include", categories: ["rights"], reason: "权益事件", anchors: [],
      coverage: "complete", policyVersion: "test-v1"
    }));
    service.setSearchIndexEnabled(true);
    const first = await service.rebuildSearchIndex();
    fail = true;
    await expect(service.rebuildSearchIndex()).rejects.toThrow(privateFailure);
    expect(service.getSearchIndexStatus()).toMatchObject({
      state: "ready", activeGenerationId: first.activeGenerationId, fragmentCount: 2,
      lastError: "INTERNAL_ERROR"
    });
    expect(database.serialize().includes(Buffer.from(privateFailure))).toBe(false);
    expect(database.prepare(
      "SELECT state, count(*) AS count FROM redesign_search_generations GROUP BY state ORDER BY state"
    ).all()).toEqual([{ state: "active", count: 1 }, { state: "failed", count: 1 }]);
    const failedGenerationId = String(database.prepare(
      "SELECT id FROM redesign_search_generations WHERE state = 'failed'"
    ).pluck().get());
    fail = false;
    const recovered = await service.rebuildSearchIndex(failedGenerationId);
    expect(recovered).toMatchObject({ state: "ready", activeGenerationId: failedGenerationId });
    expect(database.prepare(
      "SELECT state, count(*) AS count FROM redesign_search_generations GROUP BY state ORDER BY state"
    ).all()).toEqual([{ state: "active", count: 1 }, { state: "superseded", count: 1 }]);
  });

  it("queues a consented index build once and reuses an in-flight generation", async () => {
    const embedding: RecordEmbeddingPort = {
      identity: "test.background", version: 1, dimensions: 2, inputModalities: ["text"],
      async embed(inputs) { return inputs.map(() => new Float32Array([1, 0])); }
    };
    const { database, service } = await context(embedding);
    const first = service.requestSearchIndexRebuild();
    const repeated = service.requestSearchIndexRebuild();
    expect(first).toMatchObject({ state: "building", fragmentCount: 0 });
    expect(repeated).toMatchObject({ state: "building", fragmentCount: 0 });
    expect(database.prepare(
      "SELECT count(*) FROM jobs WHERE type = 'record.search-index-rebuild'"
    ).pluck().get()).toBe(1);
    expect(database.prepare(
      "SELECT count(*) FROM redesign_search_generations WHERE state = 'building'"
    ).pluck().get()).toBe(1);
    const paused = service.setSearchIndexEnabled(false);
    expect(paused.status).toMatchObject({ enabled: false, state: "paused" });
    expect(paused.jobIds).toHaveLength(1);
    expect(await service.ensureSearchIndexJob()).toBeUndefined();
    service.setSearchIndexEnabled(true);
    database.prepare(
      "UPDATE jobs SET state = 'running' WHERE type = 'record.search-index-rebuild'"
    ).run();
    expect(await service.ensureSearchIndexJob()).toBeTypeOf("string");
    expect(database.prepare(
      "SELECT count(*) FROM jobs WHERE type = 'record.search-index-rebuild'"
    ).pluck().get()).toBe(1);
  });

  it("paginates a semantic result session without embedding the query again", async () => {
    let embeddingCalls = 0;
    const embedding: RecordEmbeddingPort = {
      identity: "test.result-pagination", version: 1, dimensions: 2,
      normalization: "l2", inputModalities: ["text"],
      async embed(inputs) {
        embeddingCalls += 1;
        return inputs.map(() => new Float32Array([1, 0]));
      }
    };
    const { service, database } = await context(embedding);
    const recordIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const sourceVersion = `pagination-source-${index}`;
      const draft = await service.prepareDraft({ text: `语义分页记录 ${index}`, sourceVersion });
      const saved = await service.screenAndSave(draft.sessionId, randomUUID(), screening({
        decision: "include", categories: ["rights"], reason: "语义分页测试", anchors: [],
        coverage: "complete", policyVersion: "test-v1"
      }));
      if (saved.kind !== "saved") throw new Error("expected saved record");
      recordIds.push(saved.recordId);
    }
    service.setSearchIndexEnabled(true);
    const generationId = (await service.rebuildSearchIndex()).activeGenerationId!;
    const vectors = [new Float32Array([1, 0]), new Float32Array([0.8, 0.6]), new Float32Array([0.6, 0.8])];
    recordIds.forEach((recordId, index) => database.prepare(
      "UPDATE redesign_search_embeddings SET vector = ? WHERE generation_id = ? AND record_id = ?"
    ).run(Buffer.from(vectors[index]!.buffer), generationId, recordId));
    embeddingCalls = 0;

    const query = await service.prepareSearchQuery({ text: "查询词不命中本地全文索引" });
    const first = await service.executeSearchQuery(query.sessionId, { limit: 1 });
    expect(first.hits.map(({ record }) => record.id)).toEqual([recordIds[0]]);
    expect(first.nextCursor).toBeTypeOf("string");
    const retained = (service as unknown as { searchSessions: Map<string, { text: string }> })
      .searchSessions.get(query.sessionId);
    expect(retained?.text).toBe("");
    if (!first.nextCursor) throw new Error("expected first result cursor");
    const second = await service.executeSearchQuery(query.sessionId, { limit: 1, cursor: first.nextCursor });
    expect(second.hits.map(({ record }) => record.id)).toEqual([recordIds[1]]);
    expect(second.nextCursor).toBeTypeOf("string");
    if (!second.nextCursor) throw new Error("expected second result cursor");
    const third = await service.executeSearchQuery(query.sessionId, { limit: 1, cursor: second.nextCursor });
    expect(third.hits.map(({ record }) => record.id)).toEqual([recordIds[2]]);
    expect(third.nextCursor).toBeUndefined();
    expect(embeddingCalls).toBe(1);
    await expect(service.executeSearchQuery(query.sessionId, { limit: 1 }))
      .rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });

    const beforeFieldEdit = await service.prepareSearchQuery({ text: "查询词不命中本地全文索引" });
    const fieldPage = await service.executeSearchQuery(beforeFieldEdit.sessionId, { limit: 1 });
    if (!fieldPage.nextCursor) throw new Error("expected cursor before field edit");
    await service.patchFields(recordIds[1]!, 1, { jurisdiction: "日本" });
    await expect(service.executeSearchQuery(beforeFieldEdit.sessionId, {
      limit: 1, cursor: fieldPage.nextCursor
    })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });

    const beforeReportEdit = await service.prepareSearchQuery({ text: "查询词不命中本地全文索引" });
    const reportPage = await service.executeSearchQuery(beforeReportEdit.sessionId, { limit: 1 });
    if (!reportPage.nextCursor) throw new Error("expected cursor before report edit");
    await service.runAnalysis(recordIds[2]!, 1, {
      async analyze() {
        return {
          content: {
            summary: "同一修订的新报告", time: { source: "ai" }, location: { source: "ai" },
            people: [], chronology: [], unknowns: [], disputes: [], suggestions: [],
            legalIssues: [], citations: [], coverageNotes: []
          }, state: "complete", promptVersion: "pagination-report-v1", modelProfile: "test:model"
        };
      }
    });
    expect(service.getRecord(recordIds[2]!).record.revision).toBe(1);
    await expect(service.executeSearchQuery(beforeReportEdit.sessionId, {
      limit: 1, cursor: reportPage.nextCursor
    })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  });

  it("does not publish a semantic result or keyword fallback when records change during the query", async () => {
    let started!: () => void;
    let release!: (value: Float32Array[]) => void;
    const embeddingStarted = new Promise<void>((resolve) => { started = resolve; });
    let delayQuery = false;
    const embedding: RecordEmbeddingPort = {
      identity: "test.query-revision", version: 1, dimensions: 2, inputModalities: ["text"],
      async embed(inputs) {
        if (!delayQuery) return inputs.map(() => new Float32Array([1, 0]));
        started();
        return new Promise<Float32Array[]>((resolve) => { release = resolve; });
      }
    };
    const { service } = await context(embedding);
    const draft = await service.prepareDraft({ text: "合成语义记录", sourceVersion: "query-revision-v1" });
    const saved = await service.screenAndSave(draft.sessionId, randomUUID(), screening({
      decision: "include", categories: ["rights"], reason: "合成语义测试", anchors: [],
      coverage: "complete", policyVersion: "test-v1"
    }));
    if (saved.kind !== "saved") throw new Error("expected saved record");
    service.setSearchIndexEnabled(true);
    await service.rebuildSearchIndex(); delayQuery = true;

    const query = await service.prepareSearchQuery({ text: "查询词不命中本地全文索引" });
    const pending = service.executeSearchQuery(query.sessionId, { limit: 1 });
    await embeddingStarted;
    await service.patchFields(saved.recordId, 1, { jurisdiction: "日本" });
    release([new Float32Array([1, 0])]);
    await expect(pending).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await expect(service.executeSearchQuery(query.sessionId, { limit: 1 }))
      .rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
  });

  it("releases selected media paths and hashes after the first semantic result page", async () => {
    let queryCalls = 0;
    const embedding: RecordEmbeddingPort = {
      identity: "test.media-pagination-privacy", version: 1, dimensions: 2,
      normalization: "l2", inputModalities: ["text", "image"], maxInputBytes: 1024,
      async embed(inputs) {
        queryCalls += 1;
        return inputs.map(() => new Float32Array([1, 0]));
      }
    };
    const { database, path, service } = await context(embedding);
    for (let index = 0; index < 2; index += 1) {
      const sourceVersion = `media-pagination-${index}`;
      const draft = await service.prepareDraft({ text: `合成图片记录 ${index}`, paths: [path], sourceVersion });
      expect((await service.screenAndSave(draft.sessionId, randomUUID(), screening({
        decision: "include", categories: ["rights"], reason: "合成图片证据",
        anchors: [{ sourceVersion, temporaryMediaRef: draft.attachments[0]!.id }],
        coverage: "complete", policyVersion: "test-v1"
      }))).kind).toBe("saved");
    }
    service.setSearchIndexEnabled(true);
    await service.rebuildSearchIndex();
    const before = {
      records: database.prepare("SELECT count(*) FROM redesign_records").pluck().get(),
      embeddings: database.prepare("SELECT count(*) FROM redesign_search_embeddings").pluck().get()
    };
    const query = await service.prepareSearchQuery({ paths: [path] });
    const first = await service.executeSearchQuery(query.sessionId, { limit: 1 });
    expect(first.hits).toHaveLength(1);
    expect(first.nextCursor).toBeTypeOf("string");
    const retained = (service as unknown as {
      searchSessions: Map<string, { text: string; media: unknown[]; mediaHashes: Map<string, string> }>
    }).searchSessions.get(query.sessionId);
    expect(retained).toMatchObject({ text: "", media: [] });
    expect(retained?.mediaHashes.size).toBe(0);
    if (!first.nextCursor) throw new Error("expected media result cursor");
    const callsAfterFirstPage = queryCalls;
    const second = await service.executeSearchQuery(query.sessionId, { limit: 1, cursor: first.nextCursor });
    expect(second.hits).toHaveLength(1);
    expect(second.hits[0]?.record.id).not.toBe(first.hits[0]?.record.id);
    expect(second.nextCursor).toBeUndefined();
    expect(queryCalls).toBe(callsAfterFirstPage);
    expect({
      records: database.prepare("SELECT count(*) FROM redesign_records").pluck().get(),
      embeddings: database.prepare("SELECT count(*) FROM redesign_search_embeddings").pluck().get()
    }).toEqual(before);
  });

  it("falls back to paginated local keyword results when query embedding fails, but rejects media queries", async () => {
    let fail = false;
    const embedding: RecordEmbeddingPort = {
      identity: "test.query-outage", version: 1, dimensions: 2,
      inputModalities: ["text", "image"],
      async embed(inputs) {
        if (fail) throw new Error("simulated query embedding outage");
        return inputs.map(() => new Float32Array([1, 0]));
      }
    };
    const { path, service } = await context(embedding);
    for (let index = 0; index < 3; index += 1) {
      const draft = await service.prepareDraft({
        text: `合成薪酬凭证 ${index}`, sourceVersion: `query-outage-${index}`
      });
      expect((await service.screenAndSave(draft.sessionId, randomUUID(), screening({
        decision: "include", categories: ["rights"], reason: "合成薪酬测试", anchors: [],
        coverage: "complete", policyVersion: "test-v1"
      }))).kind).toBe("saved");
    }
    service.setSearchIndexEnabled(true);
    await service.rebuildSearchIndex();
    fail = true;

    const query = await service.prepareSearchQuery({ text: "合成薪酬凭证" });
    const first = await service.executeSearchQuery(query.sessionId, { limit: 1 });
    expect(first.hits).toHaveLength(1);
    expect(first.nextCursor).toBeTypeOf("string");
    expect(first.capabilities).toEqual({ keyword: "ready", semantic: "unavailable", media: "unavailable" });
    if (!first.nextCursor) throw new Error("expected keyword fallback cursor");
    const second = service.search({ text: "合成薪酬凭证", cursor: first.nextCursor, limit: 1 });
    expect(second.hits).toHaveLength(1);
    expect(second.hits[0]?.record.id).not.toBe(first.hits[0]?.record.id);

    const noKeywordMatch = await service.prepareSearchQuery({ text: "完全不匹配的合成查询" });
    const emptyFallback = await service.executeSearchQuery(noKeywordMatch.sessionId, { limit: 1 });
    expect(emptyFallback.hits).toEqual([]);
    expect(emptyFallback.capabilities.semantic).toBe("unavailable");

    const mediaQuery = await service.prepareSearchQuery({ paths: [path] });
    await expect(service.executeSearchQuery(mediaQuery.sessionId, { limit: 1 }))
      .rejects.toMatchObject({ code: "EMBEDDING_UNAVAILABLE", retryable: true });
    await expect(service.executeSearchQuery(mediaQuery.sessionId, { limit: 1 }))
      .rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
  });

  it("preserves keyword results when an active vector index contains corrupt bytes", async () => {
    const embedding: RecordEmbeddingPort = {
      identity: "test.corrupt-query-vector", version: 1, dimensions: 2,
      inputModalities: ["text"],
      async embed(inputs) { return inputs.map(() => new Float32Array([1, 0])); }
    };
    const { database, service } = await context(embedding);
    const draft = await service.prepareDraft({ text: "合成的本地关键词凭证", sourceVersion: "corrupt-vector-v1" });
    expect((await service.screenAndSave(draft.sessionId, randomUUID(), screening({
      decision: "include", categories: ["rights"], reason: "合成索引测试", anchors: [],
      coverage: "complete", policyVersion: "test-v1"
    }))).kind).toBe("saved");
    service.setSearchIndexEnabled(true);
    await service.rebuildSearchIndex();
    for (const corruptVector of [
      Buffer.from([1]), Buffer.alloc(4), Buffer.from("0000c07f0000803f", "hex")
    ]) {
      database.prepare("UPDATE redesign_search_embeddings SET vector = ?").run(corruptVector);
      const query = await service.prepareSearchQuery({ text: "本地关键词凭证" });
      const result = await service.executeSearchQuery(query.sessionId, { limit: 5 });
      expect(result.hits).toHaveLength(1);
      expect(result.capabilities).toEqual({ keyword: "ready", semantic: "unavailable", media: "unavailable" });
    }
  });

  it("scans semantic embeddings beyond the first 512-fragment storage page", async () => {
    const embedding: RecordEmbeddingPort = {
      identity: "test.paged-scan", version: 1, dimensions: 2, inputModalities: ["text"],
      async embed(inputs) { return inputs.map(() => new Float32Array([1, 0])); }
    };
    const { records, service, database } = await context(embedding);
    for (let index = 0; index < 257; index++) {
      const draft = await service.prepareDraft({ text: `分页扫描目标记录 ${index}`, sourceVersion: `paged-v1-${index}` });
      expect((await service.screenAndSave(draft.sessionId, randomUUID(), screening({
        decision: "include", categories: ["rights"], reason: "分页测试", anchors: [],
        coverage: "complete", policyVersion: "test-v1"
      }))).kind).toBe("saved");
    }
    service.setSearchIndexEnabled(true);
    const generationId = (await service.rebuildSearchIndex()).activeGenerationId!;
    const fragments = records.listSearchEmbeddings(generationId);
    expect(fragments).toHaveLength(514);
    const target = fragments.at(-1)!.fragment;
    database.prepare("UPDATE redesign_search_embeddings SET vector = ? WHERE generation_id = ?")
      .run(Buffer.from(new Float32Array([0, 1]).buffer), generationId);
    database.prepare("UPDATE redesign_search_embeddings SET vector = ? WHERE generation_id = ? AND fragment_id = ?")
      .run(Buffer.from(new Float32Array([1, 0]).buffer), generationId, target.id);

    const query = await service.prepareSearchQuery({ text: "只匹配末页向量" });
    const result = await service.executeSearchQuery(query.sessionId, { limit: 5 });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({
      record: { id: target.recordId }, anchor: target.anchor
    });
  });

  it("keeps keyword and combined search anchors in original coordinates after casing expansion", async () => {
    const embedding: RecordEmbeddingPort = { identity: "test.casing", version: 1, dimensions: 2, inputModalities: ["text"],
      async embed(inputs) { return inputs.map(() => new Float32Array([1, 0])); } };
    const { service } = await context(embedding);
    const text = "İ😀合成目标奖金争议";
    const draft = await service.prepareDraft({ text, sourceVersion: "casing-v1" });
    const saved = await service.screenAndSave(draft.sessionId, randomUUID(), screening({
      decision: "include", categories: ["rights"], reason: "合成定位回归", anchors: [], coverage: "complete", policyVersion: "test-v1"
    }));
    if (saved.kind !== "saved") throw new Error("expected synthetic saved record");
    expect(service.search({ text: "目标" }).hits[0]?.anchor).toMatchObject({ sourceVersion: "casing-v1", textRange: [4, 6] });
    service.setSearchIndexEnabled(true); await service.rebuildSearchIndex();
    const query = await service.prepareSearchQuery({ text: "目标" });
    const combined = await service.executeSearchQuery(query.sessionId, { limit: 5 });
    expect(combined.hits[0]?.anchor).toMatchObject({ sourceVersion: "casing-v1", textRange: [4, 6] });
    expect(service.getRecord(saved.recordId).source.text).toBe(text);
  });

  it("chunks long source text and returns a code-point anchor for the matching fragment", async () => {
    const embedding: RecordEmbeddingPort = {
      identity: "test.chunks", version: 1, dimensions: 2, inputModalities: ["text"],
      async embed(inputs) {
        return inputs.map((input) => input.text?.includes("关键尾段")
          ? new Float32Array([1, 0]) : new Float32Array([0, 1]));
      }
    };
    const { service } = await context(embedding);
    const text = `${"甲".repeat(6_500)}关键尾段`;
    const draft = await service.prepareDraft({ text, sourceVersion: "long-source-v1" });
    const saved = await service.screenAndSave(draft.sessionId, randomUUID(), screening({
      decision: "include", categories: ["grudge"], reason: "长文本事件", anchors: [],
      coverage: "complete", policyVersion: "test-v1"
    }));
    if (saved.kind !== "saved") throw new Error("expected saved record");
    service.setSearchIndexEnabled(true);
    expect(await service.rebuildSearchIndex()).toMatchObject({ fragmentCount: 3 });
    const query = await service.prepareSearchQuery({ text: "关键尾段" });
    const result = await service.executeSearchQuery(query.sessionId, { limit: 5 });
    expect(result.hits[0]).toMatchObject({
      record: { id: saved.recordId }, anchor: { sourceVersion: "long-source-v1", textRange: [6_500, 6_504] }
    });
    expect(result.hits[0]?.matches).toHaveLength(2);
  });
});
