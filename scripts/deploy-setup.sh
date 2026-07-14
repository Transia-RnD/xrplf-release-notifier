#!/usr/bin/env bash
# One-time GCP setup for keyless GitHub Actions deploys of xrplf-release-notifier.
# Creates: workload-identity pool + OIDC provider (trusting ONLY
# XRPLF/xrplf-release-notifier) and a github-deployer service account allowed to
# run Cloud Build submits. Review, then run: bash deploy-setup.sh
set -euo pipefail
P=xrplf-release-notifier
PN=417170642979
SA=github-deployer@$P.iam.gserviceaccount.com

gcloud iam workload-identity-pools create github \
  --project=$P --location=global --display-name="GitHub Actions"

gcloud iam workload-identity-pools providers create-oidc github-oidc \
  --project=$P --location=global --workload-identity-pool=github \
  --display-name="GitHub OIDC" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository=='XRPLF/xrplf-release-notifier'"

gcloud iam service-accounts create github-deployer \
  --project=$P --display-name="GitHub Actions deployer"

# Submit builds + upload source to the _cloudbuild bucket + read build logs.
gcloud projects add-iam-policy-binding $P --member="serviceAccount:$SA" \
  --role=roles/cloudbuild.builds.editor --condition=None
gcloud projects add-iam-policy-binding $P --member="serviceAccount:$SA" \
  --role=roles/storage.admin --condition=None
gcloud projects add-iam-policy-binding $P --member="serviceAccount:$SA" \
  --role=roles/serviceusage.serviceUsageConsumer --condition=None

# Let workflows from the repo impersonate the deployer SA.
gcloud iam service-accounts add-iam-policy-binding $SA --project=$P \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$PN/locations/global/workloadIdentityPools/github/attribute.repository/XRPLF/xrplf-release-notifier"

echo "Done. Now commit .github/workflows/deploy.yml"
