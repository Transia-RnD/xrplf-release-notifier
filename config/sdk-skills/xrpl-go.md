# xrpl-go (Go) — typed transaction layout

- **Transaction models:** `xrpl/transaction/*.go` — one snake_case file per transaction
  (e.g. `account_set.go`, `amm_bid.go`), each defining a `struct` for that transaction that
  embeds `BaseTx` and implements the transaction interface (typically a `TxType()` method).
  The **wire-name is the PascalCase struct name** (e.g. `AccountSet`, `MPTokenIssuanceCreate`).
  Ignore `*_test.go` files and shared helpers (`BaseTx`, `FlatTransaction`, etc.).
- **definitions.json:** under the binary-codec area (e.g. `binary-codec/definitions/
  definitions.json`); locate by filename. Presence there is serialization only, not a model.
- **runtimeDefinitions:** verify in the codec; default NO unless you find an injection path.

To inventory: list `xrpl/transaction/`, take each non-test `.go` file that defines a
transaction struct, and report its struct/`TxType()` wire-name as a `typedTransactionTypes`
entry.
