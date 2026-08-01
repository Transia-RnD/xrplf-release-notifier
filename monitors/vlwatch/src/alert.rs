//! Alert rules for observed validator lists.
//!
//! [`evaluate`] is the per-observation core (deterministic, unit-tested):
//! it takes one decoded list, mutates persistent [`VlState`], and returns the
//! alerts that should fire. [`evaluate_periodic`] covers the time-based rules
//! (no data / publisher missing) that don't hang off a single observation.
//!
//! Cold start (no prior state file) suppresses *delta* alerts — NEW_LIST and
//! SEQ_REGRESSION — so a fresh deploy doesn't announce every list it sees as
//! new. Absolute security facts (bad signature, unknown publisher, near
//! expiry) still fire on the first run.

use monitor_common::{Alert, Severity};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Expiry thresholds (days remaining) and their severities.
pub const EXPIRY_WARN_DAYS: i64 = 14;
pub const EXPIRY_CRIT_DAYS: i64 = 7;
/// No validator list from any peer for this long (while connected) → NO_DATA.
pub const NO_DATA_SECS: i64 = 1800;
/// An allowlisted publisher unseen for this long → PUBLISHER_MISSING.
pub const PUBLISHER_MISSING_SECS: i64 = 3600;

const MAX_NOTIFIED: usize = 64;

/// Persistent per-publisher dedup state, serialized to the state file.
#[derive(Default, Serialize, Deserialize)]
pub struct VlState {
    pub publishers: HashMap<String, PublisherState>,
}

#[derive(Default, Serialize, Deserialize, Clone)]
pub struct PublisherState {
    pub label: String,
    pub max_sequence: u64,
    pub notified_sequences: Vec<u64>,
    pub expiry_alerted: Vec<ExpiryFlag>,
    pub last_seen_unix: i64,
    pub expiration_unix: Option<i64>,
    pub unknown_alerted: bool,
    pub sig_fail_seqs: Vec<u64>,
}

#[derive(Serialize, Deserialize, Clone, PartialEq)]
pub struct ExpiryFlag {
    pub sequence: u64,
    pub threshold_days: i64,
}

/// One decoded validator list handed to the rule engine.
pub struct VlObservation<'a> {
    pub publisher_key: &'a str,
    pub label: &'a str,
    pub sequence: u64,
    pub expiration_unix: Option<i64>,
    pub sig_ok: bool,
    pub chain_ok: bool,
    pub validators: usize,
    pub from_peer: &'a str,
}

fn push_capped(v: &mut Vec<u64>, x: u64) {
    if !v.contains(&x) {
        v.push(x);
        if v.len() > MAX_NOTIFIED {
            let overflow = v.len() - MAX_NOTIFIED;
            v.drain(0..overflow);
        }
    }
}

