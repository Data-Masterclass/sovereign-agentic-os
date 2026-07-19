#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# bootstrap-gke.sh — irreducible GKE prerequisites for the OS chart (keyless).
# =============================================================================
# Mirrors docs/research/cloud-install-gke-eks-aks.md §2 (GKE) and the style of
# scripts/bootstrap-local.sh. Helm cannot enable APIs, bind Workload Identity,
# create a GCS bucket or turn on Vertex — those are the ~6 scriptable cloud API
# calls this script makes. After it, one `helm upgrade --install -f
# values.gke.yaml` completes the install.
#
# Keyless: Workload Identity Federation binds a Kubernetes ServiceAccount (KSA)
# DIRECTLY to IAM (no intermediary Google SA); pods then get ADC. No static keys.
#
# Idempotent: every step checks-before-create; safe to re-run.
#
# Usage (env is set by `sos install`, or export manually):
#   SOS_PROJECT=my-proj SOS_REGION=us-central1 SOS_BUCKET=sovereign-os-my-proj \
#     ./deploy/cloud/bootstrap-gke.sh
#
# Optional overrides:
#   SOS_CLUSTER   (default: agentic-os)   GKE cluster name (for WI enablement)
#   SOS_NAMESPACE (default: agentic-os)   K8s namespace the KSAs live in
# =============================================================================
set -euo pipefail

# --- inputs ----------------------------------------------------------------
PROJECT="${SOS_PROJECT:-}"
REGION="${SOS_REGION:-us-central1}"
BUCKET="${SOS_BUCKET:-}"
CLUSTER="${SOS_CLUSTER:-agentic-os}"
NAMESPACE="${SOS_NAMESPACE:-agentic-os}"

# KSAs that need cloud APIs (report §2 common shape). trino -> GCS + BigLake;
# litellm -> Vertex AI; cnpg -> GCS (WAL archive).
KSA_TRINO="trino-sa"
KSA_LITELLM="litellm-sa"
KSA_CNPG="cnpg-sa"

