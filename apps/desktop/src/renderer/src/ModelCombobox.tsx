import { useId, useMemo, useState } from "react";
import type { KeyboardEvent } from "react";
import type { LlmModelOption } from "@grudge-vault/domain";
import type { Language } from "./i18n";
import { filterAndSortModels, formatModelType, MODEL_TYPE_FILTERS, modelTypeFilterLabel, type ModelTypeFilter } from "./model-catalog";

function reasonText(model: LlmModelOption, language: Language): string | undefined {
  if (model.compatibility === "unknown") return language === "zh-CN" ? "兼容性未知，将在连接时验证" : "Compatibility unknown; verified when connecting";
  if (model.compatibility !== "incompatible") return undefined;
  const zh = {
    no_text_input: "不支持文本输入",
    no_text_output: "不支持文本输出",
    no_tool_calling: "不支持工具调用",
    non_chat_model: "不是文本助手模型"
  } as const;
  const en = {
    no_text_input: "No text input",
    no_text_output: "No text output",
    no_tool_calling: "No tool calling",
    non_chat_model: "Not a text assistant model"
  } as const;
  const fallback = language === "zh-CN" ? "与当前助手不兼容" : "Incompatible with this assistant";
  return model.compatibilityReason ? (language === "zh-CN" ? zh[model.compatibilityReason] : en[model.compatibilityReason]) : fallback;
}

interface ModelComboboxProps {
  models: LlmModelOption[];
  selectedModel: string;
  search: string;
  typeFilter: ModelTypeFilter;
  language: Language;
  disabled?: boolean;
  onSearchChange(value: string): void;
  onTypeFilterChange(value: ModelTypeFilter): void;
  onSelect(model: LlmModelOption): void;
}

export function ModelCombobox(props: ModelComboboxProps) {
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const results = useMemo(() => filterAndSortModels(props.models, props.search, props.typeFilter),
    [props.models, props.search, props.typeFilter]);
  const selected = props.models.find(({ id }) => id === props.selectedModel);
  const active = results[activeIndex];

  const move = (direction: 1 | -1) => {
    if (!results.length) return;
    let next = activeIndex < 0 ? (direction === 1 ? -1 : 0) : activeIndex;
    for (let attempts = 0; attempts < results.length; attempts += 1) {
      next = (next + direction + results.length) % results.length;
      if (results[next]?.compatibility !== "incompatible") break;
    }
    setActiveIndex(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") { setOpen(false); return; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); setOpen(true); move(event.key === "ArrowDown" ? 1 : -1); return;
    }
    if (event.key === "Enter" && open && active && active.compatibility !== "incompatible") {
      event.preventDefault(); props.onSelect(active); setOpen(false);
    }
  };

  return <div className="model-combobox" onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <div className="model-search-row">
      <input role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={listboxId}
        aria-activedescendant={open && active ? `${listboxId}-${activeIndex}` : undefined}
        aria-label={props.language === "zh-CN" ? "搜索模型名称或 ID" : "Search model name or ID"}
        placeholder={props.language === "zh-CN" ? "搜索模型名称或 ID" : "Search model name or ID"}
        disabled={props.disabled} value={props.search} onFocus={() => setOpen(true)} onKeyDown={onKeyDown}
        onChange={(event) => { props.onSearchChange(event.target.value); setActiveIndex(-1); setOpen(true); }} />
      <select aria-label={props.language === "zh-CN" ? "按模型类型筛选" : "Filter by model type"}
        disabled={props.disabled} value={props.typeFilter}
        onChange={(event) => { props.onTypeFilterChange(event.target.value as ModelTypeFilter); setActiveIndex(-1); setOpen(true); }}>
        {MODEL_TYPE_FILTERS.map((filter) => <option key={filter} value={filter}>{modelTypeFilterLabel(filter, props.language === "zh-CN")}</option>)}
      </select>
    </div>
    <div className="model-picker-summary">
      <span>{props.language === "zh-CN" ? `${results.length} / ${props.models.length} 个模型` : `${results.length} / ${props.models.length} models`}</span>
      {selected && <strong>{props.language === "zh-CN" ? "已选择：" : "Selected: "}{selected.name}</strong>}
      {!selected && props.selectedModel && <strong>{props.language === "zh-CN" ? "当前模型：" : "Current model: "}{props.selectedModel}</strong>}
    </div>
    {open && <div id={listboxId} className="model-options" role="listbox"
      aria-label={props.language === "zh-CN" ? "模型目录" : "Model catalog"}>
      {results.length === 0 ? <div className="model-empty">{props.language === "zh-CN" ? "没有匹配的模型" : "No matching models"}</div>
        : results.map((model, index) => {
          const disabled = model.compatibility === "incompatible";
          const reason = reasonText(model, props.language);
          return <button id={`${listboxId}-${index}`} key={model.id} type="button" role="option"
            aria-selected={props.selectedModel === model.id} aria-disabled={disabled} disabled={disabled}
            className={`${index === activeIndex ? "active" : ""} ${props.selectedModel === model.id ? "selected" : ""}`}
            onMouseEnter={() => setActiveIndex(index)} onMouseDown={(event) => event.preventDefault()}
            onClick={() => { props.onSelect(model); setOpen(false); }}>
            <span className="model-option-copy"><strong>{model.recommended ? "★ " : ""}{model.name}</strong>
              {model.id !== model.name && <code>{model.id}</code>}{reason && <small>{reason}</small>}</span>
            <span className={`model-type-tag ${model.compatibility}`}>{formatModelType(model)}</span>
          </button>;
        })}
    </div>}
  </div>;
}
