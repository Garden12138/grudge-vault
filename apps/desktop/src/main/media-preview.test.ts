import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OriginalMediaPreviewSource } from "@grudge-vault/application";
import { toSerializedError } from "@grudge-vault/shared";
import { MediaPreviewService, mediaPreviewRange, type MediaPreviewRequest, type MediaPreviewOptions } from "./media-preview";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function bytes(size = 200_000) { const value = Buffer.alloc(size, 37); value.write("RIFF", 0); value.write("WAVE", 8); return value; }
function request(url: string, range?: string, method = "GET", origin: string | null = "file://", signal?: AbortSignal) {
  const value = new globalThis.Request(url, { method, ...(range ? { headers: { Range: range } } : {}), ...(signal ? { signal } : {}) });
  Object.defineProperty(value, "initiatorOrigin", { value: origin ?? undefined }); return value as MediaPreviewRequest;
}
async function fixture(custom: Partial<MediaPreviewOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), "grudge-vault-preview-contract-")); roots.push(root);
  const original = bytes(); const assertCurrent = vi.fn();
  const source: OriginalMediaPreviewSource = { kind: "audio", mimeType: "audio/wav", byteSize: original.length,
    sha256: createHash("sha256").update(original).digest("hex"), assertCurrent,
    async open(signal) { return (async function* () { for (let offset = 0; offset < original.length; offset += 64 * 1024) { signal?.throwIfAborted(); yield original.subarray(offset, offset + 64 * 1024); } })(); } };
  const paths: string[] = [], reads: Array<{ start: number; end: number; byteSize: number; chunkBytes: number }> = [];
  const getSource = vi.fn(async () => source), failed = vi.fn();
  const service = new MediaPreviewService({ getSource, isTrustedOrigin: (origin) => origin === "file://", onCleanupFailure: failed,
    createTemporaryDirectory: async (prefix) => { const path = await mkdtemp(join(root, prefix)); paths.push(path); return path; },
    onRead: (value) => reads.push(value), ...custom });
  return { service, original, root, paths, source, getSource, assertCurrent, reads, failed };
}
async function absent(paths: string[]) { for (const path of paths) await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" }); }

describe("bounded single media ranges", () => {
  it.each([
    [null, { start: 0, end: 99, partial: false }], ["bytes=0-9", { start: 0, end: 9, partial: true }],
    ["bytes=90-", { start: 90, end: 99, partial: true }], ["bytes=-5", { start: 95, end: 99, partial: true }],
    ["bytes=0-999", { start: 0, end: 99, partial: true }], ["bytes=-999", { start: 0, end: 99, partial: true }],
    ["bytes=-0", undefined], ["bytes=100-", undefined], ["bytes=4-3", undefined], ["bytes=0-1,4-5", undefined],
    ["bytes=999999999999999999999-", undefined], ["bytes=--4", undefined], ["bytes=-", undefined]
  ] as const)("parses %s without unbounded or multipart reads", (header, expected) => {
    expect(mediaPreviewRange(header, 100)).toEqual(expected);
  });
});

describe.skipIf(process.platform === "win32")("private authenticated preview leases", () => {
  it("returns only an opaque capability after authentication, then serves full, HEAD and exact ranges", async () => {
    const test = await fixture(); const id = randomUUID(), assetId = randomUUID(); const preview = await test.service.open(id, assetId);
    expect(Object.keys(preview).sort()).toEqual(["assetId", "byteSize", "mimeType", "requestId", "url"]);
    expect(preview.url).toMatch(/^gv-preview:\/\/media\/[a-f0-9]{64}$/); expect(JSON.stringify(preview)).not.toContain(test.root);
    expect((await lstat(test.paths[0]!)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(test.paths[0]!, "original.wav"))).mode & 0o777).toBe(0o600);
    const full = await test.service.handle(request(preview.url)); expect(full.status).toBe(200);
    expect(full.headers.get("cache-control")).toBe("no-store"); expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect(Buffer.from(await full.arrayBuffer()).equals(test.original)).toBe(true);
    expect(Math.max(...test.reads.map(({ chunkBytes }) => chunkBytes))).toBeLessThanOrEqual(64 * 1024);
    for (const [range, from, to] of [["bytes=100-199", 100, 199], ["bytes=-17", test.original.length - 17, test.original.length - 1],
      [`bytes=${test.original.length - 11}-`, test.original.length - 11, test.original.length - 1]] as const) {
      const part = await test.service.handle(request(preview.url, range)); expect(part.status).toBe(206);
      expect(part.headers.get("content-range")).toBe(`bytes ${from}-${to}/${test.original.length}`);
      expect(Buffer.from(await part.arrayBuffer()).equals(test.original.subarray(from, to + 1))).toBe(true);
    }
    const head = await test.service.handle(request(preview.url, undefined, "HEAD")); expect(head.status).toBe(200);
    expect(await head.text()).toBe(""); expect(head.headers.get("content-length")).toBe(String(test.original.length));
    const invalid = await test.service.handle(request(preview.url, `bytes=${test.original.length}-`));
    expect(invalid.status).toBe(416); expect(invalid.headers.get("content-range")).toBe(`bytes */${test.original.length}`);
    await test.service.close(id); await absent(test.paths); expect((await test.service.handle(request(preview.url))).status).toBe(404);
  });

  it("streams a 70 MiB source without sending bytes over IPC or allocating a full playback response", async () => {
    const test = await fixture({ inspect: async () => {} });
    const block = Buffer.alloc(64 * 1024, 91), size = 70 * 1024 * 1024;
    const hash = createHash("sha256"); for (let index = 0; index < size / block.length; index++) hash.update(block);
    test.source.byteSize = size; test.source.sha256 = hash.digest("hex");
    test.source.open = async (signal) => (async function* () { for (let offset = 0; offset < size; offset += block.length) { signal?.throwIfAborted(); yield block; } })();
    const id = randomUUID(), preview = await test.service.open(id, randomUUID()); expect(preview.byteSize).toBe(size);
    expect((await lstat(join(test.paths[0]!, "original.wav"))).size).toBe(size);
    const tail = await test.service.handle(request(preview.url, "bytes=-123"));
    expect(tail.status).toBe(206); expect(Buffer.from(await tail.arrayBuffer()).equals(block.subarray(0, 123))).toBe(true);
    expect(test.reads).toEqual([{ start: size - 123, end: size - 1, byteSize: size, chunkBytes: 123 }]);
    await test.service.close(id); await absent(test.paths);
  }, 20_000);

  it.each(["https://untrusted.example", "null", "absent"])("denies untrusted initiator %s independently of the token", async (origin) => {
    const test = await fixture(); const id = randomUUID(), preview = await test.service.open(id, randomUUID());
    expect((await test.service.handle(request(preview.url, undefined, "GET", origin === "absent" ? null : origin))).status).toBe(403);
    expect(test.reads).toEqual([]); await test.service.close(id);
  });

  it.each(["?path=/private.txt", "#fragment", "/../original.media", "/extra"])("rejects altered capability URL %s", async (suffix) => {
    const test = await fixture(); const id = randomUUID(), preview = await test.service.open(id, randomUUID());
    expect((await test.service.handle(request(preview.url + suffix))).status).toBe(404);
    expect(test.reads).toEqual([]); await test.service.close(id);
  });

  it("denies mutating methods and limits overlapping readers", async () => {
    const test = await fixture(); const id = randomUUID(), preview = await test.service.open(id, randomUUID());
    expect((await test.service.handle(request(preview.url, undefined, "POST"))).status).toBe(405);
    const held = await Promise.all(Array.from({ length: 4 }, () => test.service.handle(request(preview.url))));
    expect(held.map(({ status }) => status)).toEqual([200, 200, 200, 200]);
    expect((await test.service.handle(request(preview.url))).status).toBe(429);
    await Promise.all(held.map((response) => response.body!.cancel()));
    const next = await test.service.handle(request(preview.url, "bytes=0-11")); expect(next.status).toBe(206); await next.arrayBuffer();
    await test.service.close(id); await absent(test.paths);
  });

  it.each(["size", "hash", "authentication"])("does not decode or publish a source with failed %s", async (mode) => {
    const inspect = vi.fn(async () => {}); const test = await fixture({ inspect });
    if (mode === "size") test.source.byteSize += 1;
    if (mode === "hash") test.source.sha256 = "f".repeat(64);
    if (mode === "authentication") test.source.open = async () => (async function* () { yield test.original; throw new Error("private-original-name GCM failure"); })();
    const failure = await test.service.open(randomUUID(), randomUUID()).then(() => undefined, (error: unknown) => error);
    expect(failure).toMatchObject({ code: "ASSET_CORRUPT" }); expect(JSON.stringify(toSerializedError(failure))).not.toContain("private-original-name");
    expect(inspect).not.toHaveBeenCalled(); await absent(test.paths);
  });

  it("cancels a pending native check, waits for it, and rejects an early close before open", async () => {
    let begin!: () => void; const started = new Promise<void>((resolve) => { begin = resolve; });
    const inspect = vi.fn(async (_path: string, _mime: string, signal: AbortSignal) => {
      begin(); await new Promise<void>((_resolve, reject) => { signal.addEventListener("abort", () => reject(signal.reason), { once: true }); });
    });
    const test = await fixture({ inspect }); const id = randomUUID();
    const pending = test.service.open(id, randomUUID()); const rejection = expect(pending).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    await started; expect(await readdir(test.root)).toHaveLength(1);
    await test.service.close(id); await rejection; await absent(test.paths);
    const early = randomUUID(); await test.service.close(early);
    await expect(test.service.open(early, randomUUID())).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
  });

  it("closes live responses and revokes old URLs before resume after lock", async () => {
    const test = await fixture(); const preview = await test.service.open(randomUUID(), randomUUID());
    const response = await test.service.handle(request(preview.url)); const reader = response.body!.getReader();
    expect((await reader.read()).value!.byteLength).toBeLessThanOrEqual(64 * 1024);
    await test.service.closeAll(); await expect(reader.read()).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    await absent(test.paths); expect((await test.service.handle(request(preview.url))).status).toBe(404);
    await expect(test.service.open(randomUUID(), randomUUID())).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    test.service.resume(); const next = await test.service.open(randomUUID(), randomUUID());
    expect(next.url).not.toBe(preview.url); await test.service.closeAll();
  });

  it("refuses a changed workspace, modified file or replaced inode without serving bytes", async () => {
    const test = await fixture(); const id = randomUUID(), preview = await test.service.open(id, randomUUID());
    test.assertCurrent.mockImplementationOnce(() => { throw new Error("Synthetic locked workspace"); });
    expect((await test.service.handle(request(preview.url))).status).toBe(404);
    await writeFile(join(test.paths[0]!, "original.wav"), Buffer.alloc(test.original.length));
    expect((await test.service.handle(request(preview.url))).status).toBe(404);
    expect(test.reads).toEqual([]); await test.service.close(id);
  });

  it.each(["unknown file", "symlink", "owner"])("refuses destructive cleanup after %s tampering and blocks new leases", async (mode) => {
    const test = await fixture(); const id = randomUUID(); await test.service.open(id, randomUUID());
    if (mode === "unknown file") await writeFile(join(test.paths[0]!, "unknown.txt"), "synthetic");
    if (mode === "symlink") await symlink(join(test.paths[0]!, "original.wav"), join(test.paths[0]!, "unknown.txt"));
    if (mode === "owner") await writeFile(join(test.paths[0]!, "owner"), "replaced");
    await expect(test.service.close(id)).rejects.toMatchObject({ code: "CLEANUP_FAILED" });
    expect((await lstat(test.paths[0]!)).isDirectory()).toBe(true); expect(test.failed).toHaveBeenCalledOnce();
    test.service.resume(); await expect(test.service.open(randomUUID(), randomUUID())).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
  });

  it("enforces lease and byte budgets before creating another plaintext copy", async () => {
    const test = await fixture(); const ids = Array.from({ length: 4 }, () => randomUUID());
    await Promise.all(ids.map((id) => test.service.open(id, randomUUID())));
    await expect(test.service.open(randomUUID(), randomUUID())).rejects.toMatchObject({ code: "ASSET_PREVIEW_UNAVAILABLE" });
    expect(test.paths).toHaveLength(4); await test.service.closeAll(); await absent(test.paths);
    const large = await fixture({ inspect: async () => {} }); large.source.byteSize = 500 * 1024 * 1024;
    large.source.open = async (signal) => (async function* () { signal?.throwIfAborted(); await new Promise<void>((_resolve, reject) => {
      signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
    }); yield new Uint8Array(); })();
    const first = large.service.open(randomUUID(), randomUUID()); const firstRejected = expect(first).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    const second = large.service.open(randomUUID(), randomUUID()); const secondRejected = expect(second).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    await vi.waitFor(() => expect(large.paths).toHaveLength(2));
    await expect(large.service.open(randomUUID(), randomUUID())).rejects.toMatchObject({ code: "ASSET_PREVIEW_UNAVAILABLE" });
    await large.service.closeAll(); await firstRejected; await secondRejected; await absent(large.paths);
  });

  it("expires session-only capabilities and cleans their private copies", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000); const test = await fixture();
    const preview = await test.service.open(randomUUID(), randomUUID()); now.mockReturnValue(1_000_000 + 4 * 60 * 60 * 1000);
    await test.service.expire(); await absent(test.paths); expect((await test.service.handle(request(preview.url))).status).toBe(404);
  });
});
