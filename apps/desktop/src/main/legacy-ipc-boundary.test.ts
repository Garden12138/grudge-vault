import Database from "better-sqlite3";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { JobRunner } from "@grudge-vault/application";
import { runMigrations, SqliteJobRepository } from "@grudge-vault/persistence-sqlite";
import { registerIpcHandlers } from "./ipc";

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, input?: unknown) => Promise<unknown>>(),
  showOpenDialog: vi.fn(), showSaveDialog: vi.fn(), showMessageBox: vi.fn(),
  openExternal: vi.fn(), showItemInFolder: vi.fn(), send: vi.fn()
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, input?: unknown) => Promise<unknown>) => electron.handlers.set(channel, handler),
    removeHandler: (channel: string) => electron.handlers.delete(channel)
  },
  dialog: { showOpenDialog: electron.showOpenDialog, showSaveDialog: electron.showSaveDialog, showMessageBox: electron.showMessageBox },
  shell: { openExternal: electron.openExternal, showItemInFolder: electron.showItemInFolder }
}));

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const REVISION = { id: ID, expectedRevision: 1 };
const EVENT = { title: "Synthetic ordinary day", status: "confirmed", occurredAt: { kind: "unknown" },
  narrative: "Synthetic breakfast and a walk", facts: [], interpretations: [], emotions: [], interests: [],
  participants: [], sourceRefs: [], assetRefs: [], reason: "Synthetic legacy request" };
const CASE = { title: "Synthetic case", status: "draft", jurisdiction: "CN-SH", asOfDate: "2026-01-01",
  eventRefs: [], personRefs: [], sourceRefs: [], assetRefs: [], amounts: [], disputePoints: [],
  questions: [], materialGaps: [], evidenceLinks: [], reason: "Synthetic legacy request" };

// Valid requests must reach the explicit legacy guard, not merely fail input validation.
const LEGACY_WRITES: ReadonlyArray<readonly [string, unknown]> = [
  ["conversations:create", "Synthetic conversation"],
  ["conversations:rename", { id: ID, title: "Synthetic rename" }],
  ["conversations:delete", ID],
  ["conversations:send", { conversationId: ID, content: EVENT.narrative, intent: "source" }],
  ["agent:send", { conversationId: ID, content: EVENT.narrative }],
  ["agent:resume", { runId: ID, disclosureId: OTHER_ID }],
  ["agent:approve-action", ID], ["agent:reject-action", ID],
  ["events:create", EVENT], ["events:update", { ...EVENT, eventId: ID, expectedRevision: 1 }],
  ["events:confirm", REVISION], ["events:archive", REVISION],
  ["people:create", { displayName: "Synthetic person" }],
  ["people:update", { id: ID, displayName: "Synthetic person" }],
  ["people:archive", ID], ["people:add-alias", { personId: ID, value: "Synthetic alias" }],
  ["people:deactivate-alias", ID], ["people:reject-merge-suggestion", ID],
  ["people:merge", { sourcePersonId: ID, targetPersonId: OTHER_ID }], ["people:revert-merge", ID],
  ["relations:refresh", undefined],
  ["relations:create", { sourceEventId: ID, targetEventId: OTHER_ID, kind: "similar" }],
  ["relations:confirm", ID], ["relations:reject", ID], ["relations:remove", ID],
  ["search:semantic-enabled", true], ["search:rebuild-embeddings", undefined],
  ["local-intelligence:choose-path", "ffmpeg"],
  ["local-intelligence:update-settings", { autoProcessNew: true, ocrLanguages: ["eng"], resourceProfile: "balanced", whisperGpu: "cpu" }],
  ["local-intelligence:probe", undefined], ["local-intelligence:process-asset", ID],
  ["local-intelligence:process-historical", undefined],
  ["reviews:generate", { from: "2026-01-01", to: "2026-01-31" }],
  ["clarifications:answer", { clarificationId: ID, answer: "Synthetic answer", expectedRevision: 1 }],
  ["clarifications:dismiss", REVISION], ["clarifications:priority", { id: ID, priority: "normal" }],
  ["assets:import-paths", ["/synthetic/ordinary.txt"]], ["assets:choose-and-import", undefined],
  ["assets:import-for-event", { paths: ["/synthetic/ordinary.txt"], eventId: ID, expectedRevision: 1 }],
  ["assets:choose-and-import-for-event", REVISION], ["assets:verify", ID],
  ["evidence:delete-original", { assetId: ID, confirmReferencedDeletion: true }],
  ["evidence:supersede", { oldAssetId: ID, newAssetId: OTHER_ID }],
  ["cases:create", CASE], ["cases:update", { ...CASE, caseId: ID, expectedRevision: 1 }],
  ["cases:archive", REVISION], ["cases:legal-check", ID],
  ["imports:choose-dayone", undefined], ["import-folder:choose", undefined],
  ["import-folder:set-enabled", true], ["import-folder:scan", undefined],
  ["reminders:settings", undefined],
  ["reminders:update-settings", { monthly: true, quarterly: true, clarificationWeekly: true, systemNotifications: true }],
  ["reminders:request-system-notifications", "zh-CN"], ["reminders:read", ID], ["reminders:dismiss", ID],
  ["backfill:start", { tags: [] }], ["backfill:pause", ID], ["backfill:resume", ID], ["backfill:cancel", ID],
  ["candidates:confirm", REVISION], ["candidates:ignore", REVISION],
  ["candidates:merge", { candidateEventId: ID, candidateExpectedRevision: 1, targetEventId: OTHER_ID, targetExpectedRevision: 1 }]
];
const LEGACY_JOB_TYPES = ["dayone.import", "dayone.backfill", "media.process", "search.embedding-rebuild"];
const JOB_SCENARIOS = ["queued", "delayed", "running", "expired", "failed", "cancelled", "succeeded"] as const;
type JobScenario = typeof JOB_SCENARIOS[number];
const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-01T00:01:00.000Z";
const FUTURE = "2027-01-01T00:00:00.000Z";

