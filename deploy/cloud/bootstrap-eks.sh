#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# bootstrap-eks.sh — irreducible EKS prerequisites for the OS chart (keyless).
# =============================================================================
# Mirrors docs/research/cloud-install-gke-eks-aks.md §2 (EKS) and the style of
# scripts/bootstrap-local.sh. Provisions: the EKS Pod Identity add-on, two IAM
# roles (S3+Glue for trino/cnpg; Bedrock for litellm) with PodIdentityAssociations,
# an S3 warehouse bucket + Glue database, and enables Bedrock model access.
#
# Keyless: EKS Pod Identity maps a KSA to an IAM role via an association — pods
# get creds from the Pod Identity Agent. No static keys. (IRSA is the fallback
# for cross-region Bedrock; not wired here.)
#
# Idempotent: every step checks-before-create; safe to re-run.
#
# Usage:
#   SOS_ACCOUNT=111122223333 SOS_REGION=us-east-1 SOS_BUCKET=sovereign-os-acct \
#     ./deploy/cloud/bootstrap-eks.sh
#
# Optional overrides:
#   SOS_CLUSTER   (default: agentic-os)   EKS cluster name (for the add-on + associations)
#   SOS_NAMESPACE (default: agentic-os)   K8s namespace the KSAs live in
#   SOS_GLUE_DB   (default: sovereign_os) Glue catalog database name
#   SOS_LLM_REASONING / SOS_LLM_DEFAULT / SOS_LLM_EMBED  model ids to enable in Bedrock
# =============================================================================
set -euo pipefail

# --- inputs ----------------------------------------------------------------
ACCOUNT="${SOS_ACCOUNT:-}"
REGION="${SOS_REGION:-us-east-1}"
BUCKET="${SOS_BUCKET:-}"
CLUSTER="${SOS_CLUSTER:-agentic-os}"
NAMESPACE="${SOS_NAMESPACE:-agentic-os}"
GLUE_DB="${SOS_GLUE_DB:-sovereign_os}"

KSA_TRINO="trino-sa"
KSA_LITELLM="litellm-sa"
KSA_CNPG="cnpg-sa"

ROLE_STORAGE="sovereign-os-storage"   # S3 + Glue (trino + cnpg)
ROLE_BEDROCK="sovereign-os-bedrock"   # Bedrock (litellm)

step() { printf '\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m    ✓ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# --- preflight -------------------------------------------------------------
command -v aws >/dev/null 2>&1 || die "aws not found — install AWS CLI v2: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
[ -n "$BUCKET" ] || die "SOS_BUCKET is required (the S3 warehouse bucket name)"
# Account id is derivable, but require it so the CLI + script agree.
[ -n "$ACCOUNT" ] || ACCOUNT="$(aws sts get-caller-identity --query Account --output text)" || die "SOS_ACCOUNT is required and could not be derived"

step "EKS bootstrap for account=$ACCOUNT region=$REGION bucket=$BUCKET"

# --- 1. Pod Identity add-on -------------------------------------------------
# FOOTGUN: without the add-on, PodIdentityAssociations exist but pods get no
# creds. Install/verify it first.
step "Ensuring the EKS Pod Identity add-on on cluster '$CLUSTER'"
if aws eks describe-addon --cluster-name "$CLUSTER" --addon-name eks-pod-identity-agent --region "$REGION" >/dev/null 2>&1; then
  ok "eks-pod-identity-agent add-on already present"
else
  aws eks create-addon --cluster-name "$CLUSTER" --addon-name eks-pod-identity-agent --region "$REGION" >/dev/null \
    || die "failed to create the Pod Identity add-on — check the cluster name '$CLUSTER' and region"
  ok "eks-pod-identity-agent add-on created"
fi

# --- 2. S3 warehouse bucket + Glue database --------------------------------
step "Ensuring S3 bucket s3://$BUCKET"
if aws s3api head-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null 2>&1; then
  ok "bucket s3://$BUCKET already exists"
else
  # us-east-1 rejects a LocationConstraint; every other region requires it.
  if [ "$REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null
  else
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
      --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
  fi
  ok "created s3://$BUCKET"
fi

step "Ensuring Glue database '$GLUE_DB'"
if aws glue get-database --name "$GLUE_DB" --region "$REGION" >/dev/null 2>&1; then
  ok "Glue database $GLUE_DB already exists"
else
  aws glue create-database --database-input "{\"Name\":\"$GLUE_DB\"}" --region "$REGION" >/dev/null
  ok "created Glue database $GLUE_DB"
fi

# --- 3. IAM roles (trust = pods.eks.amazonaws.com for Pod Identity) ---------
TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"pods.eks.amazonaws.com"},"Action":["sts:AssumeRole","sts:TagSession"]}]}'

ensure_role() {
  local name="$1"
  if aws iam get-role --role-name "$name" >/dev/null 2>&1; then
    ok "role $name already exists"
  else
    aws iam create-role --role-name "$name" --assume-role-policy-document "$TRUST" >/dev/null
    ok "created role $name"
  fi
}

put_inline_policy() {
  local role="$1" pname="$2" doc="$3"
  aws iam put-role-policy --role-name "$role" --policy-name "$pname" --policy-document "$doc" >/dev/null
  ok "policy $pname on $role"
}

