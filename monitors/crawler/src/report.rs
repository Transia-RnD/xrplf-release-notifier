//! Machine-readable crawl report + snapshot alert rules.
//!
//! [`compute`] distills a finished [`CrawlState`] into counts (mirroring the
//! human report and eclipse analysis printed to stderr). [`evaluate`] compares
//! the fresh report against the previous one and yields the alerts to post.

use crate::types::CrawlState;
use monitor_common::Severity;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// ≥ this many suspicious nodes escalates SUSPICIOUS_VERSION to CRITICAL.
pub const SUSPICIOUS_CRIT: usize = 10;
/// ≥ this many medium-risk eclipse targets raises a WARNING.
pub const ECLIPSE_MEDIUM_THRESHOLD: usize = 3;
/// Below this node count we don't judge topology collapse (too small to trust).
pub const COLLAPSE_FLOOR: usize = 100;
/// Node count under this fraction of the previous crawl → TOPOLOGY_COLLAPSE.
pub const COLLAPSE_RATIO_PCT: usize = 60;
/// A version new since the last crawl needs at least this many nodes to report
/// (filters one-off dev/test builds from a genuine release rollout).
pub const NEW_VERSION_MIN_NODES: usize = 10;
/// PATCH_ADOPTION re-post window while the patched share is unchanged. Movement
/// (a new percent, hence a new dedup key) posts immediately; steady state
/// heartbeats at this interval instead of the default 24h.
pub const ADOPTION_REALERT_SECS: i64 = 43_200;
/// Dedup-key granularity for the adoption percent, in percentage points. The key
/// encodes the patched share, and the hourly crawl's node set churns by a node or
/// two, so banding is what keeps churn from counting as movement.
pub const ADOPTION_BAND_PCT: usize = 5;
/// Vulnerable share ≥ this → PATCH_ADOPTION posts CRITICAL.
pub const ADOPTION_CRIT_PCT: usize = 50;
/// Vulnerable share ≥ this (and < critical) → WARNING; below → INFO.
pub const ADOPTION_WARN_PCT: usize = 10;

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct Report {
    pub nodes: usize,
    pub suspicious: usize,
    pub versions: HashMap<String, usize>,
    pub leak_points: usize,
    pub eclipse_high: usize,
    pub eclipse_medium: usize,
    // Crawl-completeness signals (set by the crawl driver, not `compute`), used to
    // suppress a false TOPOLOGY_COLLAPSE when the crawl itself was partial.
    #[serde(default)]
    pub seeds: usize,
    #[serde(default)]
    pub endpoints_crawled: usize,
    #[serde(default)]
    pub crawl_errors: usize,
}

