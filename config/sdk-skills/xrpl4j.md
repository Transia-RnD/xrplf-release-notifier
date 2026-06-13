# xrpl4j (Java) — typed transaction layout

- **Transaction models:** `xrpl4j-core/src/main/java/org/xrpl/xrpl4j/model/transactions/`
  — one `@Immutable interface <Name> extends Transaction` per transaction.
- **Registry (authoritative):** the `TransactionType` enum in
  `.../model/transactions/TransactionType.java`. **Each enum constant's string value is the
  wire-name**, e.g. `MPT_ISSUANCE_CREATE("MPTokenIssuanceCreate")`. The
  `typeMap` BiMap in `Transaction.java` corroborates which model class maps to which type.
  Unrecognized types deserialize to `UnknownTransaction` — those are NOT modeled.
- **definitions.json:** `xrpl4j-core/src/main/resources/definitions.json` (superset schema).
- **runtimeDefinitions:** NO (static resource singleton).

To inventory: read `TransactionType.java` and report **every enum constant's string value**
(excluding `UNKNOWN`) as a `typedTransactionTypes` entry.
