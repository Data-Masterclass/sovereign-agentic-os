#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# =============================================================================
# priority-classes.kind.sh — WP-47: the chart's PriorityClasses on a REAL Kubernetes (kind).
# =============================================================================
#   bash scripts/tests/priority-classes.kind.sh [--keep]
#
# Needs docker, kind, kubectl and helm, and the subchart .tgz files. Creates the kind cluster
# `wp47`, deletes it on exit (unless --keep). Not run in CI (it needs a cluster); run it by hand on
# a chart change to priority-classes.yaml. It proves, against the real API server and scheduler:
#   1. the upgrade path: the classes from origin/main, then this chart's classes, apply cleanly
#      (PriorityClass `value` and `preemptionPolicy` are immutable, so a changed value would fail);
#   2. admission resolves each class to its value, and a pod with no class gets 0;
#   3. negative twins: a pod naming a missing class is rejected (why the runner omits the field
#      when the chart creates no classes), and changing a live class's value is rejected;
#   4. scheduling: a critical pod preempts a user-app pod for the node's CPU; a user-app pod
#      (preemptionPolicy Never) does NOT preempt an app pod and stays Pending.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
REPO=$PWD
. scripts/tests/assert.sh
CLUSTER=wp47
CTX=kind-$CLUSTER
KEEP=${1:-}
TMP=$(mktemp -d)
cleanup() { [ "$KEEP" = --keep ] || kind delete cluster --name "$CLUSTER" >/dev/null 2>&1; rm -rf "$TMP"; }
trap cleanup EXIT
k() { kubectl --context "$CTX" "$@"; }
render_classes() { helm template agentic-os "$1" -n agentic-os --show-only templates/base/priority-classes.yaml; }

kind create cluster --name "$CLUSTER" --wait 120s >/dev/null || { echo "kind create failed"; exit 2; }

# ---- 1. upgrade path -----------------------------------------------------------------------
mkdir -p "$TMP/main"
git archive origin/main charts/sovereign-agentic-os | tar -x -C "$TMP/main"
mkdir -p "$TMP/main/charts/sovereign-agentic-os/charts" && cp charts/sovereign-agentic-os/charts/*.tgz "$TMP/main/charts/sovereign-agentic-os/charts/"
render_classes "$TMP/main/charts/sovereign-agentic-os" > "$TMP/old.yaml"
render_classes charts/sovereign-agentic-os > "$TMP/new.yaml"
out=$(k apply -f "$TMP/old.yaml" 2>&1); check "origin/main classes apply" "created" "$out"
out=$(k apply -f "$TMP/new.yaml" 2>&1); rc=$?
check "this chart's classes apply over them (no immutable field changed)" "sovereign-os-infra configured" "$out"
[ $rc -eq 0 ] || bad "apply exit code" "exit $rc: $out"

# ---- 2. admission resolves the values -------------------------------------------------------
pod() { # pod <name> <class|""> <cpu request>
  local pc=''; [ -n "$2" ] && pc="\"priorityClassName\": \"$2\","
  cat <<JSON
{"apiVersion":"v1","kind":"Pod","metadata":{"name":"$1","namespace":"default"},
 "spec":{$pc "terminationGracePeriodSeconds":0,
  "containers":[{"name":"p","image":"registry.k8s.io/pause:3.10","resources":{"requests":{"cpu":"$3","memory":"16Mi"},"limits":{"memory":"16Mi"}}}]}}
JSON
}
prio() { pod "$1" "$2" 10m | k create --dry-run=server -o jsonpath='{.spec.priority} {.spec.preemptionPolicy}' -f - 2>&1; }
check "critical resolves to 1000000" "1000000 PreemptLowerPriority" "$(prio a sovereign-os-critical)"
check "infra resolves to 100000" "100000 PreemptLowerPriority" "$(prio b sovereign-os-infra)"
check "app resolves to 1000" "1000 PreemptLowerPriority" "$(prio c sovereign-os-app)"
check "no class resolves to 0" "0 PreemptLowerPriority" "$(prio d '')"
check "observability resolves to -10" "-10 PreemptLowerPriority" "$(prio e sovereign-os-observability)"
check "user apps resolve to -100 and never preempt" "-100 Never" "$(prio f sovereign-os-user-apps)"

# ---- 3. negative twins ----------------------------------------------------------------------
check "a pod naming a missing class is rejected" "no PriorityClass with name" "$(prio g sovereign-os-missing)"
out=$(sed 's/^value: 1000$/value: 2000/' "$TMP/new.yaml" | k apply -f - 2>&1)
check "changing a live class's value is rejected" "value: Forbidden: may not be changed in an update" "$out"

# ---- 4. scheduling: preemption ------------------------------------------------------------
ALLOC=$(k get node "$CLUSTER-control-plane" -o jsonpath='{.status.allocatable.cpu}')
case $ALLOC in *m) ALLOC=${ALLOC%m} ;; *) ALLOC=$((ALLOC * 1000)) ;; esac
USED=$(k describe node "$CLUSTER-control-plane" | awk '/Allocated resources/{f=1} f&&/^ +cpu/{print $2; exit}')
USED=${USED%m}
BIG=$(( (ALLOC - USED) * 7 / 10 ))m   # one of these fits, two do not
wait_phase() { for _ in $(seq 1 60); do p=$(k get pod "$1" -o jsonpath='{.status.phase}' 2>/dev/null); [ "$p" = "$2" ] && return 0; sleep 1; done; return 1; }
gone() { for _ in $(seq 1 60); do k get pod "$1" >/dev/null 2>&1 || return 0; sleep 1; done; return 1; }

pod user-app sovereign-os-user-apps "$BIG" | k create -f - >/dev/null
wait_phase user-app Running && ok "a user-app pod takes ${BIG} of CPU" || bad "user-app pod Running"
pod platform sovereign-os-critical "$BIG" | k create -f - >/dev/null
if wait_phase platform Running && gone user-app; then ok "a critical pod preempts the user-app pod and runs"
else bad "critical pod preempts" "$(k get pods -o wide 2>&1)"; fi

k delete pod platform --wait=true >/dev/null
pod app-tier sovereign-os-app "$BIG" | k create -f - >/dev/null
wait_phase app-tier Running || bad "app-tier pod Running"
pod late-user-app sovereign-os-user-apps "$BIG" | k create -f - >/dev/null
sleep 15
st="$(k get pod app-tier -o jsonpath='{.status.phase}') $(k get pod late-user-app -o jsonpath='{.status.phase}')"
check "a user-app pod (Never) does not preempt an app pod and stays Pending" "Running Pending" "$st"

finish priority-classes.kind
