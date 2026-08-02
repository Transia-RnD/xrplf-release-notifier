use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::time::Instant;

const DEFAULT_WINDOW_SECS: u64 = 12;
const DEFAULT_MAX_WINDOWS: usize = 200;
const DEFAULT_SILENCE_SECS: u64 = 120;
const DEFAULT_MULTI_SILENCE_THRESHOLD: usize = 3;
const DEFAULT_STALL_SECS: u64 = 15;
const DEFAULT_WARMUP_SECS: u64 = 30;
/// Rolling window (in ledgers) over which sustained minority-branch validation
/// is measured for mini-fork / partition detection.
const MINI_FORK_WINDOW: u64 = 64;
/// A validator on a minority branch for at least this many of the last
/// MINI_FORK_WINDOW ledgers is persistently diverging (honest validators agree
/// ~100% of the time), so a stable set of these is a partition signal.
const MINI_FORK_MIN: usize = 8;
/// Public hubs relay validations from other chains (devnet/testnet-family),
/// whose ledger seqs sit nowhere near mainnet's. A non-UNL validation more than
/// this many ledgers from the UNL anchor is another network's ledger. Mainnet
/// closes ~21,600 ledgers/day, so 5,000 tolerates hours of anchor staleness.
const FOREIGN_CHAIN_SLACK: u64 = 5_000;
/// A validation this far behind the tip is a lagging node replaying history
/// (observed live: a tracking node re-validating ledgers ~4,700 behind). It
/// must not open a quorum window — the tip-time validations it would be judged
/// against are long gone, so the window could only ever read as low-quorum.
const STALE_LEDGER_SLACK: u64 = 256;

fn ts() -> String {
    chrono::Utc::now().format("%H:%M:%S").to_string()
}

/// Human label for a validator key: its name if known, else a short key.
/// A free function so it borrows only the names map, not all of `self` — callers
/// use it while a `LedgerWindow` (a different field) is mutably borrowed.
fn label(names: &HashMap<String, String>, key: &str) -> String {
    match names.get(key) {
        Some(name) => name.clone(),
        None => format!("{}…", &key[..12.min(key.len())]),
    }
}

fn labels(names: &HashMap<String, String>, keys: &[String]) -> Vec<String> {
    keys.iter().map(|k| label(names, k)).collect()
}

#[derive(Debug, Serialize)]
pub struct Alert {
    pub ts: String,
    pub severity: &'static str,
    pub category: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ledger_seq: Option<u64>,
    #[serde(skip_serializing_if = "serde_json::Value::is_null")]
    pub details: serde_json::Value,
}

struct LedgerWindow {
    first_seen: Instant,
    hashes: HashMap<String, HashSet<String>>,
    all_validators: HashSet<String>,
    unl_validators: HashSet<String>,
    finalized: bool,
    equivocators: HashSet<String>,
}

pub struct DetectionEngine {
    unl_keys: HashSet<String>,
    names: HashMap<String, String>,
    min_validators: usize,

    ledgers: HashMap<u64, LedgerWindow>,
    finalized_order: VecDeque<u64>,
    // Observed UNL-validation count per finalized ledger, aligned with
    // `finalized_order`. Its rolling max is the proof-of-coverage used to gate
    // fork/quorum verdicts (don't page when we simply under-observed).
    observed_unl_counts: VecDeque<usize>,

    validator_last_seen: HashMap<String, Instant>,

