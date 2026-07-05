#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# TIER-2 GUARDRAIL — run BEFORE every `helm upgrade` / stateful roll:
#   1. a fresh pg_dump of every database (ad-hoc Job from the pg-dump CronJob),
#   2. an ad-hoc Velero backup of the agentic-os namespace (fs-backup),
# and WAIT for both to complete. If either fails, DO NOT UPGRADE.
#
#   deploy/pre-upgrade-backup.sh          # both (the normal gate)
#   deploy/pre-upgrade-backup.sh --pg-only    # before Velero exists (Tier 0 days)
#
# Idempotent: every run creates uniquely-named, TTL'd resources.
# Needs: kubectl, jq; the pg-dump CronJob (chart) and Velero (deploy/velero/).

set -euo pipefail

NS=agentic-os
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export KUBECONFIG="${KUBECONFIG:-$SCRIPT_DIR/kubeconfig.yaml}"
STAMP=$(date -u +%Y%m%d-%H%M%S)

PG_ONLY=false
[ "${1:-}" = "--pg-only" ] && PG_ONLY=true

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'FATAL: %s — DO NOT UPGRADE.\n' "$*" >&2; exit 1; }

for bin in kubectl jq; do command -v "$bin" >/dev/null || die "$bin not on PATH"; done
[ -f "$KUBECONFIG" ] || die "kubeconfig not found at $KUBECONFIG"

# ---- 1. fresh pg_dump -----------------------------------------------------------
kubectl -n "$NS" get cronjob pg-dump >/dev/null 2>&1 \
  || die "cronjob/pg-dump not found — deploy the chart's backup.pgDump first"
JOB="pg-dump-pre-$STAMP"
log "running ad-hoc pg dump: job/$JOB"
kubectl -n "$NS" create job --from=cronjob/pg-dump "$JOB"
for i in $(seq 1 60); do
  complete=$(kubectl -n "$NS" get job "$JOB" -o jsonpath='{.status.conditions[?(@.type=="Complete")].status}' 2>/dev/null || true)
  failed=$(kubectl -n "$NS" get job "$JOB" -o jsonpath='{.status.conditions[?(@.type=="Failed")].status}' 2>/dev/null || true)
  [ "$complete" = "True" ] && break
  [ "$failed" = "True" ] && { kubectl -n "$NS" logs "job/$JOB" --all-containers --tail=40 || true; die "pg dump job failed"; }
  sleep 10
done
[ "$complete" = "True" ] || die "pg dump job did not complete within 10 min"
echo "pg dump complete:"
kubectl -n "$NS" logs "job/$JOB" -c upload --tail=3 || true

if $PG_ONLY; then log "PG-ONLY GATE PASSED (Velero step skipped)"; exit 0; fi

# ---- 2. ad-hoc Velero backup ------------------------------------------------------
kubectl get ns velero >/dev/null 2>&1 || die "velero not installed (deploy/velero/install.sh)"
NAME="pre-upgrade-$STAMP"
log "running ad-hoc Velero backup: $NAME"
kubectl apply -f - <<EOF
apiVersion: velero.io/v1
kind: Backup
metadata:
  name: $NAME
  namespace: velero
spec:
  includedNamespaces: ["$NS"]
  defaultVolumesToFsBackup: true
  ttl: 240h
  storageLocation: default
EOF
phase=""
for i in $(seq 1 120); do
  phase=$(kubectl -n velero get backup "$NAME" -o jsonpath='{.status.phase}' 2>/dev/null || true)
  case "$phase" in
    Completed) break ;;
    Failed|PartiallyFailed|FailedValidation)
      kubectl -n velero get backup "$NAME" -o jsonpath='{.status}' | jq . || true
      die "Velero backup ended $phase" ;;
    *) sleep 30 ;;
  esac
done
[ "$phase" = "Completed" ] || die "Velero backup did not complete in time (still: ${phase:-unknown})"

log "PRE-UPGRADE GATE PASSED"
echo "  pg dump:        job/$JOB (uploaded to s3 backups/pg/)"
echo "  velero backup:  $NAME ($(kubectl -n velero get backup "$NAME" -o jsonpath='{.status.progress.itemsBackedUp}') items)"
echo "Safe to run the helm upgrade now."
