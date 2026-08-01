# Deploy runbook — observatory + watchdog + logmon

Three independent pieces, deploy in any order. The monitors post to Mattermost;
everything starts **silent** (dry-run) and you flip posting on when ready.

Project: `xrplf-release-notifier` (same as the GCS bucket + Cloud Run service).

## 0. One-time auth (only you can do this)

```bash
gcloud auth application-default login    # interactive browser OAuth — terraform needs this
```

## 1. Observatory VM (vlwatch + crawler)

```bash
cd observatory/terraform
terraform apply                          # VM + service account + external IP + SSH firewall

cd ..
IP=$(terraform -chdir=terraform output -raw external_ip)
HOST=observatory@$IP ./deploy.sh         # SILENT=1 (default): monitors run, post NOTHING
```

Watch would-be alerts (logged, not posted):

```bash
ssh -i ~/.ssh/xrpl-labs observatory@$IP 'journalctl -u vlwatch -u crawler-monitor -f'
```

Go live when satisfied:

```bash
HOST=observatory@$IP SILENT=0 ./deploy.sh
```

## 2. Watchdog scheduler (POST /monitors every 15 min)

Reuses the existing `POLLER_TOKEN` (same value as the `/poll` job / `APP_SECRETS.POLLER_TOKEN`).

```bash
SERVICE_URL=$(gcloud run services describe xrplf-release-notifier \
  --region=us-central1 --format='value(status.url)')

gcloud scheduler jobs create http xrplf-release-notifier-monitors \
  --location=us-central1 \
  --schedule="*/15 * * * *" \
  --uri="$SERVICE_URL/monitors" \
  --http-method=POST \
  --headers="X-Cloud-Scheduler-Token=$POLLER_TOKEN"
```

Dry-run the watchdog once by hand (computes alerts, posts nothing):

```bash
curl -sX POST "$SERVICE_URL/monitors" \
  -H "X-Cloud-Scheduler-Token: $POLLER_TOKEN" \
  -H 'content-type: application/json' -d '{"dryRun":true}' | jq
```

## 3. logmon on the stage node (read the validator's logs)

In the `xrplf-unl-validator` repo. One-time GCS setup (mints the SA key) is in
`ansible/LOGMON.md`; paste the key into `vault.yml` as `logmon_gcs_sa_key`.

```bash
cd ../xrplf-unl-validator/ansible
ansible-playbook logmon.yml -e @vault.yml --ask-vault-pass
```

JSONL lands at `gs://xrplf-release-notifier/stage-node-logs/<host>/`; the
watchdog's LOGS_STALE/LOG_ERRORS read it.

## Kill switch (stop posting NOW)

Set `$HOST` to whatever you used at bring-up — the actual Proxmox box the
monitors run on (`observatory@<host-ip>`), not necessarily a GCP VM:

```bash
# Instant: halt all monitors — posting stops within a second (host stays up).
# Stops the live posters AND their timers, so no queued oneshot re-triggers them.
ssh -i ~/.ssh/xrpl-labs "$HOST" \
  'sudo systemctl stop vlwatch crawler-monitor crawler-crawl.timer crawler-amendments.timer crawler-nunl.timer observatory-heartbeat.timer'

# Back to silent instead of stopped (keeps observing, posts nothing):
HOST="$HOST" SILENT=1 ./deploy.sh

# GCP-only fallback — ONLY if the observatory was provisioned as a GCE VM via
# observatory/terraform (not the default Proxmox host). Nuclear: powers off the VM.
gcloud compute instances stop xrpl-observatory --zone=us-central1-a --project=xrplf-release-notifier
```

## Rollback

- Monitors: `ssh observatory@$IP 'sudo systemctl disable --now vlwatch crawler-monitor crawler-crawl.timer crawler-amendments.timer'`
- Watchdog: `gcloud scheduler jobs delete xrplf-release-notifier-monitors --location=us-central1`
- VM: `terraform -chdir=observatory/terraform destroy`
- logmon: `sudo systemctl disable --now logmon logmon-sync.timer` on the node
