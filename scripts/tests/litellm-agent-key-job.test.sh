#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# litellm-agent-key-job.test.sh — the shared agent key's init Job creates, it does not overwrite.
# =============================================================================
#   bash scripts/tests/litellm-agent-key-job.test.sh
#
# Rendering only (no cluster). The Job's behaviour on a real gateway is proven by
# scripts/tests/agent-key-migration/run.sh, which executes the RENDERED script against the pinned
# LiteLLM image. This test pins the shape:
#   * default: the Job registers the key when it is absent (/key/generate) and, when it exists, only
#     REPORTS how it differs from the chart values — it contains no /key/update, so an edit the
#     platform team made in LiteLLM survives `helm upgrade`;
#   * litellmAgentKey.reapplyOnUpgrade=true (explicit): the old behaviour — /key/update with the
#     chart values on every upgrade;
#   * the os-ui env for the continuous per-system key reconcile: interval default, auto-correct list.
# Skips (exit 0) without helm or the subchart .tgz files — but FAILS when CI is set.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
. scripts/tests/assert.sh
CHART=charts/sovereign-agentic-os
skip() {
  if [ -n "${CI:-}" ]; then echo "litellm-agent-key-job: $1 — FAILING because CI is set"; exit 1; fi
  echo "litellm-agent-key-job: $1 — SKIPPED"; exit 0
}
command -v helm >/dev/null 2>&1 || skip "helm not on PATH"
ls "$CHART"/charts/*.tgz >/dev/null 2>&1 || skip "chart dependencies not built"

render() {
  local e; e=$(mktemp)
  out=$(helm template t "$CHART" -n agentic-os --skip-schema-validation "$@" 2>"$e"); rc=$?
  [ "$rc" -eq 0 ] || out="$out$(cat "$e")"
  rm -f "$e"
}
# the key-init Job's shell script
script() { printf '%s' "$out" | python3 -c '
import sys, yaml
for d in yaml.safe_load_all(sys.stdin):
    if d and d.get("kind") == "Job" and d["metadata"]["name"] == "litellm-agent-key-init":
        print(d["spec"]["template"]["spec"]["containers"][0]["args"][0])'; }
# the os-ui container env as NAME=value lines
osenv() { printf '%s' "$out" | python3 -c '
import sys, yaml
for d in yaml.safe_load_all(sys.stdin):
    if d and d.get("kind") == "Deployment" and d["metadata"]["name"].endswith("os-ui"):
        for e in d["spec"]["template"]["spec"]["containers"][0].get("env", []):
            if "value" in e: print("%s=%s" % (e["name"], e["value"]))'; }

echo "default render"
render
rc_is "the chart renders" 0
S=$(script)
check  "the Job still registers an absent key" '/key/generate' "$S"
check  "an existing key is only compared with the chart values" 'key-drift' "$S"
absent "NO /key/update by default: a hand edit in LiteLLM survives helm upgrade" '/key/update' "$S"
E=$(osenv)
check  "the per-system reconcile runs every 300 s by default" 'AGENT_KEY_RECONCILE_INTERVAL_SECONDS=300' "$E"
absent "auto-correct is OFF by default (alert only)" 'AGENT_KEY_RECONCILE_AUTOCORRECT_SYSTEMS' "$E"

echo "negative twin: re-apply on upgrade is an explicit choice"
render --set litellmAgentKey.reapplyOnUpgrade=true
rc_is "renders" 0
S=$(script)
check  "with reapplyOnUpgrade the Job /key/update-s the chart values" '/key/update' "$S"
check  "and still registers an absent key" '/key/generate' "$S"

echo "auto-correct is a per-system list"
render --set 'osUI.agentSystemKey.reconcile.autoCorrectSystems={sys_a,sys_b}' --set osUI.agentSystemKey.reconcile.intervalSeconds=60
E=$(osenv)
check "the listed systems reach os-ui" 'AGENT_KEY_RECONCILE_AUTOCORRECT_SYSTEMS=sys_a,sys_b' "$E"
check "the interval is configurable" 'AGENT_KEY_RECONCILE_INTERVAL_SECONDS=60' "$E"
render --set osUI.agentSystemKey.reconcile.intervalSeconds=0
check "0 switches the check off (rendered, not dropped)" 'AGENT_KEY_RECONCILE_INTERVAL_SECONDS=0' "$(osenv)"
finish "litellm-agent-key-job"