# --- pretty printers (match bootstrap-local.sh) ----------------------------
step() { printf '\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m    ✓ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# --- preflight -------------------------------------------------------------
command -v gcloud >/dev/null 2>&1 || die "gcloud not found — install the Google Cloud SDK: https://cloud.google.com/sdk/docs/install"
command -v gsutil  >/dev/null 2>&1 || die "gsutil not found — it ships with the Google Cloud SDK"
[ -n "$PROJECT" ] || die "SOS_PROJECT is required (the GKE project id)"
[ -n "$BUCKET" ]  || die "SOS_BUCKET is required (the GCS warehouse bucket name)"

# WI federation target: the direct principal for a KSA (no intermediary GSA).
# NOTE: this needs the project NUMBER, not the id, in the principal string.
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')" \
  || die "cannot read project $PROJECT — check the id and your gcloud auth"
WI_POOL="$PROJECT.svc.id.goog"

step "GKE bootstrap for project=$PROJECT region=$REGION bucket=$BUCKET"

# --- 1. enable the required APIs -------------------------------------------
step "Enabling required Google APIs (idempotent)"
for api in aiplatform.googleapis.com storage.googleapis.com biglake.googleapis.com \
           container.googleapis.com iam.googleapis.com; do
  if gcloud services list --enabled --project "$PROJECT" --filter="config.name=$api" --format='value(config.name)' | grep -q "$api"; then
    ok "$api already enabled"
  else
    gcloud services enable "$api" --project "$PROJECT"
    ok "$api enabled"
  fi
done

# --- 2. ensure Workload Identity on the cluster + node pools ---------------
# FOOTGUN (report §2): WI must be on the CLUSTER *and* every node pool must run
# with GKE_METADATA, or pods silently fall back to the node SA. We enable it if a
# cluster with this name exists; if you use a different cluster, set SOS_CLUSTER.
step "Ensuring Workload Identity on cluster '$CLUSTER'"
if gcloud container clusters describe "$CLUSTER" --project "$PROJECT" --region "$REGION" >/dev/null 2>&1; then
  CUR_WI="$(gcloud container clusters describe "$CLUSTER" --project "$PROJECT" --region "$REGION" --format='value(workloadIdentityConfig.workloadPool)')"
  if [ "$CUR_WI" = "$WI_POOL" ]; then
    ok "Workload Identity already enabled ($WI_POOL)"
  else
    gcloud container clusters update "$CLUSTER" --project "$PROJECT" --region "$REGION" \
      --workload-pool="$WI_POOL"
    ok "Workload Identity enabled on cluster"
  fi
  # Node pools: ensure GKE_METADATA (fail-open is the trap — check each).
  for np in $(gcloud container node-pools list --cluster "$CLUSTER" --project "$PROJECT" --region "$REGION" --format='value(name)'); do
    MODE="$(gcloud container node-pools describe "$np" --cluster "$CLUSTER" --project "$PROJECT" --region "$REGION" --format='value(config.workloadMetadataConfig.mode)')"
    if [ "$MODE" = "GKE_METADATA" ]; then
      ok "node pool $np already uses GKE_METADATA"
    else
      gcloud container node-pools update "$np" --cluster "$CLUSTER" --project "$PROJECT" --region "$REGION" \
        --workload-metadata=GKE_METADATA
      ok "node pool $np set to GKE_METADATA"
    fi
  done
else
  printf '\033[1;33m    ! cluster %s not found in %s — skipping WI enablement.\033[0m\n' "$CLUSTER" "$REGION"
  printf '      Enable it yourself with --workload-pool=%s and GKE_METADATA node pools.\n' "$WI_POOL"
fi

# --- 3. GCS warehouse bucket ------------------------------------------------
step "Ensuring GCS bucket gs://$BUCKET"
if gsutil ls -b "gs://$BUCKET" >/dev/null 2>&1; then
  ok "bucket gs://$BUCKET already exists"
else
  # Uniform bucket-level access (-b on) is required for clean IAM-only grants.
  gsutil mb -p "$PROJECT" -l "$REGION" -b on "gs://$BUCKET"
  ok "created gs://$BUCKET"
fi

# --- 4. keyless IAM bindings for each KSA ----------------------------------
# Direct WI: bind the IAM role to the KSA principal, and let the KSA impersonate
# via roles/iam.workloadIdentityUser. No Google SA is created.
bind_ksa_role() {
  local ksa="$1" role="$2" resource_scope="$3" # resource_scope: "project" or a bucket
  local principal="principal://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$WI_POOL/subject/ns/$NAMESPACE/sa/$ksa"
  if [ "$resource_scope" = "project" ]; then
    gcloud projects add-iam-policy-binding "$PROJECT" \
      --member="$principal" --role="$role" --condition=None >/dev/null
    ok "$ksa -> $role (project)"
  else
    gsutil iam ch "$principal:$role" "gs://$resource_scope" >/dev/null
    ok "$ksa -> $role (gs://$resource_scope)"
  fi
}

step "Binding keyless IAM roles to KSAs (ns=$NAMESPACE)"
# trino-sa: read/write the warehouse bucket + BigLake catalog access.
bind_ksa_role "$KSA_TRINO"   "roles/storage.objectAdmin" "$BUCKET"
bind_ksa_role "$KSA_TRINO"   "roles/biglake.admin"       "project"
# litellm-sa: call Vertex AI (least-priv: aiplatform.user).
bind_ksa_role "$KSA_LITELLM" "roles/aiplatform.user"     "project"
# cnpg-sa: write WAL/backups to the same bucket.
bind_ksa_role "$KSA_CNPG"    "roles/storage.objectAdmin" "$BUCKET"

# --- 5. summary -------------------------------------------------------------
step "GKE bootstrap complete."
cat <<EOF

  Pass these to \`sos install\` (or they are already set if it invoked this):
    --cloud gke --project $PROJECT --region $REGION --bucket $BUCKET

  Keyless identity is wired for KSAs (annotate them in the chart / overlay):
    $KSA_TRINO, $KSA_LITELLM, $KSA_CNPG  (namespace: $NAMESPACE)
  These KSAs get ADC via Workload Identity — no keys are created or stored.

  FOOTGUNS handled here (report §2): APIs enabled; WI on cluster + GKE_METADATA
  on every node pool; uniform bucket-level access on. If some LiteLLM versions
  reject the Vertex model, use the 'google/<model>' prefix in values.gke.yaml.

  Next:  helm upgrade --install agentic-os charts/sovereign-agentic-os \\
           -n $NAMESPACE --create-namespace -f values.gke.yaml -f install.yaml
EOF
