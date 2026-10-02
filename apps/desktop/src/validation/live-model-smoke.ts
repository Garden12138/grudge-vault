// Explicitly launched developer validation only; this entry is never a packaged application Main.
import { app, BrowserWindow } from "electron";
import { createDecipheriv, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { AgentHarness, OpenAiCompatibleChatAdapter, BailianNativeMediaQueryAdapter, type AgentModelAdapterPort } from "../../../../packages/agent-harness/src/index";
import { resolveLlmProviderEndpoint, type GrudgeVaultApplication, type ScreeningInput, type ReportAnalysisInput } from "@grudge-vault/application";
import type { BailianRegion, LlmSettings } from "@grudge-vault/domain";
import { SafeStorageKeyProtector } from "../main/key-protector";
import { openLiveSmokeBudget } from "../../../../scripts/live-smoke-budget.mjs";

const root = process.argv.find((value) => value.startsWith("--validation-root="))?.slice("--validation-root=".length);
const probeOnly = process.argv.includes("--check-only");
const grantId = "2026-10-01-user-approved-third-6-synthetic-bailian-requests";
const requestLimit = 6;
// This grant covers only these three synthetic screening cases, including any bounded format repair.
const caseIds = ["image-risk-with-ordinary-text", "audio-only-risk", "video-only-risk"];
const selectedCases = process.argv.find((value) => value.startsWith("--cases="))?.slice("--cases=".length).split(",") ?? caseIds;
const emit = (value: object) => process.stdout.write(`${JSON.stringify(value)}\n`);
const SAFE_CODES = new Set(["LIVE_SMOKE_BUDGET_INVALID", "LIVE_SMOKE_REQUEST_LIMIT", "LIVE_SMOKE_SOURCE_INVALID",
  "LIVE_SMOKE_CONFIG_CHANGED", "LIVE_SMOKE_CREDENTIAL_UNAVAILABLE", "LIVE_SMOKE_ENDPOINT_BLOCKED",
  "LIVE_SMOKE_SYNTHETIC_ASSET_ONLY", "LIVE_SMOKE_NOT_AUTHORIZED", "LIVE_SMOKE_PROFILE_NOT_ISOLATED",
  "WORKSPACE_KEY_UNAVAILABLE", "INSECURE_KEY_BACKEND", "AGENT_MODEL_UNAVAILABLE", "AGENT_TOOL_FAILED",
  "SCREENING_FAILED", "LLM_AUTHENTICATION_FAILED", "LLM_CONFIGURATION_CHANGED", "MODALITY_UNAVAILABLE"]);
const safeCode = (cause: unknown) => {
  if (cause instanceof Error && "code" in cause && cause.code === "WORKSPACE_KEY_UNAVAILABLE") {
    if (cause.message === "The operating system key store is unavailable.") return "OS_KEY_BACKEND_UNAVAILABLE";
    if (cause.message === "The workspace key cannot be unlocked on this account.") return "OS_PROTECTED_ENVELOPE_UNAVAILABLE";
  }
  const candidate = cause instanceof Error && "code" in cause ? String(cause.code) : cause instanceof Error ? cause.message : "";
  return SAFE_CODES.has(candidate) ? candidate : "LIVE_SMOKE_FAILED";
};
function regularFile(path: string, maxBytes: number): Buffer {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw new Error("LIVE_SMOKE_SOURCE_INVALID");
  return readFileSync(path);
}

/** Only sealed credentials/configuration are read. No diary, report, attachment or job queries. */
async function configuredCredential() {
  const state = z.object({ recentWorkspacePath: z.string().refine(isAbsolute) }).parse(JSON.parse(regularFile(
    "/Users/cengjiada/Library/Application Support/Grudge Vault 测试版/state.json", 1024 * 1024).toString()));
  const workspaceInfo = lstatSync(state.recentWorkspacePath);
  if (!workspaceInfo.isDirectory() || workspaceInfo.isSymbolicLink()) throw new Error("LIVE_SMOKE_SOURCE_INVALID");
  const configPath = join(state.recentWorkspacePath, "workspace.json");
  const configBytes = regularFile(configPath, 1024 * 1024);
  const configuration = z.object({ id: z.string().uuid(), crypto: z.object({
    keys: z.array(z.object({ envelope: z.string().min(1) })).min(1).max(10)
  }) }).parse(JSON.parse(configBytes.toString()));
  const databasePath = join(state.recentWorkspacePath, "db/grudge-vault.sqlite3");
  const databaseInfo = lstatSync(databasePath);
  if (!databaseInfo.isFile() || databaseInfo.isSymbolicLink()) throw new Error("LIVE_SMOKE_SOURCE_INVALID");
  const database = new DatabaseSync(databasePath, { readOnly: true });
  database.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000;");
  try {
    const selection = z.object({ model: z.literal("qwen3.8-omni-flash"), region: z.enum(["cn-beijing", "ap-southeast-1", "us-east-1", "cn-hongkong"]),
      workspace_id: z.string().regex(/^[A-Za-z0-9-]{1,63}$/).nullable(), status: z.literal("ready"), last_tested_at: z.string().nullable()
    }).parse(database.prepare("SELECT model,region,workspace_id,status,last_tested_at FROM llm_provider_settings WHERE provider='bailian'").get());
    const active = database.prepare("SELECT active_provider FROM llm_settings WHERE singleton=1").get();
    if (active?.active_provider !== "bailian") throw new Error("LIVE_SMOKE_CONFIG_CHANGED");
    const credentialRow = database.prepare("SELECT envelope_json FROM llm_provider_credentials WHERE provider='bailian'").get();
    if (typeof credentialRow?.envelope_json !== "string") throw new Error("LIVE_SMOKE_CREDENTIAL_UNAVAILABLE");
    const credential = z.object({ algorithm: z.literal("aes-256-gcm"), version: z.literal(1), iv: z.string(), authTag: z.string(), ciphertext: z.string() })
      .parse(JSON.parse(credentialRow.envelope_json));
    const protector = new SafeStorageKeyProtector();
    await protector.assertAvailable();
    emit({ phase: "system-protection-ready" });
    let apiKey: string | undefined;
    for (const slot of configuration.crypto.keys) {
      const { key } = await protector.unprotect(slot.envelope);
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(credential.iv, "base64"));
        decipher.setAAD(Buffer.from(`grudge-vault:llm:${configuration.id}:bailian:v1`));
        decipher.setAuthTag(Buffer.from(credential.authTag, "base64"));
        apiKey = Buffer.concat([decipher.update(Buffer.from(credential.ciphertext, "base64")), decipher.final()]).toString();
      } catch { /* Match the application's retained-key-ring policy, never fall back to plaintext. */ }
      finally { key.fill(0); }
      if (apiKey) break;
    }
    if (!apiKey) throw new Error("LIVE_SMOKE_CREDENTIAL_UNAVAILABLE");
    const selected = JSON.stringify(selection), sealed = credentialRow.envelope_json;
    const assertCurrent = () => {
      if (!regularFile(configPath, 1024 * 1024).equals(configBytes) ||
        database.prepare("SELECT active_provider FROM llm_settings WHERE singleton=1").get()?.active_provider !== "bailian" ||
        JSON.stringify(database.prepare("SELECT model,region,workspace_id,status,last_tested_at FROM llm_provider_settings WHERE provider='bailian'").get()) !== selected ||
        database.prepare("SELECT envelope_json FROM llm_provider_credentials WHERE provider='bailian'").get()?.envelope_json !== sealed) {
        throw new Error("LIVE_SMOKE_CONFIG_CHANGED");
      }
    };
    return { apiKey, model: selection.model, region: selection.region as BailianRegion,
      workspaceId: selection.workspace_id ?? undefined, lastTestedAt: selection.last_tested_at ?? undefined,
      assertCurrent, close: () => database.close() };
  } catch (cause) { database.close(); throw cause; }
}