step "Ensuring IAM roles + least-privilege policies"
ensure_role "$ROLE_STORAGE"
ensure_role "$ROLE_BEDROCK"

# Storage role: the one bucket + Glue read/write for the catalog.
STORAGE_DOC=$(cat <<JSON
{"Version":"2012-10-17","Statement":[
 {"Effect":"Allow","Action":["s3:GetObject","s3:PutObject","s3:DeleteObject","s3:ListBucket"],
  "Resource":["arn:aws:s3:::$BUCKET","arn:aws:s3:::$BUCKET/*"]},
 {"Effect":"Allow","Action":["glue:GetDatabase","glue:GetTable","glue:GetTables","glue:CreateTable","glue:UpdateTable","glue:DeleteTable","glue:GetPartitions","glue:BatchCreatePartition"],
  "Resource":["arn:aws:glue:$REGION:$ACCOUNT:catalog","arn:aws:glue:$REGION:$ACCOUNT:database/$GLUE_DB","arn:aws:glue:$REGION:$ACCOUNT:table/$GLUE_DB/*"]}
]}
JSON
)
put_inline_policy "$ROLE_STORAGE" "sovereign-os-storage" "$STORAGE_DOC"

# Bedrock role: invoke-model only (least-priv).
BEDROCK_DOC='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["bedrock:InvokeModel","bedrock:InvokeModelWithResponseStream"],"Resource":"*"}]}'
put_inline_policy "$ROLE_BEDROCK" "sovereign-os-bedrock" "$BEDROCK_DOC"

# --- 4. Pod Identity associations (KSA -> role) ----------------------------
associate() {
  local ksa="$1" role="$2"
  local arn="arn:aws:iam::$ACCOUNT:role/$role"
  # Check for an existing association for this ns/sa on the cluster.
  local existing
  existing="$(aws eks list-pod-identity-associations --cluster-name "$CLUSTER" --namespace "$NAMESPACE" --service-account "$ksa" --region "$REGION" --query 'associations[0].associationId' --output text 2>/dev/null || echo None)"
  if [ "$existing" != "None" ] && [ -n "$existing" ]; then
    ok "$ksa already associated ($existing)"
  else
    aws eks create-pod-identity-association --cluster-name "$CLUSTER" \
      --namespace "$NAMESPACE" --service-account "$ksa" --role-arn "$arn" --region "$REGION" >/dev/null
    ok "$ksa -> $role"
  fi
}

step "Creating Pod Identity associations (ns=$NAMESPACE)"
associate "$KSA_TRINO"   "$ROLE_STORAGE"
associate "$KSA_CNPG"    "$ROLE_STORAGE"
associate "$KSA_LITELLM" "$ROLE_BEDROCK"

# --- 5. Bedrock model access ------------------------------------------------
# BIG FOOTGUN (report §2): Bedrock access is per-model, per-region. Enabling it
# programmatically requires a PutUseCaseForModelAccess/PutFoundationModelEntitlement
# flow that is account-specific and often gated in the console. We DETECT what is
# enabled and tell the operator exactly what to click if a tier model is missing —
# rather than fail the whole install or pretend it is on.
step "Checking Bedrock model access (per-model, per-region)"
WANT="${SOS_LLM_REASONING:-us.anthropic.claude-sonnet-4-5} ${SOS_LLM_DEFAULT:-us.amazon.nova-pro} ${SOS_LLM_EMBED:-amazon.titan-embed-text-v2}"
if AVAIL="$(aws bedrock list-foundation-models --region "$REGION" --query 'modelSummaries[].modelId' --output text 2>/dev/null)"; then
  for m in $WANT; do
    # Strip a cross-region inference prefix (us./eu.) for the base-model check.
    base="${m#us.}"; base="${base#eu.}"
    if printf '%s' "$AVAIL" | grep -q "$base"; then
      ok "model $m reachable in $REGION"
    else
      printf '\033[1;33m    ! model %s NOT enabled in %s — enable it: Bedrock console -> Model access -> Manage,\033[0m\n' "$m" "$REGION"
      printf '      or use the aws bedrock model-access APIs. Newer models also need a us./eu. inference profile.\n'
    fi
  done
else
  printf '\033[1;33m    ! could not list Bedrock models in %s (region may not offer Bedrock, or perms) — verify manually.\033[0m\n' "$REGION"
fi

# --- 6. summary -------------------------------------------------------------
step "EKS bootstrap complete."
cat <<EOF

  Pass these to \`sos install\`:
    --cloud eks --account $ACCOUNT --region $REGION --bucket $BUCKET

  Keyless identity is wired via Pod Identity (associate these KSAs in ns $NAMESPACE):
    $KSA_TRINO, $KSA_CNPG  -> $ROLE_STORAGE  (S3 + Glue)
    $KSA_LITELLM           -> $ROLE_BEDROCK  (Bedrock invoke)
  No access keys are created or stored.

  FOOTGUNS (report §2): Bedrock access is per-model/per-region — enable each tier
  model in the Bedrock console if flagged above; newer models need us./eu.
  cross-region inference profiles (already reflected in values.eks.yaml pins).

  Next:  helm upgrade --install agentic-os charts/sovereign-agentic-os \\
           -n $NAMESPACE --create-namespace -f values.eks.yaml -f install.yaml
EOF
