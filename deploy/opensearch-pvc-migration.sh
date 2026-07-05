#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# TIER-0 MIGRATION — move the opensearch-master StatefulSet onto a PVC.
#
# WHY: the live STS runs with NO data volume (indices sit on the container's
# writable layer — one container restart wipes them), while the chart values
# (values.stackit-selfhosted.yaml) already say persistence.enabled=true. A PVC
# cannot be added to a live StatefulSet in place, so this script:
#
#   1. EXPORTS every restorable index (settings + mappings + aliases + all docs
#      via _search) to a local backup dir, verifying doc counts;
#   2. RENDERS the STS from the chart (with the PVC template) and asserts the
#      render is what we expect;
#   3. after an explicit typed confirmation, DELETES the STS (+pod) and APPLIES
#      the rendered STS — the pod comes back on a fresh PVC;
#   4. RESTORES the exported indices and VERIFIES doc counts match the export.
#
# DATA-LOSS WINDOW (honest): writes to OpenSearch between the export (step 1)
# and the restore (step 4) are LOST — typically 2–5 minutes. While the pod is
# down (~1–2 min) os-ui mirror writes fail; after the parallel mirror fix the
# os-ui stores re-mirror on their NEXT write, so an in-process write made
# during the window re-appears in OpenSearch the next time that store is
# touched — but is lost if the os-ui pod restarts first. Deliberately skipped
# (rebuildable) and NOT restored: OpenMetadata search indices (`*_rebuild_*`
# + dot-indices — re-run OpenMetadata's Search Indexing app afterwards) and
# `top_queries-*` query-insights history.
#
# Idempotent: re-runnable; each phase checks state before acting. Abort-safe:
# set -e everywhere, and the export stays on disk for manual replay if a later
# step dies (restore can be re-run standalone: --restore-only <backup-dir>).
#
# Usage:  deploy/opensearch-pvc-migration.sh [--yes] [--restore-only <dir>]
# Needs:  kubectl, helm, jq, KUBECONFIG (defaults to deploy/kubeconfig.yaml).

set -euo pipefail

NS=agentic-os
STS=opensearch-master
POD=opensearch-master-0
PVC="opensearch-master-${POD}"
MAX_DOCS=10000   # _search export cap; abort above (switch to snapshot API then)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export KUBECONFIG="${KUBECONFIG:-$SCRIPT_DIR/kubeconfig.yaml}"

YES=false
RESTORE_ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) YES=true; shift ;;
    --restore-only) RESTORE_ONLY="$2"; shift 2 ;;
    *) echo "unknown arg: $1"; exit 2 ;;
  esac
done

log()  { printf '\n==> %s\n' "$*"; }
die()  { printf 'FATAL: %s\n' "$*" >&2; exit 1; }

# All OpenSearch API calls go through curl INSIDE the pod (no auth, plain HTTP,
# security plugin disabled) — no port-forward to babysit.
es() { # es <path> [curl args...]
  kubectl -n "$NS" exec -i -c opensearch "$POD" -- \
    curl -sS --fail-with-body "http://localhost:9200$1" "${@:2}"
}

wait_ready() {
  log "waiting for $POD Ready + cluster health >= yellow"
  kubectl -n "$NS" wait --for=condition=Ready "pod/$POD" --timeout=300s
  for i in $(seq 1 60); do
    status=$(es "/_cluster/health" 2>/dev/null | jq -r .status || echo unknown)
    [ "$status" = "green" ] || [ "$status" = "yellow" ] && { echo "cluster health: $status"; return 0; }
    sleep 5
  done
  die "cluster did not reach yellow/green"
}

# ---- preflight ---------------------------------------------------------------
for bin in kubectl helm jq; do command -v "$bin" >/dev/null || die "$bin not on PATH"; done
[ -f "$KUBECONFIG" ] || die "kubeconfig not found at $KUBECONFIG"
kubectl -n "$NS" get sts "$STS" >/dev/null || die "sts/$STS not found in ns $NS"

