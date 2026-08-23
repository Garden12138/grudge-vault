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

`workspace.json` contains an operating-system-protected Workspace Key envelope, never the plaintext key. Original file contents are AES-256-GCM encrypted. Phase 0 SQLite metadata is not encrypted and may reveal filenames, hashes, sizes, and task state.

New workspaces require an empty directory. On Linux, the app refuses to create or open a workspace when Electron reports the insecure `basic_text` backend.

## Phase 0 acceptance path

1. Start the app and create a workspace in an empty directory.
2. Drop a regular file or use **Choose files**.
3. Confirm that the Asset shows its complete SHA-256 and reaches `verified` state.
4. Quit and restart the app.
5. Confirm that the recent workspace opens automatically and the same Asset remains visible.

The Renderer must never receive a generic path, file-read, SQL, IPC-channel, or shell API. Dropped `File` objects are resolved inside Preload with Electron `webUtils`; JavaScript-constructed files have no trusted path and are rejected.
