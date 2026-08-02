//! Decode the `server_version` carried in validation messages and evaluate UNL
//! upgrade adoption after a hotfix.
//!
//! Encoding (from rippled `BuildInfo.cpp`): the top 16 bits are the `0x183B`
//! implementation marker, then `major<<40 | minor<<32 | patch<<24`, and a
//! pre-release byte at bits 16–23 (`0xC0` = final release, `0x80|n` = rc,
//! `0x40|n` = beta). So a validation tells us the exact build each validator runs.

use monitor_common::{Alert, Severity};
use std::collections::HashMap;

const IMPL_MARKER: u64 = 0x183B_0000_0000_0000;
const IMPL_MASK: u64 = 0xFFFF_0000_0000_0000;

#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Version {
    pub major: u8,
    pub minor: u8,
    pub patch: u8,
    pub is_final: bool,
}

impl Version {
    /// Compare only major.minor.patch (a final and a pre-release of the same
    /// numbers rank equal here; the `is_final` flag breaks ties where it matters).
    pub fn tuple(&self) -> (u8, u8, u8) {
        (self.major, self.minor, self.patch)
    }

    /// True if this build is older than `min` (a pre-release of exactly `min`
    /// counts as below `min`, since the hotfix lands in the final).
    pub fn below(&self, min: (u8, u8, u8)) -> bool {
        match self.tuple().cmp(&min) {
            std::cmp::Ordering::Less => true,
            std::cmp::Ordering::Greater => false,
            std::cmp::Ordering::Equal => !self.is_final,
        }
    }

    pub fn display(&self) -> String {
        format!(
            "{}.{}.{}{}",
            self.major,
            self.minor,
            self.patch,
            if self.is_final { "" } else { "-pre" }
        )
    }
}

/// Decode a `server_version` integer, or None if it isn't a rippled/xrpld build.
pub fn decode(encoded: u64) -> Option<Version> {
    if (encoded & IMPL_MASK) != IMPL_MARKER {
        return None;
    }
    let pre = (encoded >> 16) & 0xFF;
    Some(Version {
        major: ((encoded >> 40) & 0xFF) as u8,
        minor: ((encoded >> 32) & 0xFF) as u8,
        patch: ((encoded >> 24) & 0xFF) as u8,
        is_final: pre == 0xC0,
    })
}

/// Parse "X.Y.Z" into a comparison tuple.
pub fn parse_min(s: &str) -> Option<(u8, u8, u8)> {
    let mut it = s.split('.');
    Some((
        it.next()?.parse().ok()?,
        it.next()?.parse().ok()?,
        it.next()?.parse().ok()?,
    ))
}

/// Parse a human version string as reported by data.xrpl.org's validator feed
/// ("3.2.0", "3.2.1-rc1", "3.2.0-b7") into a [`Version`]. Any pre-release
/// suffix marks `is_final = false`, so an RC of the hotfix ranks below the
/// final via [`Version::below`], matching the crawl's classification.
pub fn parse_semver(s: &str) -> Option<Version> {
    let (core, pre) = match s.split_once('-') {
        Some((c, _)) => (c, false),
        None => (s, true),
    };
    let (major, minor, patch) = parse_min(core)?;
    Some(Version {
        major,
        minor,
        patch,
        is_final: pre,
    })
}

/// Evaluate UNL upgrade adoption: how many observed validators run a build below
/// `min`. Returns an alert when any lag (severity scales with the share).
pub fn evaluate_adoption(versions: &HashMap<String, Version>, min: (u8, u8, u8)) -> Option<Alert> {
    let total = versions.len();
    if total == 0 {
        return None;
    }
    let laggards: Vec<&Version> = versions.values().filter(|v| v.below(min)).collect();
    let below = laggards.len();
    if below == 0 {
        return None;
    }
    let pct = below * 100 / total;
    let sev = if pct >= 34 {
        Severity::Critical
    } else {
        Severity::Warning
    };
    // Distinct lagging builds, for the alert body.
    let mut builds: Vec<String> = laggards.iter().map(|v| v.display()).collect();
    builds.sort();
    builds.dedup();
    let builds_str = builds.join(", ");
    Some(
        Alert::new(
            sev,
            "VALIDATOR_VERSION_LAG",
            format!("{below}/{total} validators below {}.{}.{}", min.0, min.1, min.2),
            format!(
                "{below} of {total} observed validators are still running a build older than {}.{}.{} ({builds_str}) — after a hotfix these need to upgrade.",
                min.0, min.1, min.2
            ),
        )
        .field("below", below.to_string())
        .field("total", total.to_string())
        .field("min_version", format!("{}.{}.{}", min.0, min.1, min.2))
        .field("builds", builds_str),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_known_value_to_3_2_0() {
        // captured from a live validation on 2026-08-01
        let v = decode(1745992587673600000).unwrap();
        assert_eq!(v.tuple(), (3, 2, 0));
        assert!(v.is_final);
        assert_eq!(v.display(), "3.2.0");
    }

    #[test]
    fn non_rippled_value_is_none() {
        assert!(decode(0).is_none());
        assert!(decode(12345).is_none());
    }

    #[test]
    fn parse_semver_handles_data_api_strings() {
        assert_eq!(parse_semver("3.2.0").unwrap().tuple(), (3, 2, 0));
        assert!(parse_semver("3.2.0").unwrap().is_final);
        // an RC of the fix parses as a pre-release and ranks below the final
        let rc = parse_semver("3.2.1-rc1").unwrap();
        assert_eq!(rc.tuple(), (3, 2, 1));
        assert!(!rc.is_final);
        assert!(rc.below((3, 2, 1)));
        assert!(parse_semver("3.2.0-b7").unwrap().below((3, 2, 1)));
        assert!(!parse_semver("3.3.0").unwrap().below((3, 2, 1)));
        assert!(parse_semver("garbage").is_none());
    }

    #[test]
    fn below_threshold_semantics() {
        let final_320 = Version {
            major: 3,
            minor: 2,
            patch: 0,
            is_final: true,
        };
        let final_321 = Version {
            major: 3,
            minor: 2,
            patch: 1,
            is_final: true,
        };
        let rc_321 = Version {
            major: 3,
            minor: 2,
            patch: 1,
            is_final: false,
        };
        assert!(final_320.below((3, 2, 1)));
        assert!(!final_321.below((3, 2, 1)));
        assert!(rc_321.below((3, 2, 1))); // rc of the hotfix counts as below final
    }

    #[test]
    fn adoption_alert_scales() {
        let mut m = HashMap::new();
        m.insert(
            "a".into(),
            Version {
                major: 3,
                minor: 2,
                patch: 0,
                is_final: true,
            },
        );
        m.insert(
            "b".into(),
            Version {
                major: 3,
                minor: 2,
                patch: 1,
                is_final: true,
            },
        );
        // 1/2 below → 50% → CRITICAL
        let a = evaluate_adoption(&m, (3, 2, 1)).unwrap();
        assert_eq!(a.severity, Severity::Critical);
        // all patched → no alert
        m.insert(
            "a".into(),
            Version {
                major: 3,
                minor: 2,
                patch: 1,
                is_final: true,
            },
        );
        assert!(evaluate_adoption(&m, (3, 2, 1)).is_none());
    }
}
