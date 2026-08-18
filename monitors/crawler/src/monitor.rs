use crate::crosscheck::{self, Verdict};
use crate::detect::{self, Alert, DetectionEngine};
use crate::names;
use crate::sources::SourceTracker;
use crate::types::CrawlState;
use crate::version::{self, Version};
use crate::webhook::AlertSink;
use anyhow::{anyhow, Result};
use base64 as base64_engine;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::collections::HashSet;
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

fn ts() -> String {
    chrono::Utc::now().format("%H:%M:%S").to_string()
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct WsValidation {
    #[serde(rename = "type")]
    msg_type: Option<String>,
    validation_public_key: Option<String>,
    master_key: Option<String>,
    ledger_hash: Option<String>,
    ledger_index: Option<String>,
    full: Option<bool>,
    signing_time: Option<u64>,
    flags: Option<u64>,
    cookie: Option<String>,
    server_version: Option<String>,
}

#[derive(Serialize)]
struct LogEntry<'a> {
    ts: &'a str,
    pk: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    master: Option<&'a str>,
    ledger: &'a str,
    hash: &'a str,
    full: bool,
    suspicious: bool,
    source: &'a str,
}

struct Validation {
    pk: String,
    master_key: Option<String>,
    ledger_hash: String,
    ledger_index: String,
    full: bool,
    source: String,
    server_version: Option<String>,
}

fn base64_pubkey_to_base58(b64: &str) -> Option<String> {
    use base64_engine::{engine::general_purpose::STANDARD, Engine};
    let raw = STANDARD.decode(b64).ok()?;
    if raw.len() != 33 {
        return None;
    }
    let mut payload = Vec::with_capacity(1 + 33 + 4);
    payload.push(28u8);
    payload.extend_from_slice(&raw);
    let checksum = {
        let h1 = Sha256::digest(&payload);
        let h2 = Sha256::digest(h1);
        h2[..4].to_vec()
    };
    payload.extend_from_slice(&checksum);
    Some(
        bs58::encode(&payload)
            .with_alphabet(bs58::Alphabet::RIPPLE)
            .into_string(),
    )
}

fn load_suspicious_pubkeys(state_file: &str) -> HashSet<String> {
    let mut pks = HashSet::new();
    let data = match std::fs::read_to_string(state_file) {
        Ok(d) => d,
        Err(_) => {
            eprintln!(
                "[{}] no crawl state at {} — running without suspicious set",
                ts(),
                state_file
            );
            return pks;
        }
    };
    let state: CrawlState = match serde_json::from_str(&data) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[{}] failed to parse {}: {}", ts(), state_file, e);
            return pks;
        }
    };
    for node in state.nodes.values() {
        if node.suspicious {
            pks.insert(node.pubkey.clone());
            if let Some(b58) = base64_pubkey_to_base58(&node.pubkey) {
                pks.insert(b58);
            }
        }
    }
    eprintln!(
        "[{}] loaded {} suspicious pubkeys (base64 + base58)",
        ts(),
        pks.len()
    );
    pks
}

async fn stream_validations(
    url: &str,
    tx: &mpsc::UnboundedSender<Validation>,
    running: &AtomicBool,
) -> Result<()> {
    let (ws, _) = tokio_tungstenite::connect_async(url).await?;
    let (mut write, mut read) = ws.split();

    let subscribe = serde_json::json!({"command": "subscribe", "streams": ["validations"]});
    write.send(Message::Text(subscribe.to_string())).await?;

    eprintln!("[{}] [{}] connected, subscribed to validations", ts(), url);

    while running.load(Ordering::Relaxed) {
        match read.next().await {
            Some(Ok(Message::Text(text))) => {
                if let Ok(v) = serde_json::from_str::<WsValidation>(&text) {
                    if v.msg_type.as_deref() != Some("validationReceived") {
                        continue;
                    }
                    let pk = match v.validation_public_key {
                        Some(pk) => pk,
                        None => continue,
                    };
                    let _ = tx.send(Validation {
                        pk,
                        master_key: v.master_key,
                        ledger_hash: v.ledger_hash.unwrap_or_default(),
                        ledger_index: v.ledger_index.unwrap_or_default(),
                        full: v.full.unwrap_or(false),
                        source: url.to_string(),
                        server_version: v.server_version,
                    });
                }
            }
            Some(Ok(_)) => {}
            Some(Err(e)) => return Err(anyhow!("ws error: {}", e)),
            None => return Err(anyhow!("connection closed")),
        }
    }
    Ok(())
}