# ---- restorable index list (dynamic; self-updating as os-* mirrors grow) -----
list_indices() {
  es "/_cat/indices?h=index,docs.count" \
    | awk '$1 !~ /^\./ && $1 !~ /^top_queries-/ && $1 !~ /_rebuild_/ {print $1, $2}'
}

export_indices() { # export_indices <dir>
  local dir="$1"; mkdir -p "$dir"
  log "exporting restorable indices to $dir"
  list_indices > "$dir/manifest.txt"
  [ -s "$dir/manifest.txt" ] || die "no restorable indices found — nothing to migrate?"
  cat "$dir/manifest.txt"
  # read from fd 3: `kubectl exec -i` in the loop body would eat the manifest on fd 0.
  while read -u 3 -r idx count; do
    [ "$count" -le "$MAX_DOCS" ] || die "$idx has $count docs (> $MAX_DOCS) — raise MAX_DOCS / use snapshot API"
    es "/$idx/_settings"  > "$dir/$idx.settings.json"
    es "/$idx/_mapping"   > "$dir/$idx.mapping.json"
    es "/$idx/_alias"     > "$dir/$idx.alias.json"
    es "/$idx/_search?size=$MAX_DOCS" > "$dir/$idx.docs.json"
    local got
    got=$(jq '.hits.hits | length' "$dir/$idx.docs.json")
    [ "$got" -eq "$count" ] || die "export mismatch for $idx: exported $got, index reports $count"
    echo "  exported $idx ($got docs)"
  done 3< "$dir/manifest.txt"
  log "export complete + verified ($(wc -l < "$dir/manifest.txt") indices)"
}

restore_indices() { # restore_indices <dir>
  local dir="$1"
  [ -s "$dir/manifest.txt" ] || die "no manifest in $dir"
  log "restoring indices from $dir"
  # fd 3 again: the exec/stdin piping in the body must not eat the manifest.
  while read -u 3 -r idx count; do
    # Build create body: filtered settings + mappings + aliases.
    jq -s --arg idx "$idx" '{
        settings: { index: (.[0][$idx].settings.index
                    | del(.creation_date, .uuid, .version, .provided_name)) },
        mappings: .[1][$idx].mappings,
        aliases:  (.[2][$idx].aliases // {})
      }' "$dir/$idx.settings.json" "$dir/$idx.mapping.json" "$dir/$idx.alias.json" \
      > "$dir/$idx.create.json"
    if es "/$idx" -o /dev/null 2>/dev/null; then
      echo "  index $idx already exists — skipping create"
    else
      es "/$idx" -XPUT -H 'Content-Type: application/json' --data-binary @- \
        < "$dir/$idx.create.json" | jq -e '.acknowledged == true' >/dev/null \
        || die "failed to create $idx"
    fi
    if [ "$count" -gt 0 ]; then
      jq -c '.hits.hits[] | {index:{_index:._index,_id:._id}}, ._source' \
        "$dir/$idx.docs.json" > "$dir/$idx.bulk.ndjson"
      es "/_bulk" -XPOST -H 'Content-Type: application/x-ndjson' --data-binary @- \
        < "$dir/$idx.bulk.ndjson" | jq -e '.errors == false' >/dev/null \
        || die "bulk restore reported errors for $idx"
    fi
    es "/$idx/_refresh" -XPOST >/dev/null
    local got
    got=$(es "/$idx/_count" | jq .count)
    [ "$got" -eq "$count" ] || die "restore mismatch for $idx: restored $got, expected $count"
    echo "  restored $idx ($got docs, verified)"
  done 3< "$dir/manifest.txt"
  log "restore complete — every index verified against the export manifest"
}

# ---- restore-only mode (replay after a partial run) ---------------------------
if [ -n "$RESTORE_ONLY" ]; then
  wait_ready
  restore_indices "$RESTORE_ONLY"
  exit 0
fi

