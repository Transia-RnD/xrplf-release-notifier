#!/usr/bin/env bash
# q.sh — DuckDB search over parsed JSONL. Sets up a `logs` view, then either runs
# a one-off query (-c "SQL") or opens an interactive DuckDB shell.
#
#   ./query/q.sh                         # interactive, `logs` view ready
#   ./query/q.sh -c "select severity, count(*) from logs group by 1"
#   ./query/q.sh -f query/examples.sql   # run a script
#
# Reads $LOGMON_JSONL (hourly JSONL, incl. .gz). DuckDB's read_json_auto handles
# gzip transparently, so backfilled archives query the same as live data.
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=logmon.env
source ./logmon.env

command -v duckdb >/dev/null || {
  echo "duckdb not found. Install: brew install duckdb"; exit 1; }

GLOB="$LOGMON_JSONL/*.jsonl"
# columns=... keeps the schema stable even if early files lack optional fields.
SETUP="CREATE VIEW logs AS
  SELECT * FROM read_json_auto('$GLOB',
    format='newline_delimited', union_by_name=true,
    ignore_errors=true);"

if [ "${1:-}" = "-c" ] || [ "${1:-}" = "-f" ]; then
  tmp=$(mktemp)
  trap 'rm -f "$tmp"' EXIT
  echo "$SETUP" > "$tmp"
  if [ "$1" = "-c" ]; then
    echo "$2" >> "$tmp"
  else
    cat "$2" >> "$tmp"
  fi
  exec duckdb -c ".read $tmp"
fi

# Interactive: preload the view via an init script.
init=$(mktemp)
trap 'rm -f "$init"' EXIT
echo "$SETUP" > "$init"
echo "Loaded view 'logs' from $GLOB"
exec duckdb -init "$init"
