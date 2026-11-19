#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# litellm-premigrate.sh [--dry-run] — run the LiteLLM database migration of the chart in THIS
# checkout against a live cluster BEFORE the gateway itself is upgraded.
#
# WHY. The chart upgrades the proxy Deployment and creates the migration Job in the same
# `helm upgrade`. Nothing orders them: a new proxy pod that starts before the Job has finished
# reports Ready on the old schema and then refuses every call ("column … does not exist", as a
# 401) — measured for 1.90.0 -> 1.108.12, see docs/ops/litellm-upgrade.md. The new schema, on
# the other hand, is one the OLD proxy runs on without error (measured too). So: migrate first,
# with the old proxy still serving, then deploy.
#
# WHAT IT DOES. Renders the chart's OWN migration Job (the litellm-helm subchart's
# migrations-job.yaml: same image, same command, same database env) from this checkout with the
# LIVE release's values, gives it a distinct name, applies it, waits for it, prints its log.
# It creates one Job in the release namespace and changes nothing else. Run
# deploy/pre-upgrade-backup.sh FIRST — a migration is the one step an image rollback does not undo.
#
#   deploy/pre-upgrade-backup.sh
#   deploy/litellm-premigrate.sh --dry-run     # shows the Job that would be created
#   deploy/litellm-premigrate.sh
#   ./scripts/deploy.sh --from-registry <version>
#
# Environment: KUBE_CONTEXT (dmagenticos) NS (agentic-os) REL (agentic-os) TIMEOUT (45m)
set -euo pipefail
cd "$(dirname "$0")/.."
DRY=; [ "${1:-}" = "--dry-run" ] && DRY=1
CTX=${KUBE_CONTEXT:-dmagenticos}; NS=${NS:-agentic-os}; REL=${REL:-agentic-os}; TIMEOUT=${TIMEOUT:-45m}
CHART=charts/sovereign-agentic-os
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT

ls "$CHART"/charts/litellm-helm-*.tgz >/dev/null 2>&1 || { echo "run: helm dependency build $CHART" >&2; exit 2; }
helm --kube-context "$CTX" get values "$REL" -n "$NS" -o yaml > "$WORK/live.yaml"
helm template "$REL" "$CHART" -n "$NS" -f "$WORK/live.yaml" --skip-schema-validation \
  -s charts/litellm/templates/migrations-job.yaml > "$WORK/job.yaml"

IMAGE=$(awk '/^ *image:/{gsub(/["'"'"']/,"",$2); print $2; exit}' "$WORK/job.yaml")
TAG=$(printf '%s' "${IMAGE%%@*}" | sed -E 's/.*://' | tr -c 'a-zA-Z0-9\n' '-' | tr 'A-Z' 'a-z')
NAME="litellm-premigrate-$TAG"
sed -E "s/^(  name: )${REL}-litellm-migrations\$/\1${NAME}/" "$WORK/job.yaml" | grep -v 'ttlSecondsAfterFinished' > "$WORK/apply.yaml"
grep -q "name: ${NAME}\$" "$WORK/apply.yaml" || { echo "could not name the Job (the subchart's template changed?)" >&2; exit 2; }

echo "==> context $CTX / namespace $NS / release $REL"
echo "==> Job $NAME"
echo "    image:   $IMAGE"
echo "    command: $(grep -A0 'command:' "$WORK/apply.yaml" | head -1 | sed 's/^ *//')"
echo "    database host: $(awk '/name: DATABASE_HOST/{getline; print $2; exit}' "$WORK/apply.yaml")   name: $(awk '/name: DATABASE_NAME/{getline; print $2; exit}' "$WORK/apply.yaml")"
echo "    running now:   $(kubectl --context "$CTX" -n "$NS" get deploy "${REL}-litellm" -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || echo '?')"
if [ -n "$DRY" ]; then
  echo "==> --dry-run: nothing applied. The manifest (credentials are Secret references, not values):"
  cat "$WORK/apply.yaml"
  exit 0
fi

kubectl --context "$CTX" -n "$NS" delete job "$NAME" --ignore-not-found >/dev/null
kubectl --context "$CTX" -n "$NS" apply -f "$WORK/apply.yaml"
echo "==> waiting up to $TIMEOUT (index builds on a large spend log take time; the old proxy keeps serving)"
if ! kubectl --context "$CTX" -n "$NS" wait --for=condition=complete "job/$NAME" --timeout="$TIMEOUT"; then
  kubectl --context "$CTX" -n "$NS" logs "job/$NAME" --tail=60 || true
  echo "PREMIGRATE_FAILED — the gateway was NOT upgraded and is still serving on its old image. Read the log above; do not deploy until this passes." >&2
  exit 1
fi
kubectl --context "$CTX" -n "$NS" logs "job/$NAME" --tail=15
echo "PREMIGRATE_OK $IMAGE — now run ./scripts/deploy.sh (the chart's own migration Job will find nothing left to do). Delete the Job when you like: kubectl -n $NS delete job $NAME"
