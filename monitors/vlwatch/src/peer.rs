//! Outbound overlay peer: TLS connect, XRPL handshake, frame loop.
//!
//! We dial out, so from the remote node's perspective we are an inbound peer — it
//! pushes all its loaded validator lists right after the handshake and relays new
//! ones as they arrive. Our only obligation is answering its pings.

use crate::proto;
use crate::vl::{decode_vl, VlRecord, RIPPLE_EPOCH};
use base64::Engine;
use openssl::ssl::{SslConnector, SslMethod, SslStream, SslVerifyMode};
use secp256k1::{Message, PublicKey, Secp256k1, SecretKey};
use sha2::{Digest, Sha512};
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::mpsc::Sender;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub struct Identity {
    secret: SecretKey,
    pub public_b58: String,
}

impl Identity {
    pub fn generate() -> Result<Identity, String> {
        let secp = Secp256k1::new();
        loop {
            let mut buf = [0u8; 32];
            openssl::rand::rand_bytes(&mut buf).map_err(|e| e.to_string())?;
            if let Ok(secret) = SecretKey::from_slice(&buf) {
                let public = PublicKey::from_secret_key(&secp, &secret);
                let public_b58 = crate::b58::encode_node_public(&public.serialize());
                return Ok(Identity { secret, public_b58 });
            }
        }
    }

    fn sign_shared_value(&self, digest: [u8; 32]) -> Vec<u8> {
        let secp = Secp256k1::new();
        let msg = Message::from_digest(digest);
        secp.sign_ecdsa(&msg, &self.secret).serialize_der().to_vec()
    }
}

pub enum Event {
    Connected { peer: String, negotiated: String },
    Disconnected { peer: String, reason: String },
    Vl { peer: String, rec: VlRecord },
    Note { peer: String, msg: String },
}

fn sha512_half(msg: &[u8]) -> [u8; 32] {
    let d = Sha512::digest(msg);
    let mut out = [0u8; 32];
    out.copy_from_slice(&d[..32]);
    out
}

/// sha512Half( SHA512(local finished) XOR SHA512(peer finished) ) — Handshake.cpp.
fn shared_value(ssl: &openssl::ssl::SslRef) -> Result<[u8; 32], String> {
    let mut buf = [0u8; 1024];
    let n = ssl.finished(&mut buf);
    if n < 12 {
        return Err("local finished message too short".into());
    }
    let local = Sha512::digest(&buf[..n.min(buf.len())]);
    let n = ssl.peer_finished(&mut buf);
    if n < 12 {
        return Err("peer finished message too short".into());
    }
    let remote = Sha512::digest(&buf[..n.min(buf.len())]);
    let mut xored = [0u8; 64];
    for i in 0..64 {
        xored[i] = local[i] ^ remote[i];
    }
    if xored.iter().all(|&b| b == 0) {
        return Err("identical finished messages".into());
    }
    Ok(sha512_half(&xored))
}

struct HttpResponse {
    status: u16,
    reason: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    leftover: Vec<u8>,
}

fn read_response(stream: &mut SslStream<TcpStream>) -> Result<HttpResponse, String> {
    let mut buf: Vec<u8> = Vec::with_capacity(4096);
    let header_end = loop {
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos;
        }
        if buf.len() > 64 * 1024 {
            return Err("oversized HTTP response headers".into());
        }
        let mut chunk = [0u8; 4096];
        let n = stream.read(&mut chunk).map_err(|e| format!("read: {e}"))?;
        if n == 0 {
            return Err("connection closed during HTTP response".into());
        }
        buf.extend_from_slice(&chunk[..n]);
    };

    let head = String::from_utf8_lossy(&buf[..header_end]).into_owned();
    let mut lines = head.split("\r\n");
    let status_line = lines.next().unwrap_or_default();
    let mut parts = status_line.splitn(3, ' ');
    let _http = parts.next();
    let status: u16 = parts.next().unwrap_or("0").parse().unwrap_or(0);
    let reason = parts.next().unwrap_or("").to_string();
    let headers: Vec<(String, String)> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_lowercase(), v.trim().to_string()))
        .collect();

    let mut rest = buf.split_off(header_end + 4);
    let content_length: usize = headers
        .iter()
        .find(|(k, _)| k == "content-length")
        .and_then(|(_, v)| v.parse().ok())
        .unwrap_or(0);
    while rest.len() < content_length {
        let mut chunk = [0u8; 4096];
        let n = stream.read(&mut chunk).map_err(|e| format!("read body: {e}"))?;
        if n == 0 {
            break;
        }
        rest.extend_from_slice(&chunk[..n]);
    }
    let leftover = rest.split_off(content_length.min(rest.len()));
    Ok(HttpResponse { status, reason, headers, body: rest, leftover })
}

