import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runMigrations, SqliteAssetRepository, SqliteJobRepository, SqliteRecordRepository } from "@grudge-vault/persistence-sqlite";
import { AppError } from "@grudge-vault/shared";
import { JobRunner, RedesignService, type NativeImageConversionPort, type ObjectVaultPort, type RecordEmbeddingPort, type RedesignSession } from "./index";

function gate() {
  let begin!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => { begin = resolve; });
  const done = new Promise<void>((resolve) => { release = resolve; });
  return { started, done, begin, release };
}

describe("search index publication lifecycle", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { vi.restoreAllMocks(); while (cleanups.length) await cleanups.pop()!(); });

  async function fixture(options: { media?: "png" | "heic" | "wav"; converter?: NativeImageConversionPort; batchSize?: number; disk?: boolean;
    beginModelOperation?: () => (() => void) } = {}) {
    const directory = await mkdtemp(join(tmpdir(), "grudge-vault-index-lifecycle-"));
    const database = new Database(options.disk ? join(directory, "synthetic.sqlite3") : ":memory:");
    database.pragma("foreign_keys = ON"); if (options.disk) database.pragma("journal_mode = WAL"); runMigrations(database);
    cleanups.push(async () => { if (database.open) database.close(); await rm(directory, { recursive: true, force: true }); });
    const records = new SqliteRecordRepository(database, () => Buffer.alloc(32));
    const jobs = new SqliteJobRepository(database), assets = new SqliteAssetRepository(database);
    const stored = new Map<string, Buffer>();
    const putBytes = (bytes: Buffer) => {
      const sha256 = createHash("sha256").update(bytes).digest("hex"), deduplicated = stored.has(sha256);
      stored.set(sha256, bytes); return { sha256, byteSize: bytes.length, vaultFormat: 2, deduplicated };
    };
    const vault: ObjectVaultPort = {
      async put(path) { return putBytes(await readFile(path)); },
      async putStream(stream) {
        const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
        return putBytes(Buffer.concat(chunks));
      },
      async open(sha256) { return Readable.from([stored.get(sha256)!]); },
      async verify() { return true; }, async exists(hash) { return stored.has(hash); },
      async remove(hash) { stored.delete(hash); }, async cleanupTempFiles() {}
    };
    let current: RedesignSession | undefined = { records, jobs, assets, vault, key: Buffer.alloc(32) };
    let delayed: ReturnType<typeof gate> | undefined, configured = true, receivedSignal: AbortSignal | undefined;
    const embedding: RecordEmbeddingPort = { identity: "synthetic:lifecycle", version: 1, dimensions: 2,
      inputModalities: options.media && options.media !== "wav" ? ["image"] : ["text"], ...(options.batchSize === undefined ? {} : { maxBatchSize: options.batchSize }),
      isConfigured: () => configured, async embed(inputs, signal) {
        receivedSignal = signal;
        if (delayed) { delayed.begin(); await delayed.done; }
        // Deliberately ignore cancellation: the application must reject late responses itself.
        return inputs.map(() => new Float32Array([1, 0]));
      } };
    const service = new RedesignService(() => {
      if (!current) throw new AppError("WORKSPACE_LOCKED", "Synthetic workspace is closed");
      return { ...current };
    }, embedding, undefined, undefined, options.converter, options.beginModelOperation);
    const seed = async (text = "合成薪酬争议，需要整理凭证", paths: string[] = []) => {
      const draft = await service.prepareDraft({ text, paths });
      const result = await service.screenAndSave(draft.sessionId, randomUUID(), { async screen(input) {
        return { decision: "include", categories: ["rights"], reason: "合成权益用例", coverage: "complete", policyVersion: "synthetic-index-v1",
          anchors: input.media.map(({ id }) => ({ sourceVersion: input.sourceVersion, temporaryMediaRef: id })) };
      } });
      if (result.kind !== "saved") throw new Error("Expected synthetic record");
      return result.recordId;
    };
    const paths: string[] = [];
    if (options.media) {
      const bytes = Buffer.alloc(options.media === "wav" ? 16_044 : 64);
      if (options.media === "wav") {
        bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVE", 8);
        bytes.write("fmt ", 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
        bytes.writeUInt32LE(8_000, 24); bytes.writeUInt32LE(16_000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
        bytes.write("data", 36); bytes.writeUInt32LE(16_000, 40);
      } else if (options.media === "heic") { bytes.write("ftyp", 4); bytes.write("heic", 8); }
      else Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
      const path = join(directory, `synthetic-private-image.${options.media}`);
      await writeFile(path, bytes); paths.push(path);
    }
    const recordId = await seed(undefined, paths); service.setSearchIndexEnabled(true);
    const first = await service.rebuildSearchIndex();
    const originalId = first.activeGenerationId!;
    const writes = vi.spyOn(records, "putSearchEmbedding"), activates = vi.spyOn(records, "activateSearchGeneration"), fails = vi.spyOn(records, "failSearchGeneration");
    const delay = () => { delayed = gate(); return delayed; };
    const restart = async (id: string) => {
      delayed = undefined; configured = true; service.setSearchIndexEnabled(true);
      for (const job of jobs.list()) if (job.type === "record.search-index-rebuild" && job.state === "queued") jobs.cancel(job.id, new Date().toISOString());
      return service.rebuildSearchIndex(id);
    };
    return { database, directory, records, assets, jobs, vault, stored, embedding, service, recordId, originalId, writes, activates, fails, delay, seed, restart,
      setCurrent(session: RedesignSession) { current = session; },
      closeWorkspace() { service.clearTransientSessions(); current = undefined; database.close(); },
      get receivedSignal() { return receivedSignal; }, setConfigured(value: boolean) { configured = value; } };
  }

  async function buildQueuedProjection(test: Awaited<ReturnType<typeof fixture>>) {
    const generation = test.records.listSearchGenerations().find(({ state }) => state === "building");
    if (!generation) throw new Error("Expected synthetic pending projection");
    await test.service.rebuildSearchIndex(generation.id);
    for (const job of test.jobs.list()) if (job.type === "record.search-index-rebuild" && job.state === "queued") {
      test.jobs.cancel(job.id, new Date().toISOString());
    }
  }

  function seedFormalCorpus(test: Awaited<ReturnType<typeof fixture>>, count = 512) {
    const stamp = "2026-09-30T00:00:00Z";
    const record = test.database.prepare(`INSERT INTO redesign_records(id, origin, categories_json, title, summary, revision,
      occurred_at_json, recorded_at, report_state, created_at, updated_at)
      VALUES (?, 'manual', '["rights"]', '合成索引分批记录', '', 1, '{"kind":"unknown"}', ?, 'queued', ?, ?)`);
    const source = test.database.prepare(`INSERT INTO redesign_sources(id, record_id, origin, source_version, content_hash,
      text, recorded_at, created_at) VALUES (?, ?, 'manual', 'synthetic-batch-v1', ?, '合成分批索引材料', ?, ?)`);
    test.database.transaction(() => {
      for (let index = 0; index < count; index++) {
        const id = `synthetic-index-batch-${String(index).padStart(4, "0")}`;
        record.run(id, stamp, stamp, stamp);
        source.run(`${id}-source`, id, "b".repeat(64), stamp, stamp);
      }
    })();
  }

  it("holds the writer lock before persisting any row from a model response", async () => {
    const test = await fixture({ disk: true });
    const put = SqliteRecordRepository.prototype.putSearchEmbedding.bind(test.records);
    test.writes.mockImplementation((...args) => { expect(test.database.inTransaction).toBe(true); put(...args); });
    expect((await test.service.rebuildSearchIndex()).fragmentCount).toBe(2);
    expect(test.writes).toHaveBeenCalledTimes(2); expect(test.database.inTransaction).toBe(false);
  });

  it("commits each normalized model response in one bounded transaction, including the final short batch", async () => {
    const test = await fixture({ disk: true, batchSize: 16 }); seedFormalCorpus(test, 33);
    const put = SqliteRecordRepository.prototype.putSearchEmbedding.bind(test.records);
    test.writes.mockImplementation((...args) => { expect(test.database.inTransaction).toBe(true); put(...args); });
    const batches = vi.spyOn(test.records, "putSearchEmbeddings"), transactions = vi.spyOn(test.database, "transaction");
    const embed = vi.spyOn(test.embedding, "embed");
    const result = await test.service.rebuildSearchIndex();
    expect(batches.mock.calls.map(([, rows]) => rows.length)).toEqual([16, 16, 16, 16, 4]);
    expect(embed).toHaveBeenCalledTimes(5); expect(test.writes).toHaveBeenCalledTimes(68);
    // Five batch transactions and one atomic activation; generation creation is a single INSERT.
    expect(transactions).toHaveBeenCalledTimes(6); expect(test.database.inTransaction).toBe(false);
    expect(result.fragmentCount).toBe(68); expect(result.activeGenerationId).not.toBe(test.originalId);
    expect(test.records.listSearchEmbeddings(test.originalId)).toHaveLength(2);
  });

  it.each(["formal", "unrelated"] as const)("fences a late %s foreign commit before the first batch while rechecking outside the writer lock", async (kind) => {
    const test = await fixture({ disk: true }), other = new Database(join(test.directory, "synthetic.sqlite3"));
    cleanups.push(() => { other.close(); });
    const put = test.records.putSearchEmbeddings.bind(test.records), read = test.records.getSearchRecords.bind(test.records);
    const reads = vi.spyOn(test.records, "getSearchRecords").mockImplementation((ids) => {
      expect(test.database.inTransaction).toBe(false); return read(ids);
    });
    const writes = vi.spyOn(test.records, "putSearchEmbeddings").mockImplementationOnce((...args) => {
      if (kind === "formal") other.prepare("UPDATE redesign_sources SET text = ?, content_hash = ? WHERE record_id = ?")
        .run("批次锁之前更新的合成材料", "c".repeat(64), test.recordId);
      else other.prepare("INSERT INTO workspace_settings(key, value_json, updated_at) VALUES ('synthetic-batch-race', 'true', ?)")
        .run(new Date().toISOString());
      put(...args);
    });
    const embed = vi.spyOn(test.embedding, "embed");
    if (kind === "formal") {
      await expect(test.service.rebuildSearchIndex()).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
      expect(test.writes).not.toHaveBeenCalled(); expect(test.activates).not.toHaveBeenCalled();
      expect(writes).toHaveBeenCalledTimes(1);
      expect(test.records.listSearchGenerations().find(({ state }) => state === "active")?.id).toBe(test.originalId);
    } else {
      expect((await test.service.rebuildSearchIndex()).activeGenerationId).not.toBe(test.originalId);
      expect(writes).toHaveBeenCalledTimes(2); expect(test.writes).toHaveBeenCalledTimes(2);
    }
    expect(reads).toHaveBeenCalledTimes(3); expect(embed).toHaveBeenCalledTimes(1);
  });

  it("bounds repeated late unrelated commits to two batch admission attempts without retrying the model", async () => {
    const test = await fixture({ disk: true }), other = new Database(join(test.directory, "synthetic.sqlite3"));
    cleanups.push(() => { other.close(); });
    const put = test.records.putSearchEmbeddings.bind(test.records); let commits = 0;
    const writes = vi.spyOn(test.records, "putSearchEmbeddings").mockImplementation((...args) => {
      other.prepare("INSERT INTO workspace_settings(key, value_json, updated_at) VALUES (?, 'true', ?)")
        .run(`synthetic-continuous-batch-${++commits}`, new Date().toISOString()); put(...args);
    });
    const embed = vi.spyOn(test.embedding, "embed");
    await expect(test.service.rebuildSearchIndex()).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(writes).toHaveBeenCalledTimes(2); expect(embed).toHaveBeenCalledTimes(1);
    expect(test.writes).not.toHaveBeenCalled(); expect(test.activates).not.toHaveBeenCalled();
    expect(test.records.listSearchGenerations().find(({ state }) => state === "active")?.id).toBe(test.originalId);
    expect(test.database.inTransaction).toBe(false);
  });

  it.each(["pause", "clear", "configuration"] as const)("rejects a last-continuation %s before writing any batch row", async (action) => {
    let changed = false;
    const test = await fixture({ beginModelOperation: () => () => {
      if (changed) throw new AppError("LLM_CONFIGURATION_CHANGED", "Synthetic configuration changed");
    } });
    const put = test.records.putSearchEmbeddings.bind(test.records);
    vi.spyOn(test.records, "putSearchEmbeddings").mockImplementationOnce((...args) => {
      if (action === "pause") test.service.setSearchIndexEnabled(false);
      if (action === "clear") test.service.clearTransientSessions();
      if (action === "configuration") changed = true;
      put(...args);
    });
    const embed = vi.spyOn(test.embedding, "embed");
    await expect(test.service.rebuildSearchIndex()).rejects.toMatchObject({ code: action === "pause" ? "JOB_STATE_CONFLICT" :
      action === "clear" ? "SOURCE_UNAVAILABLE" : "LLM_CONFIGURATION_CHANGED" });
    expect(embed).toHaveBeenCalledTimes(1); expect(test.writes).not.toHaveBeenCalled(); expect(test.activates).not.toHaveBeenCalled();
    expect(test.records.listSearchGenerations().find(({ state }) => state === "active")?.id).toBe(test.originalId);
    expect(test.database.inTransaction).toBe(false);
  });

  it.each(["cancel", "pause", "pause-resume", "clear", "lock", "replacement", "configuration", "shape", "unavailable"] as const)(
    "interrupts cold index scheduling between actual batches after %s without queueing paid work", async (action) => {
      let epoch = 0;
      const test = await fixture({ disk: true, beginModelOperation: () => {
        const captured = epoch;
        return () => { if (captured !== epoch) throw new AppError("LLM_CONFIGURATION_CHANGED", "Synthetic scheduling configuration changed", true); };
      } });
      seedFormalCorpus(test);
      const other = new Database(join(test.directory, "synthetic.sqlite3")); cleanups.push(() => { other.close(); });
      const otherRecords = new SqliteRecordRepository(other, () => Buffer.alloc(32));
      const read = test.records.getSearchRecords.bind(test.records), embed = vi.spyOn(test.embedding, "embed");
      const controller = new AbortController(); let batches = 0, details = 0;
      let changed: Promise<void> | undefined;
      vi.spyOn(test.records, "getSearchRecords").mockImplementation((ids) => {
        expect(test.database.inTransaction).toBe(false);
        const result = read(ids); details += result.length;
        if (++batches === 1) changed = yieldToEventLoop().then(() => {
          if (action === "cancel") controller.abort(new AppError("JOB_STATE_CONFLICT", "Synthetic scheduling cancellation"));
          if (action === "pause" || action === "pause-resume") test.service.setSearchIndexEnabled(false);
          if (action === "pause-resume") test.service.setSearchIndexEnabled(true);
          if (action === "clear") test.service.clearTransientSessions();
          if (action === "lock") test.closeWorkspace();
          if (action === "replacement") test.setCurrent({ records: otherRecords, jobs: new SqliteJobRepository(other),
            assets: new SqliteAssetRepository(other), vault: test.vault, key: Buffer.alloc(32) });
          if (action === "configuration") epoch += 1;
          if (action === "shape") Object.defineProperty(test.embedding, "dimensions", { value: 3 });
          if (action === "unavailable") test.setConfigured(false);
        });
        return result;
      });
      const outcome = await Promise.resolve().then(() => test.service.ensureSearchIndexJob(controller.signal))
        .then((value) => ({ kind: "returned", value }), (error: unknown) => ({ kind: "rejected", error }));
      await changed;
      if (action === "pause" || action === "pause-resume") expect(outcome).toEqual({ kind: "returned", value: undefined });
      else expect(outcome).toMatchObject({ kind: "rejected", error: {
        code: action === "cancel" ? "JOB_STATE_CONFLICT" : action === "configuration" ? "LLM_CONFIGURATION_CHANGED"
          : action === "shape" ? "REVISION_CONFLICT" : action === "unavailable" ? "EMBEDDING_UNAVAILABLE" : "SOURCE_UNAVAILABLE"
      } });
      expect(batches).toBe(1); expect(details).toBe(256);
      expect(embed).not.toHaveBeenCalled(); expect(test.writes).not.toHaveBeenCalled(); expect(test.activates).not.toHaveBeenCalled();
      expect(otherRecords.listSearchGenerations()).toHaveLength(1);
      expect(new SqliteJobRepository(other).list().some(({ type }) => type === "record.search-index-rebuild")).toBe(false);
    }
  );

  it("handles cancellation queued before the first scheduling read without creating a job", async () => {
    const test = await fixture(); seedFormalCorpus(test);
    const read = vi.spyOn(test.records, "getSearchRecords"), controller = new AbortController();
    const cancelled = yieldToEventLoop().then(() => controller.abort(new AppError("JOB_STATE_CONFLICT", "Synthetic pre-scan cancellation")));
    const outcome = await Promise.resolve().then(() => test.service.ensureSearchIndexJob(controller.signal))
      .then(() => undefined, (error: unknown) => error);
    await cancelled;
    expect(outcome).toMatchObject({ code: "JOB_STATE_CONFLICT" }); expect(read).not.toHaveBeenCalled();
    expect(test.records.listSearchGenerations()).toHaveLength(1);
    expect(test.jobs.list().some(({ type }) => type === "record.search-index-rebuild")).toBe(false);
  });

  it.each(["clear", "lock", "replacement"] as const)("does not publish a late committed field reply after %s during index scheduling", async (action) => {
    const test = await fixture(); seedFormalCorpus(test);
    const replacementDatabase = new Database(":memory:"); runMigrations(replacementDatabase);
    cleanups.push(() => { replacementDatabase.close(); });
    const replacementRecords = new SqliteRecordRepository(replacementDatabase, () => Buffer.alloc(32));
    const read = test.records.getSearchRecords.bind(test.records); let changed: Promise<void> | undefined;
    vi.spyOn(test.records, "getSearchRecords").mockImplementationOnce((ids) => {
      const details = read(ids);
      changed = yieldToEventLoop().then(() => {
        if (action === "clear") test.service.clearTransientSessions();
        if (action === "lock") test.closeWorkspace();
        if (action === "replacement") test.setCurrent({ records: replacementRecords, jobs: new SqliteJobRepository(replacementDatabase),
          assets: new SqliteAssetRepository(replacementDatabase), vault: test.vault, key: Buffer.alloc(32) });
      });
      return details;
    });
    const embed = vi.spyOn(test.embedding, "embed");
    await expect(test.service.patchFields(test.recordId, 1, { location: "已正式提交的合成补充" }))
      .rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    await changed;
    expect(replacementDatabase.prepare("SELECT count(*) FROM redesign_records").pluck().get()).toBe(0);
    expect(replacementDatabase.prepare("SELECT count(*) FROM jobs").pluck().get()).toBe(0);
    expect(embed).not.toHaveBeenCalled(); expect(test.writes).not.toHaveBeenCalled(); expect(test.activates).not.toHaveBeenCalled();
    if (test.database.open) expect(test.records.getRecord(test.recordId)?.overrides)
      .toEqual(expect.arrayContaining([expect.objectContaining({ fieldKey: "location", value: "已正式提交的合成补充" })]));
  });

  it("checks the full scheduling corpus in bounded detail and key batches without raw array reads or model work", async () => {
    const test = await fixture(); seedFormalCorpus(test);
    const whole = vi.spyOn(test.records, "listIndexableRecords"), wholeKeys = vi.spyOn(test.records, "listSearchFragmentKeys");
    const read = test.records.getSearchRecords.bind(test.records), lengths: number[] = [];
    const embed = vi.spyOn(test.embedding, "embed"), keyBatches = vi.spyOn(test.records, "iterateSearchFragmentKeyBatches");
    const before = JSON.stringify(test.database.prepare("SELECT * FROM redesign_sources ORDER BY rowid").all());
    vi.spyOn(test.records, "getSearchRecords").mockImplementation((ids) => {
      expect(test.database.inTransaction).toBe(false); lengths.push(ids.length); return read(ids);
    });
    expect(await test.service.ensureSearchIndexJob()).toBeTypeOf("string");
    expect(lengths).toEqual([256, 256, 1]); expect(keyBatches).toHaveBeenCalledTimes(1);
    expect(whole).not.toHaveBeenCalled(); expect(wholeKeys).toHaveBeenCalledExactlyOnceWith(test.originalId, undefined, 512);
    expect(embed).not.toHaveBeenCalled();
    expect(JSON.stringify(test.database.prepare("SELECT * FROM redesign_sources ORDER BY rowid").all())).toBe(before);
    expect(test.records.listSearchGenerations()).toHaveLength(2);
    expect(test.jobs.list().filter(({ type }) => type === "record.search-index-rebuild")).toHaveLength(1);
  });

  it("coalesces concurrent cooperative scheduling checks into one generation and job", async () => {
    const test = await fixture(); seedFormalCorpus(test);
    const full = vi.spyOn(test.records, "listIndexableRecords"), embed = vi.spyOn(test.embedding, "embed");
    const [first, second] = await Promise.all([test.service.ensureSearchIndexJob(), test.service.ensureSearchIndexJob()]);
    expect(first).toBeTypeOf("string"); expect(second).toBe(first); expect(full).not.toHaveBeenCalled();
    expect(test.records.listSearchGenerations()).toHaveLength(2);
    expect(test.jobs.list().filter(({ type }) => type === "record.search-index-rebuild")).toHaveLength(1);
    expect(embed).not.toHaveBeenCalled();
  });

  it("rechecks a microtask commit after asynchronous scheduling validation rather than losing the update", async () => {
    const test = await fixture({ disk: true }), other = new Database(join(test.directory, "synthetic.sqlite3"));
    cleanups.push(() => { other.close(); });
    const keys = test.records.iterateSearchFragmentKeyBatches.bind(test.records), version = test.records.getSearchProjectionVersion.bind(test.records);
    let completed = false, changed = false;
    vi.spyOn(test.records, "iterateSearchFragmentKeyBatches").mockImplementationOnce(function* (...args) {
      yield* keys(...args); completed = true;
    });
    vi.spyOn(test.records, "getSearchProjectionVersion").mockImplementation(() => {
      const result = version();
      if (completed && !changed) {
        changed = true;
        globalThis.queueMicrotask(() => other.prepare("UPDATE redesign_sources SET text = ?, content_hash = ? WHERE record_id = ?")
          .run("调度完整校验返回后更新的合成材料", "a".repeat(64), test.recordId));
      }
      return result;
    });
    expect(await test.service.ensureSearchIndexJob()).toBeTypeOf("string"); expect(changed).toBe(true);
    expect(test.records.listSearchGenerations()).toHaveLength(2);
    expect(test.jobs.list().filter(({ type }) => type === "record.search-index-rebuild")).toHaveLength(1);
  });

  it("accepts queued index cancellation before reading the first formal batch or calling the model", async () => {
    const test = await fixture(); seedFormalCorpus(test);
    const reads = vi.spyOn(test.records, "getSearchRecords"), embed = vi.spyOn(test.embedding, "embed");
    const controller = new AbortController();
    const cancelled = yieldToEventLoop().then(() => controller.abort(new AppError("JOB_STATE_CONFLICT", "Synthetic queued cancellation")));
    const outcome = test.service.rebuildSearchIndex(undefined, controller.signal).then(() => undefined, (error: unknown) => error);
    expect(await outcome).toMatchObject({ code: "JOB_STATE_CONFLICT" }); await cancelled;
    expect(reads).not.toHaveBeenCalled(); expect(embed).not.toHaveBeenCalled();
    expect(test.writes).not.toHaveBeenCalled(); expect(test.activates).not.toHaveBeenCalled();
    expect(test.records.listSearchGenerations().find(({ state }) => state === "active")?.id).toBe(test.originalId);
  });

  it.each(["cancel", "pause-resume", "clear", "configuration", "replacement", "external-source"] as const)(
    "interrupts the initial index corpus scan between actual batches after %s without model requests", async (action) => {
      let epoch = 0;
      const test = await fixture({ disk: true, beginModelOperation: () => {
        const captured = epoch;
        return () => { if (captured !== epoch) throw new AppError("LLM_CONFIGURATION_CHANGED", "Synthetic configuration changed", true); };
      } });
      seedFormalCorpus(test);
      const other = new Database(join(test.directory, "synthetic.sqlite3")); cleanups.push(() => { other.close(); });
      const read = test.records.getSearchRecords.bind(test.records), embed = vi.spyOn(test.embedding, "embed");
      const controller = new AbortController(); let batches = 0, details = 0;
      let change: Promise<void> | undefined;
      vi.spyOn(test.records, "getSearchRecords").mockImplementation((ids) => {
        expect(test.database.inTransaction).toBe(false);
        const records = read(ids); details += ids.length;
        if (++batches === 1) change = yieldToEventLoop().then(() => {
          if (action === "cancel") controller.abort(new AppError("JOB_STATE_CONFLICT", "Synthetic corpus cancellation"));
          if (action === "pause-resume") { test.service.setSearchIndexEnabled(false); test.service.setSearchIndexEnabled(true); }
          if (action === "clear") test.service.clearTransientSessions();
          if (action === "configuration") epoch += 1;
          if (action === "replacement") test.setCurrent({ records: new SqliteRecordRepository(other, () => Buffer.alloc(32)),
            jobs: new SqliteJobRepository(other), assets: new SqliteAssetRepository(other), vault: test.vault, key: Buffer.alloc(32) });
          if (action === "external-source") other.prepare("UPDATE redesign_sources SET text = ?, content_hash = ? WHERE record_id = ?")
            .run("初始扫描期间更新的合成材料", "c".repeat(64), test.recordId);
        });
        return records;
      });
      const outcome = await test.service.rebuildSearchIndex(undefined, controller.signal).then(() => undefined, (error: unknown) => error);
      await change;
      expect(outcome).toMatchObject({ code: action === "cancel" || action === "pause-resume" ? "JOB_STATE_CONFLICT"
        : action === "configuration" ? "LLM_CONFIGURATION_CHANGED"
          : action === "external-source" ? "REVISION_CONFLICT" : "SOURCE_UNAVAILABLE" });
      expect(batches).toBe(1); expect(details).toBe(256); expect(embed).not.toHaveBeenCalled();
      expect(test.writes).not.toHaveBeenCalled(); expect(test.activates).not.toHaveBeenCalled();
      expect(test.records.listSearchGenerations().find(({ state }) => state === "active")?.id).toBe(test.originalId);
    }
  );

  it("rejects a microtask commit after completing the asynchronous input fingerprint before outbound work", async () => {
    const test = await fixture(); seedFormalCorpus(test);
    const iterate = test.records.iterateIndexableRecordBatches.bind(test.records);
    let completed = false, changed = false;
    vi.spyOn(test.records, "iterateIndexableRecordBatches").mockImplementationOnce(function* () {
      yield* iterate(); completed = true;
    });
    const version = test.records.getSearchProjectionVersion.bind(test.records);
    vi.spyOn(test.records, "getSearchProjectionVersion").mockImplementation(() => {
      const result = version();
      if (completed && !changed) {
        changed = true;
        globalThis.queueMicrotask(() => test.database.prepare("UPDATE redesign_sources SET text = ? WHERE record_id = ?")
          .run("异步指纹完成后更新的合成材料", test.recordId));
      }
      return result;
    });
    const embed = vi.spyOn(test.embedding, "embed");
    await expect(test.service.rebuildSearchIndex()).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(changed).toBe(true); expect(embed).not.toHaveBeenCalled();
    expect(test.writes).not.toHaveBeenCalled(); expect(test.activates).not.toHaveBeenCalled();
    expect(test.records.listSearchGenerations().find(({ state }) => state === "active")?.id).toBe(test.originalId);
  });

  it.each(["cancel", "pause-resume", "clear", "configuration", "replacement", "lock", "external-source"] as const)(
    "interrupts an external index recheck between actual batches after %s without accepting the held response", async (action) => {
      let epoch = 0;
      const test = await fixture({ disk: true, beginModelOperation: () => {
        const captured = epoch;
        return () => { if (captured !== epoch) throw new AppError("LLM_CONFIGURATION_CHANGED", "Synthetic configuration changed", true); };
      } });
      seedFormalCorpus(test);
      const other = new Database(join(test.directory, "synthetic.sqlite3")); cleanups.push(() => { other.close(); });
      const otherRecords = new SqliteRecordRepository(other, () => Buffer.alloc(32));
      const iterate = test.records.iterateIndexableRecordBatches.bind(test.records), embed = vi.spyOn(test.embedding, "embed");
      const controller = new AbortController(); let pass = 0, rechecked = 0, recheckBatches = 0;
      let change: Promise<void> | undefined;
      vi.spyOn(test.records, "iterateIndexableRecordBatches").mockImplementation(function* () {
        const currentPass = ++pass;
        for (const details of iterate()) {
          expect(test.database.inTransaction).toBe(false);
          if (currentPass === 3) {
            rechecked += details.length;
            if (++recheckBatches === 1) change = yieldToEventLoop().then(() => {
              if (action === "cancel") controller.abort(new AppError("JOB_STATE_CONFLICT", "Synthetic external recheck cancellation"));
              if (action === "pause-resume") { test.service.setSearchIndexEnabled(false); test.service.setSearchIndexEnabled(true); }
              if (action === "clear") test.service.clearTransientSessions();
              if (action === "configuration") epoch += 1;
              if (action === "replacement") test.setCurrent({ records: otherRecords, jobs: new SqliteJobRepository(other),
                assets: new SqliteAssetRepository(other), vault: test.vault, key: Buffer.alloc(32) });
              if (action === "lock") test.closeWorkspace();
              if (action === "external-source") other.prepare("UPDATE redesign_sources SET text = ?, content_hash = ? WHERE record_id = ?")
                .run("复核扫描期间更新的合成材料", "d".repeat(64), test.recordId);
            });
          }
          yield details;
        }
      });
      const delayed = test.delay();
      const pending = test.service.rebuildSearchIndex(undefined, controller.signal).then(() => undefined, (error: unknown) => error);
      await delayed.started;
      other.prepare("INSERT INTO workspace_settings(key, value_json, updated_at) VALUES ('synthetic-trigger-recheck', 'true', ?)")
        .run(new Date().toISOString());
      delayed.release(); const outcome = await pending; await change;
      expect(outcome).toMatchObject({ code: action === "cancel" || action === "pause-resume" ? "JOB_STATE_CONFLICT"
        : action === "configuration" ? "LLM_CONFIGURATION_CHANGED"
          : action === "external-source" ? "REVISION_CONFLICT" : "SOURCE_UNAVAILABLE" });
      expect(recheckBatches).toBe(1); expect(rechecked).toBe(256); expect(embed).toHaveBeenCalledTimes(1);
      expect(test.writes).not.toHaveBeenCalled(); expect(test.activates).not.toHaveBeenCalled();
      expect(otherRecords.listSearchGenerations().find(({ state }) => state === "active")?.id).toBe(test.originalId);
      if (action === "lock" || action === "replacement") expect(test.fails).not.toHaveBeenCalled();
    }
  );

  it("fences a microtask commit after an asynchronous external recheck before writing the held response", async () => {
    const test = await fixture({ disk: true }), other = new Database(join(test.directory, "synthetic.sqlite3"));
    cleanups.push(() => { other.close(); });
    const iterate = test.records.iterateIndexableRecordBatches.bind(test.records);
    let pass = 0, completed = false, changed = false;
    vi.spyOn(test.records, "iterateIndexableRecordBatches").mockImplementation(function* () {
      const currentPass = ++pass; yield* iterate(); if (currentPass === 3) completed = true;
    });
    const version = test.records.getSearchProjectionVersion.bind(test.records);
    vi.spyOn(test.records, "getSearchProjectionVersion").mockImplementation(() => {
      const result = version();
      if (completed && !changed) {
        changed = true;
        globalThis.queueMicrotask(() => other.prepare("UPDATE redesign_sources SET text = ? WHERE record_id = ?")
          .run("复核完成后微任务更新的合成材料", test.recordId));
      }
      return result;
    });
    const embed = vi.spyOn(test.embedding, "embed"), delayed = test.delay();
    const pending = test.service.rebuildSearchIndex().then(() => undefined, (error: unknown) => error);
    await delayed.started;
    other.prepare("INSERT INTO workspace_settings(key, value_json, updated_at) VALUES ('synthetic-recheck-microtask', 'true', ?)")
      .run(new Date().toISOString());
    delayed.release(); expect(await pending).toMatchObject({ code: "REVISION_CONFLICT" });
    expect(changed).toBe(true); expect(embed).toHaveBeenCalledTimes(1);
    expect(test.writes).not.toHaveBeenCalled(); expect(test.activates).not.toHaveBeenCalled();
    expect(test.records.listSearchGenerations().find(({ state }) => state === "active")?.id).toBe(test.originalId);
  });

  it("bounds atomic activation races without scanning under the writer lock or repeating model work", async () => {
    const test = await fixture({ disk: true }), other = new Database(join(test.directory, "synthetic.sqlite3"));
    cleanups.push(() => { other.close(); });
    const activate = SqliteRecordRepository.prototype.activateSearchGeneration.bind(test.records);
    const read = test.records.getSearchRecords.bind(test.records), embed = vi.spyOn(test.embedding, "embed");
    vi.spyOn(test.records, "getSearchRecords").mockImplementation((ids) => {
      expect(test.database.inTransaction).toBe(false); return read(ids);
    });
    let races = 0;
    test.activates.mockImplementation((...args) => {
      other.prepare("INSERT INTO workspace_settings(key, value_json, updated_at) VALUES (?, 'true', ?)")
        .run(`synthetic-activation-race-${++races}`, new Date().toISOString());
      activate(...args);
    });
    await expect(test.service.rebuildSearchIndex()).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(races).toBe(2); expect(test.activates).toHaveBeenCalledTimes(2); expect(embed).toHaveBeenCalledTimes(1);
    expect(test.writes).toHaveBeenCalledTimes(2);
    expect(test.records.listSearchGenerations().find(({ state }) => state === "active")?.id).toBe(test.originalId);
    expect(test.records.listSearchGenerations().find(({ state }) => state === "failed")?.lastError).toBe("REVISION_CONFLICT");
  });

  it("builds all 513 records using bounded fingerprint and processing passes without retaining the full corpus", async () => {
    const test = await fixture(); seedFormalCorpus(test);
    const formal = () => JSON.stringify(["redesign_records", "redesign_sources", "redesign_reports", "redesign_field_overrides",
      "redesign_record_assets", "assets"].map((table) => test.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
    const before = formal(), fullRead = vi.spyOn(test.records, "listIndexableRecords");
    const read = test.records.getSearchRecords.bind(test.records), batchLengths: number[] = [];
    const embed = vi.spyOn(test.embedding, "embed");
    vi.spyOn(test.records, "getSearchRecords").mockImplementation((ids) => {
      expect(test.database.inTransaction).toBe(false); batchLengths.push(ids.length);
      if (batchLengths.length <= 3) expect(embed).not.toHaveBeenCalled();
      return read(ids);
    });
    const result = await test.service.rebuildSearchIndex();
    expect(batchLengths).toEqual([256, 256, 1, 256, 256, 1]);
    expect(fullRead).not.toHaveBeenCalled(); expect(result.fragmentCount).toBe(1026);
    expect(result.activeGenerationId).not.toBe(test.originalId); expect(test.writes).toHaveBeenCalledTimes(1026);
    expect(test.records.listSearchFragmentKeys(result.activeGenerationId!)).toHaveLength(1026);
    expect(formal()).toBe(before);
  });

  it("yields during fragment processing, keeps partial output inactive on cancellation and rebuilds all input on retry", async () => {
    const test = await fixture(); seedFormalCorpus(test);
    const read = test.records.getSearchRecords.bind(test.records), lengths: number[] = [];
    const controller = new AbortController(); let changed: Promise<void> | undefined;
    vi.spyOn(test.records, "getSearchRecords").mockImplementation((ids) => {
      const result = read(ids); lengths.push(ids.length);
      if (lengths.length === 4) changed = yieldToEventLoop().then(() => controller.abort(new AppError("JOB_STATE_CONFLICT", "Synthetic processing cancellation")));
      return result;
    });
    await expect(test.service.rebuildSearchIndex(undefined, controller.signal)).rejects.toMatchObject({ code: "JOB_STATE_CONFLICT" });
    await changed;
    expect(lengths).toEqual([256, 256, 1, 256]); expect(test.writes).toHaveBeenCalledTimes(512);
    expect(test.activates).not.toHaveBeenCalled();
    const failed = test.records.listSearchGenerations().find(({ state }) => state === "failed")!;
    expect(test.records.listSearchGenerations().find(({ state }) => state === "active")?.id).toBe(test.originalId);
    expect(test.records.listSearchFragmentKeys(failed.id)).toHaveLength(512);
    const recovered = await test.restart(failed.id);
    expect(recovered.activeGenerationId).toBe(failed.id); expect(recovered.fragmentCount).toBe(1026);
    expect(test.records.listSearchFragmentKeys(failed.id)).toHaveLength(1026);
  });

  it("excludes old same-revision report text while retaining current source fragments until rebuilding", async () => {
    const test = await fixture();
    vi.spyOn(test.embedding, "embed").mockImplementation(async (inputs) => inputs.map((input) =>
      new Float32Array(input.text?.includes("OLD_REPORT_TOPIC") || input.text === "OLD_SEMANTIC_PROBE" ? [1, 0] : [0, 1])));
    const report = (text: string) => test.service.runAnalysis(test.recordId, 1, { async analyze(input) { return {
      state: "complete", promptVersion: "synthetic-currency-v1", modelProfile: "synthetic:no-network",
      content: { summary: "相同的合成摘要", time: { source: "ai" }, location: { source: "ai" }, people: [],
        chronology: [{ id: randomUUID(), text, anchor: { sourceVersion: input.source.sourceVersion, surface: "report" } }],
        unknowns: [], disputes: [], suggestions: [], legalIssues: [], citations: [], coverageNotes: [] }
    }; } }, false, randomUUID());
    const search = async (text: string) => {
      const query = await test.service.prepareSearchQuery({ text }); return test.service.executeSearchQuery(query.sessionId, {});
    };
    await report("OLD_REPORT_TOPIC"); await buildQueuedProjection(test);
    expect((await search("OLD_SEMANTIC_PROBE")).hits).toMatchObject([{ record: { id: test.recordId }, anchor: { surface: "report" } }]);
    await report("NEW_REPORT_TOPIC"); expect(test.service.getRecord(test.recordId).record.revision).toBe(1);
    const changes = test.database.prepare("SELECT total_changes()").pluck().get();
    const stale = await search("OLD_SEMANTIC_PROBE");
    expect(stale.hits).toEqual([]);
    expect(stale.capabilities).toMatchObject({ indexCoverage: { outdatedFragments: 1 } });
    const current = await search("CURRENT_SOURCE_PROBE");
    expect(current.hits[0]?.matches?.some(({ anchor }) => anchor?.surface === "source")).toBe(true);
    expect(test.database.prepare("SELECT total_changes()").pluck().get()).toBe(changes);
    await buildQueuedProjection(test);
    expect((await search("OLD_SEMANTIC_PROBE")).hits).toEqual([]);
  });

  it("invalidates an unchanged media description when only its source interval changes and schedules a rebuild", async () => {
    const test = await fixture({ media: "wav" });
    vi.spyOn(test.embedding, "embed").mockImplementation(async (inputs) => inputs.map((input) =>
      new Float32Array(input.text?.includes("CONSTANT_MEDIA_TOPIC") || input.text === "MEDIA_POSITION_PROBE" ? [1, 0] : [0, 1])));
    const report = (interval: [number, number]) => test.service.runAnalysis(test.recordId, 1, { async analyze(input) { return {
      state: "complete", promptVersion: "synthetic-currency-v1", modelProfile: "synthetic:no-network",
      content: { summary: "相同的合成摘要", time: { source: "ai" }, location: { source: "ai" }, people: [], chronology: [],
        mediaSegments: [{ id: randomUUID(), description: "CONSTANT_MEDIA_TOPIC", anchor: {
          sourceVersion: input.source.sourceVersion, assetId: input.attachments[0]!.id, intervalMs: interval } }],
        unknowns: [], disputes: [], suggestions: [], legalIssues: [], citations: [], coverageNotes: [] }
    }; } }, false, randomUUID());
    const search = async () => {
      const query = await test.service.prepareSearchQuery({ text: "MEDIA_POSITION_PROBE" }); return test.service.executeSearchQuery(query.sessionId, {});
    };
    await report([100, 200]); await buildQueuedProjection(test);
    expect((await search()).hits).toMatchObject([{ anchor: { intervalMs: [100, 200] } }]);
    await report([300, 400]);
    expect((await search()).hits).toEqual([]);
    expect(test.jobs.list().some(({ type, state }) => type === "record.search-index-rebuild" && state === "queued")).toBe(true);
    await buildQueuedProjection(test);
    expect((await search()).hits).toMatchObject([{ anchor: { intervalMs: [300, 400] } }]);
  });

  it("ignores anchor property order and a newer partial report when the complete projection is unchanged", async () => {
    const test = await fixture({ media: "wav" });
    const report = (reordered: boolean, partial = false) => test.service.runAnalysis(test.recordId, 1, { async analyze(input) { return {
      state: partial ? "partial" : "complete", promptVersion: "synthetic-currency-v1", modelProfile: "synthetic:no-network",
      content: { summary: "相同的合成摘要", time: { source: "ai" }, location: { source: "ai" }, people: [], chronology: [],
        mediaSegments: [{ id: randomUUID(), description: partial ? "未作为当前投影的部分描述" : "相同的合成媒体描述", anchor: reordered ? {
          intervalMs: [100, 200], assetId: input.attachments[0]!.id, sourceVersion: input.source.sourceVersion
        } : { sourceVersion: input.source.sourceVersion, assetId: input.attachments[0]!.id, intervalMs: [100, 200] } }],
        unknowns: [], disputes: [], suggestions: [], legalIssues: [], citations: [], coverageNotes: [] }
    }; } }, false, randomUUID());
    await report(false); await buildQueuedProjection(test);
    await report(true);
    expect(await test.service.ensureSearchIndexJob()).toBeUndefined();
    await report(false, true);
    expect(await test.service.ensureSearchIndexJob()).toBeUndefined();
    expect(test.service.getRecord(test.recordId).report?.content.mediaSegments?.[0]?.description).toBe("相同的合成媒体描述");
    const query = await test.service.prepareSearchQuery({ text: "合成语义探针" });
    const result = await test.service.executeSearchQuery(query.sessionId, {});
    expect(result.capabilities.indexCoverage).toEqual({ currentFragments: 4, expectedFragments: 4, outdatedFragments: 0 });
  });

  it("rebuilds to remove obsolete extra fragments even when all current fragments already exist", async () => {
    const test = await fixture();
    // An older on-disk projection can contain extras; do not bypass the public active-generation write guard.
    test.database.prepare(`INSERT INTO redesign_search_embeddings(generation_id, fragment_id, record_id, record_revision,
      source_version, modality, content_hash, text_content, asset_id, anchor_json, vector)
      SELECT generation_id, ?, record_id, record_revision, source_version, modality, content_hash, text_content,
        asset_id, anchor_json, vector FROM redesign_search_embeddings WHERE generation_id = ? LIMIT 1`)
      .run(randomUUID(), test.originalId);
    const query = await test.service.prepareSearchQuery({ text: "合成语义探针" });
    const result = await test.service.executeSearchQuery(query.sessionId, {});
    expect(result.capabilities.indexCoverage).toEqual({ currentFragments: 2, expectedFragments: 2, outdatedFragments: 1 });
    expect(result.hits[0]?.matches?.some(({ anchor }) => anchor?.surface === "report")).toBe(false);
    expect(await test.service.ensureSearchIndexJob()).toBeTypeOf("string");
    await buildQueuedProjection(test);
    expect(test.records.listSearchFragmentKeys(test.records.listSearchGenerations().find(({ state }) => state === "active")!.id)).toHaveLength(2);
  });

  it("uses local keywords without model calls and rejects media when every active fragment is obsolete", async () => {
    const test = await fixture({ media: "png" });
    await test.service.patchFields(test.recordId, 1, { location: "合成用户补充地点" });
    const embed = vi.spyOn(test.embedding, "embed"), open = vi.spyOn(test.vault, "open");
    const changes = test.database.prepare("SELECT total_changes()").pluck().get();
    const text = await test.service.prepareSearchQuery({ text: "薪酬" });
    expect(await test.service.executeSearchQuery(text.sessionId, {})).toMatchObject({ hits: [{ record: { id: test.recordId } }],
      capabilities: { semantic: "building", indexCoverage: { currentFragments: 0, expectedFragments: 1, outdatedFragments: 1 } } });
    const media = await test.service.prepareSearchQuery({ paths: [join(test.directory, "synthetic-private-image.png")] });
    await expect(test.service.executeSearchQuery(media.sessionId, {})).rejects.toMatchObject({ code: "EMBEDDING_UNAVAILABLE" });
    expect(embed).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
    expect(test.database.prepare("SELECT total_changes()").pluck().get()).toBe(changes);
  });

  it("reuses only metadata signatures while the database is unchanged and drops the cache when the workspace is cleared", async () => {
    const test = await fixture(), read = vi.spyOn(test.records, "iterateIndexableRecordBatches");
    const search = async () => {
      const query = await test.service.prepareSearchQuery({ text: "合成语义探针" }); return test.service.executeSearchQuery(query.sessionId, {});
    };
    const changes = test.database.prepare("SELECT total_changes()").pluck().get();
    expect((await search()).capabilities.indexCoverage).toEqual({ currentFragments: 2, expectedFragments: 2, outdatedFragments: 0 });
    await search(); expect(read).toHaveBeenCalledTimes(1);
    test.service.clearTransientSessions();
    await search(); expect(read).toHaveBeenCalledTimes(2);
    expect(test.database.prepare("SELECT total_changes()").pluck().get()).toBe(changes);
  });

  it("does not search or reopen an original marked deleted while the old image generation remains active", async () => {
    const test = await fixture({ media: "png" }), assetId = test.service.getRecord(test.recordId).attachments[0]!.id;
    test.database.prepare("UPDATE assets SET availability_status = 'deleted', deleted_at = '2026-09-29T00:00:00Z' WHERE id = ?").run(assetId);
    const query = await test.service.prepareSearchQuery({ paths: [join(test.directory, "synthetic-private-image.png")] });
    const embed = vi.spyOn(test.embedding, "embed"), open = vi.spyOn(test.vault, "open");
    const changes = test.database.prepare("SELECT total_changes()").pluck().get();
    await expect(test.service.executeSearchQuery(query.sessionId, {})).rejects.toMatchObject({ code: "EMBEDDING_UNAVAILABLE" });
    expect(embed).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
    expect(test.database.prepare("SELECT total_changes()").pluck().get()).toBe(changes);
  });

  it("excludes report-description anchors of deleted attachments without discarding other current fragments", async () => {
    const test = await fixture({ media: "wav" });
    vi.spyOn(test.embedding, "embed").mockImplementation(async (inputs) => inputs.map((input) =>
      new Float32Array(input.text?.includes("DELETED_MEDIA_TOPIC") || input.text === "DELETED_MEDIA_PROBE" ? [1, 0] : [0, 1])));
    await test.service.runAnalysis(test.recordId, 1, { async analyze(input) { return {
      state: "complete", promptVersion: "synthetic-deleted-media-v1", modelProfile: "synthetic:no-network",
      content: { summary: "合成摘要", time: { source: "ai" }, location: { source: "ai" }, people: [], chronology: [],
        mediaSegments: [{ id: randomUUID(), description: "DELETED_MEDIA_TOPIC", anchor: {
          sourceVersion: input.source.sourceVersion, assetId: input.attachments[0]!.id, intervalMs: [100, 200] } }],
        unknowns: [], disputes: [], suggestions: [], legalIssues: [], citations: [], coverageNotes: [] }
    }; } }, false, randomUUID());
    await buildQueuedProjection(test);
    const assetId = test.service.getRecord(test.recordId).attachments[0]!.id;
    test.database.prepare("UPDATE assets SET availability_status = 'deleted', deleted_at = '2026-09-29T00:00:00Z' WHERE id = ?").run(assetId);
    const query = await test.service.prepareSearchQuery({ text: "DELETED_MEDIA_PROBE" });
    const result = await test.service.executeSearchQuery(query.sessionId, {});
    expect(result.hits).toEqual([]);
    expect(result.capabilities.indexCoverage).toEqual({ currentFragments: 3, expectedFragments: 3, outdatedFragments: 1 });
    expect(await test.service.ensureSearchIndexJob()).toBeTypeOf("string");
    const open = vi.spyOn(test.vault, "open"); await buildQueuedProjection(test);
    expect(open).not.toHaveBeenCalled();
    expect(test.service.getRecord(test.recordId).report?.content.mediaSegments?.[0]?.description).toBe("DELETED_MEDIA_TOPIC");
  });

  it("invalidates current signatures after another SQLite connection commits without changing record revision", async () => {
    const test = await fixture({ disk: true });
    const other = new Database(join(test.directory, "synthetic.sqlite3")); cleanups.push(() => { other.close(); });
    const search = async () => {
      const query = await test.service.prepareSearchQuery({ text: "合成语义探针" }); return test.service.executeSearchQuery(query.sessionId, {});
    };
    expect((await search()).capabilities.indexCoverage?.currentFragments).toBe(2);
    const version = test.records.getSearchProjectionVersion(), changes = test.database.prepare("SELECT total_changes()").pluck().get();
    other.prepare("UPDATE redesign_sources SET text = ?, content_hash = ? WHERE record_id = ?")
      .run("另一连接更新的合成来源", "f".repeat(64), test.recordId);
    expect(test.records.getSearchProjectionVersion()).not.toBe(version);
    const result = await search();
    expect(result.capabilities.indexCoverage).toEqual({ currentFragments: 1, expectedFragments: 2, outdatedFragments: 1 });
    expect(result.hits[0]?.matches?.some(({ anchor }) => anchor?.surface === "source")).toBe(false);
    expect(test.database.prepare("SELECT total_changes()").pluck().get()).toBe(changes);
  });

  it("rejects a projection that changes during its initial read before making a model request", async () => {
    const test = await fixture();
    const read = test.records.iterateIndexableRecordBatches.bind(test.records);
    vi.spyOn(test.records, "iterateIndexableRecordBatches").mockImplementationOnce(function* () {
      for (const details of read()) {
        test.database.prepare("UPDATE redesign_sources SET text = '读取投影期间更新的合成材料' WHERE record_id = ?").run(test.recordId);
        yield details;
      }
    });
    const query = await test.service.prepareSearchQuery({ text: "合成语义探针" }), embed = vi.spyOn(test.embedding, "embed");
    await expect(test.service.executeSearchQuery(query.sessionId, {})).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(embed).not.toHaveBeenCalled();
  });

  it.each(["cancel", "clear", "lock", "replace", "local-edit", "external-edit", "pause-resume", "model-unavailable"] as const)(
    "stops a cold projection between bounded reads before calling the model (%s)", async (action) => {
      const test = await fixture({ disk: true }), query = await test.service.prepareSearchQuery({ text: "冷校验合成探针" });
      const other = new Database(join(test.directory, "synthetic.sqlite3")); cleanups.push(() => { other.close(); });
      const replacement = new Database(":memory:"); runMigrations(replacement); cleanups.push(() => { replacement.close(); });
      const replacementRecords = new SqliteRecordRepository(replacement, () => Buffer.alloc(32));
      const originalBytes = test.database.serialize(), replacementBytes = replacement.serialize();
      const embed = vi.spyOn(test.embedding, "embed"), read = test.records.getSearchRecords.bind(test.records);
      let actionRan = false;
      vi.spyOn(test.records, "getSearchRecords").mockImplementationOnce((ids) => {
        const result = read(ids);
        void yieldToEventLoop().then(() => {
          actionRan = true;
          if (action === "cancel") test.service.abandonSearchQuery(query.sessionId);
          if (action === "clear") test.service.clearTransientSessions();
          if (action === "lock") test.closeWorkspace();
          if (action === "replace") test.setCurrent({ key: Buffer.alloc(32), records: replacementRecords,
            assets: new SqliteAssetRepository(replacement), jobs: new SqliteJobRepository(replacement), vault: test.vault });
          if (action === "local-edit" || action === "external-edit") (action === "local-edit" ? test.database : other)
            .prepare("UPDATE redesign_sources SET text = '分批间修改的合成原文' WHERE record_id = ?").run(test.recordId);
          if (action === "pause-resume") { test.service.setSearchIndexEnabled(false); test.service.setSearchIndexEnabled(true); }
          if (action === "model-unavailable") test.setConfigured(false);
        });
        return result;
      });
      const outcome = test.service.executeSearchQuery(query.sessionId, {}).then(() => undefined, (error: unknown) => error);
      const error = await outcome; await yieldToEventLoop();
      expect(actionRan).toBe(true);
      expect(error).toMatchObject({ code: ["cancel", "clear", "lock", "replace"].includes(action) ? "SOURCE_UNAVAILABLE"
        : action === "model-unavailable" ? "EMBEDDING_UNAVAILABLE" : "REVISION_CONFLICT" });
      expect(embed).not.toHaveBeenCalled();
      expect(replacement.serialize().equals(replacementBytes)).toBe(true);
      if (["cancel", "clear", "replace", "model-unavailable"].includes(action)) {
        expect(test.database.serialize().equals(originalBytes)).toBe(true);
      }
      expect(test.stored.size).toBe(0);
    }
  );

  it("does not publish cached pagination after cancellation during a cooperative projection recheck", async () => {
    const test = await fixture(); await test.seed("另一条合成权益记录"); await buildQueuedProjection(test);
    const query = await test.service.prepareSearchQuery({ text: "合成语义探针" });
    const first = await test.service.executeSearchQuery(query.sessionId, { limit: 1 });
    expect(first.nextCursor).toBeTypeOf("string");
    test.database.prepare("INSERT INTO workspace_settings(key, value_json, updated_at) VALUES ('cold-pagination-test', 'true', ?)")
      .run(new Date().toISOString());
    const baseline = test.database.serialize(), embed = vi.spyOn(test.embedding, "embed");
    const read = test.records.getSearchRecords.bind(test.records);
    vi.spyOn(test.records, "getSearchRecords").mockImplementationOnce((ids) => {
      const result = read(ids); void yieldToEventLoop().then(() => test.service.abandonSearchQuery(query.sessionId)); return result;
    });
    const outcome = test.service.executeSearchQuery(query.sessionId, { limit: 1, cursor: first.nextCursor! })
      .then(() => undefined, (error: unknown) => error);
    const error = await outcome; await yieldToEventLoop();
    expect(error).toMatchObject({ code: "SOURCE_UNAVAILABLE" }); expect(embed).not.toHaveBeenCalled();
    expect(test.database.serialize().equals(baseline)).toBe(true);
  });

  it("processes cancellation queued before the first cold read without reading details or calling the model", async () => {
    const test = await fixture(), query = await test.service.prepareSearchQuery({ text: "首批前取消合成查询" });
    const read = vi.spyOn(test.records, "iterateIndexableRecordBatches"), embed = vi.spyOn(test.embedding, "embed");
    const before = test.database.serialize();
    void yieldToEventLoop().then(() => test.service.abandonSearchQuery(query.sessionId));
    await expect(test.service.executeSearchQuery(query.sessionId, {})).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    expect(read).not.toHaveBeenCalled(); expect(embed).not.toHaveBeenCalled();
    expect(test.database.serialize().equals(before)).toBe(true);
  });

  it("does not cache a partially checked projection after cancellation in the indexed-key phase", async () => {
    const test = await fixture(), query = await test.service.prepareSearchQuery({ text: "片段阶段取消合成查询" });
    const details = vi.spyOn(test.records, "iterateIndexableRecordBatches"), embed = vi.spyOn(test.embedding, "embed");
    const read = test.records.listSearchFragmentKeys.bind(test.records), before = test.database.serialize();
    vi.spyOn(test.records, "listSearchFragmentKeys").mockImplementationOnce((...args) => {
      const batch = read(...args); void yieldToEventLoop().then(() => test.service.abandonSearchQuery(query.sessionId)); return batch;
    });
    await expect(test.service.executeSearchQuery(query.sessionId, {})).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    expect(embed).not.toHaveBeenCalled();
    const next = await test.service.prepareSearchQuery({ text: "取消后完整合成查询" });
    const result = await test.service.executeSearchQuery(next.sessionId, {});
    expect(details).toHaveBeenCalledTimes(2);
    expect(result.capabilities.indexCoverage).toEqual({ currentFragments: 2, expectedFragments: 2, outdatedFragments: 0 });
    expect(test.database.serialize().equals(before)).toBe(true);
  });

  it.each(["cancel", "edit"] as const)("does not publish a keyword fallback during a cooperative recheck (%s)", async (action) => {
    const test = await fixture(), query = await test.service.prepareSearchQuery({ text: "合成薪酬争议" });
    let failed = false, expectedBytes: Buffer | undefined;
    vi.spyOn(test.embedding, "embed").mockImplementationOnce(async () => {
      failed = true;
      test.database.prepare("INSERT INTO workspace_settings(key, value_json, updated_at) VALUES ('fallback-check-test', 'true', ?)")
        .run(new Date().toISOString());
      throw new AppError("EMBEDDING_UNAVAILABLE", "合成向量错误", true);
    });
    const read = test.records.getSearchRecords.bind(test.records);
    vi.spyOn(test.records, "getSearchRecords").mockImplementation((ids) => {
      const result = read(ids);
      if (failed) void yieldToEventLoop().then(() => {
        if (action === "cancel") test.service.abandonSearchQuery(query.sessionId);
        else test.database.prepare("UPDATE redesign_sources SET text = '回退校验期间更新合成原文' WHERE record_id = ?").run(test.recordId);
        expectedBytes = test.database.serialize();
      });
      return result;
    });
    await expect(test.service.executeSearchQuery(query.sessionId, {})).rejects.toMatchObject({
      code: action === "cancel" ? "SOURCE_UNAVAILABLE" : "REVISION_CONFLICT"
    });
    expect(expectedBytes).toBeDefined(); expect(test.database.serialize().equals(expectedBytes!)).toBe(true);
    await expect(test.service.executeSearchQuery(query.sessionId, {})).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
  });

  it("rechecks a microtask commit after asynchronous snapshot validation before calling the model", async () => {
    const test = await fixture(), query = await test.service.prepareSearchQuery({ text: "异步返回窗口合成查询" });
    const keys = test.records.iterateSearchFragmentKeyBatches.bind(test.records);
    let scanned = false, checksAfterScan = 0;
    vi.spyOn(test.records, "iterateSearchFragmentKeyBatches").mockImplementation(function* (id) { yield* keys(id); scanned = true; });
    const version = test.records.getSearchProjectionVersion.bind(test.records);
    vi.spyOn(test.records, "getSearchProjectionVersion").mockImplementation(() => {
      const result = version();
      if (scanned && ++checksAfterScan === 2) globalThis.queueMicrotask(() => {
        test.database.prepare("UPDATE redesign_sources SET text = '异步返回后的合成修改' WHERE record_id = ?").run(test.recordId);
      });
      return result;
    });
    const embed = vi.spyOn(test.embedding, "embed");
    await expect(test.service.executeSearchQuery(query.sessionId, {})).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(embed).not.toHaveBeenCalled();
  });

  it("does not publish cached pagination when a microtask changes its projection after validation", async () => {
    const test = await fixture(); await test.seed("另一条合成权益记录"); await buildQueuedProjection(test);
    const query = await test.service.prepareSearchQuery({ text: "合成语义探针" });
    const first = await test.service.executeSearchQuery(query.sessionId, { limit: 1 });
    const version = test.records.getSearchProjectionVersion.bind(test.records);
    vi.spyOn(test.records, "getSearchProjectionVersion").mockImplementationOnce(() => {
      const result = version(); globalThis.queueMicrotask(() => {
        test.database.prepare("UPDATE redesign_sources SET text = '分页异步返回后的合成修改' WHERE record_id = ?").run(test.recordId);
      }); return result;
    });
    await expect(test.service.executeSearchQuery(query.sessionId, { limit: 1, cursor: first.nextCursor! }))
      .rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  });

  it("captures the model configuration epoch before a cooperative cold scan while the adapter stays configured", async () => {
    let epoch = 0;
    const test = await fixture({ beginModelOperation: () => {
      const expected = epoch;
      return () => { if (expected !== epoch) throw new AppError("LLM_CONFIGURATION_CHANGED", "合成模型配置已变化", true); };
    } });
    const query = await test.service.prepareSearchQuery({ text: "配置代次合成查询" }), before = test.database.serialize();
    const embed = vi.spyOn(test.embedding, "embed"), read = test.records.getSearchRecords.bind(test.records);
    vi.spyOn(test.records, "getSearchRecords").mockImplementationOnce((ids) => {
      const result = read(ids); void yieldToEventLoop().then(() => { epoch += 1; }); return result;
    });
    await expect(test.service.executeSearchQuery(query.sessionId, {})).rejects.toMatchObject({ code: "LLM_CONFIGURATION_CHANGED" });
    expect(test.embedding.isConfigured?.()).toBe(true); expect(embed).not.toHaveBeenCalled();
    expect(test.database.serialize().equals(before)).toBe(true);
  });

  it.each(["local", "external"] as const)("does not lose an index update committed during scheduling (%s)", async (connection) => {
    const test = await fixture({ disk: true });
    const other = new Database(join(test.directory, "synthetic.sqlite3")); cleanups.push(() => { other.close(); });
    const writer = connection === "local" ? test.database : other;
    const read = test.records.getSearchRecords.bind(test.records);
    const reads = vi.spyOn(test.records, "getSearchRecords").mockImplementationOnce((ids) => {
      const details = read(ids);
      writer.prepare("UPDATE redesign_sources SET text = ?, content_hash = ? WHERE record_id = ?")
        .run("调度读取后更新的合成材料", "d".repeat(64), test.recordId);
      return details;
    });
    const embed = vi.spyOn(test.embedding, "embed");
    const jobId = await test.service.ensureSearchIndexJob();
    expect(jobId).toBeTypeOf("string");
    expect(reads).toHaveBeenCalledTimes(2);
    expect(await test.service.ensureSearchIndexJob()).toBe(jobId);
    expect(test.jobs.list().filter(({ type, state }) => type === "record.search-index-rebuild" && state === "queued")).toHaveLength(1);
    expect(embed).not.toHaveBeenCalled();
    await buildQueuedProjection(test);
    const query = await test.service.prepareSearchQuery({ text: "合成语义探针" });
    expect((await test.service.executeSearchQuery(query.sessionId, {})).capabilities.indexCoverage)
      .toEqual({ currentFragments: 2, expectedFragments: 2, outdatedFragments: 0 });
  });

  it("rechecks an unrelated scheduling-time write without creating a paid rebuild", async () => {
    const test = await fixture(), read = test.records.getSearchRecords.bind(test.records);
    const reads = vi.spyOn(test.records, "getSearchRecords").mockImplementationOnce((ids) => {
      const details = read(ids);
      test.database.prepare("INSERT INTO workspace_settings(key, value_json, updated_at) VALUES ('synthetic-scheduling-unrelated', 'true', ?)")
        .run(new Date().toISOString());
      return details;
    });
    expect(await test.service.ensureSearchIndexJob()).toBeUndefined();
    expect(reads).toHaveBeenCalledTimes(2);
    expect(test.records.listSearchGenerations()).toHaveLength(1);
    expect(test.jobs.list().some(({ type }) => type === "record.search-index-rebuild")).toBe(false);
  });

  it("bounds scheduling retries and coalesces a read-only check before rebuilding unstable formal content", async () => {
    const test = await fixture(), read = test.records.getSearchRecords.bind(test.records);
    let changes = 0;
    const reads = vi.spyOn(test.records, "getSearchRecords").mockImplementation((ids) => {
      const details = read(ids);
      test.database.prepare("UPDATE redesign_sources SET text = ?, content_hash = ? WHERE record_id = ?")
        .run(`调度期间连续更新的合成材料-${++changes}`, String(changes).padStart(64, "0"), test.recordId);
      return details;
    });
    const jobId = await test.service.ensureSearchIndexJob();
    expect(jobId).toBeTypeOf("string"); expect(reads).toHaveBeenCalledTimes(2);
    expect(await test.service.ensureSearchIndexJob()).toBe(jobId); expect(reads).toHaveBeenCalledTimes(2);
    expect(test.records.listSearchGenerations()).toHaveLength(1);
    expect(test.jobs.list().filter(({ type, state }) => type === "record.search-index-check" && state === "queued")).toHaveLength(1);
    expect(test.jobs.list().some(({ type }) => type === "record.search-index-rebuild")).toBe(false);
    reads.mockRestore();
    const embed = vi.spyOn(test.embedding, "embed");
    const runner = new JobRunner(test.jobs, { "record.search-index-check": async (_job, context) => {
      await test.service.ensureSearchIndexJob(context.signal, false);
    } }, { pollMs: 10 });
    try {
      runner.start();
      await vi.waitFor(() => expect(test.jobs.list().find(({ id }) => id === jobId)?.state).toBe("succeeded"));
    } finally { await runner.stopAndWait(); }
    expect(test.jobs.list().filter(({ type, state }) => type === "record.search-index-rebuild" && state === "queued")).toHaveLength(1);
    expect(test.records.listSearchGenerations()).toHaveLength(2); expect(embed).not.toHaveBeenCalled();
  });

  it("defers continuous unrelated writes without creating a paid rebuild or recursively queueing checks", async () => {
    const test = await fixture(), read = test.records.getSearchRecords.bind(test.records);
    let changes = 0;
    const reads = vi.spyOn(test.records, "getSearchRecords").mockImplementation((ids) => {
      const details = read(ids);
      test.database.prepare("INSERT INTO workspace_settings(key, value_json, updated_at) VALUES (?, 'true', ?)")
        .run(`synthetic-unrelated-churn-${++changes}`, new Date().toISOString());
      return details;
    });
    const embed = vi.spyOn(test.embedding, "embed");
    const jobId = await test.service.ensureSearchIndexJob();
    expect(jobId).toBeTypeOf("string"); expect(reads).toHaveBeenCalledTimes(2);
    expect(await test.service.ensureSearchIndexJob()).toBe(jobId); expect(reads).toHaveBeenCalledTimes(2);
    await expect(test.service.ensureSearchIndexJob(undefined, false)).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(reads).toHaveBeenCalledTimes(4); expect(test.records.listSearchGenerations()).toHaveLength(1);
    expect(test.jobs.list().filter(({ type }) => type === "record.search-index-check")).toHaveLength(1);
    expect(test.jobs.list().some(({ type }) => type === "record.search-index-rebuild")).toBe(false);
    expect(test.service.getSearchIndexStatus().state).toBe("checking");
    reads.mockRestore();
    const runner = new JobRunner(test.jobs, { "record.search-index-check": async (_job, context) => {
      await test.service.ensureSearchIndexJob(context.signal, false);
    } }, { pollMs: 10 });
    try {
      runner.start();
      await vi.waitFor(() => expect(test.jobs.list().find(({ id }) => id === jobId)?.state).toBe("succeeded"));
    } finally { await runner.stopAndWait(); }
    expect(test.records.listSearchGenerations()).toHaveLength(1);
    expect(test.jobs.list().some(({ type }) => type === "record.search-index-rebuild")).toBe(false);
    expect(test.service.getSearchIndexStatus().state).toBe("ready"); expect(embed).not.toHaveBeenCalled();
  });

  it("honors a pause committed during scheduling instead of creating a late rebuild", async () => {
    const test = await fixture({ disk: true }), other = new Database(join(test.directory, "synthetic.sqlite3"));
    cleanups.push(() => { other.close(); });
    const read = test.records.getSearchRecords.bind(test.records);
    vi.spyOn(test.records, "getSearchRecords").mockImplementationOnce((ids) => {
      const details = read(ids);
      other.prepare("UPDATE redesign_sources SET text = '暂停期间更新的合成材料' WHERE record_id = ?").run(test.recordId);
      other.prepare("UPDATE workspace_settings SET value_json = 'false' WHERE key = 'redesign.search.enabled'").run();
      return details;
    });
    expect(await test.service.ensureSearchIndexJob()).toBeUndefined();
    expect(test.records.listSearchGenerations()).toHaveLength(1);
    expect(test.jobs.list().some(({ type }) => type === "record.search-index-rebuild")).toBe(false);
  });

  it("rechecks the active vector space when another connection replaces it during scheduling", async () => {
    const test = await fixture({ disk: true }), other = new Database(join(test.directory, "synthetic.sqlite3"));
    cleanups.push(() => { other.close(); });
    const otherRecords = new SqliteRecordRepository(other, () => Buffer.alloc(32));
    const read = test.records.getSearchRecords.bind(test.records), replacementId = randomUUID();
    vi.spyOn(test.records, "getSearchRecords").mockImplementationOnce((ids) => {
      const details = read(ids);
      otherRecords.createSearchGeneration({ id: replacementId, adapterIdentity: "synthetic:other-space", adapterVersion: 1,
        dimensions: 2, normalization: "l2", inputModalities: ["text"], state: "building", fragmentCount: 0, createdAt: new Date().toISOString() });
      otherRecords.activateSearchGeneration(replacementId, 0, new Date().toISOString());
      return details;
    });
    const jobId = await test.service.ensureSearchIndexJob(); expect(jobId).toBeTypeOf("string");
    const building = test.records.listSearchGenerations().find(({ state }) => state === "building");
    expect(building?.adapterIdentity).toBe(test.embedding.identity);
    expect(test.jobs.list().find(({ id }) => id === jobId)).toMatchObject({ payload: { generationId: building?.id } });
  });

  it("reuses a rebuild queued by another connection during scheduling", async () => {
    const test = await fixture({ disk: true }), other = new Database(join(test.directory, "synthetic.sqlite3"));
    cleanups.push(() => { other.close(); });
    const otherRecords = new SqliteRecordRepository(other, () => Buffer.alloc(32)), otherJobs = new SqliteJobRepository(other);
    const read = test.records.getSearchRecords.bind(test.records), buildingId = randomUUID();
    let otherJobId = "";
    const reads = vi.spyOn(test.records, "getSearchRecords").mockImplementationOnce((ids) => {
      const details = read(ids);
      otherRecords.createSearchGeneration({ id: buildingId, adapterIdentity: test.embedding.identity,
        adapterVersion: test.embedding.version, dimensions: test.embedding.dimensions, normalization: "l2",
        inputModalities: [...test.embedding.inputModalities], state: "building", fragmentCount: 0, createdAt: new Date().toISOString() });
      otherJobId = otherJobs.enqueue("record.search-index-rebuild", { generationId: buildingId }, new Date().toISOString(), 3).id;
      return details;
    });
    expect(await test.service.ensureSearchIndexJob()).toBe(otherJobId);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(test.jobs.list().filter(({ type, state }) => type === "record.search-index-rebuild" && state === "queued")).toHaveLength(1);
  });

  it.each(["source", "report", "deleted-media"] as const)("rejects a late index response after an external %s commit", async (change) => {
    const test = await fixture({ disk: true, batchSize: 1, ...(change === "deleted-media" ? { media: "png" as const } : {}) });
    const other = new Database(join(test.directory, "synthetic.sqlite3")); cleanups.push(() => { other.close(); });
    const delayed = test.delay(), pending = test.service.rebuildSearchIndex();
    const outcome = pending.then(() => undefined, (error: unknown) => error);
    await delayed.started;
    const failedGeneration = test.records.listSearchGenerations().find(({ state }) => state === "building")!.id;
    if (change === "source") other.prepare("UPDATE redesign_sources SET text = ?, content_hash = ? WHERE record_id = ?")
      .run("等待向量期间由另一连接更新的合成材料", "e".repeat(64), test.recordId);
    if (change === "report") new SqliteRecordRepository(other, () => Buffer.alloc(32)).saveReport({
      id: randomUUID(), recordId: test.recordId, recordRevision: 1, inputHash: "f".repeat(64), promptVersion: "synthetic-external-v1",
      modelProfile: "synthetic:no-network", state: "complete", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      content: { summary: "另一连接保存的合成报告", time: { source: "ai" }, location: { source: "ai" }, people: [], chronology: [],
        unknowns: [], disputes: [], suggestions: [], legalIssues: [], citations: [], coverageNotes: [] }
    });
    if (change === "deleted-media") other.prepare("UPDATE assets SET availability_status = 'deleted', deleted_at = ? WHERE id = ?")
      .run(new Date().toISOString(), test.service.getRecord(test.recordId).attachments[0]!.id);
    delayed.release();
    expect(await outcome).toMatchObject({ code: "REVISION_CONFLICT" });
    expect(test.writes).not.toHaveBeenCalled(); expect(test.activates).not.toHaveBeenCalled();
    expect(test.records.listSearchGenerations().find(({ state }) => state === "active")?.id).toBe(test.originalId);
    expect(test.records.listSearchGenerations().find(({ id }) => id === failedGeneration)).toMatchObject({ state: "failed", lastError: "REVISION_CONFLICT" });
  });

  it("allows unrelated external writes and its own vector writes without repeatedly reading the whole formal corpus", async () => {
    const test = await fixture({ disk: true, batchSize: 1 }), other = new Database(join(test.directory, "synthetic.sqlite3"));
    cleanups.push(() => { other.close(); });
    const reads = vi.spyOn(test.records, "listIndexableRecords"), batches = vi.spyOn(test.records, "iterateIndexableRecordBatches"), delayed = test.delay();
    const pending = test.service.rebuildSearchIndex(); await delayed.started;
    other.prepare("INSERT INTO workspace_settings(key, value_json, updated_at) VALUES ('synthetic-index-unrelated', 'true', ?)")
      .run(new Date().toISOString());
    delayed.release(); const result = await pending;
    expect(result.activeGenerationId).not.toBe(test.originalId);
    expect(test.writes).toHaveBeenCalledTimes(2); expect(test.activates).toHaveBeenCalledTimes(1);
    expect(reads).not.toHaveBeenCalled(); expect(batches).toHaveBeenCalledTimes(3);
  });

  it("rejects a build snapshot changed by another connection during its initial read before calling the model", async () => {
    const test = await fixture({ disk: true }), other = new Database(join(test.directory, "synthetic.sqlite3"));
    cleanups.push(() => { other.close(); });
    const read = test.records.getSearchRecords.bind(test.records);
    vi.spyOn(test.records, "getSearchRecords").mockImplementationOnce((ids) => {
      const details = read(ids);
      other.prepare("UPDATE redesign_sources SET text = ?, content_hash = ? WHERE record_id = ?")
        .run("构建读取后更新的合成材料", "c".repeat(64), test.recordId);
      return details;
    });
    const embed = vi.spyOn(test.embedding, "embed");
    await expect(test.service.rebuildSearchIndex()).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(embed).not.toHaveBeenCalled(); expect(test.writes).not.toHaveBeenCalled(); expect(test.activates).not.toHaveBeenCalled();
    expect(test.records.listSearchGenerations().find(({ state }) => state === "active")?.id).toBe(test.originalId);
  });

  it("does not accept an external snapshot assembled across a second commit while rechecking an unrelated write", async () => {
    const test = await fixture({ disk: true }), other = new Database(join(test.directory, "synthetic.sqlite3"));
    cleanups.push(() => { other.close(); });
    const read = test.records.getSearchRecords.bind(test.records), delayed = test.delay();
    const reads = vi.spyOn(test.records, "getSearchRecords");
    const pending = test.service.rebuildSearchIndex(), outcome = pending.then(() => undefined, (error: unknown) => error);
    await delayed.started;
    other.prepare("INSERT INTO workspace_settings(key, value_json, updated_at) VALUES ('synthetic-second-commit', 'true', ?)")
      .run(new Date().toISOString());
    reads.mockImplementationOnce((ids) => {
      const details = read(ids);
      other.prepare("UPDATE redesign_sources SET text = ?, content_hash = ? WHERE record_id = ?")
        .run("复核读取后更新的合成材料", "b".repeat(64), test.recordId);
      return details;
    });
    delayed.release();
    expect(await outcome).toMatchObject({ code: "REVISION_CONFLICT" });
    expect(reads).toHaveBeenCalledTimes(3); expect(test.writes).not.toHaveBeenCalled(); expect(test.activates).not.toHaveBeenCalled();
  });

  it("keeps a partially written generation inactive after another connection changes formal input", async () => {
    const test = await fixture({ disk: true, batchSize: 1 }), other = new Database(join(test.directory, "synthetic.sqlite3"));
    cleanups.push(() => { other.close(); });
    const write = SqliteRecordRepository.prototype.putSearchEmbeddings.bind(test.records);
    vi.spyOn(test.records, "putSearchEmbeddings").mockImplementationOnce((...args) => {
      write(...args);
      other.prepare("UPDATE redesign_sources SET text = ?, content_hash = ? WHERE record_id = ?")
        .run("首批写入后更新的合成材料", "a".repeat(64), test.recordId);
    });
    await expect(test.service.rebuildSearchIndex()).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(test.writes).toHaveBeenCalledTimes(1); expect(test.activates).not.toHaveBeenCalled();
    expect(test.records.listSearchGenerations().find(({ state }) => state === "active")?.id).toBe(test.originalId);
    expect(test.records.listSearchGenerations().find(({ state }) => state === "failed")?.lastError).toBe("REVISION_CONFLICT");
  });

  it("fences a foreign commit between the final build check and atomic activation", async () => {
    const test = await fixture({ disk: true }), other = new Database(join(test.directory, "synthetic.sqlite3"));
    cleanups.push(() => { other.close(); });
    const activate = SqliteRecordRepository.prototype.activateSearchGeneration.bind(test.records);
    test.activates.mockImplementationOnce((...args) => {
      other.prepare("UPDATE redesign_sources SET text = ?, content_hash = ? WHERE record_id = ?")
        .run("激活前更新的合成材料", "9".repeat(64), test.recordId);
      activate(...args);
    });
    await expect(test.service.rebuildSearchIndex()).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(test.writes).toHaveBeenCalledTimes(2); expect(test.activates).toHaveBeenCalledTimes(1);
    expect(test.records.listSearchGenerations().find(({ state }) => state === "active")?.id).toBe(test.originalId);
    expect(test.records.listSearchGenerations().find(({ state }) => state === "failed")?.lastError).toBe("REVISION_CONFLICT");
  });

  it("accepts an unrelated foreign commit just before activation after rechecking outside the writer lock", async () => {
    const test = await fixture({ disk: true }), other = new Database(join(test.directory, "synthetic.sqlite3"));
    cleanups.push(() => { other.close(); });
    const activate = SqliteRecordRepository.prototype.activateSearchGeneration.bind(test.records);
    const reads = vi.spyOn(test.records, "listIndexableRecords"), batches = vi.spyOn(test.records, "iterateIndexableRecordBatches");
    const read = test.records.getSearchRecords.bind(test.records);
    vi.spyOn(test.records, "getSearchRecords").mockImplementation((ids) => {
      expect(test.database.inTransaction).toBe(false); return read(ids);
    });
    test.activates.mockImplementationOnce((...args) => {
      other.prepare("INSERT INTO workspace_settings(key, value_json, updated_at) VALUES ('synthetic-last-unrelated', 'true', ?)")
        .run(new Date().toISOString());
      activate(...args);
    });
    const result = await test.service.rebuildSearchIndex();
    expect(result.activeGenerationId).not.toBe(test.originalId);
    expect(reads).not.toHaveBeenCalled(); expect(batches).toHaveBeenCalledTimes(3); expect(test.activates).toHaveBeenCalledTimes(2);
    expect(test.records.listSearchGenerations().find(({ state }) => state === "active")?.id).toBe(result.activeGenerationId);
  });

  it("rejects cached pagination when the current SQLite projection changes outside the service", async () => {
    const test = await fixture(); await test.seed("另一条合成权益记录"); await buildQueuedProjection(test);
    const query = await test.service.prepareSearchQuery({ text: "合成语义探针" });
    const first = await test.service.executeSearchQuery(query.sessionId, { limit: 1 });
    expect(first.nextCursor).toBeTypeOf("string");
    test.database.prepare("UPDATE redesign_records SET categories_json = '[\"danger\"]' WHERE id = ?").run(test.recordId);
    const embed = vi.spyOn(test.embedding, "embed");
    await expect(test.service.executeSearchQuery(query.sessionId, { limit: 1, cursor: first.nextCursor! })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(embed).not.toHaveBeenCalled();
  });

  it("rejects a late result after an external projection change but allows unrelated database writes", async () => {
    const test = await fixture();
    const query = await test.service.prepareSearchQuery({ text: "合成语义探针" }), delayed = test.delay();
    const result = test.service.executeSearchQuery(query.sessionId, {});
    const outcome = result.then(() => undefined, (error: unknown) => error);
    await delayed.started;
    test.database.prepare("UPDATE redesign_sources SET text = '等待模型期间更新的合成材料' WHERE record_id = ?").run(test.recordId);
    delayed.release(); expect(await outcome).toMatchObject({ code: "REVISION_CONFLICT" });
    const next = await test.service.prepareSearchQuery({ text: "合成语义探针" }), nextDelay = test.delay();
    const nextResult = test.service.executeSearchQuery(next.sessionId, {});
    await nextDelay.started;
    test.database.prepare("INSERT INTO workspace_settings(key, value_json, updated_at) VALUES ('synthetic-unrelated', 'true', '2026-09-29T00:00:00Z')").run();
    nextDelay.release(); expect((await nextResult).hits).toHaveLength(1);
  });

  it.each(["cancel", "pause", "pause-resume", "record-edit", "new-record", "model-unavailable"] as const)(
    "does not write or activate a late vector response after %s", async (action) => {
      const test = await fixture(), delayed = test.delay(), controller = new AbortController();
      const pending = test.service.rebuildSearchIndex(undefined, controller.signal);
      const outcome = pending.then(() => ({ rejected: false, error: undefined }), (error: unknown) => ({ rejected: true, error }));
      await delayed.started;
      const replacement = test.records.listSearchGenerations().find(({ state }) => state === "building")!;
      if (action === "cancel") controller.abort(new AppError("JOB_STATE_CONFLICT", "Synthetic index cancellation"));
      if (action === "pause" || action === "pause-resume") test.service.setSearchIndexEnabled(false);
      if (action === "pause-resume") test.service.setSearchIndexEnabled(true);
      if (action === "record-edit") await test.service.patchFields(test.recordId, 1, { location: "合成补充地点" });
      if (action === "new-record") await test.seed("另一条合成权益争议");
      if (action === "model-unavailable") test.setConfigured(false);
      delayed.release();
      expect((await outcome).rejected).toBe(true);
      expect(test.writes).not.toHaveBeenCalled(); expect(test.activates).not.toHaveBeenCalled();
      expect(test.records.listSearchGenerations().find(({ state }) => state === "active")?.id).toBe(test.originalId);
      expect(test.records.listSearchGenerations().find(({ id }) => id === replacement.id)?.state).toBe("failed");
      expect(test.records.listSearchFragmentKeys(replacement.id)).toEqual([]);
      if (action === "cancel" || action.startsWith("pause")) expect(test.receivedSignal?.aborted).toBe(true);
      const recovered = await test.restart(replacement.id);
      expect(recovered.activeGenerationId).toBe(replacement.id);
      expect(test.records.listSearchGenerations().find(({ id }) => id === test.originalId)?.state).toBe("superseded");
    }
  );

  it("preserves the cancellation error and never writes a failure to a closed workspace", async () => {
    const test = await fixture(), delayed = test.delay();
    const pending = test.service.rebuildSearchIndex();
    const outcome = pending.then(() => undefined, (error: unknown) => error);
    await delayed.started; test.closeWorkspace(); delayed.release();
    expect(await outcome).toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    expect(test.writes).not.toHaveBeenCalled(); expect(test.activates).not.toHaveBeenCalled(); expect(test.fails).not.toHaveBeenCalled();
    expect(test.receivedSignal?.aborted).toBe(true);
  });

  it("does not create or reset a generation for an already-cancelled request", async () => {
    const test = await fixture(), controller = new AbortController(); controller.abort();
    const before = test.records.listSearchGenerations();
    await expect(test.service.rebuildSearchIndex(undefined, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(test.records.listSearchGenerations()).toEqual(before); expect(test.writes).not.toHaveBeenCalled();
  });

  it("rejects overlapping builds of the same generation without resetting its first worker", async () => {
    const test = await fixture(), delayed = test.delay();
    const pending = test.service.rebuildSearchIndex(); await delayed.started;
    const id = test.records.listSearchGenerations().find(({ state }) => state === "building")!.id;
    const prepare = vi.spyOn(test.records, "prepareSearchGeneration");
    const duplicate = test.service.rebuildSearchIndex(id);
    const outcome = duplicate.then(() => undefined, (error: unknown) => error);
    delayed.release(); await pending;
    expect(await outcome).toMatchObject({ code: "REVISION_CONFLICT" }); expect(prepare).not.toHaveBeenCalled();
    expect(test.records.listSearchGenerations().find(({ state }) => state === "active")?.id).toBe(id);
  });

  it("rejects a late response after a report changes without changing the record revision", async () => {
    const test = await fixture(), delayed = test.delay();
    const outcome = test.service.rebuildSearchIndex().then(() => undefined, (error: unknown) => error);
    await delayed.started;
    await test.service.runAnalysis(test.recordId, 1, { async analyze() {
      return { state: "complete", promptVersion: "synthetic-v1", modelProfile: "synthetic:no-network",
        content: { summary: "合成的新分析报告", time: { source: "ai" }, location: { source: "ai" }, people: [], chronology: [],
          unknowns: [], disputes: [], suggestions: [], legalIssues: [], citations: [], coverageNotes: [] } };
    } });
    expect(test.service.getRecord(test.recordId).record.revision).toBe(1);
    delayed.release(); expect(await outcome).toMatchObject({ code: "REVISION_CONFLICT" });
    expect(test.writes).not.toHaveBeenCalled(); expect(test.activates).not.toHaveBeenCalled();
    expect(test.records.listSearchGenerations().find(({ state }) => state === "active")?.id).toBe(test.originalId);
  });

  it("destroys a source returned after cancellation before sending it to the model", async () => {
    const test = await fixture({ media: "png" }), delayed = gate();
    const source = Readable.from([...test.stored.values()]);
    vi.spyOn(test.vault, "open").mockImplementationOnce(async () => { delayed.begin(); await delayed.done; return source; });
    const embed = vi.spyOn(test.embedding, "embed");
    const outcome = test.service.rebuildSearchIndex().then(() => undefined, (error: unknown) => error);
    await delayed.started; test.service.setSearchIndexEnabled(false); delayed.release();
    expect(await outcome).toMatchObject({ code: "JOB_STATE_CONFLICT" }); expect(source.destroyed).toBe(true);
    expect(embed).not.toHaveBeenCalled(); expect(test.writes).not.toHaveBeenCalled(); expect(test.activates).not.toHaveBeenCalled();
  });

  it("interrupts a stalled source read when paused without waiting for another chunk", async () => {
    const test = await fixture({ media: "png" }), delayed = gate();
    let sent = false;
    const source = new Readable({ read() {
      if (!sent) { sent = true; this.push([...test.stored.values()][0]!.subarray(0, 8)); delayed.begin(); }
    } });
    vi.spyOn(test.vault, "open").mockResolvedValueOnce(source);
    const embed = vi.spyOn(test.embedding, "embed");
    const outcome = test.service.rebuildSearchIndex().then(() => undefined, (error: unknown) => error);
    await delayed.started; test.service.setSearchIndexEnabled(false);
    expect(await outcome).toMatchObject({ code: "JOB_STATE_CONFLICT" }); expect(source.destroyed).toBe(true);
    expect(embed).not.toHaveBeenCalled(); expect(test.writes).not.toHaveBeenCalled(); expect(test.activates).not.toHaveBeenCalled();
  });

  it.each(["digest", "length"] as const)("verifies a PNG source's %s before embedding", async (mode) => {
    const test = await fixture({ media: "png" });
    const [hash, original] = [...test.stored.entries()][0]!;
    const corrupt = mode === "length" ? original.subarray(0, original.length - 1) : Buffer.from(original).fill(7, 16);
    test.stored.set(hash, corrupt);
    const embed = vi.spyOn(test.embedding, "embed");
    await expect(test.service.rebuildSearchIndex()).rejects.toMatchObject({ code: "ASSET_CORRUPT" });
    expect(embed).not.toHaveBeenCalled(); expect(test.writes).not.toHaveBeenCalled(); expect(test.activates).not.toHaveBeenCalled();
    expect(test.records.listSearchGenerations().find(({ state }) => state === "active")?.id).toBe(test.originalId);
    expect(test.fails).toHaveBeenCalledWith(expect.any(String), "ASSET_CORRUPT");
  });

  it("rejects a late HEIC conversion after pause and resume without sending its raster to the model", async () => {
    const converter: NativeImageConversionPort = { async convert() {
      return { bytes: Buffer.from("synthetic-raster"), mimeType: "image/png", width: 32, height: 32 };
    } };
    const test = await fixture({ media: "heic", converter }), delayed = gate();
    let conversionSignal: AbortSignal | undefined;
    vi.spyOn(converter, "convert").mockImplementationOnce(async (_input, signal) => {
      conversionSignal = signal; delayed.begin(); await delayed.done;
      return { bytes: Buffer.from("synthetic-late-raster"), mimeType: "image/png", width: 32, height: 32 };
    });
    const embed = vi.spyOn(test.embedding, "embed");
    const outcome = test.service.rebuildSearchIndex().then(() => undefined, (error: unknown) => error);
    await delayed.started; test.service.setSearchIndexEnabled(false); test.service.setSearchIndexEnabled(true); delayed.release();
    expect(await outcome).toMatchObject({ code: "JOB_STATE_CONFLICT" }); expect(conversionSignal?.aborted).toBe(true);
    expect(embed).not.toHaveBeenCalled(); expect(test.writes).not.toHaveBeenCalled(); expect(test.activates).not.toHaveBeenCalled();
    expect([...test.stored.values()].some((bytes) => bytes.includes(Buffer.from("raster")))).toBe(false);
  });

  it("keeps a partially written generation inactive and clears its fragments before retry", async () => {
    const test = await fixture({ batchSize: 1 }); await test.seed("第二条合成权益记录");
    const delayed = gate(); let calls = 0;
    vi.spyOn(test.embedding, "embed").mockImplementation(async (inputs) => {
      if (++calls === 2) { delayed.begin(); await delayed.done; }
      return inputs.map(() => new Float32Array([1, 0]));
    });
    const controller = new AbortController();
    const queuedId = test.records.listSearchGenerations().find(({ state }) => state === "building")!.id;
    const outcome = test.service.rebuildSearchIndex(queuedId, controller.signal).then(() => undefined, (error: unknown) => error);
    await delayed.started;
    const replacement = test.records.listSearchGenerations().find(({ state }) => state === "building")!;
    expect(test.writes).toHaveBeenCalledTimes(1); expect(test.records.listSearchFragmentKeys(replacement.id)).toHaveLength(1);
    controller.abort(); delayed.release(); expect(await outcome).toMatchObject({ name: "AbortError" });
    expect(test.writes).toHaveBeenCalledTimes(1); expect(test.activates).not.toHaveBeenCalled();
    expect(test.records.listSearchGenerations().find(({ state }) => state === "active")?.id).toBe(test.originalId);
    expect((await test.restart(replacement.id)).activeGenerationId).toBe(replacement.id);
    const fragments = test.records.listSearchFragmentKeys(replacement.id);
    expect(fragments).toHaveLength(4); expect(new Set(fragments.map(({ id }) => id)).size).toBe(fragments.length);
  });

  it.each(["identity", "inputModalities"] as const)("rejects an adapter %s change during a response", async (field) => {
    const test = await fixture(), delayed = test.delay();
    const outcome = test.service.rebuildSearchIndex().then(() => undefined, (error: unknown) => error);
    await delayed.started; Object.defineProperty(test.embedding, field, { value: field === "identity" ? "synthetic:changed" : ["image"], configurable: true });
    delayed.release(); expect(await outcome).toMatchObject({ code: "REVISION_CONFLICT" });
    expect(test.writes).not.toHaveBeenCalled(); expect(test.activates).not.toHaveBeenCalled();
  });
});
