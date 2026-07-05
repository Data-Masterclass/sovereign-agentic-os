#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# TIER-1 — install Velero against the STACKIT backup bucket and verify it
# end-to-end (BSL Available + one real ad-hoc backup Completed).
#
# Prereqs (run once, by you):
#   tofu -chdir=deploy/terraform apply \
#     -var enable_managed_backends=false \
#     -target=stackit_objectstorage_bucket.backup \
#     -target=stackit_objectstorage_credentials_group.backup \
#     -target=stackit_objectstorage_credential.backup
#
# Idempotent: helm upgrade --install + kubectl apply semantics throughout.
# Needs: kubectl, helm, tofu (or terraform), jq.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
export KUBECONFIG="${KUBECONFIG:-$DEPLOY_DIR/kubeconfig.yaml}"
TF="$(command -v tofu || command -v terraform)"

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'FATAL: %s\n' "$*" >&2; exit 1; }

for bin in kubectl helm jq; do command -v "$bin" >/dev/null || die "$bin not on PATH"; done
[ -n "$TF" ] || die "tofu/terraform not on PATH"
[ -f "$KUBECONFIG" ] || die "kubeconfig not found at $KUBECONFIG"

# ---- 1. read the backup target from terraform ---------------------------------
log "reading backup bucket + credentials from terraform outputs"
BUCKET=$("$TF" -chdir="$DEPLOY_DIR/terraform" output -raw backup_bucket_name)
ENDPOINT=$("$TF" -chdir="$DEPLOY_DIR/terraform" output -raw backup_s3_endpoint)
ACCESS_KEY=$("$TF" -chdir="$DEPLOY_DIR/terraform" output -raw backup_access_key)
SECRET_KEY=$("$TF" -chdir="$DEPLOY_DIR/terraform" output -raw backup_secret_key)
[ -n "$BUCKET" ] && [ -n "$ENDPOINT" ] && [ -n "$ACCESS_KEY" ] && [ -n "$SECRET_KEY" ] \
  || die "terraform outputs missing — did the targeted apply for backup.tf run?"
echo "bucket=$BUCKET endpoint=$ENDPOINT"

# ---- 2. namespace + credentials Secret ----------------------------------------
log "creating velero namespace + credentials Secret"
kubectl create namespace velero --dry-run=client -o yaml | kubectl apply -f -
kubectl -n velero create secret generic velero-credentials \
  --from-literal=cloud="[default]
aws_access_key_id=$ACCESS_KEY
aws_secret_access_key=$SECRET_KEY" \
  --dry-run=client -o yaml | kubectl apply -f -

# ---- 3. helm install (pinned 8.1.0, matches deploy/argocd/apps/05-velero.yaml) -
log "installing velero chart"
helm repo add vmware-tanzu https://vmware-tanzu.github.io/helm-charts >/dev/null
helm repo update vmware-tanzu >/dev/null
helm upgrade --install velero vmware-tanzu/velero \
  -n velero --version 8.1.0 \
  -f "$SCRIPT_DIR/values.yaml" \
  --set-string "configuration.backupStorageLocation[0].name=default" \
  --set-string "configuration.backupStorageLocation[0].provider=aws" \
  --set-string "configuration.backupStorageLocation[0].bucket=$BUCKET" \
  --set-string "configuration.backupStorageLocation[0].config.region=eu01" \
  --set-string "configuration.backupStorageLocation[0].config.s3ForcePathStyle=true" \
  --set-string "configuration.backupStorageLocation[0].config.s3Url=$ENDPOINT" \
  --wait --timeout 5m

kubectl -n velero rollout status deploy/velero --timeout=300s
kubectl -n velero rollout status ds/node-agent --timeout=300s

# ---- 4. verify the BackupStorageLocation is reachable --------------------------
log "waiting for BackupStorageLocation 'default' to become Available"
ok=false
for i in $(seq 1 30); do
  phase=$(kubectl -n velero get backupstoragelocation default \
          -o jsonpath='{.status.phase}' 2>/dev/null || true)
  [ "$phase" = "Available" ] && { ok=true; break; }
  sleep 10
done
$ok || die "BSL never became Available — check bucket/credentials (kubectl -n velero logs deploy/velero)"
echo "BSL default: Available"

# ---- 5. first real backup, end-to-end ------------------------------------------
STAMP=$(date -u +%Y%m%d-%H%M%S)
NAME="install-verify-$STAMP"
log "running first ad-hoc backup: $NAME"
kubectl apply -f - <<EOF
apiVersion: velero.io/v1
kind: Backup
metadata:
  name: $NAME
  namespace: velero
spec:
  includedNamespaces: ["agentic-os"]
  defaultVolumesToFsBackup: true
  ttl: 240h
  storageLocation: default
EOF
for i in $(seq 1 120); do   # up to 60 min — first kopia upload of ~30Gi takes a while
  phase=$(kubectl -n velero get backup "$NAME" -o jsonpath='{.status.phase}' 2>/dev/null || true)
  case "$phase" in
    Completed) break ;;
    Failed|PartiallyFailed|FailedValidation)
      kubectl -n velero get backup "$NAME" -o jsonpath='{.status}' | jq . || true
      die "backup $NAME ended $phase" ;;
    *) sleep 30 ;;
  esac
done
[ "$phase" = "Completed" ] || die "backup $NAME did not complete in time (still: ${phase:-unknown})"

log "VELERO INSTALL VERIFIED"
kubectl -n velero get backup "$NAME" -o jsonpath='{.status.progress}' && echo
echo "  - daily schedule 'velero-daily-agentic-os' (03:00 UTC, 30d retention) is active:"
kubectl -n velero get schedule
echo "  - NOTE: pods rolled BEFORE the next helm upgrade still lack the exclude"
echo "    annotations (pg data / model volumes) — those volumes are included until"
echo "    the chart converges; wasteful but safe."
