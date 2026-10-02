import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, chmod, lstat, mkdir, open as openFile, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ObjectVaultPort, StoredObject, VaultKey, WorkspaceKeyRing } from "@grudge-vault/application";

const MAGIC = Buffer.from("GVOB", "ascii");
const FORMAT_V1 = 1;
const FORMAT_V2 = 2;
const ALGORITHM_AES_256_GCM = 1;
const NONCE_SIZE = 12;
const TAG_SIZE = 16;
const V1_HEADER_SIZE = MAGIC.length + 2 + NONCE_SIZE;
const KEY_ID_SIZE = 16;
const KEY_SIZE = 32;
const V2_HEADER_SIZE = MAGIC.length + 2 + KEY_ID_SIZE + NONCE_SIZE + KEY_SIZE + TAG_SIZE + NONCE_SIZE;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function isKeyRing(value: VaultKey): value is WorkspaceKeyRing {
  return !Buffer.isBuffer(value);
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_SIZE) throw new Error("Workspace key must be 256 bits.");
}

function idToBytes(id: string): Buffer {
  const hex = id.replaceAll("-", "");
  if (!/^[a-f0-9]{32}$/i.test(hex)) throw new Error("Vault key IDs must be UUIDs.");
  return Buffer.from(hex, "hex");
}