async function run() {
  if (!process.argv.includes("--authorized-live") || !root || !isAbsolute(root) ||
    resolve(root) !== root || !root.startsWith("/private/tmp/grudge-vault-live-smoke-")) throw new Error("LIVE_SMOKE_NOT_AUTHORIZED");
  if (selectedCases && (!selectedCases.length || new Set(selectedCases).size !== selectedCases.length ||
    selectedCases.some((id) => !caseIds.includes(id)))) throw new Error("LIVE_SMOKE_SOURCE_INVALID");
  const profile = join(root, "profile");
  if (app.getPath("userData") !== profile) throw new Error("LIVE_SMOKE_PROFILE_NOT_ISOLATED");
  const budget = openLiveSmokeBudget(root, grantId, requestLimit);
  const runStart = budget.used;
  let credential: Awaited<ReturnType<typeof configuredCredential>> | undefined;
  try {
    if (!probeOnly && budget.used >= requestLimit) throw new Error("LIVE_SMOKE_REQUEST_LIMIT");
    emit({ phase: "unlocking-config", used: budget.used, limit: requestLimit });
    credential = await configuredCredential();
    credential.assertCurrent();
    emit({ phase: "credential-ready", model: credential.model, region: credential.region, used: budget.used, limit: requestLimit });
    if (probeOnly) return;
    const context = credential;
    const endpoint = `${resolveLlmProviderEndpoint("bailian", context.region, context.workspaceId).replace(/\/$/, "")}/chat/completions`;
    const nativeFetch = globalThis.fetch;
    const guardedFetch: typeof globalThis.fetch = async (url, options) => {
      context.assertCurrent();
      if (String(url) !== endpoint || options?.method !== "POST" || typeof options.body !== "string" ||
        JSON.parse(options.body).model !== context.model) throw new Error("LIVE_SMOKE_ENDPOINT_BLOCKED");
      const request = budget.reserve();
      emit({ phase: "request-started", request, limit: requestLimit });
      const response = await nativeFetch(url, { ...options, redirect: "error" });
      emit({ phase: "request-responded", request, status: response.status });
      return response;
    };
    // All model traffic goes through this guard; no real catalogue, vector or legal-search side channel.
    globalThis.fetch = guardedFetch;
    const model = new OpenAiCompatibleChatAdapter(guardedFetch, 120_000);
    // Counts only: distinguish schema errors/repeated submissions without retaining model arguments or text.
    const diagnostics = { toolCalls: 0, unknownTools: 0, invalidSchemas: 0, repeatedSubmissions: 0, streamingResponses: 0,
      invalidToolArguments: 0, structuredBatchRejected: 0, otherToolFailures: 0,
      truncatedResponses: 0, incompleteStreams: 0, invalidResponses: 0, responseTimeouts: 0, otherModelFailures: 0,
      missingMediaCoverage: 0, sourceOrMediaMismatch: 0, invalidAnchorRanges: 0, otherSchemaIssues: 0 };
    const observedModel: AgentModelAdapterPort = {
      identity: model.identity, version: model.version,
      async run(input) {
        let submissions = 0;
        let value;
        try { value = await model.run({ ...input, executeTool: async (name, raw, id) => {
          diagnostics.toolCalls += 1;
          submissions += 1;
          if (submissions > 1) diagnostics.repeatedSubmissions += 1;
          const tool = input.tools.find((tool) => tool.name === name);
          if (!tool) diagnostics.unknownTools += 1;
          else {
            const parsed = tool.schema.safeParse(raw);
            if (!parsed.success) {
              diagnostics.invalidSchemas += 1;
              for (const issue of parsed.error.issues) {
                if (issue.message === "Complete media coverage requires an anchor for every examined media input.") diagnostics.missingMediaCoverage += 1;
                else if (issue.message === "Use only this input's sourceVersion and media references." ||
                  issue.path[0] === "anchors" && ["sourceVersion", "temporaryMediaRef"].includes(String(issue.path.at(-1)))) diagnostics.sourceOrMediaMismatch += 1;
                else if (issue.message === "Return a valid source range; do not invent an unavailable position.") diagnostics.invalidAnchorRanges += 1;
                else diagnostics.otherSchemaIssues += 1;
              }
            }
          }
          return input.executeTool(name, raw, id);
        } }); } catch (cause) {
          // Fixed categories only; never emit arbitrary messages or raw model output.
          if (cause instanceof Error && "code" in cause && cause.code === "AGENT_TOOL_FAILED") {
            if (cause.message === "The model returned invalid tool arguments.") diagnostics.invalidToolArguments += 1;
            else if (cause.message === "The model must return exactly the registered structured submission.") diagnostics.structuredBatchRejected += 1;
            else diagnostics.otherToolFailures += 1;
          } else if (cause instanceof Error && "code" in cause && cause.code === "AGENT_MODEL_UNAVAILABLE") {
            if (cause.message === "The model stream ended before producing a complete response (length).") diagnostics.truncatedResponses += 1;
            else if (cause.message === "The model stream ended before its completion marker.") diagnostics.incompleteStreams += 1;
            else if (["The model endpoint returned an invalid streaming event.",
              "The model endpoint returned an invalid Chat Completions response."].includes(cause.message)) diagnostics.invalidResponses += 1;
            else if (["The configured model response timed out.", "The configured model request timed out."].includes(cause.message)) diagnostics.responseTimeouts += 1;
            else diagnostics.otherModelFailures += 1;
          }
          throw cause;
        }
        if (value.streaming) diagnostics.streamingResponses += 1;
        return value;
      }
    };
    const syntheticWorkspaceId = randomUUID();
    const settings: LlmSettings = { activeProvider: "bailian", providers: { bailian: {
      provider: "bailian", model: context.model, region: context.region, status: "ready", credentialConfigured: true,
      ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
      ...(context.lastTestedAt ? { lastTestedAt: context.lastTestedAt } : {})
    } } };
    const audio = regularFile(join(root, "padded-verified-danger.wav"), 7_000_000);
    const video = regularFile(join(root, "danger.mp4"), 7_000_000);
    const canvas = new BrowserWindow({ show: false, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
    let image: Buffer;
    try {
      await canvas.loadURL("data:text/html,<html><body></body></html>");
      const encoded = await canvas.webContents.executeJavaScript(`(() => {
        const c=document.createElement('canvas');c.width=800;c.height=400;const p=c.getContext('2d');
        p.fillStyle='#fff';p.fillRect(0,0,800,400);p.fillStyle='#111';p.font='bold 38px sans-serif';
        p.fillText('邻居给我的消息',30,80);p.fillStyle='#900';p.font='bold 46px sans-serif';
        p.fillText('你再回来，我就打断你的腿！',30,180);return c.toDataURL('image/png').split(',')[1];
      })()`);
      image = Buffer.from(String(encoded), "base64");
    } finally { canvas.destroy(); }
    const assetId = randomUUID();
    const facade = {
      getWorkspaceStatus: () => ({ status: "open", workspace: { id: syntheticWorkspaceId } }),
      getLlmSettings: () => settings,
      getLlmCredential: () => context.apiKey,
      beginLlmOperation: () => context.assertCurrent,
      markLlmModalityVerified: () => {}, // Do not mark capabilities or change settings in the user's workspace.
      previewAsset: async (id: string) => {
        if (id !== assetId) throw new Error("LIVE_SMOKE_SYNTHETIC_ASSET_ONLY");
        return { bytes: audio, mimeType: "audio/wav", representation: "original" };
      },
      getDefaultLegalJurisdiction: () => "中国大陆"
    } as unknown as GrudgeVaultApplication;
    const harness = new AgentHarness(facade, { modelAdapter: observedModel });
    const results: Array<object> = [];
    const step = async (id: string, perform: () => Promise<object>) => {
      if (selectedCases && !selectedCases.includes(id)) return;
      if (budget.used >= requestLimit) { const result = { id, completed: false, code: "LIVE_SMOKE_REQUEST_LIMIT" }; results.push(result); emit(result); return; }
      const before = budget.used, started = Date.now();
      const previousDiagnostics = { ...diagnostics };
      const observed = () => Object.fromEntries(Object.entries(diagnostics)
        .map(([key, count]) => [key, count - previousDiagnostics[key as keyof typeof diagnostics]]));
      emit({ phase: "case-started", id });
      try {
        const value = await perform();
        const result = { id, completed: true, ...value, requests: budget.used - before, elapsedMs: Date.now() - started, diagnostics: observed() };
        results.push(result); emit(result);
      } catch (cause) {
        const result = { id, completed: false, code: safeCode(cause), requests: budget.used - before, elapsedMs: Date.now() - started, diagnostics: observed() };
        results.push(result); emit(result);
      }
      writeFileSync(join(root, `safe-results-${runStart}.json`), JSON.stringify({ used: budget.used, limit: requestLimit, model: context.model,
        region: context.region, results, releaseGatePassed: false }), { mode: 0o600 });
    };
    const screen = (id: string, text: string, expected: "skip" | "review" | "not-skip", bytes?: Buffer, kind?: "image" | "audio" | "video") => step(id, async () => {
      const input: ScreeningInput = { text, origin: "manual", sourceVersion: `synthetic-${id}`, media: bytes && kind ? [{
        id: randomUUID(), fileName: `synthetic.${kind === "image" ? "png" : kind === "audio" ? "wav" : "mp4"}`,
        mimeType: kind === "image" ? "image/png" : kind === "audio" ? "audio/wav" : "video/mp4", byteSize: bytes.length, kind, bytes
      }] : [] };
      const value = await harness.screen(input);
      return { decision: value.decision, coverage: value.coverage,
        mediaAnchorReturned: !bytes || value.anchors.some(({ temporaryMediaRef }) => temporaryMediaRef === input.media[0]!.id),
        sourceVersionRetained: value.anchors.every((anchor) => anchor.sourceVersion === input.sourceVersion),
        timedMediaAnchorReturned: !bytes || kind === "image" || value.anchors.some((anchor) => anchor.temporaryMediaRef === input.media[0]!.id &&
          (anchor.intervalMs && anchor.intervalMs[0] <= anchor.intervalMs[1] && anchor.intervalMs[1] <= 4_000 ||
            anchor.frameTimeMs !== undefined && anchor.frameTimeMs <= 4_000)),
        expectedRouteObserved: expected === "not-skip" ? value.decision !== "skip" : value.decision === expected };
    });
    await screen("text-ordinary", "午饭后散步，下午工作顺利。", "skip");
    await screen("text-danger", "邻居堵在门口对我说，今晚就要打断我的腿，我很害怕。", "not-skip");
    await screen("image-risk-with-ordinary-text", "今天正常回家。", "not-skip", image, "image");
    await screen("audio-only-risk", "", "not-skip", audio, "audio");
    await screen("video-only-risk", "", "not-skip", video, "video");
    await step("audio-report", async () => {
      const now = "2026-10-01T00:00:00.000Z", recordId = randomUUID();
      const input: ReportAnalysisInput = {
        record: { id: recordId, origin: "manual", categories: ["danger"], title: "录音里的威胁", summary: "", revision: 1,
          occurredAt: { kind: "unknown" }, recordedAt: now, reportState: "queued", sourceUpdated: false,
          sourceReviewRequired: false, attachmentCount: 1, createdAt: now, updatedAt: now },
        source: { id: randomUUID(), recordId, origin: "manual", sourceVersion: "synthetic-audio-report", contentHash: "a".repeat(64),
          text: "请整理录音中的威胁。地点和发生日期尚未提供。", recordedAt: now, createdAt: now },
        attachments: [{ id: assetId, originalFileName: "synthetic.wav", mimeType: "audio/wav", byteSize: audio.length } as ReportAnalysisInput["attachments"][number]], overrides: []
      };
      const result = await harness.analyze(input);
      return { reportState: result.state, unknownTimeRetained: !result.content.time.value,
        unknownLocationRetained: !result.content.location.value,
        timedMediaAnchorReturned: [...result.content.chronology, ...result.content.mediaSegments ?? []].some(({ anchor }) =>
          anchor?.assetId === assetId && Boolean(anchor.intervalMs)), coverageNotes: result.content.coverageNotes.length };
    });
    await step("audio-query-description", async () => {
      const description = new BailianNativeMediaQueryAdapter(() => ({ apiKey: context.apiKey, region: context.region,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}) }), observedModel);
      const id = randomUUID();
      const value = await description.describe([{ id, modality: "audio", mimeType: "audio/wav", bytes: audio }]);
      const descriptionText = value[0]?.text ?? "";
      return { returnedMatchingId: value.length === 1 && value[0]?.id === id, riskSpeechMentioned: /伤害|威胁/.test(descriptionText),
        syntheticUtteranceTranscribed: descriptionText.replace(/[^\p{L}\p{N}]/gu, "").includes("我要伤害你") };
    });
    await screen("text-negation", "今天没有发生争执，电影里的人被威胁了，那不是我的经历。", "skip");
    await screen("text-ambiguous", "他又这样说了，我有些不安。", "review");
    await screen("text-rights", "公司承诺的项目奖金一直没有支付，我已经催了三次。", "not-skip");
    emit({ phase: "finished", used: budget.used, limit: requestLimit, cases: results.length, releaseGatePassed: false });
  } finally { credential?.close(); budget.close(); }
}

app.enableSandbox();
// Destroying the synthetic canvas must not end an in-flight model request.
app.on("window-all-closed", () => {});
void app.whenReady().then(run).then(() => app.exit(0)).catch((cause) => {
  emit({ phase: "stopped", code: safeCode(cause) }); app.exit(1);
});
