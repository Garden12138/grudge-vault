import { z } from "zod";
import { AppError } from "@grudge-vault/shared";
import { SafeProcessRunner } from "@grudge-vault/media-pipeline";
import { dirname } from "node:path";

const probeSchema = z.object({ ok: z.literal(true), durationMs: z.number().int().positive().safe(),
  hasAudio: z.boolean(), hasVideo: z.boolean(), pcmBytesPerSecond: z.number().positive().finite().optional() }).strict();

/** Check self-contained references before Chromium sees a private original. Never transcode a preview. */
export function nativeMediaPreviewInspector(executable: string) {
  const runner = new SafeProcessRunner();
  return async (path: string, mimeType: string, signal: AbortSignal): Promise<void> => {
    const result = await runner.run({ executable, args: ["probe", path], cwd: dirname(path), signal,
      timeoutMs: 60_000, maxOutputBytes: 64_000, maxTemporaryBytes: 500 * 1024 * 1024 + 64_000 });
    signal.throwIfAborted();
    let raw: unknown;
    try { raw = JSON.parse(result.stdout.toString("utf8")); } catch { /* No framework diagnostics escape this boundary. */ }
    const probe = probeSchema.safeParse(raw);
    if (result.exitCode !== 0 || !probe.success || mimeType.startsWith("audio/") && (!probe.data.hasAudio || probe.data.hasVideo) ||
        mimeType.startsWith("video/") && !probe.data.hasVideo) {
      throw new AppError("ASSET_PREVIEW_UNAVAILABLE", "这个原件的自包含容器或媒体轨道无法安全检查，请保存原始副本后核对。", true);
    }
  };
}
