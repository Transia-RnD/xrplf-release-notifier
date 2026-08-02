//! UNL software-version adoption after a hotfix.
//!
//! The overlay binds a build version only to a node key and validator identity
//! only to a master key, and the two never cross on the wire (validations carry
//! no `ServerVersion`). So per-validator version is not observable passively.
//! data.xrpl.org's validator feed already resolves master key → server_version
//! → UNL membership, so this polls that feed, restricts to the XRPL mainnet UNL,
//! and reports how many trusted validators run a build at/above a hotfix.
//!
//! Companion to the crawl's network-wide PATCH_ADOPTION; the same cadence
//! (movement posts immediately, steady state heartbeats at 12h) via a dedup key
//! that encodes the patched percent.

use crate::version;
use crate::webhook::AlertSink;
use monitor_common::Severity;
use serde::Deserialize;

/// Default validator feed (the service behind xrpl.org's validator page).
pub const DEFAULT_FEED: &str = "https://data.xrpl.org/v1/network/validators";

#[derive(Deserialize)]
struct Feed {
    validators: Vec<FeedValidator>,
}

#[derive(Deserialize, Clone)]
struct FeedValidator {
    master_key: Option<String>,
    domain: Option<String>,
    server_version: Option<String>,
    chain: Option<String>,
    /// The feed reports `unl` as the publisher domain of the list a validator is
    /// on ("vl.ripple.com"), or `false`/null when it's on none. Membership is
    /// "a non-empty publisher string".
    #[serde(default)]
    unl: serde_json::Value,
}

impl FeedValidator {
    fn in_unl(&self) -> bool {
        self.unl.as_str().is_some_and(|s| !s.is_empty())
    }
}

struct AdoptionCard {
    severity: Severity,
    key: String,
    title: String,
    text: String,
    fields: Vec<(String, String)>,
}

/// Tally the XRPL mainnet UNL against `min` and build the status card. Members
/// whose feed entry carries no `server_version` count as unknown (reported, not
/// scored). Severity scales with the vulnerable share of *reporting* members.
fn evaluate(validators: &[FeedValidator], min: (u8, u8, u8)) -> AdoptionCard {
    let unl: Vec<&FeedValidator> = validators
        .iter()
        .filter(|v| v.in_unl() && v.chain.as_deref() == Some("main"))
        .collect();
    let total = unl.len();

    let (mut patched, mut unknown) = (0usize, 0usize);
    let mut vulnerable: Vec<(String, String)> = Vec::new();
    for v in &unl {
        let label = v
            .domain
            .clone()
            .filter(|d| !d.is_empty())
            .or_else(|| {
                v.master_key
                    .as_ref()
                    .map(|k| k[..12.min(k.len())].to_string())
            })
            .unwrap_or_else(|| "unknown".into());
        match v.server_version.as_deref().and_then(version::parse_semver) {
            None => unknown += 1,
            Some(ver) if ver.below(min) => {
                vulnerable.push((label, v.server_version.clone().unwrap_or_default()))
            }
            Some(_) => patched += 1,
        }
    }
    let reporting = patched + vulnerable.len();
    let vuln_pct = vulnerable.len() * 100 / reporting.max(1);
    let patched_pct = patched * 100 / reporting.max(1);
    let severity = if vuln_pct >= crate::report::ADOPTION_CRIT_PCT {
        Severity::Critical
    } else if vuln_pct >= crate::report::ADOPTION_WARN_PCT {
        Severity::Warning
    } else {
        Severity::Info
    };

    let min_s = format!("{}.{}.{}", min.0, min.1, min.2);
    vulnerable.sort();
    let mut text = format!(
        "{patched}/{reporting} reporting UNL validators run >={min_s} ({patched_pct}%); \
         {} still on vulnerable pre-{min_s} builds.",
        vulnerable.len()
    );
    if unknown > 0 {
        text.push_str(&format!(
            " {unknown} of {total} UNL members report no version (excluded from the %)."
        ));
    }
    if !vulnerable.is_empty() {
        let list = vulnerable
            .iter()
            .map(|(dom, ver)| format!("- `{dom}` — {ver}"))
            .collect::<Vec<_>>()
            .join("\n");
        text.push_str(&format!("\n\n**Vulnerable UNL validators:**\n{list}"));
    }

    AdoptionCard {
        severity,
        key: format!("{min_s}@{patched_pct}"),
        title: format!("UNL patch adoption: {patched_pct}% of reporting validators on >={min_s}"),
        text,
        fields: vec![
            (format!("patched (>={min_s})"), patched.to_string()),
            (
                // "pre-X" not "<X": Mattermost renders "<3" as a heart emoji
                format!("vulnerable (pre-{min_s})"),
                vulnerable.len().to_string(),
            ),
            ("no version".into(), unknown.to_string()),
            ("UNL size".into(), total.to_string()),
        ],
    }
}

