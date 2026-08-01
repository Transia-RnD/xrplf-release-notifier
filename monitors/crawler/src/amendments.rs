//! Network-wide amendment tracking via the on-ledger Amendments object.
//!
//! Polls a public node's `ledger_entry` for the Amendments singleton (no admin
//! access needed), then diffs the enabled + majority sets against the previous
//! poll. A newly-majority amendment starts a ~2-week countdown to activation; a
//! newly-enabled one just activated. Cold start (no prior state) seeds silently.

use crate::webhook::AlertSink;
use monitor_common::{state as cstate, Severity};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Well-known ledger index of the Amendments singleton object.
pub const AMENDMENTS_INDEX: &str =
    "7DB0788C020F02780A673DC74757F23823FA3014C1866E72CC4CD8B226CD6EF4";
/// Ripple epoch (2000-01-01) offset from Unix epoch.
pub const RIPPLE_EPOCH: i64 = 946_684_800;
/// An amendment activates after holding majority this long.
pub const ACTIVATION_DELAY_SECS: i64 = 14 * 86_400;

#[derive(Default, Serialize, Deserialize, Clone)]
pub struct AmendmentsState {
    pub enabled: Vec<String>,
    pub majority: Vec<String>,
}

impl AmendmentsState {
    fn is_empty(&self) -> bool {
        self.enabled.is_empty() && self.majority.is_empty()
    }
}

pub struct AmendmentAlert {
    pub severity: Severity,
    pub category: &'static str,
    pub key: String,
    pub title: String,
    pub text: String,
    pub fields: Vec<(String, String)>,
}

fn short(hash: &str) -> &str {
    &hash[..8.min(hash.len())]
}

/// Diff `fresh` against `prev`, using `close_times` (ripple-epoch seconds keyed
/// by amendment hash) to estimate activation dates. Returns the alerts to post.
pub fn diff(
    prev: &AmendmentsState,
    fresh: &AmendmentsState,
    close_times: &HashMap<String, i64>,
) -> Vec<AmendmentAlert> {
    // Cold start: seed silently rather than announce every existing amendment.
    if prev.is_empty() {
        return Vec::new();
    }
    let mut alerts = Vec::new();

    // Newly enabled (activated).
    for h in &fresh.enabled {
        if !prev.enabled.contains(h) {
            alerts.push(AmendmentAlert {
                severity: Severity::Info,
                category: "AMENDMENT_ENABLED",
                key: h.clone(),
                title: format!("Amendment {} activated", short(h)),
                text: format!("Amendment `{h}` is now enabled on the network."),
                fields: vec![("amendment".into(), h.clone())],
            });
        }
    }

    // Newly gained majority (counting down to activation).
    for h in &fresh.majority {
        if !prev.majority.contains(h) && !fresh.enabled.contains(h) {
            let when = close_times
                .get(h)
                .map(|ct| activation_date(*ct))
                .unwrap_or_else(|| "~2 weeks".into());
            alerts.push(AmendmentAlert {
                severity: Severity::Warning,
                category: "AMENDMENT_MAJORITY",
                key: h.clone(),
                title: format!("Amendment {} gained majority", short(h)),
                text: format!(
                    "Amendment `{h}` reached majority and is scheduled to activate around {when}. SDKs and operators should prepare."
                ),
                fields: vec![
                    ("amendment".into(), h.clone()),
                    ("activates".into(), when),
                ],
            });
        }
    }

    // Lost majority without activating (support fell back).
    for h in &prev.majority {
        if !fresh.majority.contains(h) && !fresh.enabled.contains(h) {
            alerts.push(AmendmentAlert {
                severity: Severity::Warning,
                category: "AMENDMENT_LOST_MAJORITY",
                key: h.clone(),
                title: format!("Amendment {} lost majority", short(h)),
                text: format!("Amendment `{h}` fell below majority before activating."),
                fields: vec![("amendment".into(), h.clone())],
            });
        }
    }

    alerts
}

