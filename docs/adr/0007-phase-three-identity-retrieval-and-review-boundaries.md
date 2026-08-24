# ADR 0007: Phase 3 identity, retrieval, and review boundaries

- Status: Accepted for the Phase 3 Beta Foundation boundary
- Date: 2026-08-24

## Context

Phase 3 must connect long-lived Event memory without turning inferred identity or similarity into fact. Keyword retrieval must remain complete without a model, while optional semantic indexes and deterministic reviews must remain replaceable, traceable derivatives.

## Decision

Person merges are non-destructive identity projections. Events and revisions retain their original participant IDs. An active directed merge resolves those identities to a canonical Person at query time; reverting the merge restores the former projection immediately. Alias rows are independently retained and soft-deactivated. Duplicate suggestions use conservative NFKC/case-folded exact matches and trigram similarity, and user decisions are durable.

Event relations distinguish algorithm suggestions, user-confirmed links, rejected links, and manual links. Deterministic suggestions cite shared canonical people, interests/topics, text terms, and bounded temporal distance together with the Event revision numbers used. Refreshing suggestions may update only undecided algorithm rows. Rejected and confirmed decisions are never overwritten.

Unified search combines the existing Event FTS index with a current-source index for Day One entries and future Transcripts. Results always carry concrete Event or SourceItem references. Transcript indexing is supported as a contract, while OCR/ASR production remains deferred.

Embedding is an optional Application adapter. A rebuild writes vectors into a new generation and activates it only after every document succeeds; failure leaves the previous active generation intact. Vectors are replaceable SQLite metadata and never modify Events or Sources. With no adapter, disabled semantics, or an incompatible generation, retrieval falls back to FTS5. Hybrid ranking uses reciprocal-rank fusion with `k=60`, keyword weight `0.7`, and semantic weight `0.3`.

Periodic reviews are immutable `AnalysisRun` snapshots. The deterministic generator uses confirmed, non-archived current Event projections, canonical identities, non-rejected relations, repeated interests/topics, and calendar clustering. Every pattern lists its supporting Event revisions and SourceItem references. A recomputed input hash marks an older review stale after an Event, relation, or identity projection changes.

## Consequences

Identity corrections and model/index replacement are reversible and cannot erase original memory. Reviews expose correlation and clustering but do not claim causation. SQLite source text and vectors remain inside the existing local, unencrypted metadata boundary. Case entities, Transcript production, model distribution, OCR, and ASR remain outside Phase 3.