function bytesToId(value: Buffer): string {
  const hex = value.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function activeKey(input: VaultKey, targetKeyId?: string): { key: Buffer; keyId?: string } {
  if (!isKeyRing(input)) {
    assertKey(input);
    return { key: input };
  }
  const keyId = targetKeyId ?? input.activeKeyId;
  const key = input.keys.get(keyId);
  if (!key) throw new Error(`Workspace key ${keyId} is unavailable.`);
  assertKey(key);
  return { key, keyId };
}

interface TemporaryObject {
  path: string;
  sha256: string;
  byteSize: number;
  vaultFormat: number;
}

export class EncryptedObjectVault implements ObjectVaultPort {
  private readonly objectsRoot: string;
  private readonly tempRoot: string;
  private initialization: Promise<void> | undefined;

  constructor(private readonly vaultRoot: string) {
    this.objectsRoot = join(vaultRoot, "objects", "sha256");
    this.tempRoot = join(vaultRoot, "tmp");
  }

  initialize(): Promise<void> {
    this.initialization ??= (async () => {
      await mkdir(this.objectsRoot, { recursive: true, mode: 0o700 });
      await mkdir(this.tempRoot, { recursive: true, mode: 0o700 });
      for (const path of [this.vaultRoot, join(this.vaultRoot, "objects"), this.objectsRoot, this.tempRoot]) {
        const metadata = await lstat(path);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Vault directory contains an unsafe link.");
      }
      await this.cleanupTempFiles();
    })().catch((error: unknown) => {
      this.initialization = undefined;
      throw error;
    });
    return this.initialization;
  }

  async put(inputPath: string, key: VaultKey): Promise<StoredObject> {
    return this.putStream(createReadStream(inputPath), key, (await stat(inputPath)).size);
  }

  async putStream(input: Readable, key: VaultKey, expectedByteSize?: number, onProgress?: (progress: number) => void): Promise<StoredObject> {
    await this.initialize();
    const temporary = await this.writeTemporary(input, key, expectedByteSize, onProgress);
    const destination = this.objectPath(temporary.sha256);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    if (await this.exists(temporary.sha256)) {
      const valid = await this.verify(temporary.sha256, key);
      await rm(temporary.path, { force: true });
      if (!valid) throw new Error("An existing vault object failed integrity verification.");
      return { sha256: temporary.sha256, byteSize: temporary.byteSize,
        vaultFormat: await this.formatVersion(temporary.sha256), deduplicated: true };
    }
    try {
      await rename(temporary.path, destination);
    } catch (error) {
      if (!(await this.exists(temporary.sha256))) throw error;
      await rm(temporary.path, { force: true });
      if (!(await this.verify(temporary.sha256, key))) throw new Error("A concurrently created vault object failed integrity verification.");
      return { sha256: temporary.sha256, byteSize: temporary.byteSize,
        vaultFormat: await this.formatVersion(temporary.sha256), deduplicated: true };
    }
    await chmod(destination, 0o600).catch(() => undefined);
    onProgress?.(1);
    return { sha256: temporary.sha256, byteSize: temporary.byteSize, vaultFormat: temporary.vaultFormat, deduplicated: false };
  }

  async open(sha256: string, key: VaultKey): Promise<Readable> {
    return this.openPath(this.objectPath(sha256), key);
  }

  private async openPath(objectPath: string, key: VaultKey): Promise<Readable> {
    const handle = await openFile(objectPath, "r");
    try {
      const objectStat = await handle.stat();
      const prefix = Buffer.alloc(6);
      await handle.read(prefix, 0, prefix.length, 0);
      if (!prefix.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Vault object magic is invalid.");
      if (prefix[5] !== ALGORITHM_AES_256_GCM) throw new Error("Vault algorithm is unsupported.");
      const version = prefix[4];
      if (version === FORMAT_V1) {
        if (objectStat.size < V1_HEADER_SIZE + TAG_SIZE) throw new Error("Vault object is truncated.");
        const header = Buffer.alloc(V1_HEADER_SIZE);
        const tag = Buffer.alloc(TAG_SIZE);
        await handle.read(header, 0, header.length, 0);
        await handle.read(tag, 0, tag.length, objectStat.size - TAG_SIZE);
        const selected = isKeyRing(key) ? key.keys.get(key.legacyKeyId) : key;
        if (!selected) throw new Error("The legacy workspace key is unavailable.");
        const decipher = createDecipheriv("aes-256-gcm", selected, header.subarray(6, V1_HEADER_SIZE));
        decipher.setAuthTag(tag);
        const encrypted = objectStat.size === V1_HEADER_SIZE + TAG_SIZE
          ? Readable.from([])
          : createReadStream(objectPath, { start: V1_HEADER_SIZE, end: objectStat.size - TAG_SIZE - 1 });
        encrypted.on("error", (error: Error) => decipher.destroy(error));
        // pipe() propagates source errors, not consumer cancellation. Releasing
        // the plaintext stream must also close the encrypted file descriptor.
        decipher.once("close", () => encrypted.destroy());
        encrypted.pipe(decipher);
        return decipher;
      }
      if (version !== FORMAT_V2 || objectStat.size < V2_HEADER_SIZE + TAG_SIZE || !isKeyRing(key)) {
        throw new Error("Vault object version is unsupported.");
      }
      const header = Buffer.alloc(V2_HEADER_SIZE);
      const contentTag = Buffer.alloc(TAG_SIZE);
      await handle.read(header, 0, header.length, 0);
      await handle.read(contentTag, 0, contentTag.length, objectStat.size - TAG_SIZE);
      let offset = 6;
      const keyIdBytes = header.subarray(offset, offset += KEY_ID_SIZE);
      const keyId = bytesToId(keyIdBytes);
      const wrappingKey = key.keys.get(keyId);
      if (!wrappingKey) throw new Error(`Workspace key ${keyId} is unavailable.`);
      const wrapNonce = header.subarray(offset, offset += NONCE_SIZE);
      const wrappedKey = header.subarray(offset, offset += KEY_SIZE);
      const wrapTag = header.subarray(offset, offset += TAG_SIZE);
      const contentNonce = header.subarray(offset, offset + NONCE_SIZE);
      const unwrap = createDecipheriv("aes-256-gcm", wrappingKey, wrapNonce);
      unwrap.setAAD(Buffer.concat([MAGIC, Buffer.from([FORMAT_V2, ALGORITHM_AES_256_GCM]), keyIdBytes, Buffer.alloc(32)]));
      unwrap.setAuthTag(wrapTag);
      const dataKey = Buffer.concat([unwrap.update(wrappedKey), unwrap.final()]);
      const decipher = createDecipheriv("aes-256-gcm", dataKey, contentNonce);
      dataKey.fill(0);
      decipher.setAuthTag(contentTag);
      const encrypted = objectStat.size === V2_HEADER_SIZE + TAG_SIZE
        ? Readable.from([])
        : createReadStream(objectPath, { start: V2_HEADER_SIZE, end: objectStat.size - TAG_SIZE - 1 });
      encrypted.on("error", (error: Error) => decipher.destroy(error));
      decipher.once("close", () => encrypted.destroy());
      encrypted.pipe(decipher);
      return decipher;
    } finally {
      await handle.close();
    }
  }

  async verify(sha256: string, key: VaultKey, onProgress?: (progress: number) => void, expectedByteSize?: number): Promise<boolean> {
    try {
      const objectStat = await stat(this.objectPath(sha256));
      const version = await this.formatVersion(sha256);
      const headerSize = version === FORMAT_V1 ? V1_HEADER_SIZE : V2_HEADER_SIZE;
      const plaintextSize = Math.max(0, objectStat.size - headerSize - TAG_SIZE);
      const plaintext = await this.open(sha256, key);
      const hash = createHash("sha256");
      let read = 0;
      for await (const chunk of plaintext) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        hash.update(buffer); read += buffer.length;
        onProgress?.(plaintextSize === 0 ? 1 : read / plaintextSize);
      }
      onProgress?.(1);
      return hash.digest("hex") === sha256 && (expectedByteSize === undefined || read === expectedByteSize);
    } catch {
      return false;
    }
  }

  async migrate(sha256: string, key: WorkspaceKeyRing, targetKeyId: string, onProgress?: (progress: number) => void): Promise<void> {
    if (await this.keyId(sha256, key) === targetKeyId && await this.formatVersion(sha256) === FORMAT_V2) return;
    const objectStat = await stat(this.objectPath(sha256));
    const version = await this.formatVersion(sha256);
    const plaintextSize = objectStat.size - (version === FORMAT_V1 ? V1_HEADER_SIZE : V2_HEADER_SIZE) - TAG_SIZE;
    const temporary = await this.writeTemporary(await this.open(sha256, key), key, plaintextSize, onProgress, targetKeyId);
    if (temporary.sha256 !== sha256 || !(await this.verifyTemporary(temporary.path, sha256, key))) {
      await rm(temporary.path, { force: true });
      throw new Error("Migrated vault object failed plaintext verification.");
    }
    await rename(temporary.path, this.objectPath(sha256));
    await chmod(this.objectPath(sha256), 0o600).catch(() => undefined);
  }

  async keyId(sha256: string, key: WorkspaceKeyRing): Promise<string> {
    const handle = await openFile(this.objectPath(sha256), "r");
    try {
      const prefix = Buffer.alloc(6 + KEY_ID_SIZE);
      await handle.read(prefix, 0, prefix.length, 0);
      return prefix[4] === FORMAT_V1 ? key.legacyKeyId : bytesToId(prefix.subarray(6, 6 + KEY_ID_SIZE));
    } finally { await handle.close(); }
  }

  async cleanupTempFiles(): Promise<void> {
    await mkdir(this.tempRoot, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.tempRoot, { withFileTypes: true });
    const partials = entries.filter((entry) => entry.name.endsWith(".partial"));
    if (partials.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
      throw new Error("Vault temporary directory contains an unsafe partial object.");
    }
    await Promise.all(partials.map((entry) => rm(join(this.tempRoot, entry.name), { force: true })));
  }

  async pruneUnreferencedObjects(referencedHashes: ReadonlySet<string>): Promise<number> {
    await this.initialize();
    let removed = 0;
    const firstBuckets = await readdir(this.objectsRoot, { withFileTypes: true });
    for (const first of firstBuckets) {
      if (first.isSymbolicLink()) throw new Error("Vault object tree contains an unsafe link.");
      if (!first.isDirectory() || !/^[a-f0-9]{2}$/.test(first.name)) continue;
      const firstPath = join(this.objectsRoot, first.name);
      const firstMetadata = await lstat(firstPath);
      if (!firstMetadata.isDirectory() || firstMetadata.isSymbolicLink()) throw new Error("Vault object tree changed during recovery scan.");
      for (const second of await readdir(firstPath, { withFileTypes: true })) {
        if (second.isSymbolicLink()) throw new Error("Vault object tree contains an unsafe link.");
        if (!second.isDirectory() || !/^[a-f0-9]{2}$/.test(second.name)) continue;
        const secondPath = join(firstPath, second.name);
        const secondMetadata = await lstat(secondPath);
        if (!secondMetadata.isDirectory() || secondMetadata.isSymbolicLink()) throw new Error("Vault object tree changed during recovery scan.");
        for (const entry of await readdir(secondPath, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) throw new Error("Vault object tree contains an unsafe link.");
          if (!entry.isFile() || !/^[a-f0-9]{64}\.gvobj$/.test(entry.name)) continue;
          const sha256 = entry.name.slice(0, 64);
          if (sha256.slice(0, 2) !== first.name || sha256.slice(2, 4) !== second.name || referencedHashes.has(sha256)) continue;
          const path = join(secondPath, entry.name);
          const metadata = await lstat(path);
          if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Vault object changed during recovery scan.");
          await rm(path);
          removed += 1;
        }
      }
    }
    return removed;
  }

  objectPath(sha256: string): string {
    if (!SHA256_PATTERN.test(sha256)) throw new Error("Invalid SHA-256 identifier.");
    return join(this.objectsRoot, sha256.slice(0, 2), sha256.slice(2, 4), `${sha256}.gvobj`);
  }

  async exists(sha256: string): Promise<boolean> {
    return access(this.objectPath(sha256)).then(() => true, () => false);
  }

  async remove(sha256: string): Promise<void> { await rm(this.objectPath(sha256), { force: true }); }

  private async formatVersion(sha256: string): Promise<number> {
    const handle = await openFile(this.objectPath(sha256), "r");
    try {
      const prefix = Buffer.alloc(5); await handle.read(prefix, 0, prefix.length, 0);
      return prefix[4] ?? 0;
    } finally { await handle.close(); }
  }

  private async writeTemporary(
    input: Readable,
    key: VaultKey,
    expectedByteSize?: number,
    onProgress?: (progress: number) => void,
    targetKeyId?: string
  ): Promise<TemporaryObject> {
    const selected = activeKey(key, targetKeyId);
    const version = isKeyRing(key) ? FORMAT_V2 : FORMAT_V1;
    const contentNonce = randomBytes(NONCE_SIZE);
    const dataKey = version === FORMAT_V2 ? randomBytes(KEY_SIZE) : selected.key;
    let header: Buffer;
    if (version === FORMAT_V1) {
      header = Buffer.concat([MAGIC, Buffer.from([FORMAT_V1, ALGORITHM_AES_256_GCM]), contentNonce]);
    } else {
      const keyIdBytes = idToBytes(selected.keyId!);
      const wrapNonce = randomBytes(NONCE_SIZE);
      const wrap = createCipheriv("aes-256-gcm", selected.key, wrapNonce);
      const hashPlaceholder = Buffer.alloc(32);
      // The actual plaintext hash is not known until streaming completes, so the v2 key envelope binds format and key identity.
      wrap.setAAD(Buffer.concat([MAGIC, Buffer.from([FORMAT_V2, ALGORITHM_AES_256_GCM]), keyIdBytes, hashPlaceholder]));
      const wrappedKey = Buffer.concat([wrap.update(dataKey), wrap.final()]);
      header = Buffer.concat([MAGIC, Buffer.from([FORMAT_V2, ALGORITHM_AES_256_GCM]), keyIdBytes,
        wrapNonce, wrappedKey, wrap.getAuthTag(), contentNonce]);
    }
    const cipher = createCipheriv("aes-256-gcm", dataKey, contentNonce);
    const hash = createHash("sha256");
    let byteSize = 0;
    const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk); byteSize += chunk.length;
      onProgress?.(expectedByteSize === undefined || expectedByteSize === 0 ? 0 : Math.min(1, byteSize / expectedByteSize));
      callback(null, chunk);
    } });
    const tempPath = join(this.tempRoot, `${randomUUID()}.partial`);
    const handle = await openFile(tempPath, "wx", 0o600);
    try {
      await handle.write(header, 0, header.length, 0);
      await pipeline(input, meter, cipher, createWriteStream(tempPath, { fd: handle.fd, autoClose: false, start: header.length }));
      await handle.write(cipher.getAuthTag(), 0, TAG_SIZE, header.length + byteSize);
      await handle.sync(); await handle.close();
      if (version === FORMAT_V2) dataKey.fill(0);
      return { path: tempPath, sha256: hash.digest("hex"), byteSize, vaultFormat: version };
    } catch (error) {
      if (version === FORMAT_V2) dataKey.fill(0);
      await handle.close().catch(() => undefined); await rm(tempPath, { force: true }).catch(() => undefined); throw error;
    }
  }

  private async verifyTemporary(path: string, sha256: string, key: WorkspaceKeyRing): Promise<boolean> {
    try {
      const plaintext = await this.openPath(path, key);
      const hash = createHash("sha256");
      for await (const chunk of plaintext) hash.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return hash.digest("hex") === sha256;
    } catch {
      return false;
    }
  }
}
