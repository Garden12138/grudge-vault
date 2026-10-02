// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useReadOnlySnapshot } from "./use-read-only-snapshot";

function deferred<T>() { let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
let root: Root | undefined;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => { if (root) await act(async () => root?.unmount()); root = undefined;
  document.body.replaceChildren(); vi.unstubAllGlobals(); });
async function fixture(read: () => Promise<string>, strict = false) {
  const listeners = new Set<() => void>(), unsubscribe = vi.fn();
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); unsubscribe(); }; };
  let current!: ReturnType<typeof useReadOnlySnapshot<string>>;
  function Probe() { current = useReadOnlySnapshot(read, subscribe); return null; }
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root?.render(strict ? createElement(StrictMode, null, createElement(Probe)) : createElement(Probe)));
  return { current: () => current, listeners, unsubscribe };
}

it.each(["success", "failure"] as const)("ignores a late initial %s after a newer read", async (kind) => {
  const held = deferred<string>(), read = vi.fn().mockReturnValueOnce(held.promise).mockResolvedValue("current");
  const f = await fixture(read); await act(async () => { await f.current().reload(); });
  await act(async () => kind === "success" ? held.resolve("old") : held.reject(new Error("old failure")));
  expect(f.current().value).toBe("current"); expect(f.current().error).toBeUndefined(); expect(f.current().loading).toBe(false);
});

it("retains and labels only a last successful snapshot after a non-Error failure", async () => {
  const read = vi.fn().mockResolvedValueOnce("last").mockRejectedValueOnce(undefined).mockResolvedValueOnce("fresh");
  const f = await fixture(read); await act(async () => { expect((await f.current().reload()).kind).toBe("failed"); });
  expect(f.current().value).toBe("last"); expect(f.current().error).toBeInstanceOf(Error); expect(f.current().version).toBe(1);
  await act(async () => { await f.current().reload(); }); expect(f.current().value).toBe("fresh"); expect(f.current().error).toBeUndefined();
});

it("a command result supersedes reads started before and during that command", async () => {
  const before = deferred<string>(), during = deferred<string>();
  const read = vi.fn().mockResolvedValueOnce("initial").mockReturnValueOnce(before.promise).mockReturnValueOnce(during.promise);
  const f = await fixture(read); let first!: Promise<unknown>, second!: Promise<unknown>;
  await act(async () => { first = f.current().reload(); });
  let commit!: ReturnType<ReturnType<typeof useReadOnlySnapshot<string>>["captureCommit"]>;
  await act(async () => { commit = f.current().captureCommit(); second = f.current().reload(); });
  await act(async () => { expect(commit.publish("command result")).toBe(true); });
  await act(async () => { before.resolve("old before"); during.resolve("old during"); await Promise.all([first, second]); });
  expect(f.current().value).toBe("command result"); expect(f.current().loading).toBe(false); expect(f.current().error).toBeUndefined();
});

it("rejects the older captured command even if it returns last", async () => {
  const f = await fixture(vi.fn(async () => "initial"));
  let old!: ReturnType<ReturnType<typeof useReadOnlySnapshot<string>>["captureCommit"]>, current!: typeof old;
  await act(async () => { old = f.current().captureCommit(); current = f.current().captureCommit(); });
  await act(async () => { expect(current.publish("new command")).toBe(true); expect(old.publish("old command")).toBe(false); });
  expect(old.isCurrent()).toBe(false); expect(f.current().value).toBe("new command");
});

it("balances StrictMode subscriptions and rejects its held old setup reply", async () => {
  const held = deferred<string>(), read = vi.fn().mockReturnValueOnce(held.promise).mockResolvedValueOnce("new setup");
  const f = await fixture(read, true); expect(read).toHaveBeenCalledTimes(2); expect(f.listeners.size).toBe(1); expect(f.unsubscribe).toHaveBeenCalledOnce();
  await act(async () => held.resolve("old setup")); expect(f.current().value).toBe("new setup");
  await act(async () => { root?.unmount(); root = undefined; }); expect(f.listeners.size).toBe(0); expect(f.unsubscribe).toHaveBeenCalledTimes(2);
});

it("unmount revokes reads and captured commands without issuing another request", async () => {
  const held = deferred<string>(), read = vi.fn(() => held.promise), f = await fixture(read);
  let commit!: ReturnType<ReturnType<typeof useReadOnlySnapshot<string>>["captureCommit"]>;
  await act(async () => { commit = f.current().captureCommit(); root?.unmount(); root = undefined; });
  await act(async () => { held.resolve("late"); expect(commit.publish("late command")).toBe(false); expect((await f.current().reload()).kind).toBe("stale"); });
  expect(read).toHaveBeenCalledOnce(); expect(f.listeners.size).toBe(0);
});

it("registers notifications before the initial read so a push during it supersedes it", async () => {
  const held = deferred<string>(); let push!: () => void, current!: ReturnType<typeof useReadOnlySnapshot<string>>;
  const subscribe = (listener: () => void) => { push = listener; return vi.fn(); };
  const read = vi.fn().mockImplementationOnce(() => { push(); return held.promise; }).mockResolvedValueOnce("push result");
  function Probe() { current = useReadOnlySnapshot<string>(read, subscribe); return null; }
  root = createRoot(document.body.appendChild(document.createElement("div"))); await act(async () => root?.render(createElement(Probe)));
  await act(async () => held.resolve("initial result")); expect(current.value).toBe("push result"); expect(read).toHaveBeenCalledTimes(2);
});
