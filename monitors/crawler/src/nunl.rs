//! Negative UNL tracking via the on-ledger NegativeUNL object.
//!
//! The Negative UNL is the set of validators temporarily removed from quorum for
//! being unreliable/offline. Poll the singleton NegativeUNL object (public
//! `ledger_entry`), diff against the previous poll, and alert on validators being
//! added to or removed from the Negative UNL.

use crate::webhook::AlertSink;
use monitor_common::{state as cstate, Severity};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

/// Encode a validator master public key (hex) as its `nH…` node-public string,
/// so a NegativeUNL PublicKey can be matched against the key→name map.
fn hex_to_node_public(hex: &str) -> Option<String> {
    let raw = (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(hex.get(i..i + 2)?, 16).ok())
        .collect::<Option<Vec<u8>>>()?;
    if raw.len() != 33 {
        return None;
    }
    let mut payload = Vec::with_capacity(38);
    payload.push(28u8); // node-public prefix
    payload.extend_from_slice(&raw);
    let checksum = Sha256::digest(Sha256::digest(&payload));
    payload.extend_from_slice(&checksum[..4]);
    Some(
        bs58::encode(&payload)
            .with_alphabet(bs58::Alphabet::RIPPLE)
            .into_string(),
    )
}

fn name_of(names: &HashMap<String, String>, hex_key: &str) -> String {
    hex_to_node_public(hex_key)
        .and_then(|nh| names.get(&nh).cloned())
        .unwrap_or_else(|| short(hex_key).to_string())
}

/// Display name as a markdown link to the validator's XRP Scan page, falling
/// back to the plain name when the key can't be encoded.
fn linked_name(names: &HashMap<String, String>, hex_key: &str) -> String {
    let n = name_of(names, hex_key);
    match hex_to_node_public(hex_key) {
        Some(nh) => format!("[{n}](https://xrpscan.com/validator/{nh})"),
        None => n,
    }
}

/// An unchanged Negative UNL re-posts this often, so a quiet network still
/// produces a periodic "nobody is listed" card instead of ambiguous silence.
pub const SUMMARY_HEARTBEAT_SECS: i64 = 24 * 60 * 60;

/// Well-known ledger index of the NegativeUNL singleton (sha512half(uint16('N'))).
pub const NEGATIVE_UNL_INDEX: &str =
    "2E8A59AA9D3B5B186B0B9E0F62E6C02587CA74A4D778938E957B6357D364B244";

#[derive(Default, Serialize, Deserialize, Clone)]
pub struct NunlState {
    pub disabled: Vec<String>,
}

pub struct NunlAlert {
    pub severity: Severity,
    pub category: &'static str,
    pub key: String,
    pub title: String,
    pub text: String,
    pub fields: Vec<(String, String)>,
}

fn short(k: &str) -> &str {
    &k[..12.min(k.len())]
}

/// Protocol cap on the Negative UNL: at most ceil(0.25 * |UNL|) validators may be
/// listed (rippled `kNegativeUnlMaxListed`). Beyond this the network can no longer
/// disable further failed validators.
const NEG_UNL_MAX_FRACTION: f64 = 0.25;
/// Warn once the listed fraction reaches this share of the UNL (approaching cap).
const NEG_UNL_WARN_FRACTION: f64 = 0.20;

