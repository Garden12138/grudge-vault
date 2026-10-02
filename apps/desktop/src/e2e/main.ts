import { app, ipcMain } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { GrudgeVaultApplication, type KeyProtectorPort, type LegalResearchInput, type MediaPipelinePort } from "@grudge-vault/application";
import { AppError } from "@grudge-vault/shared";
import type { Asset, MediaProcessingSettings } from "@grudge-vault/domain";
import type { AgentModelAdapterPort } from "@grudge-vault/agent-harness";
import { bootstrap } from "../main/bootstrap";
import { LocalWorkspaceManager } from "../main/workspace-manager";
import { coldSearchEmbedding, installColdSearchObserver } from "./cold-search-observer";

class E2eKeyProtector implements KeyProtectorPort {
  async assertAvailable(): Promise<void> {}
  async protect(key: Buffer): Promise<string> {
    return `e2e:${key.toString("base64")}`;
  }
  async unprotect(envelope: string): Promise<{ key: Buffer }> {
    if (!envelope.startsWith("e2e:")) throw new Error("Invalid E2E key envelope.");
    return { key: Buffer.from(envelope.slice(4), "base64") };
  }
}

class E2eAgentModelAdapter implements AgentModelAdapterPort {
  readonly identity = "e2e.injected-chat-completions";
  readonly version = 1;

  async testConnection(input: Parameters<NonNullable<AgentModelAdapterPort["testConnection"]>>[0]) {
    if (!input.apiKey) throw new Error("E2E API key missing");
    if (input.model === "e2e-delayed-connection") {
      const state = globalThis as typeof globalThis & { __gvE2eReleaseConnection?: () => void };
      await new Promise<void>((resolve) => { state.__gvE2eReleaseConnection = resolve; });
      delete state.__gvE2eReleaseConnection;
    }
  }

  async listModels() {
    const state = globalThis as typeof globalThis & { __gvE2eCatalogRequests?: number };
    state.__gvE2eCatalogRequests = (state.__gvE2eCatalogRequests ?? 0) + 1;
    return [
      { id: "openai/gpt-oss-20b", name: "GPT-OSS 20B", supportedParameters: ["tools"],
        inputModalities: ["text"], outputModalities: ["text"] },
      { id: "e2e/vision-assistant", name: "E2E Vision Assistant", supportedParameters: ["tools"],
        inputModalities: ["text", "image"], outputModalities: ["text"] },
      { id: "e2e/text-embedding", name: "E2E Text Embedding", supportedParameters: [],
        inputModalities: ["text"], outputModalities: ["embedding"] },
      { id: "e2e/no-tools-chat", name: "E2E Chat Without Tools", supportedParameters: ["temperature"],
        inputModalities: ["text"], outputModalities: ["text"] }
    ];
  }

