import { app } from "electron";
import type { KeyProtectorPort } from "@grudge-vault/application";
import type { AgentModelAdapterPort } from "@grudge-vault/agent-harness";
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

class E2eAgentModelAdapter implements AgentModelAdapterPort {
  readonly identity = "e2e.injected-chat-completions";
  readonly version = 1;

  async run(input: Parameters<AgentModelAdapterPort["run"]>[0]) {
    if (input.user.includes("E2E_ENHANCED_TOOL")) {
      await input.executeTool("search_events", { query: "attribution" }, "e2e-tool-call-1");
    }
    return { text: "Injected Enhanced answer with locally grounded citations.", model: input.model };
  }
}

const workspacePath = process.env.GRUDGE_VAULT_E2E_WORKSPACE;
if (!workspacePath) throw new Error("GRUDGE_VAULT_E2E_WORKSPACE is required.");

app.enableSandbox();
void bootstrap({
  keyProtector: new E2eKeyProtector(),
  agentModelAdapter: new E2eAgentModelAdapter(),
  initialWorkspacePath: workspacePath,
  initialWorkspaceName: "Automated Vault"
});