    // Per-validator record of recent finalized ledgers where they validated a
    // minority (non-agreed) hash — the basis for mini-fork / partition detection.
    minority_divergence: HashMap<String, VecDeque<u64>>,
    // Last-alerted mini-fork (severity, diverging-set size), so a set that grows
    // or escalates WARNING→CRITICAL re-fires instead of latching on the first hit.
    mini_fork_last: Option<(&'static str, usize)>,

    // Highest ledger seq validated by a trusted UNL key. UNL keys only sign
    // mainnet, so this anchors which chain "the chain" is (see FOREIGN_CHAIN_SLACK).
    unl_anchor_seq: u64,
    dropped_foreign: u64,
    dropped_stale: u64,
    highest_seq: u64,
    last_seq_advance: Instant,
    chain_stalled: bool,
    last_silence_check: Instant,
    last_stall_check: Instant,
    started_at: Instant,

    window_secs: u64,
    max_windows: usize,
    silence_secs: u64,
    multi_silence_threshold: usize,
    stall_secs: u64,
    warmup_secs: u64,
}

impl DetectionEngine {
    pub fn new(unl_keys: HashSet<String>, min_validators: Option<usize>) -> Self {
        let min = min_validators.unwrap_or_else(|| {
            if unl_keys.is_empty() {
                20
            } else {
                (unl_keys.len() * 4).div_ceil(5)
            }
        });

        eprintln!(
            "[{}] detection engine: {} UNL keys, min_validators={}",
            ts(),
            unl_keys.len(),
            min
        );

        let now = Instant::now();
        Self {
            unl_keys,
            names: HashMap::new(),
            min_validators: min,
            ledgers: HashMap::new(),
            finalized_order: VecDeque::new(),
            observed_unl_counts: VecDeque::new(),
            validator_last_seen: HashMap::new(),
            minority_divergence: HashMap::new(),
            mini_fork_last: None,
            unl_anchor_seq: 0,
            dropped_foreign: 0,
            dropped_stale: 0,
            highest_seq: 0,
            last_seq_advance: now,
            chain_stalled: false,
            last_silence_check: now,
            last_stall_check: now,
            started_at: now,
            window_secs: DEFAULT_WINDOW_SECS,
            max_windows: DEFAULT_MAX_WINDOWS,
            silence_secs: DEFAULT_SILENCE_SECS,
            multi_silence_threshold: DEFAULT_MULTI_SILENCE_THRESHOLD,
            stall_secs: DEFAULT_STALL_SECS,
            warmup_secs: DEFAULT_WARMUP_SECS,
        }
    }

    /// Attach a validator key → human name map (e.g. `nH… → "anodos.finance"`)
    /// so alerts identify who a validator is, not just its key.
    pub fn set_names(&mut self, names: HashMap<String, String>) {
        self.names = names;
    }

