#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# chart-default-secrets.test.sh — templates/base/secret-defaults-guard.yaml.
# =============================================================================
#   bash scripts/tests/chart-default-secrets.test.sh
#
# The chart refuses to render (so `helm template` and `helm upgrade` both stop before anything is
# applied) when an install that is not a laptop — an Ingress, or a profile other than local — still
# carries a published chart-default secret. Asserts:
#   * the laptop profile (values.local.yaml) and the bare chart (Ingress off) render;
#   * an Ingress with the chart defaults FAILS, naming every guarded key and printing no value;
#   * negative twins: each of the nine guarded values, left at its default while the other eight are
#     an install's own, fails and names exactly that key; an empty value fails too;
#   * an install whose every guarded value is its own renders (as the live release does);
#   * the STACKIT profile renders (its Secrets come from the store; the chart renders none of them);
#   * global.allowChartDefaultSecrets=true (test renders only) lets defaults through.
# Skips without helm or the subchart .tgz files — but FAILS when CI is set.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
. scripts/tests/assert.sh
CHART=charts/sovereign-agentic-os
skip() { if [ -n "${CI:-}" ]; then echo "chart-default-secrets: $1 — FAILING because CI is set"; exit 1; fi; echo "chart-default-secrets: $1 — SKIPPED"; exit 0; }
command -v helm >/dev/null 2>&1 || skip "helm not on PATH"
ls "$CHART"/charts/*.tgz >/dev/null 2>&1 || skip "chart dependencies not built"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
render() { out=$(helm template t "$CHART" -n agentic-os --skip-schema-validation "$@" 2>&1 >/dev/null); rc=$?; }
r() { openssl rand -hex "$1"; }
KEYS="litellmMasterKey litellmUI.password agentRuntime.token langfuseInit.publicKey langfuseInit.secretKey langfuseInit.userPassword langfuseInit.salt langfuseInit.nextauthSecret langfuseInit.encryptionKey"
own() { # an install's own values for every guarded key, except the one named in $1 (left out)
  local skipk=${1:-} k
  { echo "ingress: {enabled: true}"
    [ "$skipk" = litellmMasterKey ] || echo "litellmMasterKey: sk-$(r 16)"
    [ "$skipk" = litellmUI.password ] || echo "litellmUI: {password: ui-$(r 8)}"
    [ "$skipk" = agentRuntime.token ] || echo "agentRuntime: {token: rt-$(r 16)}"
    echo "langfuseInit:"
    for k in publicKey secretKey userPassword salt nextauthSecret; do [ "$skipk" = "langfuseInit.$k" ] || echo "  $k: x-$k-$(r 8)"; done
    [ "$skipk" = langfuseInit.encryptionKey ] || echo "  encryptionKey: $(r 32)"
  } > "$T/own.yaml"
}

echo "laptops render"
render -f values.local.yaml; rc_is "values.local.yaml (local profile, Ingress off)" 0
render; rc_is "the bare chart (local profile, Ingress off)" 0

echo "an install with an Ingress and the chart defaults"
render --set ingress.enabled=true; rc_is "FAILS" 1
check "  ... with the refusal code" "CHART_DEFAULT_SECRETS_REFUSED" "$out"
for k in $KEYS; do check "  ... naming $k" "$k" "$out"; done
for v in sk-litellm-local-dev-master langfuse-local-dev-admin sk-lf-localdev0000secret; do absent "  ... printing no value" "$v" "$out"; done

echo "negative twins: one guarded value left at its chart default"
for k in $KEYS; do
  own "$k"; render -f "$T/own.yaml"
  if [ "$rc" = 1 ] && [[ "$out" == *"$k"* ]]; then
    n=$(grep -o 'defaults: .*\. Set' <<<"$out" | tr ',' '\n' | grep -c .)
    if [ "$n" = 1 ]; then ok "$k at its default fails, naming only it"; else bad "$k: named $n keys: $out"; fi
  else bad "$k at its default did not fail on it (rc $rc): ${out:0:200}"; fi
done
own; render -f "$T/own.yaml" --set litellmMasterKey=; rc_is "an empty litellmMasterKey fails too" 1

echo "an install with its own values renders"
own; render -f "$T/own.yaml"; rc_is "every guarded value its own, Ingress on (the live release's shape)" 0
render -f values.stackit-managed.yaml; rc_is "the STACKIT profile (the chart renders none of these Secrets there)" 0
render --set ingress.enabled=true --set global.allowChartDefaultSecrets=true; rc_is "the test-render switch lets defaults through" 0

finish chart-default-secrets