  async run(input: Parameters<AgentModelAdapterPort["run"]>[0]) {
    const inference = globalThis as typeof globalThis & { __gvE2eInferenceCalls?: number };
    inference.__gvE2eInferenceCalls = (inference.__gvE2eInferenceCalls ?? 0) + 1;
    const structured = input.tools[0]?.name;
    const routing = globalThis as typeof globalThis & {
      __gvE2eNativeMode?: string; __gvE2eNativeRouting?: Array<{ tool: string; model: string }>;
    };
    if (routing.__gvE2eNativeMode && structured && structured !== "confirm_model_capability") {
      (routing.__gvE2eNativeRouting ??= []).push({ tool: structured, model: input.model });
      const parts = input.userContent as Array<{ type: string }> | undefined;
      if (input.model === "MiniMax-M3" && parts?.some((part) => part.type !== "text")) {
        throw new Error("Synthetic MiniMax main model must receive only checked text descriptions");
      }
    }
    if (structured === "confirm_model_capability") {
      await input.executeTool("confirm_model_capability", { ok: true }, "e2e-capability-call");
      return { text: "capability confirmed", model: input.model };
    }
    if (process.env.GRUDGE_VAULT_E2E_RASTER_FLOW === "1" && structured === "submit_screening") {
      const images = (input.userContent as Array<{ type: string; image_url?: { url: string } }> | undefined)
        ?.filter(({ type }) => type === "image_url") ?? [];
      if (images.length !== 1) throw new Error("Expected one synthetic raster input");
      const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(images[0]!.image_url?.url ?? "");
      if (!match) throw new Error("Expected an inline synthetic JPEG/PNG/WebP, never a local path or URL");
      const state = globalThis as typeof globalThis & { __gvE2eRasterInputs?: Array<{ mimeType: string; sha256: string }> };
      (state.__gvE2eRasterInputs ??= []).push({ mimeType: match[1]!, sha256: createHash("sha256").update(Buffer.from(match[2]!, "base64")).digest("hex") });
    }
    if (process.env.GRUDGE_VAULT_E2E_IMAGE_FLOW === "1" && (structured === "submit_screening" || structured === "submit_report")) {
      const state = globalThis as typeof globalThis & { __gvE2eImageMode?: string; __gvE2eImageCalls?: string[];
        __gvE2eImageStarted?: boolean };
      const corrupt = state.__gvE2eImageMode === "corrupt";
      const parts = input.userContent as Array<{ type: string; text?: string; image_url?: { url: string } }> | undefined;
      const images = parts?.filter(({ type }) => type === "image_url") ?? [];
      if (!corrupt) {
        if (images.length !== 1 || !parts?.some(({ text }) => text?.includes("HEIC 本机转换副本"))) {
          throw new Error("Expected one explicitly labelled converted synthetic image");
        }
        const url = images[0]!.image_url?.url ?? "";
        if (!url.startsWith("data:image/png;base64,")) throw new Error("Expected PNG, never raw HEIC");
        const raster = Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
        if (!raster.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
            raster.readUInt32BE(16) !== 64 || raster.readUInt32BE(20) !== 96 ||
            raster.includes(Buffer.from("GV_SYNTHETIC_PRIVATE_IMAGE_METADATA"))) {
          throw new Error("Expected full-size oriented raster with no synthetic private source metadata");
        }
      } else if (images.length) throw new Error("Corrupt synthetic source must not reach the model");
      (state.__gvE2eImageCalls ??= []).push(structured);
      if (state.__gvE2eImageMode === "cancel") {
        state.__gvE2eImageStarted = true;
        await new Promise<void>((_resolve, reject) => {
          const onAbort = () => reject(input.signal?.reason);
          input.signal?.addEventListener("abort", onAbort, { once: true });
          if (input.signal?.aborted) onAbort();
        });
      }
      if (structured === "submit_screening") {
        const sourceVersion = /sourceVersion=([^\n]+)/.exec(input.user)?.[1];
        const mediaNumber = Number(/媒体编号：mediaNumber=(\d+),/.exec(input.user)?.[1]);
        if (!sourceVersion || mediaNumber !== 1) throw new Error("Expected original synthetic image provenance and its first media number");
        const ordinary = state.__gvE2eImageMode === "ordinary";
        await input.executeTool(structured, { decision: ordinary ? "skip" : "include", categories: ordinary ? [] : ["grudge"],
          reason: "合成图片模型替身判断", anchors: [{ mediaNumber }], coverage: "complete", policyVersion: "screening-v1"
        }, "e2e-image-screen");
      } else {
        const assetId = /附件：([a-f0-9-]{36}):/.exec(input.user)?.[1];
        if (!assetId) throw new Error("Expected synthetic original attachment ID");
        await input.executeTool(structured, { summary: corrupt ? "合成图片认证失败，仅检查正文。" : "合成 HEIC 转换图片报告（模型替身）。",
          time: { source: "ai" }, location: { source: "ai" }, people: [], chronology: [],
          mediaSegments: corrupt ? [] : [{ description: "合成图片中的四色块", attachmentRef: assetId }],
          examinedAttachmentIds: corrupt ? [] : [assetId], unknowns: [], disputes: [], suggestions: [], legalIssues: [],
          coverageNotes: corrupt ? ["合成图片未通过认证"] : [], state: corrupt ? "partial" : "complete"
        }, "e2e-image-report");
      }
      return { model: input.model };
    }
    if (structured === "submit_media_segment_observations") {
      const state = globalThis as typeof globalThis & {
        __gvE2eNativeMode?: string; __gvE2eNativeCalls?: string[]; __gvE2eNativeSegmentStarted?: boolean;
      };
      const clipId = /segment-\d+/.exec(input.user)?.[0];
      if (!clipId) throw new Error("Expected synthetic native clip id");
      (state.__gvE2eNativeCalls ??= []).push(clipId);
      if (state.__gvE2eNativeMode === "cancel") {
        state.__gvE2eNativeSegmentStarted = true;
        await new Promise<void>((_resolve, reject) => {
          const onAbort = () => reject(input.signal?.reason);
          input.signal?.addEventListener("abort", onAbort, { once: true });
          if (input.signal?.aborted) onAbort();
        });
      }
      await input.executeTool(structured, { examinedSegmentId: clipId,
        coverage: state.__gvE2eNativeMode === "partial" ? "partial" : "complete",
        summary: state.__gvE2eNativeMode === "ordinary" ? "合成普通日常片段"
          : clipId === "segment-0" ? "合成片段开头是普通日常" : "合成片段后段含争议话语",
        observations: [{ description: "合成片段的可观察声音（模型替身）", intervalMs: [100, 200] }], notes: []
      }, "e2e-native-observation");
      return { model: input.model };
    }
    if (structured === "submit_screening") {
      const pauseCounter = globalThis as typeof globalThis & { __gvE2eZipPauseScreenCalls?: number; __gvE2eZipUsage?: boolean };
      if (pauseCounter.__gvE2eZipPauseScreenCalls !== undefined) pauseCounter.__gvE2eZipPauseScreenCalls++;
      if (pauseCounter.__gvE2eZipUsage && input.onUsage) {
        if (!input.includeUsage) throw new Error("The synthetic Bailian batch must request usage");
        input.onUsage({ kind: "request-started" });
      }
      if (input.user.includes("E2E导入进度暂停")) {
        const state = globalThis as typeof globalThis & {
          __gvE2eZipProgressHold?: boolean; __gvE2eZipProgressStarted?: boolean;
          __gvE2eZipProgressRelease?: () => void; __gvE2eZipProgressFinished?: boolean;
        };
        if (state.__gvE2eZipProgressHold) {
          state.__gvE2eZipProgressStarted = true;
          // Deliberately finish after cancellation to exercise the product's late-result guard.
          await new Promise<void>((resolve) => { state.__gvE2eZipProgressRelease = resolve; });
          delete state.__gvE2eZipProgressRelease; state.__gvE2eZipProgressFinished = true;
        }
      } else if (input.user.includes("E2E迁移取消")) {
        await new Promise<void>((resolve) => setTimeout(resolve, 2_500));
      } else if (input.user.includes("E2E延迟筛选")) {
        await new Promise<void>((resolve) => setTimeout(resolve, 700));
        (globalThis as typeof globalThis & { __gvE2eDelayedScreeningFinished?: boolean }).__gvE2eDelayedScreeningFinished = true;
      }
      const sourceVersion = /sourceVersion=([^\n]+)/.exec(input.user)?.[1] ?? "e2e-source";
      const temporaryMediaRef = /媒体临时引用：([^:\n、]+):/.exec(input.user)?.[1];
      const ordinary = input.user.includes("午饭后散步");
      if (input.user.includes("原生分段E2E")) {
        const state = globalThis as typeof globalThis & { __gvE2eNativeCalls?: string[] };
        (state.__gvE2eNativeCalls ??= []).push("screen");
        if (!JSON.stringify(input.userContent).includes("合成片段后段含争议话语")) throw new Error("Synthetic checked tail was not passed to screening");
      }
      const ambiguous = input.user.includes("他又这样说了");
      await input.executeTool("submit_screening", {
        decision: ordinary ? "skip" : ambiguous ? "review" : "include",
        categories: ordinary ? [] : input.user.includes("奖金") ? ["rights"] : ["grudge"],
        reason: ordinary ? "普通日常" : ambiguous ? "无法确定是否与用户有关" : "与用户的具体权益或负面经历有关",
        anchors: input.userContent && temporaryMediaRef ? [{ sourceVersion, temporaryMediaRef }] : [],
        coverage: "complete", policyVersion: "screening-v1"
      }, "e2e-screening-call");
      if (pauseCounter.__gvE2eZipUsage) input.onUsage?.(pauseCounter.__gvE2eZipPauseScreenCalls === 3
        ? { kind: "response-received", completionTokens: 2 }
        : { kind: "response-received", promptTokens: 20, completionTokens: 5 });
      return { text: "structured screening submitted", model: input.model };
    }
    if (structured === "submit_report") {
      if (process.env.GRUDGE_VAULT_E2E_LEGAL_FLOW === "1" && input.user.includes("E2E法律时间核验")) {
        const state = globalThis as typeof globalThis & { __gvE2eLegalReportMode?: "changed" };
        await input.executeTool(structured, { summary: "合成人物甲称奖金未付，约定和凭证仍待核对。",
          time: { source: "ai", value: { value: state.__gvE2eLegalReportMode === "changed" ? "2026-09-12" : "2026-09-10", precision: "exact" } },
          location: { source: "ai" }, people: [{ name: "合成人物甲", source: "source" }], chronology: [],
          unknowns: ["约定与关系尚未核实"], disputes: [], suggestions: ["整理约定与付款凭证"],
          legalIssues: ["合成奖金争议的适用规则待核对"], coverageNotes: [], state: "complete" }, "e2e-current-legal-report");
        return { model: input.model };
      }
      if (input.user.includes("原生分段E2E")) {
        const state = globalThis as typeof globalThis & { __gvE2eNativeCalls?: string[]; __gvE2eNativeMode?: string };
        (state.__gvE2eNativeCalls ??= []).push("report");
        const assetId = /附件：([a-f0-9-]{36}):/.exec(input.user)?.[1];
        const corrupt = state.__gvE2eNativeMode === "corrupt";
        if (!assetId || !corrupt && !JSON.stringify(input.userContent).includes("合成片段后段含争议话语")) throw new Error("Synthetic checked tail was not passed to report");
        await input.executeTool(structured, { summary: corrupt ? "附件无法认证；仅整理合成正文。" : "分段模型替身报告：后段的合成争议已保留。",
          time: { source: "ai" }, location: { source: "ai" }, people: [], chronology: [],
          examinedAttachmentIds: corrupt ? [] : [assetId], unknowns: [], disputes: [], suggestions: [], legalIssues: [],
          coverageNotes: corrupt ? ["模型替身未收到无法认证的附件"] : [], state: corrupt ? "partial" : "complete" }, "e2e-native-report");
        return { model: input.model };
      }
      let refreshReportAttempt: number | undefined;
      if (input.user.includes("E2E搜索报告刷新")) {
        const state = globalThis as typeof globalThis & {
          __gvE2eReportRefreshAttempts?: number; __gvE2eReleaseReportRefresh?: () => void;
        };
        refreshReportAttempt = (state.__gvE2eReportRefreshAttempts ?? 0) + 1;
        state.__gvE2eReportRefreshAttempts = refreshReportAttempt;
        try {
          await new Promise<void>((resolve, reject) => {
            const onAbort = () => reject(input.signal?.reason);
            state.__gvE2eReleaseReportRefresh = () => {
              input.signal?.removeEventListener("abort", onAbort);
              resolve();
            };
            input.signal?.addEventListener("abort", onAbort, { once: true });
            if (input.signal?.aborted) onAbort();
          });
        } finally { delete state.__gvE2eReleaseReportRefresh; }
      }
      const reportDelayKey = input.user.includes("E2E延迟报告") ? "__gvE2eDelayedReportAttempts"
        : input.user.includes("E2E取消报告") ? "__gvE2eCancelReportAttempts" : undefined;
      if (reportDelayKey) {
        const testState = globalThis as typeof globalThis & {
          __gvE2eDelayedReportAttempts?: number; __gvE2eCancelReportAttempts?: number;
        };
        testState[reportDelayKey] = (testState[reportDelayKey] ?? 0) + 1;
        if (testState[reportDelayKey] === 1) {
          await new Promise<void>((resolve, reject) => {
            const onAbort = () => { clearTimeout(timer); reject(input.signal?.reason); };
            const timer = setTimeout(() => {
              input.signal?.removeEventListener("abort", onAbort);
              resolve();
            }, 5_000);
            input.signal?.addEventListener("abort", onAbort, { once: true });
            if (input.signal?.aborted) onAbort();
          });
        }
      }
      const invalidAnchorAssetId = input.user.includes("E2E错误媒体定位")
        ? /附件：([a-f0-9-]{36}):/.exec(input.user)?.[1] : undefined;
      const fieldFlow = input.user.includes("E2E报告字段来源");
      const occurrenceFlow = input.user.includes("E2E时间线报告日期");
      const missingPeople = fieldFlow && input.user.includes("人物待补充");
      if (fieldFlow) {
        const state = globalThis as typeof globalThis & { __gvE2eReportFieldPrompts?: string[] };
        (state.__gvE2eReportFieldPrompts ??= []).push(input.user);
      }
      await input.executeTool("submit_report", {
        summary: refreshReportAttempt ? `搜索详情后台报告第 ${refreshReportAttempt} 版已完成。`
          : "项目奖金尚未结清，需要核对约定与付款记录。",
        time: occurrenceFlow ? { source: "ai", value: { value: "约2026年9月", precision: "approximate" } }
          : fieldFlow ? { source: "ai", value: { value: missingPeople ? "2099-01-01 12:34" : "约在九月",
          precision: missingPeople ? "unknown" : "approximate" }, prompt: "待补充：大约何时发生？" }
          : { source: "source", prompt: "待补充：大约何时发生？" },
        location: { source: "source", prompt: "待补充：事情发生在哪里？" },
        people: fieldFlow ? missingPeople ? [] : [
          { name: `合成人物甲${"长姓名".repeat(40)}`, role: "合成角色".repeat(30), source: "source" },
          { name: "尚待核对的合成人物乙", source: "ai" }
        ] : [{ name: "公司", role: "付款方", source: "source" }],
        chronology: [{ text: "用户记录项目奖金迟迟未结清。", textRange: [0, 8] }],
        unknowns: [input.user.includes("我记得约定金额是五千元")
          ? "合同原件是否载明奖金金额？" : "奖金约定的具体金额和支付日期尚待补充。"], disputes: [],
        speculations: ["公司可能故意拖欠，但目前没有证据。"],
        suggestions: ["整理奖金约定、工资记录和催款沟通。"],
        legalIssues: ["奖金是否构成约定的劳动报酬需要结合材料核验。"],
        ...(invalidAnchorAssetId ? {
          examinedAttachmentIds: [invalidAnchorAssetId],
          mediaSegments: [{
            description: "合成录音建议定位", attachmentRef: invalidAnchorAssetId, intervalMs: [10_000, 11_000]
          }]
        } : {}),
        coverageNotes: [], state: "complete"
      }, "e2e-report-call");
      return { text: "structured report submitted", model: input.model };
    }
    if (structured === "submit_media_query_descriptions") {
      const videoFlow = process.env.GRUDGE_VAULT_E2E_VIDEO_QUERY_FLOW === "1";
      const phrase = videoFlow
        ? "合成视频片段显示奖金讨论" : "合成片段后段含争议话语";
      const contexts = input.userContent as Array<{ type: string; text?: string; video_url?: { url: string } }>;
      const ids = contexts.flatMap(({ text }) => {
        const id = text && (videoFlow ? /^下一段媒体的 id：([a-f0-9-]{36})/.exec(text)?.[1]
          : /^附件 ([a-f0-9-]{36}) 的逐段 AI 理解/.exec(text)?.[1]);
        return id ? [id] : [];
      });
      const state = globalThis as typeof globalThis & { __gvE2eNativeCalls?: string[];
        __gvE2eVideoQuerySha256?: string };
      if (videoFlow) {
        const videos = contexts.filter(({ type }) => type === "video_url");
        const encoded = /^data:;base64,([A-Za-z0-9+/=]+)$/.exec(videos[0]?.video_url?.url ?? "");
        if (ids.length !== 1 || videos.length !== 1 || !encoded) throw new Error("Expected one private inline synthetic video query");
        state.__gvE2eVideoQuerySha256 = createHash("sha256").update(Buffer.from(encoded[1]!, "base64")).digest("hex");
      } else if (!ids.length || !JSON.stringify(contexts).includes(phrase)) {
        throw new Error("Expected checked synthetic query evidence");
      }
      (state.__gvE2eNativeCalls ??= []).push("query");
      await input.executeTool(structured, { descriptions: ids.map((id) => ({ id, text: phrase })) }, "e2e-query");
      return { model: input.model };
    }
    if (input.user.includes("attribution")) {
      await input.executeTool("search_events", { query: "attribution" }, "e2e-tool-call-1");
    }
    return { text: "Injected Enhanced answer with locally grounded citations.", model: input.model };
  }
}

