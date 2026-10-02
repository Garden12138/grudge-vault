import Database from "better-sqlite3";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { RedesignService, type ObjectVaultPort, type RecordEmbeddingPort } from "@grudge-vault/application";
import {
  runMigrations, SqliteAssetRepository, SqliteJobRepository, SqliteRecordRepository
} from "@grudge-vault/persistence-sqlite";

const benchmark = process.env.GV_RUN_LOCAL_BENCH === "1" ? it : it.skip;
const elapsedMs = (start: bigint): number => Number(process.hrtime.bigint() - start) / 1_000_000;
const p95 = (samples: number[]): number => [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1]!;

describe("local 10k-record / 50k-fragment benchmark", () => {
  benchmark("measures ephemeral calendar projection on 10k mixed-precision records", () => {
    const database = new Database(":memory:"); runMigrations(database);
    const records = new SqliteRecordRepository(database, () => Buffer.alloc(32));
    const stamp = "2026-09-20T00:30:00Z";
    const insert = database.prepare(`INSERT INTO redesign_records(id, origin, categories_json, title, summary, revision,
      occurred_at_json, recorded_at, report_state, source_updated, created_at, updated_at)
      VALUES (?, 'manual', '["rights"]', '合成日期性能', '', 1, ?, ?, 'complete', 0, ?, ?)`);
    const source = database.prepare(`INSERT INTO redesign_sources(id, record_id, origin, source_version, content_hash,
      text, recorded_at, created_at) VALUES (?, ?, 'manual', 'v1', ?, '合成日期性能', ?, ?)`);
    const fts = database.prepare(`INSERT INTO redesign_record_fts(record_id, title, source_text, report_text, user_text)
      VALUES (?, '合成日期性能', '合成日期性能', '', '')`);
    const times = [{ kind: "instant", value: stamp }, { kind: "month", value: "2026-09" },
      { kind: "range", from: "2026-09-10", to: "2026-09-20" }, { kind: "unknown" }];
    const withReports = process.env.GV_DATE_BENCH_REPORTS === "1";
    const report = database.prepare(`INSERT INTO redesign_reports(id, record_id, record_revision, input_hash, prompt_version,
      model_profile, content_json, state, created_at, updated_at) VALUES (?, ?, 1, ?, 'synthetic-date-bench', 'synthetic:model', ?, 'complete', ?, ?)`);
    const reportTimes = [{ source: "ai", value: { value: stamp, precision: "exact" } },
      { source: "ai", value: { value: "约2026-09", precision: "approximate" } },
      { source: "ai", value: { value: "2026-09-10至2026-09-20", precision: "range" } }, { source: "ai" }];
    const reportBodies = reportTimes.map((time) => JSON.stringify({ time, summary: "合成日期性能", location: { source: "ai" }, people: [],
      chronology: [], unknowns: Array.from({ length: 6 }, () => "合成材料待核对".repeat(50)), disputes: [], suggestions: [],
      legalIssues: [], citations: [], coverageNotes: [] }));
    try {
      database.transaction(() => {
        for (let index = 0; index < 10_000; index++) {
          const id = `date-bench-${String(index).padStart(5, "0")}`;
          insert.run(id, JSON.stringify(times[index % times.length]), stamp, stamp, stamp);
          source.run(`source-${id}`, id, "a".repeat(64), stamp, stamp); fts.run(id);
          if (withReports) report.run(`report-${id}`, id, "a".repeat(64), reportBodies[index % reportBodies.length], stamp, stamp);
        }
      })();
      const timeline: number[] = []; const keyword: number[] = [];
      const filter = { from: "2026-09-20", to: "2026-09-20", timeZone: "America/Los_Angeles", limit: 30 };
      for (let index = 0; index < 25; index++) {
        let start = process.hrtime.bigint(); const page = records.listTimeline(filter);
        timeline.push(elapsedMs(start)); expect(page.records).toHaveLength(30);
        expect(page.records.every(({ occurredAt }) => occurredAt.kind === "month" || occurredAt.kind === "range")).toBe(true);
        start = process.hrtime.bigint(); const found = records.search({ text: "合成日期性能", ...filter });
        keyword.push(elapsedMs(start)); expect(found.hits).toHaveLength(30);
        expect(found.hits.every(({ record }) => record.occurredAt.kind === "month" || record.occurredAt.kind === "range")).toBe(true);
      }
      console.info(JSON.stringify({ records: 10_000, precisionKinds: 4, withReports, reportBytes: withReports ? Buffer.byteLength(reportBodies[0]!) : 0,
        iterations: 25, timeZone: filter.timeZone,
        timelineP95Ms: p95(timeline), keywordP95Ms: p95(keyword), architecture: process.arch, platform: process.platform }));
    } finally { database.close(); }
  }, 30_000);

  benchmark("measures repository queries and complete local semantic recall plus ranking", async () => {
    const benchmarkStart = process.hrtime.bigint();
    const phase = (name: string) => console.info(JSON.stringify({ benchmarkPhase: name, elapsedMs: elapsedMs(benchmarkStart) }));
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    runMigrations(database);
    const records = new SqliteRecordRepository(database, () => Buffer.alloc(32));
    const recordedAt = "2026-09-21T00:00:00.000Z";
    const insertRecord = database.prepare(`
      INSERT INTO redesign_records(id, origin, categories_json, title, summary, revision,
        occurred_at_json, recorded_at, report_state, source_updated, created_at, updated_at)
      VALUES (?, 'manual', '["rights"]', ?, ?, 1, '{"kind":"date","value":"2026-09-21"}',
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
    const insertReport = database.prepare(`INSERT INTO redesign_reports(id, record_id, record_revision, input_hash, prompt_version,
      model_profile, content_json, state, created_at, updated_at)
      VALUES (?, ?, 1, ?, 'synthetic-search-bench-v1', 'synthetic:model', ?, 'complete', ?, ?)`);
    const reportBody = JSON.stringify({ summary: "合成本地基准报告", time: { source: "ai" }, location: { source: "ai" }, people: [],
      chronology: [{ id: "synthetic-step-one", text: "合成片段一", anchor: { sourceVersion: "v1", textRange: [0, 3] } },
        { id: "synthetic-step-two", text: "合成片段二", anchor: { sourceVersion: "v1", textRange: [3, 6] } }],
      unknowns: [], disputes: [], suggestions: [], legalIssues: [], citations: [], coverageNotes: [] });
    database.transaction(() => {
      for (let index = 0; index < 10_000; index += 1) {
        const id = `bench-${String(index).padStart(5, "0")}`;
        const title = index % 100 === 0 ? `奖金争议 benchmark ${index}` : `事件记录 ${index}`;
        const body = index % 100 === 0 ? "奖金未付，需核对约定 benchmark" : "普通结构化搜索样本";
        insertRecord.run(id, title, body, recordedAt, recordedAt, recordedAt);
        insertSource.run(`source-${id}`, id, "a".repeat(64), body, recordedAt, recordedAt);
        insertFts.run(id, title, body);
        insertReport.run(`report-${id}`, id, "a".repeat(64), reportBody, recordedAt, recordedAt);
      }
    })();
    phase("records-and-reports-seeded");
    database.prepare(`
      INSERT INTO redesign_search_generations(id, adapter_identity, adapter_version, dimensions,
        input_modalities_json, state, fragment_count, created_at, activated_at, normalization)
      VALUES ('bench-generation', 'bench', 1, 1024, '["text"]', 'building', 0, ?, NULL, 'l2')
    `).run(recordedAt);
    records.setSearchIndexEnabled(true, recordedAt);
    const embedding: RecordEmbeddingPort = {
      identity: "bench", version: 1, dimensions: 1024, normalization: "l2",
      inputModalities: ["text"],
      async embed(inputs) { return inputs.map(() => new Float32Array(1024).fill(1 / 32)); }
    };
    const vault = {} as ObjectVaultPort;
    const service = new RedesignService(() => ({
      key: Buffer.alloc(32), records,
      assets: new SqliteAssetRepository(database), jobs: new SqliteJobRepository(database),
      // Text-only search never opens or writes objects in the vault.
      vault
    }), embedding);
    // Five real current fragments per record: source, card, report fields, and two anchored steps.
    await service.rebuildSearchIndex("bench-generation");
    phase("current-fragments-built");
    expect(records.listSearchGenerations().find(({ id }) => id === "bench-generation")?.fragmentCount).toBe(50_000);

    const baselineMemory = process.memoryUsage();
    let peakRss = baselineMemory.rss;
    let peakHeap = baselineMemory.heapUsed;
    const sampleMemory = (): void => {
      const { rss, heapUsed } = process.memoryUsage();
      peakRss = Math.max(peakRss, rss);
      peakHeap = Math.max(peakHeap, heapUsed);
    };
    const memorySampler = setInterval(sampleMemory, 25);
    const eventLoop = monitorEventLoopDelay({ resolution: 10 });
    try {
      const timeline: number[] = [];
      const keyword: number[] = [];
      const vectorScan: number[] = [];
      for (let iteration = 0; iteration < 25; iteration += 1) {
        let start = process.hrtime.bigint();
        expect(records.listTimeline({ limit: 30 }).records).toHaveLength(30);
        timeline.push(elapsedMs(start));
        start = process.hrtime.bigint();
        expect(records.search({ text: "benchmark", limit: 30 }).hits).toHaveLength(30);
        keyword.push(elapsedMs(start));
      }
      phase("repository-warm-queries-complete");
      for (let iteration = 0; iteration < 5; iteration += 1) {
        const start = process.hrtime.bigint();
        let cursor: string | undefined;
        let count = 0;
        let dot = 0;
        while (true) {
          const page = records.listSearchEmbeddings("bench-generation", cursor, 512);
          for (const item of page) {
            count += 1;
            dot += item.vector[0] ?? 0;
          }
          if (page.length < 512) break;
          cursor = page.at(-1)!.fragment.id;
        }
        expect(count).toBe(50_000);
        expect(dot).toBeGreaterThan(0);
        vectorScan.push(elapsedMs(start));
      }
      phase("complete-vector-scans-complete");
      // Report the first current-projection validation separately; the specification's P95 is warm-cache.
      eventLoop.enable(); eventLoop.reset();
      const coldQuery = await service.prepareSearchQuery({ text: "语义性能探针" }), coldStart = process.hrtime.bigint();
      const coldResult = await service.executeSearchQuery(coldQuery.sessionId, { limit: 30 });
      const semanticColdStartMs = elapsedMs(coldStart);
      expect(coldResult.capabilities.indexCoverage).toEqual({ currentFragments: 50_000, expectedFragments: 50_000, outdatedFragments: 0 });
      const coldEventLoopP95DelayMs = eventLoop.percentile(95) / 1_000_000;
      const coldEventLoopMaxDelayMs = eventLoop.max / 1_000_000;
      service.abandonSearchQuery(coldQuery.sessionId); sampleMemory();
      eventLoop.reset();
      const semanticRecallAndRank: number[] = [];
      for (let iteration = 0; iteration < 20; iteration += 1) {
        const query = await service.prepareSearchQuery({ text: "语义性能探针" });
        const start = process.hrtime.bigint();
        const result = await service.executeSearchQuery(query.sessionId, { limit: 30 });
        expect(result.hits).toHaveLength(30);
        expect(result.nextCursor).toBeTypeOf("string");
        expect(result.capabilities.semantic).toBe("ready");
        expect(result.capabilities.indexCoverage).toEqual({ currentFragments: 50_000, expectedFragments: 50_000, outdatedFragments: 0 });
        semanticRecallAndRank.push(elapsedMs(start));
        console.info(JSON.stringify({ benchmarkPhase: "semantic-recall-and-rank", iteration, elapsedMs: elapsedMs(start) }));
        sampleMemory();
        service.abandonSearchQuery(query.sessionId);
      }
      sampleMemory();
      console.info(JSON.stringify({ records: 10_000, fragments: 50_000, dimensions: 1024,
        timelineP95Ms: p95(timeline), keywordP95Ms: p95(keyword), vectorScanP95Ms: p95(vectorScan),
        semanticColdStartMs, semanticWarmIterations: semanticRecallAndRank.length, semanticRecallAndRankP95Ms: p95(semanticRecallAndRank),
        coldEventLoopP95DelayMs, coldEventLoopMaxDelayMs,
        warmEventLoopP95DelayMs: eventLoop.percentile(95) / 1_000_000,
        warmEventLoopMaxDelayMs: eventLoop.max / 1_000_000,
        rssBaselineMiB: +(baselineMemory.rss / 2 ** 20).toFixed(1), peakRssMiB: +(peakRss / 2 ** 20).toFixed(1),
        heapBaselineMiB: +(baselineMemory.heapUsed / 2 ** 20).toFixed(1), peakHeapMiB: +(peakHeap / 2 ** 20).toFixed(1),
        architecture: process.arch, platform: process.platform }));
    } finally {
      eventLoop.disable();
      clearInterval(memorySampler);
      database.close();
    }
  }, 180_000);
});
