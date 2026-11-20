#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# rotation-checks.test.sh — scripts/lib/rotation-checks.py (rotate-secrets.sh verify), on fixtures.
# =============================================================================
#   bash scripts/tests/rotation-checks.test.sh
#
# env-state: the gateway's LITELLM_MIGRATE_FROM_MASTER_KEY as rendered after step 2 — an entry with
#   NO value key (seen on production; the previous go-template check read it as "[<no value>]" and
#   failed) — is `empty`; so is an empty string; a missing entry is `absent`; a real value is `set`
#   (the negative twin: verify must fail on it), and so is a valueFrom.
# changed-at + readers-restarted: the reference for "restarted" is when the Secrets a reader reads
#   last changed. A later deploy that did not touch them leaves that time alone, so a reader started
#   after the rotation but before the later deploy PASSES; with the old reference (the later deploy)
#   the same reader fails (the false positive). Negative twins: a reader started before the Secret
#   changed fails; a missing Secret is an error.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
. scripts/tests/assert.sh
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
RC=scripts/lib/rotation-checks.py RR=scripts/lib/readers-restarted.py
depenv() { printf '{"spec":{"template":{"spec":{"containers":[{"name":"litellm","env":[{"name":"STORE_MODEL_IN_DB","value":"true"}%s]}]}}}}' "$1" > "$T/d.json"; }

echo "env-state"
depenv ',{"name":"LITELLM_MIGRATE_FROM_MASTER_KEY"}'
check "an entry without a value key is empty (the production case)" "empty" "$(python3 $RC env-state "$T/d.json" litellm LITELLM_MIGRATE_FROM_MASTER_KEY)"
depenv ',{"name":"LITELLM_MIGRATE_FROM_MASTER_KEY","value":""}'
check "an empty value is empty" "empty" "$(python3 $RC env-state "$T/d.json" litellm LITELLM_MIGRATE_FROM_MASTER_KEY)"
depenv ''
check "no entry is absent" "absent" "$(python3 $RC env-state "$T/d.json" litellm LITELLM_MIGRATE_FROM_MASTER_KEY)"
depenv ',{"name":"LITELLM_MIGRATE_FROM_MASTER_KEY","value":"sk-old"}'
out=$(python3 $RC env-state "$T/d.json" litellm LITELLM_MIGRATE_FROM_MASTER_KEY)
check "twin: a real value is set (verify fails)" "set" "$out"
absent "  ... and the value is never printed" "sk-old" "$out"
depenv ',{"name":"LITELLM_MIGRATE_FROM_MASTER_KEY","valueFrom":{"secretKeyRef":{"name":"x","key":"y"}}}'
check "twin: a valueFrom is set" "set" "$(python3 $RC env-state "$T/d.json" litellm LITELLM_MIGRATE_FROM_MASTER_KEY)"

echo "changed-at, and readers against it"
ROTATED=2026-11-20T15:10:00Z; LATER_DEPLOY=2026-11-20T18:00:00+01:00   # 0.9.24 at 17:00Z, Secret untouched
printf '{"metadata":{"name":"litellm-credentials","creationTimestamp":"2026-07-01T00:00:00Z","managedFields":[{"manager":"helm","operation":"Apply","time":"%s"},{"manager":"kubectl","operation":"Update","time":"2026-11-20T09:00:00Z"}]}}' "$ROTATED" > "$T/s1.json"
printf '{"metadata":{"name":"langfuse-init","creationTimestamp":"2026-07-01T00:00:00Z","managedFields":[{"manager":"helm","operation":"Apply","time":"2026-11-20T15:09:00Z"}]}}' > "$T/s2.json"
since=$(python3 $RC changed-at "$T/s1.json" "$T/s2.json")
check "the newest change of the Secrets a reader reads" "$ROTATED" "$since"
: > "$T/missing.json"
python3 $RC changed-at "$T/s1.json" "$T/missing.json" >/dev/null 2>&1; rc=$?
rc_is "twin: a missing Secret is an error, not a pass" 1
dep='{"metadata":{"name":"agentic-os-litellm","uid":"d","generation":2,"annotations":{"deployment.kubernetes.io/revision":"3"}},"spec":{"replicas":1},"status":{"observedGeneration":2,"replicas":1,"updatedReplicas":1,"readyReplicas":1,"availableReplicas":1}}'
rs='{"items":[{"metadata":{"name":"r","uid":"r","annotations":{"deployment.kubernetes.io/revision":"3"},"ownerReferences":[{"kind":"Deployment","uid":"d"}]}}]}'
printf '%s' "$dep" > "$T/dep.json"; printf '%s' "$rs" > "$T/rs.json"
podat() { printf '{"items":[{"metadata":{"name":"gw","ownerReferences":[{"kind":"ReplicaSet","uid":"r"}]},"status":{"phase":"Running","startTime":"%s","conditions":[{"type":"Ready","status":"True"}]}}]}' "$1" > "$T/pods.json"; }
podat 2026-11-20T15:20:00Z     # restarted after the rotation, before the later deploy, not rolled since
out=$(python3 $RR "$T/dep.json" "$T/rs.json" "$T/pods.json" "$since"); rc=$?
rc_is "a reader started after the rotation passes after a later unrelated deploy" 0
python3 $RR "$T/dep.json" "$T/rs.json" "$T/pods.json" "$LATER_DEPLOY" >/dev/null; rc=$?
rc_is "twin: against the later deploy's time (the old reference) it fails — the false positive" 1
podat 2026-11-20T15:05:00Z     # never restarted after the rotation
out=$(python3 $RR "$T/dep.json" "$T/rs.json" "$T/pods.json" "$since"); rc=$?
rc_is "twin: a reader started before the Secret changed fails" 1
check "  ... saying why" "started before the Secrets it reads changed" "$out"

finish rotation-checks
