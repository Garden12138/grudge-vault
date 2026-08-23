import { app } from "electron";
import type { KeyProtectorPort } from "@grudge-vault/application";
import { bootstrap } from "../main/bootstrap";

class E2eKeyProtector implements KeyProtectorPort {
  async assertAvailable(): Promise<void> {}
  async protect(key: Buffer): Promise<string> {
    return `e2e:${key.toString("base64")}`;
  }
  async unprotect(envelope: string): Promise<{ key: Buffer }> {
    if (!envelope.startsWith("e2e:")) throw new Error("Invalid E2E key envelope.");
    return { key: Buffer.from(envelope.slice(4), "base64") };
  }
}

const workspacePath = process.env.GRUDGE_VAULT_E2E_WORKSPACE;
if (!workspacePath) throw new Error("GRUDGE_VAULT_E2E_WORKSPACE is required.");

app.enableSandbox();
void bootstrap({
  keyProtector: new E2eKeyProtector(),
  initialWorkspacePath: workspacePath,
  initialWorkspaceName: "Automated Vault"
});
