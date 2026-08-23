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