/// Cross-check a LOW_QUORUM verdict against an independent validation store
/// before emitting. Our only vantage is Ripple's s1/s2 streams, which have
/// been observed to lose a cohort of relays for one ledger under tx-burst
/// load; the store tells us whether the "missing" validations exist anywhere.
/// Vantage has them → recategorize as RELAY_GAP (network quorum was fine, the
/// relays were lost upstream of our feed). Vantage is short too → escalate to
/// CRITICAL: two independent vantages agree the ledger lacked quorum.
async fn crosscheck_low_quorum(alert: &mut Alert, base_url: &str) {
    if alert.category != "LOW_QUORUM" {
        return;
    }
    let d = &alert.details;
    let Some(seq) = d.get("ledger_index").and_then(|v| v.as_u64()) else {
        return;
    };
    let unl_count = d.get("unl_count").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
    let unl_size = d.get("unl_size").and_then(|v| v.as_u64()).unwrap_or(0);
    let min_required = d.get("min_required").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
    let missing: Vec<String> = d
        .get("missing_validator_keys")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|k| k.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    // Give the store a moment to persist validations that are still in flight
    // for a just-finalized ledger, then read its view of that ledger.
    tokio::time::sleep(Duration::from_secs(3)).await;
    match crosscheck::fetch_master_keys(base_url, seq).await {
        Err(e) => {
            eprintln!(
                "[{}] crosscheck unavailable for ledger {}: {}",
                ts(),
                seq,
                e
            );
            // Unconfirmable ≠ confirmed: only a vantage-confirmed quorum loss
            // pages CRITICAL. A single-vantage verdict stays a WARNING.
            if alert.severity == "CRITICAL" {
                alert.severity = "WARNING";
                alert.message = format!(
                    "{} — unconfirmed (crosscheck vantage unreachable)",
                    alert.message
                );
            }
            if let Some(obj) = alert.details.as_object_mut() {
                obj.insert(
                    "crosscheck".into(),
                    serde_json::json!({ "vantage": base_url, "error": e.to_string() }),
                );
            }
        }
        Ok(vantage) => {
            let recovered: Vec<&String> = missing.iter().filter(|k| vantage.contains(*k)).collect();
            match crosscheck::verdict(unl_count, min_required, recovered.len()) {
                Verdict::VantageGap {
                    recovered: r,
                    effective,
                } => {
                    alert.category = "RELAY_GAP";
                    // The network had quorum — only our feed lost relays. That is
                    // a vantage problem, not a network emergency (ALERTS.md).
                    alert.severity = "WARNING";
                    alert.message = format!(
                        "Ledger {} has {}/{} UNL validations on our feed, but {} of the missing exist at the independent xPOP vantage ({}/{} network-wide) — validations lost upstream of our sources, network quorum OK",
                        seq, unl_count, unl_size, r, effective, unl_size
                    );
                }
                Verdict::Confirmed { effective, .. } => {
                    alert.severity = "CRITICAL";
                    alert.message = format!(
                        "{} — CONFIRMED at independent xPOP vantage: only {}/{} UNL validations network-wide",
                        alert.message, effective, unl_size
                    );
                }
            }
            if let Some(obj) = alert.details.as_object_mut() {
                obj.insert(
                    "crosscheck".into(),
                    serde_json::json!({
                        "vantage": base_url,
                        "vantage_stored": vantage.len(),
                        "recovered_validator_keys": recovered,
                    }),
                );
            }
        }
    }
}

