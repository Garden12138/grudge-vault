import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  llmProviderHeaders,
  parseConservativeTemporalValue,
  resolveLlmProviderEndpoint,
  type GrudgeVaultApplication
} from "@grudge-vault/application";
import type {
  AgentAction,
  AgentCitation,
  AgentDataCategory,
  AgentIntent,
  AgentModelCallAudit,
  AgentModelSettings,
  AgentRun,
  AgentToolCall,
  BailianRegion,
  Case,
  EvidenceDetail,
  Event,
  ExternalContextDisclosure,
  GroundedAgentClaim,
  LlmModelOption,
  LlmModelCompatibility,
  LlmModelCompatibilityReason,
  LlmModelModality,
  LlmProvider,
  LlmSettings,
  Message,
  SourceReferenceDetail,
  StrategyAnalysis,
  StrategyOption,
  UnifiedSearchHit
} from "@grudge-vault/domain";
import {
  AppError,
  type AgentSendInput,
  type AgentSendResult,
  type AgentSettingsUpdateInput,
  type CreateCaseInput,
  type EventWriteFields,
  type LlmConnectInput,
  type LlmListModelsInput,
  type UpdateCaseInput,
  type UpdateEventInput
} from "@grudge-vault/shared";

export const AGENT_TOOL_SCHEMA_VERSION = 3;
export const AGENT_RESPONSE_VERSION = 1;
export const AGENT_REDACTION_POLICY_VERSION = 1;
export const MAX_AGENT_MODEL_ROUNDS = 4;
export const MAX_AGENT_TOOL_CALLS = 8;
export const MAX_AGENT_CONTEXT_BYTES = 64 * 1024;
export const MAX_AGENT_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_MODEL_CATALOG_RESPONSE_BYTES = 16 * 1024 * 1024;

const idSchema = z.string().trim().min(1).max(200);
const textSchema = z.string().trim().min(1).max(20_000);

export interface RegisteredAgentTool {
  name: string;
  version: number;
  description: string;
  intents: AgentIntent[];
  write: boolean;
  schema: z.ZodType;
  jsonSchema: Record<string, unknown>;
}

export class AgentToolRegistry {
  private readonly tools = new Map<string, RegisteredAgentTool>();

  register(input: Omit<RegisteredAgentTool, "jsonSchema">): void {
    if (this.tools.has(input.name)) throw new Error(`Agent tool ${input.name} is already registered.`);
    this.tools.set(input.name, { ...input, jsonSchema: z.toJSONSchema(input.schema) as Record<string, unknown> });
  }

  definitions(intent: AgentIntent): RegisteredAgentTool[] {
    return [...this.tools.values()].filter(({ intents }) => intents.includes(intent));
  }

  parse(intent: AgentIntent, name: string, value: unknown): { tool: RegisteredAgentTool; input: unknown } {
    const tool = this.tools.get(name);
    if (!tool || !tool.intents.includes(intent)) {
      throw new AppError("AGENT_TOOL_FAILED", `Tool ${name} is not available for this Agent intent.`);
    }
    const result = tool.schema.safeParse(value);
    if (!result.success) throw new AppError("AGENT_TOOL_FAILED", `Tool ${name} received invalid arguments.`);
    return { tool, input: result.data };
  }
}

export function createDefaultAgentToolRegistry(): AgentToolRegistry {
  const registry = new AgentToolRegistry();
  const add = (name: string, description: string, intents: AgentIntent[], write: boolean, schema: z.ZodType) =>
    registry.register({ name, version: AGENT_TOOL_SCHEMA_VERSION, description, intents, write, schema });
  add("record_source", "Confirm that the current conversation message is preserved as a local source.", ["record"], false, z.object({}));
  add("propose_event", "Propose a candidate Event for user approval.", ["record"], true, z.object({
    title: z.string().trim().min(1).max(120), narrative: textSchema,
    occurredAtText: z.string().trim().max(200).optional()
  }));
  add("update_event", "Propose a revision to an existing Event for user approval.", ["record", "clarify"], true, z.object({
    eventRef: idSchema, expectedRevision: z.number().int().positive(),
    narrative: z.string().trim().max(100_000).optional(), fact: z.string().trim().max(10_000).optional()
  }));
  add("answer_clarification", "Propose an answer to an open Clarification.", ["clarify"], true, z.object({
    clarificationRef: idSchema, expectedRevision: z.number().int().positive(), answer: textSchema
  }));
  add("add_asset", "Propose linking an existing Asset to an Event.", ["record"], true, z.object({
    eventRef: idSchema, assetRef: idSchema, expectedRevision: z.number().int().positive()
  }));
  add("search_events", "Search Event and Source memory.", ["retrieve", "review", "strategy"], false, z.object({ query: textSchema }));
  add("get_event", "Read one Event and its structured fields.", ["retrieve", "review", "strategy", "clarify"], false,
    z.object({ eventRef: idSchema }));
  add("get_sources", "Read bounded excerpts for known Source references.", ["retrieve", "review", "strategy"], false,
    z.object({ sourceRefs: z.array(idSchema).min(1).max(8) }));
  add("get_person_history", "Read the timeline for one canonical Person.", ["retrieve", "review", "strategy"], false,
    z.object({ personRef: idSchema }));
  add("find_related_events", "Read accepted and suggested relations for an Event.", ["retrieve", "review", "strategy"], false,
    z.object({ eventRef: idSchema }));
  add("build_timeline", "Build a filtered local Event timeline.", ["review", "strategy"], false, z.object({
    from: z.iso.date().optional(), to: z.iso.date().optional(), personRef: idSchema.optional()
  }));
  add("list_clarifications", "List open Clarifications.", ["clarify", "review", "strategy"], false,
    z.object({ eventRef: idSchema.optional() }));
  add("summarize_period", "Generate a deterministic, source-linked period Review.", ["review", "strategy"], false,
    z.object({ from: z.iso.date(), to: z.iso.date() }));
  add("analyze_event", "Build a fact/unknown/interpretation/interest analysis from local memory.", ["strategy"], false,
    z.object({ eventRefs: z.array(idSchema).min(1).max(8) }));
  add("compare_options", "Validate a structured set of possible actions without choosing for the user.", ["strategy"], false,
    z.object({ options: z.array(z.object({ title: z.string().trim().min(1).max(120), description: textSchema })).min(2).max(6) }));
  add("create_action_plan", "Create a reversible sequence of proposed next steps.", ["strategy"], false,
    z.object({ steps: z.array(z.string().trim().min(1).max(500)).min(1).max(10) }));
  add("get_evidence", "Read one known Evidence item without exposing original bytes.", ["evidence", "retrieve"], false,
    z.object({ evidenceRef: idSchema }));
  add("get_case", "Read one known Case and its current revision.", ["evidence", "retrieve", "review", "strategy"], false,
    z.object({ caseRef: idSchema }));
  add("build_case_timeline", "Build the current Event projection for a known Case.", ["evidence", "review", "strategy"], false,
    z.object({ caseRef: idSchema }));
  add("list_case_gaps", "List questions and material gaps for a known Case.", ["evidence", "review", "strategy"], false,
    z.object({ caseRef: idSchema }));
  add("create_case", "Propose a new draft Case for explicit user approval.", ["evidence"], true,
    z.object({ title: z.string().trim().min(1).max(200), jurisdiction: z.string().trim().min(1).max(500), asOfDate: z.iso.date(), summary: z.string().trim().max(20_000).optional() }));
  add("update_case", "Propose a revision to a known Case for explicit user approval.", ["evidence"], true,
    z.object({ caseRef: idSchema, expectedRevision: z.number().int().positive(), summary: z.string().trim().max(20_000) }));
  add("prepare_case_bundle", "Request a user-controlled Case Binder preview; never exports files.", ["evidence"], false,
    z.object({ caseRef: idSchema }));
  return registry;
}

export function exportAgentToolSchemasV3(intent?: AgentIntent): Array<{
  name: string;
  version: 3;
  description: string;
  intents: AgentIntent[];
  write: boolean;
  schema: Record<string, unknown>;
}> {
  const registry = createDefaultAgentToolRegistry();
  const tools = intent ? registry.definitions(intent) : (["record", "retrieve", "review", "clarify", "strategy", "evidence"] as const)
    .flatMap((value) => registry.definitions(value))
    .filter((tool, index, all) => all.findIndex(({ name }) => name === tool.name) === index);
  return tools.map(({ name, description, intents, write, jsonSchema }) => ({
    name, version: 3, description, intents, write, schema: jsonSchema
  }));
}

/** @deprecated Consumers should advertise the v3 registry. */
export const exportAgentToolSchemasV2 = exportAgentToolSchemasV3;
/** @deprecated Consumers should advertise the v3 registry. */
export const exportAgentToolSchemasV1 = exportAgentToolSchemasV3;

export function routeAgentIntent(content: string): AgentIntent {
  const text = content.normalize("NFKC").toLocaleLowerCase("en-US");
  if (/补全|澄清|回答.*问题|clarif|fill.*gap|answer.*question/.test(text)) return "clarify";
  if (/证据|原件|材料缺口|案卷|案件|case\b|evidence|binder/.test(text)) return "evidence";
  if (/复盘|回顾|月度|季度|这一年|timeline|review|summar/.test(text)) return "review";
  if (/策略|怎么办|行动|选项|风险|利弊|归属|strategy|option|risk|what should/.test(text)) return "strategy";
  if (/^(?:请)?(?:记录|记下)|^record\b|保存.*事件|发生了|remember|save.*event/.test(text)) return "record";
  if (/查找|检索|查询|历史|retrieve|search|find|history/.test(text)) return "retrieve";
  return "retrieve";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactExternalText(content: string, personNames: string[] = []): string {
  let output = content;
  personNames.sort((a, b) => b.length - a.length).forEach((name, index) => {
    if (name.trim()) output = output.replace(new RegExp(escapeRegExp(name), "giu"), `Person-${index + 1}`);
  });
  return output
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, "[phone-or-account]")
    .replace(/(?:[A-Za-z]:[\\/]|\/Users\/|\/home\/)[^\s]+/g, "[local-path]")
    .replace(/\b[^\s/\\]+\.(?:pdf|docx?|xlsx?|pptx?|jpe?g|png|gif|webp|heic|mp3|m4a|wav|mp4|mov|zip|json|txt|md)\b/giu,
      "[file-name]")
    .replace(/\b\d{8,}\b/g, "[account]");
}

