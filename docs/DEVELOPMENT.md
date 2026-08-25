# Development

## Requirements

- Node.js 24.10 or newer within the Node 24 release line
- pnpm 11.23
- A native compiler toolchain supported by `better-sqlite3`
- macOS Keychain, Windows DPAPI, or Linux Secret Service/KWallet for production workspaces

Install and verify:

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

If an older Corepack installation rejects pnpm's signing key, install/run the pinned package manager explicitly with `npx --yes pnpm@11.23.0 install`.

## Desktop commands

```bash
pnpm dev
pnpm test:e2e
pnpm dist
```

`pnpm dev` starts the Main, sandboxed Preload, Vite Renderer, and local job runner. `pnpm test:e2e` builds a separate test entry with an isolated test key protector; that entry is not part of the production build. `pnpm dist` creates an unsigned package for the current platform. Cross-platform packages are built natively in GitHub Actions.

## Workspace layout

```text
workspace/
├── workspace.json
├── db/grudge-vault.sqlite3
├── vault/objects/sha256/aa/bb/<hash>.gvobj
├── vault/tmp/
└── logs/
```

`workspace.json` contains an operating-system-protected Workspace Key envelope, never the plaintext key. Original file contents are AES-256-GCM encrypted. SQLite metadata is not encrypted and may reveal filenames, hashes, messages, events, Day One source text, and task state.

New workspaces require an empty directory. On Linux, the app refuses to create or open a workspace when Electron reports the insecure `basic_text` backend.

## Phase 1 acceptance path

1. Start the app and create a workspace in an empty directory.
2. Create a Chat conversation and record an experience with **Also create an event draft** enabled.
3. Open the candidate Event, add a person, preserve an approximate or unknown date, separate facts from interpretations, and confirm it.
4. Attach a regular file; confirm that it shows its complete SHA-256 and reaches `verified` state.
5. Find the Event with a keyword, person, status, or date filter and inspect its revision history.
6. Create a `.gvbackup` snapshot, restore it into an empty directory, and confirm that Event, Source, and Asset references remain valid.
7. Quit and restart the app; confirm that the recent workspace and recorded data open automatically.

The Renderer must never receive a generic path, file-read, SQL, IPC-channel, or shell API. Dropped `File` objects are resolved inside Preload with Electron `webUtils`; JavaScript-constructed files have no trusted path and are rejected.

Built-in preview is limited to a 64 MiB allowlist of common image, audio, video, PDF, JSON, and plain-text formats. HTML, SVG, unknown formats, and larger originals must be exported through the controlled copy command. Phase 1 snapshots keep the OS-protected key envelope and are therefore recoverable only by the same operating-system account; portable key recovery remains a later milestone.

## Phase 2 acceptance path

1. Export an official Day One JSON ZIP and open **Historical backfill**.
2. Choose the ZIP. Confirm that the import history reaches `succeeded`, shows entry/new/update/skip/media/error counts, and lists missing media without exposing journal bodies in diagnostics.
3. Open **Vault** and confirm that the original ZIP and referenced media appear as encrypted assets.
4. Start Backfill with an optional import run, date range, tags, and batch size. Pause a running batch, resume it, and confirm that its persisted cursor advances without duplicate candidates.
5. Open a candidate source excerpt, inspect the detector identity/version and SourceVersion hash, then open the Event editor and add an approximate amount as an explicitly uncertain fact.
6. Confirm one candidate, ignore another, and merge a third into an existing Event. Confirm that merge adds Source/Asset references but does not replace the target narrative or structured fields.
7. Import the same ZIP again. The second run must report skipped entries without creating another SourceVersion, Asset, or candidate.
8. Create and restore a `.gvbackup` while a Backfill is unfinished. Confirm that the import report, encrypted ZIP/media, candidates, and cursor survive restoration.

Importer tests use the checked-in synthetic fixture and dynamically generated adversarial ZIPs. Compatibility sign-off against two real exports remains conditional on contributors supplying repository-safe, de-identified fixtures with platform, Day One version, export options, and redaction notes; unredacted exports must never be committed.

Default archive limits are 20 GiB for the ZIP, 100,000 entries, 20 GiB per entry, 100 GiB total expanded bytes, and a 200:1 per-entry compression ratio. The importer rejects absolute/traversal paths, normalized duplicates, symbolic links, encrypted entries, and unsupported compression before parsing journal content.

## Phase 3 acceptance path

1. Create two confirmed Events involving separately created identities for the same person. Add an alias, inspect the conservative duplicate suggestion, confirm the merge, and verify that the People timeline shows both Events.
2. Inspect the stored Event revisions and confirm that their original participant IDs were not rewritten. Revert the identity merge and verify that both People projections separate again with aliases intact.
3. Refresh related-event suggestions. Inspect the shared-person/topic/time basis and algorithm version, confirm one relation, reject another, refresh again, and verify that both decisions survive.
4. Use **Unified search** to find an Event and a Day One entry. Open both results and follow their Event/Source links back to the current record and SourceVersion excerpt. Keyword search must work while semantic search is unavailable or disabled.
5. Open **Timeline**, filter by canonical Person and date range, and confirm exact/month/range Events sort into calendar groups while relative and unknown values remain separate.
6. Generate monthly, quarterly, and custom-range Reviews. Every pattern must list supporting Event revisions and Source references. Change an Event, relation, or identity merge and confirm that the older Review becomes stale before regeneration.
7. Change Clarification priorities in the global inbox and verify ordering as rights-related, important, then normal.
8. Create and restore a `.gvbackup`; confirm that aliases, active merges, relation decisions, source indexes, Review runs, and semantic-search settings survive.

