import { describe, expect, it } from "vitest";
import type { LlmModelOption } from "@grudge-vault/domain";
import { filterAndSortModels, formatModelType } from "./model-catalog";

function model(overrides: Partial<LlmModelOption> & Pick<LlmModelOption, "id">): LlmModelOption {
  const { id, ...rest } = overrides;
  return {
    id, name: overrides.name ?? id, recommended: false, toolCapable: true,
    inputModalities: ["text"], outputModalities: ["text"], modalitySource: "provider",
    compatibility: "compatible", ...rest
  };
}

describe("model catalog combobox", () => {
  const models = [
    model({ id: "vendor/text-model", name: "Alpha Chat", recommended: true }),
    model({ id: "vendor/vision-model", name: "Vision Pro", inputModalities: ["text", "image"] }),
    model({ id: "vendor/embed-model", name: "Vector Index", outputModalities: ["embedding"],
      compatibility: "incompatible", compatibilityReason: "non_chat_model" }),
    model({ id: "vendor/mystery", name: "Mystery", inputModalities: ["unknown"], outputModalities: ["unknown"],
      modalitySource: "unknown", compatibility: "unknown" })
  ];

  it("searches display names and full IDs without case sensitivity", () => {
    expect(filterAndSortModels(models, "VISION pro", "all").map(({ id }) => id)).toEqual(["vendor/vision-model"]);
    expect(filterAndSortModels(models, "VENDOR/TEXT", "all").map(({ id }) => id)).toEqual(["vendor/text-model"]);
    expect(filterAndSortModels(models, "does-not-exist", "all")).toEqual([]);
  });

  it("filters input or output modalities and keeps unknown models visible", () => {
    expect(filterAndSortModels(models, "", "image").map(({ id }) => id)).toEqual(["vendor/vision-model"]);
    expect(filterAndSortModels(models, "", "embedding").map(({ id }) => id)).toEqual(["vendor/embed-model"]);
    expect(filterAndSortModels(models, "", "unknown").map(({ id }) => id)).toEqual(["vendor/mystery"]);
    expect(filterAndSortModels(models, "", "audio")).toEqual([]);
  });

  it("formats directional modality labels and sorts recommendations before compatibility", () => {
    expect(formatModelType(models[0]!)).toBe("Text → Text");
    expect(formatModelType(models[1]!)).toBe("Text + Image → Text");
    expect(formatModelType(models[2]!)).toBe("Embedding");
    expect(formatModelType(models[3]!)).toBe("Unknown");
    expect(filterAndSortModels(models, "", "all").map(({ id }) => id)).toEqual([
      "vendor/text-model", "vendor/vision-model", "vendor/mystery", "vendor/embed-model"
    ]);
  });
});
