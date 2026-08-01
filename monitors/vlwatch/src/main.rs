//! vlwatch — passive XRPL peer that watches validator-list (UNL) propagation.
//!
//! Usage: vlwatch [--peers h:p,h:p,...] [--json] [--for <seconds>] [--verbose]

mod alert;
mod b58;
mod inject;
mod manifest;
mod peer;
mod proto;
mod vl;

use alert::{PeriodicFired, VlObservation, VlState};
use monitor_common::{state as cstate, Notifier};
use peer::{Event, Identity};
use std::collections::HashMap;
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const DEFAULT_PEERS: &[&str] = &[
    "r.ripple.com:51235",
    "zaphod.alloy.ee:51235",
    "sahyadri.isrdc.in:51235",
    "hubs.xrpkuwait.com:51235",
];

/// Well-known publisher master keys → labels. These seed the alert allowlist;
/// `--publishers <file>` adds more (`HEXKEY=label` per line).
const KNOWN_PUBLISHERS: &[(&str, &str)] = &[
    ("ED2677ABFFD1B33AC6FBC3062B71F1E8397C1505E1C42C64D11AD1B28FF73F4734", "vl.ripple.com"),
    ("ED42AEC58B701EEBB77356FFFEC26F83C1F0407263530F068C7C73D392C7E06FD1", "unl.xrplf.org"),
    ("ED45D1840EE724BE327ABE9146503D5848EFD5F38B6D5FEDE71E80ACCE5E6E738B", "vl.xrplf.org"),
];

/// Well-known publisher master keys → labels.
fn publisher_label(hex: &str) -> Option<&'static str> {
    KNOWN_PUBLISHERS
        .iter()
        .find(|(k, _)| *k == hex)
        .map(|(_, label)| *label)
}

/// Build the publisher allowlist: built-in keys plus any from `--publishers`.
fn load_allowlist(path: Option<&str>) -> HashMap<String, String> {
    let mut m: HashMap<String, String> = KNOWN_PUBLISHERS
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    if let Some(p) = path {
        match std::fs::read_to_string(p) {
            Ok(text) => {
                for line in text.lines() {
                    let line = line.trim();
                    if line.is_empty() || line.starts_with('#') {
                        continue;
                    }
                    if let Some((k, v)) = line.split_once('=') {
                        m.insert(k.trim().to_uppercase(), v.trim().to_string());
                    }
                }
            }
            Err(e) => eprintln!("vlwatch: cannot read --publishers {p}: {e}"),
        }
    }
    m
}

/// Unix seconds → "YYYY-MM-DD HH:MM UTC" (Howard Hinnant's civil-date algorithm).
fn fmt_time(unix: i64) -> String {
    let days = unix.div_euclid(86_400);
    let secs = unix.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02} UTC", secs / 3600, (secs % 3600) / 60)
}

fn now_unix() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn fmt_expiry(unix: Option<i64>) -> String {
    match unix {
        None => "-".into(),
        Some(t) => {
            let dd = (t - now_unix()) / 86_400;
            format!("{} ({}d)", fmt_time(t), dd)
        }
    }
}

