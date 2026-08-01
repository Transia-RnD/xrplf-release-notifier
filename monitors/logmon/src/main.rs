//! logmon — ingest and parse xrpld trace logs into structured JSONL.
//!
//! xrpld writes a fixed text format (see src/libxrpl/basics/Log.cpp `Logs::format`):
//!
//!     2026-Jun-10 14:30:45.123456 UTC LedgerMaster:TRC <message>
//!     <continuation line with no timestamp belongs to the previous record>
//!
//! The timestamp is `date::format("%Y-%b-%d %T %Z", system_clock::now())`, the
//! partition is optional, and the severity is one of TRC/DBG/NFO/WRN/ERR/FTL.
//!
//! This binary is a pure parser: it reads stdin, plain `.log` files, or gzipped
//! `.gz` archives, and emits one JSON object per log record. Tailing and rotation
//! are handled in shell (`run.sh` / `rotate.sh`) so this stays simple and robust.

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{self, BufRead, BufReader, BufWriter, Write};
use std::path::PathBuf;

use anyhow::{Context, Result};
use chrono::{DateTime, NaiveDateTime, Utc};
use clap::Parser;
use flate2::read::MultiGzDecoder;
use regex::Regex;
use serde::Serialize;

#[derive(Parser, Debug)]
#[command(
    name = "logmon",
    about = "Parse xrpld trace logs into structured JSONL (stdin, .log, or .gz)"
)]
struct Args {
    /// Input files (.log or .gz). Omit, or pass "-", to read stdin.
    inputs: Vec<String>,

    /// Write hourly-partitioned JSONL into this directory (DIR/YYYY-MM-DD-HH.jsonl).
    /// When omitted, JSONL is written to stdout.
    #[arg(long, short)]
    out: Option<PathBuf>,

    /// Tag every record with this host/node name (e.g. "vnode1").
    #[arg(long)]
    host: Option<String>,

    /// Tag every record with this source label (defaults to the input file name).
    #[arg(long)]
    source: Option<String>,
}

/// One parsed log record.
#[derive(Serialize)]
struct Record {
    /// RFC3339 UTC timestamp, e.g. "2026-06-10T14:30:45.123456Z". None if unparseable.
    #[serde(skip_serializing_if = "Option::is_none")]
    ts: Option<String>,
    /// Partition / component, e.g. "LedgerMaster". None when the line had none.
    #[serde(skip_serializing_if = "Option::is_none")]
    partition: Option<String>,
    /// Severity code: TRC, DBG, NFO, WRN, ERR, FTL — or "RAW" for unparsed lines.
    severity: &'static str,
    /// Numeric severity for ordering/filtering: trace=0 .. fatal=5, raw=-1.
    sev_num: i8,
    msg: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
}

fn severity_num(code: &str) -> i8 {
    match code {
        "TRC" => 0,
        "DBG" => 1,
        "NFO" => 2,
        "WRN" => 3,
        "ERR" => 4,
        "FTL" => 5,
        _ => -1,
    }
}

/// Sinks JSON records either to stdout or to hourly-partitioned files in a dir.
enum Sink {
    Stdout(BufWriter<io::Stdout>),
    Dir {
        dir: PathBuf,
        files: HashMap<String, BufWriter<File>>,
    },
}

impl Sink {
    fn write(&mut self, rec: &Record) -> Result<()> {
        let line = serde_json::to_string(rec)?;
        match self {
            Sink::Stdout(w) => {
                w.write_all(line.as_bytes())?;
                w.write_all(b"\n")?;
            }
            Sink::Dir { dir, files } => {
                // Partition by the record's UTC hour; records with no timestamp
                // go to an "unknown" bucket so nothing is silently dropped.
                let bucket = rec
                    .ts
                    .as_deref()
                    .map(|t| t.get(0..13).unwrap_or("unknown").replace('T', "-"))
                    .unwrap_or_else(|| "unknown".to_string());
                let w = match files.get_mut(&bucket) {
                    Some(w) => w,
                    None => {
                        let path = dir.join(format!("{bucket}.jsonl"));
                        let f = OpenOptions::new()
                            .create(true)
                            .append(true)
                            .open(&path)
                            .with_context(|| format!("opening {}", path.display()))?;
                        files.entry(bucket).or_insert(BufWriter::new(f))
                    }
                };
                w.write_all(line.as_bytes())?;
                w.write_all(b"\n")?;
            }
        }
        Ok(())
    }

    fn flush(&mut self) -> Result<()> {
        match self {
            Sink::Stdout(w) => w.flush()?,
            Sink::Dir { files, .. } => {
                for w in files.values_mut() {
                    w.flush()?;
                }
            }
        }
        Ok(())
    }
}

/// Streaming parser. Accumulates continuation lines into the current record and
/// flushes the previous record when a new timestamped line begins.
struct Parser2 {
    head: Regex,
    rest: Regex,
    host: Option<String>,
    source: Option<String>,
    pending: Option<Record>,
}

