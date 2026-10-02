import assert from "node:assert/strict";
import { test } from "node:test";
import { assertPackageRuntimeIdentity } from "./package-runtime-identity.mjs";

const preview = { name: "grudge-vault-redesign-preview", productName: "Grudge Vault 测试版" };
const cases = [
  ["preview preserves the previously installed runtime name", preview, true, "Grudge Vault 测试版"],
  ["production preserves its existing scoped runtime name", { name: "@grudge-vault/desktop" }, false, "@grudge-vault/desktop"],
  ["equivalent production productName does not move its profile", { name: "@grudge-vault/desktop", productName: "@grudge-vault/desktop" }, false, "@grudge-vault/desktop"],
  ["ordinary package metadata does not affect preview identity", { ...preview, version: "0.1.0", main: "out/main/index.js" }, true, "Grudge Vault 测试版"],
  ["the faulty preview containing development package metadata is rejected", { name: "@grudge-vault/desktop" }, true],
  ["an OS display name cannot replace runtime productName", { name: "grudge-vault-redesign-preview", CFBundleDisplayName: "Grudge Vault 测试版" }, true],
  ["missing preview productName cannot silently use a different profile", { name: "grudge-vault-redesign-preview" }, true],
  ["empty preview productName is rejected", { ...preview, productName: "" }, true],
  ["wrong preview package name is rejected even with the right display name", { ...preview, name: "other-preview" }, true],
  ["preview cannot use the production profile", { ...preview, productName: "Grudge Vault" }, true],
  ["production productName cannot silently rename its legacy profile", { name: "@grudge-vault/desktop", productName: "Grudge Vault" }, false],
  ["a renamed production package is rejected", { name: "grudge-vault" }, false],
  ["invalid production productName types are rejected", { name: "@grudge-vault/desktop", productName: 42 }, false],
  ["non-object metadata is rejected", null, true]
];

for (const [title, metadata, isPreview, expected] of cases) {
  test(title, () => {
    if (expected) assert.equal(assertPackageRuntimeIdentity(metadata, isPreview), expected);
    else assert.throws(() => assertPackageRuntimeIdentity(metadata, isPreview), /existing application profile/);
  });
}
