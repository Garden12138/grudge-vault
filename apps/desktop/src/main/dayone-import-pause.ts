import { AppError } from "@grudge-vault/shared";

export const MAX_DAYONE_PAUSE_MS = 4 * 60 * 60 * 1_000;
type PausePhase = "pausing" | "paused" | "screening";

/** Volatile entry-boundary gate. It retains no source IDs, content, paths or credentials. */
export class DayOneImportPause {
  private requested = false;
  private disposed = false;
  private timeout: ReturnType<typeof setTimeout> | undefined;
  private waiters = new Set<(error?: unknown) => void>();

  constructor(private readonly changed: (phase: PausePhase) => void, private readonly expired: () => void) {}

  pause(): boolean {
    if (this.disposed || this.requested) return false;
    this.requested = true;
    this.publish("pausing");
    this.timeout = setTimeout(() => {
      if (this.disposed || !this.requested) return;
      try { this.expired(); } catch { /* Cleanup still releases every paused waiter. */ }
      finally { this.dispose(); }
    }, MAX_DAYONE_PAUSE_MS);
    this.timeout.unref();
    return true;
  }

  resume(): boolean {
    if (this.disposed || !this.requested) return false;
    this.requested = false;
    this.clearTimeout();
    this.publish("screening");
    this.release();
    return true;
  }

  async beforeItem(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.disposed) throw new AppError("IMPORT_CANCELLED", "本次导入会话已结束。", true);
    while (this.requested) {
      this.publish("paused");
      await new Promise<void>((resolve, reject) => {
        const done = (error?: unknown) => {
          signal.removeEventListener("abort", aborted);
          this.waiters.delete(done);
          if (error !== undefined) reject(error); else resolve();
        };
        const aborted = () => done(signal.reason);
        this.waiters.add(done);
        signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted) aborted();
      });
      signal.throwIfAborted();
      if (this.disposed) throw new AppError("IMPORT_CANCELLED", "本次导入会话已结束。", true);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.requested = false;
    this.clearTimeout();
    this.release(new AppError("IMPORT_CANCELLED", "本次导入会话已结束。", true));
  }
  private clearTimeout() { if (this.timeout) clearTimeout(this.timeout); this.timeout = undefined; }
  private release(error?: unknown) { for (const done of [...this.waiters]) done(error); }
  private publish(phase: PausePhase) { try { this.changed(phase); } catch { /* Observations do not control admission. */ } }
}
