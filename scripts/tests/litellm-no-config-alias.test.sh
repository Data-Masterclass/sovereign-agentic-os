#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# litellm-no-config-alias.test.sh — the chart must not set router_settings.model_group_alias.
# =============================================================================
# The OS owns the role mapping (sovereign-strong / -worker / -embedding) and writes LiteLLM's
# `router_settings.model_group_alias` through the API. LiteLLM 1.109.1 REFUSES to change that key through
# `/config/update` when it is set in the config FILE ("is set in the config file and cannot be changed
# here" — measured by scripts/tests/gateway-models/run.sh), so a chart-set alias would silently disable
# the OS's remap. Default render: no alias. Negative twin: when an operator sets one, this test sees it.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
. scripts/tests/assert.sh
CHART=charts/sovereign-agentic-os
skip() { if [ -n "${CI:-}" ]; then echo "litellm-no-config-alias: $1 — FAILING because CI is set"; exit 1; fi; echo "litellm-no-config-alias: $1 — SKIPPED"; exit 0; }
command -v helm >/dev/null 2>&1 || skip "helm not on PATH"
ls "$CHART"/charts/*.tgz >/dev/null 2>&1 || skip "chart dependencies not built"
render() { out=$(helm template t "$CHART" -n agentic-os --skip-schema-validation "$@" 2>/dev/null); rc=$?; }
render
rc_is "the chart renders" 0
absent "no model_group_alias in any rendered object (the OS writes it through the API)" "model_group_alias" "$out"
render -f values.stackit-managed.yaml
absent "…nor on the STACKIT profile" "model_group_alias" "$out"
render --set 'litellm.proxy_config.router_settings.model_group_alias.x=y'
check "NEGATIVE TWIN: an operator-set alias is rendered, so this test would catch it" "model_group_alias" "$out"
finish "litellm-no-config-alias"