/// Fetch the Amendments object from a public node via `ledger_entry`. Returns
/// the current state plus per-hash majority close times (ripple-epoch seconds).
pub async fn fetch(endpoint: &str) -> anyhow::Result<(AmendmentsState, HashMap<String, i64>)> {
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
        #[serde(rename = "Amendments", default)]
        amendments: Vec<String>,
        #[serde(rename = "Majorities", default)]
        majorities: Vec<MajorityWrap>,
    }
    #[derive(Deserialize)]
    struct MajorityWrap {
        #[serde(rename = "Majority")]
        majority: MajorityInner,
    }
    #[derive(Deserialize)]
    struct MajorityInner {
        #[serde(rename = "Amendment")]
        amendment: String,
        #[serde(rename = "CloseTime")]
        close_time: i64,
    }

    let body = serde_json::json!({
        "method": "ledger_entry",
        "params": [{ "index": AMENDMENTS_INDEX, "ledger_index": "validated" }],
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
    let node = resp
        .result
        .node
        .ok_or_else(|| anyhow::anyhow!("no Amendments node in ledger_entry response"))?;

    let mut close_times = HashMap::new();
    let majority = node
        .majorities
        .into_iter()
        .map(|m| {
            close_times.insert(m.majority.amendment.clone(), m.majority.close_time);
            m.majority.amendment
        })
        .collect();
    Ok((
        AmendmentsState {
            enabled: node.amendments,
            majority,
        },
        close_times,
    ))
}

fn activation_date(close_time_ripple: i64) -> String {
    let unix = close_time_ripple + RIPPLE_EPOCH + ACTIVATION_DELAY_SECS;
    chrono::DateTime::from_timestamp(unix, 0)
        .map(|d| d.format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| "~2 weeks".into())
}

/// Poll the network's amendment state, diff against the stored state, post any
/// transitions, and persist the new state.
pub async fn run(
    endpoint: &str,
    state_file: &str,
    webhook: Option<String>,
    webhook_state: Option<String>,
    dry_run: bool,
) -> anyhow::Result<()> {
    let (fresh, close_times) = fetch(endpoint).await?;
    let prev: AmendmentsState = cstate::load_state(state_file).unwrap_or_default();

    let alerts = diff(&prev, &fresh, &close_times);
    if let Err(e) = cstate::save_state(state_file, &fresh) {
        eprintln!("amendments: state save failed: {e}");
    }

    let mut sink = AlertSink::new(webhook, dry_run, webhook_state, "xrpl-crawler/amendments");
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
        "amendments: {} enabled, {} in majority, {} alert(s)",
        fresh.enabled.len(),
        fresh.majority.len(),
        alerts.len()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn st(enabled: &[&str], majority: &[&str]) -> AmendmentsState {
        AmendmentsState {
            enabled: enabled.iter().map(|s| s.to_string()).collect(),
            majority: majority.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn cold_start_is_silent() {
        let fresh = st(&["AAAA1111", "BBBB2222"], &["CCCC3333"]);
        assert!(diff(&AmendmentsState::default(), &fresh, &HashMap::new()).is_empty());
    }

    #[test]
    fn new_majority_and_activation() {
        let prev = st(&["AAAA1111"], &[]);
        let fresh = st(&["AAAA1111", "BBBB2222"], &["CCCC3333"]);
        let a = diff(&prev, &fresh, &HashMap::new());
        let cats: Vec<_> = a.iter().map(|x| x.category).collect();
        assert!(cats.contains(&"AMENDMENT_ENABLED")); // BBBB2222
        assert!(cats.contains(&"AMENDMENT_MAJORITY")); // CCCC3333
    }

    #[test]
    fn majority_then_enabled_does_not_double_alert_majority() {
        // was in majority, now enabled → only ENABLED, not a lingering MAJORITY
        let prev = st(&[], &["CCCC3333"]);
        let fresh = st(&["CCCC3333"], &[]);
        let a = diff(&prev, &fresh, &HashMap::new());
        assert!(a.iter().any(|x| x.category == "AMENDMENT_ENABLED"));
        assert!(!a.iter().any(|x| x.category == "AMENDMENT_LOST_MAJORITY"));
    }

    #[test]
    fn lost_majority_alerts() {
        let prev = st(&[], &["DDDD4444"]);
        let fresh = st(&[], &[]);
        let a = diff(&prev, &fresh, &HashMap::new());
        assert!(a.iter().any(|x| x.category == "AMENDMENT_LOST_MAJORITY"));
    }

    #[test]
    fn activation_date_formats() {
        // ripple epoch 0 → 2000-01-01, +14d → 2000-01-15
        assert_eq!(activation_date(0), "2000-01-15");
    }
}
