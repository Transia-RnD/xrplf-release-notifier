//! Per-vantage validation accounting — live relay-gap detection.
//!
//! Every endpoint we subscribe to is one vantage onto the validation relay
//! mesh. Observed on mainnet (2026-08-02): a single vantage (Ripple's s1/s2)
//! can lose a cohort of validators' validations for exactly one ledger while
//! other vantages receive them. Feeding validations here BEFORE the
//! cross-endpoint dedup lets us compare, per finalized ledger, which UNL
//! validators each source delivered. A source missing validators that other
//! sources delivered is a measured relay gap — no third-party store needed.

use crate::detect::Alert;
use std::collections::{HashMap, HashSet, VecDeque};
use std::time::Instant;

/// Wait this long after first sight of a ledger before comparing sources —
/// matches the detection engine's finalization window so stragglers count.
const WINDOW_SECS: u64 = 12;
/// Ledgers retained after finalization (memory bound).
const MAX_WINDOWS: usize = 200;
/// A source must be missing at least this many UNL validations that other
/// sources delivered before it alerts (1-2 is routine propagation jitter).
const MIN_GAP_TO_ALERT: usize = 5;

struct LedgerSources {
    first_seen: Instant,
    per_source: HashMap<String, HashSet<String>>,
    finalized: bool,
}

pub struct SourceTracker {
    unl_keys: HashSet<String>,
    ledgers: HashMap<u64, LedgerSources>,
    order: VecDeque<u64>,
}

impl SourceTracker {
    pub fn new(unl_keys: HashSet<String>) -> Self {
        Self {
            unl_keys,
            ledgers: HashMap::new(),
            order: VecDeque::new(),
        }
    }

    /// Record one validation sighting. Must be called for EVERY message from
    /// every endpoint (before any cross-endpoint dedup). Only UNL validators
    /// are tracked — the comparison is about quorum-relevant signal.
    pub fn record(&mut self, source: &str, master_key: Option<&str>, seq: u64) {
        if self.unl_keys.is_empty() {
            return;
        }
        let Some(mk) = master_key else { return };
        if !self.unl_keys.contains(mk) {
            return;
        }
        let entry = self.ledgers.entry(seq).or_insert_with(|| {
            self.order.push_back(seq);
            LedgerSources {
                first_seen: Instant::now(),
                per_source: HashMap::new(),
                finalized: false,
            }
        });
        entry
            .per_source
            .entry(source.to_string())
            .or_default()
            .insert(mk.to_string());

        while self.order.len() > MAX_WINDOWS {
            if let Some(old) = self.order.pop_front() {
                self.ledgers.remove(&old);
            }
        }
    }

    /// Finalize windows older than WINDOW_SECS and return an alert per source
    /// whose delivered UNL set is materially short of the cross-source union.
    /// Call from the heartbeat tick.
    pub fn tick(&mut self) -> Vec<Alert> {
        let now = Instant::now();
        let mut alerts = Vec::new();
        let mut seqs: Vec<u64> = self
            .ledgers
            .iter()
            .filter(|(_, l)| {
                !l.finalized && now.duration_since(l.first_seen).as_secs() > WINDOW_SECS
            })
            .map(|(s, _)| *s)
            .collect();
        seqs.sort_unstable();
        for seq in seqs {
            let Some(window) = self.ledgers.get_mut(&seq) else {
                continue;
            };
            window.finalized = true;
            // Sources that saw nothing for this ledger are down/disconnected,
            // which VALIDATORS_SILENT / reconnect logging already covers —
            // comparing them here would just re-alarm every outage. Gap
            // analysis is for sources that were live but under-delivered.
            if window.per_source.len() < 2 {
                continue;
            }
            for gap in evaluate(seq, &window.per_source, MIN_GAP_TO_ALERT) {
                alerts.push(gap);
            }
        }
        alerts
    }
}