/// Apply the per-observation rules, updating `state` and returning any alerts.
pub fn evaluate(
    obs: &VlObservation,
    state: &mut VlState,
    allowlist: &HashMap<String, String>,
    cold_start: bool,
    now_unix: i64,
) -> Vec<Alert> {
    let mut alerts = Vec::new();
    let key = obs.publisher_key.to_string();
    let known = allowlist.contains_key(&key);

    let ps = state.publishers.entry(key.clone()).or_default();
    if ps.label.is_empty() {
        ps.label = obs.label.to_string();
    }
    let prior_max = ps.max_sequence;
    let seen_before = ps.max_sequence != 0 || !ps.notified_sequences.is_empty();

    // UNKNOWN_PUBLISHER — absolute, once per key. Fires on cold start too.
    if !known && !ps.unknown_alerted {
        ps.unknown_alerted = true;
        alerts.push(
            Alert::new(
                Severity::Critical,
                "UNKNOWN_PUBLISHER",
                "Unknown UNL publisher observed",
                "A validator list from an unrecognized publisher key is propagating on the network.".to_string(),
            )
            .field("publisher", obs.label.to_string())
            .field("key", key.clone())
            .field("sequence", obs.sequence.to_string())
            .field("from", obs.from_peer.to_string()),
        );
    }

    // SIG_FAIL — absolute, once per (key, seq). Fires on cold start too.
    if (!obs.sig_ok || !obs.chain_ok) && !ps.sig_fail_seqs.contains(&obs.sequence) {
        push_capped(&mut ps.sig_fail_seqs, obs.sequence);
        let why = match (obs.sig_ok, obs.chain_ok) {
            (false, false) => "blob signature and manifest chain both invalid",
            (false, true) => "blob signature invalid",
            (true, false) => "manifest chain invalid",
            _ => unreachable!(),
        };
        alerts.push(
            Alert::new(
                Severity::Critical,
                "SIG_FAIL",
                "Validator list failed verification",
                format!("Observed list for {} did not verify: {why}.", obs.label),
            )
            .field("publisher", obs.label.to_string())
            .field("sequence", obs.sequence.to_string())
            .field("from", obs.from_peer.to_string()),
        );
    }

    // NEW_LIST — delta, suppressed on cold start. Dedup via notified_sequences.
    if obs.sequence > prior_max {
        if !cold_start && !ps.notified_sequences.contains(&obs.sequence) {
            alerts.push(
                Alert::new(
                    Severity::Info,
                    "NEW_LIST",
                    format!("{} published UNL sequence {}", obs.label, obs.sequence),
                    format!(
                        "A new validator list is propagating ({} validators, was sequence {prior_max}).",
                        obs.validators
                    ),
                )
                .field("publisher", obs.label.to_string())
                .field("sequence", obs.sequence.to_string())
                .field("validators", obs.validators.to_string()),
            );
        }
        push_capped(&mut ps.notified_sequences, obs.sequence);
        ps.max_sequence = obs.sequence;
    } else if obs.sequence < prior_max && seen_before && !cold_start {
        // SEQ_REGRESSION — delta, suppressed on cold start. Dedup per (key, seq).
        if !ps.notified_sequences.contains(&obs.sequence) {
            push_capped(&mut ps.notified_sequences, obs.sequence);
            alerts.push(
                Alert::new(
                    Severity::Warning,
                    "SEQ_REGRESSION",
                    format!("{} advertised an older UNL sequence", obs.label),
                    format!(
                        "Observed sequence {} below the known maximum {prior_max}.",
                        obs.sequence
                    ),
                )
                .field("publisher", obs.label.to_string())
                .field("observed", obs.sequence.to_string())
                .field("known_max", prior_max.to_string()),
            );
        }
    }

    // EXPIRY_HORIZON — absolute, once per (key, seq, threshold).
    if let Some(exp) = obs.expiration_unix {
        let days_left = (exp - now_unix).div_euclid(86_400);
        let threshold = if days_left < EXPIRY_CRIT_DAYS {
            Some((EXPIRY_CRIT_DAYS, Severity::Critical))
        } else if days_left < EXPIRY_WARN_DAYS {
            Some((EXPIRY_WARN_DAYS, Severity::Warning))
        } else {
            None
        };
        if let Some((thr, sev)) = threshold {
            let flag = ExpiryFlag {
                sequence: obs.sequence,
                threshold_days: thr,
            };
            if !ps.expiry_alerted.contains(&flag) {
                ps.expiry_alerted.push(flag);
                alerts.push(
                    Alert::new(
                        sev,
                        "EXPIRY_HORIZON",
                        format!("{} UNL expiring in {days_left}d", obs.label),
                        format!(
                            "Validator list sequence {} expires in {days_left} days — a replacement must be published and staged.",
                            obs.sequence
                        ),
                    )
                    .field("publisher", obs.label.to_string())
                    .field("sequence", obs.sequence.to_string())
                    .field("days_left", days_left.to_string()),
                );
            }
        }
        ps.expiration_unix = Some(exp);
    }

    ps.last_seen_unix = now_unix;
    alerts
}

/// In-memory dedup for the time-based rules (not persisted — scoped to a run).
#[derive(Default)]
pub struct PeriodicFired {
    pub no_data: bool,
    pub missing: std::collections::HashSet<String>,
}