/// Apply the public-RPC verdict to a CHAIN_STALL alert. Only a stall the RPC
/// vantage agrees with (it cannot serve a ledger past our feed's last seq)
/// stays CRITICAL; an advancing network means the stall is our feed's, and an
/// unreachable vantage means unconfirmed — both are WARNINGs.
fn apply_stall_verdict(alert: &mut Alert, ours: u64, vantage: &anyhow::Result<u64>) {
    match vantage {
        Ok(seq) if *seq > ours => {
            alert.category = "FEED_STALL";
            alert.severity = "WARNING";
            alert.message = format!(
                "Our validation feed stalled at seq {}, but public RPC reports validated ledger {} — the network is advancing; vantage problem, not a chain stall",
                ours, seq
            );
        }
        Ok(seq) => {
            alert.severity = "CRITICAL";
            alert.message = format!(
                "{} — CONFIRMED: public RPC also has no ledger past {} (validated: {})",
                alert.message, ours, seq
            );
        }
        Err(_) => {
            alert.severity = "WARNING";
            alert.message = format!(
                "{} — unconfirmed (public RPC vantage unreachable)",
                alert.message
            );
        }
    }
}

/// Cross-check a CHAIN_STALL verdict against public JSON-RPC nodes (tried in
/// order, cluster first) before emitting: our feed going quiet is not proof
/// the network stopped.
async fn crosscheck_chain_stall(alert: &mut Alert, rpc_urls: &[String]) {
    if alert.category != "CHAIN_STALL" {
        return;
    }
    let ours = alert
        .details
        .get("last_seq")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let mut vantage: anyhow::Result<u64> = Err(anyhow!("no RPC vantage configured"));
    let mut used: &str = "";
    for url in rpc_urls {
        vantage = crosscheck::fetch_validated_seq(url).await;
        used = url;
        match &vantage {
            Ok(_) => break,
            Err(e) => eprintln!("[{}] stall crosscheck {} failed: {}", ts(), url, e),
        }
    }
    apply_stall_verdict(alert, ours, &vantage);
    if let Some(obj) = alert.details.as_object_mut() {
        obj.insert(
            "crosscheck".into(),
            match &vantage {
                Ok(seq) => serde_json::json!({ "vantage": used, "validated_seq": seq }),
                Err(e) => serde_json::json!({ "vantage": used, "error": e.to_string() }),
            },
        );
    }
}

fn emit_alert(alert: &Alert, alert_file: &mut std::fs::File, sink: &mut AlertSink) {
    let prefix = match alert.severity {
        "CRITICAL" => "!!!!! CRITICAL",
        "WARNING" => "***   WARNING",
        _ => "      INFO",
    };
    eprintln!(
        "[{}] {} [{}] {}",
        ts(),
        prefix,
        alert.category,
        alert.message,
    );
    let _ = writeln!(
        alert_file,
        "{}",
        serde_json::to_string(alert).unwrap_or_default()
    );
    // Dedup key = severity + ledger (webhook layer prepends category). Sustained
    // conditions carry ledger_seq: None so their key is stable and they post at
    // most once per 24h; including severity lets a WARNING→CRITICAL escalation
    // (e.g. a growing MINI_FORK / worsening LOW_QUORUM) still break through.
    let key = format!(
        "{}:{}",
        alert.severity,
        alert.ledger_seq.map(|s| s.to_string()).unwrap_or_default()
    );
    sink.send(
        AlertSink::severity_of(alert.severity),
        alert.category,
        &key,
        alert.category,
        &alert.message,
        Vec::new(),
        chrono::Utc::now().timestamp(),
    );
}

