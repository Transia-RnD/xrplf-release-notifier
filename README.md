# xrplf-release-notifier

Automated release notifications for rippled version changes. Monitors the [xrplf/rippled](https://github.com/XRPLF/rippled) repository and the official binary package repository (repos.ripple.com) to broadcast release updates to Mattermost and Twitter/X.

## How It Works

**Webhook path:** A GitHub App delivers push and release events. `/webhook` dispatches by `X-GitHub-Event`:
- `push` to `develop` / `release-*` modifying `BuildInfo.cpp` → beta / RC / final notification
- `push` to `refs/tags/X.Y.Z` (or `vX.Y.Z`) → tag notification
- `release` with `action: published` (not draft) → GitHub release notification

**Polling path:** Cloud Scheduler triggers `/poll` every 15 minutes. The service scrapes repos.ripple.com for new `.deb`/`.rpm` packages and notifies when a new binary appears.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.template .env
# Fill in your secrets
```

### 3. Run locally

```bash
npm run serve
```

### 4. Test with a sample webhook

```bash
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -H "X-Hub-Signature-256: sha256=$(echo -n '{}' | openssl dgst -sha256 -hmac 'your-secret' | cut -d' ' -f2)" \
  -d '{}'
```

## Testing

```bash
npm test
```

## Deployment

Deployed to GCP Cloud Run via Cloud Build:

```bash
gcloud builds submit --config=cloudbuild.yaml
```

### GCP Resources Required

- **Cloud Run** service
- **Secret Manager** secret `APP_SECRETS` (JSON blob with all credentials)
- **Cloud Storage** bucket for poller state
- **Cloud Scheduler** job hitting `POST /poll` every 15 minutes

### GitHub App Setup

1. Create at `github.com/organizations/XRPLF/settings/apps/new`
2. Permissions: Repository contents (Read-only)
3. Subscribe to events: **Push** AND **Release**
4. Install on `XRPLF/rippled`
5. Set webhook URL to Cloud Run service URL + `/webhook`

## Version Types

| Type | Pattern | Example | Notification |
|------|---------|---------|-------------|
| Beta | `X.Y.Z-bN` | `3.2.0-b4` | Source bump on `develop` |
| RC | `X.Y.Z-rcN` | `3.1.0-rc1` | Source bump on `release-*` |
| Final | `X.Y.Z` | `3.1.0` | Source bump on `release-*` |
| Tag | `(v?)X.Y.Z(-...)?` | `3.1.0`, `v3.1.0` | Canonical release point tagged |
| Release | published GitHub Release | `3.1.0` | GitHub Release announced |
| Binary | (polled) | `3.1.3` | Package available on repos.ripple.com |