impl Parser2 {
    fn new(host: Option<String>, source: Option<String>) -> Self {
        // <timestamp> <tz> <rest>. Timestamp has an optional fractional part.
        let head =
            Regex::new(r"^(\d{4}-[A-Za-z]{3}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?) (\S+) (.*)$")
                .unwrap();
        // [partition:]<SEV> <message>
        let rest = Regex::new(r"^(?:([^:\s]+):)?(TRC|DBG|NFO|WRN|ERR|FTL) ?(.*)$").unwrap();
        Self {
            head,
            rest,
            host,
            source,
            pending: None,
        }
    }

    /// Feed one raw line (no trailing newline). Returns a completed record when
    /// this line starts a new one, displacing the previous.
    fn feed(&mut self, line: &str) -> Option<Record> {
        if let Some(c) = self.head.captures(line) {
            let ts_raw = &c[1];
            let body = &c[3];
            let ts = parse_ts(ts_raw);

            let (partition, severity, msg) = if let Some(r) = self.rest.captures(body) {
                let partition = r.get(1).map(|m| m.as_str().to_string());
                let sev = match &r[2] {
                    "TRC" => "TRC",
                    "DBG" => "DBG",
                    "NFO" => "NFO",
                    "WRN" => "WRN",
                    "ERR" => "ERR",
                    _ => "FTL",
                };
                (partition, sev, r[3].to_string())
            } else {
                // Timestamped but no recognizable severity token.
                (None, "RAW", body.to_string())
            };

            let rec = Record {
                ts,
                partition,
                severity,
                sev_num: severity_num(severity),
                msg,
                host: self.host.clone(),
                source: self.source.clone(),
            };
            return self.pending.replace(rec);
        }

        // Continuation line: append to the current record's message.
        match self.pending.as_mut() {
            Some(p) => {
                p.msg.push('\n');
                p.msg.push_str(line);
                None
            }
            None => {
                // A continuation with no head yet (file started mid-message):
                // surface it as a RAW record rather than dropping it.
                self.pending = Some(Record {
                    ts: None,
                    partition: None,
                    severity: "RAW",
                    sev_num: -1,
                    msg: line.to_string(),
                    host: self.host.clone(),
                    source: self.source.clone(),
                });
                None
            }
        }
    }

    fn finish(&mut self) -> Option<Record> {
        self.pending.take()
    }
}

/// Parse "2026-Jun-10 14:30:45.123456" (UTC assumed) into RFC3339 with microseconds.
fn parse_ts(s: &str) -> Option<String> {
    let naive = NaiveDateTime::parse_from_str(s, "%Y-%b-%d %H:%M:%S%.f")
        .or_else(|_| NaiveDateTime::parse_from_str(s, "%Y-%b-%d %H:%M:%S"))
        .ok()?;
    let dt: DateTime<Utc> = DateTime::from_naive_utc_and_offset(naive, Utc);
    // xrpld logs nanosecond precision (%T over system_clock); keep all 9 digits.
    Some(dt.format("%Y-%m-%dT%H:%M:%S%.9fZ").to_string())
}

fn open_reader(path: &str) -> Result<Box<dyn BufRead>> {
    if path == "-" {
        return Ok(Box::new(BufReader::new(io::stdin())));
    }
    let f = File::open(path).with_context(|| format!("opening {path}"))?;
    if path.ends_with(".gz") {
        Ok(Box::new(BufReader::new(MultiGzDecoder::new(f))))
    } else {
        Ok(Box::new(BufReader::new(f)))
    }
}

fn file_label(path: &str) -> Option<String> {
    if path == "-" {
        return None;
    }
    PathBuf::from(path)
        .file_name()
        .map(|n| n.to_string_lossy().trim_end_matches(".gz").to_string())
}

fn main() -> Result<()> {
    let args = Args::parse();

    let mut sink = match &args.out {
        Some(dir) => {
            std::fs::create_dir_all(dir)
                .with_context(|| format!("creating output dir {}", dir.display()))?;
            Sink::Dir {
                dir: dir.clone(),
                files: HashMap::new(),
            }
        }
        None => Sink::Stdout(BufWriter::new(io::stdout())),
    };

    let inputs = if args.inputs.is_empty() {
        vec!["-".to_string()]
    } else {
        args.inputs.clone()
    };

    for input in &inputs {
        // Per-file source label unless the user pinned one explicitly.
        let source = args.source.clone().or_else(|| file_label(input));
        let mut parser = Parser2::new(args.host.clone(), source);
        let reader = open_reader(input)?;
        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(e) => {
                    eprintln!("logmon: read error on {input}: {e}");
                    break;
                }
            };
            if let Some(rec) = parser.feed(&line) {
                sink.write(&rec)?;
            }
        }
        if let Some(rec) = parser.finish() {
            sink.write(&rec)?;
        }
        sink.flush()?;
    }

    sink.flush()?;
    Ok(())
}
