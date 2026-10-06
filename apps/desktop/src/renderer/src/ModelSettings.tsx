import { useEffect, useRef, useState } from "react";
import type { BailianRegion, LlmModelOption, LlmSettings, RecordSearchIndexStatus } from "@grudge-vault/domain";
import { matchesTestedModelConfiguration } from "./model-configuration";
import { dateLabel } from "./record-time";
import { Disclosure } from "./ui-components";
import { displayError, UiError, unwrap } from "./ui-errors";

export function ModelSettings({ settings, searchIndex = null, fresh, indexFresh = false, onChanged, onConnected, embedded = false }: {
  settings: LlmSettings; searchIndex?: RecordSearchIndexStatus | null; fresh: boolean; indexFresh?: boolean;
  onChanged(): Promise<void>; onConnected?(): void; embedded?: boolean;
}) {
  const initialProvider = settings.activeProvider === "minimax" ? "minimax" : "bailian";
  const [provider, setProvider] = useState<"bailian" | "minimax">(initialProvider);
  const config = settings.providers[provider];
  const [model, setModel] = useState(settings.providers[initialProvider]?.model ?? (initialProvider === "bailian" ? "qwen3.8-omni-flash" : "MiniMax-M3"));
  const [apiKey, setApiKey] = useState("");
  const [region, setRegion] = useState<BailianRegion>(settings.providers[initialProvider]?.region ?? "cn-beijing");
  const [workspaceId, setWorkspaceId] = useState(settings.providers[initialProvider]?.workspaceId ?? "");
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false), [advanced, setAdvanced] = useState(false);
  const [recommendations, setRecommendations] = useState<LlmModelOption[]>([]);
  const [recommendationError, setRecommendationError] = useState("");
  const lifetime = useRef({ value: 0 });
  useEffect(() => { const owner = lifetime.current; owner.value++; return () => { owner.value++; }; }, []);
  useEffect(() => {
    let cancelled = false;
    setRecommendations([]); setRecommendationError("");
    void window.grudgeVault.llm.listModels({ provider, recommendationsOnly: true,
      ...(provider === "bailian" ? { region: "cn-beijing" as const } : {}) }).then((result) => {
      if (cancelled) return;
      if (result.ok) setRecommendations(result.data.filter(({ recommended }) => recommended));
      else { setRecommendationError("候选清单暂时不可用，可在高级设置填写模型 ID。"); setAdvanced(true); }
    }).catch(() => { if (!cancelled) { setRecommendationError("候选清单暂时不可用，可在高级设置填写模型 ID。"); setAdvanced(true); } });
    return () => { cancelled = true; };
  }, [provider]);
  const selectedRecommendation = recommendations.find(({ id }) => id === model.trim());
  const tested = matchesTestedModelConfiguration(config, { provider, model, region, workspaceId, apiKey });
  const capabilities = tested && fresh ? config?.capabilities : undefined;
  const active = settings.activeProvider === provider;
  const clearMessage = () => { setMessage(""); setFailed(false); };
  const selectProvider = (next: "bailian" | "minimax") => {
    const saved = settings.providers[next];
    setProvider(next); setModel(saved?.model ?? (next === "bailian" ? "qwen3.8-omni-flash" : "MiniMax-M3"));
    setRegion(saved?.region ?? "cn-beijing"); setWorkspaceId(saved?.workspaceId ?? "");
    setApiKey(""); setAdvanced(false); clearMessage();
  };
  const connect = async () => {
    if (!fresh || busy) return;
    if ((!config?.credentialConfigured || provider === "bailian" && model.trim() === "qwen3.8-omni-flash" && config.model !== "qwen3.8-omni-flash") && !window.confirm(
      "启用模型后，筛选会发送尚未确定是否收录的文字和附件，正式记录会发送用于报告分析；如选择百炼 qwen3.8-omni-flash，中国大陆权益问题还会联网搜索官方来源。服务商可能计费并按其政策处理数据。继续测试并保存配置吗？"
    )) return;
    const scope = lifetime.current.value;
    setBusy(true); clearMessage();
    try {
      unwrap(await window.grudgeVault.llm.connect({ provider, model: model.trim(), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(provider === "bailian" ? { region, ...(workspaceId.trim() ? { workspaceId: workspaceId.trim() } : {}) } : {}) }));
      if (scope !== lifetime.current.value) return;
      setApiKey(""); await onChanged();
      if (scope !== lifetime.current.value) return;
      setMessage("连接测试通过，已保存配置。"); onConnected?.();
    } catch (cause) {
      if (scope !== lifetime.current.value) return;
      setFailed(true); setMessage(displayError(cause));
      if (cause instanceof UiError && ["LLM_REGION_MISMATCH", "LLM_MODEL_NOT_FOUND", "LLM_TOOL_UNSUPPORTED"].includes(cause.code)) setAdvanced(true);
    } finally { if (scope === lifetime.current.value) setBusy(false); }
  };
  const pause = async () => {
    const scope = lifetime.current.value;
    setBusy(true); clearMessage();
    try { unwrap(await window.grudgeVault.llm.pause()); if (scope !== lifetime.current.value) return;
      await onChanged(); if (scope === lifetime.current.value) setMessage("已暂停模型外发，密钥和配置仍保留。已经发送的请求可能继续完成。");
    } catch (cause) { if (scope === lifetime.current.value) { setFailed(true); setMessage(displayError(cause)); } }
    finally { if (scope === lifetime.current.value) setBusy(false); }
  };
  const capability = (label: string, verified: boolean, candidate: boolean) => {
    const state = !fresh ? "pending" : verified ? "ready" : candidate ? "pending" : "unavailable";
    return <span className={state}>{label} · {!fresh ? "状态未知" : verified ? "可用" : candidate ? "待验证" : "不支持"}</span>;
  };
  const openHelp = async () => {
    const scope = lifetime.current.value;
    try { unwrap(await window.grudgeVault.external.open(provider === "bailian"
      ? "https://help.aliyun.com/zh/model-studio/get-api-key/" : "https://platform.minimax.io/docs/guides/quickstart-preparation")); }
    catch (cause) { if (scope === lifetime.current.value) { setMessage(displayError(cause)); setFailed(true); } }
  };
  return <section className={`settings-card model-settings${embedded ? " embedded" : ""}`}>
    <div className="settings-card-header"><div><h2>模型服务</h2><p>{config?.credentialConfigured ? `${provider === "bailian" ? "百炼" : "MiniMax"} · ${config.model}` : "连接一次，即可筛选记录并整理报告。"}</p></div>
      <span className={`status ${fresh && active ? "status-complete" : "status-partial"}`}>{!fresh ? "状态未知" : active ? tested ? "当前启用" : "已保存配置启用中" : config?.credentialConfigured ? config.status === "needs_attention" ? "需重新测试" : settings.activeProvider ? "已配置" : "已暂停" : "未配置"}</span>
    </div>
    <div className="provider-tabs"><button type="button" disabled={busy} aria-pressed={provider === "bailian"} className={provider === "bailian" ? "active" : ""} onClick={() => selectProvider("bailian")}>百炼</button><button type="button" disabled={busy} aria-pressed={provider === "minimax"} className={provider === "minimax" ? "active" : ""} onClick={() => selectProvider("minimax")}>MiniMax</button></div>
    <div className="settings-form">
      <label className="field">推荐模型<select aria-label="推荐模型" disabled={busy || recommendations.length === 0} value={selectedRecommendation?.id ?? ""} onChange={(event) => { setModel(event.target.value); setAdvanced(!event.target.value); clearMessage(); }}><option value="">自定义模型 ID</option>{recommendations.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}</select></label>
      <p className="capability-help">推荐为候选清单，实际能力以连接测试和你的输入验证为准。</p>
      {recommendationError && <p className="inline-warning" role="status">{recommendationError}</p>}
      <label className="field">API 密钥<input disabled={busy} type="password" autoComplete="off" value={apiKey} onChange={(event) => { setApiKey(event.target.value); clearMessage(); }} placeholder={config?.credentialConfigured ? "已安全保存；留空则沿用" : "粘贴服务商提供的密钥"} /></label>
      <button className="text-button help-link" type="button" onClick={() => void openHelp()}>如何获取 API 密钥？</button>
      {message && <div className={`banner ${failed ? "error" : "notice"}`} role={failed ? "alert" : "status"}>{message}</div>}
      <p className="privacy-summary">筛选和分析会发送文字与附件给所选服务商，可能产生费用；即使未收录，服务商也可能按其政策留存。</p>
      <button type="button" className="primary" disabled={busy || !fresh || !model.trim() || (!apiKey.trim() && !config?.credentialConfigured)} onClick={() => void connect()}>{busy ? "正在处理…" : config?.credentialConfigured && !active ? "重新测试并启用" : "测试连接并保存"}</button>
      {!tested && config?.credentialConfigured && <p className="inline-warning" role="status">当前输入尚未测试；编辑不会改变已保存配置，能力标签也不会沿用旧测试。</p>}
      <Disclosure title="高级设置" forceOpen={advanced || Boolean(config && recommendations.length && !selectedRecommendation)}>
        <label className="field">模型 ID<input disabled={busy} value={model} onChange={(event) => { setModel(event.target.value); clearMessage(); }} placeholder="输入账户中已开通的模型 ID" /></label>
        {provider === "bailian" && <div className="form-row"><label className="field">地域<select aria-label="地域" disabled={busy} value={region} onChange={(event) => { setRegion(event.target.value as BailianRegion); clearMessage(); }}><option value="cn-beijing">中国大陆（北京）</option><option value="cn-hongkong">中国香港</option><option value="ap-southeast-1">国际（新加坡）</option><option value="us-east-1">美国（弗吉尼亚）</option></select></label><label className="field">业务空间（按需）<input disabled={busy} value={workspaceId} onChange={(event) => { setWorkspaceId(event.target.value); clearMessage(); }} /></label></div>}
      </Disclosure>
      <div className="capability-grid" aria-label="模型能力">
        {capability("文字", Boolean(capabilities?.structuredOutput && capabilities.inputModalities.includes("text")), true)}
        {capability("图片", Boolean(capabilities?.inputModalities.includes("image")), Boolean(selectedRecommendation?.inputModalities.includes("image")) || /omni|vision|[-_]vl|minimax-m3/i.test(model))}
        {capability("音频", Boolean(capabilities?.inputModalities.includes("audio")), provider === "bailian" && model === "qwen3.8-omni-flash")}
        {capability("视频", Boolean(capabilities?.inputModalities.includes("video")), provider === "bailian" && model === "qwen3.8-omni-flash")}
      </div>
      <Disclosure title="能力与处理详情">
        <p className="capability-help">连接测试验证文字与结构化输出。图片、音频和视频只有在对应筛选完整成功后才标记可用；待验证不代表已验证。长音视频和 M4A 在 Mac 本机分段后处理，可能增加耗时与费用，不会静默截断。MiniMax 可使用已配置的百炼补齐辅助能力。</p>
        <p className="capability-help">流式响应 · {capabilities?.streaming ? "可用" : "待验证"}{capabilities?.maxInput ? `；已验证输入上限：${capabilities.maxInput.toLocaleString()}` : ""}{capabilities?.lastVerifiedAt ? `；最近验证：${dateLabel(capabilities.lastVerifiedAt)}` : ""}。</p>
        {!embedded && <p className="capability-help">百炼图文检索（独立） · {!indexFresh ? "状态未知" : searchIndex?.state === "ready" ? "可用" : searchIndex?.available ? "待建立索引" : "未配置"}，需在搜索设置中单独授权。</p>}
      </Disclosure>
      {!embedded && active && <button type="button" disabled={busy} onClick={() => void pause()}>暂停全部模型外发</button>}
    </div>
  </section>;
}
