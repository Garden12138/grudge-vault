# ADR 0005: Phase 1 recording, deletion, and backup boundaries

- Status: Accepted
- Date: 2026-08-24

## Decision

Phase 1 saves each Chat message and SourceItem before running a deterministic local Event Draft generator. The generator may extract an exact date or month only when a year is explicit; otherwise it preserves relative or unknown time and creates a Clarification. All accepted Event changes append a complete revision and compare the caller's expected current revision.

Deleting a conversation removes its title and message/source text while retaining identifiers, timestamps, and tombstones so existing Event source references remain explainable. Derived Event content is not automatically deleted.

Phase 1 backups are immutable `.gvbackup` directory snapshots containing a SQLite online backup, encrypted vault objects, `workspace.json`, and a versioned hash manifest. Restore verifies every manifest entry and referenced object before copying into an empty destination. The protected Workspace Key envelope is unchanged, so recovery is limited to the same operating-system account.

## Consequences

Recording remains useful without a model or network connection, fuzzy input is not silently made precise, and concurrent edits cannot overwrite newer projections. Source deletion is explicit without corrupting revision references. Backups preserve encrypted originals and relational identity, but portable password-based recovery and SQLite content encryption remain future work.
