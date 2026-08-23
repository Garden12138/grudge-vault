import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { EncryptedObjectVault } from "./index";

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe("EncryptedObjectVault", () => {
  it("encrypts, verifies, opens, and deduplicates objects", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-object-"));
    try {
      const input = join(root, "evidence.txt");
      const content = Buffer.from("A durable original record.\n".repeat(2_000));
      await writeFile(input, content);
      const vault = new EncryptedObjectVault(join(root, "vault"));
      const key = randomBytes(32);

      const first = await vault.put(input, key);
      const progress: number[] = [];
      const second = await vault.putStream(Readable.from(content), key, content.length, (value) => progress.push(value));

      expect(first.sha256).toHaveLength(64);
      expect(first.deduplicated).toBe(false);
      expect(second.deduplicated).toBe(true);
      expect(progress.at(-1)).toBe(1);
      expect(await vault.verify(first.sha256, key)).toBe(true);
      expect(await readAll(await vault.open(first.sha256, key))).toEqual(content);
      expect(await readFile(vault.objectPath(first.sha256))).not.toContain(content);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detects authenticated ciphertext tampering", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-tamper-"));
    try {
      const input = join(root, "sample.bin");
      await writeFile(input, randomBytes(1_024));
      const vault = new EncryptedObjectVault(join(root, "vault"));
      const key = randomBytes(32);
      const stored = await vault.put(input, key);
      const objectPath = vault.objectPath(stored.sha256);
      const bytes = await readFile(objectPath);
      bytes[Math.floor(bytes.length / 2)]! ^= 0xff;
      await writeFile(objectPath, bytes);

      expect(await vault.verify(stored.sha256, key)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
