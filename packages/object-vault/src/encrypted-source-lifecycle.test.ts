import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { EncryptedObjectVault } from "./index";

const sources = vi.hoisted(() => [] as import("node:fs").ReadStream[]);
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    createReadStream: (...args: Parameters<typeof fs.createReadStream>) => {
      const stream = fs.createReadStream(...args);
      sources.push(stream);
      return stream;
    }
  };
});

async function withObject(version: "v1" | "v2", run: (fixture: {
  plaintext: Readable;
  encrypted: import("node:fs").ReadStream;
  content: Buffer;
  objectPath: string;
}) => Promise<void>, corruptTag = false): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "grudge-vault-source-lifecycle-"));
  let plaintext: Readable | undefined;
  const firstSource = sources.length;
  try {
    const content = Buffer.alloc(4 * 1024 * 1024, 0x2a);
    const keyBytes = randomBytes(32);
    const keyId = randomUUID();
    const key = version === "v1" ? keyBytes : {
      activeKeyId: keyId, legacyKeyId: keyId, keys: new Map([[keyId, keyBytes]])
    };
    const vault = new EncryptedObjectVault(join(root, "vault"));
    const object = await vault.putStream(Readable.from(content), key, content.length);
    const objectPath = vault.objectPath(object.sha256);
    if (corruptTag) {
      const bytes = await readFile(objectPath);
      bytes[bytes.length - 1]! ^= 0x80;
      await writeFile(objectPath, bytes);
    }
    plaintext = await vault.open(object.sha256, key);
    const encrypted = sources.slice(firstSource).find((source) => source.path === objectPath);
    if (!encrypted) throw new Error("Expected a real encrypted file source.");
    await run({ plaintext, encrypted, content, objectPath });
  } finally {
    plaintext?.destroy();
    // Clean up even when proving a regression in cancellation handling.
    for (const source of sources.slice(firstSource)) source.destroy();
    await Promise.all(sources.slice(firstSource).map(async (source) => {
      await vi.waitFor(() => expect(source.closed).toBe(true));
    }));
    sources.splice(firstSource);
    await rm(root, { recursive: true, force: true });
  }
}

describe.each(["v1", "v2"] as const)("encrypted source lifecycle (%s)", (version) => {
  it("closes the underlying file when the consumer destroys a partially read stream", async () => {
    await withObject(version, async ({ plaintext, encrypted, content, objectPath }) => {
      const original = await readFile(objectPath);
      const iterator = plaintext[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(first.done).toBe(false);
      expect(first.value.length).toBeLessThan(content.length);
      plaintext.destroy();
      await vi.waitFor(() => expect(encrypted.closed).toBe(true), { timeout: 400 });
      expect(encrypted.destroyed).toBe(true);
      expect((await readFile(objectPath)).equals(original)).toBe(true);
    });
  });

  it("closes the underlying file when the consumer leaves an async iterator early", async () => {
    await withObject(version, async ({ plaintext, encrypted, content }) => {
      for await (const chunk of plaintext) {
        expect(chunk.length).toBeLessThan(content.length);
        break;
      }
      await vi.waitFor(() => expect(encrypted.closed).toBe(true), { timeout: 400 });
      expect(encrypted.destroyed).toBe(true);
    });
  });

  it("preserves full authenticated reads and closes the underlying file", async () => {
    await withObject(version, async ({ plaintext, encrypted, content }) => {
      const chunks: Buffer[] = [];
      for await (const chunk of plaintext) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).equals(content)).toBe(true);
      await vi.waitFor(() => expect(encrypted.closed).toBe(true));
    });
  });

  it("propagates authentication failure and still closes the underlying file", async () => {
    await withObject(version, async ({ plaintext, encrypted }) => {
      await expect((async () => {
        for await (const chunk of plaintext) expect(chunk.length).toBeGreaterThan(0);
      })()).rejects.toThrow();
      await vi.waitFor(() => expect(encrypted.closed).toBe(true));
    }, true);
  });
});
