//! Second-vantage cross-check for quorum verdicts.
//!
//! LOW_QUORUM is judged from Ripple's public s1/s2 validation streams — one
//! infrastructure vantage, which can lose relays under load (observed
//! 2026-08-02: 8 UNL validators' on-time validations for ledger 106013031
//! never appeared on s1/s2 but were stored by xrplwin's xPOP collector).
//! Before paging, compare the "missing" validators against that independent
//! store: if their validations exist there, the network had quorum and only
//! our feed lost them.

use anyhow::{anyhow, Context, Result};
use std::collections::HashSet;
use std::time::Duration;

/// Default vantage: xrplwin's Validation-Ledger-Tx-Store for network id 0
/// (mainnet). Per-ledger source data lives under sharded directories.
pub const DEFAULT_VANTAGE_URL: &str = "https://xpop.xrplwin.com/0";

/// Shard a ledger index into the store's directory layout: the decimal index,
/// left-padded with zeros to a multiple of 3 digits, split into 3-digit dirs
/// (106013031 → "106/013/031").
fn shard_path(seq: u64) -> String {
    let s = seq.to_string();
    let pad = (3 - s.len() % 3) % 3;
    let padded = format!("{}{}", "0".repeat(pad), s);
    padded
        .as_bytes()
        .chunks(3)
        .map(|c| std::str::from_utf8(c).expect("ascii digits"))
        .collect::<Vec<_>>()
        .join("/")
}

/// Signing keys from the store's per-ledger directory listing
/// (`validation_<signing-key>.json` entries in the nginx index HTML).
fn parse_listing(html: &str) -> Vec<String> {
    let mut keys: Vec<String> = html
        .split("href=\"validation_")
        .skip(1)
        .filter_map(|part| {
            let key = &part[..part.find(".json\"")?];
            (key.starts_with('n')
                && key.len() >= 40
                && key.chars().all(|c| c.is_ascii_alphanumeric()))
            .then(|| key.to_string())
        })
        .collect();
    keys.sort();
    keys.dedup();
    keys
}

/// Master keys of every validator with a stored validation for `seq` at the
/// vantage. Fetches the directory listing, then each validation file — they
/// are ~1 KB and this path only runs when an alert is about to fire.
pub async fn fetch_master_keys(base_url: &str, seq: u64) -> Result<HashSet<String>> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("xrpl-crawler/crosscheck")
        .build()?;
    let dir = format!("{}/{}/", base_url.trim_end_matches('/'), shard_path(seq));
    let listing = client
        .get(&dir)
        .send()
        .await
        .with_context(|| dir.clone())?
        .error_for_status()?
        .text()
        .await?;
    let signing_keys = parse_listing(&listing);
    if signing_keys.is_empty() {
        return Err(anyhow!("no validations stored at {dir}"));
    }
    let mut masters = HashSet::new();
    for sk in &signing_keys {
        let url = format!("{dir}validation_{sk}.json");
        let v: serde_json::Value = client
            .get(&url)
            .send()
            .await
            .with_context(|| url.clone())?
            .error_for_status()?
            .json()
            .await?;
        // Identity is the master key when one exists, else the signing key.
        if let Some(mk) = v
            .get("master_key")
            .and_then(|m| m.as_str())
            .or_else(|| v.get("validation_public_key").and_then(|m| m.as_str()))
        {
            masters.insert(mk.to_string());
        }
    }
    Ok(masters)
}

/// Default public JSON-RPC nodes used to confirm CHAIN_STALL, tried in order
/// (cluster first, Ripple's s1/s2 as fallbacks): if any can serve a validated
/// ledger past our feed's last seq, the network is advancing and the stall is
/// ours.
pub const DEFAULT_RPC_URLS: &str =
    "https://xrplcluster.com/,https://s1.ripple.com:51234/,https://s2.ripple.com:51234/";

/// Latest validated ledger seq at a public JSON-RPC node.
pub async fn fetch_validated_seq(rpc_url: &str) -> Result<u64> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("xrpl-crawler/crosscheck")
        .build()?;
    let body = serde_json::json!({
        "method": "ledger",
        "params": [{"ledger_index": "validated", "transactions": false, "expand": false}]
    });
    let v: serde_json::Value = client
        .post(rpc_url)
        .json(&body)
        .send()
        .await
        .with_context(|| rpc_url.to_string())?
        .error_for_status()?
        .json()
        .await?;
    // ledger_index arrives as a string on some servers, a number on others.
    v.pointer("/result/ledger/ledger_index")
        .and_then(|x| {
            x.as_u64()
                .or_else(|| x.as_str().and_then(|s| s.parse().ok()))
        })
        .ok_or_else(|| anyhow!("no validated ledger_index in response from {rpc_url}"))
}

