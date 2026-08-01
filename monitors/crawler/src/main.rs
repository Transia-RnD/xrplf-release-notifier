mod amendments;
mod crawl;
mod detect;
mod monitor;
mod names;
mod nunl;
mod report;
mod types;
mod version;
mod webhook;

use anyhow::Result;
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(
    name = "xrpl-crawler",
    about = "Xahau network crawler and validation monitor"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// BFS crawl the network via /crawl endpoints, identify suspicious nodes and leak points
    Crawl {
        /// Seed nodes (ip:port)
        #[arg(short, long, value_delimiter = ',', required = true)]
        seeds: Vec<String>,

        /// Version string to flag as suspicious (empty = suspicion off)
        #[arg(short = 'v', long, default_value = "")]
        suspicious_version: String,

        /// Max concurrent crawl requests
        #[arg(short, long, default_value_t = 20)]
        concurrency: usize,

        /// Ceiling on total nodes to admit (bounds work against fabricated-IP flooding)
        #[arg(long, default_value_t = 5000)]
        max_nodes: usize,

        /// HTTP timeout per endpoint in seconds
        #[arg(short, long, default_value_t = 8)]
        timeout: u64,

        /// Resume from saved state
        #[arg(long)]
        resume: bool,

        /// State file path
        #[arg(short, long, default_value = "crawl-state.json")]
        output: String,

        /// Write a machine-readable report + evaluate snapshot rules against it
        #[arg(long)]
        report_json: Option<String>,

        /// Post a PATCH_ADOPTION status card: share of core nodes at/above this
        /// version, e.g. a hotfix like 3.2.1 (needs --report-json; posts on
        /// movement, else every 12h)
        #[arg(long)]
        min_safe_version: Option<String>,

        /// Mattermost webhook URL for alerts
        #[arg(long)]
        webhook: Option<String>,

        /// Alert dedup state file (24h hysteresis)
        #[arg(long)]
        webhook_state: Option<String>,

        /// Evaluate rules and print alerts without posting
        #[arg(long)]
        dry_run: bool,
    },
    /// Subscribe to validation streams, log validations, flag suspicious pubkeys, detect attacks
    Monitor {
        /// WebSocket endpoints (ws:// or wss://)
        #[arg(short, long, value_delimiter = ',', required = true)]
        endpoints: Vec<String>,

        /// Crawl state file to load suspicious pubkeys from
        #[arg(long, default_value = "crawl-state.json")]
        state_file: String,

        /// Output JSONL file for validation logs
        #[arg(short, long, default_value = "validations.jsonl")]
        output: String,

        /// UNL file with expected validator master keys (one nH... key per line)
        #[arg(long)]
        unl_file: Option<String>,

        /// Minimum expected UNL validators per ledger (default: 80% of UNL size)
        #[arg(long)]
        min_validators: Option<usize>,

        /// Output JSONL file for detection alerts
        #[arg(long, default_value = "alerts.jsonl")]
        alerts: String,

        /// Minimum ledger sequence to process (filters out other networks sharing WS endpoints)
        #[arg(long, default_value_t = 0)]
        min_seq: u64,

        /// Mattermost webhook URL for detection alerts
        #[arg(long)]
        webhook: Option<String>,

        /// Alert dedup state file (24h hysteresis)
        #[arg(long)]
        webhook_state: Option<String>,

        /// Emit alerts to stdout without posting
        #[arg(long)]
        dry_run: bool,

        /// Alert when validators run a build below this version (e.g. a hotfix "3.2.1")
        #[arg(long)]
        min_version: Option<String>,

        /// JSON map of validator key → name, so alerts say who a validator is
        #[arg(long)]
        names_file: Option<String>,

        /// Live key→name source (XRPLF/unl raw yaml); refreshed hourly
        #[arg(long, default_value = crate::names::DEFAULT_NAMES_URL)]
        names_url: Option<String>,
    },
    /// Track network-wide amendment majority/activation via public ledger_entry
    Amendments {
        /// Public JSON-RPC endpoint (http)
        #[arg(short, long, default_value = "https://s1.ripple.com:51234")]
        endpoint: String,

        /// State file (previous enabled/majority sets)
        #[arg(short, long, default_value = "amendments-state.json")]
        state_file: String,

        /// Mattermost webhook URL for alerts
        #[arg(long)]
        webhook: Option<String>,

        /// Alert dedup state file (24h hysteresis)
        #[arg(long)]
        webhook_state: Option<String>,

        /// Evaluate and print alerts without posting
        #[arg(long)]
        dry_run: bool,
    },
    /// Track the Negative UNL (validators disabled/re-enabled) via public ledger_entry
    Nunl {
        /// Public JSON-RPC endpoint (http)
        #[arg(short, long, default_value = "https://s1.ripple.com:51234")]
        endpoint: String,

        /// State file (previous NUNL membership)
        #[arg(short, long, default_value = "nunl-state.json")]
        state_file: String,

        /// Mattermost webhook URL for alerts
        #[arg(long)]
        webhook: Option<String>,

        /// Alert dedup state file (24h hysteresis)
        #[arg(long)]
        webhook_state: Option<String>,

        /// Evaluate and print alerts without posting
        #[arg(long)]
        dry_run: bool,

        /// JSON map of validator key → name
        #[arg(long)]
        names_file: Option<String>,

        /// Live key→name source (XRPLF/unl raw yaml)
        #[arg(long, default_value = crate::names::DEFAULT_NAMES_URL)]
        names_url: Option<String>,
    },
    /// Generate xrpld [ips_fixed] config from crawl results
    GenConfig {
        /// Crawl state file
        #[arg(short, long, default_value = "crawl-state.json")]
        state_file: String,

        /// Max peers to include
        #[arg(short, long, default_value_t = 10)]
        max_peers: usize,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Crawl {
            seeds,
            suspicious_version,
            concurrency,
            max_nodes,
            timeout,
            resume,
            output,
            report_json,
            min_safe_version,
            webhook,
            webhook_state,
            dry_run,
        } => {
            crawl::run(
                seeds,
                &suspicious_version,
                concurrency,
                timeout,
                resume,
                &output,
                report_json.as_deref(),
                min_safe_version.as_deref(),
                webhook,
                webhook_state,
                dry_run,
                max_nodes,
            )
            .await
        }
        Command::Monitor {
            endpoints,
            state_file,
            output,
            unl_file,
            min_validators,
            alerts,
            min_seq,
            webhook,
            webhook_state,
            dry_run,
            min_version,
            names_file,
            names_url,
        } => {
            monitor::run(
                endpoints,
                &state_file,
                &output,
                unl_file.as_deref(),
                min_validators,
                &alerts,
                min_seq,
                webhook,
                webhook_state,
                dry_run,
                min_version,
                names_file,
                names_url,
            )
            .await
        }
        Command::Amendments {
            endpoint,
            state_file,
            webhook,
            webhook_state,
            dry_run,
        } => amendments::run(&endpoint, &state_file, webhook, webhook_state, dry_run).await,
        Command::Nunl {
            endpoint,
            state_file,
            webhook,
            webhook_state,
            dry_run,
            names_file,
            names_url,
        } => {
            nunl::run(
                &endpoint,
                &state_file,
                webhook,
                webhook_state,
                dry_run,
                names_file,
                names_url,
            )
            .await
        }
        Command::GenConfig {
            state_file,
            max_peers,
        } => crawl::gen_config(&state_file, max_peers),
    }
}
