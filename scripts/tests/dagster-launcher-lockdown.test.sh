#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# =============================================================================
# dagster-launcher-lockdown.test.sh — the opt-in overlay values.dagster-launcher-lockdown.yaml
# changes NOTHING about a normal run but the two documented dagster-k8s restrictions.
# =============================================================================
#   bash scripts/tests/dagster-launcher-lockdown.test.sh [dagster image]   (needs helm, docker)
#   image default: $DAGSTER_LOCK_IMAGE or sovereign-os/dagster:lock, built from this checkout:
#     docker build -f images/extensions/dagster/Dockerfile -t sovereign-os/dagster:lock images/extensions
#
# 1. renders the chart with and without the overlay and runs dagster_launcher_lockdown.py INSIDE the
#    Dagster image: render parity, config parity (upstream-normalised), the real
#    K8sRunLauncher.launch_run builds the identical Job for a normal OS launch, and refuses the
#    tags the allow-list excludes (with the stock launcher accepting them as the twin);
# 2. NEGATIVE TWINS: deliberately drifted copies of the overlay must FAIL the same check — the
#    operator copy of the run pod's env loses one entry; the restated code-location entry drifts;
#    the allow-list widens.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
# shellcheck source=scripts/tests/assert.sh
. scripts/tests/assert.sh
for b in helm docker python3; do command -v "$b" >/dev/null || { echo "$b not on PATH"; exit 2; }; done
IMAGE=${1:-${DAGSTER_LOCK_IMAGE:-sovereign-os/dagster:lock}}
OVERLAY=values.dagster-launcher-lockdown.yaml
CHART=charts/sovereign-agentic-os
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

render() { helm template agentic-os "$CHART" -n agentic-os "$@" 2>"$TMP/helm.err"; }
parity() {  # $1 = lock-down render; sets rc + out
  # docker cp, not a bind mount: works with any docker host (colima does not share every temp dir).
  local c
  c=$(docker create --entrypoint python3 "$IMAGE" -I /tmp/t/dagster_launcher_lockdown.py \
        /tmp/t/stock.yaml /tmp/t/lock.yaml) || { rc=2; out="docker create failed"; return; }
  mkdir -p "$TMP/in" && cp scripts/tests/dagster_launcher_lockdown.py "$TMP/stock.yaml" "$TMP/in/" \
    && cp "$TMP/$1" "$TMP/in/lock.yaml" && docker cp -q "$TMP/in/." "$c:/tmp/t" >/dev/null
  out=$(docker start -a "$c" 2>&1); rc=$?
  docker rm -f "$c" >/dev/null 2>&1
}

render > "$TMP/stock.yaml" || { cat "$TMP/helm.err"; exit 2; }
echo "1. the overlay ($OVERLAY) against the stock render"
if [ -f "$OVERLAY" ] && render -f "$OVERLAY" > "$TMP/lock.yaml"; then
  parity lock.yaml
  echo "$out" | sed 's/^/   /'
  rc_is "parity: the overlay changes nothing but the two restrictions" 0
else
  bad "the overlay renders" "$(cat "$TMP/helm.err" 2>/dev/null) (missing: $OVERLAY?)"
fi

echo "2. negative twins: drifted overlays must fail"
drift() {  # $1 name, $2 python edit of `v` (the overlay as a dict)
  python3 - "$OVERLAY" "$TMP/drift.yaml" "$2" <<'EOF' || return 1
import sys, yaml
v = yaml.safe_load(open(sys.argv[1]))
cfg = v["dagster"]["runLauncher"]["config"]["customRunLauncher"]["config"]
dep = v["dagster"]["dagster-user-deployments"]["deployments"][0]
exec(sys.argv[3])
yaml.safe_dump(v, open(sys.argv[2], "w"))
EOF
  if render -f "$TMP/drift.yaml" > "$TMP/drift-render.yaml"; then
    parity drift-render.yaml
    if [ "$rc" -ne 0 ]; then ok "twin: $1 -> parity fails"; else bad "twin: $1 -> parity must fail" "$out"; fi
  else
    bad "twin: $1 renders" "$(cat "$TMP/helm.err")"
  fi
}
if [ -f "$OVERLAY" ]; then
  drift "the operator run-pod env lost TRINO_USER" \
    'cfg["run_k8s_config"]["container_config"]["env"] = [e for e in cfg["run_k8s_config"]["container_config"]["env"] if e["name"] != "TRINO_USER"]'
  drift "the restated code-location entry drifted (memory limit)" \
    'dep["resources"]["limits"]["memory"] = "2Gi"'
  drift "the allow-list widened (pod_spec_config.volumes)" \
    'cfg["only_allow_user_defined_k8s_config_fields"]["pod_spec_config"] = {"volumes": True}'
  drift "the env allow-list widened (PYTHONPATH)" \
    'cfg["only_allow_user_defined_env_vars"].append("PYTHONPATH")'
  drift "a stock launcher key changed (service account)" \
    'cfg["service_account_name"] = "default"'
fi
finish "dagster-launcher-lockdown"
