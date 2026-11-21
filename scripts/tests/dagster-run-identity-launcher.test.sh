#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# =============================================================================
# dagster-run-identity-launcher.test.sh — WP-15's run settings must reach the run pod.
# =============================================================================
#   bash scripts/tests/dagster-run-identity-launcher.test.sh [dagster image]   (needs helm, docker)
#   image default: $DAGSTER_LOCK_IMAGE or sovereign-os/dagster:lock (built from this checkout)
#
# 1. the chart renders with `-f lock-down -f run-identity` and dagster_run_identity_launcher.py (INSIDE
#    the Dagster image, real K8sRunLauncher.launch_run) shows the run pod as ServiceAccount
#    `dagster-run`, token not automounted, every lock-down entry still present; the twin (the old
#    layout, the code location's context winning) shows the failure it must see;
# 2. the generated run block of the identity overlay equals scripts/gen-dagster-run-identity.py, and a
#    drifted lock-down list makes it differ (twin);
# 3. NEGATIVE TWINS: the identity overlay WITHOUT the lock-down, or applied BEFORE it, is refused by
#    the chart (the code location's context, or the lock-down's lists, would override the run pod's identity).
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
# shellcheck source=scripts/tests/assert.sh
. scripts/tests/assert.sh
for b in helm docker python3; do command -v "$b" >/dev/null || { echo "$b not on PATH"; exit 2; }; done
IMAGE=${1:-${DAGSTER_LOCK_IMAGE:-sovereign-os/dagster:lock}}
CHART=charts/sovereign-agentic-os
LOCK=values.dagster-launcher-lockdown.yaml
IDENT=values.dagster-run-identity.yaml
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
ID_SET=(--set postgres.governance.adminSecretName=ri-test)
render() { helm template agentic-os "$CHART" -n agentic-os "$@" 2>"$TMP/helm.err"; }

echo "1. both overlays, judged by dagster-k8s's own launch_run"
render > "$TMP/stock.yaml" || { cat "$TMP/helm.err"; exit 2; }
if render -f "$LOCK" > "$TMP/lock.yaml" && render -f "$LOCK" -f "$IDENT" "${ID_SET[@]}" > "$TMP/both.yaml"; then
  c=$(docker create --entrypoint python3 "$IMAGE" -I /tmp/t/dagster_run_identity_launcher.py \
        /tmp/t/stock.yaml /tmp/t/lock.yaml /tmp/t/both.yaml /tmp/t/identity.yaml /tmp/t/lockov.yaml) || exit 2
  mkdir -p "$TMP/in" && cp scripts/tests/dagster_run_identity_launcher.py scripts/tests/dagster_launcher_lockdown.py "$TMP/stock.yaml" "$TMP/lock.yaml" "$TMP/both.yaml" "$TMP/in/" \
    && cp "$IDENT" "$TMP/in/identity.yaml" && cp "$LOCK" "$TMP/in/lockov.yaml" && docker cp -q "$TMP/in/." "$c:/tmp/t" >/dev/null
  out=$(docker start -a "$c" 2>&1); rc=$?; docker rm -f "$c" >/dev/null 2>&1
  echo "$out" | grep -vE "No dagster instance configuration" | sed 's/^/   /'
  rc_is "the run pod has the run identity under both overlays" 0
else
  bad "both overlays render" "$(head -5 "$TMP/helm.err")"
fi

echo "2. the run block is generated from the lock-down overlay"
python3 scripts/gen-dagster-run-identity.py > "$TMP/block.txt"
python3 - "$IDENT" "$TMP/block.txt" <<'EOF2' && ok "the checked-in run block equals the generator's output" || bad "the checked-in run block equals the generator's output" "run scripts/gen-dagster-run-identity.py --write"
import sys
s = open(sys.argv[1]).read(); b = open(sys.argv[2]).read()
sys.exit(0 if b in s else 1)
EOF2
python3 - "$LOCK" "$TMP/lock-drift.yaml" <<'EOF2'
import sys, yaml
v = yaml.safe_load(open(sys.argv[1]))
rk = v["dagster"]["runLauncher"]["config"]["customRunLauncher"]["config"]["run_k8s_config"]
rk["container_config"]["env"].append({"name": "A_NEW_ENTRY", "value": "1"})
yaml.safe_dump(v, open(sys.argv[2], "w"))
EOF2
sed "s#^LOCK = .*#LOCK = '$TMP/lock-drift.yaml'#" scripts/gen-dagster-run-identity.py > "$TMP/gen-drift.py"
if python3 "$TMP/gen-drift.py" | cmp -s - "$TMP/block.txt"; then bad "twin: a new lock-down env entry changes the generated block" ""; else ok "twin: a new lock-down env entry changes the generated block (the checked-in one would be stale)"; fi

echo "3. negative twin: the identity overlay without the lock-down is refused"
render -f "$IDENT" "${ID_SET[@]}" >/dev/null; rc=$?
rc_is "the chart refuses -f run-identity without -f lock-down" 1
check "... because the subchart's CustomRunLauncher is incomplete without it" "customRunLauncher" "$(cat "$TMP/helm.err")"
render -f "$IDENT" -f "$LOCK" "${ID_SET[@]}" >/dev/null; rc=$?
rc_is "the chart refuses the wrong order (-f run-identity -f lock-down: the lock-down's lists would win)" 1
check "... naming the overlay and the order" "values.dagster-launcher-lockdown.yaml BEFORE" "$(cat "$TMP/helm.err")"
render -f "$LOCK" -f "$IDENT" "${ID_SET[@]}" >/dev/null; rc=$?
rc_is "the chart accepts both, in that order" 0
finish "dagster-run-identity-launcher"
