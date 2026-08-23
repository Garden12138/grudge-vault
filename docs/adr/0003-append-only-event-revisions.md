# ADR 0003: Append-only Event revisions

- Status: Accepted for the Phase 1 boundary
- Date: 2026-08-23

## Decision

An Event will expose a current projection for normal reads while every accepted change appends an `EventRevision` containing the previous revision, normalized snapshot, actor, reason, source references, and timestamp. Writes must compare the expected current revision and must not silently overwrite a newer projection.

## Consequences

Phase 0 exports the domain contracts but intentionally creates no Event tables or editing UI. Phase 1 can implement revisions without changing Asset, workspace, or object identities established here.