/// Size-vs-cap check: how close the Negative UNL is to the 25% protocol ceiling.
/// Band-keyed so the webhook dedup posts once per band and re-fires only when the
/// band changes (approaching → at cap), not every poll while steady.
fn cap_alert(nunl_size: usize, unl_size: usize) -> Option<NunlAlert> {
    if unl_size == 0 {
        return None;
    }
    let frac = nunl_size as f64 / unl_size as f64;
    let pct = (frac * 100.0).round() as u64;
    if frac >= NEG_UNL_MAX_FRACTION {
        Some(NunlAlert {
            severity: Severity::Critical,
            category: "NUNL_CAP",
            key: "critical".into(),
            title: format!("Negative UNL at the {:.0}% protocol cap", NEG_UNL_MAX_FRACTION * 100.0),
            text: format!(
                "negative UNL at the {:.0}% cap ({nunl_size}/{unl_size}, {pct}%) — network cannot disable further failed validators.",
                NEG_UNL_MAX_FRACTION * 100.0
            ),
            fields: vec![
                ("listed".into(), nunl_size.to_string()),
                ("unl_size".into(), unl_size.to_string()),
                ("percent".into(), format!("{pct}%")),
            ],
        })
    } else if frac >= NEG_UNL_WARN_FRACTION {
        Some(NunlAlert {
            severity: Severity::Warning,
            category: "NUNL_CAP",
            key: "warning".into(),
            title: format!("Negative UNL at {pct}% of UNL — approaching {:.0}% cap", NEG_UNL_MAX_FRACTION * 100.0),
            text: format!(
                "negative UNL at {pct}% of UNL ({nunl_size}/{unl_size}) — approaching the {:.0}% protocol cap; fault tolerance degrading.",
                NEG_UNL_MAX_FRACTION * 100.0
            ),
            fields: vec![
                ("listed".into(), nunl_size.to_string()),
                ("unl_size".into(), unl_size.to_string()),
                ("percent".into(), format!("{pct}%")),
            ],
        })
    } else {
        None
    }
}

/// One card describing the whole Negative UNL, not one per validator. The dedup
/// key is a fingerprint of the membership, so a change posts immediately while an
/// unchanged set re-posts only on the heartbeat interval — which is what turns
/// "no alerts" from an ambiguous silence into a stated "nobody is listed".
fn summary_alert(
    prev: &NunlState,
    fresh: &NunlState,
    names: &HashMap<String, String>,
    unl_size: usize,
) -> NunlAlert {
    let mut listed = fresh.disabled.clone();
    listed.sort();
    let digest = Sha256::digest(listed.join(",").as_bytes());
    let key: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();

    let added: Vec<String> = fresh
        .disabled
        .iter()
        .filter(|v| !prev.disabled.contains(v))
        .map(|v| linked_name(names, v))
        .collect();
    let removed: Vec<String> = prev
        .disabled
        .iter()
        .filter(|v| !fresh.disabled.contains(v))
        .map(|v| linked_name(names, v))
        .collect();

    let mut fields = vec![("listed".into(), fresh.disabled.len().to_string())];
    if unl_size > 0 {
        fields.push(("unl_size".into(), unl_size.to_string()));
    }
    if !added.is_empty() {
        fields.push(("added".into(), added.join(", ")));
    }
    if !removed.is_empty() {
        fields.push(("removed".into(), removed.join(", ")));
    }

    if fresh.disabled.is_empty() {
        let of_unl = if unl_size > 0 {
            format!(" All {unl_size} UNL validators are participating in quorum.")
        } else {
            String::new()
        };
        let recovered = if removed.is_empty() {
            String::new()
        } else {
            format!(" Re-enabled since the last poll: {}.", removed.join(", "))
        };
        return NunlAlert {
            severity: Severity::Info,
            category: "NUNL_SUMMARY",
            key,
            title: "Negative UNL is empty".into(),
            text: format!("No validators are disabled.{of_unl}{recovered}"),
            fields,
        };
    }

    let roster: Vec<String> = listed.iter().map(|v| linked_name(names, v)).collect();
    let of_unl = if unl_size > 0 {
        format!(" of {unl_size}")
    } else {
        String::new()
    };
    let mut text = format!(
        "{}{of_unl} validator(s) disabled and removed from quorum: {}.",
        fresh.disabled.len(),
        roster.join(", ")
    );
    if !added.is_empty() {
        text.push_str(&format!(
            " Added since the last poll: {}.",
            added.join(", ")
        ));
    }
    if !removed.is_empty() {
        text.push_str(&format!(" Re-enabled: {}.", removed.join(", ")));
    }
    NunlAlert {
        severity: Severity::Warning,
        category: "NUNL_SUMMARY",
        key,
        title: format!("Negative UNL: {} disabled", fresh.disabled.len()),
        text,
        fields,
    }
}