/// Time-based rules evaluated on a periodic tick.
///
/// `last_vl_unix` is when any list was last observed this run (None if never);
/// `connected` is whether at least one peer is currently up.
pub fn evaluate_periodic(
    state: &VlState,
    allowlist: &HashMap<String, String>,
    now_unix: i64,
    started_unix: i64,
    last_vl_unix: Option<i64>,
    connected: bool,
    fired: &mut PeriodicFired,
) -> Vec<Alert> {
    let mut alerts = Vec::new();

    // NO_DATA — connected but silent for NO_DATA_SECS. Fire once per gap.
    if connected {
        let quiet_since = last_vl_unix.unwrap_or(started_unix);
        if now_unix - quiet_since >= NO_DATA_SECS {
            if !fired.no_data {
                fired.no_data = true;
                alerts.push(Alert::new(
                    Severity::Warning,
                    "NO_DATA",
                    "No validator lists received",
                    format!(
                        "Connected to peers but no UNL gossip for {}+ minutes — the overlay watcher may be wedged.",
                        NO_DATA_SECS / 60
                    ),
                ));
            }
        } else {
            fired.no_data = false;
        }
    }

    // PUBLISHER_MISSING — an allowlisted publisher unseen for too long. Only
    // meaningful once we've been running long enough to have observed it.
    if now_unix - started_unix >= PUBLISHER_MISSING_SECS {
        for (key, label) in allowlist {
            let last_seen = state.publishers.get(key).map(|p| p.last_seen_unix).unwrap_or(0);
            let missing = last_seen == 0 || now_unix - last_seen >= PUBLISHER_MISSING_SECS;
            if missing {
                if !fired.missing.contains(key) {
                    fired.missing.insert(key.clone());
                    alerts.push(
                        Alert::new(
                            Severity::Warning,
                            "PUBLISHER_MISSING",
                            format!("{label} UNL not seen"),
                            format!(
                                "No validator list from {label} in over {} minutes of observation.",
                                PUBLISHER_MISSING_SECS / 60
                            ),
                        )
                        .field("publisher", label.clone())
                        .field("key", key.clone()),
                    );
                }
            } else {
                fired.missing.remove(key);
            }
        }
    }

    alerts
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allow() -> HashMap<String, String> {
        let mut m = HashMap::new();
        m.insert("KEYA".into(), "vl.example.org".into());
        m
    }

    fn obs<'a>(seq: u64, sig: bool, chain: bool, exp: Option<i64>) -> VlObservation<'a> {
        VlObservation {
            publisher_key: "KEYA",
            label: "vl.example.org",
            sequence: seq,
            expiration_unix: exp,
            sig_ok: sig,
            chain_ok: chain,
            validators: 35,
            from_peer: "hub:51235",
        }
    }

    const NOW: i64 = 1_800_000_000;

    #[test]
    fn cold_start_suppresses_new_list_but_not_absolute() {
        let mut st = VlState::default();
        // cold start: NEW_LIST suppressed, but expiry still fires.
        let a = evaluate(&obs(10, true, true, Some(NOW + 5 * 86_400)), &mut st, &allow(), true, NOW);
        let cats: Vec<_> = a.iter().map(|x| x.category.as_str()).collect();
        assert!(!cats.contains(&"NEW_LIST"), "NEW_LIST must be suppressed cold");
        assert!(cats.contains(&"EXPIRY_HORIZON"));
        assert_eq!(st.publishers["KEYA"].max_sequence, 10);
    }

    #[test]
    fn new_list_fires_warm_and_dedups_across_restart() {
        let mut st = VlState::default();
        // seed warm state
        evaluate(&obs(10, true, true, None), &mut st, &allow(), true, NOW);
        // new sequence, warm run → NEW_LIST
        let a = evaluate(&obs(11, true, true, None), &mut st, &allow(), false, NOW);
        assert!(a.iter().any(|x| x.category == "NEW_LIST"));
        // simulate restart: reload same state, observe 11 again → no re-alert
        let a2 = evaluate(&obs(11, true, true, None), &mut st, &allow(), false, NOW);
        assert!(!a2.iter().any(|x| x.category == "NEW_LIST"));
    }

    #[test]
    fn sig_fail_is_absolute_and_deduped() {
        let mut st = VlState::default();
        let a = evaluate(&obs(10, false, true, None), &mut st, &allow(), true, NOW);
        assert!(a.iter().any(|x| x.category == "SIG_FAIL" && x.severity == Severity::Critical));
        let a2 = evaluate(&obs(10, false, true, None), &mut st, &allow(), false, NOW);
        assert!(!a2.iter().any(|x| x.category == "SIG_FAIL"));
    }

    #[test]
    fn unknown_publisher_once() {
        let mut st = VlState::default();
        let mut o = obs(1, true, true, None);
        o.publisher_key = "ROGUE";
        o.label = "rogue";
        let a = evaluate(&o, &mut st, &allow(), true, NOW);
        assert!(a.iter().any(|x| x.category == "UNKNOWN_PUBLISHER"));
        let a2 = evaluate(&o, &mut st, &allow(), false, NOW);
        assert!(!a2.iter().any(|x| x.category == "UNKNOWN_PUBLISHER"));
    }

    #[test]
    fn expiry_escalates_warn_then_crit_once_each() {
        let mut st = VlState::default();
        // 10 days left → WARNING
        let a = evaluate(&obs(10, true, true, Some(NOW + 10 * 86_400)), &mut st, &allow(), true, NOW);
        assert!(a.iter().any(|x| x.category == "EXPIRY_HORIZON" && x.severity == Severity::Warning));
        // same seq, still 10d → no repeat
        let a2 = evaluate(&obs(10, true, true, Some(NOW + 10 * 86_400)), &mut st, &allow(), false, NOW);
        assert!(!a2.iter().any(|x| x.category == "EXPIRY_HORIZON"));
        // now 5 days left → CRITICAL (new threshold crossed)
        let a3 = evaluate(&obs(10, true, true, Some(NOW + 5 * 86_400)), &mut st, &allow(), false, NOW);
        assert!(a3.iter().any(|x| x.category == "EXPIRY_HORIZON" && x.severity == Severity::Critical));
    }

    #[test]
    fn seq_regression_warns_warm_only() {
        let mut st = VlState::default();
        evaluate(&obs(20, true, true, None), &mut st, &allow(), true, NOW);
        let a = evaluate(&obs(19, true, true, None), &mut st, &allow(), false, NOW);
        assert!(a.iter().any(|x| x.category == "SEQ_REGRESSION"));
    }

    #[test]
    fn periodic_no_data_fires_once() {
        let st = VlState::default();
        let mut fired = PeriodicFired::default();
        let start = NOW - 4000;
        let a = evaluate_periodic(&st, &allow(), NOW, start, None, true, &mut fired);
        assert!(a.iter().any(|x| x.category == "NO_DATA"));
        let a2 = evaluate_periodic(&st, &allow(), NOW, start, None, true, &mut fired);
        assert!(!a2.iter().any(|x| x.category == "NO_DATA"));
    }
}