enum Handshake {
    Upgraded { stream: SslStream<TcpStream>, leftover: Vec<u8>, negotiated: String },
    Redirect(Vec<String>),
}

fn connect_and_upgrade(host_port: &str, id: &Identity) -> Result<Handshake, String> {
    let addr = host_port
        .to_socket_addrs()
        .map_err(|e| format!("resolve: {e}"))?
        .next()
        .ok_or("no address resolved")?;
    let tcp = TcpStream::connect_timeout(&addr, Duration::from_secs(10)).map_err(|e| format!("connect: {e}"))?;
    tcp.set_nodelay(true).ok();
    tcp.set_read_timeout(Some(Duration::from_secs(180))).ok();
    tcp.set_write_timeout(Some(Duration::from_secs(30))).ok();

    let mut builder = SslConnector::builder(SslMethod::tls_client()).map_err(|e| e.to_string())?;
    builder.set_verify(SslVerifyMode::NONE);
    let connector = builder.build();
    let config = connector
        .configure()
        .map_err(|e| e.to_string())?
        .use_server_name_indication(false)
        .verify_hostname(false);
    let mut stream = config
        .connect("xrpl-peer", tcp)
        .map_err(|e| format!("tls: {e}"))?;

    let shared = shared_value(stream.ssl())?;
    let sig_b64 = base64::engine::general_purpose::STANDARD.encode(id.sign_shared_value(shared));
    let network_time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64 - RIPPLE_EPOCH)
        .unwrap_or(0);

    let request = format!(
        "GET / HTTP/1.1\r\n\
         User-Agent: vlwatch/0.1.0\r\n\
         Upgrade: XRPL/2.1, XRPL/2.2\r\n\
         Connection: Upgrade\r\n\
         Connect-As: Peer\r\n\
         Crawl: private\r\n\
         Network-Time: {network_time}\r\n\
         Public-Key: {}\r\n\
         Session-Signature: {sig_b64}\r\n\
         \r\n",
        id.public_b58
    );
    stream.write_all(request.as_bytes()).map_err(|e| format!("write: {e}"))?;

    let resp = read_response(&mut stream)?;
    match resp.status {
        101 => {
            let negotiated = resp
                .headers
                .iter()
                .find(|(k, _)| k == "upgrade")
                .map(|(_, v)| v.clone())
                .unwrap_or_default();
            Ok(Handshake::Upgraded { stream, leftover: resp.leftover, negotiated })
        }
        503 => {
            let ips = serde_json::from_slice::<serde_json::Value>(&resp.body)
                .ok()
                .and_then(|j| j.get("peer-ips").and_then(|v| v.as_array()).cloned())
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default();
            Ok(Handshake::Redirect(ips))
        }
        s => Err(format!("handshake rejected: {s} {}", resp.reason)),
    }
}

struct FrameReader {
    stream: SslStream<TcpStream>,
    buf: Vec<u8>,
}

impl FrameReader {
    fn fill(&mut self, need: usize) -> Result<(), String> {
        while self.buf.len() < need {
            let mut chunk = [0u8; 65536];
            let n = self.stream.read(&mut chunk).map_err(|e| format!("read: {e}"))?;
            if n == 0 {
                return Err("connection closed".into());
            }
            self.buf.extend_from_slice(&chunk[..n]);
        }
        Ok(())
    }

    fn read_frame(&mut self) -> Result<(u16, Vec<u8>), String> {
        self.fill(6)?;
        let b0 = self.buf[0];
        if b0 & 0x80 != 0 {
            return Err("compressed frame received but compression was not negotiated".into());
        }
        if b0 & 0xFC != 0 {
            return Err(format!("invalid frame header byte {b0:#04x}"));
        }
        let size = u32::from_be_bytes([self.buf[0], self.buf[1], self.buf[2], self.buf[3]]) as usize;
        if size > 64 * 1024 * 1024 {
            return Err(format!("frame exceeds 64MB ({size})"));
        }
        let msg_type = u16::from_be_bytes([self.buf[4], self.buf[5]]);
        self.fill(6 + size)?;
        let payload = self.buf[6..6 + size].to_vec();
        self.buf.drain(..6 + size);
        Ok((msg_type, payload))
    }
}