describe("redesigned IPC legacy write boundary", () => {
  let remove: (() => void) | undefined;
  let emptyDatabase: Buffer;
  const databases: Database.Database[] = [];
  beforeAll(() => {
    const template = new Database(":memory:");
    try { runMigrations(template); emptyDatabase = template.serialize(); }
    finally { template.close(); }
  });
  beforeEach(() => { vi.clearAllMocks(); expect(electron.handlers.size).toBe(0); });
  afterEach(() => {
    remove?.(); remove = undefined;
    for (const database of databases.splice(0)) if (database.open) database.close();
  });

  function fixture(options: { application?: object; runner?: JobRunner } = {}) {
    const touched: string[] = [];
    const forbidden = (name: string) => new Proxy({}, {
      get(_target, property) {
        touched.push(`${name}.${String(property)}`);
        throw new Error(`Unexpected dependency access: ${name}.${String(property)}`);
      }
    });
    const mainFrame = {};
    const getRunner = vi.fn(() => options.runner);
    const restartRunner = vi.fn();
    const lockWorkspace = vi.fn();
    const dependencies = {
      window: { isDestroyed: () => false, webContents: { id: 1, mainFrame, send: electron.send } },
      application: options.application ?? forbidden("application"), agent: forbidden("agent"),
      workspaces: forbidden("workspaces"), mediaPreviews: forbidden("mediaPreviews"),
      getRunner, restartRunner, lockWorkspace
    } as unknown as Parameters<typeof registerIpcHandlers>[0];
    remove = registerIpcHandlers(dependencies);
    return { touched, getRunner, restartRunner, lockWorkspace,
      invoke: (channel: string, input?: unknown, sender = "main") => {
        const handler = electron.handlers.get(channel);
        expect(handler, `${channel} must remain explicitly guarded`).toBeDefined();
        return handler!({ sender: { id: sender === "other-window" ? 2 : 1 },
          senderFrame: sender === "subframe" ? {} : mainFrame }, input);
      },
      assertNoSideEffects: () => {
        expect(touched).toEqual([]);
        expect(restartRunner).not.toHaveBeenCalled(); expect(lockWorkspace).not.toHaveBeenCalled();
        for (const sideEffect of [electron.showOpenDialog, electron.showSaveDialog, electron.showMessageBox,
          electron.openExternal, electron.showItemInFolder, electron.send]) expect(sideEffect).not.toHaveBeenCalled();
      }
    };
  }

  function jobContext() {
    // Every case has its own SQLite instance; schema migration is not the subject of this matrix.
    const database = new Database(emptyDatabase); databases.push(database);
    database.pragma("foreign_keys = ON");
    expect(database.prepare("SELECT count(*) FROM jobs").pluck().get()).toBe(0);
    expect(database.prepare("SELECT count(*) FROM job_attempts").pluck().get()).toBe(0);
    const jobs = new SqliteJobRepository(database);
    return { database, jobs, snapshot: () => ({
      jobs: database.prepare("SELECT * FROM jobs ORDER BY id").all(),
      attempts: database.prepare("SELECT * FROM job_attempts ORDER BY job_id, attempt_number").all()
    }) };
  }

  function seedJob(test: ReturnType<typeof jobContext>, type: string, scenario: JobScenario) {
    // Set up each state in isolation before mixing queues of the same production type.
    const seedType = `synthetic-seed:${type}:${scenario}`;
    const job = test.jobs.enqueue(seedType, { synthetic: true }, scenario === "delayed" ? FUTURE : NOW, 1);
    if (["running", "expired", "failed", "succeeded"].includes(scenario)) {
      expect(test.jobs.claimNext(NOW, scenario === "running" ? FUTURE : LATER, [seedType])?.id).toBe(job.id);
      test.jobs.updateProgress(job.id, 0.25, NOW);
    }
    if (scenario === "failed") test.jobs.fail(job.id, "SYNTHETIC_FAILURE", LATER);
    if (scenario === "cancelled") test.jobs.cancel(job.id, LATER);
    if (scenario === "succeeded") test.jobs.succeed(job.id, LATER);
    test.database.prepare("UPDATE jobs SET type = ? WHERE id = ?").run(type, job.id);
    return job;
  }

  it.each(LEGACY_WRITES)("rejects valid %s before accessing writers, models or dialogs", async (channel, input) => {
    const test = fixture();
    expect(await test.invoke(channel, input)).toMatchObject({ ok: false, error: {
      code: "VALIDATION_FAILED",
      message: "This legacy write path is disabled in the redesigned app. Use the screened intake flow."
    } });
    expect(test.getRunner).not.toHaveBeenCalled(); test.assertNoSideEffects();
  });

  it("reads a dormant folder status without inspecting any old configuration or restarting watchers", async () => {
    const test = fixture();
    expect(await test.invoke("import-folder:status")).toEqual({ ok: true, data: {
      configured: false, enabled: false, watching: false, importedCount: 0, failedCount: 0
    } });
    expect(test.getRunner).not.toHaveBeenCalled(); test.assertNoSideEffects();
  });

  it.each(["other-window", "subframe"])("rejects an otherwise valid intake from %s before touching the application", async (sender) => {
    const test = fixture();
    expect(await test.invoke("intake:prepare", { requestId: ID, text: EVENT.narrative, paths: [], fileNames: [], inlineMedia: [] }, sender))
      .toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED", message: "Untrusted IPC sender." } });
    test.assertNoSideEffects();
  });

  it("continues forwarding trusted input preparation to the screened intake service", async () => {
    const input = { requestId: ID, text: EVENT.narrative, paths: [], fileNames: [], inlineMedia: [] };
    const prepareIntake = vi.fn(async () => ({ sessionId: OTHER_ID }));
    const test = fixture({ application: { prepareIntake } });
    expect(await test.invoke("intake:prepare", input)).toEqual({ ok: true, data: { sessionId: OTHER_ID } });
    expect(prepareIntake).toHaveBeenCalledExactlyOnceWith(input); test.assertNoSideEffects();
  });

  it("unregisters the entire handler set without touching legacy services", () => {
    const test = fixture();
    for (const [channel] of LEGACY_WRITES) expect(electron.handlers.has(channel)).toBe(true);
    remove!(); remove = undefined;
    expect(electron.handlers.size).toBe(0); test.assertNoSideEffects();
  });

  const legacyActions = LEGACY_JOB_TYPES.flatMap((type) => JOB_SCENARIOS.flatMap((scenario) =>
    ["retry", "cancel"].map((action) => ({ type, scenario, action }))));
  it.each(legacyActions)("preserves every SQLite job/attempt field on $action of $scenario $type", async ({ type, scenario, action }) => {
    const context = jobContext(); const job = seedJob(context, type, scenario);
    const before = context.snapshot();
    const retryJob = vi.fn((id: string) => context.jobs.retry(id, LATER));
    const runner = new JobRunner(context.jobs, { "record.analyze": async () => undefined });
    const cancel = vi.spyOn(runner, "cancel"); const wake = vi.spyOn(runner, "wake");
    const test = fixture({ application: { listJobs: () => context.jobs.list(), retryJob }, runner });
    expect(runner.canRun(type)).toBe(false);
    expect(await test.invoke(`jobs:${action}`, job.id)).toMatchObject({ ok: false, error: { code: "JOB_STATE_CONFLICT" } });
    expect(context.snapshot()).toEqual(before);
    expect(retryJob).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled(); expect(wake).not.toHaveBeenCalled();
    test.assertNoSideEffects();
  });

  it.each(["retry", "cancel"])("retains the explicit %s control for a registered current job", async (action) => {
    const context = jobContext(); const job = seedJob(context, "asset.verify", action === "retry" ? "failed" : "queued");
    const before = context.snapshot();
    const retryJob = vi.fn((id: string) => context.jobs.retry(id, LATER));
    const runner = new JobRunner(context.jobs, { "asset.verify": async () => undefined }, { now: () => new Date(LATER) });
    const wake = vi.spyOn(runner, "wake");
    const test = fixture({ application: { listJobs: () => context.jobs.list(), retryJob }, runner });
    expect(await test.invoke(`jobs:${action}`, job.id)).toMatchObject({ ok: true, data: { state: action === "retry" ? "queued" : "cancelled" } });
    expect(context.snapshot()).not.toEqual(before);
    if (action === "retry") { expect(retryJob).toHaveBeenCalledExactlyOnceWith(job.id); expect(wake).toHaveBeenCalledOnce(); }
    else { expect(retryJob).not.toHaveBeenCalled(); expect(wake).not.toHaveBeenCalled(); }
    test.assertNoSideEffects();
  });

  it.each(["empty", "current-only"])("does not alter mixed legacy queues or expired leases with %s handlers", async (mode) => {
    const context = jobContext();
    const legacyIds = LEGACY_JOB_TYPES.flatMap((type) => JOB_SCENARIOS.map((scenario) => seedJob(context, type, scenario).id));
    const legacySnapshot = () => {
      const snapshot = context.snapshot(); const ids = new Set(legacyIds);
      return { jobs: snapshot.jobs.filter((row) => ids.has((row as { id: string }).id)),
        attempts: snapshot.attempts.filter((row) => ids.has((row as { job_id: string }).job_id)) };
    };
    const before = legacySnapshot();
    const current = context.jobs.enqueue("record.analyze", { synthetic: true }, NOW, 1);
    const claim = vi.spyOn(context.jobs, "claimNext");
    const analyze = vi.fn(async () => undefined);
    const handlers = mode === "empty" ? {} : { "record.analyze": analyze };
    const runner = new JobRunner(context.jobs, handlers, { pollMs: 10, now: () => new Date("2026-01-01T00:02:00.000Z") });
    try {
      runner.start();
      if (mode === "current-only") {
        await vi.waitFor(() => expect(context.jobs.list().find(({ id }) => id === current.id)?.state).toBe("succeeded"));
        expect(analyze).toHaveBeenCalledOnce();
      }
      await runner.stopAndWait();
      expect(legacySnapshot()).toEqual(before);
      expect(claim).toHaveBeenCalled();
      for (const call of claim.mock.calls) expect(call[2]).toEqual(mode === "empty" ? [] : ["record.analyze"]);
      if (mode === "empty") {
        expect(analyze).not.toHaveBeenCalled();
        expect(context.jobs.list().find(({ id }) => id === current.id)).toMatchObject({ state: "queued", attempts: 0 });
      }
    } finally { await runner.stopAndWait(); }
  });
});