    pub fn process_validation(
        &mut self,
        master_key: Option<&str>,
        ledger_hash: &str,
        ledger_index: u64,
    ) -> Vec<Alert> {
        let mut alerts = Vec::new();

        let mk = match master_key {
            Some(k) if !k.is_empty() => k.to_string(),
            _ => return alerts,
        };

        // Foreign-chain guard: a non-UNL validation far from the UNL anchor is
        // another network's ledger relayed by a public hub — it must not open a
        // window, advance highest_seq, or be quorum-judged.
        let is_unl = self.unl_keys.contains(&mk);
        if is_unl {
            if ledger_index > self.unl_anchor_seq {
                self.unl_anchor_seq = ledger_index;
            }
        } else if self.unl_anchor_seq > 0
            && ledger_index.abs_diff(self.unl_anchor_seq) > FOREIGN_CHAIN_SLACK
        {
            self.dropped_foreign += 1;
            if self.dropped_foreign == 1 || self.dropped_foreign.is_multiple_of(500) {
                eprintln!(
                    "[{}] dropping foreign-chain validation: seq {} vs UNL anchor {} ({} dropped so far)",
                    ts(),
                    ledger_index,
                    self.unl_anchor_seq,
                    self.dropped_foreign
                );
            }
            return alerts;
        }

        // Stale-ledger guard: a validation far behind the tip is a lagging node
        // replaying history — it must not open a quorum window, and does not
        // count as tip-liveness for silence detection.
        if self.highest_seq > 0 && ledger_index + STALE_LEDGER_SLACK < self.highest_seq {
            self.dropped_stale += 1;
            if self.dropped_stale == 1 || self.dropped_stale.is_multiple_of(500) {
                eprintln!(
                    "[{}] dropping stale validation: seq {} is {} behind tip {} ({} dropped so far)",
                    ts(),
                    ledger_index,
                    self.highest_seq - ledger_index,
                    self.highest_seq,
                    self.dropped_stale
                );
            }
            return alerts;
        }

        let now = Instant::now();
        let warmed_up = now.duration_since(self.started_at).as_secs() > self.warmup_secs;

        self.validator_last_seen.insert(mk.clone(), now);

        if ledger_index > self.highest_seq {
            if warmed_up && self.highest_seq > 0 && ledger_index > self.highest_seq + 5 {
                let was_stalled = self.chain_stalled;
                let severity = if was_stalled { "CRITICAL" } else { "WARNING" };
                let category = if was_stalled {
                    "STALL_RECOVERY"
                } else {
                    "SEQUENCE_GAP"
                };
                alerts.push(Alert {
                    ts: chrono::Utc::now().to_rfc3339(),
                    severity,
                    category,
                    message: format!(
                        "Ledger sequence jumped {} -> {} (gap of {}){}",
                        self.highest_seq,
                        ledger_index,
                        ledger_index - self.highest_seq,
                        if was_stalled {
                            " — CHAIN RESUMED AFTER STALL (possible fork adoption)"
                        } else {
                            ""
                        }
                    ),
                    ledger_seq: Some(ledger_index),
                    details: serde_json::json!({
                        "previous_seq": self.highest_seq,
                        "new_seq": ledger_index,
                        "gap": ledger_index - self.highest_seq,
                        "was_stalled": was_stalled,
                    }),
                });
            }
            self.highest_seq = ledger_index;
            self.last_seq_advance = now;
            self.chain_stalled = false;
        }

        alerts.extend(self.check_stall(now));

        let window = self
            .ledgers
            .entry(ledger_index)
            .or_insert_with(|| LedgerWindow {
                first_seen: Instant::now(),
                hashes: HashMap::new(),
                all_validators: HashSet::new(),
                unl_validators: HashSet::new(),
                finalized: false,
                equivocators: HashSet::new(),
            });

        if !window.finalized {
            // EQUIVOCATION: this validator already signed a DIFFERENT hash for the
            // same ledger sequence. Unambiguous Byzantine behavior — page. (Zero
            // false-positive tolerance per the monitoring spec §5.)
            let already_other = window
                .hashes
                .iter()
                .any(|(h, vs)| h != ledger_hash && vs.contains(&mk));
            if already_other && window.equivocators.insert(mk.clone()) && warmed_up {
                alerts.push(Alert {
                    ts: chrono::Utc::now().to_rfc3339(),
                    severity: "CRITICAL",
                    category: "EQUIVOCATION",
                    message: format!(
                        "Validator {} signed two different hashes for ledger {} — equivocation (Byzantine / key compromise)",
                        label(&self.names, &mk),
                        ledger_index
                    ),
                    ledger_seq: Some(ledger_index),
                    details: serde_json::json!({
                        "validator": label(&self.names, &mk),
                        "validator_key": mk,
                        "ledger_index": ledger_index,
                        "is_unl": is_unl,
                    }),
                });
            }

            window.all_validators.insert(mk.clone());
            window
                .hashes
                .entry(ledger_hash.to_string())
                .or_default()
                .insert(mk.clone());
            if is_unl {
                window.unl_validators.insert(mk);
            }
        }

        alerts.extend(self.finalize_old_windows());

        if warmed_up && self.last_silence_check.elapsed() > std::time::Duration::from_secs(30) {
            alerts.extend(self.check_silence());
            self.last_silence_check = Instant::now();
        }

        alerts
    }

