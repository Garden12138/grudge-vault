import { RedesignService, type RecordEmbeddingPort } from "@grudge-vault/application";
import { SqliteRecordRepository } from "@grudge-vault/persistence-sqlite";
import { performance } from "node:perf_hooks";

export interface ColdSearchObservation {
  armed: boolean;
  detailBatches: number;
  details: number;
  keyBatches: number;
  keys: number;
  embeddingCalls: number;
  embeddingInputs: number;
  started: number;
  completed: number;
  indexBuild?: { started: number; completed: number; detailPasses: number[];
    writeBatches?: { attempts: number; committed: number; fragments: number; maxSize: number; totalMilliseconds: number };
    paused?: { detailPasses: number[]; details: number; embeddingCalls: number; embeddingInputs: number;
      writeBatches?: { attempts: number; committed: number; fragments: number; maxSize: number; totalMilliseconds: number } };
    outcomes: Array<{ kind: "returned" | "rejected"; code?: string; aborted?: boolean; fragmentCount?: number }> };
  indexSchedule?: { started: number; completed: number;
    paused?: { details: number; keys: number; embeddingCalls: number };
    outcomes: Array<{ kind: "returned" | "rejected"; hasJob?: boolean; code?: string; aborted?: boolean }> };
  abandoned?: { details: number; keys: number; embeddingCalls: number };
  outcomes: Array<{ kind: "returned" | "rejected"; code?: string; hits?: number; hasCursor?: boolean;
    coverage?: { currentFragments: number; expectedFragments: number; outdatedFragments: number } }>;
}

type ObservationGlobal = typeof globalThis & { __gvE2eColdSearch?: ColdSearchObservation };
const observation = () => {
  const value = (globalThis as ObservationGlobal).__gvE2eColdSearch;
  return value?.armed ? value : undefined;
};

