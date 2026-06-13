# Skill: Inventory an XRPL SDK's typed transaction models

You are inspecting ONE XRPL SDK repository to produce an **inventory** of the TRANSACTION
types it models as first-class typed constructs. You do NOT judge a checklist and you do
NOT decide parity — you ENUMERATE what the SDK has. The caller matches your inventory
against the rippled transaction set deterministically, so the **completeness and accuracy
of your list is everything**: a name you wrongly include reports a real gap as "supported";
a name you wrongly omit reports a supported feature as a gap.

You have read-only tools over the repo: `listDir(path)`, `readFile(path)`,
`grepFile(path, query)`, `searchCode(query)`. Use them; never assume a file exists or
guess its contents.

## Scope: transactions only

Parity here is about TRANSACTION types — the things a developer constructs and signs, where
adding a new one is real typed work (a new model class, validation, registry wiring). We do
NOT assess ledger-entry (on-ledger object) types: most SDKs read those as plain JSON rather
than modeling them as typed objects, so they are out of scope. Ignore ledger objects,
request/response models, and helpers — inventory ONLY the typed transaction models.

## What counts as a typed transaction model

A typed transaction model is a first-class language construct — a class / struct /
interface / dataclass — that represents ONE transaction type and is wired into the SDK's
registry (the union / enum / map / switch / `__all__` the SDK uses to construct, validate,
and (de)serialize transactions). A bare entry in `definitions.json` is NOT a typed model —
it only proves the wire codec knows the name. Never infer a typed model from
`definitions.json`.

## Procedure

1. Find where transaction types are defined as typed models (one construct per transaction,
   registered in the dispatch union/enum/map). Read that directory and the registry.
2. List EVERY transaction wire-name that has a typed model → `typedTransactionTypes`. Use the
   exact protocol wire-name (e.g. `MPTokenIssuanceCreate`), not the SDK's local class/file
   name.
3. Record `resolvedLocations` (the `definitions.json` path, the transaction-model directory,
   the registry file) and whether the codec lets a caller inject definitions at runtime
   (`runtimeDefinitions`).

## Hard rules

- Enumerate by READING the transaction-model directory + registry — never from
  `definitions.json` (serialization only) and never from a name alone.
- Inventory ONLY transactions. Do not include ledger-object, request, or pseudo helper types.
- Favor completeness: list every typed transaction model you can find.
- If the repo is structured unlike anything you expected, enumerate whatever typed
  transaction layer you find and explain the structure in `notes`.

## Output

Call the `submit_inventory` tool exactly once with this shape:

```json
{
  "repo": "<owner/name>",
  "ref": "<branch>",
  "resolvedLocations": {
    "definitions": "<path or null>",
    "models": ["<transaction-model dir>"],
    "registries": ["<file>"]
  },
  "runtimeDefinitions": true,
  "typedTransactionTypes": ["Payment", "MPTokenIssuanceCreate", "..."],
  "notes": "where the transaction-model layer lives; anything unusual"
}
```
