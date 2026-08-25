import { app } from "electron";
import { createHash } from "node:crypto";
import type { KeyProtectorPort, MediaPipelinePort } from "@grudge-vault/application";
import type { Asset, MediaProcessingSettings } from "@grudge-vault/domain";
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
    if (input.user.includes("attribution")) {
      await input.executeTool("search_events", { query: "attribution" }, "e2e-tool-call-1");
    }
    return { text: "Injected Enhanced answer with locally grounded citations.", model: input.model };
  }
}

class E2eMediaPipeline implements MediaPipelinePort {
  private settings: MediaProcessingSettings = {
    autoProcessNew: true, ocrLanguages: ["eng"], resourceProfile: "balanced", whisperGpu: "auto"
  };
  private readonly configHash = createHash("sha256").update("e2e-media-config-v1").digest("hex");

  getSettings() { return this.settings; }
  async updateSettings(settings: MediaProcessingSettings) { this.settings = settings; return this.getStatus(); }
  async getStatus() {
    return {
      settings: this.settings,
      ocr: { configured: true, available: true, identity: "e2e.ocr", version: "1", displayNames: ["injected-e2e-ocr"], warnings: [] },
      asr: { configured: true, available: true, identity: "e2e.asr", version: "1", displayNames: ["injected-e2e-asr"], warnings: [] },
      eligibleHistoricalAssets: 0, pendingJobs: 0
    };
  }
  probe() { return this.getStatus(); }
  kindFor(asset: Asset) { return asset.mimeType === "image/png" ? "ocr" as const : undefined; }
  async fingerprint(asset: Asset) {
    return { kind: "ocr" as const, processorIdentity: "e2e.ocr", processorVersion: 1, configHash: this.configHash,
      inputHash: createHash("sha256").update(`${asset.sha256}:${this.configHash}`).digest("hex") };
  }
  async process(input: Parameters<MediaPipelinePort["process"]>[0]) {
    const fingerprint = await this.fingerprint(input.asset);
    input.reportProgress(1);
    return { ...fingerprint, payload: {
      formatVersion: 1 as const, kind: "ocr" as const, sourceAssetId: input.asset.id, sourceSha256: input.asset.sha256,
      language: "eng", processorIdentity: "e2e.ocr", processorVersion: 1, engineVersions: { injected: "1" },
      configHash: this.configHash, text: "E2E OCR attribution evidence from a local image.",
      pages: [{ page: 1, text: "E2E OCR attribution evidence from a local image.", words: [] }],
      createdAt: new Date().toISOString()
    } };
  }
}

const workspacePath = process.env.GRUDGE_VAULT_E2E_WORKSPACE;
if (!workspacePath) throw new Error("GRUDGE_VAULT_E2E_WORKSPACE is required.");

app.enableSandbox();
void bootstrap({
  keyProtector: new E2eKeyProtector(),
  agentModelAdapter: new E2eAgentModelAdapter(),
  mediaPipeline: new E2eMediaPipeline(),
  initialWorkspacePath: workspacePath,
  initialWorkspaceName: "Automated Vault",
  continuousScheduler: process.env.GRUDGE_VAULT_E2E_DISABLE_SCHEDULER !== "1"
});
