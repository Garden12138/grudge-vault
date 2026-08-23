# ADR 0002: Encrypted content-addressed object vault

- Status: Accepted
- Date: 2026-08-23

## Decision

Address original objects by the SHA-256 of their plaintext. Encrypt each object independently with AES-256-GCM and a random 96-bit nonce under a Workspace Key. Store a versioned `GVOB` header, ciphertext, and authentication tag; write only encrypted temporary files and atomically move completed objects into the hash path.

The operating system key store protects the Workspace Key envelope. Linux without Secret Service or KWallet fails closed. SQLite keeps object metadata but never the key or original external path.

## Consequences

Identical content deduplicates without modifying the immutable object. Verification decrypts and re-hashes the original bytes. Filename and hash metadata remain visible in Phase 0; metadata encryption and portable key recovery remain later work.
