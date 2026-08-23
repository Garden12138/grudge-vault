import { safeStorage } from "electron";
import type { KeyProtectorPort } from "@grudge-vault/application";
import { AppError } from "@grudge-vault/shared";

export class SafeStorageKeyProtector implements KeyProtectorPort {
  async assertAvailable(): Promise<void> {
    if (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text") {
      throw new AppError(
        "INSECURE_KEY_BACKEND",
        "A Linux Secret Service or KWallet keyring is required before opening a workspace."
      );
    }
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
      throw new AppError("WORKSPACE_KEY_UNAVAILABLE", "The operating system key store is unavailable.", true);
    }
  }

  async protect(key: Buffer): Promise<string> {
    await this.assertAvailable();
    try {
      return (await safeStorage.encryptStringAsync(key.toString("base64"))).toString("base64");
    } catch (cause) {
      throw new AppError("WORKSPACE_KEY_UNAVAILABLE", "The workspace key could not be protected.", true, { cause });
    }
  }

  async unprotect(envelope: string): Promise<{ key: Buffer; refreshedEnvelope?: string }> {
    await this.assertAvailable();
    try {
      const decrypted = await safeStorage.decryptStringAsync(Buffer.from(envelope, "base64"));
      const key = Buffer.from(decrypted.result, "base64");
      if (key.length !== 32) throw new Error("Invalid workspace key length.");
      if (decrypted.shouldReEncrypt) {
        return { key, refreshedEnvelope: await this.protect(key) };
      }
      return { key };
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      throw new AppError("WORKSPACE_KEY_UNAVAILABLE", "The workspace key cannot be unlocked on this account.", false, { cause });
    }
  }
}
