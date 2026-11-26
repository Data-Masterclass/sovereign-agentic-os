#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# cronjob-secrets-chart.test.sh — every CronJob reads only Secrets that exist.
# =============================================================================
#   bash scripts/tests/cronjob-secrets-chart.test.sh
#
# A CronJob whose pod names a Secret nobody creates never runs: the pod sits in
# CreateContainerConfigError and nothing reports it. This happened twice (2026-11-26): the agent
# schedule CronJob os-ui creates at run time and connections.catalogRefresh both read the service
# bearer from Secret `os-ui`, which no profile renders (the bearer is agent-runtime-token/token).
#
# Renders the chart (laptop profile, no cluster) with EVERY CronJob feature on — the static agent
# schedules, catalog refresh, metrics alerts, pg-dump, the restore drill, OpenSearch snapshots —
# adds the CronJob os-ui creates at run time (os-ui/scripts/print-schedule-cronjob.ts, its live
# defaults), and checks every non-optional Secret reference against the Secrets the render
# creates (scripts/tests/cronjob-secrets-check.py). Owner-provided Secrets are accepted only where
# values.yaml documents that the operator creates them first (named below). Negative twin: the old
# catalogRefresh default `os-ui` must fail.
# Skips without helm, the subchart .tgz files or os-ui's node_modules — but FAILS when CI is set.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
. scripts/tests/assert.sh
CHART=charts/sovereign-agentic-os
skip() { if [ -n "${CI:-}" ]; then echo "cronjob-secrets-chart: $1 — FAILING because CI is set"; exit 1; fi; echo "cronjob-secrets-chart: $1 — SKIPPED"; exit 0; }
command -v helm >/dev/null 2>&1 || skip "helm not on PATH"
ls "$CHART"/charts/*.tgz >/dev/null 2>&1 || skip "chart dependencies not built"
[ -d os-ui/node_modules ] || skip "os-ui dependencies not installed (npm --prefix os-ui ci)"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT

# Documented operator-created Secrets (values.yaml): backup.gitBundles.secretName ("owner-created")
# and metrics.alerts.cron.principalSecret ("Provision it before enabling").
OWNER=(--owner-provided git-backup-s3 --owner-provided metrics-alert-principal)

ALL=(-f values.local.yaml
  --set 'agentRuntime.schedules[0].name=probe' --set 'agentRuntime.schedules[0].systemId=sys_probe'
  --set 'agentRuntime.schedules[0].cron=0 9 * * 1' --set 'agentRuntime.schedules[0].prompt=hi'
  --set connections.catalogRefresh.enabled=true
  --set metrics.alerts.cron.enabled=true
  --set backup.pgDump.enabled=true
  --set backup.drill.enabled=true --set 'backup.drill.postgresCompare.criticalTables[0]=os_governance:public.audit_events'
  --set backup.gitBundles.enabled=true --set backup.gitBundles.bucket=chart-test
  --set backup.gitBundles.image.digest=sha256:0000000000000000000000000000000000000000000000000000000000000000
  --set opensearchSnapshots.enabled=true --set opensearchSnapshots.cronJob.enabled=true)

render() { helm template t "$CHART" -n agentic-os --skip-schema-validation "$@" > "$T/render.yaml" 2> "$T/render.err"; }

echo "1. the runtime agent-schedule CronJob (os-ui's live defaults)"
( cd os-ui && node --experimental-test-module-mocks --import ./scripts/test-setup.mjs scripts/print-schedule-cronjob.ts ) > "$T/runtime.json" 2> "$T/runtime.err"
rc=$?; out=$(cat "$T/runtime.err"); rc_is "print-schedule-cronjob.ts ran" 0
check "it is a CronJob" '"kind":"CronJob"' "$(cat "$T/runtime.json")"

echo "2. every CronJob — rendered and runtime — reads a Secret the chart creates"
render "${ALL[@]}"; rc=$?; out=$(cat "$T/render.err"); rc_is "chart renders with every CronJob feature on" 0
out=$(python3 scripts/tests/cronjob-secrets-check.py "$T/runtime.json" "${OWNER[@]}" < "$T/render.yaml" 2>&1); rc=$?
echo "$out" | sed 's/^/     /'
rc_is "no CronJob names a missing Secret" 0
for cj in agent-runtime-schedule-probe connections-catalog-refresh metrics-alert-evaluator pg-dump restore-drill opensearch-snapshot agent-schedule-sys-chart-test; do
  check "covered: $cj" "cronjob $cj" "$out"
done
check "the runtime CronJob reads agent-runtime-token/token" "cronjob agent-schedule-sys-chart-test [trigger] env RUNTIME_TOKEN -> agent-runtime-token/token" "$out"

echo "3. negative twin: the old catalogRefresh default (Secret os-ui) is caught"
render "${ALL[@]}" --set connections.catalogRefresh.tokenSecret=os-ui --set connections.catalogRefresh.tokenSecretKey=agent-runtime-token
out=$(python3 scripts/tests/cronjob-secrets-check.py "${OWNER[@]}" < "$T/render.yaml" 2>&1); rc=$?
rc_is "the check fails" 1
check "and names the CronJob and the missing Secret" "FAIL cronjob connections-catalog-refresh [sweep] env RUNTIME_TOKEN -> os-ui/agent-runtime-token: the chart creates no Secret 'os-ui'" "$out"

echo "4. negative twin: an owner-provided Secret is not accepted without being named"
render "${ALL[@]}"
out=$(python3 scripts/tests/cronjob-secrets-check.py < "$T/render.yaml" 2>&1); rc=$?
rc_is "the check fails" 1
check "naming metrics-alert-principal" "the chart creates no Secret 'metrics-alert-principal'" "$out"

finish cronjob-secrets-chart