class E2eMediaPipeline implements MediaPipelinePort {
  private settings: MediaProcessingSettings = {
    autoProcessNew: true, ocrLanguages: ["eng"], resourceProfile: "balanced", whisperGpu: "auto"
  };
  private readonly configHash = createHash("sha256").update("e2e-media-config-v1").digest("hex");

  getSettings() { return this.settings; }
  async updateSettings(settings: MediaProcessingSettings) { this.settings = settings; return this.getStatus(); }
  async getStatus() {
    return {
      settings: this.settings,
      ocr: { configured: true, available: true, identity: "e2e.ocr", version: "1", displayNames: ["injected-e2e-ocr"], warnings: [] },
      asr: { configured: true, available: true, identity: "e2e.asr", version: "1", displayNames: ["injected-e2e-asr"], warnings: [] },
      eligibleHistoricalAssets: 0, pendingJobs: 0
    };
  }
  probe() { return this.getStatus(); }
  kindFor(asset: Asset) { return asset.mimeType === "image/png" ? "ocr" as const : undefined; }
  async fingerprint(asset: Asset) {
    return { kind: "ocr" as const, processorIdentity: "e2e.ocr", processorVersion: 1, configHash: this.configHash,
      inputHash: createHash("sha256").update(`${asset.sha256}:${this.configHash}`).digest("hex") };
  }
  async process(input: Parameters<MediaPipelinePort["process"]>[0]) {
    const fingerprint = await this.fingerprint(input.asset);
    input.reportProgress(1);
    return { ...fingerprint, payload: {
      formatVersion: 1 as const, kind: "ocr" as const, sourceAssetId: input.asset.id, sourceSha256: input.asset.sha256,
      language: "eng", processorIdentity: "e2e.ocr", processorVersion: 1, engineVersions: { injected: "1" },
      configHash: this.configHash, text: "E2E OCR attribution evidence from a local image.",
      pages: [{ page: 1, text: "E2E OCR attribution evidence from a local image.", words: [] }],
      createdAt: new Date().toISOString()
    } };
  }
}

