import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { _electron as electron, expect, test, type JSHandle, type Page } from "@playwright/test";
import { RedesignService, type ObjectVaultPort } from "../../packages/application/src/index";
import { SqliteAssetRepository, SqliteJobRepository, SqliteRecordRepository } from "../../packages/persistence-sqlite/src/index";
import { LocalWorkspaceManager } from "../../apps/desktop/src/main/workspace-manager";
import { coldSearchEmbedding, type ColdSearchObservation } from "../../apps/desktop/src/e2e/cold-search-observer";
import { armSearchFeedback, beginFeedbackTrace, finishFeedbackTrace, type FeedbackObservation } from "./search-feedback";
import { focusDesktop } from "./ui-helpers";

const recordCount = 10_000, fragmentCount = 50_000;
// Windows runners take longer to seed and persist this large vector corpus.
// UI and cancellation assertions keep their own short deadlines.
const corpusTestTimeout = process.platform === "win32" ? 420_000 : 180_000;
const fullIndexWriteTimeout = process.platform === "win32" ? 240_000 : 45_000;
const freshObservation = (): ColdSearchObservation => ({ armed: true, detailBatches: 0, details: 0, keyBatches: 0,
  keys: 0, embeddingCalls: 0, embeddingInputs: 0, started: 0, completed: 0, outcomes: [] });
type Desktop = Awaited<ReturnType<typeof electron.launch>>;
const observationHandles = new WeakMap<Desktop, JSHandle<ColdSearchObservation>>();
async function armColdObservation(desktop: Desktop): Promise<void> {
  await observationHandles.get(desktop)?.dispose();
  observationHandles.set(desktop, await desktop.evaluateHandle((_, value) => {
    (globalThis as typeof globalThis & { __gvE2eColdSearch?: ColdSearchObservation }).__gvE2eColdSearch = value;
    return value;
  }, freshObservation()));
}

async function readObservedProperties(handle: JSHandle<unknown>, array = false): Promise<unknown> {
  // Runtime.getProperties reads data descriptors without invoking JavaScript
  // or creating inspector promises while native index writes are in progress.
  const properties = await handle.getProperties();
  // These are the only array fields in the aggregate schema. An empty array
  // has no enumerable descriptors, just like a primitive value.
  if (properties.size === 0) return array ? [] : handle.jsonValue();
  try {
    const entries = await Promise.all([...properties].map(async ([name, value]) =>
      [name, await readObservedProperties(value, name === "outcomes" || name === "detailPasses")] as const));
    return array
      ? entries.sort(([a], [b]) => Number(a) - Number(b)).map(([, value]) => value)
      : Object.fromEntries(entries);
  } finally {
    await Promise.all([...properties.values()].map(value => value.dispose()));
  }
}

async function readColdObservation(desktop: Desktop): Promise<ColdSearchObservation> {
  const handle = observationHandles.get(desktop);
  if (!handle) throw new Error("Cold observation must be armed before reading.");
  return await readObservedProperties(handle) as ColdSearchObservation;
}

async function waitForSearchStartup(page: Page): Promise<void> {
  // Setup is not the measured search/check boundary. Async startup can be checking without a job.
  // Wait for actual quiescence, then a separate external commit forces the measured cold read.
  await expect.poll(() => page.evaluate(async () => {
    const [jobs, index] = await Promise.all([window.grudgeVault.jobs.list(), window.grudgeVault.records.searchIndexStatus()]);
    return jobs.ok && index.ok && index.data.state === "ready" &&
      !jobs.data.some(({ state }) => state === "queued" || state === "running");
  }), { timeout: 30_000 }).toBe(true);
}

