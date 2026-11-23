#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# gateway-config-models.test.sh — dev and production render NO config-file gateway models; the platform's
# provider hosts come from git and are JOINED to the operator's.
# =============================================================================
#  * scripts/check-gateway-config-models.mjs passes on the committed files (merged AND rendered by helm);
#  * each planted fault fails it: a dev values file with its own model_list, a non-empty list in the file,
#    deploy.sh layering VALUES_OVERLAY or another file after it, the file setting an operator key, a model
#    list that arrives after it;
#  * rendered: an operator's llmProviders.allowHosts AND the chart's llmProviders.platformHosts
#    (api.lyceum.technology) both reach the egress allowlist (proxy filter and os-ui's LLM_EGRESS_ALLOWLIST).
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
. scripts/tests/assert.sh
run() { out=$(env "$@" node scripts/check-gateway-config-models.mjs 2>&1); rc=$?; }
run X=1
rc_is "dev and prod render no config models (merge + helm render)" 0
for twin in dev-list list-not-empty catalog-not-last overlay-after-catalog operator-key late-model; do
  run PARITY_TWIN=$twin
  if [ "$rc" -ne 0 ]; then ok "NEGATIVE TWIN $twin is caught"; else bad "NEGATIVE TWIN $twin was NOT caught" "$out"; fi
done

if ! command -v helm >/dev/null || ! ls charts/sovereign-agentic-os/charts/*.tgz >/dev/null 2>&1; then
  if [ -n "${CI:-}" ]; then bad "helm + chart dependencies available" "run helm dependency build charts/sovereign-agentic-os"; else echo "  SKIP render checks (no helm or no chart dependencies)"; fi
  finish "gateway-config-models"; exit $?
fi
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
printf 'llmProviders:\n  allowHosts: [operator-provider.example.test]\n' > "$TMP/operator.yaml"
out=$(helm template agentic-os charts/sovereign-agentic-os -n agentic-os -f "$TMP/operator.yaml" -f deploy/gateway-no-config-models.yaml \
      --set global.allowChartDefaultSecrets=true --skip-schema-validation 2>&1); rc=$?
rc_is "operator values + the no-config-models file render" 0
egress=$(printf '%s\n' "$out" | grep -A1 'name: LLM_EGRESS_ALLOWLIST' | tail -1)
check "the operator's provider host stays on the egress allowlist" "operator-provider.example.test" "$egress"
check "the chart's Lyceum host joins it (platformHosts)" "api.lyceum.technology" "$egress"
finish "gateway-config-models"
