# xrpl.js (TypeScript) — typed transaction layout

- **Transaction models:** `packages/xrpl/src/models/transactions/*.ts` — one file per
  transaction, each `export interface <Name> extends BaseTransaction` plus a
  `validate<Name>()` function. The **wire-name is the interface name** (PascalCase), e.g.
  `MPTokenIssuanceCreate`.
- **Registry:** `packages/xrpl/src/models/transactions/transaction.ts` — the
  `SubmittableTransaction` union and the `validate()` `switch`. A transaction is fully
  modeled when it appears in that union (and has a `validate<Name>` case). The exports in
  `transactions/index.ts` corroborate it.
- **definitions.json:** `packages/ripple-binary-codec/src/enums/definitions.json`.
- **runtimeDefinitions:** YES — `new XrplDefinitions(...)` can be passed to `encode`/`decode`.

To inventory: list `packages/xrpl/src/models/transactions/`, take each `<Name>.ts` interface
that extends a transaction base and is in the `SubmittableTransaction` union; report each
interface name as a `typedTransactionTypes` entry.
