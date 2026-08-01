-- Example DuckDB queries over the `logs` view (set up by q.sh).
-- Columns: ts (VARCHAR rfc3339), partition, severity, sev_num, msg, host, source.
-- Run any one with:  ./query/q.sh -c "<query>"

-- Volume by partition + severity (where is the firehose coming from?)
SELECT partition, severity, count(*) AS n
FROM logs
GROUP BY 1, 2
ORDER BY n DESC
LIMIT 30;

-- Everything at WRN or worse, newest first
SELECT ts, partition, severity, msg
FROM logs
WHERE sev_num >= 3
ORDER BY ts DESC
LIMIT 100;

-- Consensus / ledger-close activity in a time window
SELECT ts, partition, msg
FROM logs
WHERE partition IN ('LedgerConsensus', 'LedgerMaster', 'Consensus')
  AND ts BETWEEN '2026-06-10T14:00:00Z' AND '2026-06-10T14:05:00Z'
ORDER BY ts;

-- Free-text hunt across the message body
SELECT ts, partition, severity, msg
FROM logs
WHERE msg ILIKE '%proposal%'
ORDER BY ts
LIMIT 200;

-- Per-minute trace rate (spot bursts/stalls)
SELECT strftime(ts::TIMESTAMP, '%Y-%m-%d %H:%M') AS minute, count(*) AS n
FROM logs
GROUP BY 1
ORDER BY 1;