/// Build the alerts for a poll: the size-vs-cap check plus the membership summary.
/// `unl_size` drives the cap check. There is no cold-start suppression — a summary
/// is a statement of current state, so reporting it on the first poll is correct.
pub fn diff(
    prev: &NunlState,
    fresh: &NunlState,
    names: &HashMap<String, String>,
    unl_size: usize,
) -> Vec<NunlAlert> {
    let mut alerts = Vec::new();

    // Size-vs-cap is a property of the current listing, independent of membership
    // churn — surface it even on the first poll (network may already be near cap).
    if let Some(a) = cap_alert(fresh.disabled.len(), unl_size) {
        alerts.push(a);
    }

    alerts.push(summary_alert(prev, fresh, names, unl_size));
    alerts
}

pub async fn fetch(endpoint: &str) -> anyhow::Result<NunlState> {
    #[derive(Deserialize)]
    struct Resp {
        result: ResultBody,
    }
    #[derive(Deserialize)]
    struct ResultBody {
        node: Option<Node>,
    }
    #[derive(Deserialize)]
    struct Node {
        #[serde(rename = "DisabledValidators", default)]
        disabled: Vec<DisabledWrap>,
    }
    #[derive(Deserialize)]
    struct DisabledWrap {
        #[serde(rename = "DisabledValidator")]
        inner: DisabledInner,
    }
    #[derive(Deserialize)]
    struct DisabledInner {
        #[serde(rename = "PublicKey")]
        public_key: String,
    }

    let body = serde_json::json!({
        "method": "ledger_entry",
        "params": [{ "index": NEGATIVE_UNL_INDEX, "ledger_index": "validated" }],
    });
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()?;
    let resp: Resp = client
        .post(endpoint)
        .json(&body)
        .send()
        .await?
        .json()
        .await?;

    // No NegativeUNL object yet (empty NUNL) is normal — treat as empty state.
    let Some(node) = resp.result.node else {
        return Ok(NunlState::default());
    };
    Ok(NunlState {
        disabled: node
            .disabled
            .into_iter()
            .map(|d| d.inner.public_key)
            .collect(),
    })
}

