# vlwatch — passive XRPL validator-list network monitor

## Purpose

Connect to a handful of well-connected mainnet nodes as a passive overlay peer and
observe every validator list (UNL) propagating on the network in real time: publisher
key, domain, blob sequence, expiration, validator count, and whether the signature
chain verifies. This answers "which UNLs are live on the network, at what sequence"
without trusting any HTTP endpoint — and catches a rogue or stale list the moment a
connected node starts relaying it.

Complements `config/unl-monitor.sh` (which polls the local node's RPC and the GCS
bucket); vlwatch watches the gossip layer itself.

## Protocol facts (verified against rippled source, xrpld checkout)

- **Handshake** (`src/xrpld/overlay/detail/Handshake.cpp`)
  - TLS with self-signed certs (no verification). Shared value =
    `sha512Half( SHA512(SSL_get_finished) XOR SHA512(SSL_get_peer_finished) )`.
  - `Session-Signature` = base64(DER secp256k1 signature over the 32-byte shared
    value) by the node identity key. Node keys MUST be secp256k1 (`Handshake.cpp:294`).
  - HTTP/1.1 upgrade request: `Upgrade: XRPL/2.1, XRPL/2.2`, `Connection: Upgrade`,
    `Connect-As: Peer`, `Public-Key: <base58 NodePublic (prefix 0x1C)>`,
    `Session-Signature`, optional `Network-Time` (ripple epoch seconds, 20s server
    tolerance), optional `Network-ID` (absent ⇒ not checked), `Crawl: private`.
  - Server replies `101` (negotiated version in `Upgrade`) or `503` with a JSON body
    `{"peer-ips": ["ip:port", ...]}` (redirect when full; `OverlayImpl.cpp:379`).
- **Framing** (`overlay/detail/ProtocolMessage.h`, `Compression.h`)
  - Uncompressed: 6-byte header — 4-byte BE payload size (top 6 bits zero) +
    2-byte BE message type. Compressed (top bit set, 10-byte header) only occurs if
    `compr=lz4` was negotiated via `X-Protocol-Ctl`; vlwatch never offers it.
  - Max message size 64 MB.
- **Messages** (`include/xrpl/proto/xrpl.proto`)
  - `mtPING=3` TMPing{1:type(0 ping/1 pong), 2:seq} — the node pings every 60s and
    drops us on one missed reply; PONG must echo the seq (`PeerImp.cpp:737,1123`).
  - `mtVALIDATOR_LIST=54` TMValidatorList{1:manifest, 2:blob, 3:signature, 4:version}.
  - `mtVALIDATOR_LIST_COLLECTION=56` TMValidatorListCollection{1:version, 2:manifest,
    3:repeated ValidatorBlobInfo{1:manifest?, 2:blob, 3:signature}}.
  - Everything else (validations, proposals, transactions, endpoints, squelch,
    manifests) is ignored — no reply required.
- **Propagation** (`PeerImp.cpp:874`, `ValidatorList.cpp:718,848,1337`)
  - Because vlwatch dials out, it is an *inbound* peer to the node, which pushes ALL
    its loaded lists (one message per publisher) right after the handshake, then
    relays every newly accepted list (passive peers stay eligible — no traffic
    required beyond pong replies).
  - **Caveat:** a node only accepts/relays lists whose publisher master key is in its
    own configured `[validator_list_keys]` (`ValidatorList::verify` returns
    `Untrusted` otherwise and never rebroadcasts). What vlwatch observes is therefore
    the union of publishers trusted by the nodes it connects to.

## Architecture

One OS thread per peer (blocking I/O, no async runtime), events over an mpsc channel
to the main thread, which dedupes on (publisher, sequence) and prints event lines
(human or `--json`). All VL payloads are independently verified: manifest signature
chain (master + ephemeral over the `MAN\0` region) and blob signature (ed25519 raw /
secp256k1 sha512-half+DER) — a list that fails verification is still reported,
flagged `sig=FAIL`.

Modules: `b58` (ripple base58check), `manifest` (STObject parse + verify, ported from
xrpld-publisher rust), `proto` (mini protobuf + framing), `peer` (identity, TLS,
handshake, frame loop), `vl` (VL decode/verify), `main` (CLI, aggregation, output).

## Usage

```
vlwatch [--peers host:port,host:port,...] [--json] [--for <seconds>] [--verbose]
```

Defaults to a built-in hub list. `--for` exits after N seconds and prints a summary
table (publisher × max sequence × expiry × count × verification × source peer).

## Implementation checklist

- [x] Research: handshake, framing, propagation rules from rippled source
- [x] Crate scaffold on branch `feat/vlwatch`
- [x] b58 / manifest modules (ported from xrpld-publisher rust, + secp256k1)
- [ ] proto: varint/fields decode, TMPing encode, frame codec
- [ ] peer: identity, TLS, shared value, session signature, upgrade, 503 redirect
- [ ] vl: blob/signature/manifest decode with base64/hex fallbacks, verification
- [ ] main: CLI, dedupe, human + JSON output, summary table
- [ ] Live test against public hubs; confirm known publishers observed
- [ ] Local commit on feat/vlwatch (no push)

## Future

- Prometheus /metrics or JSON state file for the unl-monitor.sh Mattermost pipeline
- Alert rules: unknown publisher key, sequence regression, expiry horizon, list
  divergence between peers
- Optional crawl mode: walk `peer-ips` redirects to sample more of the network