    /// Time-driven chain-stall check (throttled to ~5s). Fires CHAIN_STALL when no
    /// new validated ledger has advanced for `stall_secs`. Called both on inbound
    /// validations and from the wall-clock `tick`, so a total stream silence
    /// (all endpoints disconnected) still trips it. Requires `highest_seq > 0` so
    /// a monitor that never connected doesn't cry stall at startup.
    fn check_stall(&mut self, now: Instant) -> Vec<Alert> {
        let mut alerts = Vec::new();
        let warmed_up = now.duration_since(self.started_at).as_secs() > self.warmup_secs;
        if !warmed_up || now.duration_since(self.last_stall_check).as_secs() <= 5 {
            return alerts;
        }
        self.last_stall_check = now;
        let secs_since_advance = now.duration_since(self.last_seq_advance).as_secs();
        if secs_since_advance > self.stall_secs && !self.chain_stalled && self.highest_seq > 0 {
            self.chain_stalled = true;
            alerts.push(Alert {
                ts: chrono::Utc::now().to_rfc3339(),
                severity: "CRITICAL",
                category: "CHAIN_STALL",
                message: format!(
                    "No new validated ledger for {}s (last seq: {}) — chain may be stalled",
                    secs_since_advance, self.highest_seq
                ),
                // Stable category-level latch key (ledger_seq -> None): a flapping
                // feed that stalls/resumes repeatedly dedups to once/24h instead
                // of posting a fresh CRITICAL per episode.
                ledger_seq: None,
                details: serde_json::json!({
                    "seconds_since_advance": secs_since_advance,
                    "last_seq": self.highest_seq,
                }),
            });
        }
        alerts
    }

    /// Wall-clock driven checks. The monitor's `select!` loop calls this on a fixed
    /// interval so stall + silence + window finalization fire during a *total*
    /// outage (quorum loss / all streams silent), when no inbound validation would
    /// otherwise drive them — the exact conditions CHAIN_STALL / VALIDATORS_SILENT
    /// exist to catch.
    pub fn tick(&mut self) -> Vec<Alert> {
        let now = Instant::now();
        if now.duration_since(self.started_at).as_secs() <= self.warmup_secs {
            return Vec::new();
        }
        let mut alerts = self.check_stall(now);
        alerts.extend(self.finalize_old_windows());
        if self.last_silence_check.elapsed() > std::time::Duration::from_secs(30) {
            alerts.extend(self.check_silence());
            self.last_silence_check = Instant::now();
        }
        alerts
    }