async function seedLargeSearch(workspace: string, recentPath: string): Promise<void> {
  const manager = new LocalWorkspaceManager({
    async assertAvailable() {}, async protect(key) { return `e2e:${key.toString("base64")}`; },
    async unprotect(envelope) { return { key: Buffer.from(envelope.slice(4), "base64") }; }
  }, recentPath);
  try {
    await manager.create(workspace, "合成大库取消测试");
    await manager.updateSecuritySettings({ autoLockMinutes: 0, integrityScanIntervalDays: 30 });
  } finally { await manager.close(); }
  const database = new Database(join(workspace, "db/grudge-vault.sqlite3"));
  database.pragma("foreign_keys = ON");
  const stamp = "2026-10-02T00:00:00.000Z";
  try {
    const insert = database.prepare(`INSERT INTO redesign_records(id, origin, categories_json, title, summary, revision,
      occurred_at_json, recorded_at, report_state, source_updated, created_at, updated_at)
      VALUES (?, 'manual', '["rights"]', ?, '合成奖金样本', 1, '{"kind":"date","value":"2026-10-02"}', ?, 'complete', 0, ?, ?)`);
    const source = database.prepare(`INSERT INTO redesign_sources(id, record_id, origin, source_version, content_hash, text,
      recorded_at, created_at) VALUES (?, ?, 'manual', 'v1', ?, '合成奖金样本：需核对约定', ?, ?)`);
    const fts = database.prepare(`INSERT INTO redesign_record_fts(record_id, title, source_text, report_text, user_text)
      VALUES (?, ?, '合成奖金样本：需核对约定', '', '')`);
    const report = database.prepare(`INSERT INTO redesign_reports(id, record_id, record_revision, input_hash, prompt_version,
      model_profile, content_json, state, created_at, updated_at) VALUES (?, ?, 1, ?, 'synthetic-cold-search-v1', 'synthetic:model', ?, 'complete', ?, ?)`);
    const body = JSON.stringify({ summary: "合成本地取消测试报告", time: { source: "ai" }, location: { source: "ai" }, people: [],
      chronology: [{ id: "synthetic-step-one", text: "合成片段一", anchor: { sourceVersion: "v1", textRange: [0, 3] } },
        { id: "synthetic-step-two", text: "合成片段二", anchor: { sourceVersion: "v1", textRange: [3, 6] } }],
      unknowns: [], disputes: [], suggestions: [], legalIssues: [], citations: [], coverageNotes: [] });
    database.transaction(() => {
      for (let index = 0; index < recordCount; index++) {
        const id = `cold-search-${String(index).padStart(5, "0")}`, title = `合成权益记录 ${index}`;
        insert.run(id, title, stamp, stamp, stamp); source.run(`source-${id}`, id, "a".repeat(64), stamp, stamp);
        fts.run(id, title); report.run(`report-${id}`, id, "a".repeat(64), body, stamp, stamp);
      }
    })();
    const records = new SqliteRecordRepository(database, () => Buffer.alloc(32));
    records.setSearchIndexEnabled(true, stamp);
    const vault = {} as ObjectVaultPort;
    const service = new RedesignService(() => ({ key: Buffer.alloc(32), records, assets: new SqliteAssetRepository(database),
      jobs: new SqliteJobRepository(database), vault }), coldSearchEmbedding);
    const built = await service.rebuildSearchIndex();
    expect(built.fragmentCount).toBe(fragmentCount);
  } finally { database.close(); }
}

// Only the generated fixture is read. Digest comparisons include vector BLOBs, not just row counts.
function formalSnapshot(workspace: string, generationId?: string): Record<string, { count: number; sha256: string }> {
  const database = new Database(join(workspace, "db/grudge-vault.sqlite3"), { readonly: true });
  try {
    return Object.fromEntries(["redesign_records", "redesign_sources", "redesign_reports", "redesign_field_overrides",
      "redesign_pending_reviews", "redesign_search_generations", "redesign_search_embeddings",
      "redesign_record_fts", "assets", "workspace_settings"].map((table) => {
      const hash = createHash("sha256"); let count = 0;
      const statement = database.prepare(`SELECT * FROM ${table}${table === "redesign_search_embeddings" && generationId ? " WHERE generation_id = ?" : ""} ORDER BY rowid`);
      const rows = table === "redesign_search_embeddings" && generationId ? statement.iterate(generationId) : statement.iterate();
      for (const row of rows as Iterable<Record<string, unknown>>) {
        for (const [key, value] of Object.entries(row)) {
          hash.update(JSON.stringify(key));
          if (Buffer.isBuffer(value)) { hash.update(`binary:${value.length}:`); hash.update(value); }
          else hash.update(JSON.stringify(value));
          hash.update("\n");
        }
        hash.update("end-row\n"); count++;
      }
      return [table, { count, sha256: hash.digest("hex") }];
    }));
  } finally { database.close(); }
}

