# Day One fixtures

`synthetic-minimal.zip` is generated from the adjacent synthetic source folder and is safe to commit. Unit and security tests also generate alternate layouts, UUID-free entries, media, malformed records, unsafe paths, encrypted flags, duplicates, and high compression ratios at runtime.

Phase 2 compatibility sign-off additionally requires at least two real, de-identified official JSON ZIP exports supplied by contributors. Each accepted fixture must document its platform, Day One version, export options, and redaction method. Never add an original or partially redacted journal export to this repository.