function truncateUtf8(value: string, byteLimit: number): string {
  if (Buffer.byteLength(value, "utf8") <= byteLimit) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= byteLimit) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

const chatCompletionSchema = z.object({
  model: z.string().optional(),
  choices: z.array(z.object({ message: z.object({
    role: z.literal("assistant"), content: z.string().nullable().optional(),
    tool_calls: z.array(z.object({
      id: z.string(), type: z.literal("function"), function: z.object({ name: z.string(), arguments: z.string() })
    })).optional()
  }) })).min(1),
  usage: z.object({ prompt_tokens: z.number().int().nonnegative().optional(), completion_tokens: z.number().int().nonnegative().optional() }).optional()
});

export interface AgentModelAdapterRequest {
  baseUrl: string;
  model: string;
  apiKey?: string;
  extraHeaders?: Record<string, string>;
  system: string;
  user: string;
  tools: RegisteredAgentTool[];
  executeTool(name: string, input: unknown, providerCallId: string): Promise<unknown>;
}

export interface AgentModelConnectionRequest {
  baseUrl: string;
  model: string;
  apiKey: string;
  extraHeaders?: Record<string, string>;
}

export interface AgentModelCatalogItem {
  id: string;
  name?: string;
  supportedParameters?: string[];
  inputModalities?: string[];
  outputModalities?: string[];
  capabilities?: string[];
  features?: string[];
  pricing?: { prompt?: string; completion?: string };
}

export interface AgentModelCatalogRequest extends Omit<AgentModelConnectionRequest, "model"> {
  query?: globalThis.URLSearchParams;
  catalogUrl?: string;
  catalogFormat?: "openai" | "bailian";
}

export interface AgentModelAdapterResult {
  text?: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
}

export interface AgentModelAdapterPort {
  readonly identity: string;
  readonly version: number;
  run(input: AgentModelAdapterRequest): Promise<AgentModelAdapterResult>;
  testConnection?(input: AgentModelConnectionRequest): Promise<void>;
  listModels?(input: AgentModelCatalogRequest): Promise<AgentModelCatalogItem[]>;
}

type FetchResponse = Awaited<ReturnType<typeof globalThis.fetch>>;

async function readBoundedResponse(response: FetchResponse, byteLimit = MAX_AGENT_RESPONSE_BYTES): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > byteLimit) {
    throw new AppError("AGENT_MODEL_UNAVAILABLE", "The model response exceeded the local safety limit.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > byteLimit) {
        await reader.cancel();
        throw new AppError("AGENT_MODEL_UNAVAILABLE", "The model response exceeded the local safety limit.");
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new globalThis.TextDecoder().decode(bytes);
}

function modelHttpError(status: number): AppError {
  if (status === 401 || status === 403) {
    return new AppError("LLM_AUTHENTICATION_FAILED", "The API key was rejected by the model service.");
  }
  if (status === 404) return new AppError("LLM_MODEL_NOT_FOUND", "The selected model is not available in this account or region.");
  if (status === 410) return new AppError("LLM_MODEL_NOT_FOUND", "The selected model is no longer available from this provider.");
  if (status === 429) return new AppError("LLM_RATE_LIMITED", "The model service is temporarily rate limited.", true);
  return new AppError("AGENT_MODEL_UNAVAILABLE", `The model service returned HTTP ${status}.`, status >= 500);
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === "AbortError";
}

function safeTransportCode(cause: unknown): string | undefined {
  let current = cause;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (current instanceof Error) {
      const chromiumCode = current.message.match(/(?:net::)?(ERR_[A-Z0-9_]+)/)?.[1];
      if (chromiumCode) return chromiumCode;
      current = current.cause;
      continue;
    }
    if (typeof current === "object") {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,80}$/.test(code)) return code;
      current = (current as { cause?: unknown }).cause;
      continue;
    }
    break;
  }
  return undefined;
}

function unreachableMessage(cause: unknown, fallback: string): string {
  const code = safeTransportCode(cause);
  return code ? `${fallback} (${code})` : fallback;
}

async function resolvePendingChatCompletion(
  fetcher: typeof globalThis.fetch,
  response: FetchResponse,
  baseUrl: string,
  headers: Record<string, string>,
  signal: AbortSignal
): Promise<FetchResponse> {
  if (response.status !== 202) return response;
  const pendingBody = await readBoundedResponse(response);
  let bodyRequestId: string | undefined;
  try {
    const parsed = JSON.parse(pendingBody) as { requestId?: unknown; request_id?: unknown };
    const candidate = parsed.requestId ?? parsed.request_id;
    if (typeof candidate === "string") bodyRequestId = candidate;
  } catch {
    // Some NVIDIA deployments return the request id only in the response header.
  }
  const requestId = response.headers.get("nvcf-reqid") ?? bodyRequestId;
  if (!requestId || !/^[A-Za-z0-9_-]{1,200}$/.test(requestId)) {
    throw new AppError("AGENT_MODEL_UNAVAILABLE", "The model service returned a pending response without a request id.", true);
  }
  let current = response;
  while (current.status === 202) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (signal.aborted) throw signal.reason;
    current = await fetcher(`${baseUrl.replace(/\/$/, "")}/status/${encodeURIComponent(requestId)}`, {
      method: "GET", redirect: "error", signal, headers
    });
    if (current.status === 202) await readBoundedResponse(current);
  }
  return current;
}

function modelRequestTuning(model: string): Record<string, unknown> {
  // Keep DeepSeek V4 in its non-thinking mode so the app's bounded tool loop
  // remains responsive and predictable.
  return model.startsWith("deepseek-ai/deepseek-v4-") ? { reasoning_effort: "none" } : {};
}

export class OpenAiCompatibleChatAdapter implements AgentModelAdapterPort {
  readonly identity = "openai-compatible.chat-completions";
  readonly version = 1;

  constructor(
    private readonly fetcher: typeof globalThis.fetch = globalThis.fetch,
    private readonly requestTimeoutMs = 360_000
  ) {}