function databaseSnapshot(workspace: string): { byteLength: number; sha256: string } {
  const database = new Database(join(workspace, "db/grudge-vault.sqlite3"), { readonly: true });
  try {
    const bytes = database.serialize();
    return { byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  } finally { database.close(); }
}

// The extended budget covers building a real 10k/50k fixture; other E2E timeouts are unchanged.
// eslint-disable-next-line no-empty-pattern
test("cancels a real cold 10k-record search from the UI before embedding and can search the full index afterwards", async ({}, testInfo) => {
  test.setTimeout(corpusTestTimeout);
  const root = await mkdtemp(join(tmpdir(), "grudge-vault-cold-search-e2e-"));
  const workspace = join(root, "workspace"), userData = join(root, "user-data");
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await seedLargeSearch(workspace, join(root, "seed-recent.json"));
    const environment = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined));
    application = await electron.launch({ args: [resolve("apps/desktop/out-e2e/main/main.js"), `--user-data-dir=${userData}`],
      env: { ...environment, GRUDGE_VAULT_E2E_WORKSPACE: workspace, GRUDGE_VAULT_E2E_NO_NETWORK: "1",
        GRUDGE_VAULT_E2E_COLD_SEARCH_FLOW: "1" } });
    const desktop = application, page = await desktop.firstWindow();
    await expect(page.locator(".new-record-button")).toBeVisible();
    // Finish the normal empty-settings initialization before the read-only search boundary.
    // Otherwise the first auxiliary capability check legitimately initializes settings and rechecks the projection.
    expect(await page.evaluate(() => window.grudgeVault.llm.getSettings())).toMatchObject({ ok: true });
    await waitForSearchStartup(page);
    await page.locator("nav").getByRole("button", { name: "搜索", exact: true }).click();
    await expect(page.locator(".search-mode")).toHaveText("关键词＋语义检索", { timeout: 20000 });
    await page.locator("#global-search-input").fill("仅用于冷校验取消的合成查询");
    // An unrelated external commit naturally invalidates any cache warmed by the startup scheduler.
    // This is performed before the measured queries, only in the owned synthetic database.
    const dirty = new Database(join(workspace, "db/grudge-vault.sqlite3"));
    try { dirty.prepare("INSERT INTO workspace_settings(key, value_json, updated_at) VALUES (?, 'true', ?)")
      .run("e2e.synthetic-cold-search-boundary", new Date().toISOString()); }
    finally { dirty.close(); }
    const before = formalSnapshot(workspace);
    const beforeDatabase = databaseSnapshot(workspace);
    const read = () => readColdObservation(desktop);
    await armColdObservation(desktop);
    await focusDesktop(desktop, page);
    await armSearchFeedback(page, "gv-search-first-feedback");
    const firstTraceSession = await beginFeedbackTrace(page);
    await page.locator(".search-input").getByRole("button", { name: "搜索", exact: true }).click();
    // Observe actual batches, then use the real UI and IPC cancellation path. Never hold the scan artificially.
    await expect.poll(async () => (await read()).details, { intervals: [10, 20, 50] }).toBeGreaterThan(0);
    await page.getByRole("button", { name: "取消搜索", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText("本次搜索已取消。");
    await expect.poll(async () => (await read()).completed).toBe(1);
    await expect(page.locator(".search-input button")).toBeEnabled();
    const firstFeedback = await page.evaluate(() => (window as typeof window & { __gvFeedback?: FeedbackObservation }).__gvFeedback!);
    expect(firstFeedback).toMatchObject({ trustedSubmission: true, phaseVisible: true, falseEmpty: false,
      staleResults: false, prematureCapabilities: false });
    expect(firstFeedback.domDelayMs).toBeLessThanOrEqual(200);
    expect(firstFeedback.nextFrameDelayMs).toBeLessThanOrEqual(200);
    const firstFeedbackTrace = await finishFeedbackTrace(firstTraceSession, testInfo.outputPath("first-feedback-trace.json"), "gv-search-first-feedback");
    expect(firstFeedbackTrace.capturedFramesAfterDom).toBeGreaterThan(0);
    // Captured-frame evidence is kept separately from DOM/rAF timing and inspected after the run.
    const cancelled = await read();
    expect(cancelled.started).toBe(1);
    expect(cancelled.abandoned?.details).toBeGreaterThan(0);
    expect(cancelled.abandoned?.details).toBeLessThan(recordCount);
    expect(cancelled.details).toBeLessThan(recordCount);
    expect(cancelled.embeddingCalls).toBe(0);
    expect(cancelled.embeddingInputs).toBe(0);
    expect(cancelled.keys).toBe(0);
    expect(cancelled.outcomes).toEqual([{ kind: "rejected", code: "SOURCE_UNAVAILABLE" }]);
    await expect(page.locator(".search-results article")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "载入更多", exact: true })).toHaveCount(0);
    expect(formalSnapshot(workspace)).toEqual(before);
    expect(databaseSnapshot(workspace)).toEqual(beforeDatabase);
    await page.screenshot({ path: testInfo.outputPath("cold-search-cancelled.png") });

    // Cancellation must not publish a partial projection cache. The next UI query scans all records and keys.
    await armColdObservation(desktop);
    await page.locator("#global-search-input").fill("下一次完整合成语义查询");
    await focusDesktop(desktop, page);
    await armSearchFeedback(page, "gv-search-next-feedback");
    const nextTraceSession = await beginFeedbackTrace(page);
    await page.locator(".search-input button").click();
    await expect(page.locator(".search-results article")).toHaveCount(30, { timeout: 20_000 });
    await expect(page.locator(".search-capabilities .ready")).toHaveText(["语义索引 · 可用"]);
    await expect(page.locator(".search-capabilities .unavailable")).toHaveText(["媒体查询 · 不可用"]);
    const completed = await read();
    const nextFeedback = await page.evaluate(() => (window as typeof window & { __gvFeedback?: FeedbackObservation }).__gvFeedback!);
    expect(nextFeedback).toMatchObject({ trustedSubmission: true, phaseVisible: true, falseEmpty: false,
      staleResults: false, prematureCapabilities: false });
    expect(nextFeedback.domDelayMs).toBeLessThanOrEqual(200);
    expect(nextFeedback.nextFrameDelayMs).toBeLessThanOrEqual(200);
    const nextFeedbackTrace = await finishFeedbackTrace(nextTraceSession, testInfo.outputPath("next-feedback-trace.json"), "gv-search-next-feedback");
    expect(nextFeedbackTrace.capturedFramesAfterDom).toBeGreaterThan(0);
    expect(completed).toMatchObject({ started: 1, completed: 1, detailBatches: 40, details: recordCount,
      keyBatches: 98, keys: fragmentCount, embeddingCalls: 1, embeddingInputs: 1,
      outcomes: [{ kind: "returned", hits: 30, hasCursor: true,
        coverage: { currentFragments: fragmentCount, expectedFragments: fragmentCount, outdatedFragments: 0 } }] });
    await page.getByRole("button", { name: "载入更多", exact: true }).click();
    await expect(page.locator(".search-results article")).toHaveCount(60);
    const paged = await read();
    expect(paged).toMatchObject({ started: 2, completed: 2, details: recordCount, keys: fragmentCount, embeddingCalls: 1,
      outcomes: [{ kind: "returned", hits: 30 }, { kind: "returned", hits: 30 }] });
    expect(formalSnapshot(workspace)).toEqual(before);
    expect(databaseSnapshot(workspace)).toEqual(beforeDatabase);
    expect(await readdir(join(workspace, "vault/objects/sha256"))).toEqual([]);
    expect(await desktop.evaluate(() => ({ inference: (globalThis as typeof globalThis & { __gvE2eInferenceCalls?: number }).__gvE2eInferenceCalls ?? 0,
      network: (globalThis as typeof globalThis & { __gvE2eUnexpectedNetwork?: number }).__gvE2eUnexpectedNetwork ?? 0 })))
      .toEqual({ inference: 0, network: 0 });
    await page.screenshot({ path: testInfo.outputPath("cold-search-subsequent-page.png") });
    await testInfo.attach("aggregate-search-observation", { body: JSON.stringify({ recordCount, fragmentCount, dimensions: 1024,
      cancelled, completed, paged, formalTablesUnchanged: true, completeDatabaseUnchanged: true,
      feedback: { firstFeedback, nextFeedback, firstFeedbackTrace, nextFeedbackTrace },
      databaseByteLength: beforeDatabase.byteLength, objectFiles: 0, inferenceCalls: 0, unexpectedNetwork: 0,
      observationReadProtocol: "data properties without JavaScript evaluation",
      limits: "Synthetic embedding; no injected delays. Not a <=200ms UI benchmark, real model quality, or target-device certification." }, null, 2),
    contentType: "application/json" });
  } finally {
    if (application) await application.close();
    // Exact directory created by this test, never an installed app or user workspace.
    await rm(root, { recursive: true, force: true });
  }
});