    fn finalize_old_windows(&mut self) -> Vec<Alert> {
        let mut alerts = Vec::new();
        let now = Instant::now();
        let warmed_up = now.duration_since(self.started_at).as_secs() > self.warmup_secs;
        let window_duration = std::time::Duration::from_secs(self.window_secs);

        // Process in ascending seq order so minority_divergence deque front-pruning
        // over the MINI_FORK_WINDOW stays monotonic (HashMap iteration is unordered).
        let mut seqs_to_finalize: Vec<u64> = self
            .ledgers
            .iter()
            .filter(|(_, w)| !w.finalized && now.duration_since(w.first_seen) > window_duration)
            .map(|(seq, _)| *seq)
            .collect();
        seqs_to_finalize.sort_unstable();

        for seq in seqs_to_finalize {
            if let Some(window) = self.ledgers.get_mut(&seq) {
                window.finalized = true;
                self.finalized_order.push_back(seq);
                self.observed_unl_counts
                    .push_back(window.unl_validators.len());

                if !warmed_up {
                    continue;
                }

                // Proof-of-coverage: only trust fork/quorum verdicts once the
                // pipeline has actually observed >= quorum UNL validators for some
                // recent ledger. A single laggy endpoint that under-counts must not
                // fire FORK/LOW_QUORUM every ledger on a healthy network.
                let coverage_ok = self.observed_unl_counts.iter().copied().max().unwrap_or(0)
                    >= self.min_validators;

                // --- FORK DETECTION ---
                if window.hashes.len() > 1 {
                    let mut fork_details = Vec::new();
                    for (hash, validators) in &window.hashes {
                        let unl_on_hash: Vec<&String> = validators
                            .iter()
                            .filter(|v| self.unl_keys.contains(*v))
                            .collect();
                        fork_details.push(serde_json::json!({
                            "hash": &hash[..16.min(hash.len())],
                            "total_validators": validators.len(),
                            "unl_validators": unl_on_hash.len(),
                            "unl_keys": unl_on_hash,
                        }));
                    }

                    // A genuine fork = NO branch reached quorum, so the network
                    // can't finalize the ledger on any single hash. A lopsided
                    // split — one branch has quorum and the rest are a handful of
                    // out-of-sync stragglers (e.g. 32-vs-1) — is normal consensus
                    // noise and finalizes fine, so it must NOT alert.
                    let max_branch_unl = window
                        .hashes
                        .values()
                        .map(|vs| vs.iter().filter(|v| self.unl_keys.contains(*v)).count())
                        .max()
                        .unwrap_or(0);

                    let real_fork = if self.unl_keys.is_empty() {
                        // No UNL to judge quorum: require a roughly balanced split
                        // (minority branch ≥ 25% of validators).
                        let total = window.all_validators.len();
                        let max_total = window.hashes.values().map(|v| v.len()).max().unwrap_or(0);
                        total.saturating_sub(max_total) * 4 >= total
                    } else {
                        max_branch_unl < self.min_validators
                    };

                    // Gate on coverage (S8): with a UNL, only alert once we've proven
                    // the pipeline can see quorum, so under-observation doesn't fire.
                    if real_fork && (self.unl_keys.is_empty() || coverage_ok) {
                        alerts.push(Alert {
                            ts: chrono::Utc::now().to_rfc3339(),
                            severity: "CRITICAL",
                            category: "FORK_DETECTED",
                            message: format!(
                                "Ledger {} forked — {} UNL validators split across {} hashes, no branch reached quorum ({})",
                                seq,
                                window.unl_validators.len(),
                                window.hashes.len(),
                                self.min_validators
                            ),
                            // Stable category-level latch key (ledger_seq -> None):
                            // a sustained fork dedups to once/24h instead of paging
                            // every ~12s as the affected ledger changes.
                            ledger_seq: None,
                            details: serde_json::json!({ "ledger_index": seq, "branches": fork_details }),
                        });
                    }

                    // Record which UNL validators sat on a MINORITY branch this
                    // ledger (the plurality hash is "the chain"; anyone else diverged).
                    let majority_hash = window
                        .hashes
                        .iter()
                        .max_by_key(|(_, vs)| {
                            vs.iter().filter(|v| self.unl_keys.contains(*v)).count()
                        })
                        .map(|(h, _)| h.clone());
                    if let Some(maj) = majority_hash {
                        for (hash, validators) in &window.hashes {
                            if hash == &maj {
                                continue;
                            }
                            for v in validators {
                                if self.unl_keys.contains(v) {
                                    self.minority_divergence
                                        .entry(v.clone())
                                        .or_default()
                                        .push_back(seq);
                                }
                            }
                        }
                    }
                }

                // --- MINI-FORK: sustained per-validator disagreement ---
                // A single-ledger split is timing noise; the SAME validators on a
                // minority branch across many ledgers is a partitioned / private-
                // peer cluster, even while the main network keeps quorum (scenario
                // 06 / monitoring-signals §5).
                if !self.unl_keys.is_empty() {
                    let cutoff = seq.saturating_sub(MINI_FORK_WINDOW);
                    let mut persistent: Vec<String> = Vec::new();
                    for (v, dq) in self.minority_divergence.iter_mut() {
                        while dq.front().is_some_and(|&s| s < cutoff) {
                            dq.pop_front();
                        }
                        if dq.len() >= MINI_FORK_MIN {
                            persistent.push(v.clone());
                        }
                    }
                    if persistent.is_empty() {
                        self.mini_fork_last = None;
                    } else {
                        persistent.sort();
                        let quorum_gap = self.unl_keys.len().saturating_sub(self.min_validators);
                        let severity = if persistent.len() >= quorum_gap {
                            "CRITICAL"
                        } else {
                            "WARNING"
                        };
                        let size = persistent.len();
                        // Re-fire on escalation only: severity climbing to CRITICAL,
                        // or the diverging set growing. Steady state stays latched.
                        let escalated = match self.mini_fork_last {
                            None => true,
                            Some((last_sev, last_size)) => {
                                (severity == "CRITICAL" && last_sev != "CRITICAL")
                                    || size > last_size
                            }
                        };
                        if escalated {
                            self.mini_fork_last = Some((severity, size));
                            let named = labels(&self.names, &persistent);
                            alerts.push(Alert {
                                ts: chrono::Utc::now().to_rfc3339(),
                                severity,
                                category: "MINI_FORK",
                                message: format!(
                                    "{} validator(s) persistently on a minority branch over the last {} ledgers ({}) — possible partition or private-peer cluster",
                                    persistent.len(),
                                    MINI_FORK_WINDOW,
                                    named.join(", ")
                                ),
                                ledger_seq: None,
                                details: serde_json::json!({ "validators": named, "validator_keys": persistent }),
                            });
                        }
                    }
                }

                // --- QUORUM CHECK ---
                if !self.unl_keys.is_empty() {
                    let unl_count = window.unl_validators.len();
                    // Gate on coverage (S8): a single under-observing endpoint must
                    // not report every ledger as low-quorum on a healthy network.
                    if unl_count < self.min_validators && coverage_ok {
                        let missing: Vec<String> = self
                            .unl_keys
                            .iter()
                            .filter(|k| !window.unl_validators.contains(*k))
                            .cloned()
                            .collect();

                        let severity = if unl_count < self.min_validators / 2 {
                            "CRITICAL"
                        } else {
                            "WARNING"
                        };

                        alerts.push(Alert {
                            ts: chrono::Utc::now().to_rfc3339(),
                            severity,
                            category: "LOW_QUORUM",
                            message: format!(
                                "Ledger {} has {}/{} UNL validations (need {}, missing {})",
                                seq,
                                unl_count,
                                self.unl_keys.len(),
                                self.min_validators,
                                missing.len()
                            ),
                            // Stable per-severity latch key (ledger_seq -> None) so a
                            // sustained low-quorum dedups to once/24h (S7).
                            ledger_seq: None,
                            details: serde_json::json!({
                                "ledger_index": seq,
                                "unl_count": unl_count,
                                "unl_size": self.unl_keys.len(),
                                "min_required": self.min_validators,
                                "missing_validators": labels(&self.names, &missing),
                                "missing_validator_keys": missing,
                            }),
                        });
                    }
                }
            }
        }

        while self.finalized_order.len() > self.max_windows {
            self.observed_unl_counts.pop_front();
            if let Some(old_seq) = self.finalized_order.pop_front() {
                self.ledgers.remove(&old_seq);
            }
        }

        alerts
    }

