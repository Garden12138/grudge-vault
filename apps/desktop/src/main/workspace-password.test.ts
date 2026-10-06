import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { LocalWorkspaceManager } from "./workspace-manager";

const password = "Synthetic账本密码 2026";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const clean of cleanup.splice(0)) await clean(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "grudge-vault-password-test-"));
  const protector = { async assertAvailable() {}, async protect(key: Buffer) { return key.toString("base64"); },
    unprotect: vi.fn(async (envelope: string) => ({ key: Buffer.from(envelope, "base64") })) };
  const state = join(root, "state.json"), workspace = join(root, "workspace");
  const manager = new LocalWorkspaceManager(protector, state);
  cleanup.push(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  await manager.create(workspace, "合成密码账本");
  return { root, workspace, state, protector, manager, config: async () => JSON.parse(await readFile(join(workspace, "workspace.json"), "utf8")) };
}

it("requires verification before opening keys or records, including selecting the same protected folder", async () => {
  const test = await fixture();
  await test.manager.setPassword({ newPassword: password });
  const config = await test.config();
  expect(JSON.stringify(config)).not.toContain(password);
  expect(config.password).toMatchObject({ version: 1, algorithm: "scrypt", salt: expect.any(String), verifier: expect.any(String) });
  const calls = test.protector.unprotect.mock.calls.length;
  await expect(test.manager.open(test.workspace)).rejects.toMatchObject({ code: "WORKSPACE_PASSWORD_REQUIRED" });
  expect(test.manager.current()).toBeUndefined();
  expect(test.manager.status()).toMatchObject({ status: "locked", passwordConfigured: true });
  await expect(test.manager.unlock({ password: "Synthetic wrong password" })).rejects.toMatchObject({ code: "WORKSPACE_PASSWORD_INCORRECT" });
  expect(test.protector.unprotect).toHaveBeenCalledTimes(calls);
  await expect(test.manager.unlock()).rejects.toMatchObject({ code: "WORKSPACE_PASSWORD_REQUIRED" });
  await test.manager.unlock({ password });
  expect(test.manager.current()).toBeDefined();
});

it("starts a protected recent workspace locked after a restart, and preserves its password through backups", async () => {
  const test = await fixture();
  await test.manager.setPassword({ newPassword: password });
  await test.manager.createBackup(join(test.root, "backup"));
  await test.manager.close();
  expect(await test.manager.openRecent()).toBeUndefined();
  expect(test.manager.status()).toMatchObject({ status: "locked", passwordConfigured: true });
  await test.manager.unlock({ password });
  await expect(test.manager.restoreBackup(join(test.root, "backup"), join(test.root, "restored"))).rejects.toMatchObject({ code: "WORKSPACE_PASSWORD_REQUIRED" });
  expect(test.manager.status()).toMatchObject({ status: "locked", passwordConfigured: true });
  await test.manager.unlock({ password });
  expect(test.manager.current()?.workspace.rootPath).toBe(await realpath(join(test.root, "restored")));
});

it("bootstraps an existing passwordless locked workspace without changing the vault key or records", async () => {
  const test = await fixture(), before = await test.config();
  await test.manager.lock();
  await test.manager.unlock({ newPassword: password });
  const after = await test.config();
  expect(after.crypto).toEqual(before.crypto); expect(after.id).toBe(before.id); expect(after.security).toEqual(before.security);
  await test.manager.lock();
  await expect(test.manager.unlock()).rejects.toMatchObject({ code: "WORKSPACE_PASSWORD_REQUIRED" });
  await test.manager.unlock({ password });
});

it("requires the old password to change it and rejects the old one afterwards", async () => {
  const test = await fixture(); await test.manager.setPassword({ newPassword: password });
  const before = await test.config();
  await expect(test.manager.setPassword({ currentPassword: "wrong password", newPassword: "Synthetic新密码" })).rejects.toMatchObject({ code: "WORKSPACE_PASSWORD_INCORRECT" });
  expect(await test.config()).toEqual(before);
  await test.manager.setPassword({ currentPassword: password, newPassword: "Synthetic新密码" });
  expect((await test.config()).password.salt).not.toBe(before.password.salt);
  await test.manager.lock();
  await expect(test.manager.unlock({ password })).rejects.toMatchObject({ code: "WORKSPACE_PASSWORD_INCORRECT" });
  await test.manager.unlock({ password: "Synthetic新密码" });
});

it("limits repeated incorrect attempts without unlocking or reading the key store", async () => {
  const test = await fixture(); await test.manager.setPassword({ newPassword: password }); await test.manager.lock();
  const calls = test.protector.unprotect.mock.calls.length;
  for (let attempt = 0; attempt < 5; attempt++) await expect(test.manager.unlock({ password: "wrong password" })).rejects.toMatchObject({ code: "WORKSPACE_PASSWORD_INCORRECT" });
  await expect(test.manager.unlock({ password })).rejects.toMatchObject({ code: "WORKSPACE_PASSWORD_THROTTLED" });
  expect(test.protector.unprotect).toHaveBeenCalledTimes(calls); expect(test.manager.current()).toBeUndefined();
});

it("does not allow a late correct password request to reopen a revoked session", async () => {
  const test = await fixture(); await test.manager.setPassword({ newPassword: password }); await test.manager.lock();
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  test.protector.unprotect.mockImplementationOnce(async envelope => { entered(); await held; return { key: Buffer.from(envelope, "base64") }; });
  const opening = test.manager.unlock({ password });
  const rejected = expect(opening).rejects.toMatchObject({ code: "WORKSPACE_LOCKED" });
  await reached; await test.manager.lock(); release(); await rejected;
  expect(test.manager.current()).toBeUndefined();
});

it("clears a forgotten password only after authenticating the independent recovery package", async () => {
  const test = await fixture(); await test.manager.setPassword({ newPassword: password });
  const recovery = join(test.root, "synthetic.gvrecovery");
  await test.manager.exportRecovery(recovery, "synthetic separate recovery phrase"); await test.manager.lock();
  await expect(test.manager.recover(recovery, "wrong recovery phrase")).rejects.toMatchObject({ code: "RECOVERY_PACKAGE_INVALID" });
  expect(test.manager.passwordStatus().configured).toBe(true);
  await test.manager.recover(recovery, "synthetic separate recovery phrase");
  expect(test.manager.passwordStatus().configured).toBe(false); expect(test.manager.current()).toBeDefined();
});
