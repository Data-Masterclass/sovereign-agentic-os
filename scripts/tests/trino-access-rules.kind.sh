#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# trino-access-rules.kind.sh — one owner for `trino-access-rules` under Helm 4 server-side apply.
# =============================================================================
#   bash scripts/tests/trino-access-rules.kind.sh [--keep]
#   RULES_CONTEXT=kind-x bash scripts/tests/trino-access-rules.kind.sh   # reuse a cluster
#
# os-ui overwrites `.data.rules.json` at runtime (core/infra/trino-rules-server.ts, a JSON merge PATCH
# = an Update by another field manager). With Helm 4 every later `helm upgrade` failed on a field
# conflict on that key unless --force-conflicts, which also reset the rules to the permissive
# bootstrap. The chart now renders the OS's live rules back (`lookup`) once the OS has stamped them.
# Against a real API server with a real Helm 4, using the chart's REAL templates/_helpers.tpl,
# _eso.tpl and lakehouse/trino.yaml in a stub chart (nothing else of the chart is installed):
#   1. install, the "OS" writes its rules, upgrade WITHOUT --force-conflicts: succeeds, rules kept;
#   2. before the OS has written anything, a values change still updates the bootstrap (the chart
#      owns it until then);
#   3. RED twin: the same flow with public/main's trino.yaml (no lookup) fails with the conflict.
# Uses its own KUBECONFIG file; never touches ~/.kube/config.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
. scripts/tests/assert.sh
helm version --short | grep -q '^v[4-9]' || { echo "needs Helm >= 4 (server-side apply): $(helm version --short)"; exit 2; }
CHART=charts/sovereign-agentic-os
NS=rules-test
CTX=${RULES_CONTEXT:-}
KCFG=${KUBECONFIG:-}
CREATED=""
T=$(mktemp -d)
cleanup() {
  kubectl --context "$CTX" delete ns "$NS" "$NS-red" --wait=false >/dev/null 2>&1
  [ -n "$CREATED" ] && [ "${1:-}" != --keep ] && kind delete cluster --name rules --kubeconfig "$KCFG" >/dev/null 2>&1
  rm -rf "$T"
}
if [ -z "$CTX" ]; then
  KCFG=$(mktemp); export KUBECONFIG=$KCFG
  kind create cluster --name rules --kubeconfig "$KCFG" --wait 120s >/dev/null || { echo "kind create failed"; exit 2; }
  CTX=kind-rules; CREATED=1
fi
trap 'cleanup "${1:-}"' EXIT
k() { kubectl --context "$CTX" "$@"; }

stub() { # stub <dir> <trino.yaml source>
  mkdir -p "$1/templates/base/external-secrets" "$1/templates/extensions/lakehouse"
  sed '/^dependencies:/,$d' "$CHART/Chart.yaml" > "$1/Chart.yaml"
  cp "$CHART/values.yaml" "$1/values.yaml"
  cp "$CHART/templates/base/_helpers.tpl" "$1/templates/base/"
  cp "$CHART/templates/base/external-secrets/_eso.tpl" "$1/templates/base/external-secrets/"
  cp "$2" "$1/templates/extensions/lakehouse/trino.yaml"
}
stub "$T/new" "$CHART/templates/extensions/lakehouse/trino.yaml"
git show public/main:charts/sovereign-agentic-os/templates/extensions/lakehouse/trino.yaml > "$T/main-trino.yaml" 2>/dev/null \
  || git show origin/main:charts/sovereign-agentic-os/templates/extensions/lakehouse/trino.yaml > "$T/main-trino.yaml"
stub "$T/red" "$T/main-trino.yaml"
# Nothing here needs to run; no pod is waited for.
SETS=(--set priorityClasses.enabled=false --skip-schema-validation)
OS_RULES='{"catalogs":[{"allow":"all"}],"schemas":[{"user":"os-written-'$RANDOM'","owner":true}]}'
os_writes() { # the OS's reconciler: JSON merge PATCH of the data key + its stamp (another field manager)
  local sha; sha=$(printf %s "$OS_RULES" | shasum -a 256 | cut -d' ' -f1)
  k -n "$1" patch configmap trino-access-rules --type merge --field-manager os-ui \
    -p "$(python3 -c 'import json,sys; print(json.dumps({"metadata":{"annotations":{"os.sovereign/rules-sha256":sys.argv[2]}},"data":{"rules.json":sys.argv[1]}}))' "$OS_RULES" "$sha")" >/dev/null
}
rules() { k -n "$1" get configmap trino-access-rules -o jsonpath='{.data.rules\.json}'; }
helmx() { out=$(helm --kube-context "$CTX" "$@" "${SETS[@]}" 2>&1); rc=$?; }

echo "1. the OS writes its rules; a plain helm upgrade keeps them"
k create ns "$NS" >/dev/null
helmx install t "$T/new" -n "$NS"
rc_is "install" 0
check "  the bootstrap is rendered on a fresh install" '"owner": true' "$(rules "$NS")"
echo "2. before the OS writes, the chart still owns the bootstrap"
helmx upgrade t "$T/new" -n "$NS" --set trino.accessControl.serviceUser=svc-renamed
rc_is "  upgrade with a changed service user" 0
check "  the bootstrap follows the values" '^svc-renamed$' "$(rules "$NS")"
os_writes "$NS"
check "  (the OS's rules are live)" "$OS_RULES" "$(rules "$NS")"
helmx upgrade t "$T/new" -n "$NS"
rc_is "  helm upgrade WITHOUT --force-conflicts succeeds" 0
absent "  no field conflict" "conflict" "$out"
check "  the OS's rules survive the upgrade (no reset to the bootstrap)" "$OS_RULES" "$(rules "$NS")"
helmx upgrade t "$T/new" -n "$NS" --server-side=true
rc_is "  explicitly server-side: succeeds" 0
check "  rules still the OS's" "$OS_RULES" "$(rules "$NS")"
mf=$(k -n "$NS" get configmap trino-access-rules --show-managed-fields -o jsonpath='{range .metadata.managedFields[*]}{.manager}:{.operation} {end}')
check "  Helm applied with server-side apply" "helm:Apply" "$mf"

echo "3. RED twin: public/main's template (no lookup)"
k create ns "$NS-red" >/dev/null
helmx install t "$T/red" -n "$NS-red"
rc_is "  install" 0
os_writes "$NS-red"
helmx upgrade t "$T/red" -n "$NS-red"
rc_is "  helm upgrade fails" 1
check "  on the rules.json field conflict" "rules.json" "$out"
finish trino-access-rules-kind