  async testConnection(input: AgentModelConnectionRequest): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let response: FetchResponse;
    try {
      const headers = {
        "content-type": "application/json", authorization: `Bearer ${input.apiKey}`,
        ...input.extraHeaders
      };
      response = await this.fetcher(`${input.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST", redirect: "error", signal: controller.signal,
        headers,
        body: JSON.stringify({
          model: input.model,
          messages: [{ role: "user", content: "Reply with OK." }],
          stream: false, max_tokens: 8,
          ...modelRequestTuning(input.model)
        })
      });
      response = await resolvePendingChatCompletion(this.fetcher, response, input.baseUrl, headers, controller.signal);
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      throw new AppError("AGENT_MODEL_UNAVAILABLE", isAbortError(cause)
        ? "The model service connection test timed out."
        : unreachableMessage(cause, "The model service could not be reached."), true, { cause });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) throw modelHttpError(response.status);
    try { chatCompletionSchema.parse(JSON.parse(await readBoundedResponse(response))); }
    catch (cause) {
      if (cause instanceof AppError) throw cause;
      throw new AppError("AGENT_MODEL_UNAVAILABLE", "The selected model did not return a compatible Chat Completions response.", false, { cause });
    }
  }

  async listModels(input: AgentModelCatalogRequest): Promise<AgentModelCatalogItem[]> {
    if (input.catalogFormat === "bailian") return this.listBailianModels(input);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(this.requestTimeoutMs, 20_000));
    let response: FetchResponse;
    const suffix = input.query?.toString();
    try {
      response = await this.fetcher(`${input.catalogUrl ?? `${input.baseUrl.replace(/\/$/, "")}/models`}${suffix ? `?${suffix}` : ""}`, {
        method: "GET", redirect: "error", signal: controller.signal,
        headers: { authorization: `Bearer ${input.apiKey}`, ...input.extraHeaders }
      });
    } catch (cause) {
      throw new AppError("AGENT_MODEL_UNAVAILABLE", unreachableMessage(cause, "The model list could not be loaded."), true, { cause });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) throw modelHttpError(response.status);
    const schema = z.object({ data: z.array(z.object({
      id: z.string().min(1).max(500), name: z.string().max(500).optional(),
      supported_parameters: z.array(z.string()).optional(),
      architecture: z.object({
        input_modalities: z.array(z.string()).optional(), output_modalities: z.array(z.string()).optional()
      }).optional(),
      pricing: z.object({ prompt: z.string().optional(), completion: z.string().optional() }).optional()
    })).max(2_000) });
    try {
      return schema.parse(JSON.parse(await readBoundedResponse(response, MAX_MODEL_CATALOG_RESPONSE_BYTES))).data.map((item) => {
        const pricing = item.pricing ? {
          ...(item.pricing.prompt !== undefined ? { prompt: item.pricing.prompt } : {}),
          ...(item.pricing.completion !== undefined ? { completion: item.pricing.completion } : {})
        } : undefined;
        return {
          id: item.id, ...(item.name ? { name: item.name } : {}),
          ...(item.supported_parameters ? { supportedParameters: item.supported_parameters } : {}),
          ...(item.architecture?.input_modalities ? { inputModalities: item.architecture.input_modalities } : {}),
          ...(item.architecture?.output_modalities ? { outputModalities: item.architecture.output_modalities } : {}),
          ...(pricing && Object.keys(pricing).length ? { pricing } : {})
        };
      });
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      throw new AppError("AGENT_MODEL_UNAVAILABLE", "The model service returned an invalid model list.", false, { cause });
    }
  }

  private async listBailianModels(input: AgentModelCatalogRequest): Promise<AgentModelCatalogItem[]> {
    if (!input.catalogUrl) throw new AppError("AGENT_MODEL_UNAVAILABLE", "The Bailian model catalog URL is missing.");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(this.requestTimeoutMs, 60_000));
    const items: AgentModelCatalogItem[] = [];
    let total: number | undefined;
    try {
      for (let page = 1; total === undefined || items.length < total; page += 1) {
        const query = new globalThis.URLSearchParams({ page_no: String(page), page_size: "100", language: "zh-CN" });
        const response = await this.fetcher(`${input.catalogUrl}?${query}`, {
          method: "GET", redirect: "error", signal: controller.signal,
          headers: { authorization: `Bearer ${input.apiKey}`, ...input.extraHeaders }
        });
        if (!response.ok) throw modelHttpError(response.status);
        const schema = z.object({
          success: z.boolean().optional(),
          output: z.object({
            total: z.number().int().nonnegative().max(100_000), page_no: z.number().int().positive(),
            page_size: z.number().int().positive(),
            models: z.array(z.object({
              model: z.string().min(1).max(500), name: z.string().max(500).optional(),
              capabilities: z.array(z.string()).optional(), features: z.array(z.string()).optional(),
              inference_metadata: z.object({
                request_modality: z.array(z.string()).optional(), response_modality: z.array(z.string()).optional()
              }).optional()
            })).max(1_000)
          })
        });
        const result = schema.parse(JSON.parse(await readBoundedResponse(response, MAX_MODEL_CATALOG_RESPONSE_BYTES)));
        total = result.output.total;
        items.push(...result.output.models.map((item) => ({
          id: item.model, ...(item.name ? { name: item.name } : {}),
          ...(item.capabilities ? { capabilities: item.capabilities } : {}),
          ...(item.features ? { features: item.features } : {}),
          ...(item.inference_metadata?.request_modality
            ? { inputModalities: item.inference_metadata.request_modality } : {}),
          ...(item.inference_metadata?.response_modality
            ? { outputModalities: item.inference_metadata.response_modality } : {})
        })));
        if (result.output.models.length === 0) break;
      }
      return items;
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      throw new AppError("AGENT_MODEL_UNAVAILABLE", isAbortError(cause)
        ? "The Bailian model catalog request timed out."
        : unreachableMessage(cause, "The Bailian model catalog could not be loaded."), true, { cause });
    } finally {
      clearTimeout(timeout);
    }
  }

  async run(input: AgentModelAdapterRequest): Promise<AgentModelAdapterResult> {
    const messages: Array<Record<string, unknown>> = [
      { role: "system", content: input.system }, { role: "user", content: input.user }
    ];
    let toolCalls = 0;
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    let returnedModel = input.model;
    for (let round = 0; round < MAX_AGENT_MODEL_ROUNDS; round += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      let response: FetchResponse;
      try {
        const headers = {
          "content-type": "application/json",
          ...(input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {}),
          ...input.extraHeaders
        };
        response = await this.fetcher(`${input.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST", redirect: "error", signal: controller.signal,
          headers,
          body: JSON.stringify({
            model: input.model, messages, stream: false, tool_choice: "auto",
            max_tokens: 2_048,
            ...modelRequestTuning(input.model),
            tools: input.tools.map((tool) => ({
              type: "function", function: { name: tool.name, description: tool.description, parameters: tool.jsonSchema }
            }))
          })
        });
        response = await resolvePendingChatCompletion(this.fetcher, response, input.baseUrl, headers, controller.signal);
      } catch (cause) {
        if (cause instanceof AppError) throw cause;
        throw new AppError("AGENT_MODEL_UNAVAILABLE", isAbortError(cause)
          ? "The configured model request timed out."
          : unreachableMessage(cause, "The configured model endpoint could not be reached."), true, { cause });
      } finally {
        clearTimeout(timeout);
      }
      if (!response.ok) throw modelHttpError(response.status);
      let value: z.infer<typeof chatCompletionSchema>;
      try {
        value = chatCompletionSchema.parse(JSON.parse(await readBoundedResponse(response)));
      } catch (cause) {
        if (cause instanceof AppError) throw cause;
        throw new AppError("AGENT_MODEL_UNAVAILABLE", "The model endpoint returned an invalid Chat Completions response.", false, { cause });
      }
      returnedModel = value.model ?? returnedModel;
      promptTokens = value.usage?.prompt_tokens ?? promptTokens;
      completionTokens = value.usage?.completion_tokens ?? completionTokens;
      const message = value.choices[0]!.message;
      const calls = (message.tool_calls ?? []) as ChatToolCall[];
      if (calls.length === 0) {
        return {
          model: returnedModel,
          ...(message.content ? { text: message.content } : {}),
          ...(promptTokens !== undefined ? { promptTokens } : {}),
          ...(completionTokens !== undefined ? { completionTokens } : {})
        };
      }
      toolCalls += calls.length;
      if (toolCalls > MAX_AGENT_TOOL_CALLS) throw new AppError("AGENT_TOOL_FAILED", "The model exceeded the Agent tool-call limit.");
      messages.push({ role: "assistant", content: message.content ?? null, tool_calls: calls });
      for (const call of calls) {
        let argumentsValue: unknown;
        try { argumentsValue = JSON.parse(call.function.arguments); }
        catch (cause) { throw new AppError("AGENT_TOOL_FAILED", "The model returned invalid tool arguments.", false, { cause }); }
        const output = await input.executeTool(call.function.name, argumentsValue, call.id);
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(output) });
      }
    }
    throw new AppError("AGENT_TOOL_FAILED", "The model exceeded the Agent round limit.");
  }
}

interface AgentSnapshot {
  context: string;
  contextHash: string;
  categories: AgentDataCategory[];
  categoryCounts: Partial<Record<AgentDataCategory, number>>;
  events: Event[];
  cases: Case[];
  evidence: EvidenceDetail[];
  sources: SourceReferenceDetail[];
  hits: UnifiedSearchHit[];
  citations: AgentCitation[];
  aliases: Map<string, string>;
  personNames: string[];
}

function eventCitation(event: Event): AgentCitation {
  return { id: `citation:event:${event.id}`, kind: "event", targetId: event.id, label: event.title, available: true };
}

function sourceCitation(source: SourceReferenceDetail): AgentCitation {
  const kind = source.kind === "transcript" ? "transcript" : source.kind === "ocr" ? "ocr" : "source";
  const targetId = source.derivedArtifactId ?? source.sourceItemId;
  return {
    id: `citation:source:${targetId}`, kind,
    targetId, label: source.title, excerpt: source.excerpt.slice(0, 240), available: true
  };
}

function claim(
  text: string,
  citationIds: string[],
  kind?: NonNullable<GroundedAgentClaim["kind"]>
): GroundedAgentClaim {
  return { id: randomUUID(), text, citationIds: [...new Set(citationIds)], ...(kind ? { kind } : {}) };
}

function eventClaimCitations(event: Event, citationByTarget: Map<string, AgentCitation>, sourceRefs: string[] = []): string[] {
  const sourceCitations = sourceRefs.map((id) => citationByTarget.get(id)?.id).filter((id): id is string => Boolean(id));
  return sourceCitations.length ? sourceCitations : [citationByTarget.get(event.id)?.id].filter((id): id is string => Boolean(id));
}

function buildDeterministicAnalysis(app: GrudgeVaultApplication, snapshot: AgentSnapshot): StrategyAnalysis {
  const citationByTarget = new Map(snapshot.citations.map((citation) => [citation.targetId, citation]));
  const confirmedFacts: GroundedAgentClaim[] = [];
  const disputedOrUnknown: GroundedAgentClaim[] = [];
  const interpretations: GroundedAgentClaim[] = [];
  const emotions: GroundedAgentClaim[] = [];
  const interests: GroundedAgentClaim[] = [];
  const historicalPatterns: GroundedAgentClaim[] = [];
  const risks: GroundedAgentClaim[] = [];
  const suggestedQuestions: string[] = [];
  for (const event of snapshot.events) {
    for (const item of event.facts) {
      const target = item.kind === "fact.confirmed" ? confirmedFacts : disputedOrUnknown;
      target.push(claim(item.text, eventClaimCitations(event, citationByTarget, item.sourceRefs), item.kind));
    }
    for (const item of event.interpretations) interpretations.push(claim(
      item.text, eventClaimCitations(event, citationByTarget, item.sourceRefs), item.kind
    ));
    for (const item of event.emotions) emotions.push(claim(
      item.label, eventClaimCitations(event, citationByTarget, item.sourceRefs), "emotion"
    ));
    for (const item of event.interests) interests.push(claim(item.description ? `${item.label}: ${item.description}` : item.label,
      eventClaimCitations(event, citationByTarget, item.sourceRefs)));
    const detail = app.getEvent(event.id);
    for (const clarification of detail.clarifications.filter(({ status }) => status === "open")) suggestedQuestions.push(clarification.question);
    if (detail.clarifications.some(({ status }) => status === "open")) {
      risks.push(claim(`事件“${event.title}”仍有待补全信息。`, eventClaimCitations(event, citationByTarget)));
    }
    const relations = app.listEventRelations(event.id).filter(({ status }) => status !== "rejected");
    for (const relation of relations.slice(0, 3)) {
      historicalPatterns.push(claim(
        relation.basis.map(({ label }) => label).join("；") || `存在 ${relation.kind} 关系。`,
        eventClaimCitations(event, citationByTarget, relation.basis.flatMap(({ sourceRefs }) => sourceRefs))
      ));
    }
  }
  const materials = snapshot.sources.map((source) => claim(source.title, [sourceCitation(source).id]));
  const baseCitationIds = snapshot.citations.slice(0, 4).map(({ id }) => id);
  const options: StrategyOption[] = snapshot.events.length ? [
    {
      id: randomUUID(), title: "先补全未知信息", description: "逐项回答待补全问题，再判断后续行动。",
      benefits: ["减少基于缺失信息做决定的风险"], costs: ["需要额外时间核对"], risks: [],
      unknowns: suggestedQuestions.slice(0, 4), reversible: true, citationIds: baseCitationIds
    },
    {
      id: randomUUID(), title: "整理并保留现有来源", description: "先确认相关记录和原始材料仍可访问。",
      benefits: ["提高后续沟通和复盘的可核验性"], costs: ["需要检查来源完整性"],
      risks: ["材料可能仍不足以支持所有解释"], unknowns: [], reversible: true, citationIds: baseCitationIds
    },
    {
      id: randomUUID(), title: "准备一次事实导向的沟通", description: "只使用已确认事实、争议点和明确问题组织沟通。",
      benefits: ["降低事实与判断混写"], costs: ["需要准备并选择合适时机"],
      risks: ["对方反应仍不可预测"], unknowns: ["沟通对象与期望结果需要用户决定"], reversible: true, citationIds: baseCitationIds
    }
  ] : [];
  return {
    confirmedFacts, disputedOrUnknown,
    materials, interpretations, emotions, interests,
    historicalPatterns: [...new Map(historicalPatterns.map((item) => [item.text, item])).values()],
    risks, options,
    actionPlan: snapshot.events.length ? [
      "先打开引用，核对事实、未知项和材料是否完整。",
      ...(suggestedQuestions.length ? ["逐项回答仍然开放的待补全问题。"] : []),
      "比较可逆选项，再由用户选择是否采取行动。"
    ] : [],
    suggestedQuestions: [...new Set(suggestedQuestions)]
  };
}

