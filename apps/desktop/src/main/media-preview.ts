import { createHash, randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, readFile, readdir, rm, writeFile, type FileHandle } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import type { OriginalMediaPreviewSource } from "@grudge-vault/application";
import { AppError, type AssetMediaPreview } from "@grudge-vault/shared";

export const MEDIA_PREVIEW_SCHEME = "gv-preview";
const MAX_SOURCE_BYTES = 500 * 1024 * 1024;
const MAX_RESERVED_BYTES = 1024 * 1024 * 1024;
const MAX_PREVIEWS = 4;
const READ_CHUNK_BYTES = 64 * 1024;
const LIFETIME_MS = 4 * 60 * 60 * 1000;
const OWNER = "grudge-vault-media-preview-v1\n";
const MIME_TYPES = new Map([
  ["audio/wav", "audio/wav"], ["audio/x-wav", "audio/wav"], ["audio/mpeg", "audio/mpeg"],
  ["audio/mp4", "audio/mp4"], ["audio/x-m4a", "audio/mp4"],
  ["video/mp4", "video/mp4"], ["video/quicktime", "video/quicktime"]
]);
const EXTENSIONS = new Map([["audio/wav", "wav"], ["audio/mpeg", "mp3"], ["audio/mp4", "m4a"],
  ["video/mp4", "mp4"], ["video/quicktime", "mov"]]);

type Entry = {
  requestId: string; assetId: string; controller: AbortController; done: Promise<void>; finish(): void;
  directory?: string; directoryIdentity?: Stats; source?: OriginalMediaPreviewSource; fileIdentity?: Stats;
  fileName?: string;
  token?: string; expiresAt?: number; reservedBytes: number; reads: Set<{ close(): Promise<void> }>;
  readSlots: number;
  cleanup?: Promise<void>;
};
export interface MediaPreviewRequest extends globalThis.Request { readonly initiatorOrigin?: string; }
export interface MediaPreviewOptions {
  getSource(assetId: string): Promise<OriginalMediaPreviewSource>;
  createTemporaryDirectory(prefix: string): Promise<string>;
  isTrustedOrigin(origin: string | undefined): boolean;
  inspect?(path: string, mimeType: string, signal: AbortSignal): Promise<void>;
  onCleanupFailure?(): void;
  onRead?(value: { start: number; end: number; byteSize: number; chunkBytes: number }): void;
}

export function mediaPreviewRange(header: string | null, size: number): { start: number; end: number; partial: boolean } | undefined {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || !match[1] && !match[2]) return undefined;
  const first = match[1] ? Number(match[1]) : undefined, last = match[2] ? Number(match[2]) : undefined;
  if (first !== undefined && !Number.isSafeInteger(first) || last !== undefined && !Number.isSafeInteger(last)) return undefined;
  const start = first ?? Math.max(0, size - last!);
  const end = first === undefined ? size - 1 : Math.min(last ?? size - 1, size - 1);
  return start < 0 || start >= size || end < start ? undefined : { start, end, partial: true };
}

/** Session-only capabilities; no listener port, public URL, filesystem path or original bytes cross IPC. */
export class MediaPreviewService {
  private readonly entries = new Map<string, Entry>();
  private readonly cancelled = new Set<string>();
  private reservedBytes = 0;
  private accepting = true;
  private cleanupFailed = false;

  constructor(private readonly options: MediaPreviewOptions) {}

  open(requestId: string, assetId: string): Promise<AssetMediaPreview> {
    if (!this.accepting || this.cleanupFailed || this.cancelled.has(requestId)) {
      return Promise.reject(new AppError("SOURCE_UNAVAILABLE", "原件预览已取消或工作区正在变化，请重新打开。", true));
    }
    if (this.entries.has(requestId) || this.entries.size >= MAX_PREVIEWS) {
      return Promise.reject(new AppError("ASSET_PREVIEW_UNAVAILABLE", "预览数量达到上限，请先关闭其他预览。", true));
    }
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const entry: Entry = { requestId, assetId, controller: new AbortController(), done, finish, reservedBytes: 0, reads: new Set(), readSlots: 0 };
    this.entries.set(requestId, entry);
    return this.prepare(entry).finally(finish);
  }