The production build intentionally ships without an Embedding Adapter. When an adapter is injected, `search.embedding-rebuild` writes a new vector generation in batches and activates it only after success. A failed rebuild must retain the former active generation. Transcript search documents are accepted by the index contract, but OCR/ASR and Transcript production remain later work.

## Phase 4 acceptance path

1. Open **Chat** and confirm the composer defaults to **Agent**, while **Quick record** still creates a Phase 1 candidate immediately and **Save source** only preserves the Message/SourceItem.
2. With no model endpoint configured, ask the Private Agent to retrieve a person history, review a period, and compare options. Confirm that no network adapter is invoked, every factual section has a valid local Event/Source/Asset citation, and unknowns remain separate from confirmed facts.
3. Ask the Agent to record an event. Confirm that the original user Message is already durable, the candidate is only a pending action, rejection writes nothing, and approval creates an `actor: agent` revision linked to that Message SourceItem.
4. Prepare an Event edit through an injected model adapter, change the Event separately, then approve the old proposal. It must become `stale` without overwriting the newer revision.
5. Ask for open Clarifications. A plain reply may immediately answer only the single Clarification explicitly shown in the preceding Agent response; ambiguous or model-proposed updates remain approval cards.
6. Configure a Private endpoint and verify that non-loopback addresses are rejected. Configure Enhanced and verify that HTTP, userinfo, query strings, fragments, and redirects are rejected.
7. Enable Enhanced with an injected fake adapter. Inspect the disclosure summary, allow it, and confirm that names, contact/account patterns, local paths, and filenames are redacted; no Asset binary or complete raw Source is sent. Adding a newly used data category must show the confirmation again.
8. Confirm that API credentials never return through IPC, are AES-256-GCM encrypted with the Workspace Key in SQLite, and can be cleared independently for Private and Enhanced.
9. Force timeout, rate-limit, invalid JSON, invalid tool arguments, guessed IDs, response-size, tool-count, and round-count failures. The raw Message must remain, the run must retain an error code and hashed audit record, and the UI must return a deterministic response while normal search/editing continues.
10. Create and restore a `.gvbackup`; confirm that Agent settings, encrypted credentials, runs, structured analyses, citations, actions, disclosures, and external-call audits survive.

Automated Adapter tests use injected `fetch`/model doubles and never contact a real service. Release verification must use Node 24 and pnpm 11.23 for lint, typecheck, unit/integration, E2E, and production build; validation under another runtime is informative but is not release sign-off.

## Phase 5 acceptance path

1. Open a v1 workspace and confirm that `workspace.json` atomically upgrades to v2, SQLite reaches migration v6, and existing GVOB v1 objects remain readable while `workspace.crypto-migrate` is queued.
2. Interrupt object/credential migration, restart, and confirm that its SQLite cursor resumes. Complete rotation and verify that every original and derived object header uses the target key before retiring slots are removed.
3. Export a `.gvrecovery` package with an untrimmed 12+ character passphrase. Confirm that wrong passphrases, tampering, another workspace, and an older epoch fail, then rebind the workspace through a different test KeyProtector.
4. Trigger manual, system-idle, suspend, and screen-lock paths. Confirm that running jobs are requeued, SQLite closes, key Buffers are zeroed, and Renderer clears entity text, paths, and preview Blob URLs. Unlock must use the OS key store.
5. Open **Evidence**, run the whole-vault scan, interrupt and resume it, and inspect per-original authentication/hash/size results. Remove an object externally and corrupt another to verify `missing` and `corrupt` remain distinct from availability tombstones.
6. Inspect deletion impact, reject the first confirmation, then delete an original and confirm its Asset tombstone and Event/Source/Import/Case links remain. Supersede another original and confirm that no existing reference is rewritten.
7. Create a Case with Events, People, Sources, original Assets, decimal multi-currency amounts, dispute points, questions, material gaps, and Evidence-to-Statement mappings. Cause an `expectedRevision` conflict and verify the newer projection wins.
8. Run the offline Legal Information Adapter. Change the Case and confirm the old `needs_external_verification` result becomes stale without presenting a legal conclusion.
9. Use Binder Wizard to select the Case revision, Events, Sources, originals, derived attachments, locale, and redaction profile. Inspect the warning that original bytes may contain sensitive content.
10. Export to a nonexistent directory. Verify `sha256sums.txt` independently, compare an exported original byte-for-byte, inspect Event revisions in `manifest.json`, and force a corrupt/missing item to confirm atomic failure cleanup.
11. Ask the Agent for Case evidence. Confirm schema v2 tools reject guessed IDs, Case writes remain approval cards, and `prepare_case_bundle` cannot choose a path or export.
12. Create and restore a v2 snapshot during mixed-key migration and after Binder audit creation. Confirm all Phase 5 database state and encrypted objects survive, while `.gvrecovery` remains outside the snapshot.

Release sign-off uses Node 24 and pnpm 11.23 for `lint`, `typecheck`, unit/integration tests, the Phase 5 E2E path, and the production build. Native packaging remains a macOS/Windows/Linux CI responsibility.
