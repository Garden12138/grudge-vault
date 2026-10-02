import type { BailianRegion, LlmProviderConfig } from "@grudge-vault/domain";

export interface ModelConfigurationDraft {
  provider: "bailian" | "minimax";
  model: string;
  region: BailianRegion;
  workspaceId: string;
  apiKey: string;
}

/** Capabilities belong to the tested configuration, not an unsaved candidate. */
export function matchesTestedModelConfiguration(
  saved: LlmProviderConfig | undefined,
  draft: ModelConfigurationDraft
): boolean {
  if (!saved || saved.status !== "ready" || !saved.credentialConfigured || draft.apiKey.trim()) return false;
  if (saved.provider !== draft.provider || saved.model !== draft.model.trim()) return false;
  return draft.provider !== "bailian" || (saved.region === draft.region &&
    (saved.workspaceId ?? "") === draft.workspaceId.trim());
}
