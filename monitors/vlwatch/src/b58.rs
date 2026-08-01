//! Ripple-alphabet base58check for node public keys (token type 0x1C).

use sha2::{Digest, Sha256};

const ALPHABET: &[u8; 58] = b"rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";

pub fn encode_node_public(key: &[u8]) -> String {
    encode_check(0x1C, key)
}

fn encode_check(token: u8, payload: &[u8]) -> String {
    let mut data = Vec::with_capacity(1 + payload.len() + 4);
    data.push(token);
    data.extend_from_slice(payload);
    let d1 = Sha256::digest(&data);
    let d2 = Sha256::digest(d1);
    data.extend_from_slice(&d2[..4]);

    let mut digits: Vec<u8> = vec![0];
    for &byte in &data {
        let mut carry = byte as u32;
        for d in digits.iter_mut() {
            carry += (*d as u32) << 8;
            *d = (carry % 58) as u8;
            carry /= 58;
        }
        while carry > 0 {
            digits.push((carry % 58) as u8);
            carry /= 58;
        }
    }
    let mut s = String::new();
    for &byte in &data {
        if byte == 0 {
            s.push(ALPHABET[0] as char);
        } else {
            break;
        }
    }
    for &d in digits.iter().rev() {
        s.push(ALPHABET[d as usize] as char);
    }
    // Leading-zero handling above appended one digit too many when data is all zeros;
    // trim the artificial initial zero digit if no carry ever produced more digits.
    if digits == [0] {
        s.pop();
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_known_master_key() {
        // squidrouter.com's master key, cross-checked against xrpscan.
        let key = hex::decode("ED7B1A5F8FDAA19A2CA33B5BB8FED39B442F4F2F45BB331C525B09F92D8486B824")
            .unwrap();
        assert_eq!(
            encode_node_public(&key),
            "nHUHeq3QdVyLTUENPHAAJ1d5M1SbvY49rajs31mJS8CEfrvTfjn3"
        );
    }
}