  private assertCurrent(entry: Entry): void {
    entry.controller.signal.throwIfAborted();
    if (!this.accepting || this.entries.get(entry.requestId) !== entry) throw new AppError("SOURCE_UNAVAILABLE", "原件预览会话已失效。", true);
    entry.source?.assertCurrent();
  }

  private async prepare(entry: Entry): Promise<AssetMediaPreview> {
    try {
      const source = await this.options.getSource(entry.assetId);
      entry.source = source; this.assertCurrent(entry);
      const mimeType = MIME_TYPES.get(source.mimeType);
      if (!mimeType || !mimeType.startsWith(`${source.kind}/`) || !Number.isSafeInteger(source.byteSize) || source.byteSize <= 0 || source.byteSize > MAX_SOURCE_BYTES ||
          !/^[a-f0-9]{64}$/.test(source.sha256)) throw new AppError("ASSET_PREVIEW_UNAVAILABLE", "这个原件超出当前音视频预览范围。", true);
      if (this.reservedBytes + source.byteSize > MAX_RESERVED_BYTES) throw new AppError("ASSET_PREVIEW_UNAVAILABLE", "预览占用达到上限，请先关闭其他预览。", true);
      entry.reservedBytes = source.byteSize; this.reservedBytes += source.byteSize;
      entry.fileName = `original.${EXTENSIONS.get(mimeType)!}`;
      const directory = await this.options.createTemporaryDirectory("media-preview-");
      entry.directory = directory;
      entry.directoryIdentity = await this.assertDirectory(directory);
      if ((await readdir(directory)).length) throw new AppError("CLEANUP_FAILED", "预览处理目录不是新的空目录。");
      await writeFile(join(directory, "owner"), OWNER, { flag: "wx", mode: 0o600 });
      this.assertCurrent(entry);
      const path = join(directory, entry.fileName);
      const file = await open(path, "wx", 0o600);
      try {
        const hash = createHash("sha256"); let size = 0;
        for await (const chunk of await source.open(entry.controller.signal)) {
          this.assertCurrent(entry); size += chunk.byteLength;
          if (size > source.byteSize) throw new AppError("ASSET_CORRUPT", "原件大小与附件信息不一致。");
          for (let offset = 0; offset < chunk.byteLength; offset += READ_CHUNK_BYTES) {
            this.assertCurrent(entry);
            const copied = Buffer.from(chunk.subarray(offset, offset + READ_CHUNK_BYTES));
            hash.update(copied); await file.writeFile(copied);
          }
        }
        this.assertCurrent(entry);
        if (size !== source.byteSize || hash.digest("hex") !== source.sha256) throw new AppError("ASSET_CORRUPT", "原件摘要与附件信息不一致。");
      } finally { await file.close(); }
      // Authentication must finish before any decoder, URL or player sees plaintext.
      if (this.options.inspect) await this.options.inspect(path, mimeType, entry.controller.signal);
      else await this.assertPortableAudio(path, mimeType);
      this.assertCurrent(entry);
      entry.fileIdentity = await lstat(path);
      if (!this.validFile(entry.fileIdentity, source.byteSize)) throw new AppError("SOURCE_UNAVAILABLE", "原件预览副本身份异常。", true);
      entry.token = randomBytes(32).toString("hex"); entry.expiresAt = Date.now() + LIFETIME_MS;
      return { requestId: entry.requestId, assetId: entry.assetId, mimeType, byteSize: source.byteSize,
        url: `${MEDIA_PREVIEW_SCHEME}://media/${entry.token}` };
    } catch (cause) {
      await this.cleanup(entry);
      if (entry.controller.signal.aborted) throw entry.controller.signal.reason;
      if (cause instanceof AppError) throw cause;
      throw new AppError("ASSET_CORRUPT", "原件预览副本无法完整认证，请核对原件。", true, { cause });
    }
  }

  private validFile(info: Stats, size: number): boolean {
    return info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size === size &&
      (process.platform === "win32" || (info.mode & 0o777) === 0o600) && (!process.getuid || info.uid === process.getuid());
  }

