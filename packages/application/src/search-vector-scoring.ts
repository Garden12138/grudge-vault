import { Worker } from "node:worker_threads";
import { AppError } from "@grudge-vault/shared";

const MAX_BATCH = 512;
const workerSource = String.raw`
  const { parentPort, workerData } = require("node:worker_threads");
  const query = workerData.query;
  const normalization = workerData.normalization;
  let queryNorm = 0;
  for (const value of query) queryNorm += value ** 2;
  parentPort.on("message", ({ id, matrix, count }) => {
    if (!Number.isSafeInteger(id) || !Number.isSafeInteger(count) || count < 1 || count > 512 ||
        !(matrix instanceof Float32Array) || matrix.length !== count * query.length) {
      parentPort.postMessage({ id, error: true }); return;
    }
    const scores = new Float64Array(count);
    for (let row = 0; row < count; row++) {
      let dot = 0, rightNorm = 0;
      for (let column = 0; column < query.length; column++) {
        const value = matrix[row * query.length + column];
        if (!Number.isFinite(value)) { parentPort.postMessage({ id, error: true }); return; }
        dot += query[column] * value;
        if (normalization === "none") rightNorm += value ** 2;
      }
      const score = normalization === "l2" ? Math.max(-1, Math.min(1, dot))
        : queryNorm && rightNorm ? dot / Math.sqrt(queryNorm * rightNorm) : 0;
      if (!Number.isFinite(score)) { parentPort.postMessage({ id, error: true }); return; }
      scores[row] = score;
    }
    parentPort.postMessage({ id, scores }, [scores.buffer]);
  });
`;

const unavailable = () => new AppError("EMBEDDING_UNAVAILABLE", "本地语义计算未完成，请重新搜索。", true);

/** One owned thread per running query. Only private copies of numeric vectors cross the boundary. */
export class SearchVectorScorer {
  private readonly worker: Worker;
  private readonly dimensions: number;
  private sequence = 0;
  private closed = false;
  private closing: Promise<void> | undefined;
  private pending: {
    id: number; count: number; timer: ReturnType<typeof setTimeout>;
    resolve(scores: Float64Array): void; reject(error: unknown): void;
  } | undefined;
  private readonly abort = () => {
    this.rejectPending(this.signal?.reason ?? unavailable());
    void this.close().catch(() => {});
  };

  constructor(query: Float32Array, normalization: "none" | "l2", private readonly signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!query.length || !query.every(Number.isFinite) || (normalization !== "none" && normalization !== "l2")) {
      throw unavailable();
    }
    this.dimensions = query.length;
    const snapshot = query.slice();
    try {
      this.worker = new Worker(workerSource, { eval: true, env: {}, execArgv: [], workerData: { query: snapshot, normalization },
        transferList: [snapshot.buffer] });
    } catch { throw unavailable(); }
    this.worker.on("message", (message: unknown) => this.receive(message));
    this.worker.on("error", () => { this.rejectPending(unavailable()); void this.close().catch(() => {}); });
    this.worker.on("exit", () => {
      this.rejectPending(unavailable()); this.closed = true;
      this.signal?.removeEventListener("abort", this.abort);
    });
    signal?.addEventListener("abort", this.abort, { once: true });
  }

  async score(vectors: readonly Float32Array[]): Promise<Float64Array> {
    this.signal?.throwIfAborted();
    if (this.closed || this.pending || vectors.length > MAX_BATCH || vectors.some((vector) => vector.length !== this.dimensions)) {
      throw unavailable();
    }
    if (!vectors.length) return new Float64Array();
    // Never transfer a SQLite BLOB's shared backing buffer or detach the caller's original vectors.
    const matrix = new Float32Array(vectors.length * this.dimensions);
    vectors.forEach((vector, index) => matrix.set(vector, index * this.dimensions));
    return new Promise<Float64Array>((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.rejectPending(unavailable()); void this.close().catch(() => {});
      }, 30_000);
      timer.unref();
      this.pending = { id, count: vectors.length, timer, resolve, reject };
      try { this.worker.postMessage({ id, count: vectors.length, matrix }, [matrix.buffer]); }
      catch { this.rejectPending(unavailable()); void this.close().catch(() => {}); }
    });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.signal?.removeEventListener("abort", this.abort);
    this.rejectPending(unavailable());
    this.closing = this.worker.terminate().then(() => undefined, () => { throw unavailable(); });
    return this.closing;
  }

  private rejectPending(error: unknown): void {
    const pending = this.pending; this.pending = undefined;
    if (pending) { clearTimeout(pending.timer); pending.reject(error); }
  }

  private receive(message: unknown): void {
    const pending = this.pending;
    if (!pending || this.closed) return;
    const value = message as { id?: unknown; scores?: unknown; error?: unknown } | null;
    if (!value || value.id !== pending.id || value.error || !(value.scores instanceof Float64Array) ||
      value.scores.length !== pending.count || !value.scores.every(Number.isFinite)) {
      this.rejectPending(unavailable()); void this.close().catch(() => {}); return;
    }
    clearTimeout(pending.timer); this.pending = undefined; pending.resolve(value.scores);
  }
}
