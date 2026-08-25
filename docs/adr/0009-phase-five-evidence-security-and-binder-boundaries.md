# ADR 0009: Phase 5 evidence, workspace security, and Binder boundaries

- Status: Accepted for the Phase 5 Evidence Beta boundary
- Date: 2026-08-25

## Context

Evidence workflows need stronger guarantees than an ordinary attachment list: originals must remain distinguishable from derived output, deletion and replacement must not silently rewrite history, a Case must be revision-safe, and an exported Binder must be independently verifiable. Workspace Key rotation also has to remain recoverable across crashes without exposing portable plaintext keys.

## Decision

Workspace configuration v2 stores a key ring with UUID key IDs, an epoch, active/retiring/pending slots, and OS-key-store envelopes. Opening v1 atomically writes v2 and queues object migration. GVOB v2 encrypts every object with a random content key, wraps that key with the identified Workspace Key using AES-256-GCM, authenticates the encrypted content, verifies plaintext size and SHA-256, and atomically replaces an object only after verification. SQLite v6 persists migration and integrity-scan cursors and item results. A retiring key is erased only after every original, derived object, and Agent credential has migrated and object headers confirm the target key ID.

Portable `.gvrecovery` v1 packages are explicitly exported and never enter snapshots or Binders automatically. They bind workspace ID and key epoch as authenticated data and include every live key slot. The unmodified passphrase must contain at least 12 characters. The package uses a random 16-byte salt, asynchronous scrypt `N=2^17, r=8, p=1`, and AES-256-GCM. Recovery only rebinds envelopes to an available OS key store; routine unlock never accepts a recovery package.

Main owns locking. Manual lock, system suspend/lock-screen, and the configurable system idle timer stop and requeue leased work, close SQLite, zero all key Buffers, and notify Renderer to revoke previews and clear entity state. Renderer receives no generic filesystem, SQL, shell, or IPC capability and its locked screen contains no entity body or local path.

An Asset keeps independent availability and integrity state. Deletion retains a tombstone and references while removing ciphertext; supersession creates/uses a distinct Asset and does not rewrite Event, Source, Import, or Case links. `DerivedArtifact` is immutable metadata over a separately stored object and can never satisfy `CaseEvidenceLink.assetId`.

Cases use append-only revisions and optimistic concurrency. Monetary values remain decimal strings with ISO 4217 currency, precision, certainty, and sources. Case Timeline is a projection over current selected Events, while a Binder records the Event revisions observed at export.

Binder export requires an explicit revision-bound preview followed by a user file-dialog action. Originals are included or excluded whole and are reverified immediately before export. Text redaction affects generated PDF/JSON and exported names only. A hidden sandboxed BrowserWindow with JavaScript, permissions, windows, and network access disabled implements `CaseSummaryPdfPort`; tests inject deterministic bytes. The sibling staging directory is renamed only to a nonexistent destination. `sha256sums.txt` uses POSIX relative paths and covers every file except itself. See [Case Binder format v1](../CASE_BINDER_FORMAT.md).

The Legal Information Adapter is deliberately offline. It hashes a request over jurisdiction, as-of date, and dispute topics and returns verification questions plus `needs_external_verification`; it cannot produce a substantive legal conclusion. Results become stale when the Case revision changes.

Agent Tool Registry v2 adds Evidence intent and run-local alias tools for Evidence, Cases, timelines, and gaps. Case writes remain approval actions. `prepare_case_bundle` can only request a preview card and explicitly reports that export is unavailable to the model.

## Consequences

Snapshots can preserve mixed-key migration state, and interrupted object work resumes without dropping the retiring key. Recovery files become sensitive user-managed artifacts and must be stored separately. SQLite still contains unencrypted metadata and text by design. Phase 5 establishes trusted classification and export boundaries but intentionally does not implement OCR/ASR or pixel-level redaction.
