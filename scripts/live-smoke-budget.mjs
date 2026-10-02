import { closeSync, existsSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** One grant, one process; persist attempted requests before any network side effect. */
export function openLiveSmokeBudget(root, grantId, limit = 20) {
  const rootInfo = lstatSync(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !/^[a-zA-Z0-9-]{1,100}$/.test(grantId) ||
    !Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
    throw new Error("LIVE_SMOKE_BUDGET_INVALID");
  }
  const lock = join(root, "grant.lock"), ledger = join(root, "request-budget.json");
  const descriptor = openSync(lock, "wx", 0o600);
  closeSync(descriptor);
  let state;
  const persist = () => {
    const temporary = join(root, `.request-budget-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, `${JSON.stringify(state)}\n`, { flag: "wx", mode: 0o600 });
      renameSync(temporary, ledger);
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  };
  try {
    if (existsSync(ledger)) {
      const info = lstatSync(ledger);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("LIVE_SMOKE_BUDGET_INVALID");
      state = JSON.parse(readFileSync(ledger, "utf8"));
      if (state.grantId !== grantId || state.limit !== limit || !Number.isSafeInteger(state.used) || state.used < 0 || state.used > limit) {
        throw new Error("LIVE_SMOKE_BUDGET_INVALID");
      }
    } else { state = { grantId, limit, used: 0 }; persist(); }
  } catch (cause) { unlinkSync(lock); throw cause; }
  let closed = false;
  return {
    get used() { return state.used; },
    reserve() {
      if (closed || state.used >= limit) throw new Error("LIVE_SMOKE_REQUEST_LIMIT");
      state = { grantId, limit, used: state.used + 1 };
      persist(); return state.used;
    },
    close() { if (!closed) { closed = true; unlinkSync(lock); } }
  };
}
