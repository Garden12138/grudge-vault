import { describe, expect, it } from "vitest";
import type { LlmSettings } from "@grudge-vault/domain";
import { llmConnectSchema, llmListModelsSchema, llmProviderSchema, redesignLlmSettings } from "./llm-ipc-validation";

describe("LLM IPC validation", () => {
  it("accepts only the two redesigned providers and valid Bailian regions", () => {
    expect(llmConnectSchema.safeParse({
      provider: "bailian", region: "cn-beijing", workspaceId: "workspace-123",
      model: "qwen3.7-plus", apiKey: "secret"
    }).success).toBe(true);
    expect(llmConnectSchema.safeParse({
      provider: "minimax", model: "MiniMax-M3", apiKey: "secret"
    }).success).toBe(true);

    expect(llmConnectSchema.safeParse({ provider: "custom", model: "model", apiKey: "secret" }).success).toBe(false);
    for (const provider of ["nvidia", "openrouter"]) {
      expect(llmProviderSchema.safeParse(provider).success).toBe(false);
      expect(llmConnectSchema.safeParse({ provider, model: "model", apiKey: "secret" }).success).toBe(false);
      expect(llmListModelsSchema.safeParse({ provider, apiKey: "secret" }).success).toBe(false);
    }
    expect(llmConnectSchema.safeParse({ provider: "bailian", model: "model", apiKey: "secret" }).success).toBe(false);
    expect(llmConnectSchema.safeParse({
      provider: "nvidia", region: "cn-beijing", model: "model", apiKey: "secret"
    }).success).toBe(false);
    expect(llmConnectSchema.safeParse({
      provider: "nvidia", workspaceId: "workspace-123", model: "model", apiKey: "secret"
    }).success).toBe(false);
  });

  it("hides a legacy active provider without deleting its stored configuration", () => {
    const stored: LlmSettings = {
      activeProvider: "nvidia",
      providers: {
        nvidia: { provider: "nvidia", model: "legacy-model", credentialConfigured: true, status: "ready" },
        bailian: { provider: "bailian", model: "qwen3.7-plus", region: "cn-beijing", credentialConfigured: true, status: "ready" }
      }
    };
    expect(redesignLlmSettings(stored)).toEqual({ providers: { bailian: stored.providers.bailian } });
    expect(stored.activeProvider).toBe("nvidia");
    expect(stored.providers.nvidia?.model).toBe("legacy-model");
    expect(redesignLlmSettings({ ...stored, activeProvider: "bailian" })).toEqual({
      activeProvider: "bailian", providers: { bailian: stored.providers.bailian }
    });
    expect(redesignLlmSettings({
      ...stored, activeProvider: "bailian", providers: {
        ...stored.providers, bailian: { ...stored.providers.bailian!, status: "needs_attention" }
      }
    }).activeProvider).toBeUndefined();
  });

  it("rejects custom addresses, invalid regions, and oversized model names", () => {
    expect(llmConnectSchema.safeParse({
      provider: "openrouter", model: "model", apiKey: "secret", baseUrl: "https://example.com/v1"
    }).success).toBe(false);
    expect(llmListModelsSchema.safeParse({
      provider: "bailian", region: "eu-west-1", apiKey: "secret"
    }).success).toBe(false);
    expect(llmConnectSchema.safeParse({
      provider: "nvidia", model: "m".repeat(201), apiKey: "secret"
    }).success).toBe(false);
    expect(llmListModelsSchema.safeParse({
      provider: "bailian", region: "cn-beijing", workspaceId: "workspace_unsafe", apiKey: "secret"
    }).success).toBe(false);
  });

  it("accepts an explicit offline recommendation flag without relaxing provider or region validation", () => {
    expect(llmListModelsSchema.parse({
      provider: "bailian", region: "cn-beijing", recommendationsOnly: true
    }).recommendationsOnly).toBe(true);
    expect(llmListModelsSchema.parse({ provider: "minimax", recommendationsOnly: false }).recommendationsOnly).toBe(false);
    expect(llmListModelsSchema.safeParse({ provider: "minimax", recommendationsOnly: "true" }).success).toBe(false);
    expect(llmListModelsSchema.safeParse({ provider: "bailian", recommendationsOnly: true }).success).toBe(false);
    expect(llmListModelsSchema.safeParse({ provider: "nvidia", recommendationsOnly: true }).success).toBe(false);
    expect(llmConnectSchema.safeParse({ provider: "minimax", model: "MiniMax-M3", recommendationsOnly: true }).success).toBe(false);
  });
});
