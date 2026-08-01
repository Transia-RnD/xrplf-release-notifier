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

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct Report {
    pub nodes: usize,
    pub suspicious: usize,
    pub versions: HashMap<String, usize>,
    pub leak_points: usize,
    pub eclipse_high: usize,
    pub eclipse_medium: usize,
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
    let mut leak_pairs: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
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
        let edges: Vec<_> = state.edges.iter().filter(|e| e.source == node.pubkey).collect();
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
        let in_pct = if in_t > 0 { (in_s as f64 / in_t as f64) * 100.0 } else { 0.0 };
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
            title: format!("{} suspicious-version nodes on the network", report.suspicious),
            text: "Nodes advertising the configured suspicious version were found during the crawl.".into(),
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
                    text: format!("{count} nodes are now running {ver} (not seen in the previous crawl)."),
                    fields: vec![
                        ("version".into(), ver.clone()),
                        ("nodes".into(), count.to_string()),
                        ("share".into(), format!("{}%", count * 100 / pct)),
                    ],
                });
            }
        }

        if prev.nodes >= COLLAPSE_FLOOR && report.nodes * 100 < prev.nodes * COLLAPSE_RATIO_PCT {
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
        assert!(a.iter().any(|x| x.category == "ECLIPSE_RISK" && x.severity == Severity::Critical));
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
        let new_versions: Vec<_> = a.iter().filter(|x| x.category == "NEW_VERSION").map(|x| x.key.as_str()).collect();
        assert_eq!(new_versions, vec!["xrpld-3.3.0"]);
        // no prev → no NEW_VERSION (cold)
        assert!(!evaluate(&now, None).iter().any(|x| x.category == "NEW_VERSION"));
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