function deterministicResponse(intent: AgentIntent, snapshot: AgentSnapshot, actions: AgentAction[], english: boolean): string {
  if (english) {
    if (intent === "record") return actions.length ? "I preserved your message and prepared a candidate Event for approval." : "I preserved your message as a local source.";
    if (intent === "clarify" && actions.some(({ status }) => status === "approved")) return "I saved this direct answer to the single clarification that was shown, with your message as its source.";
    if (intent === "evidence") return `I found ${snapshot.cases.length} Case(s) and ${snapshot.evidence.length} Evidence item(s). Binder export remains a user-only action.`;
    if (snapshot.events.length === 0) return "I could not find a matching local Event. I have not filled in any missing details.";
    if (intent === "strategy") return `I found ${snapshot.events.length} grounded Event(s). The analysis separates facts, unknowns, interpretations, risks, and reversible options.`;
    if (intent === "review") return `I found ${snapshot.events.length} Event(s) for this review. Every factual item below links back to local memory.`;
    return `I found ${snapshot.events.length} matching Event(s) with source-linked citations.`;
  }
  if (intent === "record") return actions.length ? "我已保存原始消息，并准备了一条待确认的候选事件。" : "我已将这条消息保存为本地来源。";
  if (intent === "clarify" && actions.some(({ status }) => status === "approved")) return "我已把这条直接回复写入刚才明确展示的单个待补全问题，并保留了原始消息作为依据。";
  if (intent === "evidence") return `找到 ${snapshot.cases.length} 个 Case 和 ${snapshot.evidence.length} 项证据；Binder 导出仍必须由用户点击完成。`;
  if (snapshot.events.length === 0) return "没有找到匹配的本地事件；我没有补造缺失信息。";
  if (intent === "strategy") return `找到 ${snapshot.events.length} 条有依据的事件。下面将事实、未知、解释、风险和可逆行动选项分开呈现。`;
  if (intent === "review") return `找到 ${snapshot.events.length} 条用于本次回顾的事件；下列事实均可跳回本地来源。`;
  return `找到 ${snapshot.events.length} 条匹配事件，并附上可跳转的本地引用。`;
}

export interface AgentHarnessOptions {
  modelAdapter?: AgentModelAdapterPort;
}

const NVIDIA_RECOMMENDED: LlmModelOption[] = [{
  id: "openai/gpt-oss-20b", name: "GPT-OSS 20B",
  recommended: true, toolCapable: true,
  inputModalities: ["text"], outputModalities: ["text"],
  modalitySource: "conservative", compatibility: "compatible"
}];

const BAILIAN_RECOMMENDED: LlmModelOption[] = [
  { id: "qwen3.7-plus", name: "Qwen 3.7 Plus", recommended: true, toolCapable: true,
    inputModalities: ["text"], outputModalities: ["text"], modalitySource: "conservative", compatibility: "compatible" },
  { id: "qwen3.8-flash", name: "Qwen 3.8 Flash", recommended: true, toolCapable: true,
    inputModalities: ["text"], outputModalities: ["text"], modalitySource: "conservative", compatibility: "compatible" },
  { id: "qwen3.8-max", name: "Qwen 3.8 Max", recommended: true, toolCapable: true,
    inputModalities: ["text"], outputModalities: ["text"], modalitySource: "conservative", compatibility: "compatible" }
];

const MODALITIES = new Set<LlmModelModality>(["text", "image", "audio", "video", "embedding"]);

function normalizeModality(value: string): LlmModelModality {
  const normalized = value.trim().toLocaleLowerCase("en-US").replaceAll("_", "-");
  if (MODALITIES.has(normalized as LlmModelModality)) return normalized as LlmModelModality;
  if (/(?:embed|vector)/.test(normalized)) return "embedding";
  return normalized ? "other" : "unknown";
}

function normalizedModalities(values: string[] | undefined): LlmModelModality[] {
  if (!values?.length) return ["unknown"];
  return [...new Set(values.map(normalizeModality))];
}

function incompatible(reason: LlmModelCompatibilityReason): Pick<LlmModelOption, "compatibility" | "compatibilityReason"> {
  return { compatibility: "incompatible", compatibilityReason: reason };
}

function classifyOpenRouterModel(item: AgentModelCatalogItem): LlmModelOption {
  const inputModalities = normalizedModalities(item.inputModalities);
  const outputModalities = normalizedModalities(item.outputModalities);
  const toolCapable = Boolean(item.supportedParameters?.some((value) => value.toLocaleLowerCase("en-US") === "tools"));
  let compatibility: Pick<LlmModelOption, "compatibility" | "compatibilityReason"> = { compatibility: "compatible" };
  if (!inputModalities.includes("text")) compatibility = incompatible("no_text_input");
  else if (!outputModalities.includes("text")) compatibility = incompatible("no_text_output");
  else if (!toolCapable) compatibility = incompatible("no_tool_calling");
  const hint = pricingHint(item);
  return {
    id: item.id, name: item.name ?? item.id, recommended: false, toolCapable,
    inputModalities, outputModalities, modalitySource: "provider", ...compatibility,
    ...(hint ? { pricingHint: hint } : {})
  };
}

function hasNormalizedValue(values: string[] | undefined, pattern: RegExp): boolean {
  return Boolean(values?.some((value) => pattern.test(value.trim().toLocaleLowerCase("en-US"))));
}

function classifyBailianModel(item: AgentModelCatalogItem): LlmModelOption {
  const inputModalities = normalizedModalities(item.inputModalities);
  const outputModalities = normalizedModalities(item.outputModalities);
  const textGeneration = hasNormalizedValue(item.capabilities, /^(?:tg|text[-_ ]?generation|generation|chat)$/);
  const toolCapable = hasNormalizedValue(item.features, /^(?:function[-_ ]?calling|tool[-_ ]?calling|tools)$/);
  let compatibility: Pick<LlmModelOption, "compatibility" | "compatibilityReason"> = { compatibility: "compatible" };
  if (!textGeneration) compatibility = incompatible("non_chat_model");
  else if (!inputModalities.includes("text")) compatibility = incompatible("no_text_input");
  else if (!outputModalities.includes("text")) compatibility = incompatible("no_text_output");
  else if (!toolCapable) compatibility = incompatible("no_tool_calling");
  return {
    id: item.id, name: item.name ?? item.id, recommended: false, toolCapable,
    inputModalities, outputModalities, modalitySource: "provider", ...compatibility
  };
}

function classifyNvidiaModel(item: AgentModelCatalogItem): LlmModelOption {
  const normalizedId = item.id.toLocaleLowerCase("en-US");
  const knownChat = /^(?:openai\/gpt-oss-|deepseek-ai\/deepseek-v4-)/.test(normalizedId);
  const embedding = /(?:^|[/_.-])(?:embed(?:ding|qa)?|retriever|nvclip)(?:$|[/_.-])/.test(normalizedId);
  const nonChat = embedding || /(?:^|[/_.-])(?:rerank(?:er)?|detector|detection|reward|classifier|guard|safety|moderation|parse)(?:$|[/_.-])/.test(normalizedId);
  const visual = /(?:^|[/_.-])(?:vision|vl|fuyu|kosmos|neva|vila|deplot)(?:$|[/_.-])/.test(normalizedId);
  const omni = /(?:^|[/_.-])omni(?:$|[/_.-])/.test(normalizedId);
  if (nonChat) {
    return {
      id: item.id, name: item.name ?? item.id, recommended: false, toolCapable: false,
      inputModalities: visual ? ["text", "image"] : ["text"],
      outputModalities: embedding ? ["embedding"] : ["other"],
      modalitySource: "conservative", ...incompatible("non_chat_model")
    };
  }
  if (knownChat) {
    return {
      id: item.id, name: item.name ?? item.id, recommended: false, toolCapable: true,
      inputModalities: ["text"], outputModalities: ["text"],
      modalitySource: "conservative", compatibility: "compatible"
    };
  }
  if (visual || omni) {
    return {
      id: item.id, name: item.name ?? item.id, recommended: false, toolCapable: true,
      inputModalities: omni ? ["text", "image", "audio", "video"] : ["text", "image"],
      outputModalities: ["text"], modalitySource: "conservative", compatibility: "unknown"
    };
  }
  return {
    id: item.id, name: item.name ?? item.id, recommended: false, toolCapable: true,
    inputModalities: ["unknown"], outputModalities: ["unknown"],
    modalitySource: "unknown", compatibility: "unknown"
  };
}

export function resolveBailianCatalogEndpoint(region: BailianRegion, workspaceId?: string): string | undefined {
  if (region === "ap-southeast-1") return "https://dashscope-intl.aliyuncs.com/api/v1/models";
  if (region === "cn-hongkong") return "https://cn-hongkong.dashscope.aliyuncs.com/api/v1/models";
  const workspace = workspaceId?.trim();
  return workspace ? `https://${workspace}.${region}.maas.aliyuncs.com/api/v1/models` : undefined;
}

function modelSort(left: LlmModelOption, right: LlmModelOption): number {
  if (left.recommended !== right.recommended) return left.recommended ? -1 : 1;
  const rank: Record<LlmModelCompatibility, number> = { compatible: 0, unknown: 1, incompatible: 2 };
  return rank[left.compatibility] - rank[right.compatibility] || left.name.localeCompare(right.name, "en");
}

function mergeRecommended(dynamic: LlmModelOption[], recommended: LlmModelOption[]): LlmModelOption[] {
  const models = new Map(dynamic.map((item) => [item.id, item]));
  recommended.forEach((item) => {
    const catalogItem = models.get(item.id);
    models.set(item.id, catalogItem ? { ...catalogItem, recommended: true, name: item.name } : item);
  });
  return [...models.values()].sort(modelSort);
}

function pricingHint(item: AgentModelCatalogItem): string | undefined {
  const prompt = Number(item.pricing?.prompt);
  const completion = Number(item.pricing?.completion);
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return undefined;
  return `$${(prompt * 1_000_000).toFixed(2)} / $${(completion * 1_000_000).toFixed(2)} per 1M tokens`;
}

export class AgentHarness {
  private readonly registry = createDefaultAgentToolRegistry();
  private readonly modelAdapter: AgentModelAdapterPort;

