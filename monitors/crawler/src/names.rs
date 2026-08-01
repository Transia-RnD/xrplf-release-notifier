//! Live validator key → name resolution from the XRPLF/unl source of truth, so
//! names stay current as the UNL changes (rather than a stale snapshot). Falls
//! back to the shipped `validator-names.json` when the fetch fails.

use std::collections::HashMap;
use std::time::Duration;

/// Raw `data/unl-raw.yaml` from XRPLF/unl — the authoritative key→name map.
pub const DEFAULT_NAMES_URL: &str =
    "https://raw.githubusercontent.com/XRPLF/unl/main/data/unl-raw.yaml";

/// Fetch and parse the live name map. Errors bubble up so callers can fall back.
pub async fn fetch(url: &str) -> anyhow::Result<HashMap<String, String>> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent("xrplf-release-notifier/monitors")
        .build()?;
    let text = client.get(url).send().await?.error_for_status()?.text().await?;
    let map = parse(&text);
    if map.is_empty() {
        anyhow::bail!("names source parsed to 0 entries");
    }
    Ok(map)
}

/// Parse the flat `nodes:` list of `- id: <key>` / `name: <name>` pairs. Hand-
/// parsed (no YAML dep) — the file is a stable, simple id/name list.
fn parse(yaml: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let mut cur_id: Option<String> = None;
    for line in yaml.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("- id:").or_else(|| t.strip_prefix("id:")) {
            cur_id = Some(rest.trim().trim_matches('"').to_string());
        } else if let Some(rest) = t.strip_prefix("name:") {
            if let Some(id) = cur_id.take() {
                let name = rest.trim().trim_matches('"').to_string();
                if !id.is_empty() && !name.is_empty() {
                    map.insert(id, name);
                }
            }
        }
    }
    map
}

/// Live map if the fetch succeeds, else the shipped fallback file, else empty.
pub async fn resolve(url: Option<&str>, fallback_file: Option<&str>) -> HashMap<String, String> {
    if let Some(u) = url {
        match fetch(u).await {
            Ok(m) => return m,
            Err(e) => eprintln!("names: live fetch failed ({e}); using fallback"),
        }
    }
    fallback_file
        .map(crate::detect::load_names)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_unl_raw_yaml() {
        let y = "nodes:\n  - id: nHAAA\n    name: alice.example\n  - id: nHBBB\n    name: bob.example\n";
        let m = parse(y);
        assert_eq!(m.get("nHAAA").map(String::as_str), Some("alice.example"));
        assert_eq!(m.get("nHBBB").map(String::as_str), Some("bob.example"));
        assert_eq!(m.len(), 2);
    }
}
