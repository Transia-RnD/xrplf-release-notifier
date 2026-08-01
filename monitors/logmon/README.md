# logmon — xrpld trace-log ingestion & search

Runs alongside an xrpld node (a dedicated "log node", or any cluster node) to turn
its trace-level firehose into something searchable:

```
xrpld debug.log ──tail -F──▶ logmon (parse) ──▶ hourly JSONL ──▶ DuckDB (search)
       │
       └── rotate.sh (size-based) ──log_rotate RPC──▶ fresh debug.log + gzip archive
```

This is the **node-internal** complement to the [`crawler`](../crawler) (which watches
the network externally via the `validations` stream). Together they correlate what a
node *did internally* with what the network *saw*.

## Why this shape
- **Shell tails, Rust parses, DuckDB searches.** `tail -F` already handles rotation/reopen
  robustly, so the Rust binary stays a pure stdin/`.gz`/`.log` parser — small and hard to break.
- **Native `logrotate` RPC.** xrpld has no SIGHUP handler; it exposes a `logrotate` admin RPC
  (method name has no underscore — see `Handler.cpp`) that close-and-reopens the log file
  (`src/xrpld/rpc/handlers/admin/log/LogRotate.cpp`). `rotate.sh` uses it the same way
  `logrotate(8)` would: rename → reopen via RPC → gzip the renamed file.
- **JSONL, not a daemon.** DuckDB reads the JSONL glob (incl. `.gz`) directly — SQL search,
  aggregation, and time-window joins with zero running services. Drop-in replaceable by a
  real JSON log format if/when xrpld gains one (only the parser changes).

## Log format parsed
xrpld writes (`Logs::format`, `src/libxrpl/basics/Log.cpp`):
```
2026-Jun-10 14:30:45.123456 UTC LedgerMaster:TRC <message>
```
`%Y-%b-%d %T %Z` timestamp (UTC, microseconds), **optional** partition, severity ∈
`TRC DBG NFO WRN ERR FTL`. Continuation lines (no leading timestamp) are folded into the
previous record's `msg`. Each output record:
```json
{"ts":"2026-06-10T14:30:45.123456Z","partition":"LedgerMaster","severity":"TRC","sev_num":0,"msg":"…","host":"vnode1","source":"debug.log"}
```

## Setup
1. **Enable trace logging** on the node (validators in the lab clusters already have it):
   ```ini
   [debug_logfile]
   /opt/ripple/log/debug.log
   [rpc_startup]
   { "command": "log_level", "severity": "trace" }
   ```
2. **Configure** `logmon.env` — point `LOGMON_LOG` at the host side of the log mount,
   `LOGMON_ADMIN_RPC` at the node's `port_rpc_admin_local` (alphanet vnode1 → `:5105`),
   and set `LOGMON_HOST`, `LOGMON_MAX_BYTES`, `LOGMON_RETAIN_DAYS`.
3. **Build:** `cargo build --release`

## Run
```bash
./run.sh                  # follow live debug.log -> hourly JSONL under $LOGMON_JSONL
./run.sh --once           # parse the current debug.log once and exit
./rotate.sh               # one rotation check; cron this (e.g. */5 * * * *) or `watch -n300 ./rotate.sh`
./backfill.sh             # parse archive/*.log.gz into the JSONL store
```

## Search (DuckDB)
```bash
brew install duckdb       # if needed
./query/q.sh                                  # interactive, `logs` view preloaded
./query/q.sh -c "select severity, count(*) from logs group by 1 order by 2 desc"
./query/q.sh -f query/examples.sql            # see query/examples.sql for more
```

## End-to-end verification
`test-node/verify.sh` proves the whole pipeline against a **real** xrpld with no
cluster/SSH: it boots one standalone xrpld in Docker (reusing the alphanet linux
binary, so the log format is identical), drives ledgers, runs the rotate dance
(`mv` → `logrotate` RPC → gzip), ingests the real archive + live log, and runs a
DuckDB query. One command:
```bash
cargo build --release && brew install duckdb
./test-node/verify.sh
```

> **macOS caveat:** `verify.sh` logs to a container-internal path on purpose. Docker
> Desktop's virtiofs does **not** surface a file recreated after a host-side `mv` of an
> open file — a Docker-on-macOS artifact, not a logmon/xrpld bug. On the real Linux log
> node, `rotate.sh`'s host-side rename + `logrotate` RPC works exactly like `logrotate(8)`.

## Status
Built and verified end-to-end against a real standalone xrpld (3.2.0): parser
(nanosecond ts, optional partition, all severities, multi-line, gzip, hourly output,
stdin pipe), `logrotate`-RPC rotation (fresh log recreated + archive gzipped), and
DuckDB search over the resulting JSONL. Re-run anytime with `./test-node/verify.sh`.
