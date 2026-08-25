# Case Binder directory format v1

A Case Binder is an ordinary, self-contained directory created from an explicit, revision-bound preview. The destination must not exist. Export writes a sibling staging directory and atomically renames it only after every selected original and derived attachment verifies successfully.

```text
<binder>/
├── case-summary.pdf
├── 01_timeline/timeline.json
├── 02_statements/statements.json
├── 03_people/people.json
├── 04_evidence-index/evidence.json
├── 05_originals/
├── 06_transcripts/
├── manifest.json
└── sha256sums.txt
```

`05_originals` contains byte-for-byte decrypted copies of explicitly selected original Assets. Redaction never changes those bytes. `06_transcripts` contains only explicitly selected `DerivedArtifact` objects and never classifies them as originals. Either directory may be absent when empty.

## `manifest.json`

The UTF-8 JSON document has `formatVersion: 1` and records:

- Case ID and exact Case revision;
- generation time, generator identity, and generator version;
- the complete selection/redaction profile;
- each selected Event ID and the revision observed at export;
- one entry for every generated, original, or derived payload file;
- POSIX relative path, classification, byte size, and exported-file SHA-256;
- source entity ID where applicable;
- the pre-export plaintext SHA-256 for originals.

The manifest does not contain a recovery package or a Workspace Key envelope.

## `sha256sums.txt`

Each line is compatible with the conventional SHA-256 checksum format:

```text
<64 lowercase hex characters><two spaces><POSIX relative path>
```

Paths never begin with `/`, contain `..`, or use platform-specific separators. The list covers every exported file, including `manifest.json`, except `sha256sums.txt` itself. From inside the Binder, a standard implementation can verify it with:

```bash
sha256sum -c sha256sums.txt
```

On macOS, equivalent verification can be performed by hashing each listed path with `shasum -a 256` and comparing the first column.

## Failure and privacy rules

- A stale Case revision invalidates the preview.
- Any selected missing, deleted, corrupt, unauthenticated, wrong-size, or wrong-hash object prevents directory commit.
- File names are normalized, reserved path characters are replaced, and stable numeric prefixes prevent collisions.
- PDF/JSON text and exported names follow the preview redaction profile. Original file bytes may still contain sensitive content and the preview must warn about that fact.