const workspacePath = process.env.GRUDGE_VAULT_E2E_WORKSPACE;
if (!workspacePath) throw new Error("GRUDGE_VAULT_E2E_WORKSPACE is required.");
if (process.env.GRUDGE_VAULT_E2E_COLD_SEARCH_FLOW === "1") installColdSearchObserver();

// Fault injection exists only in the isolated E2E entry, never the production entry.
if (process.env.GRUDGE_VAULT_E2E_SETTINGS_READ_FAILURE === "1") {
  const state = globalThis as typeof globalThis & { __gvE2eFailSettingsReads?: boolean;
    __gvE2eSettingsReadFailures?: Record<"model" | "index" | "jurisdiction", number> };
  state.__gvE2eFailSettingsReads = false;
  state.__gvE2eSettingsReadFailures = { model: 0, index: 0, jurisdiction: 0 };
  const fail = (kind: "model" | "index" | "jurisdiction") => {
    if (!state.__gvE2eFailSettingsReads) return;
    state.__gvE2eSettingsReadFailures![kind]++;
    throw new AppError("WORKSPACE_INVALID", "合成设置读取失败", true);
  };
  const model = GrudgeVaultApplication.prototype.getLlmSettings;
  GrudgeVaultApplication.prototype.getLlmSettings = function () { fail("model"); return model.call(this); };
  const index = GrudgeVaultApplication.prototype.getRecordSearchIndexStatus;
  GrudgeVaultApplication.prototype.getRecordSearchIndexStatus = function () { fail("index"); return index.call(this); };
  const jurisdiction = GrudgeVaultApplication.prototype.getDefaultLegalJurisdiction;
  GrudgeVaultApplication.prototype.getDefaultLegalJurisdiction = function () { fail("jurisdiction"); return jurisdiction.call(this); };
}
if (process.env.GRUDGE_VAULT_E2E_TIMELINE_READ_FAILURE === "1") {
  const read = GrudgeVaultApplication.prototype.listRecordTimeline;
  const state = globalThis as typeof globalThis & { __gvE2eFailTimelineRead?: boolean; __gvE2eTimelineReadFailures?: number };
  state.__gvE2eFailTimelineRead = true;
  GrudgeVaultApplication.prototype.listRecordTimeline = function (...args) {
    if (state.__gvE2eFailTimelineRead) {
      state.__gvE2eTimelineReadFailures = (state.__gvE2eTimelineReadFailures ?? 0) + 1;
      throw new AppError("WORKSPACE_INVALID", "合成时间线读取失败", true);
    }
    return read.apply(this, args);
  };
}
if (process.env.GRUDGE_VAULT_E2E_WORKSPACE_CLOSE_FAILURE === "1") {
  const openWorkspace = LocalWorkspaceManager.prototype.open;
  LocalWorkspaceManager.prototype.open = async function (...args) {
    const current = await openWorkspace.apply(this, args);
    const close = current.close;
    current.close = async () => {
      await close();
      const state = globalThis as typeof globalThis & { __gvE2eFailWorkspaceClose?: boolean };
      if (state.__gvE2eFailWorkspaceClose) {
        state.__gvE2eFailWorkspaceClose = false;
        throw new Error("Synthetic close failure after database close and key disposal");
      }
    };
    return current;
  };
}

