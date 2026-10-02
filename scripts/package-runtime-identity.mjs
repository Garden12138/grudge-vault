// Keep this function self-contained: the package verifier embeds it in an
// isolated Electron-as-Node probe that never starts the user's application.
export function assertPackageRuntimeIdentity(metadata, preview) {
  const expectedPackageName = preview ? "grudge-vault-redesign-preview" : "@grudge-vault/desktop";
  const expectedRuntimeName = preview ? "Grudge Vault 测试版" : "@grudge-vault/desktop";
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || metadata.name !== expectedPackageName) {
    throw new Error("Packaged runtime identity would change the existing application profile.");
  }
  if (metadata.productName !== undefined && typeof metadata.productName !== "string") {
    throw new Error("Packaged runtime identity would change the existing application profile.");
  }
  // Electron prefers package.json productName over name when choosing the
  // default app name and userData directory. Info.plist alone is insufficient.
  const runtimeName = typeof metadata.productName === "string" && metadata.productName.length > 0
    ? metadata.productName : metadata.name;
  if (runtimeName !== expectedRuntimeName) {
    throw new Error("Packaged runtime identity would change the existing application profile.");
  }
  return runtimeName;
}
