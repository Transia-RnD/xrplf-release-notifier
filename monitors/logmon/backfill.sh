#!/usr/bin/env bash
# backfill.sh — parse rotated archives (archive/*.log.gz) into the JSONL store so
# DuckDB can query historical logs alongside live data. Idempotent-ish: re-running
# appends, so clear $LOGMON_JSONL first if you want a clean rebuild.
set -euo pipefail

cd "$(dirname "$0")"
# shellcheck source=logmon.env
source ./logmon.env

BIN="./target/release/logmon"
[ -x "$BIN" ] || { echo "backfill: build first -> cargo build --release"; exit 1; }
mkdir -p "$LOGMON_JSONL"

shopt -s nullglob
files=("$LOGMON_ARCHIVE"/debug-*.log.gz "$LOGMON_ARCHIVE"/debug-*.log)
[ ${#files[@]} -gt 0 ] || { echo "backfill: no archives in $LOGMON_ARCHIVE"; exit 0; }

echo "backfill: parsing ${#files[@]} archive(s) -> $LOGMON_JSONL"
exec "$BIN" --out "$LOGMON_JSONL" --host "$LOGMON_HOST" "${files[@]}"
