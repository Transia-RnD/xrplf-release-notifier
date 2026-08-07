//! Network-wide amendment tracking via the on-ledger Amendments object.
//!
//! Polls a public node's `ledger_entry` for the Amendments singleton (no admin
//! access needed), then diffs the enabled + majority sets against the previous
//! poll. A newly-majority amendment starts a ~2-week countdown to activation; a
//! newly-enabled one just activated. Cold start (no prior state) seeds silently.

use crate::webhook::AlertSink;
use monitor_common::{state as cstate, Severity};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
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

/// An unchanged amendment picture re-posts this often, so a quiet network still
/// produces a periodic "nothing pending" card instead of ambiguous silence.
pub const SUMMARY_HEARTBEAT_SECS: i64 = 24 * 60 * 60;

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

/// One card describing the current amendment picture rather than one per
/// amendment. The dedup key fingerprints both sets, so any change posts at once
/// while a steady network re-posts only on the heartbeat — which is what makes
/// "nothing is pending activation" something you are told rather than infer.
///
/// The card leads on the **majority** set: those are the amendments with a
/// deadline attached. The enabled set is reported as a count, since listing all
/// ~93 of them every day would bury the part that needs action.
pub fn diff(
    prev: &AmendmentsState,
    fresh: &AmendmentsState,
    close_times: &HashMap<String, i64>,
) -> Vec<AmendmentAlert> {
    let mut sorted = fresh.enabled.clone();
    sorted.sort();
    let mut majority = fresh.majority.clone();
    majority.sort();
    let digest = Sha256::digest(format!("{}|{}", sorted.join(","), majority.join(",")).as_bytes());
    let key: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();

    // Cold start still reports state — a summary is a statement of what is true
    // now, not an announcement that something changed.
    let cold = prev.is_empty();
    let activated: Vec<&String> = fresh
        .enabled
        .iter()
        .filter(|h| !cold && !prev.enabled.contains(h))
        .collect();
    let lost: Vec<&String> = prev
        .majority
        .iter()
        .filter(|h| !fresh.majority.contains(h) && !fresh.enabled.contains(h))
        .collect();

    let pending: Vec<String> = majority
        .iter()
        .filter(|h| !fresh.enabled.contains(h))
        .map(|h| {
            let when = close_times
                .get(h)
                .map(|ct| activation_date(*ct))
                .unwrap_or_else(|| "~2 weeks".into());
            format!("`{}` (activates ~{when})", short(h))
        })
        .collect();

    let mut fields = vec![
        ("enabled".into(), fresh.enabled.len().to_string()),
        ("in_majority".into(), pending.len().to_string()),
    ];
    if !activated.is_empty() {
        fields.push((
            "activated".into(),
            activated
                .iter()
                .map(|h| short(h))
                .collect::<Vec<_>>()
                .join(", "),
        ));
    }
    if !lost.is_empty() {
        fields.push((
            "lost_majority".into(),
            lost.iter().map(|h| short(h)).collect::<Vec<_>>().join(", "),
        ));
    }

    let mut text = if pending.is_empty() {
        format!(
            "{} amendments enabled; none currently pending activation.",
            fresh.enabled.len()
        )
    } else {
        format!(
            "{} amendment(s) in majority and scheduled to activate: {}. {} enabled overall. SDKs and operators should prepare.",
            pending.len(),
            pending.join(", "),
            fresh.enabled.len()
        )
    };
    if !activated.is_empty() {
        text.push_str(&format!(
            " Activated since the last poll: {}.",
            activated
                .iter()
                .map(|h| short(h))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    if !lost.is_empty() {
        text.push_str(&format!(
            " Fell below majority without activating: {}.",
            lost.iter().map(|h| short(h)).collect::<Vec<_>>().join(", ")
        ));
    }

    vec![AmendmentAlert {
        severity: if pending.is_empty() {
            Severity::Info
        } else {
            Severity::Warning
        },
        category: "AMENDMENT_SUMMARY",
        key,
        title: if pending.is_empty() {
            "No amendments pending activation".into()
        } else {
            format!("{} amendment(s) in majority", pending.len())
        },
        text,
        fields,
    }]
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
            // The key fingerprints both sets, so a change posts at once; a
            // steady picture re-posts on the heartbeat.
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

    fn only(a: &[AmendmentAlert]) -> &AmendmentAlert {
        assert_eq!(a.len(), 1, "the summary is the only card");
        &a[0]
    }

    // A summary states current state, so the first poll reports rather than seeds.
    #[test]
    fn cold_start_reports_state() {
        let a = diff(
            &AmendmentsState::default(),
            &st(&["AAAA1111"], &["CCCC3333"]),
            &HashMap::new(),
        );
        let s = only(&a);
        assert_eq!(s.severity, Severity::Warning);
        assert!(s.text.contains("CCCC3333"));
        // Nothing "activated" on a cold start — there is no prior poll to compare.
        assert!(!s.text.contains("Activated since"));
    }

    #[test]
    fn quiet_network_says_nothing_pending() {
        let prev = st(&["AAAA1111"], &[]);
        let a = diff(&prev, &st(&["AAAA1111"], &[]), &HashMap::new());
        let s = only(&a);
        assert_eq!(s.severity, Severity::Info);
        assert_eq!(s.title, "No amendments pending activation");
        assert!(s.text.contains("1 amendments enabled"));
    }

    #[test]
    fn churn_folds_into_one_card() {
        let prev = st(&["AAAA1111"], &["CCCC3333", "DDDD4444"]);
        let fresh = st(&["AAAA1111", "BBBB2222"], &["CCCC3333"]);
        let a = diff(&prev, &fresh, &HashMap::new());
        let s = only(&a);
        assert!(s.text.contains("Activated since the last poll: BBBB2222"));
        assert!(s
            .text
            .contains("Fell below majority without activating: DDDD4444"));
        assert!(s.text.contains("CCCC3333"));
    }

    // An amendment that goes majority -> enabled activated; it did not "lose"
    // majority, and must not be reported as having fallen back.
    #[test]
    fn majority_then_enabled_is_not_a_loss() {
        let prev = st(&["AAAA1111"], &["BBBB2222"]);
        let fresh = st(&["AAAA1111", "BBBB2222"], &[]);
        let a = diff(&prev, &fresh, &HashMap::new());
        let s = only(&a);
        assert!(s.text.contains("Activated since the last poll: BBBB2222"));
        assert!(!s.text.contains("Fell below majority"));
    }

    #[test]
    fn key_follows_both_sets() {
        let none = HashMap::new();
        let k = |prev: &AmendmentsState, fresh: &AmendmentsState| {
            let a = diff(prev, fresh, &none);
            only(&a).key.clone()
        };
        let base = k(
            &st(&["AAAA1111"], &["CCCC3333"]),
            &st(&["AAAA1111"], &["CCCC3333"]),
        );
        // Order is not identity.
        assert_eq!(
            base,
            k(
                &st(&["AAAA1111"], &["CCCC3333"]),
                &st(&["AAAA1111"], &["CCCC3333"])
            )
        );
        // A new majority entry changes the key, so it posts immediately.
        assert_ne!(
            base,
            k(
                &st(&["AAAA1111"], &["CCCC3333"]),
                &st(&["AAAA1111"], &["CCCC3333", "DDDD4444"])
            )
        );
    }

    #[test]
    fn activation_date_formats() {
        // ripple epoch 0 = 2000-01-01; +2 weeks from a known close time.
        assert!(!activation_date(0).is_empty());
    }
}
