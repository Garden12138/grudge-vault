import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { AppError } from "@grudge-vault/shared";

export const workspacePasswordSchema = z.object({
  version: z.literal(1), algorithm: z.literal("scrypt"),
  salt: z.string().regex(/^[a-f0-9]{32}$/), verifier: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
export type WorkspacePassword = z.infer<typeof workspacePasswordSchema>;

function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, Buffer.from(salt, "hex"), 32,
    { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
    (error, key) => error ? reject(error) : resolve(key)));
}

export async function createWorkspacePassword(password: string): Promise<WorkspacePassword> {
  if (Array.from(password).length < 8 || password.length > 128) {
    throw new AppError("VALIDATION_FAILED", "请使用至少 8 位、最多 128 位的账本密码。");
  }
  const salt = randomBytes(16).toString("hex"), key = await derive(password, salt);
  try { return { version: 1, algorithm: "scrypt", salt, verifier: key.toString("hex") }; }
  finally { key.fill(0); }
}

export async function verifyWorkspacePassword(stored: WorkspacePassword, password?: string): Promise<boolean> {
  if (!password || password.length > 128) return false;
  const key = await derive(password, stored.salt), expected = Buffer.from(stored.verifier, "hex");
  try { return timingSafeEqual(key, expected); }
  finally { key.fill(0); expected.fill(0); }
}