pub async fn run(
    endpoint: &str,
    state_file: &str,
    webhook: Option<String>,
    webhook_state: Option<String>,
    dry_run: bool,
    names_file: Option<String>,
    names_url: Option<String>,
) -> anyhow::Result<()> {
    let fresh = fetch(endpoint).await?;
    let prev: NunlState = cstate::load_state(state_file).unwrap_or_default();
    let names = crate::names::resolve(names_url.as_deref(), names_file.as_deref()).await;

    // The published key→name registry (XRPLF/unl) is the same UNL source the
    // quorum math draws on, so its size is |UNL| for the negative-UNL cap. If the
    // fetch failed (empty), the cap check is skipped rather than firing falsely.
    let unl_size = names.len();
    let alerts = diff(&prev, &fresh, &names, unl_size);
    if let Err(e) = cstate::save_state(state_file, &fresh) {
        eprintln!("nunl: state save failed: {e}");
    }

    let mut sink = AlertSink::new(webhook, dry_run, webhook_state, "xrpl-crawler/nunl");
    if sink.enabled() {
        let now = chrono::Utc::now().timestamp();
        for a in &alerts {
            // The summary's key changes whenever membership does, so a change
            // posts at once; an unchanged roster re-posts on the heartbeat.
            if a.category == "NUNL_SUMMARY" {
                sink.send_every(
                    SUMMARY_HEARTBEAT_SECS,
                    a.severity,
                    a.category,
                    &a.key,
                    &a.title,
                    &a.text,
                    a.fields.clone(),
                    now,
                );
            } else {
                sink.send(
                    a.severity,
                    a.category,
                    &a.key,
                    &a.title,
                    &a.text,
                    a.fields.clone(),
                    now,
                );
            }
        }
    }
    eprintln!(
        "nunl: {} disabled validator(s), {} alert(s)",
        fresh.disabled.len(),
        alerts.len()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn st(disabled: &[&str]) -> NunlState {
        NunlState {
            disabled: disabled.iter().map(|s| s.to_string()).collect(),
        }
    }

    fn summary(alerts: &[NunlAlert]) -> &NunlAlert {
        alerts
            .iter()
            .find(|a| a.category == "NUNL_SUMMARY")
            .expect("every poll produces a summary")
    }

    // A summary states current membership, so unlike the old per-validator
    // events it is correct to post it on the very first poll.
    #[test]
    fn cold_start_reports_state() {
        let a = diff(&NunlState::default(), &st(&["EDAAA"]), &HashMap::new(), 0);
        let s = summary(&a);
        assert_eq!(s.severity, Severity::Warning);
        assert!(s.text.contains("EDAAA"));
    }

    #[test]
    fn empty_nunl_says_so() {
        let a = diff(&st(&["EDAAA"]), &NunlState::default(), &HashMap::new(), 35);
        let s = summary(&a);
        assert_eq!(s.severity, Severity::Info);
        assert_eq!(s.title, "Negative UNL is empty");
        assert!(s.text.contains("All 35 UNL validators"));
        // The validator that recovered is still named, so the churn is not lost.
        assert!(s.text.contains("EDAAA"));
    }

    // One card for the whole set, naming both sides of the churn.
    #[test]
    fn churn_folds_into_one_summary() {
        let a = diff(&st(&["EDAAA"]), &st(&["EDBBB"]), &HashMap::new(), 0);
        assert_eq!(a.iter().filter(|x| x.category == "NUNL_SUMMARY").count(), 1);
        let s = summary(&a);
        assert!(s.text.contains("Added since the last poll"));
        assert!(s.text.contains("EDBBB"));
        assert!(s.text.contains("Re-enabled"));
        assert!(s.text.contains("EDAAA"));
    }

    // Dedup key tracks membership, not order: an unchanged set keeps its key
    // (so it re-posts only on the heartbeat), a changed set gets a new one.
    #[test]
    fn key_follows_membership() {
        let none = HashMap::new();
        let k =
            |prev: &NunlState, fresh: &NunlState| summary(&diff(prev, fresh, &none, 0)).key.clone();
        let base = k(&NunlState::default(), &st(&["a", "b"]));
        assert_eq!(base, k(&st(&["a", "b"]), &st(&["b", "a"])));
        assert_ne!(base, k(&st(&["a", "b"]), &st(&["a", "c"])));
    }

    // S16: size-vs-cap bands. 20% of UNL warns (approaching), 25% is critical (at
    // the protocol cap), below 20% is silent.
    #[test]
    fn cap_bands() {
        let none = HashMap::new();
        // 2 / 10 = 20% => WARNING
        let w = diff(&NunlState::default(), &st(&["a", "b"]), &none, 10);
        assert!(w
            .iter()
            .any(|x| x.category == "NUNL_CAP" && x.severity == Severity::Warning));
        // 3 / 12 = 25% => CRITICAL
        let c = diff(&NunlState::default(), &st(&["a", "b", "c"]), &none, 12);
        assert!(c
            .iter()
            .any(|x| x.category == "NUNL_CAP" && x.severity == Severity::Critical));
        // 1 / 20 = 5% => no cap alert
        let n = diff(&NunlState::default(), &st(&["a"]), &none, 20);
        assert!(!n.iter().any(|x| x.category == "NUNL_CAP"));
    }
}