    fn check_silence(&self) -> Vec<Alert> {
        if self.unl_keys.is_empty() {
            return Vec::new();
        }

        let mut alerts = Vec::new();
        let now = Instant::now();
        let threshold = std::time::Duration::from_secs(self.silence_secs);

        let mut silent: Vec<String> = Vec::new();
        let mut never_seen: Vec<String> = Vec::new();

        // Pipeline-ready = we've actually observed a quorum-sized set of distinct
        // UNL validators at least once. Until then, a not-yet-seen UNL key is
        // startup/relay lag on a sparse endpoint, not an outage — so don't count
        // `never_seen` and fabricate a cold-start "QUORUM LOST" (S9).
        let unl_seen_ever = self
            .unl_keys
            .iter()
            .filter(|k| self.validator_last_seen.contains_key(*k))
            .count();
        let pipeline_ready = unl_seen_ever >= self.min_validators;

        for key in &self.unl_keys {
            match self.validator_last_seen.get(key) {
                Some(last) if now.duration_since(*last) > threshold => {
                    silent.push(key.clone());
                }
                None if self.highest_seq > 0 && pipeline_ready => {
                    never_seen.push(key.clone());
                }
                _ => {}
            }
        }

        let total_missing = silent.len() + never_seen.len();

        // A handful of quiet validators is normal (restarts, relay gaps). Only
        // surface when it actually threatens consensus: WARN within 1 of losing
        // quorum, CRITICAL once quorum is gone. `multi_silence_threshold` is a
        // floor so small/test UNLs still trip.
        let quorum_gap = self.unl_keys.len().saturating_sub(self.min_validators);
        let warn_at = quorum_gap
            .saturating_sub(1)
            .max(self.multi_silence_threshold);

        if total_missing >= warn_at {
            let quorum_lost = total_missing > quorum_gap;
            let severity = if quorum_lost { "CRITICAL" } else { "WARNING" };
            let tail = if quorum_lost {
                " — QUORUM LOST"
            } else {
                " — quorum margin low"
            };

            alerts.push(Alert {
                ts: chrono::Utc::now().to_rfc3339(),
                severity,
                category: "VALIDATORS_SILENT",
                message: format!(
                    "{}/{} UNL validators not validating ({} silent >{}s, {} never seen){}",
                    total_missing,
                    self.unl_keys.len(),
                    silent.len(),
                    self.silence_secs,
                    never_seen.len(),
                    tail
                ),
                ledger_seq: None,
                details: serde_json::json!({
                    "silent_validators": labels(&self.names, &silent),
                    "never_seen_validators": labels(&self.names, &never_seen),
                    "total_missing": total_missing,
                    "can_still_reach_quorum": !quorum_lost,
                }),
            });
        }

        alerts
    }

