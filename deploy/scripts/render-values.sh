#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# render-values.sh — fill the Mode B overlay + Argo manifests' REPLACE-… tokens
# from `terraform output`. Endpoints/registry/DNS only (NOT secrets — those go to
# Secrets Manager via push-secrets.sh). Idempotent; supports --dry-run.
#
# Usage:
#   deploy/scripts/render-values.sh [--dry-run]
# Run from anywhere; paths are resolved relative to the repo root.
set -euo pipefail

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TF_DIR="$ROOT/deploy/terraform"
OVERLAY="$ROOT/values.stackit-managed.yaml"
CSS="$ROOT/deploy/argocd/secrets/cluster-secret-store.yaml"
VELERO="$ROOT/deploy/argocd/apps/05-velero.yaml"

command -v jq >/dev/null || { echo "jq required"; exit 1; }
TF="$(command -v terraform || command -v tofu)" || { echo "terraform/tofu required"; exit 1; }

echo "==> reading terraform outputs"
OUT="$("$TF" -chdir="$TF_DIR" output -json)"
get() { echo "$OUT" | jq -r ".${1}.value // empty"; }

PG_HOST="$(get postgres_host)"
OS_HOST="$(get opensearch_host)"
MS_URL="$(get model_serving_base_url)"
REGISTRY="$(get container_registry_url)"
DNS_NAME="$(get dns_name)"
SM_ID="$(get secretsmanager_instance_id)"
ESO_USER="$(get secretsmanager_eso_username)"   # sensitive — only the username
VELERO_BUCKET="$(echo "$OUT" | jq -r '.object_storage_buckets.value.velero // empty')"

# token -> value -> file(s)
declare -a SUBS=(
  "REPLACE-postgres-flex-host|$PG_HOST|$OVERLAY"
  "REPLACE-opensearch-host|$OS_HOST|$OVERLAY"
  "REPLACE-model-serving-base-url|$MS_URL|$OVERLAY"
  "REPLACE-REGISTRY|$REGISTRY|$OVERLAY"
  "REPLACE-DNS-NAME|$DNS_NAME|$OVERLAY"
  "REPLACE-sm-instance-id|$SM_ID|$CSS"
  "REPLACE-eso-username|$ESO_USER|$CSS"
  "REPLACE-velero-bucket|$VELERO_BUCKET|$VELERO"
)

apply_sub() {
  local token="$1" value="$2" file="$3"
  [[ -z "$value" ]] && { echo "  SKIP $token (no output)"; return; }
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "  would set $token -> $value  ($(basename "$file"))"
  else
    # `|` delimiter; values may contain / and : but not |.
    sed -i.bak "s|$token|$value|g" "$file" && rm -f "$file.bak"
    echo "  set $token -> $value  ($(basename "$file"))"
  fi
}

echo "==> rendering ($([[ $DRY_RUN -eq 1 ]] && echo dry-run || echo write))"
for s in "${SUBS[@]}"; do
  IFS='|' read -r token value file <<<"$s"
  apply_sub "$token" "$value" "$file"
done

cat <<EOF

NOTE: still TODO by a human / publish-images.sh:
  - REPLACE-chat-model-id / REPLACE-embed-model-id  (pick from \`stackit ai-model-serving models\`)
  - REPLACE-*-DIGEST                                 (run: deploy/scripts/publish-images.sh --push)
Secrets (passwords/keys/token) go to Secrets Manager — see push-secrets.sh.
EOF
