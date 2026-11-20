#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# readers-restarted.test.sh — scripts/lib/readers-restarted.py (rotate-secrets.sh verify).
# =============================================================================
#   bash scripts/tests/readers-restarted.test.sh
#
# Fixtures shaped like `kubectl get … -o json`. The case seen on production: the gateway's only
# Running pod (current ReplicaSet) started after the deploy, and a Succeeded migration Job pod with
# the same `app.kubernetes.io/name=litellm` label started before it → PASS (the Job pod is no
# reader). Also ignored: a Terminating pod of the previous ReplicaSet. Negative twins: a Running
# pod of the current ReplicaSet from before the deploy → FAIL; no current ReplicaSet → skip (2).
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
. scripts/tests/assert.sh
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
RR=scripts/lib/readers-restarted.py
DEPLOYED=2026-11-20T15:40:00.123+01:00          # helm's last_deployed (local offset) = 14:40Z
cat > "$T/dep.json" <<'J'
{"metadata": {"name": "agentic-os-litellm", "uid": "dep-1", "annotations": {"deployment.kubernetes.io/revision": "7"}}}
J
cat > "$T/rs.json" <<'J'
{"items": [
 {"metadata": {"name": "agentic-os-litellm-new", "uid": "rs-new", "annotations": {"deployment.kubernetes.io/revision": "7"}, "ownerReferences": [{"kind": "Deployment", "uid": "dep-1"}]}},
 {"metadata": {"name": "agentic-os-litellm-old", "uid": "rs-old", "annotations": {"deployment.kubernetes.io/revision": "6"}, "ownerReferences": [{"kind": "Deployment", "uid": "dep-1"}]}}
]}
J
pod() { # name phase start ownerKind ownerUid
  printf '{"metadata": {"name": "%s", "ownerReferences": [{"kind": "%s", "uid": "%s"}]}, "status": {"phase": "%s", "startTime": "%s"}}' "$1" "$4" "$5" "$2" "$3"
}
printf '{"items": [%s, %s, %s]}' \
  "$(pod agentic-os-litellm-new-abc Running 2026-11-20T14:45:00Z ReplicaSet rs-new)" \
  "$(pod litellm-premigrate-1-109-1-pdpdq Succeeded 2026-11-20T11:20:00Z Job job-1)" \
  "$(pod agentic-os-litellm-old-xyz Running 2026-11-20T09:00:00Z ReplicaSet rs-old)" > "$T/pods.json"

out=$(python3 $RR "$T/dep.json" "$T/rs.json" "$T/pods.json" "$DEPLOYED"); rc=$?
rc_is "the production case passes: only the current ReplicaSet's Running pod counts" 0
check "  ... saying the other pods were ignored" "2 other pod(s) with the same labels ignored" "$out"

echo "negative twins"
printf '{"items": [%s, %s]}' \
  "$(pod agentic-os-litellm-new-abc Running 2026-11-20T14:45:00Z ReplicaSet rs-new)" \
  "$(pod agentic-os-litellm-new-stale Running 2026-11-20T14:39:59Z ReplicaSet rs-new)" > "$T/pods2.json"
out=$(python3 $RR "$T/dep.json" "$T/rs.json" "$T/pods2.json" "$DEPLOYED"); rc=$?
rc_is "a Running pod of the current ReplicaSet from before the deploy fails" 1
check "  ... naming it" "agentic-os-litellm-new-stale" "$out"
out=$(python3 $RR "$T/dep.json" '/dev/stdin' "$T/pods.json" "$DEPLOYED" <<<'{"items": []}'); rc=$?
rc_is "no current ReplicaSet is a skip, not a pass" 2
printf '{"items": [%s]}' "$(pod litellm-premigrate-1-109-1-pdpdq Succeeded 2026-11-20T11:20:00Z Job job-1)" > "$T/pods3.json"
out=$(python3 $RR "$T/dep.json" "$T/rs.json" "$T/pods3.json" "$DEPLOYED"); rc=$?
rc_is "only a completed Job pod: no serving pod, a skip" 2
# What the previous check did (every pod with the selector's labels): the Job pod failed it.
starts=$(python3 -c 'import json,sys; print(" ".join(p["status"]["startTime"] for p in json.load(open(sys.argv[1]))["items"]))' "$T/pods.json")
python3 -c 'import sys; from datetime import datetime as d; t=lambda v: d.fromisoformat(v.replace("Z","+00:00")); sys.exit(0 if all(t(x) > t(sys.argv[1]) for x in sys.argv[2].split()) else 1)' "$DEPLOYED" "$starts"; rc=$?
rc_is "twin: the old all-labelled-pods check fails on the production case (the false positive)" 1

finish readers-restarted
