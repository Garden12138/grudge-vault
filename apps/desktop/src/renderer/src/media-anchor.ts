import type { SourceAnchor } from "@grudge-vault/domain";

export function mediaAnchorSeek(
  anchor: Pick<SourceAnchor, "intervalMs" | "frameTimeMs">,
  durationSeconds: number
): { positionSeconds?: number; invalid: boolean } {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return { invalid: false };
  const positionMs = anchor.intervalMs?.[0] ?? anchor.frameTimeMs;
  if (positionMs === undefined) return { invalid: false };
  const durationMs = durationSeconds * 1_000;
  const interval = anchor.intervalMs;
  if (!Number.isFinite(positionMs) || positionMs < 0 || positionMs >= durationMs ||
    (interval && (!Number.isFinite(interval[1]) || interval[1] < positionMs || interval[1] > durationMs))) {
    return { positionSeconds: 0, invalid: true };
  }
  return { positionSeconds: positionMs / 1_000, invalid: false };
}
