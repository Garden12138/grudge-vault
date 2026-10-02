import { describe, expect, it } from "vitest";
import type { LlmProviderConfig } from "@grudge-vault/domain";
import { matchesTestedModelConfiguration, type ModelConfigurationDraft } from "./model-configuration";

const saved: LlmProviderConfig = {
  provider: "bailian", model: "qwen3.8-omni-flash", region: "cn-beijing", workspaceId: "workspace-123",
  status: "ready", credentialConfigured: true
};
const draft: ModelConfigurationDraft = {
  provider: "bailian", model: saved.model, region: "cn-beijing", workspaceId: "workspace-123", apiKey: ""
};

describe("tested model configuration identity", () => {
  it("accepts the saved configuration and normalizes editable whitespace", () => {
    expect(matchesTestedModelConfiguration(saved, draft)).toBe(true);
    expect(matchesTestedModelConfiguration(saved, {
      ...draft, model: ` ${draft.model} `, workspaceId: ` ${draft.workspaceId} `, apiKey: " "
    })).toBe(true);
  });

  it.each([
    { model: "another-model" }, { provider: "minimax" as const }, { region: "ap-southeast-1" as const },
    { workspaceId: "workspace-456" }, { apiKey: "new-key" }
  ])("does not reuse capability verification for a changed draft: %j", (change) => {
    expect(matchesTestedModelConfiguration(saved, { ...draft, ...change })).toBe(false);
  });

  it("does not reuse missing, disconnected, or failed configuration verification", () => {
    expect(matchesTestedModelConfiguration(undefined, draft)).toBe(false);
    expect(matchesTestedModelConfiguration({ ...saved, credentialConfigured: false }, draft)).toBe(false);
    expect(matchesTestedModelConfiguration({ ...saved, status: "needs_attention" }, draft)).toBe(false);
    expect(matchesTestedModelConfiguration({ ...saved, status: "not_configured" }, draft)).toBe(false);
  });

  it("treats a blank workspace as absent and ignores Bailian-only fields for MiniMax", () => {
    const withoutWorkspace: LlmProviderConfig = {
      provider: "bailian", model: saved.model, region: "cn-beijing", status: "ready", credentialConfigured: true
    };
    expect(matchesTestedModelConfiguration(withoutWorkspace, { ...draft, workspaceId: " " })).toBe(true);
    expect(matchesTestedModelConfiguration({
      provider: "minimax", model: "MiniMax-M3", status: "ready", credentialConfigured: true
    }, { ...draft, provider: "minimax", model: "MiniMax-M3" })).toBe(true);
  });
});