struct SeenList {
    rec: vl::VlRecord,
    first_from: String,
    peers: Vec<String>,
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut peers: Vec<String> = DEFAULT_PEERS.iter().map(|s| s.to_string()).collect();
    let mut json = false;
    let mut run_for: Option<u64> = None;
    let mut verbose = false;
    let mut inject_target: Option<String> = None;
    let mut inject_count: usize = 0;
    let mut webhook: Option<String> = None;
    let mut state_file: Option<String> = None;
    let mut publishers_file: Option<String> = None;
    let mut dry_run = false;

    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--peers" => {
                let v = it.next().expect("--peers needs a value");
                peers = v.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
            }
            "--json" => json = true,
            "--for" => run_for = Some(it.next().expect("--for needs seconds").parse().expect("bad --for")),
            "--verbose" => verbose = true,
            "--webhook" => webhook = Some(it.next().expect("--webhook needs a url").clone()),
            "--state-file" => state_file = Some(it.next().expect("--state-file needs a path").clone()),
            "--publishers" => publishers_file = Some(it.next().expect("--publishers needs a path").clone()),
            "--dry-run" => dry_run = true,
            "--inject" => inject_target = Some(it.next().expect("--inject needs host:port").clone()),
            "--count" => inject_count = it.next().expect("--count needs a number").parse().expect("bad --count"),
            "--help" | "-h" => {
                println!("vlwatch [--peers h:p,...] [--json] [--for <seconds>] [--verbose]");
                println!("        [--webhook <url>] [--state-file <path>] [--publishers <file>] [--dry-run]");
                println!("        [--inject <host:port> --count <n>]  LAB-ONLY: send n untrusted manifests");
                return;
            }
            other => {
                eprintln!("unknown argument: {other}");
                std::process::exit(2);
            }
        }
    }

    // LAB-ONLY injection mode (XRPLF/rippled#7572 fix verification). Guarded to
    // loopback/RFC1918 targets only; aborts on any public address.
    if let Some(target) = inject_target {
        if let Err(e) = inject::ensure_lab_target(&target) {
            eprintln!("{e}");
            std::process::exit(2);
        }
        let id = Arc::new(Identity::generate().expect("cannot generate node identity"));
        match peer::inject_flood(&target, &id, inject_count) {
            Ok(()) => return,
            Err(e) => {
                eprintln!("inject failed: {e}");
                std::process::exit(1);
            }
        }
    }

    let id = Arc::new(Identity::generate().expect("cannot generate node identity"));
    eprintln!("vlwatch: node identity {}", id.public_b58);

    // Alerting is active when a webhook or --dry-run is requested. The state
    // file gives cross-restart dedup and cold-start detection.
    let alerting = webhook.is_some() || dry_run;
    let allowlist = load_allowlist(publishers_file.as_deref());
    let notifier = Notifier::new(
        if dry_run { None } else { webhook.clone() },
        "xrpl network monitor",
        "vlwatch",
    );
    let mut vl_state: VlState = state_file
        .as_ref()
        .and_then(cstate::load_state)
        .unwrap_or_default();
    let cold_start = state_file
        .as_ref()
        .map(|p| !std::path::Path::new(p).exists())
        .unwrap_or(true);
    if alerting && cold_start {
        eprintln!("vlwatch: cold start — suppressing delta alerts, seeding state");
    }
    let mut periodic = PeriodicFired::default();
    let mut connected = false;
    let mut last_vl_unix: Option<i64> = None;
    let started_unix = now_unix();
    let mut last_periodic = Instant::now();

    let persist = |st: &VlState| {
        if let Some(p) = &state_file {
            if let Err(e) = cstate::save_state(p, st) {
                eprintln!("vlwatch: state save failed: {e}");
            }
        }
    };
    if alerting {
        persist(&vl_state); // seed state file on first run so restarts aren't cold
    }

    let (tx, rx) = mpsc::channel::<Event>();
    for p in &peers {
        let tx = tx.clone();
        let id = id.clone();
        let p = p.clone();
        std::thread::spawn(move || peer::run_peer(p, id, tx));
    }
    drop(tx);

    let started = Instant::now();
    let deadline = run_for.map(|s| started + Duration::from_secs(s));
    // Latest list seen per (publisher, sequence); latest sequence per publisher.
    let mut seen: HashMap<(String, u64), SeenList> = HashMap::new();

    loop {
        if let Some(d) = deadline {
            if Instant::now() >= d {
                break;
            }
        }
        // Periodic time-based rules (~every 30s) while alerting.
        if alerting && last_periodic.elapsed() >= Duration::from_secs(30) {
            last_periodic = Instant::now();
            let alerts = alert::evaluate_periodic(
                &vl_state,
                &allowlist,
                now_unix(),
                started_unix,
                last_vl_unix,
                connected,
                &mut periodic,
            );
            if let Err(e) = notifier.send(&alerts) {
                eprintln!("vlwatch: notify failed: {e}");
            }
        }
        let ev = match rx.recv_timeout(Duration::from_millis(500)) {
            Ok(ev) => ev,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };
        match ev {
            Event::Connected { peer, negotiated } => {
                connected = true;
                if json {
                    println!("{}", serde_json::json!({"event":"connected","peer":peer,"protocol":negotiated}));
                } else {
                    eprintln!("[{}] connected ({})", peer, negotiated);
                }
            }
            Event::Disconnected { peer, reason } => {
                if json {
                    println!("{}", serde_json::json!({"event":"disconnected","peer":peer,"reason":reason}));
                } else {
                    eprintln!("[{}] disconnected: {}", peer, reason);
                }
            }
            Event::Note { peer, msg } => {
                if verbose {
                    if json {
                        println!("{}", serde_json::json!({"event":"note","peer":peer,"note":msg}));
                    } else {
                        eprintln!("[{}] {}", peer, msg);
                    }
                }
            }
            Event::Vl { peer, rec } => {
                let key = (rec.publisher_hex.clone(), rec.sequence);
                if let Some(existing) = seen.get_mut(&key) {
                    if !existing.peers.contains(&peer) {
                        existing.peers.push(peer);
                    }
                    continue; // already reported this (publisher, sequence)
                }
                let label = publisher_label(&rec.publisher_hex)
                    .map(String::from)
                    .or_else(|| rec.domain.clone())
                    .unwrap_or_else(|| rec.publisher_b58.clone());
                if alerting {
                    last_vl_unix = Some(now_unix());
                    let obs = VlObservation {
                        publisher_key: &rec.publisher_hex,
                        label: &label,
                        sequence: rec.sequence,
                        expiration_unix: rec.expiration_unix,
                        sig_ok: rec.sig_ok,
                        chain_ok: rec.chain_ok,
                        validators: rec.validator_count,
                        from_peer: &peer,
                    };
                    let alerts =
                        alert::evaluate(&obs, &mut vl_state, &allowlist, cold_start, now_unix());
                    if let Err(e) = notifier.send(&alerts) {
                        eprintln!("vlwatch: notify failed: {e}");
                    }
                    persist(&vl_state);
                }
                if json {
                    println!(
                        "{}",
                        serde_json::json!({
                            "event": "validator_list",
                            "publisher": label,
                            "publisher_key": rec.publisher_hex,
                            "publisher_b58": rec.publisher_b58,
                            "domain": rec.domain,
                            "sequence": rec.sequence,
                            "manifest_seq": rec.manifest_seq,
                            "version": rec.version,
                            "validators": rec.validator_count,
                            "expiration_unix": rec.expiration_unix,
                            "effective_unix": rec.effective_unix,
                            "signature_ok": rec.sig_ok,
                            "manifest_chain_ok": rec.chain_ok,
                            "from_peer": peer,
                        })
                    );
                } else {
                    let verified = if rec.sig_ok && rec.chain_ok { "OK" } else { "FAIL" };
                    println!(
                        "LIST {label:<22} seq={} validators={} expires={} sig={verified} src={peer}",
                        rec.sequence,
                        rec.validator_count,
                        fmt_expiry(rec.expiration_unix),
                    );
                }
                seen.insert(key, SeenList { rec, first_from: peer, peers: vec![] });
            }
        }
    }

    if !json && !seen.is_empty() {
        // Summary: newest sequence per publisher.
        let mut latest: HashMap<String, &SeenList> = HashMap::new();
        for s in seen.values() {
            let e = latest.entry(s.rec.publisher_hex.clone()).or_insert(s);
            if s.rec.sequence > e.rec.sequence {
                *e = s;
            }
        }
        println!("\n=== publishers observed ({}) ===", latest.len());
        println!(
            "{:<22} {:<12} {:<6} {:<22} {:<5} first seen from",
            "publisher", "sequence", "count", "expires", "sig"
        );
        let mut rows: Vec<_> = latest.values().collect();
        rows.sort_by(|a, b| a.rec.publisher_hex.cmp(&b.rec.publisher_hex));
        for s in rows {
            let label = publisher_label(&s.rec.publisher_hex)
                .map(String::from)
                .or_else(|| s.rec.domain.clone())
                .unwrap_or_else(|| s.rec.publisher_b58.clone());
            println!(
                "{:<22} {:<12} {:<6} {:<22} {:<5} {}",
                label,
                s.rec.sequence,
                s.rec.validator_count,
                s.rec.expiration_unix.map(fmt_time).unwrap_or_else(|| "-".into()),
                if s.rec.sig_ok && s.rec.chain_ok { "OK" } else { "FAIL" },
                s.first_from,
            );
        }
    }
}
