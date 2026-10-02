import { useEffect } from "react";
import type { RecordSearchIndexStatus } from "@grudge-vault/domain";

// A read-only check can finish without creating a job or emitting a job-change event.
// Poll only this transient state, without overlapping requests or reviving a paused/unmounted view.
export function useSearchIndexCheckRefresh(
  state: RecordSearchIndexStatus["state"] | undefined,
  read: () => Promise<RecordSearchIndexStatus | undefined>,
  publish: (status: RecordSearchIndexStatus) => void,
  failed: (cause: unknown) => void,
  refreshEpoch = 0
): void {
  useEffect(() => {
    if (state !== "checking") return;
    let disposed = false, failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      let again = false;
      try {
        const status = await read();
        if (disposed) return;
        // A newer read/command can supersede this poll without being a read failure.
        // Keep the loop available if the current view is still checking.
        if (status) { failures = 0; publish(status); again = status.state === "checking"; }
        else again = true;
      } catch (cause) {
        if (disposed) return;
        failed(cause); again = ++failures < 3;
      }
      if (!disposed && again) timer = setTimeout(() => { void refresh(); }, 500);
    };
    timer = setTimeout(() => { void refresh(); }, 500);
    return () => { disposed = true; clearTimeout(timer); };
  }, [state, read, publish, failed, refreshEpoch]);
}
