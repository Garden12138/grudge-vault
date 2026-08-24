# ADR 0008: Phase 4 Agent Harness and model boundaries

- Status: Accepted for the Phase 4 First Useful Beta boundary
- Date: 2026-08-24

## Context

Phase 4 makes Chat the entry point for recording, retrieval, review, clarification, and strategy analysis. This increases the risk that an interchangeable model could invent facts, write directly to durable memory, receive excessive private context, or make the rest of the application depend on network availability. The boundary must work usefully with no model and remain testable without contacting a real endpoint.

## Decision

`packages/agent-harness` owns deterministic intent routing, bounded context construction, a versioned Zod Tool Registry, model protocol adaptation, grounded response assembly, disclosures, and write proposals. Domain and Application Services remain authoritative for Events, revisions, Clarifications, Sources, Assets, search, timeline, and Review behavior. Case, Evidence, OCR/ASR, and bundled models remain outside Phase 4.

Private is the default. Without an endpoint it performs deterministic local orchestration and templates with zero model calls. A configured Private endpoint may use HTTP or HTTPS only when its hostname is `localhost`, `127.0.0.1`, or `::1`. Enhanced is disabled until the user configures an HTTPS base URL without userinfo, query, or fragment. Both use a replaceable non-streaming Chat Completions adapter following the standard model request → tool call → local execution → tool output → final answer flow. The adapter appends `/chat/completions`, refuses redirects, allows at most four model rounds and eight tool calls, applies a 60-second timeout to each request, and rejects responses larger than 2 MiB. See the [OpenAI function-calling guide](https://developers.openai.com/api/docs/guides/function-calling).

The router exposes only the tools allowed for the selected intent. Tool arguments are Zod-validated, model-visible object references are run-local opaque aliases, and unknown or guessed IDs fail closed. The Context Builder includes no more than six recent conversation turns, eight retrieval results, 1,000 characters per excerpt, and 64 KiB total. Redaction policy v1 replaces known person names with localized aliases, removes contact/account patterns, local paths, and filenames, and never includes Asset bytes or complete raw Sources.

Enhanced creates an `ExternalContextDisclosure` containing data categories, counts, redaction policy version, and context hash. Consent is remembered by policy/category, then requested again when `conversation_text`, `event_fields`, `source_excerpt`, `asset_metadata`, or `transcript_excerpt` is newly introduced. The UI always displays the current run summary. API credentials are AES-256-GCM encrypted with the Workspace Key and mode-bound authenticated data; Renderer settings expose only whether a credential exists.

Model writes are durable `AgentAction` proposals. Approval re-enters Application Services and rechecks the expected Event revision; conflicts become `stale`. The only immediate write is a direct user reply to the single Clarification explicitly shown by the immediately preceding Agent response. That revision uses `actor: agent` and retains the reply Message SourceItem as evidence.

Structured facts are rebuilt from current local tool results. Confirmed facts require a valid citation from the current run; disputed/unknown items remain separate, and unsupported model prose is not promoted into confirmed Event fields. Strategy options keep their grounds, benefits, costs, risks, and unknowns separate and do not decide for the user.

SQLite migration v5 stores runs, hashed tool-call inputs, citations, actions, disclosures, settings, encrypted credential envelopes, and external-call audits. External-call audits contain only endpoint origin, model, categories, context hash, token counts, status, and error code—never prompts or Source bodies. Workspace snapshots preserve the database and therefore preserve all Phase 4 state.

## Consequences

The application remains useful and testable offline, and a model outage cannot block ordinary recording, browsing, search, or editing. Model providers can be replaced without changing the domain model. Users must explicitly approve durable model-proposed writes and newly disclosed external context categories. The first adapter intentionally excludes streaming, Responses API compatibility, redirects, Azure-specific paths/authentication, model distribution, and automatic evidence/case generation.