  private async assertDirectory(path: string, identity?: Stats): Promise<Stats> {
    const info = await lstat(path);
    if (!isAbsolute(path) || !/^media-preview-[A-Za-z0-9]{6}$/.test(basename(path)) || !info.isDirectory() ||
        info.isSymbolicLink() || process.platform !== "win32" && (info.mode & 0o777) !== 0o700 || process.getuid && info.uid !== process.getuid() ||
        identity && (info.dev !== identity.dev || info.ino !== identity.ino)) {
      throw new AppError("CLEANUP_FAILED", "原件预览需要独立私有处理目录。");
    }
    return info;
  }

  private async assertPortableAudio(path: string, mimeType: string): Promise<void> {
    const file = await open(path, "r");
    try {
      const bytes = Buffer.alloc(12); const { bytesRead } = await file.read(bytes, 0, 12, 0);
      const wav = mimeType === "audio/wav" && bytesRead === 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE";
      const mp3 = mimeType === "audio/mpeg" && bytesRead >= 3 && (bytes.toString("ascii", 0, 3) === "ID3" || bytes[0] === 255 && (bytes[1]! & 0xe0) === 0xe0);
      if (!wav && !mp3) throw new AppError("ASSET_PREVIEW_UNAVAILABLE", "当前环境不能安全检查这个音视频容器，请保存原始副本后查看。", true);
    } finally { await file.close(); }
  }

  async close(requestId: string): Promise<boolean> {
    this.cancelled.add(requestId);
    while (this.cancelled.size > 128) this.cancelled.delete(this.cancelled.values().next().value!);
    const entry = this.entries.get(requestId);
    if (!entry) return true;
    entry.controller.abort(new AppError("SOURCE_UNAVAILABLE", "原件预览已关闭。", true));
    await Promise.all([...entry.reads].map((read) => read.close()));
    await entry.done; await this.cleanup(entry); return true;
  }

  async closeAll(): Promise<void> {
    this.accepting = false;
    await Promise.all([...this.entries.keys()].map((id) => this.close(id)));
  }

  resume(): void { if (!this.cleanupFailed) this.accepting = true; }

  async expire(): Promise<void> {
    await Promise.all([...this.entries.values()].filter(({ expiresAt }) => expiresAt !== undefined && expiresAt <= Date.now()).map(({ requestId }) => this.close(requestId)));
  }

  private cleanup(entry: Entry): Promise<void> {
    if (entry.cleanup) return entry.cleanup;
    entry.cleanup = (async () => {
      try {
        if (entry.directory) {
          if (!entry.directoryIdentity) throw new Error("Unknown preview directory identity");
          await this.assertDirectory(entry.directory, entry.directoryIdentity);
          const marker = await lstat(join(entry.directory, "owner"));
          if (!this.validFile(marker, Buffer.byteLength(OWNER)) || await readFile(join(entry.directory, "owner"), "utf8") !== OWNER) throw new Error("Invalid preview owner");
          const contents = await readdir(entry.directory, { withFileTypes: true });
          if (contents.some((item) => !["owner", entry.fileName].includes(item.name) || !item.isFile() || item.isSymbolicLink())) throw new Error("Unknown preview contents");
          await rm(entry.directory, { recursive: true, force: false });
        }
        this.entries.delete(entry.requestId); this.reservedBytes -= entry.reservedBytes; entry.reservedBytes = 0;
      } catch (cause) {
        this.cleanupFailed = true; this.options.onCleanupFailure?.();
        throw new AppError("CLEANUP_FAILED", "原件预览副本清理失败，请检查本机临时存储并重新启动。", true, { cause });
      }
    })();
    return entry.cleanup;
  }