// Aggregate observation only: no holds, delays, changed batch sizes, IDs, query text or source content.
// Imported only by the isolated E2E entry; production has no observer or synthetic adapter.
export function installColdSearchObserver(): void {
  const put = SqliteRecordRepository.prototype.putSearchEmbeddings;
  SqliteRecordRepository.prototype.putSearchEmbeddings = function (...args) {
    const build = observation()?.indexBuild;
    const writes = build && build.started > build.completed ? build.writeBatches ??= {
      attempts: 0, committed: 0, fragments: 0, maxSize: 0, totalMilliseconds: 0
    } : undefined;
    if (writes) { writes.attempts++; writes.maxSize = Math.max(writes.maxSize, args[1].length); }
    const start = performance.now();
    try {
      put.apply(this, args);
      if (writes) { writes.committed++; writes.fragments += args[1].length; }
    } finally { if (writes) writes.totalMilliseconds += performance.now() - start; }
  };
  const details = SqliteRecordRepository.prototype.iterateIndexableRecordBatches;
  SqliteRecordRepository.prototype.iterateIndexableRecordBatches = function* (...args) {
    const build = observation()?.indexBuild;
    const pass = build && build.started > build.completed ? build.detailPasses.push(0) - 1 : undefined;
    for (const batch of details.apply(this, args)) {
      const value = observation();
      if (value) { value.detailBatches++; value.details += batch.length; }
      if (build && pass !== undefined) build.detailPasses[pass]! += batch.length;
      yield batch;
    }
  };
  const keys = SqliteRecordRepository.prototype.iterateSearchFragmentKeyBatches;
  SqliteRecordRepository.prototype.iterateSearchFragmentKeyBatches = function* (...args) {
    for (const batch of keys.apply(this, args)) {
      const value = observation();
      if (value) { value.keyBatches++; value.keys += batch.length; }
      yield batch;
    }
  };
  const execute = RedesignService.prototype.executeSearchQuery;
  RedesignService.prototype.executeSearchQuery = async function (...args) {
    const value = observation();
    if (value) value.started++;
    try {
      const page = await execute.apply(this, args);
      if (value) value.outcomes.push({ kind: "returned", hits: page.hits.length,
        hasCursor: Boolean(page.nextCursor), ...(page.capabilities.indexCoverage ? { coverage: page.capabilities.indexCoverage } : {}) });
      return page;
    } catch (error) {
      if (value) value.outcomes.push({ kind: "rejected", ...(error && typeof error === "object" &&
        "code" in error && typeof error.code === "string" ? { code: error.code } : {}) });
      throw error;
    } finally { if (value) value.completed++; }
  };
  const rebuild = RedesignService.prototype.rebuildSearchIndex;
  RedesignService.prototype.rebuildSearchIndex = async function (...args) {
    const value = observation();
    const build = value ? value.indexBuild ??= { started: 0, completed: 0, detailPasses: [], outcomes: [] } : undefined;
    if (build) build.started++;
    try {
      const status = await rebuild.apply(this, args);
      if (build) build.outcomes.push({ kind: "returned", fragmentCount: status.fragmentCount });
      return status;
    } catch (error) {
      if (build) build.outcomes.push({ kind: "rejected", ...(error && typeof error === "object" &&
        "code" in error && typeof error.code === "string" ? { code: error.code } : {}),
      aborted: args[1]?.aborted === true || error instanceof Error && error.name === "AbortError" });
      throw error;
    } finally { if (build) build.completed++; }
  };
  const setEnabled = RedesignService.prototype.setSearchIndexEnabled;
  RedesignService.prototype.setSearchIndexEnabled = function (...args) {
    const value = observation(), build = value?.indexBuild;
    if (args[0] === false && value && build && build.started > build.completed) {
      build.paused = { detailPasses: [...build.detailPasses], details: value.details,
        embeddingCalls: value.embeddingCalls, embeddingInputs: value.embeddingInputs,
        ...(build.writeBatches ? { writeBatches: { ...build.writeBatches } } : {}) };
    }
    const schedule = value?.indexSchedule;
    if (args[0] === false && value && schedule && schedule.started > schedule.completed) {
      schedule.paused = { details: value.details, keys: value.keys, embeddingCalls: value.embeddingCalls };
    }
    return setEnabled.apply(this, args);
  };
  const ensure = RedesignService.prototype.ensureSearchIndexJob;
  RedesignService.prototype.ensureSearchIndexJob = async function (...args) {
    const value = observation();
    const schedule = value ? value.indexSchedule ??= { started: 0, completed: 0, outcomes: [] } : undefined;
    if (schedule) schedule.started++;
    try {
      const id = await ensure.apply(this, args);
      if (schedule) schedule.outcomes.push({ kind: "returned", hasJob: Boolean(id) });
      return id;
    } catch (error) {
      if (schedule) schedule.outcomes.push({ kind: "rejected", ...(error && typeof error === "object" &&
        "code" in error && typeof error.code === "string" ? { code: error.code } : {}), aborted: args[0]?.aborted === true });
      throw error;
    } finally { if (schedule) schedule.completed++; }
  };
  const abandon = RedesignService.prototype.abandonSearchQuery;
  RedesignService.prototype.abandonSearchQuery = function (...args) {
    const value = observation();
    if (value && value.started > value.completed && !value.abandoned) {
      value.abandoned = { details: value.details, keys: value.keys, embeddingCalls: value.embeddingCalls };
    }
    return abandon.apply(this, args);
  };
}

export const coldSearchEmbedding: RecordEmbeddingPort = {
  identity: "e2e.synthetic-cold-search", version: 1, dimensions: 1024, normalization: "l2", inputModalities: ["text"],
  async embed(inputs) {
    const value = observation();
    if (value) { value.embeddingCalls++; value.embeddingInputs += inputs.length; }
    return inputs.map(() => new Float32Array(1024).fill(1 / 32));
  }
};