  constructor(private readonly application: GrudgeVaultApplication, options: AgentHarnessOptions = {}) {
    this.modelAdapter = options.modelAdapter ?? new OpenAiCompatibleChatAdapter();
  }

  getLlmSettings(): LlmSettings { return this.application.getLlmSettings(); }

  saveLlm(input: LlmConnectInput): LlmSettings { return this.application.saveLlmProvider(input); }

  async listLlmModels(input: LlmListModelsInput): Promise<LlmModelOption[]> {
    const apiKey = input.apiKey?.trim() || this.application.getLlmCredential(input.provider);
    const savedConfig = this.application.getLlmSettings().providers[input.provider];
    const workspaceId = input.workspaceId?.trim() || savedConfig?.workspaceId;
    if (!apiKey || !this.modelAdapter.listModels) {
      return input.provider === "nvidia" ? NVIDIA_RECOMMENDED
        : input.provider === "bailian" ? BAILIAN_RECOMMENDED : [];
    }
    const catalogUrl = input.provider === "bailian"
      ? resolveBailianCatalogEndpoint(input.region ?? "cn-beijing", workspaceId) : undefined;
    if (input.provider === "bailian" && !catalogUrl) return BAILIAN_RECOMMENDED;
    const catalog = await this.modelAdapter.listModels({
      baseUrl: resolveLlmProviderEndpoint(input.provider, input.region), apiKey,
      extraHeaders: llmProviderHeaders(input.provider),
      ...(catalogUrl ? { catalogUrl, catalogFormat: "bailian" as const } : {})
    });
    const dynamic = catalog.map((item) => input.provider === "openrouter" ? classifyOpenRouterModel(item)
      : input.provider === "bailian" ? classifyBailianModel(item) : classifyNvidiaModel(item));
    return input.provider === "nvidia" ? mergeRecommended(dynamic, NVIDIA_RECOMMENDED)
      : input.provider === "bailian" ? mergeRecommended(dynamic, BAILIAN_RECOMMENDED)
        : dynamic.sort(modelSort);
  }

  async connectLlm(input: LlmConnectInput): Promise<LlmSettings> {
    const apiKey = input.apiKey?.trim() || this.application.getLlmCredential(input.provider);
    if (!apiKey) throw new AppError("LLM_AUTHENTICATION_FAILED", "Enter an API key before connecting.");
    if (input.provider === "nvidia") {
      if (!this.modelAdapter.listModels) {
        throw new AppError("AGENT_MODEL_UNAVAILABLE", "This app build cannot load the NVIDIA model catalog.");
      }
      const catalog = await this.modelAdapter.listModels({
        baseUrl: resolveLlmProviderEndpoint(input.provider, input.region), apiKey,
        extraHeaders: llmProviderHeaders(input.provider)
      });
      if (!catalog.some(({ id }) => id === input.model.trim())) {
        throw new AppError("LLM_MODEL_NOT_FOUND", "The selected model is not available in this account or region.");
      }
    }
    if (!this.modelAdapter.testConnection) {
      throw new AppError("LLM_TOOL_UNSUPPORTED", "This app build cannot verify model tool support.");
    }
    try {
      await this.modelAdapter.testConnection({
        baseUrl: resolveLlmProviderEndpoint(input.provider, input.region), model: input.model.trim(), apiKey,
        extraHeaders: llmProviderHeaders(input.provider)
      });
    } catch (error) {
      if (input.provider === "bailian" && error instanceof AppError && error.code === "LLM_AUTHENTICATION_FAILED") {
        throw new AppError("LLM_REGION_MISMATCH", "The API key or selected Alibaba Cloud region does not match.");
      }
      throw error;
    }
    return this.application.saveLlmConnection(input, new Date().toISOString());
  }

  async activateLlm(provider: LlmProvider): Promise<LlmSettings> {
    const config = this.application.getLlmSettings().providers[provider];
    const apiKey = this.application.getLlmCredential(provider);
    if (!config || !apiKey) throw new AppError("LLM_AUTHENTICATION_FAILED", "Connect this model service first.");
    if (!this.modelAdapter.testConnection) throw new AppError("LLM_TOOL_UNSUPPORTED", "This app build cannot verify model tool support.");
    try {
      await this.modelAdapter.testConnection({
        baseUrl: resolveLlmProviderEndpoint(provider, config.region), model: config.model, apiKey,
        extraHeaders: llmProviderHeaders(provider)
      });
    } catch (error) {
      if (provider === "bailian" && error instanceof AppError && error.code === "LLM_AUTHENTICATION_FAILED") {
        throw new AppError("LLM_REGION_MISMATCH", "The API key or selected Alibaba Cloud region does not match.");
      }
      throw error;
    }
    return this.application.activateLlmProvider(provider, new Date().toISOString());
  }

  disconnectLlm(provider: LlmProvider): LlmSettings { return this.application.disconnectLlmProvider(provider); }

  private runtimeSettings(): { settings: AgentModelSettings; provider?: LlmProvider } {
    const consent = this.application.getAgentSettings();
    const llm = this.application.getLlmSettings();
    const provider = llm.activeProvider;
    const config = provider ? llm.providers[provider] : undefined;
    if (!provider || !config || config.status !== "ready" || !config.credentialConfigured) {
      return { settings: {
        mode: "private", consentPolicyVersion: consent.consentPolicyVersion,
        consentedDataCategories: consent.consentedDataCategories
      } };
    }
    return { provider, settings: {
      mode: "enhanced", consentPolicyVersion: consent.consentPolicyVersion,
      consentedDataCategories: consent.consentedDataCategories,
      enhancedEndpoint: {
        baseUrl: resolveLlmProviderEndpoint(provider, config.region), model: config.model, credentialConfigured: true
      }
    } };
  }

  async send(input: AgentSendInput): Promise<AgentSendResult> {
    const userMessage = this.application.recordConversationMessage(input.conversationId, "user", input.content);
    let intent = routeAgentIntent(input.content);
    const previousRun = this.application.listAgentRuns(input.conversationId).at(-1);
    const recentMessages = this.application.listMessages(input.conversationId);
    if (intent === "retrieve" && previousRun?.assistantMessageId === recentMessages.at(-2)?.id &&
      previousRun?.analysis?.suggestedQuestions.length === 1) intent = "clarify";
    const runtime = this.runtimeSettings();
    const settings = runtime.settings;
    const snapshot = await this.buildSnapshot(input.conversationId, input.content, intent);
    const endpoint = settings.mode === "private" ? settings.privateEndpoint : settings.enhancedEndpoint;
    const missing = settings.mode === "enhanced" && endpoint
      ? snapshot.categories.filter((category) => !settings.consentedDataCategories.includes(category)) : [];
    const now = new Date().toISOString();
    const disclosure: ExternalContextDisclosure | undefined = settings.mode === "enhanced" && endpoint ? {
      id: randomUUID(), runId: "", policyVersion: AGENT_REDACTION_POLICY_VERSION,
      categories: snapshot.categories, categoryCounts: snapshot.categoryCounts, contextHash: snapshot.contextHash,
      required: missing.length > 0, createdAt: now
    } : undefined;
    let run: AgentRun = {
      id: randomUUID(), conversationId: input.conversationId, userMessageId: userMessage.id, intent,
      mode: settings.mode, status: disclosure?.required ? "awaiting_consent" : "running",
      ...(endpoint ? { modelIdentity: this.modelAdapter.identity, modelVersion: this.modelAdapter.version } : {}),
      toolSchemaVersion: AGENT_TOOL_SCHEMA_VERSION, contextHash: snapshot.contextHash,
      responseVersion: AGENT_RESPONSE_VERSION, citations: snapshot.citations, toolCalls: [], actions: [], createdAt: now
    };
    if (disclosure) run = { ...run, disclosure: { ...disclosure, runId: run.id } };
    run = this.application.saveAgentRun(run);
    if (run.status === "awaiting_consent") return { run, userMessage };
    return this.execute(run, userMessage, snapshot, settings, runtime.provider);
  }

  async resume(runId: string, disclosureId: string): Promise<AgentSendResult> {
    let run = this.application.getAgentRun(runId);
    if (run.status !== "awaiting_consent" || !run.disclosure || run.disclosure.id !== disclosureId) {
      throw new AppError("AGENT_RUN_STATE_CONFLICT", "This Agent run is not waiting for that disclosure.");
    }
    const acceptedAt = new Date().toISOString();
    run = this.application.saveAgentRun({
      ...run, status: "running", disclosure: { ...run.disclosure, acceptedAt }
    });
    this.application.grantAgentDataCategories(run.disclosure!.categories);
    const userMessage = this.application.listMessages(run.conversationId).find(({ id }) => id === run.userMessageId);
    if (!userMessage?.content) throw new AppError("ENTITY_NOT_FOUND", "The Agent user message no longer exists.");
    const snapshot = await this.buildSnapshot(run.conversationId, userMessage.content, run.intent);
    const runtime = this.runtimeSettings();
    const refreshedSettings = runtime.settings;
    const newlyRequired = snapshot.categories.filter(
      (category) => !refreshedSettings.consentedDataCategories.includes(category)
    );
    if (refreshedSettings.mode === "enhanced" && newlyRequired.length > 0) {
      const disclosure: ExternalContextDisclosure = {
        id: randomUUID(), runId: run.id, policyVersion: AGENT_REDACTION_POLICY_VERSION,
        categories: snapshot.categories, categoryCounts: snapshot.categoryCounts,
        contextHash: snapshot.contextHash, required: true, createdAt: new Date().toISOString()
      };
      run = this.application.saveAgentRun({ ...run, status: "awaiting_consent", disclosure });
      return { run, userMessage };
    }
    return this.execute(run, userMessage, snapshot, refreshedSettings, runtime.provider);
  }

  cancel(runId: string): AgentRun {
    const run = this.application.getAgentRun(runId);
    if (!["awaiting_consent", "running"].includes(run.status)) {
      throw new AppError("AGENT_RUN_STATE_CONFLICT", "Only an unfinished Agent run can be cancelled.");
    }
    const now = new Date().toISOString();
    return this.application.saveAgentRun({
      ...run, status: "cancelled", completedAt: now,
      ...(run.disclosure && !run.disclosure.acceptedAt ? { disclosure: { ...run.disclosure, rejectedAt: now } } : {})
    });
  }

