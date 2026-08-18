# Alert catalog

Every alert the observatory can raise, by source. Severity → Mattermost color:
INFO green, WARNING amber, CRITICAL red. "Dedup" is how re-fires are suppressed.

Alerting is opt-in per run: a monitor only evaluates rules when given `--webhook`
(post) or `--dry-run` (print). Without either it just does its base job.

**Fault alerts vs status cards.** A fault alert fires on a condition and dedups
per occurrence. A *status card* (`NUNL_SUMMARY`, `AMENDMENT_SUMMARY`,
`PATCH_ADOPTION`, `UNL_PATCH_ADOPTION`) always evaluates and states the current
picture, so it has to repeat — otherwise silence can't be told apart from a dead
poller. Its cadence therefore depends on whether the picture needs action:

- **needs action** (WARNING/CRITICAL) — re-posts on the card's own window (24h for
  the summaries, 12h for adoption).
- **healthy** (INFO) — re-posts weekly. A daily all-clear was the bulk of the
  channel's volume, and observatory liveness is now reported independently by the
  notifier watchdog (`OBSERVATORY_STALE`), which is what the daily repeat was
  standing in for.
- **movement always posts immediately**, at any severity, because the dedup key
  encodes the picture itself.
- **dedup unwritable → status cards are dropped** for that run. A status card that
  can't be recorded posts again on the very next tick, so one missed card beats a
  flooded channel; fault alerts are never suppressed this way. See `DISK_LOW`.

Adoption keys band the percent (5-point buckets) and carry the severity. An exact
percent in the key meant the hourly crawl's ordinary node churn minted a fresh key
— and a post — nearly every hour; banding keeps post-on-movement for movement
that matters, while an escalation always posts because the severity changes.

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
| `PATCH_ADOPTION` | INFO (<10% vulnerable) / WARNING / CRITICAL (≥50%) | `--min-safe-version X.Y.Z` set: share of core (rippled/xrpld) nodes at/above the hotfix version, with top vulnerable builds | on 5-point movement or escalation; heartbeat 12h while the share needs action, weekly once healthy; at 0 vulnerable the all-clear posts once |

`PATCH_ADOPTION` is the standing version of `scripts/attack-report.py` (the
manifest-flood incident post) and keeps its classification: base semver of
`rippled-`/`xrpld-` builds, pre-releases of the fix count as patched, non-core
clients bucket as "other". Cadence: the hourly crawl always evaluates; the dedup
key bands the patched percent, so a 5-point move (or a severity change) posts
immediately, while a steady share re-posts every 12h — weekly once the share is
healthy. Once no vulnerable nodes remain the card is terminal: the all-clear
posts once and the heartbeat stops (a regression changes the band and posts
immediately). The unit ships
`--min-safe-version 3.2.1` (the manifest-flood hotfix); bump the flag when the
next security release becomes the floor.

## crawler `amendments` — on-ledger amendment tracking (periodic, observatory VM)

Polls a public node's `ledger_entry` for the Amendments object and reports the
current picture. Cold start reports state rather than seeding silently.

| Alert | Severity | Fires when | Dedup |
|-------|----------|-----------|-------|
| `AMENDMENT_SUMMARY` | INFO (nothing pending) / WARNING (any in majority) | Every poll: one card naming the amendments in majority with their activation dates, plus anything activated or fallen below majority since the last poll | key fingerprints both sets — a change posts immediately; steady state re-posts every 24h with amendments pending, weekly when nothing is |

Replaces the per-amendment `AMENDMENT_MAJORITY` / `AMENDMENT_ENABLED` /
`AMENDMENT_LOST_MAJORITY` events, for the same reason as `NUNL_SUMMARY`: they were
edge-triggered, so a settled network emitted nothing and silence could not be told
apart from a broken poller. A weekly repeat is enough to keep that property now
that `OBSERVATORY_STALE` reports poller liveness directly. The card leads on the
**majority** set because those
are the amendments with a deadline attached; the enabled set is a count, since
listing all ~93 daily would bury the part that needs action.

## crawler `nunl` — Negative UNL tracking (periodic, observatory VM)

Polls the on-ledger NegativeUNL object and diffs the disabled set.

| Alert | Severity | Fires when | Dedup |
|-------|----------|-----------|-------|
| `NUNL_SUMMARY` | INFO (empty) / WARNING (any listed) | Every poll: one card stating the whole current Negative UNL, naming validators added or re-enabled since the last poll | key is a fingerprint of the membership — a change posts immediately; an unchanged listing re-posts every 24h, an unchanged *empty* one weekly |
| `NUNL_CAP` | WARNING ≥20% / CRITICAL ≥25% | The listing approaches or reaches the protocol cap on Negative UNL size | per band |

