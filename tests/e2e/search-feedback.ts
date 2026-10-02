import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { CDPSession, Page } from "@playwright/test";

export interface FeedbackObservation {
  trustedSubmission: boolean;
  domDelayMs?: number;
  nextFrameDelayMs?: number;
  phaseVisible: boolean;
  falseEmpty: boolean;
  staleResults: boolean;
  prematureCapabilities: boolean;
}

// Only installed in an owned synthetic test renderer. No DOM text, query or IDs are collected.
export async function armSearchFeedback(page: Page, prefix: string): Promise<void> {
  await page.evaluate((prefix) => {
    const form = document.querySelector(".search-box");
    if (!form) throw new Error("Synthetic search form missing");
    const state: FeedbackObservation = { trustedSubmission: false, phaseVisible: false,
      falseEmpty: false, staleResults: false, prematureCapabilities: false };
    (window as typeof window & { __gvFeedback?: FeedbackObservation }).__gvFeedback = state;
    form.addEventListener("submit", (event) => {
      const start = globalThis.performance.now();
      state.trustedSubmission = event.isTrusted;
      globalThis.performance.mark(`${prefix}-submit`);
      const observer = new globalThis.MutationObserver(() => {
        const phase = document.querySelector(".stage-progress");
        if (!phase) return;
        const box = phase.getBoundingClientRect(), style = globalThis.getComputedStyle(phase);
        if (box.width <= 0 || box.height <= 0 || box.top < 0 || box.bottom > globalThis.innerHeight ||
          style.visibility === "hidden" || style.display === "none") return;
        const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        if (!top || !phase.contains(top)) return;
        state.phaseVisible = true;
        state.domDelayMs = globalThis.performance.now() - start;
        state.falseEmpty = Boolean(document.querySelector(".search-page .empty-state"));
        state.staleResults = Boolean(document.querySelector(".search-results"));
        state.prematureCapabilities = Boolean(document.querySelector(".search-capabilities"));
        globalThis.performance.mark(`${prefix}-visible-dom`);
        observer.disconnect();
        globalThis.requestAnimationFrame(() => {
          state.nextFrameDelayMs = globalThis.performance.now() - start;
          globalThis.performance.mark(`${prefix}-frame-after-dom`);
        });
      });
      observer.observe(form.parentElement!, { childList: true, subtree: true, attributes: true });
    }, { capture: true, once: true });
  }, prefix);
}

export async function beginFeedbackTrace(page: Page): Promise<CDPSession> {
  const session = await page.context().newCDPSession(page);
  await session.send("Tracing.start", { transferMode: "ReturnAsStream",
    categories: "-*,blink.user_timing,devtools.timeline,disabled-by-default-devtools.timeline.frame,disabled-by-default-devtools.screenshot" });
  return session;
}

interface TraceEvent { name: string; ts: number; pid: number; args?: { snapshot?: string } }

export async function finishFeedbackTrace(session: CDPSession, path: string, prefix: string) {
  const complete = new Promise<{ stream?: string }>((resolve) => session.once("Tracing.tracingComplete", resolve));
  await session.send("Tracing.end");
  const { stream } = await complete;
  if (!stream) throw new Error("Synthetic feedback trace returned no stream");
  const chunks: Buffer[] = []; let total = 0;
  try {
    while (true) {
      const part = await session.send("IO.read", { handle: stream });
      const bytes = Buffer.from(part.data, part.base64Encoded ? "base64" : "utf8");
      chunks.push(bytes); total += bytes.length;
      if (total > 32 * 1024 * 1024) throw new Error("Synthetic feedback trace exceeded its bounded capture size");
      if (part.eof) break;
    }
  } finally { await session.send("IO.close", { handle: stream }); }
  const bytes = Buffer.concat(chunks);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return inspectFeedbackTrace(path, prefix);
}

export async function inspectFeedbackTrace(path: string, prefix: string) {
  const bytes = await readFile(path);
  const trace = JSON.parse(bytes.toString("utf8")) as { traceEvents: TraceEvent[] };
  const submit = trace.traceEvents.find(({ name }) => name === `${prefix}-submit`);
  const visible = trace.traceEvents.find(({ name }) => name === `${prefix}-visible-dom`);
  if (!submit || !visible || submit.pid !== visible.pid || visible.ts < submit.ts) {
    throw new Error("Synthetic feedback trace is missing its ordered renderer markers");
  }
  const frames = trace.traceEvents.filter(({ name, ts, args }) => name === "Screenshot" && ts >= visible.ts && args?.snapshot)
    .sort((a, b) => a.ts - b.ts);
  const candidates: Array<{ frameIndex: number; traceDelayMs: number; frameFile: string }> = [];
  for (const [index, frame] of frames.slice(0, 5).entries()) {
    const framePath = `${path}.frame-${index}.jpg`;
    await writeFile(framePath, Buffer.from(frame.args!.snapshot!, "base64"));
    candidates.push({ frameIndex: index, traceDelayMs: (frame.ts - submit.ts) / 1000, frameFile: basename(framePath) });
  }
  return { traceBytes: bytes.length, domTraceDelayMs: (visible.ts - submit.ts) / 1000,
    capturedFramesAfterDom: frames.length, candidates,
    limits: "Trace timestamp of a captured frame, not physical display latency or all-path/target-device certification; inspect the frame before claiming it shows feedback." };
}
