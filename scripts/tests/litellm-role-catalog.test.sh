#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# litellm-role-catalog.test.sh — the chart seeds the CATALOG under real names; the OS owns the roles.
# =============================================================================
#  * `litellm.proxy_config.model_list` (every profile) holds real model names (stackit-…), never the
#    old aliases (sovereign-default/-mock/-reasoning/-reasoning-fast/-premium/-vision/-embed) — except the
#    compatibility copies in deploy/gateway-models.yaml (dev and prod), kept for one release.
#  * the initial role mapping is a chart value (`osUI.modelRoles.seed`) whose three targets are in the
#    catalog; the shared agent key allows the three role names (so a remap needs no key change).
#  * the chart never sets `model_group_alias` (litellm-no-config-alias.test.sh).
# Negative twins: a profile that brings an old alias back, a seed pointing outside the catalog and a
# key without a role are each caught by the same checker.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
. scripts/tests/assert.sh
run() { out=$(env "$@" node scripts/check-litellm-role-catalog.mjs 2>&1); rc=$?; }
run X=1
rc_is "base, STACKIT and dev profiles: real catalog names, role seed inside the catalog, key allows the three roles" 0
for twin in old-alias seed-outside-catalog key-without-role; do
  run ROLE_CATALOG_TWIN=$twin
  if [ "$rc" -ne 0 ]; then ok "NEGATIVE TWIN $twin is caught"; else bad "NEGATIVE TWIN $twin was NOT caught" "$out"; fi
done
finish "litellm-role-catalog"
