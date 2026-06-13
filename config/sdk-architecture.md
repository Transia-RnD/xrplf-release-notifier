# XRPL SDK architecture reference

**This is human documentation, NOT operational config.** The parity agent discovers every
location itself from each repo (see `parity-skill.md`); nothing here is read by the code.
It records how each SDK is structured *today* so a human can sanity-check the agent's
output and understand the parity model. Locations drift over time — when they do, the agent
re-finds them and this doc is what you update by hand if you care to keep it current.

## The core trap: `definitions.json` != supported

Every SDK ships a binary-codec `definitions.json`. Its presence proves a feature can be
**serialized**, not that the SDK has a **typed model** for it. Concrete proof: xrpl-rust's
`definitions.json` declares MPToken / Credential / Vault / Oracle / etc., yet it has **zero
typed transaction models** for any of them — a definitions diff would falsely report it
"at parity." Real parity = typed model + registry wiring. Hence the two-level check.

## Two levels

- **Level 1 — serialization:** wire-name present in `definitions.json`
  (`TRANSACTION_TYPES` / `LEDGER_ENTRY_TYPES` / `FIELDS`).
- **Level 2 — typed support:** a typed model/class/struct/interface exists AND is wired
  into the SDK's central registry (the union/enum/map/switch a new type must be added to).

The refactor-resilient anchor is the **wire-name string literal** (e.g.
`"MPTokenIssuanceCreate"`), never a file path.

## Per-SDK snapshot (as of 2026-06)

### xrpl.js (TypeScript) — XRPLF/xrpl.js

- **Runtime definitions injection: YES.** `encode(tx, new XrplDefinitions(json))` lets the
  codec serialize unknown features at runtime; only this SDK has the clean path. So its
  serialization parity is effectively "free" — the real gap is the typed layer.
- Typed models: `packages/xrpl/src/models/transactions/` (file per tx), `.../models/ledger/`.
- Registry: `packages/xrpl/src/models/transactions/transaction.ts` (`SubmittableTransaction`
  union + the `validate()` switch) and `transactions/index.ts` (exports).
- definitions.json: `packages/ripple-binary-codec/src/enums/definitions.json` (static).

### xrpl-py (Python) — XRPLF/xrpl-py

- **Runtime definitions injection: NO.** `encode()`/`decode()` take no definitions arg;
  the map is a module global loaded at import. New features need a shipped definitions file.
- Typed models: `xrpl/models/transactions/` (dataclass per tx). **No ledger-entry models.**
- Registry: `xrpl/models/transactions/types/transaction_type.py` (`TransactionType` enum)
  + `xrpl/models/transactions/__init__.py` `__all__` (resolved via `getattr`).
- definitions.json: `xrpl/core/binarycodec/definitions/definitions.json` (static).

### xrpl4j (Java) — XRPLF/xrpl4j

- **Runtime definitions injection: NO** (static resource singleton). Unknown txs deserialize
  to `UnknownTransaction` (fails open, no typed accessors).
- Typed models: `xrpl4j-core/.../model/transactions/` (immutables interfaces),
  `.../model/ledger/`.
- Registry: `TransactionType.java` enum + `Transaction.java` `typeMap` BiMap; ledger:
  `LedgerObject.java` `@JsonSubTypes`; new wire type: `SerializedType.java` typeMap.
- definitions.json: `xrpl4j-core/src/main/resources/definitions.json` — **superset schema**
  with extra sections (`*_FLAGS`, `*_FORMATS`); parse defensively.

### xrpl-go (Go) — XRPLF/xrpl-go

Not hand-audited yet — the parity agent discovers its structure at run time (typed-model
package, registry, and `definitions.json` location). Add a snapshot here once a run
confirms the layout.

### xrpl-rust (Rust) — XRPLF/xrpl-rust

- **Runtime definitions injection: NO** at the typed layer; the binary codec is map-driven
  so it tolerates new fields from definitions.json, but exposes no typed API.
- Typed models: `src/models/transactions/` (struct per tx), `src/models/ledger/objects/`.
- Registry: `src/models/transactions/mod.rs` `TransactionType` enum.
- **Significantly behind:** typed models stop around the XChainBridge era. MPToken,
  Credential, Vault, Oracle, PermissionedDomain, DID, Batch, etc. exist only in
  `definitions.json` — the canonical false-parity case.
