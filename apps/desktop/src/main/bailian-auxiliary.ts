import type { LlmSettings } from "@grudge-vault/domain";
import type { BailianEmbeddingCredentials } from "@grudge-vault/agent-harness";

export function configuredBailianAuxiliary(
  settings: LlmSettings, credential: () => string | undefined, requiredModel?: string
): BailianEmbeddingCredentials | undefined {
  if (settings.activeProvider !== "bailian" && settings.activeProvider !== "minimax") return undefined;
  const config = settings.providers.bailian;
  if (!config || config.status !== "ready" || !config.credentialConfigured || !config.region ||
    requiredModel && config.model !== requiredModel) return undefined;
  const apiKey = credential();
  if (!apiKey?.trim()) return undefined;
  return {
    apiKey, region: config.region,
    ...(config.workspaceId ? { workspaceId: config.workspaceId } : {})
  };
}
