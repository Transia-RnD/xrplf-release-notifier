//! Shared building blocks for the observatory monitors (vlwatch, crawler).
//!
//! Every monitor produces [`Alert`]s and either posts them to a Mattermost
//! webhook or, in `--dry-run`, prints them. Persistent per-monitor dedup state
//! is JSON on disk via [`load_state`] / [`save_state`]. The webhook payload
//! mirrors the `attachments` format used by the on-node `unl-monitor.sh`.

pub mod state;

use serde::Serialize;

/// Alert severity, ordered least → most urgent.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Severity {
    Info,
    Warning,
    Critical,
}

impl Severity {
    /// Mattermost attachment bar color (hex).
    pub fn color(self) -> &'static str {
        match self {
            Severity::Info => "#4CAF50",
            Severity::Warning => "#FF9800",
            Severity::Critical => "#E53935",
        }
    }

    /// Leading emoji for the alert title.
    pub fn emoji(self) -> &'static str {
        match self {
            Severity::Info => ":information_source:",
            Severity::Warning => ":warning:",
            Severity::Critical => ":rotating_light:",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Severity::Info => "INFO",
            Severity::Warning => "WARNING",
            Severity::Critical => "CRITICAL",
        }
    }
}

/// A single notification. `category` is the machine key (e.g. `SIG_FAIL`) used
/// for dedup; `title`/`text` are human-facing.
#[derive(Clone, Debug)]
pub struct Alert {
    pub severity: Severity,
    pub category: String,
    pub title: String,
    pub text: String,
    /// Optional `(label, value)` rows rendered as short attachment fields.
    pub fields: Vec<(String, String)>,
}

impl Alert {
    pub fn new(
        severity: Severity,
        category: impl Into<String>,
        title: impl Into<String>,
        text: impl Into<String>,
    ) -> Self {
        Alert {
            severity,
            category: category.into(),
            title: title.into(),
            text: text.into(),
            fields: Vec::new(),
        }
    }

    pub fn field(mut self, label: impl Into<String>, value: impl Into<String>) -> Self {
        self.fields.push((label.into(), value.into()));
        self
    }
}

/// Build the Mattermost webhook JSON for a batch of alerts.
pub fn mattermost_payload(username: &str, source: &str, alerts: &[Alert]) -> serde_json::Value {
    let attachments: Vec<serde_json::Value> = alerts
        .iter()
        .map(|a| {
            let fields: Vec<serde_json::Value> = a
                .fields
                .iter()
                .map(|(t, v)| serde_json::json!({"title": t, "value": v, "short": true}))
                .collect();
            serde_json::json!({
                "color": a.severity.color(),
                "title": format!("{} {} [{}]", a.severity.emoji(), a.title, a.severity.label()),
                "text": a.text,
                "fields": fields,
                "footer": source,
            })
        })
        .collect();
    serde_json::json!({ "username": username, "attachments": attachments })
}

/// A webhook sink, or a dry-run sink that prints instead of posting.
pub struct Notifier {
    webhook: Option<String>,
    username: String,
    source: String,
}

impl Notifier {
    /// `webhook == None` means dry-run: alerts are printed, never posted.
    pub fn new(webhook: Option<String>, username: impl Into<String>, source: impl Into<String>) -> Self {
        Notifier {
            webhook,
            username: username.into(),
            source: source.into(),
        }
    }

    pub fn is_dry_run(&self) -> bool {
        self.webhook.is_none()
    }

    /// Post (or print) the alerts. Returns Err only on transport failure.
    pub fn send(&self, alerts: &[Alert]) -> Result<(), String> {
        if alerts.is_empty() {
            return Ok(());
        }
        match &self.webhook {
            None => {
                for a in alerts {
                    println!(
                        "[DRY-RUN] {} {} — {}",
                        a.severity.label(),
                        a.category,
                        a.title
                    );
                    if !a.text.is_empty() {
                        println!("          {}", a.text);
                    }
                }
                Ok(())
            }
            Some(url) => {
                let payload = mattermost_payload(&self.username, &self.source, alerts);
                let body = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
                post_json(url, &body)
            }
        }
    }
}

/// Blocking POST of a JSON body. Used by the synchronous monitors.
pub fn post_json(url: &str, body: &str) -> Result<(), String> {
    match ureq::post(url)
        .set("Content-Type", "application/json")
        // The Mattermost host sits behind a WAF that 403s default client
        // user-agents (e.g. ureq/*); send a descriptive one.
        .set("User-Agent", "xrplf-release-notifier/monitors")
        .send_string(body)
    {
        Ok(_) => Ok(()),
        Err(ureq::Error::Status(code, _)) => Err(format!("webhook returned HTTP {code}")),
        Err(e) => Err(format!("webhook transport error: {e}")),
    }
}

/// Serialize a payload as compact JSON (helper for callers that post via their
/// own async HTTP client, e.g. the crawler's reqwest).
pub fn to_body<T: Serialize>(v: &T) -> Result<String, String> {
    serde_json::to_string(v).map_err(|e| e.to_string())
}
