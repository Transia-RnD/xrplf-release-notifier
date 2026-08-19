//! Webhook alert sink with hysteresis, shared by `monitor` and `crawl`.
//!
//! Alerts dedup on a `category:key` string and re-fire at most once per
//! [`REALERT_SECS`] while a condition persists, so an ongoing fork or eclipse
//! posts daily rather than on every validation. `--dry-run` prints instead.

use monitor_common::state as cstate;
use monitor_common::{Alert as CAlert, Notifier, Severity};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const REALERT_SECS: i64 = 86_400;

/// Floor on how often a *healthy* status card repeats, applied to INFO by
/// [`AlertSink::send_status`]. Status cards repeat so silence can't pass for a
/// dead pipeline; weekly is enough because OBSERVATORY_STALE reports liveness.
pub const HEALTHY_REALERT_SECS: i64 = 7 * 86_400;

#[derive(Default, Serialize, Deserialize)]
struct DedupState {
    last_sent: HashMap<String, i64>,
}

pub struct AlertSink {
    notifier: Notifier,
    state_path: Option<String>,
    dedup: DedupState,
    enabled: bool,
    /// A state path is configured but cannot be written, so nothing this run
    /// posts can be recorded. See [`Self::send_status`].
    dedup_broken: bool,
}

impl AlertSink {
    pub fn new(
        webhook: Option<String>,
        dry_run: bool,
        state_path: Option<String>,
        source: &str,
    ) -> Self {
        let enabled = webhook.is_some() || dry_run;
        let dedup: DedupState = state_path
            .as_ref()
            .and_then(cstate::load_state)
            .unwrap_or_default();
        // Probe the write path by storing back what was just loaded: unpersisted
        // dedup means every run re-fires from stale timestamps.
        let dedup_broken = match &state_path {
            Some(p) => match cstate::save_state(p, &dedup) {
                Ok(()) => false,
                Err(e) => {
                    eprintln!("crawler: alert-state at {p} is not writable ({e}) — status cards suppressed this run");
                    true
                }
            },
            None => false,
        };
        AlertSink {
            notifier: Notifier::new(
                if dry_run { None } else { webhook },
                "xrpl network monitor",
                source,
            ),
            state_path,
            dedup,
            enabled,
            dedup_broken,
        }
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    /// The most recently posted key for `category`, without its `category:`
    /// prefix. Lets a caller ask what it last said before saying it again.
    pub fn last_key_for(&self, category: &str) -> Option<&str> {
        let prefix = format!("{category}:");
        self.dedup
            .last_sent
            .iter()
            .filter_map(|(k, ts)| k.strip_prefix(&prefix).map(|rest| (rest, ts)))
            .max_by_key(|(_, ts)| **ts)
            .map(|(rest, _)| rest)
    }

    /// Map the crawler's string severity to the shared enum.
    pub fn severity_of(s: &str) -> Severity {
        match s {
            "CRITICAL" => Severity::Critical,
            "WARNING" => Severity::Warning,
            _ => Severity::Info,
        }
    }

    /// Post an alert unless the same `category:key` fired within REALERT_SECS.
    #[allow(clippy::too_many_arguments)]
    pub fn send(
        &mut self,
        severity: Severity,
        category: &str,
        key: &str,
        title: &str,
        text: &str,
        fields: Vec<(String, String)>,
        now_unix: i64,
    ) {
        self.send_every(
            REALERT_SECS,
            severity,
            category,
            key,
            title,
            text,
            fields,
            now_unix,
        )
    }

    /// [`Self::send_every`] for a status card, where the re-fire window depends
    /// on whether the picture needs action: INFO waits at least
    /// [`HEALTHY_REALERT_SECS`], anything higher uses `degraded_secs`. The
    /// healthy window is a floor, so a caller that passes a longer window (a
    /// terminal all-clear posting once) keeps it.
    ///
    /// Skipped entirely when dedup can't be persisted: a status card restates the
    /// picture every run, so without dedup it posts on every tick. Fault alerts
    /// go out regardless, via [`Self::send`].
    #[allow(clippy::too_many_arguments)]
    pub fn send_status(
        &mut self,
        degraded_secs: i64,
        severity: Severity,
        category: &str,
        key: &str,
        title: &str,
        text: &str,
        fields: Vec<(String, String)>,
        now_unix: i64,
    ) {
        if self.dedup_broken {
            eprintln!("crawler: {category} suppressed (dedup state unwritable): {title}");
            return;
        }
        let realert = if severity == Severity::Info {
            degraded_secs.max(HEALTHY_REALERT_SECS)
        } else {
            degraded_secs
        };
        self.send_every(
            realert, severity, category, key, title, text, fields, now_unix,
        )
    }

    /// [`Self::send`] with a caller-chosen re-fire window instead of REALERT_SECS.
    #[allow(clippy::too_many_arguments)]
    pub fn send_every(
        &mut self,
        realert_secs: i64,
        severity: Severity,
        category: &str,
        key: &str,
        title: &str,
        text: &str,
        fields: Vec<(String, String)>,
        now_unix: i64,
    ) {
        if !self.enabled {
            return;
        }
        let dkey = format!("{category}:{key}");
        if let Some(&last) = self.dedup.last_sent.get(&dkey) {
            if now_unix - last < realert_secs {
                return;
            }
        }
        let mut alert = CAlert::new(severity, category, title, text);
        for (t, v) in fields {
            alert = alert.field(t, v);
        }
        if let Err(e) = self.notifier.send(&[alert]) {
            eprintln!("crawler: notify failed: {e}");
            return;
        }
        self.dedup.last_sent.insert(dkey, now_unix);
        if let Some(p) = &self.state_path {
            if let Err(e) = cstate::save_state(p, &self.dedup) {
                eprintln!("crawler: alert-state save failed: {e}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `state_path: None` keeps dedup in memory; `dry_run` prints instead of posting.
    fn sink() -> AlertSink {
        AlertSink::new(None, true, None, "test")
    }

    fn status(sink: &mut AlertSink, sev: Severity, now: i64) {
        sink.send_status(
            REALERT_SECS,
            sev,
            "SUMMARY",
            "same-key",
            "t",
            "x",
            vec![],
            now,
        );
    }

    fn last(sink: &AlertSink) -> Option<i64> {
        sink.dedup.last_sent.get("SUMMARY:same-key").copied()
    }

    #[test]
    fn healthy_status_repeats_weekly_not_daily() {
        let mut s = sink();
        status(&mut s, Severity::Info, 0);
        assert_eq!(last(&s), Some(0));
        // a day later the all-clear is still quiet
        status(&mut s, Severity::Info, REALERT_SECS + 1);
        assert_eq!(last(&s), Some(0));
        status(&mut s, Severity::Info, HEALTHY_REALERT_SECS + 1);
        assert_eq!(last(&s), Some(HEALTHY_REALERT_SECS + 1));
    }

    #[test]
    fn status_needing_action_keeps_the_degraded_window() {
        let mut s = sink();
        status(&mut s, Severity::Warning, 0);
        status(&mut s, Severity::Warning, REALERT_SECS - 1);
        assert_eq!(last(&s), Some(0));
        status(&mut s, Severity::Warning, REALERT_SECS + 1);
        assert_eq!(last(&s), Some(REALERT_SECS + 1));
    }

    // Unwritable dedup means stale timestamps every run, so a periodic status
    // card would re-fire on every poll.
    #[test]
    fn unwritable_dedup_suppresses_status_cards_but_not_faults() {
        // A regular file can't be a parent directory, so this path is uncreatable.
        let barrier = std::env::temp_dir().join(format!("sink-probe-{}", std::process::id()));
        std::fs::write(&barrier, b"").unwrap();
        let blocked = barrier.join("state.json").to_string_lossy().into_owned();
        let mut s = AlertSink::new(None, true, Some(blocked), "test");
        std::fs::remove_file(&barrier).unwrap();
        assert!(s.dedup_broken);

        status(&mut s, Severity::Info, 0);
        status(&mut s, Severity::Warning, 0);
        assert!(last(&s).is_none()); // no status card posted, nothing recorded

        // a fault alert is never suppressed — it dedups on its own key
        s.send(Severity::Critical, "FORK", "k", "t", "x", vec![], 0);
        assert_eq!(s.dedup.last_sent.get("FORK:k"), Some(&0));
    }

    #[test]
    fn last_key_for_returns_the_most_recent_key_in_a_category() {
        let mut s = sink();
        let send = |s: &mut AlertSink, key: &str, now: i64| {
            s.send_every(1, Severity::Info, "ADOPT", key, "t", "x", vec![], now)
        };
        send(&mut s, "3.2.1@75/WARNING", 100);
        send(&mut s, "3.2.1@100/INFO", 200);
        // a category that merely starts with "ADOPT" must not be matched
        s.send_every(1, Severity::Info, "ADOPTX", "newer", "t", "x", vec![], 300);
        assert_eq!(s.last_key_for("ADOPT"), Some("3.2.1@100/INFO"));
        assert_eq!(s.last_key_for("ADOPTX"), Some("newer"));
        assert_eq!(s.last_key_for("MISSING"), None);
    }

    #[test]
    fn healthy_window_is_a_floor_so_a_terminal_card_posts_once() {
        let mut s = sink();
        s.send_status(i64::MAX, Severity::Info, "A", "k", "t", "x", vec![], 0);
        s.send_status(
            i64::MAX,
            Severity::Info,
            "A",
            "k",
            "t",
            "x",
            vec![],
            HEALTHY_REALERT_SECS * 52,
        );
        assert_eq!(s.dedup.last_sent.get("A:k"), Some(&0));
    }
}
