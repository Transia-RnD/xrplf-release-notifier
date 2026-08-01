use base64 as base64_engine;
use crate::detect::{self, DetectionEngine, Alert};
use crate::types::CrawlState;
use crate::version::{self, Version};
use crate::webhook::AlertSink;
use std::collections::HashMap;
use anyhow::{anyhow, Result};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
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
    Some(bs58::encode(&payload).with_alphabet(bs58::Alphabet::RIPPLE).into_string())
}

fn load_suspicious_pubkeys(state_file: &str) -> HashSet<String> {
    let mut pks = HashSet::new();
    let data = match std::fs::read_to_string(state_file) {
        Ok(d) => d,
        Err(_) => {
            eprintln!("[{}] no crawl state at {} — running without suspicious set", ts(), state_file);
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
    eprintln!("[{}] loaded {} suspicious pubkeys (base64 + base58)", ts(), pks.len());
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
    write
        .send(Message::Text(subscribe.to_string()))
        .await?;

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
    // Dedup key = category + ledger, so a persistent fork/stall posts at most
    // once per 24h rather than on every affected ledger.
    let key = alert.ledger_seq.map(|s| s.to_string()).unwrap_or_default();
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
    output: &str,
    unl_file: Option<&str>,
    min_validators: Option<usize>,
    alert_output: &str,
    min_seq: u64,
    webhook: Option<String>,
    webhook_state: Option<String>,
    dry_run: bool,
    min_version: Option<String>,
) -> Result<()> {
    let mut sink = AlertSink::new(webhook, dry_run, webhook_state, "xrpl-crawler/monitor");
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
    let mut engine = DetectionEngine::new(unl_keys, min_validators);

    let (tx, mut rx) = mpsc::unbounded_channel::<Validation>();
    let running = Arc::new(AtomicBool::new(true));
    let total = Arc::new(AtomicU64::new(0));
    let sus_count = Arc::new(AtomicU64::new(0));
    let alert_count = Arc::new(AtomicU64::new(0));

    for ep in endpoints {
        let tx = tx.clone();
        let running = running.clone();
        tokio::spawn(async move {
            loop {
                if !running.load(Ordering::Relaxed) {
                    return;
                }
                if let Err(e) = stream_validations(&ep, &tx, &running).await {
                    if !running.load(Ordering::Relaxed) {
                        return;
                    }
                    eprintln!("[{}] [{}] {}, reconnecting in 5s", ts(), ep, e);
                    tokio::time::sleep(Duration::from_secs(5)).await;
                }
            }
        });
    }
    drop(tx);

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(output)?;

    let mut alert_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(alert_output)?;

    let mut seen: HashSet<String> = HashSet::new();
    let mut seen_suspicious: HashSet<String> = HashSet::new();

    let summary_total = total.clone();
    let summary_sus = sus_count.clone();
    let summary_alerts = alert_count.clone();
    let summary_running = running.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60));
        loop {
            interval.tick().await;
            if !summary_running.load(Ordering::Relaxed) {
                return;
            }
            eprintln!(
                "[{}] -- total: {} | suspicious: {} | alerts: {} --",
                ts(),
                summary_total.load(Ordering::Relaxed),
                summary_sus.load(Ordering::Relaxed),
                summary_alerts.load(Ordering::Relaxed),
            );
        }
    });

    eprintln!("[{}] logging validations to: {}", ts(), output);
    eprintln!("[{}] logging alerts to: {}", ts(), alert_output);

    loop {
        tokio::select! {
            val = rx.recv() => {
                let v = match val {
                    Some(v) => v,
                    None => break,
                };
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
                let _ = writeln!(file, "{}", serde_json::to_string(&entry).unwrap_or_default());

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

                // Feed into detection engine (skip other networks)
                let seq: u64 = v.ledger_index.parse().unwrap_or(0);
                if seq > min_seq {
                    let alerts = engine.process_validation(
                        v.master_key.as_deref(),
                        &v.ledger_hash,
                        seq,
                    );
                    for alert in &alerts {
                        alert_count.fetch_add(1, Ordering::Relaxed);
                        emit_alert(alert, &mut alert_file, &mut sink);
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
