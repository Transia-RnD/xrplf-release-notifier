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
| `NO_DATA` | WARNING | Connected to peers but no list gossip for 30 min (watcher wedged) | once per gap |
| `PUBLISHER_MISSING` | WARNING | An allowlisted publisher unseen for >1h of observation | once per publisher until seen |
| `UNL_DIVERGENCE` | WARNING | ≥2 fresh peers advertise different current sequences for a publisher for >10 min (relay split / stuck hub) | once per episode |

## crawler `monitor` — validations stream (always-on, observatory VM)

Subscribes to `validations` streams and runs the detection engine. Alerts post
with 24h hysteresis (a persistent condition re-fires at most daily).

| Alert | Severity | Fires when | Dedup |
|-------|----------|-----------|-------|
| `FORK_DETECTED` | CRITICAL | Conflicting ledger hashes where **no branch reached quorum** (a genuine split, not a lone straggler) | per ledger, 24h |
| `MINI_FORK` | WARNING/CRITICAL | The same validators persistently validate a **minority branch** across many ledgers — a partitioned / private-peer cluster, even while the main network keeps quorum | per episode, 24h |
| `EQUIVOCATION` | CRITICAL | A validator signed **two different hashes for the same ledger** — unambiguous Byzantine behavior / key compromise (zero-false-positive signal) | per (validator, ledger) |
| `LOW_QUORUM` | WARNING/CRITICAL | Fewer validators than the expected minimum agreed a ledger | per ledger, 24h |
| `CHAIN_STALL` | CRITICAL | No ledger progress for the stall window | per ledger, 24h |
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

Ad-hoc: `scripts/attack-report.py` turns a crawl `--report-json` into a
manifest-flood **patch-adoption** post (patched ≥3.2.1 vs vulnerable). One-shot
situational tool; fold into a recurring crawl alert if we want it standing.

## crawler `amendments` — on-ledger amendment tracking (periodic, observatory VM)

Polls a public node's `ledger_entry` for the Amendments object and diffs the
enabled + majority sets. Cold start (no prior state) seeds silently.

| Alert | Severity | Fires when | Dedup |
|-------|----------|-----------|-------|
| `AMENDMENT_MAJORITY` | WARNING | An amendment reaches majority (activation ~2 weeks out) | per amendment, 24h |
| `AMENDMENT_ENABLED` | INFO | An amendment activates on the network | per amendment, 24h |
| `AMENDMENT_LOST_MAJORITY` | WARNING | An amendment falls below majority before activating | per amendment, 24h |

## crawler `nunl` — Negative UNL tracking (periodic, observatory VM)

Polls the on-ledger NegativeUNL object and diffs the disabled/pending sets.

| Alert | Severity | Fires when | Dedup |
|-------|----------|-----------|-------|
| `NUNL_DISABLED` | WARNING | A validator is added to the Negative UNL (unreliable/offline) | per validator, 24h |
| `NUNL_REENABLED` | INFO | A validator recovers and leaves the Negative UNL | per validator, 24h |
| `NUNL_PENDING_DISABLE` | WARNING | A validator is scheduled to be disabled at the next flag ledger | per validator, 24h |
| `NUNL_PENDING_REENABLE` | INFO | A validator is scheduled to be re-enabled at the next flag ledger | per validator, 24h |

## crawler `monitor --min-version` — validator upgrade adoption (post-hotfix)

| Alert | Severity | Fires when | Dedup |
|-------|----------|-----------|-------|
| `VALIDATOR_VERSION_LAG` | WARNING / CRITICAL (≥34% lag) | Validators run a build below `--min-version` (a hotfix), decoded from `server_version` in validations | 24h |

**Caveat:** `server_version` is not reliably present on the *public* validations
stream (observed ~0% coverage on s1/s2). This alert only produces signal when
`monitor` is pointed at an endpoint that relays it (e.g. the stage node's admin
WS). The decoder (rippled `BuildInfo` layout) and rule are unit-tested; with no
version data it simply no-ops.

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
