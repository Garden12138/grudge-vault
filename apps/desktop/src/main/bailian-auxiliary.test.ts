import { describe, expect, it, vi } from "vitest";
import type { LlmSettings } from "@grudge-vault/domain";
import { configuredBailianAuxiliary } from "./bailian-auxiliary";

describe("Bailian auxiliary capability routing", () => {
  const ready: LlmSettings = {
    activeProvider: "bailian",
    providers: {
      bailian: {
        provider: "bailian", model: "qwen3.8-omni-flash", region: "ap-southeast-1",
        workspaceId: "synthetic-workspace", credentialConfigured: true, status: "ready"
      },
      minimax: {
        provider: "minimax", model: "MiniMax-M3", credentialConfigured: true, status: "ready"
      }
    }
  };

  it("keeps verified Bailian media and search available with MiniMax as the main model", () => {
    const key = vi.fn(() => "synthetic-key");
    const minimax = { ...ready, activeProvider: "minimax" as const };
    const expected = {
      apiKey: "synthetic-key", region: "ap-southeast-1", workspaceId: "synthetic-workspace"
    };
    expect(configuredBailianAuxiliary(minimax, key)).toEqual(expected);
    expect(configuredBailianAuxiliary(minimax, key, "qwen3.8-omni-flash")).toEqual(expected);
    expect(key).toHaveBeenCalledTimes(2);
  });

  it("does not use auxiliary credentials while paused or under a hidden legacy main provider", () => {
    const key = vi.fn(() => "synthetic-key");
    expect(configuredBailianAuxiliary({ providers: ready.providers }, key)).toBeUndefined();
    expect(configuredBailianAuxiliary({ ...ready, activeProvider: "nvidia" }, key)).toBeUndefined();
    expect(key).not.toHaveBeenCalled();
  });

  it("requires a ready, region-bound credential and the explicitly selected Omni model for those tasks", () => {
    const key = vi.fn(() => "synthetic-key");
    expect(configuredBailianAuxiliary({ ...ready, providers: {
      ...ready.providers, bailian: { ...ready.providers.bailian!, status: "needs_attention" }
    } }, key)).toBeUndefined();
    expect(configuredBailianAuxiliary({ ...ready, providers: {
      ...ready.providers, bailian: {
        provider: "bailian", model: "qwen3.8-omni-flash", credentialConfigured: true, status: "ready"
      }
    } }, key)).toBeUndefined();
    expect(configuredBailianAuxiliary({ ...ready, providers: {
      ...ready.providers, bailian: { ...ready.providers.bailian!, model: "qwen3.7-plus" }
    } }, key, "qwen3.8-omni-flash")).toBeUndefined();
    expect(key).not.toHaveBeenCalled();
    expect(configuredBailianAuxiliary(ready, () => undefined)).toBeUndefined();
  });
});