/// Fetch the validator feed.
async fn fetch(url: &str) -> anyhow::Result<Vec<FeedValidator>> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .user_agent("xrplf-release-notifier/monitors")
        .build()?;
    let feed: Feed = client.get(url).send().await?.json().await?;
    Ok(feed.validators)
}

/// Poll the feed, evaluate UNL adoption vs `min_version`, and post the card.
pub async fn run(
    feed_url: &str,
    min_version: &str,
    webhook: Option<String>,
    webhook_state: Option<String>,
    dry_run: bool,
) -> anyhow::Result<()> {
    let min = version::parse_min(min_version)
        .ok_or_else(|| anyhow::anyhow!("--min-safe-version '{min_version}' is not X.Y.Z"))?;
    let validators = fetch(feed_url).await?;
    let card = evaluate(&validators, min);

    let mut sink = AlertSink::new(webhook, dry_run, webhook_state, "xrpl-crawler/unl-adoption");
    if sink.enabled() {
        let now = chrono::Utc::now().timestamp();
        sink.send_every(
            crate::report::ADOPTION_REALERT_SECS,
            card.severity,
            "UNL_PATCH_ADOPTION",
            &card.key,
            &card.title,
            &card.text,
            card.fields.clone(),
            now,
        );
    }
    eprintln!("unl-adoption: {}", card.title);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(
        master: &str,
        chain: &str,
        unl: bool,
        sv: Option<&str>,
        dom: Option<&str>,
    ) -> FeedValidator {
        FeedValidator {
            master_key: Some(master.into()),
            domain: dom.map(Into::into),
            server_version: sv.map(Into::into),
            chain: Some(chain.into()),
            // mirror the feed: a publisher string when in a UNL, else `false`
            unl: if unl {
                serde_json::Value::String("vl.ripple.com".into())
            } else {
                serde_json::Value::Bool(false)
            },
        }
    }

    #[test]
    fn restricts_to_mainnet_unl_and_scores() {
        let feed = vec![
            v("nMAINp", "main", true, Some("3.2.1"), Some("a.example")),
            v("nMAINv", "main", true, Some("3.2.0"), Some("b.example")),
            v("nRC", "main", true, Some("3.2.1-rc1"), Some("c.example")), // RC → vulnerable
            v("nXAHAU", "xahau", true, Some("3.2.0"), None),              // wrong chain
            v("nNONUNL", "main", false, Some("3.2.0"), None),             // not UNL
        ];
        let c = evaluate(&feed, (3, 2, 1));
        // reporting = 3 (two vulnerable, one patched) → 33% patched
        assert_eq!(c.fields[0].1, "1"); // patched
        assert_eq!(c.fields[1].1, "2"); // vulnerable
        assert_eq!(c.fields[3].1, "3"); // UNL size (mainnet only)
        assert_eq!(c.key, "3.2.1@33");
        assert_eq!(c.severity, Severity::Critical); // 66% vulnerable
        assert!(c.text.contains("b.example"));
        assert!(c.text.contains("c.example")); // the RC is listed vulnerable
    }

    #[test]
    fn no_version_excluded_from_percent() {
        let feed = vec![
            v("nA", "main", true, Some("3.2.1"), None),
            v("nB", "main", true, None, None), // no version → unknown, not scored
        ];
        let c = evaluate(&feed, (3, 2, 1));
        assert_eq!(c.fields[0].1, "1"); // patched
        assert_eq!(c.fields[2].1, "1"); // no version
        assert_eq!(c.key, "3.2.1@100"); // 1/1 reporting patched
        assert_eq!(c.severity, Severity::Info);
        assert!(c.text.contains("report no version"));
    }

    #[test]
    fn movement_changes_dedup_key() {
        let low = evaluate(
            &[
                v("nA", "main", true, Some("3.2.1"), None),
                v("nB", "main", true, Some("3.2.0"), None),
            ],
            (3, 2, 1),
        );
        let high = evaluate(
            &[
                v("nA", "main", true, Some("3.2.1"), None),
                v("nB", "main", true, Some("3.2.1"), None),
            ],
            (3, 2, 1),
        );
        assert_ne!(low.key, high.key);
        assert_eq!(high.key, "3.2.1@100");
    }
}
