# ADR 0001: Desktop stack and process boundary

- Status: Accepted
- Date: 2026-08-23

## Decision

Use Electron 43, React, TypeScript, electron-vite, and pnpm workspaces. The Main process owns workspaces, SQLite, the object vault, key protection, dialogs, and jobs. The Renderer is sandboxed and receives only a small typed API from a context-isolated CommonJS preload.

IPC channels represent business commands. Every handler validates its sender and Zod input and returns a serializable result. Node integration, webviews, arbitrary navigation, new windows, permissions, generic filesystem access, SQL, and shell access are unavailable to the Renderer.

## Consequences

The desktop runtime can use mature Node libraries while an injected Renderer cannot turn an IPC primitive into arbitrary local access. Future clients can reuse the Application contracts without reproducing Electron-specific behavior.
