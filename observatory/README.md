# Observatory

A small always-on GCE VM that runs the network monitors (`vlwatch`,
`xrpl-crawler`) as systemd services, posting alerts straight to Mattermost. The
notifier service watches the VM's heartbeat from outside.

## Layout

- `terraform/` — the VM, its service account (heartbeat writer), external IP, SSH firewall.
- `systemd/` — units: `vlwatch.service` (stream), `crawler-monitor.service` (validations stream), `crawler-crawl.{service,timer}` (hourly snapshot), `observatory-heartbeat.{service,timer}`.
- `heartbeat.sh` — publishes `gs://<bucket>/observatory/heartbeat.json` (per-unit `systemctl is-active`).
- `deploy.sh` — sync sources → build on VM → install binaries + units → start.
- `publishers.txt` — vlwatch UNL publisher allowlist.

## Bring-up

```sh
cd terraform
cp terraform.tfvars.example terraform.tfvars   # set project, tighten ssh_source_ranges
terraform init && terraform apply
IP=$(terraform output -raw external_ip)

cd ..
HOST=observatory@$IP ./deploy.sh                # builds + starts everything
```

Redeploy a new build: re-run `./deploy.sh` (idempotent).

## What runs

| Unit | Cadence | Posts |
|------|---------|-------|
| vlwatch | continuous | UNL propagation alerts (see ../monitors/ALERTS.md) |
| crawler-monitor | continuous | fork/quorum/stall detection (24h hysteresis) |
| crawler-crawl | hourly :07 | topology/eclipse/version snapshot |
| observatory-heartbeat | every 10 min | heartbeat.json to GCS (watched by the notifier) |

The webhook URL is read from the repo `.env` at deploy time and written to
`/etc/observatory.env` — it never enters terraform state.
