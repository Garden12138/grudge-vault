import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, chmod, mkdir, open as openFile, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ObjectVaultPort, StoredObject } from "@grudge-vault/application";

const MAGIC = Buffer.from("GVOB", "ascii");
const FORMAT_VERSION = 1;
const ALGORITHM_AES_256_GCM = 1;
const NONCE_SIZE = 12;
const TAG_SIZE = 16;
const HEADER_SIZE = MAGIC.length + 2 + NONCE_SIZE;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function assertKey(key: Buffer): void {
  if (key.length !== 32) throw new Error("Workspace key must be 256 bits.");
}

export class EncryptedObjectVault implements ObjectVaultPort {
  private readonly objectsRoot: string;
  private readonly tempRoot: string;

  constructor(private readonly vaultRoot: string) {
    this.objectsRoot = join(vaultRoot, "objects", "sha256");
    this.tempRoot = join(vaultRoot, "tmp");
  }

  async initialize(): Promise<void> {
    await mkdir(this.objectsRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.tempRoot, { recursive: true, mode: 0o700 });
    await this.cleanupTempFiles();
  }

  async put(inputPath: string, key: Buffer): Promise<StoredObject> {
    assertKey(key);
    await this.initialize();
    const nonce = randomBytes(NONCE_SIZE);
    const header = Buffer.concat([
      MAGIC,
      Buffer.from([FORMAT_VERSION, ALGORITHM_AES_256_GCM]),
      nonce
    ]);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const hash = createHash("sha256");
    let byteSize = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        byteSize += chunk.length;
        callback(null, chunk);
      }
    });
    const tempPath = join(this.tempRoot, `${randomUUID()}.partial`);
    const handle = await openFile(tempPath, "wx", 0o600);

    try {
      await handle.write(header, 0, header.length, 0);
      const encryptedOutput = createWriteStream(tempPath, {
        fd: handle.fd,
        autoClose: false,
        start: HEADER_SIZE
      });
      await pipeline(createReadStream(inputPath), meter, cipher, encryptedOutput);
      const tag = cipher.getAuthTag();
      await handle.write(tag, 0, tag.length, HEADER_SIZE + byteSize);
      await handle.sync();
      await handle.close();

      const sha256 = hash.digest("hex");
      const destination = this.objectPath(sha256);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });

      if (await this.exists(destination)) {
        const valid = await this.verify(sha256, key);
        await rm(tempPath, { force: true });
        if (!valid) throw new Error("An existing vault object failed integrity verification.");
        return { sha256, byteSize, vaultFormat: FORMAT_VERSION, deduplicated: true };
      }

      try {
        await rename(tempPath, destination);
      } catch (error) {
        if (!(await this.exists(destination))) throw error;
        await rm(tempPath, { force: true });
        if (!(await this.verify(sha256, key))) {
          throw new Error("A concurrently created vault object failed integrity verification.");
        }
        return { sha256, byteSize, vaultFormat: FORMAT_VERSION, deduplicated: true };
      }
      await chmod(destination, 0o600).catch(() => undefined);
      return { sha256, byteSize, vaultFormat: FORMAT_VERSION, deduplicated: false };
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async open(sha256: string, key: Buffer): Promise<Readable> {
    assertKey(key);
    const objectPath = this.objectPath(sha256);
    const handle = await openFile(objectPath, "r");
    try {
      const objectStat = await handle.stat();
      if (objectStat.size < HEADER_SIZE + TAG_SIZE) throw new Error("Vault object is truncated.");
      const header = Buffer.alloc(HEADER_SIZE);
      const tag = Buffer.alloc(TAG_SIZE);
      await handle.read(header, 0, header.length, 0);
      await handle.read(tag, 0, tag.length, objectStat.size - TAG_SIZE);
      if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Vault object magic is invalid.");
      if (header[MAGIC.length] !== FORMAT_VERSION) throw new Error("Vault object version is unsupported.");
      if (header[MAGIC.length + 1] !== ALGORITHM_AES_256_GCM) throw new Error("Vault algorithm is unsupported.");

      const nonce = header.subarray(MAGIC.length + 2, HEADER_SIZE);
      const decipher = createDecipheriv("aes-256-gcm", key, nonce);
      decipher.setAuthTag(tag);
      const encrypted = createReadStream(objectPath, {
        start: HEADER_SIZE,
        end: objectStat.size - TAG_SIZE - 1
      });
      encrypted.on("error", (error) => decipher.destroy(error));
      encrypted.pipe(decipher);
      return decipher;
    } finally {
      await handle.close();
    }
  }

  async verify(sha256: string, key: Buffer, onProgress?: (progress: number) => void): Promise<boolean> {
    try {
      const objectStat = await stat(this.objectPath(sha256));
      const plaintextSize = Math.max(0, objectStat.size - HEADER_SIZE - TAG_SIZE);
      const plaintext = await this.open(sha256, key);
      const hash = createHash("sha256");
      let read = 0;
      for await (const chunk of plaintext) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        hash.update(buffer);
        read += buffer.length;
        onProgress?.(plaintextSize === 0 ? 1 : read / plaintextSize);
      }
      onProgress?.(1);
      return hash.digest("hex") === sha256;
    } catch {
      return false;
    }
  }

  async cleanupTempFiles(): Promise<void> {
    await mkdir(this.tempRoot, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.tempRoot, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".partial"))
        .map((entry) => rm(join(this.tempRoot, entry.name), { force: true }))
    );
  }

  objectPath(sha256: string): string {
    if (!SHA256_PATTERN.test(sha256)) throw new Error("Invalid SHA-256 identifier.");
    return join(this.objectsRoot, sha256.slice(0, 2), sha256.slice(2, 4), `${sha256}.gvobj`);
  }

  private async exists(path: string): Promise<boolean> {
    return access(path).then(() => true, () => false);
  }
}
