import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@grudge-vault/shared";
import { SearchVectorScorer } from "./search-vector-scoring";

describe("owned numeric search worker", () => {
  const scorers: SearchVectorScorer[] = [];
  afterEach(async () => { vi.useRealTimers(); for (const scorer of scorers.splice(0)) await scorer.close(); vi.restoreAllMocks(); });
  const create = (query: Float32Array, normalization: "none" | "l2" = "l2", signal?: AbortSignal) => {
    const scorer = new SearchVectorScorer(query, normalization, signal); scorers.push(scorer); return scorer;
  };
  const workerOf = (scorer: SearchVectorScorer) => (scorer as unknown as { worker: Worker }).worker;
  const reference = (query: Float32Array, vector: Float32Array, normalization: "none" | "l2") => {
    let dot = 0, left = 0, right = 0;
    for (let index = 0; index < query.length; index++) {
      dot += query[index]! * vector[index]!; left += query[index]! ** 2; right += vector[index]! ** 2;
    }
    return normalization === "l2" ? Math.max(-1, Math.min(1, dot)) : left && right ? dot / Math.sqrt(left * right) : 0;
  };

  it.each(["none", "l2"] as const)("preserves exact %s scores and batch order", async (normalization) => {
    const query = Float32Array.from([0.1, -0.2, 0.3]);
    const vectors = [query.slice(), Float32Array.from([-0.1, 0.2, -0.3]), new Float32Array(3),
      Float32Array.from([9, 9, 9]), Float32Array.from([0.1, -0.2, 0.3])];
    const scorer = create(query, normalization);
    expect(workerOf(scorer).threadId).toBeGreaterThan(0);
    expect(Array.from(await scorer.score(vectors))).toEqual(vectors.map((vector) => reference(query, vector, normalization)));
    await scorer.close(); expect(workerOf(scorer).threadId).toBe(-1);
  });

  it("snapshots query and pooled vector views without detaching or modifying originals", async () => {
    const backing = Float32Array.from([999, 1, 0, 777, 0, 1, 888]);
    const before = backing.slice(), query = Float32Array.from([1, 0]);
    const scorer = create(query); query.fill(0);
    const result = scorer.score([backing.subarray(1, 3), backing.subarray(4, 6)]);
    expect(Array.from(await result)).toEqual([1, 0]); expect(backing).toEqual(before);
    expect(backing.buffer.byteLength).toBe(before.buffer.byteLength);
  });

  it.each(["none", "l2"] as const)("preserves 512 seeded 1024-dimensional %s scores over successive batches", async (normalization) => {
    let seed = 20261001;
    const value = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 - 0.5; };
    const query = Float32Array.from({ length: 1024 }, value);
    const vectors = Array.from({ length: 512 }, () => Float32Array.from({ length: 1024 }, value));
    const scorer = create(query, normalization), expected = vectors.map((vector) => reference(query, vector, normalization));
    expect(Array.from(await scorer.score(vectors))).toEqual(expected);
    expect(Array.from(await scorer.score(vectors.slice(256)))).toEqual(expected.slice(256));
  });

  it("sends only bounded numeric batches, never source metadata or the original backing buffer", async () => {
    const scorer = create(Float32Array.from([1, 0]));
    const post = vi.spyOn(workerOf(scorer), "postMessage");
    const vector = Float32Array.from([1, 0]); await scorer.score(Array.from({ length: 512 }, () => vector));
    const value = post.mock.calls[0]![0] as { id: number; count: number; matrix: Float32Array };
    expect(Object.keys(value).sort()).toEqual(["count", "id", "matrix"]);
    expect(value.count).toBe(512); expect(value.matrix.buffer).not.toBe(vector.buffer);
    expect(vector).toEqual(Float32Array.from([1, 0]));
    await expect(scorer.score(Array.from({ length: 513 }, () => vector))).rejects.toMatchObject({ code: "EMBEDDING_UNAVAILABLE" });
    expect(post).toHaveBeenCalledOnce();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("rejects non-finite stored vector %s", async (value) => {
    const scorer = create(Float32Array.from([1, 0]));
    await expect(scorer.score([Float32Array.from([value, 0])])).rejects.toMatchObject({ code: "EMBEDDING_UNAVAILABLE" });
    await scorer.close(); expect(workerOf(scorer).threadId).toBe(-1);
  });

  it("rejects invalid shapes without a message and preserves empty-batch behavior", async () => {
    const scorer = create(Float32Array.from([1, 0])); const post = vi.spyOn(workerOf(scorer), "postMessage");
    await expect(scorer.score([Float32Array.from([1])])).rejects.toMatchObject({ code: "EMBEDDING_UNAVAILABLE" });
    expect(await scorer.score([])).toEqual(new Float64Array()); expect(post).not.toHaveBeenCalled();
    expect(() => create(new Float32Array())).toThrowError(expect.objectContaining({ code: "EMBEDDING_UNAVAILABLE" }));
    expect(() => create(Float32Array.from([Number.NaN]))).toThrowError(expect.objectContaining({ code: "EMBEDDING_UNAVAILABLE" }));
  });

  it("rejects pre-aborted work before allocating a thread", () => {
    const controller = new AbortController(), reason = new AppError("SOURCE_UNAVAILABLE", "Synthetic cancelled query.", true);
    controller.abort(reason);
    expect(() => create(Float32Array.from([1]), "l2", controller.signal)).toThrow(reason);
  });

  it("cancels a pending batch and waits for its thread to exit", async () => {
    const controller = new AbortController(), reason = new AppError("SOURCE_UNAVAILABLE", "Synthetic cancelled query.", true);
    const scorer = create(new Float32Array(4096).fill(0.01), "l2", controller.signal);
    const pending = scorer.score(Array.from({ length: 512 }, () => new Float32Array(4096).fill(0.01)));
    const rejected = expect(pending).rejects.toBe(reason); controller.abort(reason); await rejected;
    await scorer.close(); expect(workerOf(scorer).threadId).toBe(-1);
    await expect(scorer.score([new Float32Array(4096)])).rejects.toBe(reason);
  });

  it("closes idempotently and rejects concurrent or closed batches", async () => {
    const scorer = create(Float32Array.from([1, 0])); const pending = scorer.score([Float32Array.from([1, 0])]);
    await expect(scorer.score([Float32Array.from([1, 0])])).rejects.toMatchObject({ code: "EMBEDDING_UNAVAILABLE" });
    await pending; const closed = scorer.close(); expect(scorer.close()).toBe(closed); await closed;
    await expect(scorer.score([Float32Array.from([1, 0])])).rejects.toMatchObject({ code: "EMBEDDING_UNAVAILABLE" });
  });

  it("keeps the parent event loop running during real numeric work", async () => {
    const scorer = create(new Float32Array(4096).fill(1 / 64)); let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 1);
    try {
      const result = await scorer.score(Array.from({ length: 512 }, () => new Float32Array(4096).fill(1 / 64)));
      expect(result.length).toBe(512); expect(result.every((score) => score === 1)).toBe(true); expect(ticks).toBeGreaterThan(0);
    } finally { clearInterval(timer); }
  });

  it("sanitizes worker faults instead of exposing diagnostic text", async () => {
    const scorer = create(Float32Array.from([1, 0])); const pending = scorer.score([Float32Array.from([1, 0])]);
    const rejected = expect(pending).rejects.toMatchObject({ code: "EMBEDDING_UNAVAILABLE", message: "本地语义计算未完成，请重新搜索。" });
    workerOf(scorer).emit("error", new Error("SYNTHETIC_PRIVATE_DIAGNOSTIC")); await rejected;
    await scorer.close(); expect(workerOf(scorer).threadId).toBe(-1);
  });

  it("rejects malformed worker output and waits for termination", async () => {
    const scorer = create(Float32Array.from([1, 0])), pending = scorer.score([Float32Array.from([1, 0])]);
    const rejected = expect(pending).rejects.toMatchObject({ code: "EMBEDDING_UNAVAILABLE" });
    workerOf(scorer).emit("message", { id: 1, scores: Float64Array.from([Number.NaN]) });
    await rejected; await scorer.close(); expect(workerOf(scorer).threadId).toBe(-1);
  });

  it("terminates an unanswered batch at the local timeout without publishing a partial score", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const scorer = create(Float32Array.from([1, 0])), pending = scorer.score([Float32Array.from([1, 0])]);
    const rejected = expect(pending).rejects.toMatchObject({ code: "EMBEDDING_UNAVAILABLE" });
    vi.advanceTimersByTime(30_000); await rejected;
    await scorer.close(); expect(workerOf(scorer).threadId).toBe(-1);
  });
});
