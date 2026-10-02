import { z } from "zod";
import type { NativeMediaProgress } from "@grudge-vault/domain";

const schema = z.object({
  sessionId: z.string().uuid(), mediaId: z.string().uuid(),
  mediaNumber: z.number().int().min(1).max(20), mediaCount: z.number().int().min(1).max(20),
  stage: z.enum(["processing", "understanding", "checked", "summarizing"]),
  segmentNumber: z.number().int().min(0).max(128), checkedDurationMs: z.number().int().nonnegative(),
  sourceDurationMs: z.number().int().positive().optional()
}).strict().refine((value) => value.mediaNumber <= value.mediaCount &&
  (value.sourceDurationMs === undefined || value.checkedDurationMs <= value.sourceDurationMs) &&
  (["processing", "summarizing"].includes(value.stage) || value.segmentNumber > 0 && value.sourceDurationMs !== undefined));

export function parseMediaProgress(value: unknown): (NativeMediaProgress & { sessionId: string }) | undefined {
  const parsed = schema.safeParse(value);
  if (!parsed.success) return undefined;
  const { sourceDurationMs, ...fields } = parsed.data;
  return { ...fields, ...(sourceDurationMs !== undefined ? { sourceDurationMs } : {}) };
}

interface EventPort {
  on(channel: string, listener: (event: unknown, value: unknown) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, value: unknown) => void): unknown;
}

export function subscribeMediaProgress(port: EventPort, channel: "intake:media-progress" | "records:search-media-progress",
  callback: (value: NativeMediaProgress & { sessionId: string }) => void): () => void {
  let active = true;
  const listener = (_event: unknown, value: unknown) => {
    if (!active) return;
    const parsed = parseMediaProgress(value); if (parsed) callback(parsed);
  };
  port.on(channel, listener);
  return () => { if (active) { active = false; port.removeListener(channel, listener); } };
}