  listRuns(conversationId: string): AgentRun[] { return this.application.listAgentRuns(conversationId); }
  getRun(runId: string): AgentRun { return this.application.getAgentRun(runId); }
  getSettings(): AgentModelSettings { return this.application.getAgentSettings(); }
  updateSettings(input: AgentSettingsUpdateInput): AgentModelSettings { return this.application.updateAgentSettings(input); }
  clearCredential(mode: AgentModelSettings["mode"]): AgentModelSettings { return this.application.clearAgentCredential(mode); }

  approveAction(actionId: string): AgentAction {
    const run = this.findRunByAction(actionId);
    const action = run.actions.find(({ id }) => id === actionId)!;
    if (action.status !== "pending") throw new AppError("AGENT_ACTION_CONFLICT", "This Agent action is no longer pending.");
    const sourceRef = this.application.listMessages(run.conversationId).find(({ id }) => id === run.userMessageId)?.sourceItemId;
    if (!sourceRef) throw new AppError("ENTITY_NOT_FOUND", "The source message for this Agent action no longer exists.");
    const now = new Date().toISOString();
    let nextAction: AgentAction;
    try {
      let result: Event | Case;
      if (action.toolName === "propose_event") {
        result = this.application.proposeAgentEvent(action.payload as EventWriteFields, sourceRef);
      } else if (action.toolName === "update_event" || action.toolName === "add_asset") {
        result = this.application.updateEventFromAgent(action.payload as UpdateEventInput, sourceRef);
      } else if (action.toolName === "answer_clarification") {
        const input = action.payload as { clarificationId: string; answer: string; expectedRevision: number };
        result = this.application.answerClarificationFromAgent(input.clarificationId, input.answer, input.expectedRevision, sourceRef);
      } else if (action.toolName === "create_case") {
        const input = action.payload as CreateCaseInput;
        result = this.application.createCase({ ...input, sourceRefs: [...new Set([...input.sourceRefs, sourceRef])] });
      } else if (action.toolName === "update_case") {
        const input = action.payload as UpdateCaseInput;
        result = this.application.updateCase({ ...input, sourceRefs: [...new Set([...input.sourceRefs, sourceRef])] });
      } else throw new AppError("AGENT_TOOL_FAILED", "The stored Agent action uses an unsupported tool.");
      nextAction = { ...action, status: "approved", resultRefs: [result.id], resolvedAt: now };
    } catch (error) {
      const code = error instanceof AppError ? error.code : "INTERNAL_ERROR";
      nextAction = {
        ...action, status: code === "EVENT_REVISION_CONFLICT" || code === "CASE_REVISION_CONFLICT" ? "stale" : "failed",
        errorCode: code, resolvedAt: now
      };
    }
    const toolCalls = run.toolCalls.map((call) => call.id === action.toolCallId ? {
      ...call, status: nextAction.status === "approved" ? "succeeded" as const : "failed" as const,
      outputRefs: nextAction.resultRefs, finishedAt: now,
      ...(nextAction.errorCode ? { errorCode: nextAction.errorCode } : {})
    } : call);
    this.application.saveAgentRun({
      ...run, toolCalls, actions: run.actions.map((value) => value.id === actionId ? nextAction : value)
    });
    return nextAction;
  }

  rejectAction(actionId: string): AgentAction {
    const run = this.findRunByAction(actionId);
    const action = run.actions.find(({ id }) => id === actionId)!;
    if (action.status !== "pending") throw new AppError("AGENT_ACTION_CONFLICT", "This Agent action is no longer pending.");
    const next = { ...action, status: "rejected" as const, resolvedAt: new Date().toISOString() };
    this.application.saveAgentRun({
      ...run, actions: run.actions.map((value) => value.id === actionId ? next : value),
      toolCalls: run.toolCalls.map((call) => call.id === action.toolCallId ? {
        ...call, status: "failed" as const, errorCode: "AGENT_ACTION_CONFLICT", finishedAt: next.resolvedAt
      } : call)
    });
    return next;
  }

  private findRunByAction(actionId: string): AgentRun {
    for (const conversation of this.application.listConversations()) {
      const run = this.application.listAgentRuns(conversation.id).find(({ actions }) => actions.some(({ id }) => id === actionId));
      if (run) return run;
    }
    throw new AppError("ENTITY_NOT_FOUND", "The Agent action no longer exists.");
  }

  private async execute(
    initialRun: AgentRun,
    userMessage: Message,
    snapshot: AgentSnapshot,
    settings: AgentModelSettings,
    provider?: LlmProvider
  ): Promise<AgentSendResult> {
    let run = initialRun;
    const now = new Date().toISOString();
    const initialCall: AgentToolCall = {
      id: randomUUID(), runId: run.id, sequence: 0,
      toolName: run.intent === "record" ? "record_source" : run.intent === "evidence" ? "get_evidence" : "search_events",
      toolVersion: AGENT_TOOL_SCHEMA_VERSION,
      inputHash: sha256(userMessage.content ?? ""), inputRefs: [userMessage.sourceItemId],
      outputRefs: run.intent === "evidence"
        ? [...snapshot.cases.map(({ id }) => id), ...snapshot.evidence.map(({ asset }) => asset.id)]
        : snapshot.events.map(({ id }) => id), status: "succeeded", startedAt: now, finishedAt: now
    };
    run = { ...run, status: "running", toolCalls: [initialCall], citations: snapshot.citations };
    const endpoint = settings.mode === "private" ? settings.privateEndpoint : settings.enhancedEndpoint;
    if (run.intent === "record" && userMessage.content && !endpoint) run = this.addRecordProposal(run, userMessage.content);
    if (run.intent === "clarify" && userMessage.content) run = this.answerDisplayedClarification(run, userMessage);
    this.application.saveAgentRun(run);

    let modelText: string | undefined;
    let degradedError: string | undefined;
    if (endpoint) {
      const audit: AgentModelCallAudit = {
        id: randomUUID(), runId: run.id, sequence: this.application.listAgentModelCallAudits(run.id).length,
        endpointOrigin: new URL(endpoint.baseUrl).origin, model: endpoint.model,
        categories: snapshot.categories, contextHash: snapshot.contextHash, status: "running",
        startedAt: new Date().toISOString()
      };
      this.application.saveAgentModelCallAudit(audit);
      try {
        const credential = provider
          ? this.application.getLlmCredential(provider)
          : this.application.getAgentCredential(settings.mode);
        const result = await this.modelAdapter.run({
          baseUrl: endpoint.baseUrl, model: endpoint.model, ...(credential ? { apiKey: credential } : {}),
          ...(provider ? { extraHeaders: llmProviderHeaders(provider) } : {}),
          system: "Use only the registered tools. Keep unknowns unknown. Never present an uncited claim as a confirmed fact. Offer options; do not decide for the user.",
          user: snapshot.context, tools: this.registry.definitions(run.intent),
          executeTool: async (name, value, providerCallId) => {
            const executed = await this.executeModelTool(run, snapshot, name, value, providerCallId);
            run = executed.run;
            this.application.saveAgentRun(run);
            return executed.output;
          }
        });
        modelText = result.text?.trim();
        this.application.saveAgentModelCallAudit({
          ...audit, status: "succeeded", finishedAt: new Date().toISOString(),
          ...(result.promptTokens !== undefined ? { promptTokens: result.promptTokens } : {}),
          ...(result.completionTokens !== undefined ? { completionTokens: result.completionTokens } : {})
        });
      } catch (error) {
        degradedError = error instanceof AppError ? error.code : "INTERNAL_ERROR";
        if (provider && error instanceof AppError && [
          "LLM_AUTHENTICATION_FAILED", "LLM_MODEL_NOT_FOUND", "LLM_TOOL_UNSUPPORTED", "LLM_REGION_MISMATCH"
        ].includes(error.code)) this.application.markLlmProviderNeedsAttention(provider);
        this.application.saveAgentModelCallAudit({
          ...audit, status: "failed", errorCode: degradedError, finishedAt: new Date().toISOString()
        });
      }
    }
    const analysis = buildDeterministicAnalysis(this.application, snapshot);
    if (modelText) analysis.interpretations.push(claim(modelText, [], "interpretation.agent"));
    if (run.intent === "record" && userMessage.content && degradedError && run.actions.length === 0) {
      run = this.addRecordProposal(run, userMessage.content);
    }
    const english = !/[\p{Script=Han}]/u.test(userMessage.content ?? "");
    const responseText = modelText || deterministicResponse(run.intent, snapshot, run.actions, english);
    const assistantMessage = this.application.recordConversationMessage(run.conversationId, "assistant", responseText);
    run = this.application.saveAgentRun({
      ...run, assistantMessageId: assistantMessage.id, status: "succeeded", responseText, analysis,
      citations: snapshot.citations, completedAt: new Date().toISOString(),
      ...(degradedError ? { errorCode: degradedError } : {})
    });
    return { run, userMessage, assistantMessage };
  }

  private addRecordProposal(run: AgentRun, content: string): AgentRun {
    const title = content.split(/[。！？.!?\n]/, 1)[0]?.trim().slice(0, 120) || content.slice(0, 120);
    const fields: EventWriteFields = {
      title, status: "candidate", occurredAt: parseConservativeTemporalValue(content), narrative: content,
      facts: [], interpretations: [], emotions: [], interests: [], participants: [], sourceRefs: [], assetRefs: []
    };
    const call: AgentToolCall = {
      id: randomUUID(), runId: run.id, sequence: run.toolCalls.length, toolName: "propose_event", toolVersion: AGENT_TOOL_SCHEMA_VERSION,
      inputHash: sha256(JSON.stringify(fields)), inputRefs: [run.userMessageId], outputRefs: [], status: "proposed",
      startedAt: new Date().toISOString()
    };
    const action: AgentAction = {
      id: randomUUID(), runId: run.id, toolCallId: call.id, toolName: call.toolName, toolVersion: AGENT_TOOL_SCHEMA_VERSION,
      summary: `创建候选事件：${title}`, payload: fields, status: "pending", resultRefs: [], createdAt: call.startedAt
    };
    return { ...run, toolCalls: [...run.toolCalls, call], actions: [...run.actions, action] };
  }