// eslint-disable-next-line no-empty-pattern
test("pauses a real 10k-record scheduling check from settings and verifies full coverage without rebuilding", async ({}, testInfo) => {
  test.setTimeout(corpusTestTimeout);
  const root = await mkdtemp(join(tmpdir(), "grudge-vault-index-schedule-e2e-"));
  const workspace = join(root, "workspace"), userData = join(root, "user-data");
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await seedLargeSearch(workspace, join(root, "seed-recent.json"));
    const environment = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined));
    application = await electron.launch({ args: [resolve("apps/desktop/out-e2e/main/main.js"), `--user-data-dir=${userData}`],
      env: { ...environment, GRUDGE_VAULT_E2E_WORKSPACE: workspace, GRUDGE_VAULT_E2E_NO_NETWORK: "1",
        GRUDGE_VAULT_E2E_COLD_SEARCH_FLOW: "1" } });
    const desktop = application, page = await desktop.firstWindow();
    await expect(page.locator(".new-record-button")).toBeVisible();
    await page.locator("nav").getByRole("button", { name: "设置", exact: true }).click();
    const card = page.locator(".settings-card").filter({ has: page.getByRole("heading", { name: "多模态搜索索引", exact: true }) });
    await waitForSearchStartup(page);
    await expect(card.locator(".status")).toHaveText("已就绪");
    const initial = await page.evaluate(() => window.grudgeVault.records.searchIndexStatus());
    if (!initial.ok || !initial.data.activeGenerationId) throw new Error("Expected owned synthetic active generation");
    const originalId = initial.data.activeGenerationId;
    const retained = (snapshot: ReturnType<typeof formalSnapshot>) => Object.fromEntries(Object.entries(snapshot)
      .filter(([table]) => table !== "workspace_settings"));
    const before = retained(formalSnapshot(workspace));
    await page.locator("nav").getByRole("button", { name: "时间线", exact: true }).click();
    const external = new Database(join(workspace, "db/grudge-vault.sqlite3"));
    try {
      external.prepare("INSERT INTO workspace_settings(key, value_json, updated_at) VALUES ('synthetic-scheduling-cold', 'true', ?)")
        .run(new Date().toISOString());
    } finally { external.close(); }
    const read = () => readColdObservation(desktop);
    const arm = () => armColdObservation(desktop);
    await arm();
    // Public IPC owns the async check; the settings pause below is the real UI action.
    await page.evaluate(() => {
      const observed = globalThis as typeof globalThis & { __gvE2eScheduleReply?: { ok: boolean; state?: string } };
      void window.grudgeVault.records.setSearchIndexEnabled(true).then((result) => {
        observed.__gvE2eScheduleReply = { ok: result.ok, ...(result.ok ? { state: result.data.state } : {}) };
      });
    });
    await expect.poll(async () => (await read()).details, { intervals: [10, 20, 50] }).toBeGreaterThan(0);
    await page.locator("nav").getByRole("button", { name: "设置", exact: true }).click();
    await expect(card.locator(".status")).toHaveText("检查中");
    await expect(card.getByRole("button", { name: "正在检查现有索引…", exact: true })).toBeDisabled();
    await expect(card.getByText("正在只读核对索引覆盖；确认需要更新后才会请求向量模型，可以随时暂停。", { exact: true })).toBeVisible();
    // Pause before capturing screenshots, which can outlast the real read-only check.
    await card.getByRole("button", { name: "暂停语义查询与自动更新", exact: true }).click();
    await expect(card.locator(".status")).toHaveText("已暂停");
    await expect.poll(async () => (await read()).indexSchedule?.completed ?? 0).toBe(1);
    await expect.poll(() => page.evaluate(() => (globalThis as typeof globalThis & {
      __gvE2eScheduleReply?: { ok: boolean; state?: string };
    }).__gvE2eScheduleReply)).toEqual({ ok: true, state: "paused" });
    const cancelled = await read();
    expect(cancelled.details).toBeGreaterThan(0);
    expect(cancelled.details < recordCount || cancelled.keys < fragmentCount).toBe(true);
    expect(cancelled.indexSchedule).toMatchObject({ started: 1, completed: 1, outcomes: [{ kind: "returned", hasJob: false }] });
    expect(cancelled.details).toBe(cancelled.indexSchedule?.paused?.details);
    expect(cancelled.keys).toBe(cancelled.indexSchedule?.paused?.keys);
    expect(cancelled.embeddingCalls).toBe(0); expect(cancelled.indexBuild).toBeUndefined();
    expect(retained(formalSnapshot(workspace))).toEqual(before);
    await card.screenshot({ path: testInfo.outputPath("index-schedule-paused.png") });

    await page.locator("nav").getByRole("button", { name: "时间线", exact: true }).click();
    await arm();
    await page.evaluate(() => {
      const observed = globalThis as typeof globalThis & { __gvE2eScheduleReply?: { ok: boolean; state?: string } };
      delete observed.__gvE2eScheduleReply;
      void window.grudgeVault.records.setSearchIndexEnabled(true).then((result) => {
        observed.__gvE2eScheduleReply = { ok: result.ok, ...(result.ok ? { state: result.data.state } : {}) };
      });
    });
    await expect.poll(async () => (await read()).details, { intervals: [10, 20, 50] }).toBeGreaterThan(0);
    await page.locator("nav").getByRole("button", { name: "设置", exact: true }).click();
    await expect(card.locator(".status")).toHaveText("检查中");
    await card.screenshot({ path: testInfo.outputPath("index-schedule-checking.png") });
    // A successful read-only decision creates no job event; the same mounted view must still settle.
    await expect(card.locator(".status")).toHaveText("已就绪", { timeout: 20_000 });
    await expect.poll(() => page.evaluate(() => (globalThis as typeof globalThis & {
      __gvE2eScheduleReply?: { ok: boolean; state?: string };
    }).__gvE2eScheduleReply)).toEqual({ ok: true, state: "ready" });
    expect(await page.evaluate(() => window.grudgeVault.records.searchIndexStatus()))
      .toMatchObject({ ok: true, data: { state: "ready", activeGenerationId: originalId, fragmentCount } });
    await card.screenshot({ path: testInfo.outputPath("index-schedule-ready.png") });
    const completed = await read();
    expect(completed).toMatchObject({ detailBatches: 40, details: recordCount, keyBatches: 98, keys: fragmentCount,
      embeddingCalls: 0, embeddingInputs: 0, indexSchedule: { started: 1, completed: 1, outcomes: [{ kind: "returned", hasJob: false }] } });
    expect(completed.indexBuild).toBeUndefined(); expect(retained(formalSnapshot(workspace))).toEqual(before);
    const database = new Database(join(workspace, "db/grudge-vault.sqlite3"), { readonly: true });
    try {
      expect(database.prepare("SELECT count(*) FROM jobs WHERE type = 'record.search-index-rebuild'").pluck().get()).toBe(0);
      expect(database.prepare("SELECT count(*) FROM redesign_search_generations").pluck().get()).toBe(1);
    } finally { database.close(); }
    expect(await readdir(join(workspace, "vault/objects/sha256"))).toEqual([]);
    expect(await desktop.evaluate(() => ({ inference: (globalThis as typeof globalThis & { __gvE2eInferenceCalls?: number }).__gvE2eInferenceCalls ?? 0,
      network: (globalThis as typeof globalThis & { __gvE2eUnexpectedNetwork?: number }).__gvE2eUnexpectedNetwork ?? 0 })))
      .toEqual({ inference: 0, network: 0 });
    await testInfo.attach("aggregate-index-scheduling-observation", { body: JSON.stringify({ recordCount, fragmentCount, dimensions: 1024,
      cancelled, completed, formalTablesAndVectorBytesUnchanged: true, activeGenerationUnchanged: true,
      newBuildJobs: 0, objectFiles: 0, inferenceCalls: 0, unexpectedNetwork: 0,
      observationReadProtocol: "data properties without JavaScript evaluation",
      limits: "Owned synthetic corpus; passive aggregate observer and real settings pause, no delays or changed batch sizes. Not real model quality or all-path/device performance." }),
    contentType: "application/json" });
  } finally {
    if (application) await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

// eslint-disable-next-line no-empty-pattern
test("pauses a real 10k-record index build before embedding, resumes it and interrupts an external recheck", async ({}, testInfo) => {
  test.setTimeout(corpusTestTimeout);
  const root = await mkdtemp(join(tmpdir(), "grudge-vault-index-scan-e2e-"));
  const workspace = join(root, "workspace"), userData = join(root, "user-data");
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await seedLargeSearch(workspace, join(root, "seed-recent.json"));
    const environment = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined));
    application = await electron.launch({ args: [resolve("apps/desktop/out-e2e/main/main.js"), `--user-data-dir=${userData}`],
      env: { ...environment, GRUDGE_VAULT_E2E_WORKSPACE: workspace, GRUDGE_VAULT_E2E_NO_NETWORK: "1",
        GRUDGE_VAULT_E2E_COLD_SEARCH_FLOW: "1" } });
    const desktop = application, page = await desktop.firstWindow();
    await expect(page.locator(".new-record-button")).toBeVisible();
    expect(await page.evaluate(() => window.grudgeVault.llm.getSettings())).toMatchObject({ ok: true });
    await waitForSearchStartup(page);
    const initial = await page.evaluate(() => window.grudgeVault.records.searchIndexStatus());
    if (!initial.ok || !initial.data.activeGenerationId) throw new Error("Expected owned synthetic active generation");
    const originalId = initial.data.activeGenerationId;
    const before = formalSnapshot(workspace, originalId);
    const retained = (snapshot: ReturnType<typeof formalSnapshot>) => Object.fromEntries(Object.entries(snapshot)
      .filter(([table]) => table !== "workspace_settings" && table !== "redesign_search_generations"));
    const read = () => readColdObservation(desktop);
    const arm = () => armColdObservation(desktop);
    await page.locator("nav").getByRole("button", { name: "设置", exact: true }).click();
    const card = page.locator(".settings-card").filter({ has: page.getByRole("heading", { name: "多模态搜索索引", exact: true }) });
    const pause = card.getByRole("button", { name: "暂停语义查询与自动更新", exact: true });
    await pause.scrollIntoViewIfNeeded();
    page.on("dialog", (dialog) => void dialog.accept());
    await arm();
    await card.getByRole("button", { name: "重建索引", exact: true }).click();
    await expect.poll(async () => (await read()).details, { intervals: [10, 20, 50] }).toBeGreaterThan(0);
    await pause.click();
    await expect(card.locator(".status")).toHaveText("已暂停");
    await expect.poll(async () => (await read()).indexBuild?.completed ?? 0).toBe(1);
    const cancelled = await read();
    expect(cancelled.details).toBeGreaterThan(0); expect(cancelled.details).toBeLessThan(recordCount);
    expect(cancelled.embeddingCalls).toBe(0); expect(cancelled.embeddingInputs).toBe(0);
    expect(cancelled.keys).toBe(0);
    // JobRunner.cancel uses an ordinary AbortController.abort(), so its reason may be AbortError
    // rather than the service-only pause code. Check the actual signal and persisted fixed code.
    expect(cancelled.indexBuild).toMatchObject({ started: 1, completed: 1, outcomes: [{ kind: "rejected", aborted: true }] });
    expect(cancelled.indexBuild?.outcomes).toHaveLength(1);
    const pausedDatabase = new Database(join(workspace, "db/grudge-vault.sqlite3"), { readonly: true });
    try {
      expect(pausedDatabase.prepare("SELECT state, last_error FROM redesign_search_generations WHERE state = 'failed'").all())
        .toEqual([{ state: "failed", last_error: "JOB_STATE_CONFLICT" }]);
      expect(pausedDatabase.prepare("SELECT state FROM jobs WHERE type = 'record.search-index-rebuild'").all())
        .toEqual([{ state: "cancelled" }]);
    } finally { pausedDatabase.close(); }
    expect(retained(formalSnapshot(workspace, originalId))).toEqual(retained(before));
    expect(await page.evaluate(() => window.grudgeVault.records.searchIndexStatus())).toMatchObject({ ok: true,
      data: { state: "paused", activeGenerationId: originalId, fragmentCount } });
    await page.screenshot({ path: testInfo.outputPath("index-scan-paused.png") });

    await arm();
    await card.getByRole("button", { name: "恢复并更新索引", exact: true }).click();
    await expect.poll(async () => (await read()).indexBuild?.completed ?? 0, { timeout: fullIndexWriteTimeout }).toBe(1);
    await expect(card.locator(".status")).toHaveText("已就绪");
    const completed = await read();
    expect(completed).toMatchObject({ detailBatches: 80, details: recordCount * 2, keyBatches: 0, keys: 0,
      embeddingInputs: fragmentCount, indexBuild: { started: 1, completed: 1, outcomes: [{ kind: "returned", fragmentCount }],
        writeBatches: { attempts: 3125, committed: 3125, fragments: fragmentCount, maxSize: 16 } } });
    const current = await page.evaluate(() => window.grudgeVault.records.searchIndexStatus());
    if (!current.ok || !current.data.activeGenerationId) throw new Error("Expected complete synthetic generation");
    expect(current.data.activeGenerationId).not.toBe(originalId); expect(current.data.fragmentCount).toBe(fragmentCount);
    expect(formalSnapshot(workspace, current.data.activeGenerationId).redesign_search_embeddings?.count).toBe(fragmentCount);
    expect(retained(formalSnapshot(workspace, originalId))).toEqual(retained(before));
    await page.screenshot({ path: testInfo.outputPath("index-scan-resumed.png") });

    // Trigger a genuine data_version change in this owned fixture after processing starts.
    // Observe the third real detail pass (external recheck), without delaying the builder.
    const currentId = current.data.activeGenerationId, currentBefore = formalSnapshot(workspace, currentId);
    await arm();
    await card.getByRole("button", { name: "重建索引", exact: true }).click();
    await expect.poll(async () => (await read()).embeddingCalls, { intervals: [10, 20, 50] }).toBeGreaterThan(0);
    const external = new Database(join(workspace, "db/grudge-vault.sqlite3"));
    try {
      external.prepare("INSERT INTO workspace_settings(key, value_json, updated_at) VALUES ('synthetic-e2e-recheck', 'true', ?)")
        .run(new Date().toISOString());
    } finally { external.close(); }
    await expect.poll(async () => (await read()).indexBuild?.detailPasses[2] ?? 0, { intervals: [10, 20, 50] }).toBeGreaterThan(0);
    await pause.click();
    await expect(card.locator(".status")).toHaveText("已暂停");
    await expect.poll(async () => (await read()).indexBuild?.completed ?? 0).toBe(1);
    const rechecked = await read(), recheckBuild = rechecked.indexBuild!;
    expect(recheckBuild.writeBatches).toEqual(recheckBuild.paused?.writeBatches);
    expect(recheckBuild).toMatchObject({ started: 1, completed: 1, outcomes: [{ kind: "rejected", aborted: true }] });
    expect(recheckBuild.detailPasses).toHaveLength(3); expect(recheckBuild.detailPasses[0]).toBe(recordCount);
    expect(recheckBuild.detailPasses[1]).toBeGreaterThan(0);
    expect(recheckBuild.detailPasses[2]).toBeGreaterThan(0); expect(recheckBuild.detailPasses[2]).toBeLessThan(recordCount);
    expect(recheckBuild.detailPasses).toEqual(recheckBuild.paused?.detailPasses);
    expect(rechecked.embeddingCalls).toBeGreaterThan(0);
    expect(rechecked.embeddingCalls).toBe(recheckBuild.paused?.embeddingCalls);
    expect(rechecked.embeddingInputs).toBe(recheckBuild.paused?.embeddingInputs);
    expect(rechecked.keys).toBe(0);
    expect(await page.evaluate(() => window.grudgeVault.records.searchIndexStatus())).toMatchObject({ ok: true,
      data: { state: "paused", activeGenerationId: currentId, fragmentCount } });
    expect(retained(formalSnapshot(workspace, currentId))).toEqual(retained(currentBefore));
    const recheckDatabase = new Database(join(workspace, "db/grudge-vault.sqlite3"), { readonly: true });
    try {
      expect(recheckDatabase.prepare("SELECT count(*) FROM redesign_search_generations WHERE state = 'failed' AND last_error = 'JOB_STATE_CONFLICT'")
        .pluck().get()).toBe(1);
      expect(recheckDatabase.prepare("SELECT count(*) FROM redesign_search_generations WHERE state = 'building'").pluck().get()).toBe(0);
    } finally { recheckDatabase.close(); }
    expect(await readdir(join(workspace, "vault/objects/sha256"))).toEqual([]);
    expect(await desktop.evaluate(() => ({ inference: (globalThis as typeof globalThis & { __gvE2eInferenceCalls?: number }).__gvE2eInferenceCalls ?? 0,
      network: (globalThis as typeof globalThis & { __gvE2eUnexpectedNetwork?: number }).__gvE2eUnexpectedNetwork ?? 0 })))
      .toEqual({ inference: 0, network: 0 });
    await page.screenshot({ path: testInfo.outputPath("index-recheck-paused.png") });
    await testInfo.attach("aggregate-index-scan-observation", { body: JSON.stringify({ recordCount, fragmentCount, dimensions: 1024,
      cancelled, completed, rechecked, originalFormalTablesAndVectorBytesUnchanged: true, originalGenerationRetained: true,
      recoveredGenerationRetainedDuringRecheck: true,
      newGenerationComplete: true, objectFiles: 0, inferenceCalls: 0, unexpectedNetwork: 0,
      observationReadProtocol: "data properties without JavaScript evaluation",
      limits: "Owned synthetic inputs and embedding; no injected delays or smaller batches. Not real model quality, peak-memory or target-device certification." }),
    contentType: "application/json" });
  } catch (cause) {
    if (application) {
      try {
        const observed = await application.evaluate(() => (globalThis as typeof globalThis & {
          __gvE2eColdSearch?: ColdSearchObservation;
        }).__gvE2eColdSearch);
        process.stderr.write(`Synthetic index counters after failure: ${JSON.stringify(observed)}\n`);
        await testInfo.attach("aggregate-index-build-failure", { body: JSON.stringify({ observed,
          observationReadProtocol: "data properties without JavaScript evaluation",
          limits: "Passive synthetic counters sampled after the failed assertion, before closing the owned app; not an exact deadline snapshot." }),
        contentType: "application/json" });
      } catch { /* Preserve the original failure if diagnostic collection is unavailable. */ }
    }
    throw cause;
  } finally {
    if (application) await application.close();
    await rm(root, { recursive: true, force: true });
  }
});
