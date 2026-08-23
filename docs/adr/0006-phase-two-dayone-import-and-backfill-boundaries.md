# ADR 0006: Phase 2 Day One import and backfill boundaries

- Status: Accepted for the Phase 2 Core boundary
- Date: 2026-08-24

## Context

Day One exports combine a large JSON document with user-controlled ZIP paths and media. Import must be safe, repeatable, locally auditable, and recoverable without giving a format adapter database authority or asking Renderer code to handle filesystem paths. Candidate extraction must preserve uncertainty and source provenance rather than manufacture facts.

## Decision

The Main process encrypts the selected ZIP into the content-addressed Object Vault before creating an `ImportRun`; durable jobs reference only the Asset ID. A standalone `@grudge-vault/importer-dayone` adapter uses `yauzl` 3.4 and `stream-json`, validates the complete ZIP directory before reading content, and emits normalized entries, media streams, and redacted issues through Application ports. It never opens SQLite.

Each workspace has one Day One `Source`. Entry UUID is the primary external identity. UUID-free entries use a hash of creation time, body, and media identifiers: identical imports are stable, while changed copies are conservatively added and warned about. Every normalized change appends a `SourceVersion`; old media relationships remain immutable. `ImportRun` and its per-entry ledger retain batch provenance even when an entry is skipped.

Backfill stores scope, detector identity/version, batch size, counters, and a source-item cursor. It examines only current SourceVersions. `local.dayone-candidate` v1 proposes at most one Event per meaningful entry, copies only bounded source text, extracts conservative absolute time, preserves relative time with a Clarification, and otherwise uses the journal date with source attribution. The unique source-version/detector/version/ordinal key makes cursor replay safe.

Candidate confirmation, ignore, and merge compare expected Event revisions and update Event revisions plus extraction state in one SQLite transaction. Merge unions source and asset references only. A newer source version supersedes an unreviewed candidate and archives its Event projection without deleting history.

## Security limits

The importer rejects absolute or traversing paths, Unicode/case-normalized duplicates, symbolic links, encrypted entries, unsupported compression methods, malformed ZIP/JSON structure, and configured size or ratio violations. Defaults are 20 GiB archive, 100,000 entries, 20 GiB per entry, 100 GiB expanded total, and 200:1 per-entry ratio. ZIP media streams directly into authenticated encryption; diagnostic issues contain identifiers and structural errors, not journal bodies.

## Consequences

Raw ZIPs and media are encrypted and deduplicated, while JournalEntry and SourceVersion text remain visible in the local unencrypted SQLite metadata boundary established earlier. Import Folder watching, OCR/ASR, geocoding, very-large-ZIP performance work, and unified source search remain out of scope. Real-format compatibility cannot be claimed until two repository-safe, de-identified exports are supplied and pass the fixture suite.
