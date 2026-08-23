# ADR 0004: Model adapter boundary

- Status: Accepted for future implementation
- Date: 2026-08-23

## Decision

Models, embeddings, OCR, and ASR will be reached through versioned Application ports. Adapters declare their identity, version, execution mode, and data requirements. Domain entities and repositories cannot depend on a model SDK, and model output is analysis or a proposal until a domain command accepts it.

## Consequences

Private and Enhanced execution can share domain behavior. Phase 0 includes no model dependency or outbound model call; future adapters must preserve source references, consent, and failure-independent local operation.
