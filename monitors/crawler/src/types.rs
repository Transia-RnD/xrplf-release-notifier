use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Deserialize)]
pub struct CrawlResponse {
    pub overlay: Option<Overlay>,
}

#[derive(Debug, Deserialize)]
pub struct Overlay {
    pub active: Vec<CrawlPeer>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct CrawlPeer {
    pub public_key: String,
    #[serde(rename = "type")]
    pub peer_type: Option<String>,
    pub ip: Option<String>,
    #[serde(default, deserialize_with = "flexible_port")]
    pub port: Option<u16>,
    pub version: Option<String>,
    pub complete_ledgers: Option<String>,
}

fn flexible_port<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<u16>, D::Error> {
    let v = serde_json::Value::deserialize(d)?;
    Ok(match v {
        serde_json::Value::Number(n) => n.as_u64().map(|n| n as u16),
        serde_json::Value::String(s) => s.parse().ok(),
        _ => None,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct DirectedEdge {
    pub source: String,
    pub peer: String,
    pub peer_type: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct NodeInfo {
    pub pubkey: String,
    pub ips: HashSet<String>,
    pub version: Option<String>,
    pub complete_ledgers: Option<String>,
    pub suspicious: bool,
    pub crawlable: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct CrawlState {
    pub visited: HashSet<String>,
    pub queue: Vec<String>,
    pub nodes: HashMap<String, NodeInfo>,
    pub edges: HashSet<DirectedEdge>,
    pub ep_to_pubkey: HashMap<String, String>,
    pub started_at: String,
}
