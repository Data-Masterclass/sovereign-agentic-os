#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# rotation-readers.test.sh — the readers rotate-secrets.sh verify checks are DISCOVERED.
# =============================================================================
#   bash scripts/tests/rotation-readers.test.sh
#
# rotation-checks.py readers, on a `kubectl get deploy,statefulset,daemonset,cronjob -o json` list:
# every workload whose pod template reads a rotated Secret is found — by env valueFrom, envFrom, a
# secret or projected volume, in containers or init containers, of a Deployment, StatefulSet,
# DaemonSet or CronJob — including a NEW seventh reader no hand-written list names (the twin: the
# former hard-coded list misses it). Not found: workloads reading only other Secrets or ConfigMaps.
# readers-restarted.py for StatefulSets and DaemonSets: pass when the rollout is complete and every
# pod is Ready and newer than the Secret change; twins: a stale pod, a not-Ready pod, an incomplete
# rollout, a stale controller each fail; 0 replicas is a skip.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
. scripts/tests/assert.sh
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
RC=scripts/lib/rotation-checks.py RR=scripts/lib/readers-restarted.py
ROTATED="litellm-credentials langfuse-init langfuse-core-secrets agent-runtime-token"
wl() { # kind name podspec-json
  case $1 in
    CronJob) printf '{"kind":"CronJob","metadata":{"name":"%s"},"spec":{"jobTemplate":{"spec":{"template":{"spec":%s}}}}}' "$2" "$3" ;;
    *) printf '{"kind":"%s","metadata":{"name":"%s"},"spec":{"template":{"spec":%s}}}' "$1" "$2" "$3" ;;
  esac
}
envref() { printf '{"containers":[{"name":"c","env":[{"name":"X","valueFrom":{"secretKeyRef":{"name":"%s","key":"k"}}}]}]}' "$1"; }
items=(
  "$(wl Deployment agentic-os-litellm '{"containers":[{"name":"litellm","envFrom":[{"secretRef":{"name":"litellm-credentials"}}]}]}')"
  "$(wl Deployment os-ui "$(envref langfuse-init)")"
  "$(wl Deployment brand-new-reader "$(envref agent-runtime-token)")"
  "$(wl StatefulSet some-db '{"containers":[{"name":"c"}],"volumes":[{"name":"v","secret":{"secretName":"langfuse-core-secrets"}}]}')"
  "$(wl DaemonSet node-agent '{"initContainers":[{"name":"i","env":[{"name":"T","valueFrom":{"secretKeyRef":{"name":"agent-runtime-token","key":"token"}}}]}],"containers":[{"name":"c"}]}')"
  "$(wl CronJob pg-sweep '{"containers":[{"name":"c"}],"volumes":[{"name":"p","projected":{"sources":[{"secret":{"name":"litellm-credentials"}}]}}]}')"
  "$(wl Deployment unrelated "$(envref postgres-dagster-credentials)")"
  "$(wl Deployment configmap-only '{"containers":[{"name":"c","envFrom":[{"configMapRef":{"name":"litellm-credentials"}}]}]}')"
)
(IFS=,; printf '{"kind":"List","items":[%s]}' "${items[*]}") > "$T/all.json"
# shellcheck disable=SC2086
out=$(python3 $RC readers "$T/all.json" $ROTATED)
echo "discovery"
check "a Deployment by envFrom" "Deployment agentic-os-litellm litellm-credentials" "$out"
check "a Deployment by env valueFrom" "Deployment os-ui langfuse-init" "$out"
check "a NEW reader nobody listed" "Deployment brand-new-reader agent-runtime-token" "$out"
check "a StatefulSet by a secret volume" "StatefulSet some-db langfuse-core-secrets" "$out"
check "a DaemonSet by an init container" "DaemonSet node-agent agent-runtime-token" "$out"
check "a CronJob by a projected volume" "CronJob pg-sweep litellm-credentials" "$out"
absent "twin: a workload reading only another Secret is not a reader" "unrelated" "$out"
absent "twin: a ConfigMap with a Secret's name is not a Secret" "configmap-only" "$out"
check "exactly six readers" "6" "$(grep -c . <<<"$out")"
OLD_LIST="agentic-os-langfuse-web agentic-os-langfuse-worker agentic-os-litellm os-ui os-ui-worker agentic-os-dagster-user-deployments-sovereign"
case " $OLD_LIST " in *" brand-new-reader "*) bad "twin setup" ;; *) ok "twin: the former hand-written list does not contain the new reader — discovery does" ;; esac
check "item extracts one object" '"name": "some-db"' "$(python3 $RC item "$T/all.json" StatefulSet some-db)"