#[allow(clippy::too_many_arguments)]
pub async fn run(
    endpoints: Vec<String>,
    state_file: &str,
    output: Option<&str>,
    unl_file: Option<&str>,
    min_validators: Option<usize>,
    alert_output: &str,
    min_seq: u64,
    webhook: Option<String>,
    webhook_state: Option<String>,
    dry_run: bool,
    min_version: Option<String>,
    names_file: Option<String>,
    names_url: Option<String>,
    crosscheck_url: String,
    rpc_check_url: String,
) -> Result<()> {
    let mut sink = AlertSink::new(webhook, dry_run, webhook_state, "xrpl-crawler/monitor");
    let crosscheck_url = crosscheck_url.trim().trim_end_matches('/').to_string();
    if crosscheck_url.is_empty() {
        eprintln!("[{}] LOW_QUORUM crosscheck disabled", ts());
    } else {
        eprintln!(
            "[{}] LOW_QUORUM crosscheck vantage: {}",
            ts(),
            crosscheck_url
        );
    }
    let rpc_check_urls: Vec<String> = rpc_check_url
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if rpc_check_urls.is_empty() {
        eprintln!("[{}] CHAIN_STALL crosscheck disabled", ts());
    } else {
        eprintln!(
            "[{}] CHAIN_STALL crosscheck vantages (in order): {}",
            ts(),
            rpc_check_urls.join(", ")
        );
    }
    let suspicious = load_suspicious_pubkeys(state_file);
    // Post-hotfix upgrade adoption: decode each validator's server_version and
    // alert when validators lag below --min-version.
    let min_ver = min_version.as_deref().and_then(version::parse_min);
    let mut validator_versions: HashMap<String, Version> = HashMap::new();
    let mut last_adoption = std::time::Instant::now();

    let unl_keys = match unl_file {
        Some(path) => detect::load_unl_file(path),
        None => HashSet::new(),
    };
    // Per-endpoint accounting: compares which UNL validators each source
    // delivered per ledger, catching a vantage that loses relays live.
    let mut source_tracker = SourceTracker::new(unl_keys.clone());
    let mut engine = DetectionEngine::new(unl_keys, min_validators);
    // Resolve validator names live from XRPLF/unl (fallback: shipped file), then
    // refresh hourly so names stay current as the UNL changes.
    let names = crate::names::resolve(names_url.as_deref(), names_file.as_deref()).await;
    eprintln!("[{}] loaded {} validator names", ts(), names.len());
    engine.set_names(names);

    let (tx, mut rx) = mpsc::unbounded_channel::<Validation>();
    let running = Arc::new(AtomicBool::new(true));
    let total = Arc::new(AtomicU64::new(0));
    let sus_count = Arc::new(AtomicU64::new(0));
    let alert_count = Arc::new(AtomicU64::new(0));

    for ep in endpoints {
        let tx = tx.clone();
        let running = running.clone();
        tokio::spawn(async move {
            // Exponential backoff (5s..60s) for endpoints that fail fast —
            // e.g. one whose DNS/TLS isn't provisioned yet — so a dead
            // endpoint doesn't spam the journal every 5s. A connection that
            // survived >60s resets the backoff.
            let mut fails: u32 = 0;
            loop {
                if !running.load(Ordering::Relaxed) {
                    return;
                }
                let started = std::time::Instant::now();
                if let Err(e) = stream_validations(&ep, &tx, &running).await {
                    if !running.load(Ordering::Relaxed) {
                        return;
                    }
                    if started.elapsed() > Duration::from_secs(60) {
                        fails = 0;
                    } else {
                        fails = (fails + 1).min(4);
                    }
                    let backoff = (5u64 << fails).min(60);
                    eprintln!("[{}] [{}] {}, reconnecting in {}s", ts(), ep, e, backoff);
                    tokio::time::sleep(Duration::from_secs(backoff)).await;
                }
            }
        });
    }
    drop(tx);

    let mut file = match output {
        Some(path) => Some(
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)?,
        ),
        None => None,
    };

    let mut alert_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(alert_output)?;

    let mut seen: HashSet<String> = HashSet::new();
    let mut seen_suspicious: HashSet<String> = HashSet::new();

    // Validations delivered per source since the last summary line. Makes a
    // feed collapse attributable at a glance (which endpoint went quiet vs
    // "did we get rate limited"), which alert counts alone can't show.
    let source_counts: Arc<std::sync::Mutex<HashMap<String, u64>>> =
        Arc::new(std::sync::Mutex::new(HashMap::new()));

    let summary_total = total.clone();
    let summary_sus = sus_count.clone();
    let summary_alerts = alert_count.clone();
    let summary_running = running.clone();
    let summary_sources = source_counts.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60));
        loop {
            interval.tick().await;
            if !summary_running.load(Ordering::Relaxed) {
                return;
            }
            let per_source = {
                let mut counts = summary_sources.lock().expect("source counts lock");
                let mut rates: Vec<String> = counts
                    .iter()
                    .map(|(src, n)| {
                        let short = src.trim_start_matches("wss://").trim_start_matches("ws://");
                        format!("{short}={n}/min")
                    })
                    .collect();
                counts.clear();
                rates.sort();
                rates.join(" ")
            };
            eprintln!(
                "[{}] -- total: {} | suspicious: {} | alerts: {} | {} --",
                ts(),
                summary_total.load(Ordering::Relaxed),
                summary_sus.load(Ordering::Relaxed),
                summary_alerts.load(Ordering::Relaxed),
                per_source,
            );
        }
    });

    match output {
        Some(p) => eprintln!("[{}] logging validations to: {}", ts(), p),
        None => eprintln!("[{}] raw validation dump off (--output unset)", ts()),
    }
    eprintln!("[{}] logging alerts to: {}", ts(), alert_output);

    // Refresh the validator name map hourly (skip the immediate first tick).
    let mut names_refresh = tokio::time::interval(Duration::from_secs(3600));
    names_refresh.tick().await;

    // Wall-clock heartbeat driving the time-based detectors (chain-stall, silence,
    // window finalization). Without this, a total outage — every WS endpoint
    // disconnected so `rx.recv()` never fires — would keep the loop parked and the
    // very alerts that outage should raise (CHAIN_STALL / VALIDATORS_SILENT) could
    // never fire. Skip the immediate first tick.
    let mut heartbeat = tokio::time::interval(Duration::from_secs(5));
    heartbeat.tick().await;

    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                for mut alert in engine.tick() {
                    alert_count.fetch_add(1, Ordering::Relaxed);
                    if !crosscheck_url.is_empty() {
                        crosscheck_low_quorum(&mut alert, &crosscheck_url).await;
                    }
                    if !rpc_check_urls.is_empty() {
                        crosscheck_chain_stall(&mut alert, &rpc_check_urls).await;
                    }
                    emit_alert(&alert, &mut alert_file, &mut sink);
                }
                for alert in &source_tracker.tick() {
                    alert_count.fetch_add(1, Ordering::Relaxed);
                    emit_alert(alert, &mut alert_file, &mut sink);
                }
            }
            _ = names_refresh.tick() => {
                if let Some(u) = names_url.as_deref() {
                    match names::fetch(u).await {
                        Ok(m) => {
                            eprintln!("[{}] refreshed {} validator names", ts(), m.len());
                            engine.set_names(m);
                        }
                        Err(e) => eprintln!("[{}] names refresh failed: {e}", ts()),
                    }
                }
            }
            val = rx.recv() => {
                let v = match val {
                    Some(v) => v,
                    None => break,
                };
                // Per-source accounting must see EVERY sighting — the
                // cross-endpoint dedup below keeps only the first source.
                *source_counts
                    .lock()
                    .expect("source counts lock")
                    .entry(v.source.clone())
                    .or_insert(0) += 1;
                let seq: u64 = v.ledger_index.parse().unwrap_or(0);
                if seq > min_seq {
                    source_tracker.record(&v.source, v.master_key.as_deref(), seq);
                }

                let dedup_key = format!("{}:{}", v.pk, v.ledger_index);
                if !seen.insert(dedup_key) {
                    continue;
                }
                if seen.len() > 50_000 {
                    seen.clear();
                }

                let is_sus = suspicious.contains(&v.pk)
                    || v.master_key.as_ref().is_some_and(|mk| suspicious.contains(mk));

                total.fetch_add(1, Ordering::Relaxed);
                if is_sus {
                    sus_count.fetch_add(1, Ordering::Relaxed);
                    seen_suspicious.insert(v.pk.clone());
                    eprintln!(
                        "[{}] *** SUSPICIOUS *** pk={}... ledger={} full={} src={}",
                        ts(),
                        &v.pk[..16.min(v.pk.len())],
                        v.ledger_index,
                        v.full,
                        v.source,
                    );
                }

                let now = chrono::Utc::now().to_rfc3339();
                let entry = LogEntry {
                    ts: &now,
                    pk: &v.pk,
                    master: v.master_key.as_deref(),
                    ledger: &v.ledger_index,
                    hash: &v.ledger_hash,
                    full: v.full,
                    suspicious: is_sus,
                    source: &v.source,
                };
                if let Some(f) = file.as_mut() {
                    let _ = writeln!(f, "{}", serde_json::to_string(&entry).unwrap_or_default());
                }

                // Track this validator's decoded software version (key by master
                // key when present, else the ephemeral validation key).
                if min_ver.is_some() {
                    if let Some(dec) = v
                        .server_version
                        .as_deref()
                        .and_then(|s| s.parse::<u64>().ok())
                        .and_then(version::decode)
                    {
                        let key = v.master_key.clone().unwrap_or_else(|| v.pk.clone());
                        validator_versions.insert(key, dec);
                    }
                    // Evaluate adoption at most every 5 minutes.
                    if last_adoption.elapsed() >= Duration::from_secs(300) {
                        last_adoption = std::time::Instant::now();
                        if let Some(min) = min_ver {
                            if let Some(alert) = version::evaluate_adoption(&validator_versions, min) {
                                sink.send(
                                    alert.severity,
                                    &alert.category,
                                    "adoption",
                                    &alert.title,
                                    &alert.text,
                                    alert.fields.clone(),
                                    chrono::Utc::now().timestamp(),
                                );
                            }
                        }
                    }
                }

                // Feed into detection engine. Partial validations (full=false)
                // don't count toward quorum in rippled either — a syncing or
                // amendment-blocked validator must not open/poison a window.
                if seq > min_seq && v.full {
                    let alerts = engine.process_validation(
                        v.master_key.as_deref(),
                        &v.ledger_hash,
                        seq,
                    );
                    for mut alert in alerts {
                        alert_count.fetch_add(1, Ordering::Relaxed);
                        if !crosscheck_url.is_empty() {
                            crosscheck_low_quorum(&mut alert, &crosscheck_url).await;
                        }
                        if !rpc_check_urls.is_empty() {
                            crosscheck_chain_stall(&mut alert, &rpc_check_urls).await;
                        }
                        emit_alert(&alert, &mut alert_file, &mut sink);
                    }
                }
            }
            _ = tokio::signal::ctrl_c() => {
                running.store(false, Ordering::Relaxed);
                eprintln!("\n[{}] shutting down", ts());
                eprintln!(
                    "  total: {} | suspicious: {} | unique suspicious pks: {} | alerts: {}",
                    total.load(Ordering::Relaxed),
                    sus_count.load(Ordering::Relaxed),
                    seen_suspicious.len(),
                    alert_count.load(Ordering::Relaxed),
                );
                eprintln!("  detection: {}", engine.status_summary());
                break;
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::anyhow;

    fn stall_alert() -> Alert {
        Alert {
            ts: String::new(),
            severity: "CRITICAL",
            category: "CHAIN_STALL",
            message: "No new validated ledger for 20s (last seq: 100)".into(),
            ledger_seq: None,
            details: serde_json::json!({ "last_seq": 100 }),
        }
    }

    #[test]
    fn stall_downgrades_when_network_advances() {
        let mut a = stall_alert();
        apply_stall_verdict(&mut a, 100, &Ok(105));
        assert_eq!(a.category, "FEED_STALL");
        assert_eq!(a.severity, "WARNING");
    }

    #[test]
    fn stall_confirmed_when_vantage_stuck_too() {
        let mut a = stall_alert();
        apply_stall_verdict(&mut a, 100, &Ok(100));
        assert_eq!(a.category, "CHAIN_STALL");
        assert_eq!(a.severity, "CRITICAL");
        assert!(a.message.contains("CONFIRMED"));
    }

    #[test]
    fn stall_unconfirmed_when_vantage_unreachable() {
        let mut a = stall_alert();
        apply_stall_verdict(&mut a, 100, &Err(anyhow!("timeout")));
        assert_eq!(a.category, "CHAIN_STALL");
        assert_eq!(a.severity, "WARNING");
        assert!(a.message.contains("unconfirmed"));
    }
}