    pub fn status_summary(&self) -> String {
        let active_unl = if self.unl_keys.is_empty() {
            0
        } else {
            let now = Instant::now();
            let recent = std::time::Duration::from_secs(30);
            self.unl_keys
                .iter()
                .filter(|k| {
                    self.validator_last_seen
                        .get(*k)
                        .is_some_and(|t| now.duration_since(*t) < recent)
                })
                .count()
        };

        format!(
            "seq={} | windows={} | active_unl={}/{} | dropped_foreign={} | dropped_stale={}",
            self.highest_seq,
            self.ledgers.len(),
            active_unl,
            self.unl_keys.len(),
            self.dropped_foreign,
            self.dropped_stale,
        )
    }
}

/// Load a validator key → name map (JSON object). Missing/invalid → empty.
pub fn load_names(path: &str) -> HashMap<String, String> {
    match std::fs::read_to_string(path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

pub fn load_unl_file(path: &str) -> HashSet<String> {
    let mut keys = HashSet::new();
    let data = match std::fs::read_to_string(path) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[{}] failed to read UNL file {}: {}", ts(), path, e);
            return keys;
        }
    };
    for line in data.lines() {
        let key = line.trim();
        if key.is_empty() || key.starts_with('#') {
            continue;
        }
        keys.insert(key.to_string());
    }
    eprintln!("[{}] loaded {} UNL keys from {}", ts(), keys.len(), path);
    keys
}

#[cfg(test)]
impl DetectionEngine {
    fn force_warmup(&mut self) {
        self.started_at = Instant::now() - std::time::Duration::from_secs(3600);
    }

    /// Backdate the last-advance / last-stall-check markers so a stall condition
    /// is testable without waiting real wall-clock time.
    fn backdate_advance(&mut self, secs: u64) {
        let d = std::time::Duration::from_secs(secs);
        self.last_seq_advance = Instant::now() - d;
        self.last_stall_check = Instant::now() - d;
    }

