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

    validator_last_seen: HashMap<String, Instant>,

    // Per-validator record of recent finalized ledgers where they validated a
    // minority (non-agreed) hash — the basis for mini-fork / partition detection.
    minority_divergence: HashMap<String, VecDeque<u64>>,
    mini_fork_active: bool,

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
            validator_last_seen: HashMap::new(),
            minority_divergence: HashMap::new(),
            mini_fork_active: false,
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

        // Stall detection (check every 5s)
        if warmed_up
            && now.duration_since(self.last_stall_check).as_secs() > 5
        {
            self.last_stall_check = now;
            let secs_since_advance = now.duration_since(self.last_seq_advance).as_secs();
            if secs_since_advance > self.stall_secs && !self.chain_stalled {
                self.chain_stalled = true;
                alerts.push(Alert {
                    ts: chrono::Utc::now().to_rfc3339(),
                    severity: "CRITICAL",
                    category: "CHAIN_STALL",
                    message: format!(
                        "No new validated ledger for {}s (last seq: {}) — chain may be stalled",
                        secs_since_advance, self.highest_seq
                    ),
                    ledger_seq: Some(self.highest_seq),
                    details: serde_json::json!({
                        "seconds_since_advance": secs_since_advance,
                        "last_seq": self.highest_seq,
                    }),
                });
            }
        }

        let is_unl = self.unl_keys.contains(&mk);
        let window = self.ledgers.entry(ledger_index).or_insert_with(|| LedgerWindow {
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

    fn finalize_old_windows(&mut self) -> Vec<Alert> {
        let mut alerts = Vec::new();
        let now = Instant::now();
        let warmed_up = now.duration_since(self.started_at).as_secs() > self.warmup_secs;
        let window_duration = std::time::Duration::from_secs(self.window_secs);

        let seqs_to_finalize: Vec<u64> = self
            .ledgers
            .iter()
            .filter(|(_, w)| !w.finalized && now.duration_since(w.first_seen) > window_duration)
            .map(|(seq, _)| *seq)
            .collect();

        for seq in seqs_to_finalize {
            if let Some(window) = self.ledgers.get_mut(&seq) {
                window.finalized = true;
                self.finalized_order.push_back(seq);

                if !warmed_up {
                    continue;
                }

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
                        let max_total =
                            window.hashes.values().map(|v| v.len()).max().unwrap_or(0);
                        total.saturating_sub(max_total) * 4 >= total
                    } else {
                        max_branch_unl < self.min_validators
                    };

                    if real_fork {
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
                            ledger_seq: Some(seq),
                            details: serde_json::json!({ "branches": fork_details }),
                        });
                    }

                    // Record which UNL validators sat on a MINORITY branch this
                    // ledger (the plurality hash is "the chain"; anyone else diverged).
                    let majority_hash = window
                        .hashes
                        .iter()
                        .max_by_key(|(_, vs)| vs.iter().filter(|v| self.unl_keys.contains(*v)).count())
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
                    if !persistent.is_empty() && !self.mini_fork_active {
                        self.mini_fork_active = true;
                        let quorum_gap = self.unl_keys.len().saturating_sub(self.min_validators);
                        let severity = if persistent.len() >= quorum_gap {
                            "CRITICAL"
                        } else {
                            "WARNING"
                        };
                        persistent.sort();
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
                    } else if persistent.is_empty() {
                        self.mini_fork_active = false;
                    }
                }

                // --- QUORUM CHECK ---
                if !self.unl_keys.is_empty() {
                    let unl_count = window.unl_validators.len();
                    if unl_count < self.min_validators {
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
                            ledger_seq: Some(seq),
                            details: serde_json::json!({
                                "unl_count": unl_count,
                                "unl_size": self.unl_keys.len(),
                                "min_required": self.min_validators,
                                "missing_validators": labels(&self.names, &missing),
                            }),
                        });
                    }
                }
            }
        }

        while self.finalized_order.len() > self.max_windows {
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

        for key in &self.unl_keys {
            match self.validator_last_seen.get(key) {
                Some(last) if now.duration_since(*last) > threshold => {
                    silent.push(key.clone());
                }
                None if self.highest_seq > 0 => {
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
        let warn_at = quorum_gap.saturating_sub(1).max(self.multi_silence_threshold);

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
            "seq={} | windows={} | active_unl={}/{}",
            self.highest_seq,
            self.ledgers.len(),
            active_unl,
            self.unl_keys.len(),
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
        assert!(a.iter().any(|x| x.category == "EQUIVOCATION" && x.severity == "CRITICAL"));
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
}