  async handle(request: MediaPreviewRequest): Promise<globalThis.Response> {
    const fixed = (status: number, extra?: Record<string, string>) => new globalThis.Response(null, {
      status, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", ...extra }
    });
    if (!this.options.isTrustedOrigin(request.initiatorOrigin)) return fixed(403);
    if (request.method !== "GET" && request.method !== "HEAD") return fixed(405, { Allow: "GET, HEAD" });
    const token = new RegExp(`^${MEDIA_PREVIEW_SCHEME}://media/([a-f0-9]{64})$`).exec(request.url)?.[1];
    const entry = token && [...this.entries.values()].find((value) => value.token === token);
    if (!entry || !entry.source || !entry.fileIdentity || !entry.directory) return fixed(404);
    if (entry.expiresAt! <= Date.now()) { await this.close(entry.requestId); return fixed(404); }
    let file: FileHandle | undefined;
    if (entry.readSlots >= 4) return fixed(429);
    entry.readSlots += 1;
    let transferred = false;
    try {
      this.assertCurrent(entry);
      const range = mediaPreviewRange(request.headers.get("range"), entry.source.byteSize);
      if (!range) return fixed(416, { "Content-Range": `bytes */${entry.source.byteSize}` });
      await this.assertDirectory(entry.directory, entry.directoryIdentity);
      file = await open(join(entry.directory, entry.fileName!), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const info = await file.stat(), original = entry.fileIdentity;
      if (!this.validFile(info, entry.source.byteSize) || info.dev !== original.dev || info.ino !== original.ino ||
          info.mtimeMs !== original.mtimeMs || info.ctimeMs !== original.ctimeMs) throw new AppError("SOURCE_UNAVAILABLE", "预览副本在播放前发生变化。", true);
      this.assertCurrent(entry);
      const headers: Record<string, string> = { "Content-Type": MIME_TYPES.get(entry.source.mimeType)!,
        "Content-Length": String(range.end - range.start + 1), "Accept-Ranges": "bytes", "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
      if (range.partial) headers["Content-Range"] = `bytes ${range.start}-${range.end}/${entry.source.byteSize}`;
      if (request.method === "HEAD") { await file.close(); file = undefined; return new globalThis.Response(null, { status: range.partial ? 206 : 200, headers }); }
      const handle = file; file = undefined;
      let position = range.start, closed = false, closing: Promise<void> | undefined;
      let bodyController: globalThis.ReadableStreamDefaultController<Uint8Array> | undefined;
      const read = { close: () => {
        if (closing) return closing;
        closed = true;
        bodyController?.error(new AppError("SOURCE_UNAVAILABLE", "原件预览读取已停止。", true));
        closing = handle.close().finally(() => {
          entry.reads.delete(read); entry.readSlots -= 1; request.signal.removeEventListener("abort", abort);
        });
        return closing;
      } };
      const abort = () => { void read.close().catch(() => {}); };
      const body = new globalThis.ReadableStream<Uint8Array>({
        start(controller) { bodyController = controller; },
        pull: async (controller) => {
          if (closed) return;
          try {
            request.signal.throwIfAborted(); this.assertCurrent(entry);
            const buffer = Buffer.alloc(Math.min(READ_CHUNK_BYTES, range.end - position + 1));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
            if (closed) return;
            this.assertCurrent(entry); request.signal.throwIfAborted();
            if (bytesRead !== buffer.length) throw new AppError("SOURCE_UNAVAILABLE", "预览副本读取不完整。", true);
            this.options.onRead?.({ start: position, end: position + bytesRead - 1, byteSize: entry.source!.byteSize, chunkBytes: bytesRead });
            position += bytesRead; controller.enqueue(new Uint8Array(buffer));
            if (position > range.end) {
              closed = true; controller.close();
              closing = handle.close().finally(() => { entry.reads.delete(read); entry.readSlots -= 1; request.signal.removeEventListener("abort", abort); });
              await closing;
            }
          } catch (cause) {
            if (!closed) controller.error(new AppError("SOURCE_UNAVAILABLE", "原件预览读取已停止。", true, { cause }));
            await read.close();
          }
        },
        cancel: () => read.close()
      });
      entry.reads.add(read); request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) abort();
      transferred = true;
      return new globalThis.Response(body, { status: range.partial ? 206 : 200, headers });
    } catch {
      if (file) await file.close();
      return fixed(404);
    } finally { if (!transferred) entry.readSlots -= 1; }
  }
}
