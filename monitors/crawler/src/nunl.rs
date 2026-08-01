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

/// Well-known ledger index of the NegativeUNL singleton (sha512half(uint16('N'))).
pub const NEGATIVE_UNL_INDEX: &str =
    "2E8A59AA9D3B5B186B0B9E0F62E6C02587CA74A4D778938E957B6357D364B244";

#[derive(Default, Serialize, Deserialize, Clone)]
pub struct NunlState {
    pub disabled: Vec<String>,
}

impl NunlState {
    fn is_seeded(&self) -> bool {
        !self.disabled.is_empty()
    }
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

/// Diff `fresh` against `prev`. `cold` suppresses membership announcements on the
/// first poll (but a genuinely empty NUNL producing no alerts is also fine).
/// `unl_size` drives the size-vs-cap check, which runs even on a cold start.
pub fn diff(
    prev: &NunlState,
    fresh: &NunlState,
    cold: bool,
    names: &HashMap<String, String>,
    unl_size: usize,
) -> Vec<NunlAlert> {
    let mut alerts = Vec::new();

    // Size-vs-cap is a property of the current listing, independent of membership
    // churn — surface it even on the first poll (network may already be near cap).
    if let Some(a) = cap_alert(fresh.disabled.len(), unl_size) {
        alerts.push(a);
    }

    if cold && !prev.is_seeded() {
        return alerts;
    }

    for v in &fresh.disabled {
        if !prev.disabled.contains(v) {
            let n = name_of(names, v);
            let link = linked_name(names, v);
            alerts.push(NunlAlert {
                severity: Severity::Warning,
                category: "NUNL_DISABLED",
                key: v.clone(),
                title: format!("Validator {n} added to Negative UNL"),
                text: format!(
                    "{link} (`{v}`) was disabled (unreliable/offline) and removed from quorum."
                ),
                fields: vec![("validator".into(), link)],
            });
        }
    }
    for v in &prev.disabled {
        if !fresh.disabled.contains(v) {
            let n = name_of(names, v);
            let link = linked_name(names, v);
            alerts.push(NunlAlert {
                severity: Severity::Info,
                category: "NUNL_REENABLED",
                key: v.clone(),
                title: format!("Validator {n} re-enabled"),
                text: format!("{link} (`{v}`) recovered and was removed from the Negative UNL."),
                fields: vec![("validator".into(), link)],
            });
        }
    }
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
    let cold = !std::path::Path::new(state_file).exists();
    let prev: NunlState = cstate::load_state(state_file).unwrap_or_default();
    let names = crate::names::resolve(names_url.as_deref(), names_file.as_deref()).await;

    // The published key→name registry (XRPLF/unl) is the same UNL source the
    // quorum math draws on, so its size is |UNL| for the negative-UNL cap. If the
    // fetch failed (empty), the cap check is skipped rather than firing falsely.
    let unl_size = names.len();
    let alerts = diff(&prev, &fresh, cold, &names, unl_size);
    if let Err(e) = cstate::save_state(state_file, &fresh) {
        eprintln!("nunl: state save failed: {e}");
    }

    let mut sink = AlertSink::new(webhook, dry_run, webhook_state, "xrpl-crawler/nunl");
    if sink.enabled() {
        let now = chrono::Utc::now().timestamp();
        for a in &alerts {
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

    #[test]
    fn cold_start_silent() {
        // unl_size 0 => cap check off; cold + unseeded prev => no membership churn.
        assert!(diff(
            &NunlState::default(),
            &st(&["EDAAA"]),
            true,
            &HashMap::new(),
            0
        )
        .is_empty());
    }

    #[test]
    fn disable_and_reenable() {
        let prev = st(&["EDAAA"]);
        let fresh = st(&["EDBBB"]);
        // unl_size 0 => no cap alert; isolate the membership diff.
        let a = diff(&prev, &fresh, false, &HashMap::new(), 0);
        assert!(a
            .iter()
            .any(|x| x.category == "NUNL_DISABLED" && x.key == "EDBBB"));
        assert!(a
            .iter()
            .any(|x| x.category == "NUNL_REENABLED" && x.key == "EDAAA"));
    }

    // S16: size-vs-cap bands. 20% of UNL warns (approaching), 25% is critical (at
    // the protocol cap), below 20% is silent.
    #[test]
    fn cap_bands() {
        let none = HashMap::new();
        // 2 / 10 = 20% => WARNING
        let w = diff(&NunlState::default(), &st(&["a", "b"]), false, &none, 10);
        assert!(w
            .iter()
            .any(|x| x.category == "NUNL_CAP" && x.severity == Severity::Warning));
        // 3 / 12 = 25% => CRITICAL
        let c = diff(
            &NunlState::default(),
            &st(&["a", "b", "c"]),
            false,
            &none,
            12,
        );
        assert!(c
            .iter()
            .any(|x| x.category == "NUNL_CAP" && x.severity == Severity::Critical));
        // 1 / 20 = 5% => no cap alert
        let n = diff(&NunlState::default(), &st(&["a"]), false, &none, 20);
        assert!(!n.iter().any(|x| x.category == "NUNL_CAP"));
    }
}