  private answerDisplayedClarification(run: AgentRun, userMessage: Message): AgentRun {
    const previousRun = this.application.listAgentRuns(run.conversationId)
      .filter(({ id }) => id !== run.id).at(-1);
    const question = previousRun?.analysis?.suggestedQuestions.length === 1
      ? previousRun.analysis.suggestedQuestions[0] : undefined;
    if (!question || previousRun?.assistantMessageId !== this.application.listMessages(run.conversationId).at(-2)?.id) return run;
    const open = this.application.listClarifications().filter((item) => item.status === "open" && item.question === question);
    if (open.length !== 1) return run;
    const clarification = open[0]!;
    const event = this.application.getEvent(clarification.eventId).event;
    const now = new Date().toISOString();
    const result = this.application.answerClarificationFromAgent(
      clarification.id, userMessage.content!, event.currentRevision, userMessage.sourceItemId
    );
    const call: AgentToolCall = {
      id: randomUUID(), runId: run.id, sequence: run.toolCalls.length,
      toolName: "answer_clarification", toolVersion: AGENT_TOOL_SCHEMA_VERSION,
      inputHash: sha256(userMessage.content!), inputRefs: [clarification.id, userMessage.sourceItemId],
      outputRefs: [result.id], status: "succeeded", startedAt: now, finishedAt: now
    };
    const action: AgentAction = {
      id: randomUUID(), runId: run.id, toolCallId: call.id, toolName: call.toolName, toolVersion: AGENT_TOOL_SCHEMA_VERSION,
      summary: "回答一条当前明确展示的待补全问题", payload: {
        clarificationId: clarification.id, expectedRevision: event.currentRevision
      }, expectedRevision: event.currentRevision, status: "approved", resultRefs: [result.id],
      createdAt: now, resolvedAt: now
    };
    return { ...run, toolCalls: [...run.toolCalls, call], actions: [...run.actions, action] };
  }

  private async executeModelTool(
    run: AgentRun,
    snapshot: AgentSnapshot,
    name: string,
    rawInput: unknown,
    providerCallId: string
  ): Promise<{ run: AgentRun; output: unknown }> {
    const { tool, input } = this.registry.parse(run.intent, name, rawInput);
    const now = new Date().toISOString();
    const call: AgentToolCall = {
      id: randomUUID(), runId: run.id, sequence: run.toolCalls.length, toolName: name, toolVersion: tool.version,
      inputHash: sha256(JSON.stringify(input)), inputRefs: [], outputRefs: [], status: tool.write ? "proposed" : "running",
      startedAt: now
    };
    if (run.toolCalls.length >= MAX_AGENT_TOOL_CALLS + 1) throw new AppError("AGENT_TOOL_FAILED", "The Agent tool-call limit was exceeded.");
    const resolve = (ref: string): string => {
      const resolved = snapshot.aliases.get(ref);
      if (!resolved) throw new AppError("AGENT_TOOL_FAILED", `Reference ${ref} is not available in this Agent run.`);
      return resolved;
    };
    let output: unknown;
    let action: AgentAction | undefined;
    const value = input as Record<string, unknown>;
    if (name === "get_evidence") {
      const evidence = this.application.getEvidence(resolve(String(value.evidenceRef)));
      output = {
        ref: String(value.evidenceRef), sha256: evidence.asset.sha256, byteSize: evidence.asset.byteSize,
        mimeType: evidence.asset.mimeType, availabilityStatus: evidence.availabilityStatus,
        integrityStatus: evidence.asset.integrityStatus, derivedArtifacts: evidence.derivedArtifacts.map(({ id, kind }) => ({ id, kind }))
      };
      call.outputRefs = [evidence.asset.id, ...evidence.derivedArtifacts.map(({ id }) => id)];
    } else if (name === "get_case") {
      const detail = this.application.getCase(resolve(String(value.caseRef)));
      output = {
        ref: String(value.caseRef), title: redactExternalText(detail.case.title, snapshot.personNames),
        status: detail.case.status, jurisdiction: detail.case.jurisdiction, asOfDate: detail.case.asOfDate,
        currentRevision: detail.case.currentRevision, eventCount: detail.case.eventRefs.length,
        evidenceCount: detail.case.assetRefs.length
      };
      call.outputRefs = [detail.case.id, ...detail.case.eventRefs, ...detail.case.assetRefs];
    } else if (name === "build_case_timeline") {
      const detail = this.application.getCase(resolve(String(value.caseRef)));
      output = detail.timeline.groups.map(({ label, events }) => ({ label, events: events.map(({ id, title, currentRevision }) => ({
        ref: [...snapshot.aliases.entries()].find(([, target]) => target === id)?.[0] ?? "event",
        title: redactExternalText(title, snapshot.personNames), currentRevision
      })) }));
      call.outputRefs = detail.case.eventRefs;
    } else if (name === "list_case_gaps") {
      const detail = this.application.getCase(resolve(String(value.caseRef)));
      output = {
        questions: detail.case.questions.map(({ question, reason, status }) => ({
          question: redactExternalText(question, snapshot.personNames), reason: redactExternalText(reason, snapshot.personNames), status
        })),
        materialGaps: detail.case.materialGaps.map(({ label, reason, priority, status }) => ({
          label: redactExternalText(label, snapshot.personNames), reason: redactExternalText(reason, snapshot.personNames), priority, status
        }))
      };
      call.outputRefs = [detail.case.id];
    } else if (name === "prepare_case_bundle") {
      const detail = this.application.getCase(resolve(String(value.caseRef)));
      output = { previewCard: true, caseRef: String(value.caseRef), caseRevision: detail.case.currentRevision,
        requiresUserSelection: true, exportAvailableToModel: false };
      call.outputRefs = [detail.case.id];
    } else if (name === "search_events") {
      const hits = await this.application.unifiedSearch({ text: String(value.query), semantic: false, limit: 8 });
      output = hits.map((hit, index) => {
        const ref = `search_result_${index + 1}`;
        const target = hit.eventId ?? hit.sourceItemId ?? hit.derivedArtifactId ?? (hit.kind === "ocr" || hit.kind === "transcript" ? hit.id : undefined);
        if (target) snapshot.aliases.set(ref, target);
        return {
          ref, kind: hit.kind, title: redactExternalText(hit.title, snapshot.personNames),
          excerpt: redactExternalText(hit.excerpt, snapshot.personNames).slice(0, 1000),
          ...(hit.derivedArtifactId ? { derivedArtifactRef: ref } : {}),
          ...(hit.sourceAssetId ? { sourceAssetRef: `asset:${hit.sourceAssetId}` } : {})
        };
      });
      call.outputRefs = hits.flatMap((hit) => [hit.eventId, hit.sourceItemId, hit.derivedArtifactId]).filter((id): id is string => Boolean(id));
    } else if (name === "get_event" || name === "analyze_event") {
      const refs = name === "get_event" ? [String(value.eventRef)] : value.eventRefs as string[];
      const events = refs.slice(0, 8).map((ref) => this.application.getEvent(resolve(ref)).event);
      output = events.map((event) => ({
        ref: [...snapshot.aliases.entries()].find(([, id]) => id === event.id)?.[0] ?? "event",
        title: redactExternalText(event.title, snapshot.personNames),
        facts: event.facts.slice(0, 8).map(({ kind, text }) => ({
          kind, text: redactExternalText(text, snapshot.personNames).slice(0, 1000)
        })),
        interpretations: event.interpretations.slice(0, 8)
          .map(({ text }) => redactExternalText(text, snapshot.personNames).slice(0, 1000)),
        interests: event.interests.slice(0, 8)
          .map(({ label }) => redactExternalText(label, snapshot.personNames).slice(0, 1000))
      }));
      call.outputRefs = events.map(({ id }) => id);
    } else if (name === "get_sources") {
      const sources = (value.sourceRefs as string[]).map((ref) => this.application.getSourceReference(resolve(ref)));
      output = sources.map((source) => ({
        title: redactExternalText(source.title, snapshot.personNames),
        excerpt: redactExternalText(source.excerpt, snapshot.personNames).slice(0, 1000)
      }));
      call.outputRefs = sources.map(({ sourceItemId }) => sourceItemId);
    } else if (name === "get_person_history") {
      const detail = this.application.getPersonIdentity(resolve(String(value.personRef)));
      output = { person: "Person", events: detail.events.slice(0, 8).map(({ title, occurredAt }) => ({
        title: redactExternalText(title, snapshot.personNames), occurredAt
      })) };
      call.outputRefs = detail.events.slice(0, 8).map(({ id }) => id);
    } else if (name === "find_related_events") {
      const relations = this.application.listEventRelations(resolve(String(value.eventRef))).slice(0, 8);
      output = relations.map(({ kind, status, basis }) => ({
        kind, status, basis: basis.map(({ label }) => redactExternalText(label, snapshot.personNames))
      }));
      call.outputRefs = relations.flatMap(({ sourceEventId, targetEventId }) => [sourceEventId, targetEventId]);
    } else if (name === "build_timeline") {
      const timeline = this.application.queryTimeline({
        ...(value.from ? { from: String(value.from) } : {}), ...(value.to ? { to: String(value.to) } : {}),
        ...(value.personRef ? { personId: resolve(String(value.personRef)) } : {})
      });
      const events = timeline.groups.flatMap(({ label, events }) => events.map((event) => ({ label, event }))).slice(0, 8);
      output = events.map(({ label, event }) => ({
        label, title: redactExternalText(event.title, snapshot.personNames)
      }));
      call.outputRefs = events.map(({ event }) => event.id);
    } else if (name === "list_clarifications") {
      const clarifications = this.application.listClarifications(value.eventRef ? resolve(String(value.eventRef)) : undefined);
      output = clarifications.filter(({ status }) => status === "open").slice(0, 8).map((item, index) => ({
        ref: `clarification_${index + 1}`, question: redactExternalText(item.question, snapshot.personNames), priority: item.priority
      }));
      clarifications.slice(0, 8).forEach((item, index) => snapshot.aliases.set(`clarification_${index + 1}`, item.id));
      call.outputRefs = clarifications.slice(0, 8).map(({ id }) => id);
    } else if (name === "summarize_period") {
      const review = this.application.generateReview({ from: String(value.from), to: String(value.to) });
      output = review.patterns.slice(0, 8).map(({ title, summary }) => ({
        title: redactExternalText(title, snapshot.personNames), summary: redactExternalText(summary, snapshot.personNames)
      }));
      call.outputRefs = [...review.eventIds, ...review.sourceRefs];
    } else if (name === "compare_options" || name === "create_action_plan" || name === "record_source") {
      output = { accepted: true, value };
    } else {
      let payload: unknown;
      let summary: string;
      let expectedRevision: number | undefined;
      if (name === "propose_event") {
        const narrative = String(value.narrative);
        payload = {
          title: String(value.title), status: "candidate", occurredAt: parseConservativeTemporalValue(String(value.occurredAtText ?? narrative)),
          narrative, facts: [], interpretations: [], emotions: [], interests: [], participants: [], sourceRefs: [], assetRefs: []
        } satisfies EventWriteFields;
        summary = `创建候选事件：${String(value.title)}`;
      } else if (name === "update_event") {
        const event = this.application.getEvent(resolve(String(value.eventRef))).event;
        expectedRevision = Number(value.expectedRevision);
        payload = {
          ...event, eventId: event.id, expectedRevision,
          ...(value.narrative ? { narrative: String(value.narrative) } : {}),
          facts: value.fact ? [...event.facts, {
            id: randomUUID(), kind: "fact.unknown" as const, text: String(value.fact), sourceRefs: []
          }] : event.facts,
          reason: "Agent update approved by user"
        } satisfies UpdateEventInput;
        summary = `更新事件：${event.title}`;
      } else if (name === "answer_clarification") {
        const clarificationId = resolve(String(value.clarificationRef));
        expectedRevision = Number(value.expectedRevision);
        payload = { clarificationId, answer: String(value.answer), expectedRevision };
        summary = "回答一条待补全问题";
      } else if (name === "add_asset") {
        const event = this.application.getEvent(resolve(String(value.eventRef))).event;
        const assetId = resolve(String(value.assetRef));
        expectedRevision = Number(value.expectedRevision);
        payload = {
          ...event, eventId: event.id, expectedRevision,
          assetRefs: [...new Set([...event.assetRefs, assetId])], reason: "Agent asset link approved by user"
        } satisfies UpdateEventInput;
        summary = `关联材料到事件：${event.title}`;
      } else if (name === "create_case") {
        payload = {
          title: String(value.title), status: "draft", ...(value.summary ? { summary: String(value.summary) } : {}),
          jurisdiction: String(value.jurisdiction), asOfDate: String(value.asOfDate), eventRefs: [], personRefs: [],
          sourceRefs: [], assetRefs: [], amounts: [], disputePoints: [], questions: [], materialGaps: [], evidenceLinks: [],
          reason: "Agent Case creation approved by user"
        } satisfies CreateCaseInput;
        summary = `创建 Case：${String(value.title)}`;
      } else if (name === "update_case") {
        const caseItem = this.application.getCase(resolve(String(value.caseRef))).case;
        expectedRevision = Number(value.expectedRevision);
        payload = {
          ...caseItem, caseId: caseItem.id, expectedRevision, summary: String(value.summary),
          reason: "Agent Case revision approved by user"
        } satisfies UpdateCaseInput;
        summary = `更新 Case：${caseItem.title}`;
      } else throw new AppError("AGENT_TOOL_FAILED", `Tool ${name} has no executor.`);
      action = {
        id: randomUUID(), runId: run.id, toolCallId: call.id, toolName: name, toolVersion: tool.version,
        summary, payload, status: "pending", resultRefs: [], createdAt: now,
        ...(expectedRevision ? { expectedRevision } : {})
      };
      output = { proposed: true, actionId: action.id, summary, providerCallId };
    }
    const finishedAt = new Date().toISOString();
    const completedCall = { ...call, status: tool.write ? "proposed" as const : "succeeded" as const, finishedAt };
    return {
      run: {
        ...run, toolCalls: [...run.toolCalls, completedCall],
        ...(action ? { actions: [...run.actions, action] } : {})
      },
      output
    };
  }

