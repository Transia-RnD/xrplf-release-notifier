# Alert catalog

Every alert the observatory can raise, by source. Severity → Mattermost color:
INFO green, WARNING amber, CRITICAL red. "Dedup" is how re-fires are suppressed.

Alerting is opt-in per run: a monitor only evaluates rules when given `--webhook`
(post) or `--dry-run` (print). Without either it just does its base job.

## vlwatch — UNL propagation (always-on, observatory VM)

Watches validator-list gossip on the overlay and verifies each list's signature
chain. State: `monitors-state.json` per publisher (max sequence, expiry flags).
**Cold start** (no state file) suppresses the *delta* rules (NEW_LIST,
SEQ_REGRESSION) so a fresh deploy doesn't announce every list as new; the
absolute security rules still fire.

| Alert | Severity | Fires when | Dedup |
|-------|----------|-----------|-------|
| `NEW_LIST` | INFO | A publisher advertises a sequence above its known max — the "UNL updated" headline | per (publisher, seq) |
| `SIG_FAIL` | CRITICAL | Blob signature or manifest chain fails to verify | per (publisher, seq) |
| `UNKNOWN_PUBLISHER` | CRITICAL | A list from a key not in the publisher allowlist is propagating | once per key |
| `SEQ_REGRESSION` | WARNING | Observed sequence is below the known max (rollback / stale relay) | per (publisher, seq) |
| `EXPIRY_HORIZON` | WARNING <14d / CRITICAL <7d | The current list is nearing its expiration | once per (publisher, seq, threshold) |
| `NO_PEERS` | WARNING | vlwatch has **no active peer connections** for 10 min — can't observe the overlay (not "no new lists", which is normal — lists only gossip on connect/change) | once per gap |
| `UNL_DIVERGENCE` | WARNING | ≥2 fresh peers advertise different current sequences for a publisher for >10 min (relay split / stuck hub) | once per episode |

## crawler `monitor` — validations stream (always-on, observatory VM)

Subscribes to `validations` streams and runs the detection engine. Alerts post
with 24h hysteresis (a persistent condition re-fires at most daily).

Public hubs relay validations from other chains (devnet/testnet-family). The
engine anchors on the highest ledger seq signed by a trusted UNL key — UNL keys
only sign mainnet — and drops non-UNL validations more than 5,000 ledgers from
that anchor, so foreign ledgers (which naturally carry 0 UNL validations) never
reach the quorum/fork detectors.

| Alert | Severity | Fires when | Dedup |
|-------|----------|-----------|-------|
| `FORK_DETECTED` | CRITICAL | Conflicting ledger hashes where **no branch reached quorum** (a genuine split, not a lone straggler) | per ledger, 24h |
| `MINI_FORK` | WARNING/CRITICAL | The same validators persistently validate a **minority branch** across many ledgers — a partitioned / private-peer cluster, even while the main network keeps quorum | per episode, 24h |
| `EQUIVOCATION` | CRITICAL | A validator signed **two different hashes for the same ledger** — unambiguous Byzantine behavior / key compromise (zero-false-positive signal) | per (validator, ledger) |
| `LOW_QUORUM` | WARNING/CRITICAL | Fewer validators than the expected minimum agreed a ledger. Cross-checked against an independent validation store (xrplwin xPOP, `--crosscheck-url`) before posting: **confirmed there → CRITICAL**; store unreachable → downgraded to WARNING (unconfirmable ≠ confirmed) | per ledger, 24h |
| `RELAY_GAP` | WARNING | Our feed saw below-quorum validations for a ledger, but the missing validations **exist at the independent store** — the network had quorum; relays were lost upstream of our sources | per ledger, 24h |
| `VANTAGE_LOSS` | WARNING | One subscribed endpoint delivered ≥5 fewer UNL validations for a finalized ledger than the union of the other endpoints — live-measured relay loss at that vantage (no third-party store involved) | per source, 24h |
| `CHAIN_STALL` | WARNING/CRITICAL | No ledger progress for the stall window. Confirmed against a public RPC node (`--rpc-check-url`) before posting: **the vantage also has no newer validated ledger → CRITICAL**; vantage unreachable → WARNING (unconfirmed) | once, 24h |
| `FEED_STALL` | WARNING | Our validation feed stalled but the public RPC vantage shows the network advancing — a vantage problem, not a chain stall | once, 24h |
| `VALIDATORS_SILENT` | WARNING/CRITICAL | UNL validators missing to within 1 of losing quorum (not routine stragglers) | per gap, 24h |

## crawler `crawl` — topology snapshot (hourly, observatory VM)

BFS over `/crawl` endpoints, then compares the fresh report to the previous one.
Suspicious-version detection is **off unless** `--suspicious-version` is set.

| Alert | Severity | Fires when | Dedup |
|-------|----------|-----------|-------|
| `SUSPICIOUS_VERSION` | WARNING / CRITICAL (≥10) | Nodes advertising the configured suspicious version are present | 24h |
| `ECLIPSE_RISK` | CRITICAL (any high) / WARNING (≥3 medium) | Legitimate nodes have a majority of suspicious inbound peers | 24h |
| `TOPOLOGY_COLLAPSE` | WARNING | Reachable node count fell below 60% of the previous crawl (partition/crawl failure) | 24h |
| `NEW_VERSION` | INFO | A version absent last crawl now runs on ≥10 nodes (a release rolling out) | per version, 24h |
| `PATCH_ADOPTION` | INFO (<10% vulnerable) / WARNING / CRITICAL (≥50%) | `--min-safe-version X.Y.Z` set: share of core (rippled/xrpld) nodes at/above the hotfix version, with top vulnerable builds | on movement + 12h heartbeat while vulnerable nodes remain; at 0 vulnerable the all-clear posts once |

