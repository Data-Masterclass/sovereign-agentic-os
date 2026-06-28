#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# push-secrets.sh — write the credential VALUES from `terraform output` into
# STACKIT Secrets Manager (KV v2, Vault-API compatible). External Secrets then
# syncs them into the cluster. The stackitcloud/stackit provider has NO
# per-secret resource, so this is the bridge between terraform-generated secrets
# and Secrets Manager — kept OUT of terraform state files in git.
#
# SAFE BY DEFAULT: dry-run unless --write is given. Secrets are read from
# terraform's sensitive outputs and POSTed to the SM Vault KV endpoint using the
# writer user. Nothing is printed in --write mode.
#
# Prereqs at go-live: the SM instance URL + the writer user (terraform), and the
# `vault` CLI (or curl). Also seeds the ESO auth secret + registry dockerconfig.
#
# Usage:
#   deploy/scripts/push-secrets.sh [--write]
set -euo pipefail

WRITE=0
[[ "${1:-}" == "--write" ]] && WRITE=1

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TF="$(command -v terraform || command -v tofu)" || { echo "terraform/tofu required"; exit 1; }
command -v jq >/dev/null || { echo "jq required"; exit 1; }

OUT="$("$TF" -chdir="$ROOT/deploy/terraform" output -json)"
get() { echo "$OUT" | jq -r ".${1}.value // empty"; }

# Secrets Manager Vault endpoint (instance-specific). Confirm the exact host form
# in the STACKIT portal; the instance id comes from terraform.
SM_ID="$(get secretsmanager_instance_id)"
SM_ADDR="https://${SM_ID}.secrets-manager.eu01.stackit.cloud"
SM_USER="$(get secretsmanager_writer_username)"
SM_PASS="$(get secretsmanager_writer_password)"

# logical KV key -> property=value pairs (must match deploy/argocd/secrets/externalsecrets.yaml)
put_kv() {
  local path="$1"; shift
  if [[ $WRITE -eq 0 ]]; then
    echo "  would write secrets/$path : ${*%%=*} ..."   # keys only, never values
    return
  fi
  # Vault KV v2 write via CLI (userpass auth done once below).
  vault kv put "secrets/$path" "$@" >/dev/null
  echo "  wrote secrets/$path"
}

if [[ $WRITE -eq 1 ]]; then
  export VAULT_ADDR="$SM_ADDR"
  vault login -method=userpass username="$SM_USER" password="$SM_PASS" >/dev/null
fi

echo "==> pushing secrets to Secrets Manager ($([[ $WRITE -eq 1 ]] && echo write || echo dry-run))"
put_kv object-storage \
  access_key="$(get object_storage_access_key)" \
  secret_key="$(get object_storage_secret_key)"
put_kv postgres \
  username="$(get postgres_username)" password="$(get postgres_password)" \
  host="$(get postgres_host)" port="$(get postgres_port)"
put_kv opensearch \
  username="$(get opensearch_username)" password="$(get opensearch_password)" \
  host="$(get opensearch_host)" port="$(get opensearch_port)"
put_kv ai-model-serving \
  token="$(get model_serving_token)" base_url="$(get model_serving_base_url)"

cat <<EOF

ALSO (manual, once):
  - container-registry/dockerconfigjson : a registry pull secret (docker login ... | base64)
  - the ESO reader auth secret in-cluster:
      kubectl -n external-secrets create secret generic stackit-sm-auth \\
        --from-literal=password='<terraform output secretsmanager_eso_password>'
EOF
