# ADR 0010: Phase 6 local media and continuous-memory boundaries

- Status: Accepted for the Phase 6 Core boundary
- Date: 2026-08-25

## Context

Media attachments have little long-term value when their text cannot participate in search, citation, and review. Day One exports also need a low-friction incremental path, while periodic review must remain deterministic and useful without turning the desktop application into an opaque background service. These capabilities process highly sensitive plaintext and user-selected executables, so the process, path, storage, and notification boundaries must be explicit.

## Decision

`@grudge-vault/media-pipeline` defines the local media adapter boundary. The shipping adapter uses user-installed Tesseract plus Poppler for PNG/JPEG/WebP/TIFF/PDF OCR and FFmpeg plus `whisper-cli` for MP3/MP4/WAV/OGG/WebM/FLAC audio. It does not download engines, language packs, or models. Main selects every path through a system dialog, probes required flags/version/languages, and stores paths only in a machine-local `local-intelligence.json` written with mode `0600`.

All subprocesses use absolute paths, `shell: false`, a minimal environment, one Whisper processor, profile-bounded threads, and explicit time, captured-output, derived-output, PDF-page, and temporary-space limits. Locking, cancellation, and application exit terminate active processing. Decrypted inputs and intermediary WAV/page images live only under the workspace vault temporary directory and are removed in a `finally` path.

OCR and Transcript payloads use versioned JSON contracts and are encrypted as ordinary vault objects. `inputHash` covers the source SHA-256, processor contract, engine/model identity, and settings. SQLite v7 retains immutable historical versions and atomically changes a `(sourceAssetId, kind)` current projection together with the search document. A failed task never changes that projection. FTS5 and optional Embedding index only the current version.

The Main-owned Import Folder monitor accepts one explicitly selected directory outside the workspace. It considers only top-level regular `.zip` files, waits for size and modification time to stabilize, scans immediately, watches filesystem events, and reconciles every five minutes while the workspace is unlocked. Archive SHA-256 is the durable dedupe key. External absolute paths remain machine-local and never enter SQLite, snapshots, job payloads, or errors/logs. Imported ciphertext is passed into the existing Day One validation and job path.

The continuous-memory scheduler runs on startup/unlock and every fifteen minutes. Stable local-calendar keys identify the latest completed month, latest completed quarter, and current ISO week, limiting first-upgrade backfill to one month and one quarter. Monthly/quarterly Reviews and weekly aggregates for important or rights-related open Clarifications create persistent in-app Reminders. System notifications are opt-in, generic, and best effort; the Reminder table is authoritative.

Agent Tool Registry v3 exposes source kind and derived references for retrieval and citations. OCR adds the `ocr_excerpt` Enhanced category and therefore requires renewed per-category consent. No Agent tool may start historical processing, cancel jobs, choose paths, or mutate local engine settings.

## Consequences

Users supply and trust their local binaries and models, and capability availability varies by machine. Media understanding remains entirely offline and originals remain unchanged. The full derived artifact is encrypted, but OCR/Transcript text required for search is deliberately unencrypted SQLite metadata and is disclosed as such in the UI and README. The workspace and backup manifest stay v2; SQLite advances to v7. Video understanding, built-in model distribution, synchronization, new data sources, new clients, and third-party Skills/plugins remain outside this decision.
