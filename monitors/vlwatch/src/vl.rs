//! Decode + verify a validator list received off the wire.
//!
//! Wire fields are tolerant of encoding variants: the manifest may be raw STObject
//! bytes or base64 text, the blob is normally base64 text (signature covers the
//! decoded bytes), and the signature may be raw or hex text.

use crate::b58::encode_node_public;
use crate::manifest::{parse_manifest, verify_manifest_chain, xrpl_verify, Manifest};
use base64::Engine;

pub const RIPPLE_EPOCH: i64 = 946_684_800;

#[derive(Clone)]
pub struct VlRecord {
    pub publisher_hex: String,
    pub publisher_b58: String,
    pub domain: Option<String>,
    pub manifest_seq: u32,
    pub version: u32,
    pub sequence: u64,
    pub expiration_unix: Option<i64>,
    pub effective_unix: Option<i64>,
    pub validator_count: usize,
    pub sig_ok: bool,
    pub chain_ok: bool,
}

fn parse_manifest_flex(raw: &[u8]) -> Result<Manifest, String> {
    parse_manifest(raw).or_else(|first_err| {
        let txt = std::str::from_utf8(raw).map_err(|_| first_err.clone())?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(txt.trim())
            .map_err(|_| first_err)?;
        parse_manifest(&bytes)
    })
}

fn decode_blob_flex(raw: &[u8]) -> Result<(Vec<u8>, serde_json::Value), String> {
    if let Ok(txt) = std::str::from_utf8(raw) {
        let compact: String = txt.split_whitespace().collect();
        if let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(&compact) {
            if let Ok(json) = serde_json::from_slice::<serde_json::Value>(&decoded) {
                return Ok((decoded, json));
            }
        }
    }
    let json =
        serde_json::from_slice(raw).map_err(|e| format!("blob is neither base64 nor JSON: {e}"))?;
    Ok((raw.to_vec(), json))
}

fn sig_candidates(raw: &[u8]) -> Vec<Vec<u8>> {
    let mut out = vec![raw.to_vec()];
    if let Ok(txt) = std::str::from_utf8(raw) {
        let t = txt.trim();
        if !t.is_empty() && t.len() % 2 == 0 && t.bytes().all(|c| c.is_ascii_hexdigit()) {
            if let Ok(b) = hex::decode(t) {
                out.push(b);
            }
        }
    }
    out
}

pub fn decode_vl(
    manifest_raw: &[u8],
    blob_raw: &[u8],
    sig_raw: &[u8],
    version: u32,
) -> Result<VlRecord, String> {
    let m = parse_manifest_flex(manifest_raw)?;
    let chain_ok = verify_manifest_chain(&m);
    let (blob_bytes, json) = decode_blob_flex(blob_raw)?;
    let sig_ok = sig_candidates(sig_raw)
        .iter()
        .any(|s| xrpl_verify(&m.signing_pub_key, &blob_bytes, s));

    let ripple_to_unix = |v: &serde_json::Value| v.as_i64().map(|t| t.saturating_add(RIPPLE_EPOCH));
    Ok(VlRecord {
        publisher_hex: hex::encode_upper(&m.public_key),
        publisher_b58: encode_node_public(&m.public_key),
        domain: m.domain.clone(),
        manifest_seq: m.sequence,
        version,
        sequence: json.get("sequence").and_then(|v| v.as_u64()).unwrap_or(0),
        expiration_unix: json.get("expiration").and_then(ripple_to_unix),
        effective_unix: json.get("effective").and_then(ripple_to_unix),
        validator_count: json
            .get("validators")
            .and_then(|v| v.as_array())
            .map(|a| a.len())
            .unwrap_or(0),
        sig_ok,
        chain_ok,
    })
}
