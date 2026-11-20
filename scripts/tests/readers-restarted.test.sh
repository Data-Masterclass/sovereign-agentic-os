#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# readers-restarted.test.sh — scripts/lib/readers-restarted.py (rotate-secrets.sh verify).
# =============================================================================
#   bash scripts/tests/readers-restarted.test.sh
#
# Fixtures shaped like `kubectl get … -o json`. PASS only for a finished rollout whose every pod is
# Ready, of the current ReplicaSet and started after the deploy — the case seen on production: the
# gateway's one pod after the deploy, plus a Succeeded migration-Job pod with the same label from
# before it (no reader, ignored). Negative twins, each must FAIL: a missing Deployment; the
# controller behind (observedGeneration); mid-rollout (new pod not Ready, old ReplicaSet's pod still
# Running); a crash-looping pod (Running, not Ready); a Pending new pod while the old serves; an old
# pod Terminating; no current ReplicaSet; a Ready pod from before the deploy. SKIP only at 0 replicas.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
. scripts/tests/assert.sh
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
RR=scripts/lib/readers-restarted.py
DEPLOYED=2026-11-20T15:40:00.123+01:00          # helm's last_deployed (local offset) = 14:40Z
AFTER=2026-11-20T14:45:00Z; BEFORE=2026-11-20T11:20:00Z

# dep <spec.replicas> <generation> <observedGeneration> <replicas> <updated> <ready> <available>
dep() { printf '{"metadata":{"name":"agentic-os-litellm","uid":"dep-1","generation":%s,"annotations":{"deployment.kubernetes.io/revision":"7"}},"spec":{"replicas":%s},"status":{"observedGeneration":%s,"replicas":%s,"updatedReplicas":%s,"readyReplicas":%s,"availableReplicas":%s}}' "$2" "$1" "$3" "$4" "$5" "$6" "$7"; }
RS_BOTH='{"items":[{"metadata":{"name":"rs-new","uid":"rs-new","annotations":{"deployment.kubernetes.io/revision":"7"},"ownerReferences":[{"kind":"Deployment","uid":"dep-1"}]}},{"metadata":{"name":"rs-old","uid":"rs-old","annotations":{"deployment.kubernetes.io/revision":"6"},"ownerReferences":[{"kind":"Deployment","uid":"dep-1"}]}}]}'
RS_OLD_ONLY='{"items":[{"metadata":{"name":"rs-old","uid":"rs-old","annotations":{"deployment.kubernetes.io/revision":"6"},"ownerReferences":[{"kind":"Deployment","uid":"dep-1"}]}}]}'
# pod <name> <phase> <start> <ownerKind> <ownerUid> <ready True|False> [terminating]
pod() {
  local del=""; [ -n "${7:-}" ] && del=',"deletionTimestamp":"2026-11-20T14:46:00Z"'
  printf '{"metadata":{"name":"%s","ownerReferences":[{"kind":"%s","uid":"%s"}]%s},"status":{"phase":"%s","startTime":"%s","conditions":[{"type":"Ready","status":"%s"}]}}' "$1" "$4" "$5" "$del" "$2" "$3" "$6"
}
JOB_POD=$(pod litellm-premigrate-1-109-1-pdpdq Succeeded $BEFORE Job job-1 False)
NEW_OK=$(pod gw-new Running $AFTER ReplicaSet rs-new True)
run() { # <label> <expected rc> <dep json> <rs json> <pods items…>
  local label=$1 want=$2 d=$3 r=$4; shift 4
  printf '%s' "$d" > "$T/dep.json"; printf '%s' "$r" > "$T/rs.json"
  local IFS=,; printf '{"items":[%s]}' "$*" > "$T/pods.json"; unset IFS
  out=$(python3 $RR "$T/dep.json" "$T/rs.json" "$T/pods.json" "$DEPLOYED"); rc=$?
  rc_is "$label" "$want"; [ "$rc" = "$want" ] || echo "     output: $out"
}

echo "pass"
run "the production case: rollout done, one Ready pod after the deploy, a Job pod ignored" 0 "$(dep 1 3 3 1 1 1 1)" "$RS_BOTH" "$NEW_OK" "$JOB_POD"
check "  ... saying the Job pod was ignored" "1 other pod(s) with the same labels ignored" "$out"

echo "negative twins (each must FAIL)"
run "missing Deployment" 1 "" '{"items":[]}' "$NEW_OK"
check "  ... saying so" "does not exist" "$out"
run "controller has not observed the latest spec" 1 "$(dep 1 4 3 1 1 1 1)" "$RS_BOTH" "$NEW_OK"
run "mid-rollout: new pod not Ready, old ReplicaSet's pod still Running" 1 "$(dep 1 3 3 2 1 1 1)" "$RS_BOTH" \
  "$(pod gw-new Running $AFTER ReplicaSet rs-new False)" "$(pod gw-old Running $BEFORE ReplicaSet rs-old True)"
run "mid-rollout even if the counts already look complete: an old pod still Running" 1 "$(dep 1 3 3 1 1 1 1)" "$RS_BOTH" \
  "$NEW_OK" "$(pod gw-old Running $BEFORE ReplicaSet rs-old True)"
check "  ... naming the old pod" "gw-old" "$out"
run "an old pod Terminating" 1 "$(dep 1 3 3 1 1 1 1)" "$RS_BOTH" "$NEW_OK" "$(pod gw-old Running $BEFORE ReplicaSet rs-old False terminating)"
run "crash-looping: Running but not Ready" 1 "$(dep 1 3 3 1 1 0 0)" "$RS_BOTH" "$(pod gw-new Running $AFTER ReplicaSet rs-new False)"
run "crash-looping, even if the status counts lag" 1 "$(dep 1 3 3 1 1 1 1)" "$RS_BOTH" "$(pod gw-new Running $AFTER ReplicaSet rs-new False)"
check "  ... naming the not-Ready pod" "not Ready: gw-new" "$out"
run "the new pod Pending while the old serves" 1 "$(dep 1 3 3 2 1 1 1)" "$RS_BOTH" \
  "$(pod gw-new Pending $AFTER ReplicaSet rs-new False)" "$(pod gw-old Running $BEFORE ReplicaSet rs-old True)"
run "no current ReplicaSet" 1 "$(dep 1 3 3 1 1 1 1)" "$RS_OLD_ONLY" "$(pod gw-old Running $BEFORE ReplicaSet rs-old True)"
run "a Ready pod of the current ReplicaSet from before the deploy" 1 "$(dep 1 3 3 1 1 1 1)" "$RS_BOTH" "$(pod gw-stale Running $BEFORE ReplicaSet rs-new True)"
run "only a Job pod, no current pod" 1 "$(dep 1 3 3 1 1 1 1)" "$RS_BOTH" "$JOB_POD"

echo "skip"
run "scaled to 0 replicas" 2 "$(dep 0 3 3 0 0 0 0)" "$RS_BOTH" "$JOB_POD"

finish readers-restarted