/// Distill a finished crawl into counts. `sus_version` empty ⇒ suspicion off.
pub fn compute(state: &CrawlState) -> Report {
    let mut versions: HashMap<String, usize> = HashMap::new();
    let mut suspicious = 0usize;
    for n in state.nodes.values() {
        *versions
            .entry(n.version.clone().unwrap_or_else(|| "unknown".into()))
            .or_default() += 1;
        if n.suspicious {
            suspicious += 1;
        }
    }
    let sus_pks: std::collections::HashSet<&str> = state
        .nodes
        .values()
        .filter(|n| n.suspicious)
        .map(|n| n.pubkey.as_str())
        .collect();

    // Leak points: legitimate <-> suspicious edges (unique unordered pairs).
    let mut leak_pairs: std::collections::HashSet<(String, String)> =
        std::collections::HashSet::new();
    for e in &state.edges {
        let src_sus = sus_pks.contains(e.source.as_str());
        let peer_sus = sus_pks.contains(e.peer.as_str());
        if src_sus ^ peer_sus {
            let (a, b) = if e.source < e.peer {
                (e.source.clone(), e.peer.clone())
            } else {
                (e.peer.clone(), e.source.clone())
            };
            leak_pairs.insert((a, b));
        }
    }

    // Eclipse: per crawlable legitimate node, share of inbound peers suspicious.
    let mut eclipse_high = 0usize;
    let mut eclipse_medium = 0usize;
    for node in state.nodes.values() {
        if !node.crawlable || node.suspicious {
            continue;
        }
        let edges: Vec<_> = state
            .edges
            .iter()
            .filter(|e| e.source == node.pubkey)
            .collect();
        if edges.is_empty() {
            continue;
        }
        let (mut in_t, mut in_s, mut out_s) = (0usize, 0usize, 0usize);
        for e in &edges {
            let peer_sus = sus_pks.contains(e.peer.as_str());
            match e.peer_type.as_str() {
                "out" => {
                    if peer_sus {
                        out_s += 1;
                    }
                }
                _ => {
                    in_t += 1;
                    if peer_sus {
                        in_s += 1;
                    }
                }
            }
        }
        if in_s == 0 && out_s == 0 {
            continue;
        }
        let in_pct = if in_t > 0 {
            (in_s as f64 / in_t as f64) * 100.0
        } else {
            0.0
        };
        if in_pct >= 50.0 {
            eclipse_high += 1;
        } else if in_pct >= 25.0 || in_s + out_s >= 3 {
            eclipse_medium += 1;
        }
    }

    Report {
        nodes: state.nodes.len(),
        suspicious,
        versions,
        leak_points: leak_pairs.len(),
        eclipse_high,
        eclipse_medium,
        // Filled in by the crawl driver (it has the crawl attempt/error counts).
        ..Default::default()
    }
}

pub struct RuleAlert {
    pub severity: Severity,
    pub category: &'static str,
    pub key: String,
    pub title: String,
    pub text: String,
    pub fields: Vec<(String, String)>,
}

/// Snapshot rules comparing a fresh report against the previous crawl.
pub fn evaluate(report: &Report, prev: Option<&Report>) -> Vec<RuleAlert> {
    let mut out = Vec::new();

    if report.suspicious > 0 {
        let sev = if report.suspicious >= SUSPICIOUS_CRIT {
            Severity::Critical
        } else {
            Severity::Warning
        };
        out.push(RuleAlert {
            severity: sev,
            category: "SUSPICIOUS_VERSION",
            key: "count".into(),
            title: format!(
                "{} suspicious-version nodes on the network",
                report.suspicious
            ),
            text:
                "Nodes advertising the configured suspicious version were found during the crawl."
                    .into(),
            fields: vec![
                ("suspicious".into(), report.suspicious.to_string()),
                ("total_nodes".into(), report.nodes.to_string()),
                ("leak_points".into(), report.leak_points.to_string()),
            ],
        });
    }

    if report.eclipse_high > 0 || report.eclipse_medium >= ECLIPSE_MEDIUM_THRESHOLD {
        let sev = if report.eclipse_high > 0 {
            Severity::Critical
        } else {
            Severity::Warning
        };
        out.push(RuleAlert {
            severity: sev,
            category: "ECLIPSE_RISK",
            key: "risk".into(),
            title: format!(
                "Eclipse risk: {} high, {} medium",
                report.eclipse_high, report.eclipse_medium
            ),
            text: "Legitimate nodes have a high share of suspicious inbound peers.".into(),
            fields: vec![
                ("high_risk".into(), report.eclipse_high.to_string()),
                ("medium_risk".into(), report.eclipse_medium.to_string()),
            ],
        });
    }

    if let Some(prev) = prev {
        // NEW_VERSION — a version absent (or negligible) last crawl now on a
        // meaningful share of nodes: a release rolling out across the network.
        for (ver, &count) in &report.versions {
            if ver == "unknown" || count < NEW_VERSION_MIN_NODES {
                continue;
            }
            if prev.versions.get(ver).copied().unwrap_or(0) == 0 {
                let pct = report.nodes.max(1);
                out.push(RuleAlert {
                    severity: Severity::Info,
                    category: "NEW_VERSION",
                    key: ver.clone(),
                    title: format!("New node version on the network: {ver}"),
                    text: format!(
                        "{count} nodes are now running {ver} (not seen in the previous crawl)."
                    ),
                    fields: vec![
                        ("version".into(), ver.clone()),
                        ("nodes".into(), count.to_string()),
                        ("share".into(), format!("{}%", count * 100 / pct)),
                    ],
                });
            }
        }

        // Completeness guard: a crawl that mostly errored, or started from
        // materially fewer seeds than the baseline, sees fewer nodes for reasons
        // that have nothing to do with the real topology — don't cry collapse.
        let attempts = report.endpoints_crawled + report.crawl_errors;
        let high_error_rate = attempts > 0 && report.crawl_errors * 100 > attempts * 40;
        let seeds_shrank = prev.seeds > 0 && report.seeds * 2 < prev.seeds;
        if prev.nodes >= COLLAPSE_FLOOR
            && report.nodes * 100 < prev.nodes * COLLAPSE_RATIO_PCT
            && !high_error_rate
            && !seeds_shrank
        {
            out.push(RuleAlert {
                severity: Severity::Warning,
                category: "TOPOLOGY_COLLAPSE",
                key: "collapse".into(),
                title: format!("Crawl node count dropped to {} (was {})", report.nodes, prev.nodes),
                text: "The reachable topology shrank sharply since the last crawl — possible partition or crawl failure.".into(),
                fields: vec![
                    ("now".into(), report.nodes.to_string()),
                    ("previous".into(), prev.nodes.to_string()),
                ],
            });
        }
    }

    out
}

