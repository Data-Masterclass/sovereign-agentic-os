#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# same-origin-chart.test.sh — the origins os-ui accepts come from configuration only.
# =============================================================================
#   bash scripts/tests/same-origin-chart.test.sh
#
# Renders the chart (no cluster) and asserts:
#   * with osUI.publicUrl + both OS UI hosts, os-ui gets OS_PUBLIC_URL_ALIASES = the OTHER host;
#   * negative twin: with ingress.redirectAliasToPublicUrl the alias never reaches os-ui → no aliases;
#   * the metrics alert CronJob states Origin = the configured public URL (not its in-cluster URL);
#   * negative twin: without a public URL the CronJob falls back to the in-cluster origin.
# Skips (exit 0) without helm or the subchart .tgz files — but FAILS when CI is set.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
. scripts/tests/assert.sh
CHART=charts/sovereign-agentic-os
skip() {
  if [ -n "${CI:-}" ]; then echo "same-origin-chart: $1 — FAILING because CI is set"; exit 1; fi
  echo "same-origin-chart: $1 — SKIPPED"; exit 0
}
command -v helm >/dev/null 2>&1 || skip "helm not on PATH"
ls "$CHART"/charts/*.tgz >/dev/null 2>&1 || skip "chart dependencies not built"
render() { out=$(helm template t "$CHART" "$@" 2>/dev/null); rc=$?; }
HOSTS=(--set osUI.publicUrl=https://agentic.example.test --set ingress.hosts.osUI=os.agentic.example.test --set ingress.hosts.osUIApex=agentic.example.test)

echo "1. aliases from the ingress hosts"
render "${HOSTS[@]}" --show-only templates/base/os-ui/os-ui.yaml
rc_is "renders" 0
env=$(printf '%s\n' "$out" | grep -A1 -- '- name: OS_PUBLIC_URL_ALIASES')
check "alias = the other OS UI host" 'value: "https://os.agentic.example.test"' "$env"
absent "the public URL itself is not an alias" 'https://agentic.example.test"' "$env"

echo "2. negative twin: alias redirected at the ingress → no aliases"
render "${HOSTS[@]}" --set ingress.redirectAliasToPublicUrl=true --show-only templates/base/os-ui/os-ui.yaml
absent "no OS_PUBLIC_URL_ALIASES" "OS_PUBLIC_URL_ALIASES" "$out"

echo "3. the alert CronJob states the configured public origin"
render "${HOSTS[@]}" --set metrics.alerts.cron.enabled=true --show-only templates/extensions/metrics/metrics-alert-cronjob.yaml
pub=$(printf '%s\n' "$out" | grep -A1 -- '- name: OS_ORIGIN')
check "OS_ORIGIN = public URL" 'value: "https://agentic.example.test"' "$pub"
check "Origin header uses OS_ORIGIN" 'Origin: $OS_ORIGIN' "$out"

echo "4. negative twin: no public URL → the in-cluster origin"
render --set metrics.alerts.cron.enabled=true --show-only templates/extensions/metrics/metrics-alert-cronjob.yaml
pub=$(printf '%s\n' "$out" | grep -A1 -- '- name: OS_ORIGIN')
check "OS_ORIGIN = in-cluster os-ui" 'value: "http://os-ui:3000"' "$pub"

finish same-origin-chart