app.enableSandbox();
if (process.env.GRUDGE_VAULT_E2E_NO_NETWORK === "1") {
  globalThis.fetch = async () => {
    const state = globalThis as typeof globalThis & { __gvE2eUnexpectedNetwork?: number };
    state.__gvE2eUnexpectedNetwork = (state.__gvE2eUnexpectedNetwork ?? 0) + 1;
    throw new Error("Network access is forbidden in this isolated synthetic test");
  };
}
void bootstrap({
  keyProtector: new E2eKeyProtector(),
  agentModelAdapter: new E2eAgentModelAdapter(),
  mediaPipeline: new E2eMediaPipeline(),
  // Model injection alone must not leave a real legal-search side channel in synthetic tests.
  legalResearch: { async research(input) {
    if (process.env.GRUDGE_VAULT_E2E_LEGAL_FLOW === "1") {
      const state = globalThis as typeof globalThis & { __gvE2eLegalInputs?: LegalResearchInput[] };
      (state.__gvE2eLegalInputs ??= []).push(globalThis.structuredClone(input));
      return { issues: [], citations: [{ id: "synthetic-citation", title: "合成规则（非真实法律）", publisher: "中国政府网",
        url: `https://www.gov.cn/synthetic-e2e-rule?proof=${"SyntheticOriginalLink".repeat(20)}`, retrievedAt: "2026-09-29T00:00:00.000Z", jurisdiction: "中国大陆",
        effectiveInfo: "", supportingExcerpt: "只用于验证界面的合成摘录，不代表实际法律。", claimId: "issue-1",
        verificationStatus: "verified" as const, verificationEvidence: { officialSource: true, excerptSupportsClaim: true,
          jurisdictionMatches: true, effectiveAtOccurredAt: true } }], coverageNotes: [] };
    }
    return { issues: input.issues, citations: [], coverageNotes: [] };
  } },
  ...(process.env.GRUDGE_VAULT_E2E_COLD_SEARCH_FLOW === "1" ? { recordEmbedding: coldSearchEmbedding } :
    process.env.GRUDGE_VAULT_E2E_NATIVE_FLOW === "1" || process.env.GRUDGE_VAULT_E2E_VIDEO_QUERY_FLOW === "1" ||
    process.env.GRUDGE_VAULT_E2E_IMAGE_FLOW === "1" ||
    process.env.GRUDGE_VAULT_E2E_SEARCH_FLOW === "1" ? { recordEmbedding: {
    identity: "e2e.synthetic-native-flow", version: 1, dimensions: 2, inputModalities: ["text", "image"] as const,
    async embed(inputs: import("@grudge-vault/application").RecordEmbeddingInput[], signal?: AbortSignal) {
      if (process.env.GRUDGE_VAULT_E2E_SEARCH_FLOW === "1" && inputs.length > 1) {
        const state = globalThis as typeof globalThis & {
          __gvE2eHoldSearchIndex?: boolean; __gvE2eReleaseSearchIndex?: () => void;
        };
        if (state.__gvE2eHoldSearchIndex) try {
          await new Promise<void>((resolve, reject) => {
            const onAbort = () => reject(signal?.reason);
            state.__gvE2eReleaseSearchIndex = () => {
              state.__gvE2eHoldSearchIndex = false; signal?.removeEventListener("abort", onAbort); resolve();
            };
            signal?.addEventListener("abort", onAbort, { once: true });
            if (signal?.aborted) onAbort();
          });
        } finally { delete state.__gvE2eReleaseSearchIndex; }
      }
      if (process.env.GRUDGE_VAULT_E2E_IMAGE_FLOW === "1") for (const input of inputs) {
        if (input.modality !== "image") continue;
        if (input.mimeType !== "image/png" || !input.bytes ||
            !Buffer.from(input.bytes).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
            Buffer.from(input.bytes).includes(Buffer.from("GV_SYNTHETIC_PRIVATE_IMAGE_METADATA"))) {
          throw new Error("Synthetic embedding must receive a private raster, never HEIC or source EXIF");
        }
        const state = globalThis as typeof globalThis & { __gvE2eImageEmbeddings?: number };
        state.__gvE2eImageEmbeddings = (state.__gvE2eImageEmbeddings ?? 0) + 1;
      }
      return inputs.map(({ text }) => process.env.GRUDGE_VAULT_E2E_VIDEO_QUERY_FLOW === "1" &&
        !text?.includes("合成视频片段显示奖金讨论") ? new Float32Array([0, 1]) : new Float32Array([1, 0]));
    }
  } } : {}),
  initialWorkspacePath: workspacePath,
  initialWorkspaceName: "Automated Vault",
  ...(process.env.GRUDGE_VAULT_E2E_PREVIEW_FLOW === "1" ? { onMediaPreviewRead: (value: { start: number; end: number; byteSize: number; chunkBytes: number }) => {
    const state = globalThis as typeof globalThis & { __gvE2ePreviewReads?: Array<{ start: number; end: number; byteSize: number; chunkBytes: number }> };
    (state.__gvE2ePreviewReads ??= []).push(value);
  }, onMediaPreviewAccess: (value: { status: number; origin: string }) => {
    const state = globalThis as typeof globalThis & { __gvE2ePreviewAccess?: Array<{ status: number; origin: string }> };
    (state.__gvE2ePreviewAccess ??= []).push(value);
  } } : {})
}).then(() => {
  if (process.env.GRUDGE_VAULT_E2E_STALLED_ZIP_PROGRESS !== "1") return;
  const state = globalThis as typeof globalThis & {
    __gvE2eZipStatusHandlerReady?: boolean; __gvE2eZipStatusReads?: number;
    __gvE2eReleaseOldZipStatus?: () => void; __gvE2eReleaseLaterZipStatuses?: () => void;
  };
  const operationId = randomUUID();
  const paused = { operationId, phase: "paused" as const, totalEntries: 4,
    included: 1, skipped: 1, review: 0, failed: 0, issueCount: 0, updatedAt: "2026-09-30T00:00:00.000Z" };
  const held: Array<() => void> = [];
  state.__gvE2eReleaseLaterZipStatuses = () => { while (held.length) held.shift()?.(); };
  ipcMain.removeHandler("intake:dayone-import-progress");
  ipcMain.handle("intake:dayone-import-progress", () => {
    const read = (state.__gvE2eZipStatusReads ?? 0) + 1;
    state.__gvE2eZipStatusReads = read;
    if (read === 2) return new Promise((resolve) => setTimeout(() => resolve({ ok: true, data: paused }), 1_500));
    return new Promise((resolve) => {
      const release = () => resolve({ ok: true, data: read === 1 ? { ...paused, phase: "completed" } : paused });
      if (read === 1) state.__gvE2eReleaseOldZipStatus = release;
      else held.push(release);
    });
  });
  state.__gvE2eZipStatusHandlerReady = true;
});
