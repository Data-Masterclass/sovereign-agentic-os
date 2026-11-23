#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# gateway-catalog-parity.test.sh — dev and production render the same gateway model catalog.
# =============================================================================
#  * scripts/check-gateway-catalog-parity.mjs passes on the committed files (merged AND rendered by helm);
#  * --names prints the catalog's model names (what scripts/smoke-test.sh compares the live ConfigMap with);
#  * each planted fault fails it: a dev values file with its own model_list, a compatibility alias that
#    is not an exact copy, deploy.sh layering VALUES_OVERLAY after the catalog, a model only one
#    environment gets.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
. scripts/tests/assert.sh
run() { out=$(env "$@" node scripts/check-gateway-catalog-parity.mjs 2>&1); rc=$?; }
run X=1
rc_is "dev and prod carry the same catalog (merge + helm render)" 0
names=$(node scripts/check-gateway-catalog-parity.mjs --names)
if printf '%s\n' "$names" | grep -qx 'lyceum-kimi-k3.1-pro' && printf '%s\n' "$names" | grep -qx 'stackit-gpt-oss-20b'; then ok "--names lists the catalog"; else bad "--names lists the catalog" "$names"; fi
for twin in dev-list alias-drift catalog-not-last env-only-model; do
  run PARITY_TWIN=$twin
  if [ "$rc" -ne 0 ]; then ok "NEGATIVE TWIN $twin is caught"; else bad "NEGATIVE TWIN $twin was NOT caught" "$out"; fi
done
finish "gateway-catalog-parity"