/// What the second vantage says about a low-quorum verdict.
#[derive(Debug, PartialEq)]
pub enum Verdict {
    /// Enough of the "missing" validations exist at the vantage — the network
    /// had quorum; the relays were lost upstream of our own sources.
    VantageGap { recovered: usize, effective: usize },
    /// The vantage is missing them too — the low quorum is network-real.
    Confirmed { recovered: usize, effective: usize },
}

pub fn verdict(unl_count: usize, min_required: usize, recovered: usize) -> Verdict {
    let effective = unl_count + recovered;
    if effective >= min_required {
        Verdict::VantageGap {
            recovered,
            effective,
        }
    } else {
        Verdict::Confirmed {
            recovered,
            effective,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shards_nine_digit_ledger_index() {
        assert_eq!(shard_path(106013031), "106/013/031");
    }

    #[test]
    fn shards_pad_short_indexes() {
        assert_eq!(shard_path(4136520), "004/136/520");
        assert_eq!(shard_path(71), "071");
        assert_eq!(shard_path(1234), "001/234");
    }

    #[test]
    fn parses_nginx_listing() {
        let html = r#"<html><body><pre><a href="../">../</a>
<a href="ledger_info.json">ledger_info.json</a> 02-Aug-2026 04:22 598
<a href="validation_n94RkpbJYRYQrWUmL8PAVQ1XTVKtfyKkLm8C6SWzWPcKEbuNb6EV.json">validation_n94RkpbJYRYQrWUmL8PAVQ1XTVKtfyKkLm8C..&gt;</a> 02-Aug-2026 04:22 1099
<a href="validation_n9MZ7EVGKypqdyNguP31xSqhFqDBF4V5FESLMmLiGrBJ3khP2AzQ.json">validation_n9MZ7EVGKypqdyNguP31xSqhFqDBF4V5FESL..&gt;</a> 02-Aug-2026 04:22 1100
</pre></body></html>"#;
        let keys = parse_listing(html);
        assert_eq!(
            keys,
            vec![
                "n94RkpbJYRYQrWUmL8PAVQ1XTVKtfyKkLm8C6SWzWPcKEbuNb6EV",
                "n9MZ7EVGKypqdyNguP31xSqhFqDBF4V5FESLMmLiGrBJ3khP2AzQ",
            ]
        );
    }

    #[test]
    fn listing_ignores_truncated_display_text() {
        // The nginx index shows a truncated key as the link text; only the
        // href (full key) must be extracted.
        let html = r#"<a href="validation_n94RkpbJYRYQrWUmL8PAVQ1XTVKtfyKkLm8C6SWzWPcKEbuNb6EV.json">validation_n94RkpbJYRYQrWUmL8PAVQ1XTVKtfyKkLm8C..&gt;</a>"#;
        assert_eq!(parse_listing(html).len(), 1);
    }

    #[test]
    fn verdict_vantage_gap_when_recovered_reaches_quorum() {
        // Observed event: 25 seen, need 28, 8 of the missing exist at vantage.
        assert_eq!(
            verdict(25, 28, 8),
            Verdict::VantageGap {
                recovered: 8,
                effective: 33
            }
        );
    }

    #[test]
    fn verdict_confirmed_when_vantage_also_short() {
        assert_eq!(
            verdict(25, 28, 1),
            Verdict::Confirmed {
                recovered: 1,
                effective: 26
            }
        );
    }

    /// Live check against the real store for the 2026-08-02 event ledger.
    /// Manual-run only (`cargo test -- --ignored`): needs network and the
    /// store's retention to still cover the ledger.
    #[tokio::test]
    #[ignore]
    async fn live_event_ledger_recovers_lost_validations() {
        let masters = fetch_master_keys(DEFAULT_VANTAGE_URL, 106013031)
            .await
            .expect("store reachable");
        // Two of the validators whose validations s1/s2 lost that day.
        assert!(masters.contains("nHUdjQgg33FRu88GQDtzLWRw95xKnBurUZcqPpe3qC9XVeBNrHeJ")); // swarthout
        assert!(masters.contains("nHUryiyDqEtyWVtFG24AAhaYjMf9FRLietbGzviF3piJsMm9qyDR")); // bitrue
        assert!(masters.len() >= 28, "expected quorum-scale coverage, got {}", masters.len());
    }

    #[test]
    fn verdict_boundary_exactly_quorum_is_gap() {
        assert_eq!(
            verdict(25, 28, 3),
            Verdict::VantageGap {
                recovered: 3,
                effective: 28
            }
        );
    }
}