/// Base semver of a core rippled/xrpld build string ("xrpld-3.2.1-rc1" →
/// (3,2,1)), or None for non-core clients ("xrpl-rust-validator/0.1.0",
/// "xrpld-rs-3.2.0", "unknown").
pub fn core_semver(version: &str) -> Option<(u8, u8, u8)> {
    let rest = version
        .strip_prefix("rippled-")
        .or_else(|| version.strip_prefix("xrpld-"))?;
    let mut parts = rest.splitn(3, '.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch: String = parts
        .next()?
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    Some((major, minor, patch.parse().ok()?))
}

/// Dedup key for an adoption status card: the patched percent rounded down to
/// an [`ADOPTION_BAND_PCT`] band, plus the severity so an escalation always
/// mints a new key even if it lands inside the current band.
pub fn adoption_key(min_s: &str, patched_pct: usize, severity: Severity) -> String {
    let band = patched_pct / ADOPTION_BAND_PCT * ADOPTION_BAND_PCT;
    format!("{min_s}@{band}/{}", severity.label())
}

/// PATCH_ADOPTION — share of core nodes running a build at/above `min` (a
/// hotfix). Pre-releases of `min` itself count as patched, matching the
/// incident-time attack-report.py. Always returns an alert (it's a status
/// card, not a fault signal); the dedup key encodes the patched percent so a
/// change of [`ADOPTION_BAND_PCT`] posts immediately and steady state falls to
/// the heartbeat window.
/// The bool is true when no vulnerable core nodes remain (and at least one
/// core node reports) — the caller should then post once and stop the
/// heartbeat.
pub fn evaluate_adoption(report: &Report, min: (u8, u8, u8)) -> (RuleAlert, bool) {
    let (mut patched, mut vulnerable, mut other) = (0usize, 0usize, 0usize);
    let mut lagging: Vec<(&str, usize)> = Vec::new();
    for (ver, &count) in &report.versions {
        match core_semver(ver) {
            Some(base) if base >= min => patched += count,
            Some(_) => {
                vulnerable += count;
                lagging.push((ver, count));
            }
            None => other += count,
        }
    }
    let core = patched + vulnerable;
    let patched_pct = patched * 100 / core.max(1);
    let vuln_pct = vulnerable * 100 / core.max(1);
    let severity = if vuln_pct >= ADOPTION_CRIT_PCT {
        Severity::Critical
    } else if vuln_pct >= ADOPTION_WARN_PCT {
        Severity::Warning
    } else {
        Severity::Info
    };
    lagging.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
    let top = lagging
        .iter()
        .take(5)
        .map(|(v, c)| format!("- `{v}` — {c}"))
        .collect::<Vec<_>>()
        .join("\n");
    let min_s = format!("{}.{}.{}", min.0, min.1, min.2);
    let mut text = format!(
        "Crawl of {} reachable nodes: of {core} core (rippled/xrpld) nodes, \
         {patched_pct}% run >={min_s} and {vuln_pct}% remain on vulnerable pre-{min_s} builds.",
        report.nodes
    );
    if !top.is_empty() {
        text.push_str(&format!("\n\n**Top vulnerable builds:**\n{top}"));
    }
    let alert = RuleAlert {
        severity,
        category: "PATCH_ADOPTION",
        key: adoption_key(&min_s, patched_pct, severity),
        title: format!("Patch adoption: {patched_pct}% of core nodes on >={min_s}"),
        text,
        fields: vec![
            (format!("patched (>={min_s})"), patched.to_string()),
            // "pre-X" not "<X": Mattermost renders "<3" as a heart emoji
            (format!("vulnerable (pre-{min_s})"), vulnerable.to_string()),
            ("other/non-core".into(), other.to_string()),
            ("total crawled".into(), report.nodes.to_string()),
        ],
    };
    (alert, vulnerable == 0 && core > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rpt(nodes: usize, suspicious: usize, high: usize, medium: usize) -> Report {
        Report {
            nodes,
            suspicious,
            eclipse_high: high,
            eclipse_medium: medium,
            ..Default::default()
        }
    }

    #[test]
    fn clean_report_no_alerts() {
        assert!(evaluate(&rpt(900, 0, 0, 0), Some(&rpt(950, 0, 0, 0))).is_empty());
    }

    #[test]
    fn suspicious_escalates_at_threshold() {
        let a = evaluate(&rpt(900, 3, 0, 0), None);
        assert_eq!(a[0].severity, Severity::Warning);
        let b = evaluate(&rpt(900, 12, 0, 0), None);
        assert_eq!(b[0].severity, Severity::Critical);
    }

    #[test]
    fn eclipse_high_is_critical() {
        let a = evaluate(&rpt(900, 0, 1, 0), None);
        assert!(a
            .iter()
            .any(|x| x.category == "ECLIPSE_RISK" && x.severity == Severity::Critical));
    }

    #[test]
    fn new_version_reports_only_meaningful_rollout() {
        let mut now = rpt(900, 0, 0, 0);
        now.versions = HashMap::from([
            ("xrpld-3.3.0".into(), 40), // new, meaningful
            ("xrpld-3.2.0".into(), 800),
            ("dev-build".into(), 2), // new but below min
        ]);
        let mut prev = rpt(900, 0, 0, 0);
        prev.versions = HashMap::from([("xrpld-3.2.0".into(), 840)]);
        let a = evaluate(&now, Some(&prev));
        let new_versions: Vec<_> = a
            .iter()
            .filter(|x| x.category == "NEW_VERSION")
            .map(|x| x.key.as_str())
            .collect();
        assert_eq!(new_versions, vec!["xrpld-3.3.0"]);
        // no prev → no NEW_VERSION (cold)
        assert!(!evaluate(&now, None)
            .iter()
            .any(|x| x.category == "NEW_VERSION"));
    }

    #[test]
    fn core_semver_matches_attack_report_classification() {
        // core builds, incl. pre-releases and vendor suffixes
        assert_eq!(core_semver("xrpld-3.2.1"), Some((3, 2, 1)));
        assert_eq!(core_semver("rippled-3.1.3"), Some((3, 1, 3)));
        assert_eq!(core_semver("xrpld-3.2.1-rc1"), Some((3, 2, 1)));
        assert_eq!(core_semver("xrpld-3.3.0-b1"), Some((3, 3, 0)));
        assert_eq!(core_semver("xrpld-3.2.0-DJS"), Some((3, 2, 0)));
        assert_eq!(
            core_semver("xrpld-3.3.0-rc1+5db10a4d.DEBUG"),
            Some((3, 3, 0))
        );
        // non-core / unparseable
        assert_eq!(core_semver("xrpl-rust-validator/0.1.0"), None);
        assert_eq!(core_semver("xrpld-rs-3.2.0"), None);
        assert_eq!(core_semver("unknown"), None);
        assert_eq!(core_semver("Hubster/1.0.0"), None);
        assert_eq!(core_semver("xrpld-3.2"), None);
    }

    #[test]
    fn adoption_buckets_percent_and_severity() {
        let mut r = rpt(1000, 0, 0, 0);
        r.versions = HashMap::from([
            ("xrpld-3.2.1".into(), 150),
            ("xrpld-3.3.0-rc6".into(), 50),
            ("xrpld-3.2.0".into(), 600),
            ("rippled-3.1.3".into(), 200),
            ("xrpl-rust-validator/0.1.0".into(), 50),
        ]);
        let (a, fully_patched) = evaluate_adoption(&r, (3, 2, 1));
        // 200 patched / 1000 core → 20%, 80% vulnerable → CRITICAL
        assert!(!fully_patched);
        assert_eq!(a.severity, Severity::Critical);
        assert_eq!(a.key, "3.2.1@20/CRITICAL");
        assert!(a.title.contains("20%"));
        assert!(a.text.contains("xrpld-3.2.0"));
        assert_eq!(a.fields[0].1, "200");
        assert_eq!(a.fields[1].1, "800");
        assert_eq!(a.fields[2].1, "50");

        // mostly patched → WARNING band, then INFO when nearly complete
        r.versions = HashMap::from([("xrpld-3.2.1".into(), 850), ("xrpld-3.2.0".into(), 150)]);
        assert_eq!(
            evaluate_adoption(&r, (3, 2, 1)).0.severity,
            Severity::Warning
        );
        r.versions = HashMap::from([("xrpld-3.2.1".into(), 950), ("xrpld-3.2.0".into(), 50)]);
        let (done, fully_patched) = evaluate_adoption(&r, (3, 2, 1));
        assert_eq!(done.severity, Severity::Info);
        assert!(!fully_patched); // 50 still vulnerable
                                 // movement changes the dedup key → posts immediately
        assert_ne!(done.key, "3.2.1@20/CRITICAL");
        assert_eq!(done.key, "3.2.1@95/INFO");

        // everyone patched → terminal card, heartbeat stops
        r.versions = HashMap::from([("xrpld-3.2.1".into(), 1000)]);
        let (all_clear, fully_patched) = evaluate_adoption(&r, (3, 2, 1));
        assert_eq!(all_clear.key, "3.2.1@100/INFO");
        assert!(fully_patched);
    }

    #[test]
    fn adoption_handles_no_core_nodes() {
        let mut r = rpt(10, 0, 0, 0);
        r.versions = HashMap::from([("Hubster/1.0.0".into(), 10)]);
        let (a, fully_patched) = evaluate_adoption(&r, (3, 2, 1));
        assert_eq!(a.severity, Severity::Info);
        assert_eq!(a.key, "3.2.1@0/INFO");
        assert!(!fully_patched); // zero core nodes is no evidence of patching
    }

    #[test]
    fn topology_collapse_needs_prev_over_floor() {
        // previous below floor → no alert even on big drop
        assert!(evaluate(&rpt(10, 0, 0, 0), Some(&rpt(50, 0, 0, 0))).is_empty());
        // previous over floor, >40% drop → alert
        let a = evaluate(&rpt(50, 0, 0, 0), Some(&rpt(200, 0, 0, 0)));
        assert!(a.iter().any(|x| x.category == "TOPOLOGY_COLLAPSE"));
    }
}
