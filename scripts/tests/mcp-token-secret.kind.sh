#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# mcp-token-secret.kind.sh — the MCP signing-key MIGRATION against a REAL API server.
# =============================================================================
#   bash scripts/tests/mcp-token-secret.kind.sh [--keep]
#   MCP_KEY_CONTEXT=kind-x bash scripts/tests/mcp-token-secret.kind.sh   # reuse a cluster
#
# os-ui-session uses `lookup`, which plain `helm template` cannot exercise, so this renders with
# `helm template --dry-run=server` against kind. It proves:
#   1. a pre-split Secret (only OS_SESSION_SECRET = OLD): the upgrade that ROTATES the session to NEW
#      renders OS_MCP_TOKEN_SECRET = OLD, so every issued MCP token stays valid;
#   2. a split Secret (MCP = M): a later session rotation keeps OS_MCP_TOKEN_SECRET = M;
#   3. negative twin: an explicit osUI.mcpTokenSecret overrides the stored value.
# Uses its own KUBECONFIG file; never touches ~/.kube/config. Only throwaway values are used.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
. scripts/tests/assert.sh
CHART=charts/sovereign-agentic-os
NS=mcp-key-test
CTX=${MCP_KEY_CONTEXT:-}
KCFG=${KUBECONFIG:-}
CREATED=""
cleanup() {
  kubectl --context "$CTX" delete ns "$NS" --wait=false >/dev/null 2>&1
  [ -n "$CREATED" ] && [ "${1:-}" != --keep ] && kind delete cluster --name mcpkey --kubeconfig "$KCFG" >/dev/null 2>&1
}
if [ -z "$CTX" ]; then
  KCFG=$(mktemp); export KUBECONFIG=$KCFG
  kind create cluster --name mcpkey --kubeconfig "$KCFG" --wait 120s >/dev/null || { echo "kind create failed"; exit 2; }
  CTX=kind-mcpkey; CREATED=1
fi
trap 'cleanup "${1:-}"' EXIT
k() { kubectl --context "$CTX" "$@"; }
k create ns "$NS" >/dev/null
render() {
  out=$(helm template t "$CHART" -n "$NS" --kube-context "$CTX" --dry-run=server --skip-schema-validation \
        --set priorityClasses.enabled=false --show-only templates/base/os-ui/os-ui-session.yaml "$@" 2>&1); rc=$?
}
live() { # $1 session, $2 mcp ("" = pre-split Secret)
  k -n "$NS" delete secret os-ui-session --ignore-not-found >/dev/null
  { cat <<YAML
apiVersion: v1
kind: Secret
metadata:
  name: os-ui-session
  labels: { app.kubernetes.io/managed-by: Helm }
  annotations: { meta.helm.sh/release-name: t, meta.helm.sh/release-namespace: $NS }
stringData:
  OS_SESSION_SECRET: "$1"
YAML
    [ -n "$2" ] && printf '  OS_MCP_TOKEN_SECRET: "%s"\n' "$2"
  } | k -n "$NS" apply -f - >/dev/null
}
OLD="old-$RANDOM$RANDOM"; NEW="new-$RANDOM$RANDOM"; M="mcp-$RANDOM$RANDOM"

echo "1. pre-split Secret, upgrade rotates the session"
live "$OLD" ""
render --set osUI.sessionSecret="$NEW"
rc_is "renders" 0
check "session rotated to NEW" "OS_SESSION_SECRET: \"$NEW\"" "$out"
check "MCP key migrated from the STORED session secret" "OS_MCP_TOKEN_SECRET: \"$OLD\"" "$out"

echo "2. split Secret, later session rotation"
live "$NEW" "$M"
render --set osUI.sessionSecret="rot-$RANDOM"
check "MCP key preserved" "OS_MCP_TOKEN_SECRET: \"$M\"" "$out"

echo "3. explicit osUI.mcpTokenSecret wins"
render --set osUI.mcpTokenSecret=explicit-mcp
check "explicit MCP key" 'OS_MCP_TOKEN_SECRET: "explicit-mcp"' "$out"
absent "twin: the stored MCP key is not used once overridden" "OS_MCP_TOKEN_SECRET: \"$M\"" "$out"

finish mcp-token-secret-kind
