# xrpl-py (Python) — typed transaction layout

- **Transaction models:** `xrpl/models/transactions/*.py` — one snake_case file per
  transaction, each a frozen `@dataclass class <Name>(Transaction)`.
- **Registry (authoritative):** `xrpl/models/transactions/types/transaction_type.py` — the
  `TransactionType(str, Enum)`. **Each enum member's VALUE is the exact wire-name**, e.g.
  `MPTOKEN_ISSUANCE_CREATE = "MPTokenIssuanceCreate"`. The class is also exported from
  `xrpl/models/transactions/__init__.py` `__all__`.
- **definitions.json:** `xrpl/core/binarycodec/definitions/definitions.json`.
- **runtimeDefinitions:** NO (definitions are a module-level singleton).

To inventory: read `transaction_type.py` and report **every `TransactionType` enum value**
as a `typedTransactionTypes` entry — those strings ARE the wire-names. (xrpl-py models no
ledger objects, but ledger types are out of scope anyway.)
