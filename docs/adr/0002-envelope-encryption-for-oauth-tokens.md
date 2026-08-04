# ADR 0002 — Envelope encryption for OAuth tokens and mail bodies

**Status:** Accepted · **Date:** 2026-08-04

## Context

We hold OAuth refresh tokens that grant read/send access to users' mailboxes. A database
compromise without further controls would be catastrophic and unrecoverable — refresh tokens
are long-lived and there is no way to know which were exfiltrated. We also cache email bodies,
which are the most sensitive content in the system.

Column-level encryption with a single application key is insufficient: one leaked key exposes
every record, and rotation requires rewriting the entire table under load.

## Decision

Envelope encryption:

1. A **KEK** (key-encryption key) lives in a KMS (AWS KMS / Azure Key Vault / GCP KMS), never
   in application memory in plaintext beyond a short-lived data-key cache.
2. Each encrypted record gets its own **DEK** (data-encryption key), generated per record.
3. The DEK encrypts the payload with **AES-256-GCM**; the wrapped DEK, IV, auth tag and
   `keyVersion` are stored alongside the ciphertext.
4. Additional authenticated data (AAD) binds the ciphertext to its record — `userId:field` —
   so ciphertext cannot be moved between rows or fields.

Rotation re-wraps DEKs (cheap, no plaintext re-encryption) for KEK rotation, and re-encrypts
lazily on next write for DEK rotation.

In development a local KEK from `ENCRYPTION_MASTER_KEY` stands in for KMS behind the same
interface, so no code path differs between environments.

## Consequences

**Good.** A database dump alone is useless without KMS access. KEK rotation is an operation on
key material, not a table rewrite. Per-record DEKs bound the blast radius of any single key
leak. AAD prevents ciphertext substitution attacks.

**Bad.** Every decrypt is a KMS call unless data keys are cached — we cache wrapped-DEK →
plaintext-DEK in memory with a short TTL and a hard cap, accepting a small window where DEKs
live in process memory. Encrypted columns cannot be indexed or searched; where lookup is
required (e.g. email address) we store a keyed **HMAC-SHA256 blind index** next to the
ciphertext.
