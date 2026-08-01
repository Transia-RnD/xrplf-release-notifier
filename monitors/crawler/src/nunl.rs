//! Negative UNL tracking via the on-ledger NegativeUNL object.
//!
//! The Negative UNL is the set of validators temporarily removed from quorum for
//! being unreliable/offline. Poll the singleton NegativeUNL object (public
//! `ledger_entry`), diff against the previous poll, and alert on validators being
//! disabled, re-enabled, or pending either at the next flag ledger.

use crate::webhook::AlertSink;
use monitor_common::{state as cstate, Severity};
use serde::{Deserialize, Serialize};

/// Well-known ledger index of the NegativeUNL singleton (sha512half(uint16('N'))).
pub const NEGATIVE_UNL_INDEX: &str =
    "2E8A59AA9D3B5B186B0B9E0F62E6C02587CA74A4D778938E957B6357D364B244";

#[derive(Default, Serialize, Deserialize, Clone)]
pub struct NunlState {
    pub disabled: Vec<String>,
    pub to_disable: Option<String>,
    pub to_reenable: Option<String>,
}

impl NunlState {
    fn is_seeded(&self) -> bool {
        !self.disabled.is_empty() || self.to_disable.is_some() || self.to_reenable.is_some()
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

/// Diff `fresh` against `prev`. `cold` suppresses membership announcements on the
/// first poll (but a genuinely empty NUNL producing no alerts is also fine).
pub fn diff(prev: &NunlState, fresh: &NunlState, cold: bool) -> Vec<NunlAlert> {
    if cold && !prev.is_seeded() {
        return Vec::new();
    }
    let mut alerts = Vec::new();

    for v in &fresh.disabled {
        if !prev.disabled.contains(v) {
            alerts.push(NunlAlert {
                severity: Severity::Warning,
                category: "NUNL_DISABLED",
                key: v.clone(),
                title: format!("Validator {} added to Negative UNL", short(v)),
                text: format!("Validator `{v}` was disabled (unreliable/offline) and removed from quorum."),
                fields: vec![("validator".into(), v.clone())],
            });
        }
    }
    for v in &prev.disabled {
        if !fresh.disabled.contains(v) {
            alerts.push(NunlAlert {
                severity: Severity::Info,
                category: "NUNL_REENABLED",
                key: v.clone(),
                title: format!("Validator {} re-enabled", short(v)),
                text: format!("Validator `{v}` recovered and was removed from the Negative UNL."),
                fields: vec![("validator".into(), v.clone())],
            });
        }
    }
    if fresh.to_disable != prev.to_disable {
        if let Some(v) = &fresh.to_disable {
            alerts.push(NunlAlert {
                severity: Severity::Warning,
                category: "NUNL_PENDING_DISABLE",
                key: v.clone(),
                title: format!("Validator {} pending disable", short(v)),
                text: format!("Validator `{v}` is scheduled to be added to the Negative UNL at the next flag ledger."),
                fields: vec![("validator".into(), v.clone())],
            });
        }
    }
    if fresh.to_reenable != prev.to_reenable {
        if let Some(v) = &fresh.to_reenable {
            alerts.push(NunlAlert {
                severity: Severity::Info,
                category: "NUNL_PENDING_REENABLE",
                key: v.clone(),
                title: format!("Validator {} pending re-enable", short(v)),
                text: format!("Validator `{v}` is scheduled to leave the Negative UNL at the next flag ledger."),
                fields: vec![("validator".into(), v.clone())],
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
        #[serde(rename = "ValidatorToDisable")]
        to_disable: Option<String>,
        #[serde(rename = "ValidatorToReEnable")]
        to_reenable: Option<String>,
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
    let resp: Resp = client.post(endpoint).json(&body).send().await?.json().await?;

    // No NegativeUNL object yet (empty NUNL) is normal — treat as empty state.
    let Some(node) = resp.result.node else {
        return Ok(NunlState::default());
    };
    Ok(NunlState {
        disabled: node.disabled.into_iter().map(|d| d.inner.public_key).collect(),
        to_disable: node.to_disable,
        to_reenable: node.to_reenable,
    })
}

pub async fn run(
    endpoint: &str,
    state_file: &str,
    webhook: Option<String>,
    webhook_state: Option<String>,
    dry_run: bool,
) -> anyhow::Result<()> {
    let fresh = fetch(endpoint).await?;
    let cold = !std::path::Path::new(state_file).exists();
    let prev: NunlState = cstate::load_state(state_file).unwrap_or_default();

    let alerts = diff(&prev, &fresh, cold);
    if let Err(e) = cstate::save_state(state_file, &fresh) {
        eprintln!("nunl: state save failed: {e}");
    }

    let mut sink = AlertSink::new(webhook, dry_run, webhook_state, "xrpl-crawler/nunl");
    if sink.enabled() {
        let now = chrono::Utc::now().timestamp();
        for a in &alerts {
            sink.send(a.severity, a.category, &a.key, &a.title, &a.text, a.fields.clone(), now);
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
            ..Default::default()
        }
    }

    #[test]
    fn cold_start_silent() {
        assert!(diff(&NunlState::default(), &st(&["EDAAA"]), true).is_empty());
    }

    #[test]
    fn disable_and_reenable() {
        let prev = st(&["EDAAA"]);
        let fresh = st(&["EDBBB"]);
        let a = diff(&prev, &fresh, false);
        assert!(a.iter().any(|x| x.category == "NUNL_DISABLED" && x.key == "EDBBB"));
        assert!(a.iter().any(|x| x.category == "NUNL_REENABLED" && x.key == "EDAAA"));
    }

    #[test]
    fn pending_disable_alerts_on_change() {
        let prev = NunlState::default();
        let fresh = NunlState {
            to_disable: Some("EDCCC".into()),
            ..Default::default()
        };
        let a = diff(&prev, &fresh, false);
        assert!(a.iter().any(|x| x.category == "NUNL_PENDING_DISABLE"));
    }
}
