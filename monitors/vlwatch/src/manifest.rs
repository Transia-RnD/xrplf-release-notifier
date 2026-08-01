//! XRPL manifest (STObject) parsing and signature verification.
//! Ported from xrpld-publisher rust (verify.rs), extended with secp256k1 support:
//! ed25519 keys sign the raw message; secp256k1 keys sign sha512-half of it (DER sig).

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use sha2::{Digest, Sha512};

pub struct Manifest {
    pub sequence: u32,
    pub public_key: Vec<u8>,      // master, 33 bytes
    pub signing_pub_key: Vec<u8>, // ephemeral, 33 bytes
    pub signature: Vec<u8>,       // ephemeral signature over MAN\0 region
    pub master_signature: Vec<u8>,
    pub domain: Option<String>,
    pub signed_region: Vec<u8>, // MAN\0 + Sequence + PublicKey + SigningPubKey [+ Domain]
}

/// Read a VL (variable-length) size prefix per the XRPL encoding. Returns (len, bytes_consumed).
fn read_vl_len(b: &[u8]) -> Result<(usize, usize), String> {
    let b0 = *b.first().ok_or("truncated VL length")? as usize;
    if b0 <= 192 {
        Ok((b0, 1))
    } else if b0 <= 240 {
        let b1 = *b.get(1).ok_or("truncated VL length")? as usize;
        Ok((193 + (b0 - 193) * 256 + b1, 2))
    } else if b0 <= 254 {
        let b1 = *b.get(1).ok_or("truncated VL length")? as usize;
        let b2 = *b.get(2).ok_or("truncated VL length")? as usize;
        Ok((12481 + (b0 - 241) * 65536 + b1 * 256 + b2, 3))
    } else {
        Err("invalid VL length prefix".into())
    }
}

pub fn parse_manifest(bytes: &[u8]) -> Result<Manifest, String> {
    let mut m = Manifest {
        sequence: 0,
        public_key: vec![],
        signing_pub_key: vec![],
        signature: vec![],
        master_signature: vec![],
        domain: None,
        signed_region: b"MAN\0".to_vec(),
    };
    let mut i = 0;
    while i < bytes.len() {
        let start = i;
        let b0 = bytes[i];
        let type_code = b0 >> 4;
        let mut field = (b0 & 0x0f) as u16;
        i += 1;
        if field == 0 {
            field = *bytes.get(i).ok_or("truncated field code")? as u16;
            i += 1;
        }
        match type_code {
            2 => {
                let end = i + 4;
                let raw = bytes.get(i..end).ok_or("truncated UInt32")?;
                if field == 4 {
                    m.sequence = u32::from_be_bytes(raw.try_into().unwrap());
                }
                i = end;
                m.signed_region.extend_from_slice(&bytes[start..end]);
            }
            7 => {
                let (len, adv) = read_vl_len(&bytes[i..])?;
                let dstart = i + adv;
                let dend = dstart + len;
                let data = bytes.get(dstart..dend).ok_or("truncated blob")?.to_vec();
                match field {
                    1 => {
                        m.public_key = data;
                        m.signed_region.extend_from_slice(&bytes[start..dend]);
                    }
                    3 => {
                        m.signing_pub_key = data;
                        m.signed_region.extend_from_slice(&bytes[start..dend]);
                    }
                    7 => {
                        m.domain = Some(String::from_utf8_lossy(&data).into_owned());
                        m.signed_region.extend_from_slice(&bytes[start..dend]);
                    }
                    6 => m.signature = data,
                    18 => m.master_signature = data,
                    _ => {}
                }
                i = dend;
            }
            _ => return Err(format!("unexpected manifest field type {type_code}")),
        }
    }
    if m.public_key.is_empty() || m.signing_pub_key.is_empty() {
        return Err("manifest missing PublicKey or SigningPubKey".into());
    }
    Ok(m)
}

fn sha512_half(msg: &[u8]) -> [u8; 32] {
    let d = Sha512::digest(msg);
    let mut out = [0u8; 32];
    out.copy_from_slice(&d[..32]);
    out
}

/// Verify with an XRPL 33-byte public key: 0xED => ed25519 over the raw message,
/// 0x02/0x03 => secp256k1 ECDSA (DER) over sha512-half of the message.
pub fn xrpl_verify(pubkey_33: &[u8], msg: &[u8], sig: &[u8]) -> bool {
    match pubkey_33.first() {
        Some(0xED) if pubkey_33.len() == 33 && sig.len() == 64 => {
            let vk: [u8; 32] = match pubkey_33[1..33].try_into() {
                Ok(b) => b,
                Err(_) => return false,
            };
            let sig: [u8; 64] = match sig.try_into() {
                Ok(b) => b,
                Err(_) => return false,
            };
            match VerifyingKey::from_bytes(&vk) {
                Ok(vk) => vk.verify(msg, &Signature::from_bytes(&sig)).is_ok(),
                Err(_) => false,
            }
        }
        Some(0x02) | Some(0x03) if pubkey_33.len() == 33 => {
            use secp256k1::{ecdsa, Message, PublicKey, Secp256k1};
            let secp = Secp256k1::verification_only();
            let (Ok(pk), Ok(sig)) = (
                PublicKey::from_slice(pubkey_33),
                ecdsa::Signature::from_der(sig),
            ) else {
                return false;
            };
            let msg = Message::from_digest(sha512_half(msg));
            secp.verify_ecdsa(&msg, &sig, &pk).is_ok()
        }
        _ => false,
    }
}

/// Full manifest chain check: both the ephemeral and master signatures cover the MAN\0 region.
pub fn verify_manifest_chain(m: &Manifest) -> bool {
    xrpl_verify(&m.signing_pub_key, &m.signed_region, &m.signature)
        && xrpl_verify(&m.public_key, &m.signed_region, &m.master_signature)
}