    fn has_window(&self, seq: u64) -> bool {
        self.ledgers.contains_key(&seq)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unl(keys: &[&str]) -> HashSet<String> {
        keys.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn equivocation_flags_double_sign_once() {
        let mut e = DetectionEngine::new(unl(&["VAL1"]), Some(1));
        e.force_warmup();
        e.process_validation(Some("VAL1"), "HASH_A", 100);
        let a = e.process_validation(Some("VAL1"), "HASH_B", 100);
        assert!(a
            .iter()
            .any(|x| x.category == "EQUIVOCATION" && x.severity == "CRITICAL"));
        // repeat of the same conflicting hash does not re-alert for this ledger
        let again = e.process_validation(Some("VAL1"), "HASH_B", 100);
        assert!(!again.iter().any(|x| x.category == "EQUIVOCATION"));
    }

    #[test]
    fn honest_validators_do_not_equivocate() {
        let mut e = DetectionEngine::new(unl(&["VAL1", "VAL2"]), Some(1));
        e.force_warmup();
        e.process_validation(Some("VAL1"), "HASH_A", 100);
        let a = e.process_validation(Some("VAL2"), "HASH_A", 100);
        assert!(!a.iter().any(|x| x.category == "EQUIVOCATION"));
    }

    // B4: the wall-clock tick must drive CHAIN_STALL even when no validation
    // arrives (total outage → stream silent). Previously the stall check only ran
    // inside process_validation, so a total silence could never trip it.
    #[test]
    fn tick_fires_chain_stall_without_inbound() {
        let mut e = DetectionEngine::new(unl(&["VAL1"]), Some(1));
        e.force_warmup();
        // Chain advanced once, then the stream goes silent.
        e.process_validation(Some("VAL1"), "HASH_A", 500);
        e.backdate_advance(3600);
        let a = e.tick();
        // ledger_seq must be None: the stable latch key keeps a flapping feed
        // from posting a fresh CRITICAL per stall episode.
        assert!(a.iter().any(|x| x.category == "CHAIN_STALL"
            && x.severity == "CRITICAL"
            && x.ledger_seq.is_none()));
    }

    // Public hubs relay validations from other chains; a non-UNL validation whose
    // seq is nowhere near the UNL anchor must be dropped before it opens a window
    // (the 2026-08-02 incident: foreign ledgers 55153/4155533/19582133 each fired
    // a CRITICAL LOW_QUORUM because they naturally carry 0/35 UNL validations).
    #[test]
    fn foreign_chain_validations_ignored() {
        let mut e = DetectionEngine::new(unl(&["VAL1", "VAL2"]), Some(2));
        e.force_warmup();
        e.process_validation(Some("VAL1"), "HASH_A", 106_000_000);
        e.process_validation(Some("VAL2"), "HASH_A", 106_000_000);
        // Foreign-chain ledger from a non-UNL key: no alert, no window.
        let a = e.process_validation(Some("FOREIGN1"), "HASH_F", 55_153);
        assert!(a.is_empty());
        assert!(!e.has_window(55_153));
        // A non-UNL validator near the anchor is mainnet and still tracked.
        e.process_validation(Some("OTHER1"), "HASH_A", 106_000_001);
        assert!(e.has_window(106_000_001));
        // UNL validations always pass — they define the anchor.
        e.process_validation(Some("VAL1"), "HASH_A", 106_000_002);
        assert!(e.has_window(106_000_002));
    }

    // A lagging node replaying old ledgers (observed live: a tracker
    // re-validating a ledger ~4,700 behind the tip — inside the foreign-chain
    // slack) must not open a quorum window it can never fill.
    #[test]
    fn stale_ledger_validations_ignored() {
        let mut e = DetectionEngine::new(unl(&["VAL1"]), Some(1));
        e.force_warmup();
        e.process_validation(Some("VAL1"), "HASH_A", 106_000_000);
        // Non-UNL node replaying a ledger 4,700 behind the tip.
        e.process_validation(Some("OTHER1"), "HASH_B", 105_995_300);
        assert!(!e.has_window(105_995_300));
        // Even a UNL validator replaying history must not open a window.
        e.process_validation(Some("VAL1"), "HASH_C", 105_999_000);
        assert!(!e.has_window(105_999_000));
        // A ledger just behind the tip (normal in-flight window) still opens.
        e.process_validation(Some("OTHER2"), "HASH_A", 105_999_990);
        assert!(e.has_window(105_999_990));
    }

    // Before any UNL validation establishes the anchor (or with no UNL at all),
    // nothing is filtered — the engine behaves as before.
    #[test]
    fn no_anchor_means_no_filtering() {
        let mut e = DetectionEngine::new(unl(&["VAL1"]), Some(1));
        e.force_warmup();
        e.process_validation(Some("OTHER1"), "HASH_A", 55_153);
        assert!(e.has_window(55_153));
    }

    // S9: a monitor that has only ever seen a handful of UNL validators (sparse
    // endpoint / startup lag) must not emit a "QUORUM LOST" from `never_seen` keys.
    #[test]
    fn no_cold_start_false_quorum_lost() {
        let keys: Vec<String> = (0..10).map(|i| format!("V{i}")).collect();
        let mut e = DetectionEngine::new(keys.iter().cloned().collect(), Some(8));
        e.force_warmup();
        // Pipeline has relayed only 2 of the 10 UNL validators so far.
        e.process_validation(Some("V0"), "HASH_A", 100);
        e.process_validation(Some("V1"), "HASH_A", 100);
        let a = e.check_silence();
        assert!(!a.iter().any(|x| x.category == "VALIDATORS_SILENT"));
    }
}
