#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# opa-strategy.test.sh — with the OPA bundle volume on, the `opa` Deployment must stay upgradable from
# a release that did not have it. That release's Deployment holds `strategy.rollingUpdate` (the API
# server's default); switching `type` to Recreate makes the upgrade's server-side apply fail with
# "spec.strategy.rollingUpdate: Forbidden: may not be specified when strategy type is Recreate"
# (seen on dev, 21 Nov 2026). The one ReadWriteOnce volume still needs the old pod gone first:
# RollingUpdate with maxSurge 0 does exactly that, with no type change.
set -uo pipefail
cd "$(dirname "$0")/../.."
. scripts/tests/assert.sh
render() { helm template agentic-os charts/sovereign-agentic-os -n agentic-os --skip-schema-validation \
  --set opa.dataBundle.enabled=true --set opa.dataBundle.persistence.enabled=true \
  --set postgres.governance.enabled=true --set postgres.governance.adminSecretName=x \
  --show-only templates/base/opa/opa.yaml 2>/dev/null; }
yaml=$(render)
[ -n "$yaml" ] || { bad "the chart renders with the bundle volume on"; finish opa-strategy.test.sh; exit $?; }
strategy=$(printf '%s' "$yaml" | python3 -c '
import sys, yaml
for d in yaml.safe_load_all(sys.stdin):
    if d and d["kind"] == "Deployment" and d["metadata"]["name"] == "opa":
        print(yaml.safe_dump(d["spec"].get("strategy"), default_flow_style=True).strip())')
echo "== bundle volume on: the strategy of the opa Deployment ($strategy)"
absent "it is not Recreate (an upgrade from RollingUpdate would be refused)" "Recreate" "$strategy"
check "the old pod goes first (maxSurge 0), so the one RWO volume is free" "maxSurge: 0" "$strategy"
check "one pod may be unavailable meanwhile" "maxUnavailable: 1" "$strategy"
finish opa-strategy.test.sh
