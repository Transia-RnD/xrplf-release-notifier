//! Minimal protobuf (proto2 wire format) decoding for the few peer messages vlwatch
//! consumes, plus the 6-byte uncompressed peer-protocol frame codec.

pub const MT_MANIFESTS: u16 = 2;
pub const MT_PING: u16 = 3;
pub const MT_VALIDATOR_LIST: u16 = 54;
pub const MT_VALIDATOR_LIST_COLLECTION: u16 = 56;

pub enum Value<'a> {
    Varint(u64),
    Bytes(&'a [u8]),
}

pub struct Field<'a> {
    pub num: u32,
    pub val: Value<'a>,
}

fn read_varint(buf: &[u8], pos: &mut usize) -> Option<u64> {
    let mut out: u64 = 0;
    let mut shift = 0;
    loop {
        let b = *buf.get(*pos)?;
        *pos += 1;
        out |= ((b & 0x7f) as u64) << shift;
        if b & 0x80 == 0 {
            return Some(out);
        }
        shift += 7;
        if shift >= 64 {
            return None;
        }
    }
}

/// Decode all fields of a message. Unknown wire types are skipped where possible.
pub fn fields(buf: &[u8]) -> Result<Vec<Field<'_>>, String> {
    let mut out = Vec::new();
    let mut pos = 0;
    while pos < buf.len() {
        let key = read_varint(buf, &mut pos).ok_or("truncated field key")?;
        let num = (key >> 3) as u32;
        match key & 0x07 {
            0 => {
                let v = read_varint(buf, &mut pos).ok_or("truncated varint")?;
                out.push(Field { num, val: Value::Varint(v) });
            }
            2 => {
                let len = read_varint(buf, &mut pos).ok_or("truncated length")? as usize;
                let end = pos.checked_add(len).ok_or("length overflow")?;
                let data = buf.get(pos..end).ok_or("truncated bytes field")?;
                pos = end;
                out.push(Field { num, val: Value::Bytes(data) });
            }
            5 => pos += 4,
            1 => pos += 8,
            w => return Err(format!("unsupported wire type {w}")),
        }
    }
    Ok(out)
}

pub fn varint_field(fs: &[Field], num: u32) -> Option<u64> {
    fs.iter().find_map(|f| match (&f.val, f.num == num) {
        (Value::Varint(v), true) => Some(*v),
        _ => None,
    })
}

pub fn bytes_field<'a>(fs: &'a [Field], num: u32) -> Option<&'a [u8]> {
    fs.iter().find_map(|f| match (&f.val, f.num == num) {
        (Value::Bytes(b), true) => Some(*b),
        _ => None,
    })
}

fn push_varint(out: &mut Vec<u8>, mut v: u64) {
    loop {
        let b = (v & 0x7f) as u8;
        v >>= 7;
        if v == 0 {
            out.push(b);
            break;
        }
        out.push(b | 0x80);
    }
}

/// TMPing { type: ptPONG, seq } — the reply that keeps the connection alive.
pub fn encode_pong(seq: Option<u64>) -> Vec<u8> {
    let mut out = vec![0x08, 0x01]; // field 1 varint = 1 (ptPONG)
    if let Some(seq) = seq {
        out.push(0x10); // field 2 varint
        push_varint(&mut out, seq);
    }
    out
}

/// 6-byte uncompressed frame: 4-byte BE size (top 6 bits zero) + 2-byte BE type.
pub fn encode_frame(msg_type: u16, payload: &[u8]) -> Vec<u8> {
    let size = payload.len() as u32;
    let mut out = Vec::with_capacity(6 + payload.len());
    out.extend_from_slice(&size.to_be_bytes());
    out.extend_from_slice(&msg_type.to_be_bytes());
    out.extend_from_slice(payload);
    out
}
