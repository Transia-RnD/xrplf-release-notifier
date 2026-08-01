# monitors

Cargo workspace for the XRPL observatory monitors. Each binary is a
self-sufficient CLI: it runs as a systemd daemon, applies its own alert rules
against on-disk dedup state, and posts to a Mattermost webhook (`--webhook`) or
prints in `--dry-run`. Shared alerting/state lives in [`common`](common/).

| crate | binary | role |
|-------|--------|------|
| `common` | (lib) | `Alert`/`Severity`, Mattermost payload + POST, JSON state |
| `vlwatch` | `vlwatch` | passive overlay peer; validator-list (UNL) propagation alerts |
| `crawler` | `xrpl-crawler` | `crawl` topology/eclipse scan + `monitor` validations-stream detection |
| `logmon` | `logmon` | xrpld trace-log → structured JSONL (runs on the stage node) |

## Provenance

`vlwatch` originated in this repo (`feat/vlwatch`). `crawler` and `logmon` were
vendored from the research playground and are now canonical here:

| crate | source repo | path | commit |
|-------|-------------|------|--------|
| crawler | Transia-RnD/xrpl-playground | `research/crawler` | `59b1a34` |
| logmon | Transia-RnD/xrpl-playground | `research/logmon` | `a8e3703` |

Do not sync back to the originals; changes land here.

## Build

```sh
cargo build --release            # all four crates
cargo test                       # rule unit tests
cargo clippy --all-targets
```

`vlwatch` and `crawler` statically link OpenSSL (`openssl` `vendored` feature)
so the binaries run on hosts without a matching `libssl`.
