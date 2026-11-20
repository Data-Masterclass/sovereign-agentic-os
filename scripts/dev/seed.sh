#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# =============================================================================
# seed.sh — load the SYNTHETIC demo into dev: the Northpeak case study and its demo domains.
# =============================================================================
#   scripts/dev/seed.sh
#
# Synthetic only. The gold mart is generated in SQL by the chart's northpeak-marts-init hook
# (values.dev.yaml marts.enabled). This script then runs seed/ecommerce (the Northpeak cast in
# the domains platform, sales, marketing, ops) through the OS's governed API, exactly as its
# README describes, as the demo users bootstrap-secrets.sh generated. Idempotent (the seed
# reuses what exists). Dev cluster only.
. "$(dirname "$0")/lib.sh"
require_marked_dev
k -n "$NS" get secret northpeak-seed-credentials >/dev/null || die "run scripts/dev/bootstrap-secrets.sh first"
k -n "$NS" rollout status deploy/os-ui --timeout=10m

say "Northpeak seed (seed/ecommerce)"
k -n "$NS" create configmap northpeak-seed \
  --from-file=seed.mjs="$REPO_ROOT/seed/ecommerce/seed.mjs" \
  --from-file=client.mjs="$REPO_ROOT/seed/ecommerce/lib/client.mjs" \
  --from-file=narrative.mjs="$REPO_ROOT/seed/ecommerce/lib/narrative.mjs" \
  --dry-run=client -o yaml | k -n "$NS" apply -f - >/dev/null
k -n "$NS" delete job northpeak-seed --ignore-not-found >/dev/null
k -n "$NS" apply -f "$REPO_ROOT/seed/ecommerce/k8s/job.yaml" >/dev/null
k -n "$NS" wait --for=condition=complete job/northpeak-seed --timeout=30m \
  || { k -n "$NS" logs job/northpeak-seed --tail=40 || true; die "the Northpeak seed did not complete"; }
k -n "$NS" logs job/northpeak-seed --tail=5
echo "SEED_OK context=$CTX"