/// Pure comparison: union all sources' UNL sets, then flag each source whose
/// own set is missing >= min_gap validators that at least one other delivered.
fn evaluate(seq: u64, per_source: &HashMap<String, HashSet<String>>, min_gap: usize) -> Vec<Alert> {
    let union: HashSet<&String> = per_source.values().flatten().collect();
    let mut alerts = Vec::new();
    let mut sources: Vec<&String> = per_source.keys().collect();
    sources.sort();
    for src in sources {
        let seen = &per_source[src];
        let missing: Vec<&str> = union
            .iter()
            .filter(|k| !seen.contains(**k))
            .map(|k| k.as_str())
            .collect();
        if missing.len() >= min_gap {
            alerts.push(Alert {
                ts: chrono::Utc::now().to_rfc3339(),
                severity: "WARNING",
                category: "VANTAGE_LOSS",
                message: format!(
                    "Source {} delivered {}/{} UNL validations for ledger {} — missing {} that other sources delivered (relay loss at that vantage)",
                    src,
                    seen.len(),
                    union.len(),
                    seq,
                    missing.len()
                ),
                // Stable per-source key: a lossy vantage dedups to one post
                // per 24h regardless of how many ledgers it drops.
                ledger_seq: None,
                details: serde_json::json!({
                    "ledger_index": seq,
                    "source": src,
                    "delivered": seen.len(),
                    "union": union.len(),
                    "missing_validator_keys": missing,
                }),
            });
        }
    }
    alerts
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(keys: &[&str]) -> HashSet<String> {
        keys.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn no_alert_when_sources_agree() {
        let mut per = HashMap::new();
        per.insert("s1".to_string(), set(&["a", "b", "c"]));
        per.insert("s2".to_string(), set(&["a", "b", "c"]));
        assert!(evaluate(1, &per, 5).is_empty());
    }

    #[test]
    fn no_alert_below_gap_threshold() {
        let mut per = HashMap::new();
        per.insert("s1".to_string(), set(&["a", "b", "c", "d", "e"]));
        per.insert("s2".to_string(), set(&["a", "b", "c"]));
        // s2 missing 2 — routine jitter, below MIN_GAP_TO_ALERT
        assert!(evaluate(1, &per, 5).is_empty());
    }

    #[test]
    fn alerts_lossy_source_only() {
        // The observed event shape: one vantage misses a cohort another has.
        let full: Vec<String> = (0..33).map(|i| format!("v{i}")).collect();
        let full_refs: Vec<&str> = full.iter().map(|s| s.as_str()).collect();
        let mut per = HashMap::new();
        per.insert("xrplcluster".to_string(), set(&full_refs));
        per.insert("s1".to_string(), set(&full_refs[..25]));
        let alerts = evaluate(106013031, &per, 5);
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0].category, "VANTAGE_LOSS");
        assert!(alerts[0].message.contains("s1"));
        assert!(alerts[0].message.contains("25/33"));
        assert!(alerts[0].message.contains("missing 8"));
    }

    #[test]
    fn tracker_end_to_end_gap_detection() {
        let unl: HashSet<String> = (0..10).map(|i| format!("v{i}")).collect();
        let mut t = SourceTracker::new(unl);
        for i in 0..10 {
            t.record("s2", Some(&format!("v{i}")), 5);
        }
        for i in 0..4 {
            t.record("s1", Some(&format!("v{i}")), 5);
        }
        t.record("s1", Some("not-unl"), 5); // ignored: not a UNL key
                                            // Window not yet elapsed — no alerts.
        assert!(t.tick().is_empty());
        // Force the window to look old.
        t.ledgers.get_mut(&5).unwrap().first_seen =
            Instant::now() - std::time::Duration::from_secs(WINDOW_SECS + 1);
        let alerts = t.tick();
        assert_eq!(alerts.len(), 1);
        assert!(alerts[0].message.contains("4/10"));
        // Already finalized — never re-alerts.
        assert!(t.tick().is_empty());
    }

    #[test]
    fn single_source_window_is_skipped() {
        let unl: HashSet<String> = set(&["a", "b", "c", "d", "e", "f"]);
        let mut t = SourceTracker::new(unl);
        t.record("s1", Some("a"), 7);
        t.ledgers.get_mut(&7).unwrap().first_seen =
            Instant::now() - std::time::Duration::from_secs(WINDOW_SECS + 1);
        assert!(t.tick().is_empty());
    }
}