fn handle_vl_message(msg_type: u16, payload: &[u8]) -> Result<Vec<VlRecord>, String> {
    let fs = proto::fields(payload)?;
    match msg_type {
        proto::MT_VALIDATOR_LIST => {
            let manifest = proto::bytes_field(&fs, 1).ok_or("TMValidatorList missing manifest")?;
            let blob = proto::bytes_field(&fs, 2).ok_or("TMValidatorList missing blob")?;
            let sig = proto::bytes_field(&fs, 3).ok_or("TMValidatorList missing signature")?;
            let version = proto::varint_field(&fs, 4).unwrap_or(1) as u32;
            Ok(vec![decode_vl(manifest, blob, sig, version)?])
        }
        proto::MT_VALIDATOR_LIST_COLLECTION => {
            let version = proto::varint_field(&fs, 1).unwrap_or(2) as u32;
            let top_manifest = proto::bytes_field(&fs, 2).ok_or("collection missing manifest")?;
            let mut out = Vec::new();
            for f in fs.iter().filter(|f| f.num == 3) {
                let proto::Value::Bytes(info) = &f.val else { continue };
                let bfs = proto::fields(info)?;
                let manifest = proto::bytes_field(&bfs, 1).unwrap_or(top_manifest);
                let blob = proto::bytes_field(&bfs, 2).ok_or("blob info missing blob")?;
                let sig = proto::bytes_field(&bfs, 3).ok_or("blob info missing signature")?;
                out.push(decode_vl(manifest, blob, sig, version)?);
            }
            Ok(out)
        }
        _ => Ok(vec![]),
    }
}

/// Connect to one peer (following 503 redirects) and stream events until failure.
/// Returns the reason the session ended.
fn session(host_port: &str, id: &Identity, tx: &Sender<Event>) -> String {
    let mut candidates = vec![host_port.to_string()];
    let mut hops = 0;
    while let Some(target) = candidates.pop() {
        let hs = match connect_and_upgrade(&target, id) {
            Ok(h) => h,
            Err(e) => {
                let _ = tx.send(Event::Note { peer: target.clone(), msg: format!("connect failed: {e}") });
                continue;
            }
        };
        match hs {
            Handshake::Redirect(ips) => {
                let _ = tx.send(Event::Note {
                    peer: target.clone(),
                    msg: format!("full; redirected to {} peers", ips.len()),
                });
                hops += 1;
                if hops <= 3 {
                    // Try a few redirect targets, most recent first.
                    candidates.extend(ips.into_iter().take(5));
                }
            }
            Handshake::Upgraded { stream, leftover, negotiated } => {
                let _ = tx.send(Event::Connected { peer: target.clone(), negotiated });
                let mut reader = FrameReader { stream, buf: leftover };
                loop {
                    match reader.read_frame() {
                        Ok((proto::MT_PING, payload)) => {
                            let Ok(fs) = proto::fields(&payload) else { continue };
                            if proto::varint_field(&fs, 1) == Some(0) {
                                let pong = proto::encode_pong(proto::varint_field(&fs, 2));
                                let frame = proto::encode_frame(proto::MT_PING, &pong);
                                if let Err(e) = reader.stream.write_all(&frame) {
                                    return format!("pong write failed: {e}");
                                }
                            }
                        }
                        Ok((t @ (proto::MT_VALIDATOR_LIST | proto::MT_VALIDATOR_LIST_COLLECTION), payload)) => {
                            match handle_vl_message(t, &payload) {
                                Ok(recs) => {
                                    for rec in recs {
                                        let _ = tx.send(Event::Vl { peer: target.clone(), rec });
                                    }
                                }
                                Err(e) => {
                                    let _ = tx.send(Event::Note {
                                        peer: target.clone(),
                                        msg: format!("bad validator list message: {e}"),
                                    });
                                }
                            }
                        }
                        Ok(_) => {} // validations, proposals, endpoints, manifests, squelch… ignored
                        Err(e) => return e,
                    }
                }
            }
        }
    }
    "no reachable address".into()
}

pub fn run_peer(host_port: String, id: std::sync::Arc<Identity>, tx: Sender<Event>) {
    let mut backoff = 5;
    loop {
        let reason = session(&host_port, &id, &tx);
        let _ = tx.send(Event::Disconnected { peer: host_port.clone(), reason });
        std::thread::sleep(Duration::from_secs(backoff));
        backoff = (backoff * 2).min(60);
    }
}

/// LAB-ONLY: connect to a single lab node, complete the handshake, and send one
/// TMManifests message carrying `count` minted untrusted manifests. Callers MUST
/// gate the target through `inject::ensure_lab_target` first.
pub fn inject_flood(host_port: &str, id: &Identity, count: usize) -> Result<(), String> {
    match connect_and_upgrade(host_port, id)? {
        Handshake::Upgraded { mut stream, negotiated, .. } => {
            let payload = crate::inject::build_manifests_message(count);
            let frame = proto::encode_frame(proto::MT_MANIFESTS, &payload);
            stream.write_all(&frame).map_err(|e| format!("send: {e}"))?;
            stream.flush().ok();
            eprintln!(
                "injected {count} untrusted manifests ({} payload bytes, {} frame bytes) to {host_port} [{negotiated}]",
                payload.len(),
                frame.len()
            );
            // Keep the socket open briefly so the peer processes the message before FIN.
            std::thread::sleep(Duration::from_secs(2));
            Ok(())
        }
        Handshake::Redirect(_) => Err("target redirected (full); not a direct lab node".into()),
    }
}
