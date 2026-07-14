/**
 * Runtime domain knowledge — "the skill the AI runs with" — for deciding
 * whether a xrpld change is BREAKING ON UPGRADE. Researched against the
 * xrpld source; the authoritative mechanisms live in:
 *   - include/xrpl/protocol/TER.h            ("DO NOT CHANGE THESE NUMBERS")
 *   - include/xrpl/protocol/{TxFormats,LedgerFormats}.h  ("hard fork" warnings)
 *   - include/xrpl/protocol/SField.h         (field tag = type<<16 | index)
 *   - include/xrpl/protocol/ApiVersion.h     (default api_version = 1; v3 = beta)
 *   - include/xrpl/protocol/detail/features.macro + Feature.{h,cpp}  (amendments)
 *   - include/xrpl/protocol/SystemParameters.h  (80% / 2-week activation)
 *   - src/xrpld/core/detail/Config.cpp        (startup throws on removed config)
 *
 * Three independent axes can "break" (a change may hit several):
 *   - PROTOCOL/WIRE: consensus hard fork — frozen enums; never done casually.
 *   - API (RPC/JSON): default-api_version field/method changes break consumers.
 *   - SDK/INTEGRATOR: new tx types/fields/ledger objects an SDK must ADD.
 * This rulebook covers the first two (what bites on the day a node upgrades).
 * The SDK "new surface" axis is detected separately and deterministically
 * (src/parity/reference.ts buildReference) — do NOT report it here.
 */
export const BREAKING_RULES = `XRP Ledger / xrpld — decide if a change is BREAKING ON UPGRADE (takes effect the moment a node runs the new binary, unconditionally — with NO amendment gate and NO api_version gate). You classify the two breaks that bite on upgrade: node-operator and default-API-consumer. New SDK surface (new tx types/fields/ledger objects) is handled elsewhere — do NOT report it here.

Classify BREAKING_NOW only if one of these holds:

1. PROTOCOL / WIRE (rare, catastrophic). A diff RENUMBERS, RETYPES, or REMOVES an EXISTING entry in a frozen table:
   - TER tec/tes result codes — source: "DO NOT CHANGE THESE NUMBERS: They appear in ledger meta data."
   - TxType (ttXxx) codes, LedgerEntryType (ltXxx) codes, SerializedTypeID — source: "Changing them ... will result in a hard fork."
   - An existing SField's (type, index) pair — that pair is the wire tag.
   Adding a NEW entry in an unused slot is ADDITIVE, not this.

2. DEFAULT API (api_version 1 or 2). A request/response field or method is removed, renamed, or retyped; an error token (string) is renamed/repurposed; or behavior visible to existing default-version clients changes. BUT if the change is gated behind \`if (apiVersion >= 3)\` (or any version above the current default of 2) with the old branch intact, it is OPT-IN — NOT breaking.

3. CONFIG / CLI / OPERATOR DEFAULT. A [section] or option is removed/renamed, startup now THROWS on an old config (Config.cpp Throw<>), or an unconditional default-behavior change (e.g. signing disabled by default, fee/reserve voting units change).

4. AMENDMENT GOVERNANCE (operator-relevant on upgrade). An EXISTING amendment's default vote flips (DefaultNo <-> DefaultYes), or an amendment is retired / obsoleted / blocked. Introducing a NEW amendment is NOT this.

A change is NOT_BREAKING — do not report — if ANY of these hold:
- AMENDMENT-GATED: the changed code path is guarded by rules().enabled(featureX) / ctx.rules.enabled(...) / a transactor's checkExtraFeatures() returning rules.enabled(...) / ammEnabled(rules), OR it is a new XRPL_FEATURE/XRPL_FIX (Supported::Yes). Gated code is DORMANT on release day — it activates only after on-ledger voting reaches 80% for 2 weeks.
- API-VERSION-GATED / OPT-IN: behind apiVersion >= 3 (beta) with the prior version preserved.
- ADDITIVE: a new optional field, a new method only under a new api_version, a new SField / transaction type / ledger object in an unused slot, a new TER code appended to a range.
- INTERNAL: refactors, tests, CI, docs, logging, performance/caching, formatting, comments; or server-side validation that leaves the wire format and result codes identical.

ABSOLUTE RULES:
- NEVER hedge. Do not write "may", "might", "could", "possibly", "appears", "likely", or "probably". Name the symbol/behavior that changed and its concrete mechanism, or classify NOT_BREAKING.
- Decide from the actual code and gate evidence provided. If you cannot confirm a change is unconditional (no amendment gate, no api_version gate) from the evidence, classify NOT_BREAKING.`
