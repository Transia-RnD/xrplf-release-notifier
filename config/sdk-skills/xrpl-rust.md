# xrpl-rust (Rust) — typed transaction layout

- **Transaction models:** `src/models/transactions/*.rs` — one snake_case file per
  transaction, each a `struct` embedding `CommonFields`.
- **Registry (authoritative):** the `TransactionType` enum in
  `src/models/transactions/mod.rs`. **Each enum variant name is the wire-name** (PascalCase),
  e.g. `MPTokenIssuanceCreate`. This enum is the parity ceiling — a transaction is modeled
  iff it has a variant here (and a matching struct file).
- **definitions.json:** `src/core/binarycodec/definitions/definitions.json` (embedded via
  `include_str!`; the codec is map-driven, so definitions.json being current does NOT imply
  a typed model — do not infer support from it).
- **runtimeDefinitions:** NO (static, compiled in).

To inventory: read the `TransactionType` enum in `mod.rs` and report **every variant name**
as a `typedTransactionTypes` entry. (This SDK historically lags — many tx types are in
definitions.json but absent from the enum; those are gaps, not support.)
