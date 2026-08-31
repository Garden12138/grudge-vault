import type { LlmModelModality, LlmModelOption } from "@grudge-vault/domain";

export type ModelTypeFilter = "all" | LlmModelModality;

export const MODEL_TYPE_FILTERS: ModelTypeFilter[] = [
  "all", "text", "image", "audio", "video", "embedding", "other", "unknown"
];

export function filterAndSortModels(
  models: LlmModelOption[],
  search: string,
  typeFilter: ModelTypeFilter
): LlmModelOption[] {
  const query = search.trim().toLocaleLowerCase("en-US");
  const rank = { compatible: 0, unknown: 1, incompatible: 2 } as const;
  return models.filter((model) => {
    const matchesSearch = !query || `${model.name}\n${model.id}`.toLocaleLowerCase("en-US").includes(query);
    const modalities = [...model.inputModalities, ...model.outputModalities];
    const matchesType = typeFilter === "all" || modalities.includes(typeFilter) ||
      (typeFilter === "unknown" && model.modalitySource === "unknown");
    return matchesSearch && matchesType;
  }).sort((left, right) => Number(right.recommended) - Number(left.recommended) ||
    rank[left.compatibility] - rank[right.compatibility] || left.name.localeCompare(right.name, "en"));
}

function titleCase(value: string): string {
  return value.charAt(0).toLocaleUpperCase("en-US") + value.slice(1);
}

export function formatModelType(model: LlmModelOption): string {
  const inputs = model.inputModalities;
  const outputs = model.outputModalities;
  if (outputs.length === 1 && outputs[0] === "embedding") return "Embedding";
  if (model.modalitySource === "unknown" || (inputs.includes("unknown") && outputs.includes("unknown"))) return "Unknown";
  return `${inputs.map(titleCase).join(" + ")} → ${outputs.map(titleCase).join(" + ")}`;
}

export function modelTypeFilterLabel(filter: ModelTypeFilter, chinese: boolean): string {
  if (filter === "all") return chinese ? "全部类型" : "All types";
  if (filter === "unknown") return chinese ? "未知" : "Unknown";
  if (filter === "other") return chinese ? "其他" : "Other";
  return titleCase(filter);
}
