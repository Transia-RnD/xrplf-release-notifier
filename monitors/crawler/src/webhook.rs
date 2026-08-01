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

#[derive(Default, Serialize, Deserialize)]
struct DedupState {
    last_sent: HashMap<String, i64>,
}

pub struct AlertSink {
    notifier: Notifier,
    state_path: Option<String>,
    dedup: DedupState,
    enabled: bool,
}

impl AlertSink {
    pub fn new(webhook: Option<String>, dry_run: bool, state_path: Option<String>, source: &str) -> Self {
        let enabled = webhook.is_some() || dry_run;
        let dedup = state_path.as_ref().and_then(cstate::load_state).unwrap_or_default();
        AlertSink {
            notifier: Notifier::new(
                if dry_run { None } else { webhook },
                "xrpl network monitor",
                source,
            ),
            state_path,
            dedup,
            enabled,
        }
    }

    pub fn enabled(&self) -> bool {
        self.enabled
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
        if !self.enabled {
            return;
        }
        let dkey = format!("{category}:{key}");
        if let Some(&last) = self.dedup.last_sent.get(&dkey) {
            if now_unix - last < REALERT_SECS {
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
