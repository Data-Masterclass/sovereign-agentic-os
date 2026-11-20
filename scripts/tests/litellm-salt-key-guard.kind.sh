#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# litellm-salt-key-guard.kind.sh — the LITELLM_SALT_KEY change guard against a REAL API server.
# =============================================================================
#   bash scripts/tests/litellm-salt-key-guard.kind.sh [--keep]
#   SALT_GUARD_CONTEXT=kind-x bash scripts/tests/litellm-salt-key-guard.kind.sh   # reuse a cluster
#
# The guard uses `lookup`, which `helm template` without a cluster cannot exercise, so this renders
# with `helm template --dry-run=server` (lookup on) against kind. Cluster-scoped PriorityClasses are
# left out so the test also runs on a cluster that already holds a release. It proves:
#   1. no live salt key yet: setting one renders (the first set is allowed);
#   2. live salt key = the value passed: renders;
#   3. negative twins: a DIFFERENT value fails with LITELLM_SALT_KEY_CHANGE_REFUSED, and so does
#      an empty value (removal); neither message contains either value;
#   4. litellmSaltKey.allowChange=true lets the rollback / re-key through.
# Without SALT_GUARD_CONTEXT it creates the kind cluster `saltguard` and deletes it on exit
# (unless --keep). Not run in CI (it needs a cluster). Only throwaway values are used.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
. scripts/tests/assert.sh
CHART=charts/sovereign-agentic-os
NS=salt-guard-test
CTX=${SALT_GUARD_CONTEXT:-}
CREATED=""
cleanup() {
  kubectl --context "$CTX" delete ns "$NS" --wait=false >/dev/null 2>&1
  [ -n "$CREATED" ] && [ "${1:-}" != --keep ] && kind delete cluster --name saltguard >/dev/null 2>&1
}
if [ -z "$CTX" ]; then
  kind create cluster --name saltguard --wait 120s >/dev/null || { echo "kind create failed"; exit 2; }
  CTX=kind-saltguard; CREATED=1
fi
trap 'cleanup "${1:-}"' EXIT
k() { kubectl --context "$CTX" "$@"; }
k create ns "$NS" >/dev/null
A="salt-a-$RANDOM$RANDOM"; B="salt-b-$RANDOM$RANDOM"
render() {
  out=$(helm template t "$CHART" -n "$NS" --kube-context "$CTX" --dry-run=server --skip-schema-validation \
        --set priorityClasses.enabled=false --show-only templates/base/litellm/credentials.yaml "$@" 2>&1); rc=$?
}
live() { # $1: salt value or "" — a Helm-owned litellm-credentials, as the chart's own Secret is live
  k -n "$NS" delete secret litellm-credentials --ignore-not-found >/dev/null
  { cat <<YAML
apiVersion: v1
kind: Secret
metadata:
  name: litellm-credentials
  labels: { app.kubernetes.io/managed-by: Helm }
  annotations: { meta.helm.sh/release-name: t, meta.helm.sh/release-namespace: $NS }
stringData:
  masterkey: m
YAML
    [ -n "$1" ] && printf '  LITELLM_SALT_KEY: "%s"\n' "$1"
  } | k -n "$NS" apply -f - >/dev/null
}

echo "1. live Secret without a salt key"
live ""
render --set "litellmSaltKey.value=$A"; rc_is "first set renders" 0
check "  ... with the key" "LITELLM_SALT_KEY" "$out"

echo "2. live salt key = the value passed"
live "$A"
render --set "litellmSaltKey.value=$A"; rc_is "same value renders" 0

echo "3. negative twins"
render --set "litellmSaltKey.value=$B"; rc_is "a different value fails" 1
check "  ... with the refusal code" "LITELLM_SALT_KEY_CHANGE_REFUSED" "$out"
absent "  ... without the old value" "$A" "$out"
absent "  ... without the new value" "$B" "$out"
render; rc_is "no value (removal) fails" 1
check "  ... with the refusal code" "LITELLM_SALT_KEY_CHANGE_REFUSED" "$out"
absent "  ... without the old value" "$A" "$out"

echo "4. explicit rollback"
render --set "litellmSaltKey.value=$B" --set litellmSaltKey.allowChange=true; rc_is "allowChange=true renders a change" 0
render --set litellmSaltKey.allowChange=true; rc_is "allowChange=true renders a removal" 0
absent "  ... and the removal drops the key" "LITELLM_SALT_KEY" "$out"

finish litellm-salt-key-guard
