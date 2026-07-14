#!/usr/bin/env bash
# One-time GCP setup for keyless GitHub Actions deploys of xrplf-release-notifier.
# Creates: workload-identity pool + OIDC provider (trusting ONLY
# XRPLF/xrplf-release-notifier) and a github-deployer service account allowed to
# run Cloud Build submits.
#
# Idempotent: safe to re-run — existing resources are left as-is and the
# role bindings are no-ops when already present.
set -euo pipefail
P=xrplf-release-notifier
PN=417170642979
SA=github-deployer@$P.iam.gserviceaccount.com

# --- preflight: right account, right project, before touching IAM ---
ACCOUNT=$(gcloud config get-value account 2>/dev/null)
if [[ -z "$ACCOUNT" ]]; then
  echo "No active gcloud account — run: gcloud auth login" >&2
  exit 1
fi
if ! gcloud projects describe "$P" --format="value(projectNumber)" 2>/dev/null | grep -qx "$PN"; then
  echo "Account $ACCOUNT cannot access project $P (or project number mismatch)" >&2
  exit 1
fi
echo "About to configure IAM on project $P as $ACCOUNT:"
echo "  - workload-identity pool 'github' + OIDC provider trusting XRPLF/xrplf-release-notifier"
echo "  - service account $SA with cloudbuild.builds.editor, storage.admin, serviceusage.serviceUsageConsumer"
read -r -p "Proceed? [y/N] " REPLY
[[ "$REPLY" == "y" || "$REPLY" == "Y" ]] || { echo "Aborted."; exit 1; }

# --- create-if-missing ---
gcloud iam workload-identity-pools describe github \
  --project=$P --location=global >/dev/null 2>&1 ||
gcloud iam workload-identity-pools create github \
  --project=$P --location=global --display-name="GitHub Actions"

gcloud iam workload-identity-pools providers describe github-oidc \
  --project=$P --location=global --workload-identity-pool=github >/dev/null 2>&1 ||
gcloud iam workload-identity-pools providers create-oidc github-oidc \
  --project=$P --location=global --workload-identity-pool=github \
  --display-name="GitHub OIDC" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository=='XRPLF/xrplf-release-notifier'"

gcloud iam service-accounts describe "$SA" --project=$P >/dev/null 2>&1 ||
gcloud iam service-accounts create github-deployer \
  --project=$P --display-name="GitHub Actions deployer"

# --- role bindings (add-iam-policy-binding is a no-op when already granted) ---
# Submit builds + upload source to the _cloudbuild bucket + read build logs.
for ROLE in roles/cloudbuild.builds.editor roles/storage.admin roles/serviceusage.serviceUsageConsumer; do
  gcloud projects add-iam-policy-binding "$P" --member="serviceAccount:$SA" \
    --role="$ROLE" --condition=None >/dev/null
done

# Let workflows from the repo impersonate the deployer SA.
gcloud iam service-accounts add-iam-policy-binding "$SA" --project=$P \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$PN/locations/global/workloadIdentityPools/github/attribute.repository/XRPLF/xrplf-release-notifier" >/dev/null

echo "Done. Deploys from .github/workflows/ci.yml can now authenticate."