echo "StatefulSet / DaemonSet verdicts"
SINCE=2026-11-20T15:10:00Z
sts() { printf '{"kind":"StatefulSet","metadata":{"name":"db","uid":"s","generation":%s},"spec":{"replicas":%s},"status":{"observedGeneration":%s,"replicas":%s,"readyReplicas":%s,"updatedReplicas":%s,"currentRevision":"%s","updateRevision":"r2"}}' "$1" "$2" "$3" "$4" "$5" "$6" "$7" > "$T/w.json"; }
ds() { printf '{"kind":"DaemonSet","metadata":{"name":"agent","uid":"d","generation":1},"spec":{},"status":{"observedGeneration":1,"desiredNumberScheduled":%s,"currentNumberScheduled":%s,"updatedNumberScheduled":%s,"numberReady":%s,"numberAvailable":%s}}' "$1" "$2" "$3" "$4" "$5" > "$T/w.json"; }
pods() { # ownerKind ownerUid start ready
  printf '{"items":[{"metadata":{"name":"p0","ownerReferences":[{"kind":"%s","uid":"%s"}]},"status":{"phase":"Running","startTime":"%s","conditions":[{"type":"Ready","status":"%s"}]}}]}' "$1" "$2" "$3" "$4" > "$T/p.json"; }
v() { out=$(python3 $RR "$T/w.json" /dev/null "$T/p.json" "$SINCE"); rc=$?; }
sts 2 1 2 1 1 1 r2; pods StatefulSet s 2026-11-20T15:20:00Z True; v; rc_is "StatefulSet: rollout complete, pod Ready and newer → pass" 0
pods StatefulSet s 2026-11-20T15:00:00Z True; v; rc_is "twin: a StatefulSet pod from before the Secret change fails" 1
pods StatefulSet s 2026-11-20T15:20:00Z False; v; rc_is "twin: a StatefulSet pod not Ready fails" 1
sts 2 1 2 1 1 1 r1; pods StatefulSet s 2026-11-20T15:20:00Z True; v; rc_is "twin: a StatefulSet mid-rollout (currentRevision != updateRevision) fails" 1
sts 3 1 2 1 1 1 r2; v; rc_is "twin: a StatefulSet whose controller lags fails" 1
sts 2 0 2 0 0 0 r2; v; rc_is "a StatefulSet at 0 replicas is a skip" 2
ds 2 2 2 2 2; printf '{"items":[%s,%s]}' \
  '{"metadata":{"name":"a","ownerReferences":[{"kind":"DaemonSet","uid":"d"}]},"status":{"phase":"Running","startTime":"2026-11-20T15:20:00Z","conditions":[{"type":"Ready","status":"True"}]}}' \
  '{"metadata":{"name":"b","ownerReferences":[{"kind":"DaemonSet","uid":"d"}]},"status":{"phase":"Running","startTime":"2026-11-20T15:21:00Z","conditions":[{"type":"Ready","status":"True"}]}}' > "$T/p.json"
v; rc_is "DaemonSet: every node's pod Ready and newer → pass" 0
ds 2 2 1 2 2; v; rc_is "twin: a DaemonSet not fully updated fails" 1
ds 2 2 2 2 2; pods DaemonSet d 2026-11-20T15:00:00Z True; v; rc_is "twin: a DaemonSet pod from before the Secret change fails" 1

finish rotation-readers