`NUNL_SUMMARY` replaces the former per-validator `NUNL_DISABLED` / `NUNL_REENABLED`
events. Those were edge-triggered, so a healthy network produced no output at all
and silence was indistinguishable from a dead pipeline. The summary is a statement
of current state instead: it posts on the first poll, re-posts the moment
membership changes, and otherwise repeats — daily while validators are listed,
weekly while none are — so "nobody is on the Negative UNL" is something you are
told rather than something you infer.

## crawler `unl-adoption` — XRPL mainnet UNL hotfix adoption (hourly, observatory VM)

Polls data.xrpl.org's validator feed (which resolves each validator's
`server_version`, `domain`, and UNL publisher), restricts to the XRPL **mainnet**
UNL (`chain == "main"`, non-empty `unl` publisher), and reports how many trusted
validators run a build at/above `--min-safe-version`. Members whose feed entry
carries no version are reported but excluded from the percentage.

| Alert | Severity | Fires when | Dedup |
|-------|----------|-----------|-------|
| `UNL_PATCH_ADOPTION` | INFO (<10% vulnerable) / WARNING / CRITICAL (≥50%) | Share of reporting UNL validators at/above the hotfix, naming the vulnerable ones by domain | on 5-point movement or escalation; heartbeat 12h while the share needs action, weekly once healthy; at 0 vulnerable the all-clear posts once |

Same cadence as the network-wide `PATCH_ADOPTION`: the dedup key bands the
patched percent, so real movement posts immediately and a steady share re-posts
every 12h (weekly once healthy) — until no vulnerable validators remain, at which
point the 100% card posts once and the heartbeat stops. RCs of the fix count as
vulnerable (the fix lands in the final). Unit ships `--min-safe-version 3.2.1`.

**Why this and not the validations stream:** the overlay binds a build version
only to a node key and validator identity only to a master key, and the two
never cross on the wire — validations carry **no** `ServerVersion` (verified
live: 0/300 in the raw validation binary, so no admin/private endpoint can
surface it either). data.xrpl.org already does the master-key→version resolution
out-of-band, so this consumes that rather than trying to observe it passively.
The old `monitor --min-version` / `VALIDATOR_VERSION_LAG` decoder is retained but
inert (validations never carry the field); `unl-adoption` supersedes it.

## notifier watchdog — external vantage (Cloud Run, every 15 min)

The one thing the monitors can't self-report: whether they and the stage node
are alive. Runs in the TS service, posts to the same webhook.

| Alert | Severity | Fires when |
|-------|----------|-----------|
| `NODE_UNREACHABLE` | CRITICAL | `unl.xrpl.foundation/healthz` or public-WS `server_info` fails 2 windows running |
| `BAD_SERVER_STATE` | WARNING→CRITICAL | Public-WS `server_state` not in {full, proposing, validating} |
| `OBSERVATORY_STALE` | CRITICAL | Observatory heartbeat object missing/old, or a monitor unit inactive |
| `DISK_LOW` | WARNING ≥85% / CRITICAL ≥95% | The observatory VM's root disk is filling. Every monitor state file is written atomically (temp + rename), so a full disk fails all of them while leaving every unit `active` — dedup stops persisting and the periodic monitors re-fire the same cards each poll. Fires once per episode, rearms when the disk drains |
| `LOGS_STALE` | WARNING | No new logmon JSONL in the log bucket for >3h (log pipeline died) |
| `LOG_ERRORS` | WARNING/CRITICAL | ERR/FTL count or configured patterns cross threshold in shipped stage-node logs |

`DISK_LOW` exists because of the 2026-08-17 storm: the `monitor` unit's raw
`--output` validation dump grew unbounded (~10GB/day, never rotated, never read)
and filled the 19GB root disk. Every unit stayed `active`, so `OBSERVATORY_STALE`
saw nothing, while alert dedup silently froze and the 15-minute nUNL/amendment
polls re-posted their summary cards on every tick. Three changes close it: the raw
dump is now opt-in (`--output` unset in the unit), the heartbeat publishes
`disk_pct`, and a monitor that cannot persist dedup state suppresses its status
cards for that run rather than reposting them (fault alerts still go out).

## Not here (owned elsewhere)

Staged-list / burn-in / node-health alerts on the validator itself are already
posted by the on-node `unl-monitor.sh` (in the `xrplf-unl-validator` repo). We
do **not** duplicate those; the watchdog only covers the case where that on-node
monitor is itself down (`NODE_UNREACHABLE`).
