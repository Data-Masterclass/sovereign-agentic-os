#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# =============================================================================
# bootstrap-local.sh — cluster-scoped operators the OS chart depends on.
# =============================================================================
# Mirrors stackit.md §2 ("In-cluster platform — bootstrap, before the OS chart"),
# scoped to what the local agent-core slice needs. Operators (CRDs + admission
# webhooks) must exist before the umbrella chart's CRs are applied, so they live
# here rather than inside the umbrella release (avoids a webhook-readiness race).
#
# Idempotent: safe to re-run. Local/kind only.
#
# Usage:  ./scripts/bootstrap-local.sh
# =============================================================================
set -euo pipefail

# --- pinned versions -------------------------------------------------------
CNPG_CHART_VERSION="0.28.3"     # CloudNativePG operator (app v1.29.1)

# The default Postgres engine is `plain` (a self-contained StatefulSet, no K8s-API
# dependency), so NO cluster-scoped operator is required for the local slice — the
# OS chart renders everything it needs. The CNPG operator is only needed for the
# opt-in engine:cnpg path; install it with BOOTSTRAP_CNPG=true.
BOOTSTRAP_CNPG="${BOOTSTRAP_CNPG:-false}"

if [ "${BOOTSTRAP_CNPG}" != "true" ]; then
  echo "==> Postgres engine = plain (default): no operator bootstrap needed."
  echo "    (Set BOOTSTRAP_CNPG=true to install the CloudNativePG operator for engine:cnpg.)"
  echo "==> Bootstrap complete."
  echo "Now install the OS chart:  helm install agentic-os charts/sovereign-agentic-os -n agentic-os --create-namespace -f values.local.yaml"
  exit 0
fi

echo "==> Adding/refreshing Helm repos"
helm repo add cnpg https://cloudnative-pg.github.io/charts >/dev/null 2>&1 || true
helm repo update >/dev/null

echo "==> Installing CloudNativePG operator (chart ${CNPG_CHART_VERSION})"
helm upgrade --install cnpg cnpg/cloudnative-pg \
  --version "${CNPG_CHART_VERSION}" \
  --namespace cnpg-system --create-namespace \
  --wait --timeout 5m

echo "==> Waiting for the CNPG operator + webhook to be ready"
kubectl -n cnpg-system rollout status deploy/cnpg-cloudnative-pg --timeout=180s

echo "==> Bootstrap complete. Cluster-scoped operators are ready:"
kubectl get crd clusters.postgresql.cnpg.io >/dev/null 2>&1 \
  && echo "    - postgresql.cnpg.io/Cluster CRD present"
echo "Now install the OS chart (with postgres.engine=cnpg):  helm install agentic-os charts/sovereign-agentic-os -n agentic-os --create-namespace -f values.local.yaml --set postgres.engine=cnpg"
