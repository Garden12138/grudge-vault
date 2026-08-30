import { describe, expect, it } from "vitest";
import { llmConnectSchema, llmListModelsSchema } from "./llm-ipc-validation";

describe("LLM IPC validation", () => {
  it("accepts only the three fixed providers and valid Bailian regions", () => {
    expect(llmConnectSchema.safeParse({
      provider: "nvidia", model: "openai/gpt-oss-20b", apiKey: "secret"
    }).success).toBe(true);
    expect(llmConnectSchema.safeParse({
      provider: "openrouter", model: "provider/model", apiKey: "secret"
    }).success).toBe(true);
    expect(llmConnectSchema.safeParse({
      provider: "bailian", region: "cn-beijing", model: "qwen3.7-plus", apiKey: "secret"
    }).success).toBe(true);

    expect(llmConnectSchema.safeParse({ provider: "custom", model: "model", apiKey: "secret" }).success).toBe(false);
    expect(llmConnectSchema.safeParse({ provider: "bailian", model: "model", apiKey: "secret" }).success).toBe(false);
    expect(llmConnectSchema.safeParse({
      provider: "nvidia", region: "cn-beijing", model: "model", apiKey: "secret"
    }).success).toBe(false);
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
  });
});