`PATCH_ADOPTION` is the standing version of `scripts/attack-report.py` (the
manifest-flood incident post) and keeps its classification: base semver of
`rippled-`/`xrpld-` builds, pre-releases of the fix count as patched, non-core
clients bucket as "other". Cadence: the hourly crawl always evaluates; the
dedup key encodes the patched percent, so any percentage-point move posts
immediately, while an unchanged percent re-posts only every 12h. Once no
vulnerable nodes remain the card is terminal: the all-clear posts once and the
heartbeat stops (a regression changes the percent and posts immediately). The
unit ships
`--min-safe-version 3.2.1` (the manifest-flood hotfix); bump the flag when the
next security release becomes the floor.

## crawler `amendments` — on-ledger amendment tracking (periodic, observatory VM)

Polls a public node's `ledger_entry` for the Amendments object and diffs the
enabled + majority sets. Cold start (no prior state) seeds silently.

| Alert | Severity | Fires when | Dedup |
|-------|----------|-----------|-------|
| `AMENDMENT_MAJORITY` | WARNING | An amendment reaches majority (activation ~2 weeks out) | per amendment, 24h |
| `AMENDMENT_ENABLED` | INFO | An amendment activates on the network | per amendment, 24h |
| `AMENDMENT_LOST_MAJORITY` | WARNING | An amendment falls below majority before activating | per amendment, 24h |

## crawler `nunl` — Negative UNL tracking (periodic, observatory VM)

Polls the on-ledger NegativeUNL object and diffs the disabled set.

| Alert | Severity | Fires when | Dedup |
|-------|----------|-----------|-------|
| `NUNL_DISABLED` | WARNING | A validator is added to the Negative UNL (unreliable/offline) | per validator, 24h |
| `NUNL_REENABLED` | INFO | A validator recovers and leaves the Negative UNL | per validator, 24h |

## crawler `unl-adoption` — XRPL mainnet UNL hotfix adoption (hourly, observatory VM)

Polls data.xrpl.org's validator feed (which resolves each validator's
`server_version`, `domain`, and UNL publisher), restricts to the XRPL **mainnet**
UNL (`chain == "main"`, non-empty `unl` publisher), and reports how many trusted
validators run a build at/above `--min-safe-version`. Members whose feed entry
carries no version are reported but excluded from the percentage.

| Alert | Severity | Fires when | Dedup |
|-------|----------|-----------|-------|
| `UNL_PATCH_ADOPTION` | INFO (<10% vulnerable) / WARNING / CRITICAL (≥50%) | Share of reporting UNL validators at/above the hotfix, naming the vulnerable ones by domain | on movement + 12h heartbeat while vulnerable validators remain; at 0 vulnerable the all-clear posts once |

Same cadence as the network-wide `PATCH_ADOPTION`: the dedup key encodes the
patched percent, so a change posts immediately and an unchanged percent
re-posts every 12h — until no vulnerable validators remain, at which point the
100% card posts once and the heartbeat stops. RCs of the fix count as
vulnerable (the fix lands in the final). Unit ships `--min-safe-version 3.2.1`.

**Why this and not the validations stream:** the overlay binds a build version
only to a node key and validator identity only to a master key, and the two
never cross on the wire — validations carry **no** `ServerVersion` (verified
live: 0/300 in the raw validation binary, so no admin/private endpoint can
surface it either). data.xrpl.org already does the master-key→version resolution
out-of-band, so this consumes that rather than trying to observe it passively.
The old `monitor --min-version` / `VALIDATOR_VERSION_LAG` decoder is retained but
inert (validations never carry the field); `unl-adoption` supersedes it.

## notifier watchdog — external vantage (Cloud Run, every 15 min) — planned

The one thing the monitors can't self-report: whether they and the stage node
are alive. Runs in the TS service, posts to the same webhook.

| Alert | Severity | Fires when |
|-------|----------|-----------|
| `NODE_UNREACHABLE` | CRITICAL | `unl.xrpl.foundation/healthz` or public-WS `server_info` fails 2 windows running |
| `BAD_SERVER_STATE` | WARNING→CRITICAL | Public-WS `server_state` not in {full, proposing, validating} |
| `OBSERVATORY_STALE` | CRITICAL | Observatory heartbeat object missing/old, or a monitor unit inactive |
| `LOGS_STALE` | WARNING | No new logmon JSONL in the log bucket for >3h (log pipeline died) |
| `LOG_ERRORS` | WARNING/CRITICAL | ERR/FTL count or configured patterns cross threshold in shipped stage-node logs |

## Not here (owned elsewhere)

Staged-list / burn-in / node-health alerts on the validator itself are already
posted by the on-node `unl-monitor.sh` (in the `xrplf-unl-validator` repo). We
do **not** duplicate those; the watchdog only covers the case where that on-node
monitor is itself down (`NODE_UNREACHABLE`).