  private async buildSnapshot(conversationId: string, content: string, intent: AgentIntent): Promise<AgentSnapshot> {
    let hits: UnifiedSearchHit[] = [];
    try { hits = await this.application.unifiedSearch({ text: content, semantic: false, limit: 8 }); }
    catch { hits = []; }
    const eventsById = new Map<string, Event>();
    for (const hit of hits) {
      const eventId = hit.eventId ?? (hit.kind === "event" ? hit.id : undefined);
      if (eventId) {
        try { eventsById.set(eventId, this.application.getEvent(eventId).event); } catch { /* stale search hit */ }
      }
    }
    const cases = intent === "evidence" ? this.application.listCases().slice(0, 8) : [];
    if (intent === "evidence") {
      for (const caseItem of cases) {
        for (const eventId of caseItem.eventRefs) {
          try { eventsById.set(eventId, this.application.getEvent(eventId).event); } catch { /* stale Case reference */ }
        }
      }
    }
    if (eventsById.size === 0 && ["review", "strategy", "clarify"].includes(intent)) {
      for (const event of this.application.searchEvents({ status: "confirmed", limit: 8 })) eventsById.set(event.id, event);
    }
    const events = [...eventsById.values()].slice(0, 8);
    const sources: SourceReferenceDetail[] = [];
    for (const sourceRef of [...new Set(events.flatMap(({ sourceRefs }) => sourceRefs))].slice(0, 8)) {
      try { sources.push(this.application.getSourceReference(sourceRef)); } catch { /* source removed */ }
    }
    for (const hit of hits.filter(({ kind }) => kind === "ocr" || kind === "transcript")) {
      try {
        const source = this.application.getSourceReference(hit.id);
        if (!sources.some(({ sourceItemId }) => sourceItemId === source.sourceItemId)) sources.push(source);
      } catch { /* stale derived search result */ }
    }
    const caseAssetIds = new Set(cases.flatMap(({ assetRefs }) => assetRefs));
    const evidence = (intent === "evidence" ? this.application.listEvidence()
      .filter(({ asset }) => caseAssetIds.size === 0 || caseAssetIds.has(asset.id)) : []).slice(0, 8);
    const assets = [...new Map([
      ...this.application.listAssets().filter(({ id }) => events.some(({ assetRefs }) => assetRefs.includes(id))),
      ...evidence.map(({ asset }) => asset)
    ].map((asset) => [asset.id, asset])).values()].slice(0, 8);
    const people = this.application.listPeople();
    const names = people.map(({ displayName }) => displayName);
    const messages = this.application.listMessages(conversationId).slice(0, -1).slice(-12);
    const aliases = new Map<string, string>();
    events.forEach((event, index) => aliases.set(`event_${index + 1}`, event.id));
    sources.forEach((source, index) => aliases.set(`source_${index + 1}`, source.sourceItemId));
    assets.forEach((asset, index) => aliases.set(`asset_${index + 1}`, asset.id));
    cases.forEach((caseItem, index) => aliases.set(`case_${index + 1}`, caseItem.id));
    evidence.forEach((item, index) => aliases.set(`evidence_${index + 1}`, item.asset.id));
    people.forEach((person, index) => aliases.set(`person_${index + 1}`, person.id));
    const external = {
      message: redactExternalText(content, names).slice(0, 20_000),
      recentConversation: messages.map(({ role, content: messageContent }) => ({
        role, content: redactExternalText(messageContent ?? "", names).slice(0, 1000)
      })),
      events: events.map((event, index) => ({
        ref: `event_${index + 1}`, title: redactExternalText(event.title, names), occurredAt: event.occurredAt,
        facts: event.facts.map(({ kind, text }) => ({ kind, text: redactExternalText(text, names).slice(0, 1000) })),
        interpretations: event.interpretations.map(({ text }) => redactExternalText(text, names).slice(0, 1000)),
        emotions: event.emotions.map(({ label, intensity }) => ({ label: redactExternalText(label, names), intensity })),
        interests: event.interests.map(({ label }) => redactExternalText(label, names))
      })),
      sources: sources.map((source, index) => ({
        ref: `source_${index + 1}`, kind: source.kind,
        excerpt: redactExternalText(source.excerpt, names).slice(0, 1000)
      })),
      assets: assets.map((asset, index) => ({ ref: `asset_${index + 1}`, mimeType: asset.mimeType, byteSize: asset.byteSize })),
      cases: cases.map((caseItem, index) => ({
        ref: `case_${index + 1}`, title: redactExternalText(caseItem.title, names), status: caseItem.status,
        jurisdiction: caseItem.jurisdiction, asOfDate: caseItem.asOfDate, currentRevision: caseItem.currentRevision,
        openGapCount: caseItem.materialGaps.filter(({ status }) => status === "open").length
      })),
      evidence: evidence.map((item, index) => ({
        ref: `evidence_${index + 1}`, mimeType: item.asset.mimeType, byteSize: item.asset.byteSize,
        availabilityStatus: item.availabilityStatus, integrityStatus: item.asset.integrityStatus,
        derivedArtifactCount: item.derivedArtifacts.length
      }))
    };
    const context = truncateUtf8(JSON.stringify(external), MAX_AGENT_CONTEXT_BYTES);
    const categories: AgentDataCategory[] = ["conversation_text"];
    if (events.length) categories.push("event_fields");
    if (sources.some(({ kind }) => kind === "transcript")) categories.push("transcript_excerpt");
    if (sources.some(({ kind }) => kind === "ocr")) categories.push("ocr_excerpt");
    if (sources.some(({ kind }) => kind !== "transcript" && kind !== "ocr")) categories.push("source_excerpt");
    if (assets.length) categories.push("asset_metadata");
    const categoryCounts: Partial<Record<AgentDataCategory, number>> = {
      conversation_text: messages.length + 1,
      ...(events.length ? { event_fields: events.length } : {}),
      ...(sources.filter(({ kind }) => kind !== "transcript" && kind !== "ocr").length ? {
        source_excerpt: sources.filter(({ kind }) => kind !== "transcript" && kind !== "ocr").length
      } : {}),
      ...(sources.filter(({ kind }) => kind === "ocr").length ? {
        ocr_excerpt: sources.filter(({ kind }) => kind === "ocr").length
      } : {}),
      ...(sources.filter(({ kind }) => kind === "transcript").length ? {
        transcript_excerpt: sources.filter(({ kind }) => kind === "transcript").length
      } : {}),
      ...(assets.length ? { asset_metadata: assets.length } : {})
    };
    const citations: AgentCitation[] = [
      ...events.map(eventCitation), ...sources.map(sourceCitation),
      ...assets.map((asset): AgentCitation => ({
        id: `citation:asset:${asset.id}`, kind: "asset", targetId: asset.id,
        label: asset.originalFileName, available: true
      }))
    ];
    return {
      context, contextHash: sha256(context), categories, categoryCounts,
      events, cases, evidence, sources, hits, citations, aliases, personNames: names
    };
  }
}