# ---- 1. export ----------------------------------------------------------------
kubectl -n "$NS" wait --for=condition=Ready "pod/$POD" --timeout=60s >/dev/null \
  || die "$POD not Ready — do not migrate from a broken pod"
BACKUP_DIR="$REPO_ROOT/.opensearch-migration/$(date -u +%Y-%m-%dT%H-%M-%SZ)"
export_indices "$BACKUP_DIR"

# ---- 2. render the STS WITH the PVC template ----------------------------------
log "rendering opensearch STS from the chart (persistence.enabled=true)"
[ -d "$REPO_ROOT/charts/sovereign-agentic-os/charts" ] \
  || helm dependency build "$REPO_ROOT/charts/sovereign-agentic-os" >/dev/null
EXTRA_VALUES=()
[ -f "$SCRIPT_DIR/values.stackit-deploy.yaml" ] \
  && EXTRA_VALUES=(-f "$SCRIPT_DIR/values.stackit-deploy.yaml")
RENDERED="$BACKUP_DIR/opensearch-sts.rendered.yaml"
# ${arr[@]+...} guard: macOS bash 3.2 + set -u dies on empty-array expansion.
helm template agentic-os "$REPO_ROOT/charts/sovereign-agentic-os" -n "$NS" \
  -f "$REPO_ROOT/values.selfcontained.yaml" \
  -f "$REPO_ROOT/values.stackit-selfhosted.yaml" \
  ${EXTRA_VALUES[@]+"${EXTRA_VALUES[@]}"} \
  --set global.profile=local \
  --set 'global.imagePullSecrets[0].name=registry-pull-secret' \
  --show-only charts/opensearch/templates/statefulset.yaml > "$RENDERED"
grep -q "volumeClaimTemplates" "$RENDERED" || die "render has NO volumeClaimTemplates — check values"
grep -q "mountPath: /usr/share/opensearch/data" "$RENDERED" || die "render missing data mount"
grep -q "name: $STS" "$RENDERED" || die "render is not sts/$STS"
echo "render OK: $RENDERED"

# ---- 3. confirm, then delete + recreate ---------------------------------------
log "READY TO MIGRATE. Export: $BACKUP_DIR"
echo "  - sts/$STS + pod will be DELETED and recreated on a fresh PVC ($PVC)"
echo "  - OpenSearch is DOWN ~1-2 min; os-ui mirror writes fail during that window"
echo "  - writes since the export just taken are LOST (see header)"
if [ "$YES" != true ]; then
  read -r -p "Type MIGRATE to proceed: " answer
  [ "$answer" = "MIGRATE" ] || die "aborted by user (export kept at $BACKUP_DIR)"
fi

log "deleting sts/$STS (cascade: pod goes too)"
kubectl -n "$NS" delete sts "$STS" --timeout=180s
kubectl -n "$NS" wait --for=delete "pod/$POD" --timeout=180s || true

log "applying rendered STS"
kubectl -n "$NS" apply -f "$RENDERED"
wait_ready

# Verify the pod really is on the PVC now.
kubectl -n "$NS" get pvc "$PVC" >/dev/null || die "expected PVC $PVC not created"
kubectl -n "$NS" get pod "$POD" -o json \
  | jq -e --arg pvc "$PVC" '.spec.volumes[] | select(.persistentVolumeClaim.claimName == $pvc)' >/dev/null \
  || die "pod is NOT mounting $PVC"
log "pod is running on PVC $PVC ($(kubectl -n "$NS" get pvc "$PVC" -o jsonpath='{.status.phase} {.status.capacity.storage}'))"

# ---- 4. restore + verify -------------------------------------------------------
restore_indices "$BACKUP_DIR"

log "MIGRATION COMPLETE"
echo "  - export retained at: $BACKUP_DIR (keep until you trust the new PVC)"
echo "  - OpenMetadata search: re-run its 'Search Indexing' app (indices were rebuilt-type, not restored)"
echo "  - verify os-ui Approvals/Audit tabs show their data"
