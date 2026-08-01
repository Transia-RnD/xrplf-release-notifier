use crate::report;
use crate::types::{CrawlPeer, CrawlResponse, CrawlState, DirectedEdge, NodeInfo};
use crate::webhook::AlertSink;
use anyhow::{anyhow, Result};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

fn ts() -> String {
    chrono::Utc::now().format("%H:%M:%S").to_string()
}

fn parse_endpoint(ep: &str) -> (&str, u16) {
    match ep.rsplit_once(':') {
        Some((ip, port_str)) => (ip, port_str.parse().unwrap_or(51235)),
        None => (ep, 51235),
    }
}

fn save_state(path: &str, state: &CrawlState) -> Result<()> {
    let tmp = format!("{}.tmp", path);
    std::fs::write(&tmp, serde_json::to_string_pretty(state)?)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

fn load_state(path: &str) -> Result<CrawlState> {
    let data = std::fs::read_to_string(path)?;
    Ok(serde_json::from_str(&data)?)
}

async fn crawl_endpoint(client: &reqwest::Client, ip: &str, port: u16) -> Result<CrawlResponse> {
    let host = if ip.contains(':') {
        format!("[{}]", ip)
    } else {
        ip.to_string()
    };
    let url = format!("https://{}:{}/crawl", host, port);
    let resp = client
        .get(&url)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(resp)
}

fn merge(
    state: &mut CrawlState,
    peers: &[CrawlPeer],
    source_pk: Option<&str>,
    sus_version: &str,
    max_nodes: usize,
    cap_logged: &mut bool,
) {
    for peer in peers {
        let pk = &peer.public_key;
        let is_sus = !sus_version.is_empty() && peer.version.as_deref() == Some(sus_version);

        // Bound total work: a hostile cluster advertising fabricated unique IPs
        // could otherwise inflate the node/queue maps without limit (concurrency
        // caps parallelism, not total work). Past the ceiling, stop admitting new
        // nodes — known nodes still update.
        if !state.nodes.contains_key(pk) && state.nodes.len() >= max_nodes {
            if !*cap_logged {
                *cap_logged = true;
                eprintln!(
                    "[{}] crawl node ceiling reached ({}) — no longer enqueuing new nodes/endpoints",
                    ts(),
                    max_nodes
                );
            }
            continue;
        }

        let node = state.nodes.entry(pk.clone()).or_insert_with(|| NodeInfo {
            pubkey: pk.clone(),
            ..Default::default()
        });

        if let Some(v) = &peer.version {
            node.version = Some(v.clone());
        }
        if let Some(l) = &peer.complete_ledgers {
            node.complete_ledgers = Some(l.clone());
        }
        node.suspicious = node.suspicious || is_sus;

        if let (Some(ip), Some(port)) = (&peer.ip, peer.port) {
            let ep = format!("{}:{}", ip, port);
            node.ips.insert(ep.clone());
            state.ep_to_pubkey.insert(ep.clone(), pk.clone());
            if !state.visited.contains(&ep) && state.queue.len() < max_nodes {
                state.queue.push(ep);
            }
        }

        if let Some(src) = source_pk {
            if src != pk {
                state.edges.insert(DirectedEdge {
                    source: src.to_string(),
                    peer: pk.clone(),
                    peer_type: peer.peer_type.clone().unwrap_or_default(),
                });
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn run(
    seeds: Vec<String>,
    sus_version: &str,
    concurrency: usize,
    timeout_secs: u64,
    resume: bool,
    output: &str,
    report_json: Option<&str>,
    webhook: Option<String>,
    webhook_state: Option<String>,
    dry_run: bool,
    max_nodes: usize,
) -> Result<()> {
    let mut cap_logged = false;
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(timeout_secs))
        .build()?;

    let mut state = if resume {
        match load_state(output) {
            Ok(s) => {
                eprintln!(
                    "[{}] resumed: {} visited, {} queued, {} nodes",
                    ts(),
                    s.visited.len(),
                    s.queue.len(),
                    s.nodes.len()
                );
                s
            }
            Err(e) => return Err(anyhow!("failed to load state: {}", e)),
        }
    } else {
        let mut s = CrawlState {
            started_at: chrono::Utc::now().to_rfc3339(),
            ..Default::default()
        };
        for seed in &seeds {
            s.queue.push(seed.clone());
        }
        eprintln!("[{}] fresh crawl with {} seed(s)", ts(), seeds.len());
        s
    };

    let running = Arc::new(AtomicBool::new(true));
    {
        let r = running.clone();
        tokio::spawn(async move {
            tokio::signal::ctrl_c().await.ok();
            r.store(false, Ordering::Relaxed);
        });
    }

    let (tx, mut rx) = mpsc::channel::<(String, Result<CrawlResponse>)>(concurrency * 2);
    let mut in_flight = 0usize;
    let mut crawled = 0usize;
    let mut errors = 0usize;

    loop {
        while in_flight < concurrency && running.load(Ordering::Relaxed) {
            let ep = loop {
                match state.queue.pop() {
                    Some(ep) if !state.visited.contains(&ep) => break Some(ep),
                    Some(_) => continue,
                    None => break None,
                }
            };
            let ep = match ep {
                Some(ep) => ep,
                None => break,
            };
            state.visited.insert(ep.clone());
            in_flight += 1;

            let tx = tx.clone();
            let client = client.clone();
            tokio::spawn(async move {
                let (ip, port) = parse_endpoint(&ep);
                let result = crawl_endpoint(&client, ip, port).await;
                let _ = tx.send((ep, result)).await;
            });
        }

        if in_flight == 0 || !running.load(Ordering::Relaxed) {
            break;
        }

        if let Some((ep, result)) = rx.recv().await {
            in_flight -= 1;
            match result {
                Ok(response) => {
                    crawled += 1;
                    let source_pk = state.ep_to_pubkey.get(&ep).cloned();
                    if let Some(ref pk) = source_pk {
                        if let Some(node) = state.nodes.get_mut(pk) {
                            node.crawlable = true;
                        }
                    }
                    let peers = response
                        .overlay
                        .as_ref()
                        .map(|o| o.active.as_slice())
                        .unwrap_or(&[]);
                    merge(
                        &mut state,
                        peers,
                        source_pk.as_deref(),
                        sus_version,
                        max_nodes,
                        &mut cap_logged,
                    );
                }
                Err(e) => {
                    errors += 1;
                    eprintln!("\r[{}] error crawling {}: {}    ", ts(), ep, e);
                }
            }
            eprint!(
                "\r[{}] crawled: {} | errors: {} | nodes: {} | queue: {}    ",
                ts(),
                crawled,
                errors,
                state.nodes.len(),
                state.queue.len()
            );
            if crawled.is_multiple_of(20) {
                save_state(output, &state)?;
            }
        }
    }

    save_state(output, &state)?;
    eprintln!();
    print_report(&state, sus_version);
    eprintln!("\nstate saved to: {}", output);

    // Machine-readable report + snapshot alert rules.
    if let Some(path) = report_json {
        let prev: Option<report::Report> = monitor_common::state::load_state(path);
        let mut fresh = report::compute(&state);
        // Completeness signals for the TOPOLOGY_COLLAPSE guard (N12).
        fresh.seeds = seeds.len();
        fresh.endpoints_crawled = crawled;
        fresh.crawl_errors = errors;
        let alerts = report::evaluate(&fresh, prev.as_ref());
        if let Err(e) = monitor_common::state::save_state(path, &fresh) {
            eprintln!("crawler: report-json save failed: {e}");
        }
        let mut sink = AlertSink::new(webhook, dry_run, webhook_state, "xrpl-crawler/crawl");
        if sink.enabled() {
            let now = chrono::Utc::now().timestamp();
            for a in &alerts {
                sink.send(
                    a.severity,
                    a.category,
                    &a.key,
                    &a.title,
                    &a.text,
                    a.fields.clone(),
                    now,
                );
            }
            eprintln!("crawler: {} snapshot alert(s) evaluated", alerts.len());
        }
    }
    Ok(())
}

fn print_report(state: &CrawlState, sus_version: &str) {
    let nodes: Vec<&NodeInfo> = state.nodes.values().collect();
    let suspicious: Vec<&&NodeInfo> = nodes.iter().filter(|n| n.suspicious).collect();
    let legitimate: Vec<&&NodeInfo> = nodes
        .iter()
        .filter(|n| !n.suspicious && n.version.is_some())
        .collect();
    let sus_pks: HashSet<&str> = suspicious.iter().map(|n| n.pubkey.as_str()).collect();

    eprintln!("{}", "=".repeat(80));
    eprintln!("CRAWL COMPLETE");
    eprintln!("{}", "=".repeat(80));
    eprintln!();
    eprintln!("  nodes:      {}", nodes.len());
    eprintln!("  endpoints:  {}", state.visited.len());
    eprintln!("  suspicious: {}", suspicious.len());
    eprintln!("  legitimate: {}", legitimate.len());
    eprintln!("  edges:      {}", state.edges.len());

    let mut versions: HashMap<&str, usize> = HashMap::new();
    for n in &nodes {
        *versions
            .entry(n.version.as_deref().unwrap_or("unknown"))
            .or_default() += 1;
    }
    let mut version_list: Vec<_> = versions.into_iter().collect();
    version_list.sort_by(|a, b| b.1.cmp(&a.1));

    eprintln!("\n  versions:");
    for (v, count) in &version_list {
        let marker = if *v == sus_version {
            " *** SUSPICIOUS ***"
        } else {
            ""
        };
        eprintln!("    {:>4}  {}{}", count, v, marker);
    }

    if !suspicious.is_empty() {
        eprintln!("\n{}", "-".repeat(80));
        eprintln!("SUSPICIOUS NODES ({})", suspicious.len());
        eprintln!("{}", "-".repeat(80));
        for n in &suspicious {
            let ips: Vec<&str> = n.ips.iter().map(|s| s.as_str()).collect();
            let ips_str = if ips.is_empty() {
                "(no IP)".to_string()
            } else {
                ips.join(", ")
            };
            eprintln!(
                "  {}  {}  {}",
                &n.pubkey[..20.min(n.pubkey.len())],
                ips_str,
                n.complete_ledgers.as_deref().unwrap_or("-")
            );
        }
    }

    // leak points
    let mut leaks: Vec<(&NodeInfo, &NodeInfo)> = Vec::new();
    let mut seen_leaks: HashSet<(&str, &str)> = HashSet::new();
    for edge in &state.edges {
        let src_sus = sus_pks.contains(edge.source.as_str());
        let peer_sus = sus_pks.contains(edge.peer.as_str());
        if src_sus == peer_sus {
            continue;
        }
        let (leg_pk, sus_pk) = if src_sus {
            (edge.peer.as_str(), edge.source.as_str())
        } else {
            (edge.source.as_str(), edge.peer.as_str())
        };
        if !seen_leaks.insert((leg_pk, sus_pk)) {
            continue;
        }
        if let (Some(leg), Some(sus)) = (state.nodes.get(leg_pk), state.nodes.get(sus_pk)) {
            if leg.version.is_some() {
                leaks.push((leg, sus));
            }
        }
    }

    if !leaks.is_empty() {
        eprintln!("\n{}", "-".repeat(80));
        eprintln!(
            "LEAK POINTS ({} edges between legitimate <-> suspicious)",
            leaks.len()
        );
        eprintln!("{}", "-".repeat(80));
        for (leg, sus) in &leaks {
            let leg_ips: Vec<&str> = leg.ips.iter().map(|s| s.as_str()).collect();
            let sus_ips: Vec<&str> = sus.ips.iter().map(|s| s.as_str()).collect();
            eprintln!(
                "  legit:  {}  {}  {}",
                &leg.pubkey[..20.min(leg.pubkey.len())],
                leg.version.as_deref().unwrap_or("?"),
                if leg_ips.is_empty() {
                    "(no IP)".to_string()
                } else {
                    leg_ips.join(", ")
                }
            );
            eprintln!(
                "  suspc:  {}  {}",
                &sus.pubkey[..20.min(sus.pubkey.len())],
                if sus_ips.is_empty() {
                    "(no IP)".to_string()
                } else {
                    sus_ips.join(", ")
                }
            );
            eprintln!();
        }
    } else {
        eprintln!("\n  no leak points found (cluster may be isolated or need more seeds)");
    }

    // cluster density
    let sus_to_sus = state
        .edges
        .iter()
        .filter(|e| sus_pks.contains(e.source.as_str()) && sus_pks.contains(e.peer.as_str()))
        .count();
    let sus_total = state
        .edges
        .iter()
        .filter(|e| sus_pks.contains(e.source.as_str()) || sus_pks.contains(e.peer.as_str()))
        .count();
    if sus_total > 0 {
        let pct = (sus_to_sus as f64 / sus_total as f64) * 100.0;
        eprintln!(
            "  cluster density: {}/{} suspicious-only edges ({:.1}%)",
            sus_to_sus, sus_total, pct
        );
    }

    // eclipse analysis
    print_eclipse_report(state, &sus_pks);
}

struct EclipseTarget<'a> {
    node: &'a NodeInfo,
    inbound_total: usize,
    inbound_sus: usize,
    outbound_total: usize,
    outbound_sus: usize,
}

fn print_eclipse_report(state: &CrawlState, sus_pks: &HashSet<&str>) {
    // for each crawled node, tally inbound/outbound peers and how many are suspicious
    // peer_type "in" means the peer connected inbound TO the source (source accepted their connection)
    // peer_type "out" means the source connected outbound TO the peer
    let mut targets: Vec<EclipseTarget> = Vec::new();

    for node in state.nodes.values() {
        if !node.crawlable || node.suspicious {
            continue;
        }
        let pk = &node.pubkey;
        let node_edges: Vec<_> = state.edges.iter().filter(|e| e.source == *pk).collect();
        if node_edges.is_empty() {
            continue;
        }

        let mut inbound_total = 0usize;
        let mut inbound_sus = 0usize;
        let mut outbound_total = 0usize;
        let mut outbound_sus = 0usize;

        for edge in &node_edges {
            let peer_is_sus = sus_pks.contains(edge.peer.as_str());
            match edge.peer_type.as_str() {
                "in" => {
                    inbound_total += 1;
                    if peer_is_sus {
                        inbound_sus += 1;
                    }
                }
                "out" => {
                    outbound_total += 1;
                    if peer_is_sus {
                        outbound_sus += 1;
                    }
                }
                _ => {
                    // unknown direction, count as general connection
                    inbound_total += 1;
                    if peer_is_sus {
                        inbound_sus += 1;
                    }
                }
            }
        }

        if inbound_sus > 0 || outbound_sus > 0 {
            targets.push(EclipseTarget {
                node,
                inbound_total,
                inbound_sus,
                outbound_total,
                outbound_sus,
            });
        }
    }

    // sort by inbound suspicious ratio descending
    targets.sort_by(|a, b| {
        let a_pct = if a.inbound_total > 0 {
            a.inbound_sus as f64 / a.inbound_total as f64
        } else {
            0.0
        };
        let b_pct = if b.inbound_total > 0 {
            b.inbound_sus as f64 / b.inbound_total as f64
        } else {
            0.0
        };
        b_pct
            .partial_cmp(&a_pct)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    eprintln!("\n{}", "=".repeat(80));
    eprintln!("ECLIPSE ATTACK ANALYSIS");
    eprintln!("{}", "=".repeat(80));
    eprintln!("  (default peers_max=21 → ~11 inbound slots)");
    eprintln!("  nodes with suspicious inbound connections:\n");

    if targets.is_empty() {
        eprintln!("  no legitimate crawled nodes have suspicious peers");
        return;
    }

    let mut high_risk = 0usize;
    let mut medium_risk = 0usize;

    for t in &targets {
        let in_pct = if t.inbound_total > 0 {
            (t.inbound_sus as f64 / t.inbound_total as f64) * 100.0
        } else {
            0.0
        };
        let total_peers = t.inbound_total + t.outbound_total;
        let total_sus = t.inbound_sus + t.outbound_sus;

        let risk = if in_pct >= 50.0 {
            high_risk += 1;
            "*** HIGH RISK ***"
        } else if in_pct >= 25.0 || total_sus >= 3 {
            medium_risk += 1;
            "** MEDIUM **"
        } else {
            ""
        };

        let ips: Vec<&str> = t.node.ips.iter().map(|s| s.as_str()).collect();
        let ip_str = if ips.is_empty() {
            "(no IP)".to_string()
        } else {
            ips.join(", ")
        };

        eprintln!(
            "  {}  {}",
            &t.node.pubkey[..20.min(t.node.pubkey.len())],
            t.node.version.as_deref().unwrap_or("?"),
        );
        eprintln!(
            "    peers: {total} ({in_t} in, {out_t} out) | suspicious: {sus_t} ({in_s} in, {out_s} out) | inbound: {pct:.0}% sus  {risk}",
            total = total_peers,
            in_t = t.inbound_total,
            out_t = t.outbound_total,
            sus_t = total_sus,
            in_s = t.inbound_sus,
            out_s = t.outbound_sus,
            pct = in_pct,
            risk = risk,
        );
        eprintln!("    {}", ip_str);
        eprintln!();
    }

    eprintln!("{}", "-".repeat(80));
    eprintln!(
        "  SUMMARY: {} high-risk, {} medium-risk out of {} nodes with suspicious peers",
        high_risk,
        medium_risk,
        targets.len()
    );
    if high_risk > 0 {
        eprintln!("  HIGH RISK = >50% inbound slots filled by suspicious nodes (eclipse likely)");
    }
}

pub fn gen_config(state_file: &str, max_peers: usize) -> Result<()> {
    let state = load_state(state_file)?;
    let sus_pks: HashSet<&str> = state
        .nodes
        .values()
        .filter(|n| n.suspicious)
        .map(|n| n.pubkey.as_str())
        .collect();

    let mut edge_count: HashMap<&str, usize> = HashMap::new();
    for edge in &state.edges {
        *edge_count.entry(edge.source.as_str()).or_default() += 1;
        *edge_count.entry(edge.peer.as_str()).or_default() += 1;
    }

    let mut leak_nodes: Vec<&NodeInfo> = Vec::new();
    let mut seen: HashSet<&str> = HashSet::new();
    for edge in &state.edges {
        let src_sus = sus_pks.contains(edge.source.as_str());
        let peer_sus = sus_pks.contains(edge.peer.as_str());
        if src_sus == peer_sus {
            continue;
        }
        let leg_pk = if src_sus {
            edge.peer.as_str()
        } else {
            edge.source.as_str()
        };
        if !seen.insert(leg_pk) {
            continue;
        }
        if let Some(node) = state.nodes.get(leg_pk) {
            if !node.ips.is_empty() {
                leak_nodes.push(node);
            }
        }
    }

    // suspicious nodes with IPs, sorted by connectivity
    let mut sus_with_ips: Vec<&NodeInfo> = state
        .nodes
        .values()
        .filter(|n| n.suspicious && !n.ips.is_empty())
        .collect();
    sus_with_ips.sort_by(|a, b| {
        let ac = edge_count.get(a.pubkey.as_str()).unwrap_or(&0);
        let bc = edge_count.get(b.pubkey.as_str()).unwrap_or(&0);
        bc.cmp(ac)
    });

    let date = chrono::Utc::now().format("%Y-%m-%d");

    println!("{}", "=".repeat(80));
    println!("VARIANT A: PASSIVE — peer with legitimate nodes adjacent to attacker cluster");
    println!("{}", "=".repeat(80));
    println!("# Generated on {}", date);
    println!("# relay_validations=all required to see non-UNL validations\n");
    println!("[ips_fixed]");
    if leak_nodes.is_empty() {
        println!("# no leak point IPs found");
    } else {
        for node in leak_nodes.iter().take(max_peers) {
            for ep in &node.ips {
                let (ip, port) = parse_endpoint(ep);
                println!("{} {}", ip, port);
            }
        }
    }
    println!("\n[relay_validations]\nall");
    println!("\n[crawl]\noverlay = 1\nserver = 1\nunl = 1");

    println!("\n{}", "=".repeat(80));
    println!("VARIANT B: DIRECT — peer with suspicious nodes");
    println!("{}", "=".repeat(80));
    println!("# Generated on {}", date);
    println!("# WARNING: connects directly to attacker nodes\n");
    println!("[ips_fixed]");
    if sus_with_ips.is_empty() {
        println!("# no suspicious node IPs found (peer_private=1?)");
    } else {
        for node in sus_with_ips.iter().take(max_peers) {
            for ep in &node.ips {
                let (ip, port) = parse_endpoint(ep);
                println!(
                    "{}  {}  # {}...",
                    ip,
                    port,
                    &node.pubkey[..16.min(node.pubkey.len())]
                );
            }
        }
    }
    println!("\n[peer_private]\n1");
    println!("\n[relay_validations]\nall");
    println!("\n[crawl]\noverlay = 1\nserver = 1\nunl = 1");

    eprintln!(
        "\nsuspicious nodes: {} ({} with IPs)",
        sus_pks.len(),
        sus_with_ips.len()
    );
    eprintln!("leak point nodes: {} (with IPs)", leak_nodes.len());
    Ok(())
}
