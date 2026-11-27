#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# FEATURE: App Builder app databases (workstream D) - a real cluster for the isolation test.
# USER STORY: As the owner I want "role A cannot connect to database B" proven against a real CloudNativePG cluster
#   with the chart's own objects, not a mock.
# ARCHITECTURE: on an EXISTING kind cluster (kindnet enforces NetworkPolicy): installs the pinned operator with
#   scripts/cnpg/install.sh, renders the chart with the App Builder switch on and mode cnpg (C1's env namespaces with
#   Pod Security restricted and default-deny, D's Clusters, NetworkPolicies, Role and admission policies) and applies
#   it; creates the os-ui ServiceAccount in agentic-os and writes a token + CA to $OUT (the test points os-ui's own
#   Kubernetes client at it with OS_K8S_SA_DIR / KUBERNETES_API, so every call runs with the chart's RBAC). The
#   operand image is the candidate in scripts/cnpg/versions.env (a TEST of the owner decision, never shipped).
#   Usage: bash tests/app-databases/up.sh <kubeconfig> <out-dir>
#   Then:  cd os-ui && APPDB_KIND_KUBECONFIG=<kubeconfig> APPDB_KIND_SA_DIR=<out-dir> node --experimental-test-module-mocks \
#            --import ./scripts/test-setup.mjs --test tabs/software/lib/appdb/appdb.kind.test.ts
set -euo pipefail
KCFG="${1:?kubeconfig}"; OUT="${2:?out dir}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=/dev/null
. "$root/scripts/cnpg/versions.env"
k() { kubectl --kubeconfig "$KCFG" "$@"; }
mkdir -p "$OUT"
bash "$root/scripts/cnpg/install.sh" --kubeconfig "$KCFG"

api_ip="$(k get endpointslice -n default -l kubernetes.io/service-name=kubernetes -o jsonpath='{.items[0].endpoints[0].addresses[0]}')"
svc_ip="$(k get svc kubernetes -n default -o jsonpath='{.spec.clusterIP}')"
k create namespace agentic-os --dry-run=client -o yaml | k apply -f - >/dev/null
k -n agentic-os create serviceaccount os-ui --dry-run=client -o yaml | k apply -f - >/dev/null
helm template agentic-os "$root/charts/sovereign-agentic-os" -n agentic-os --skip-schema-validation \
  --set osUI.enabled=true --set softwareRunner.environments.enabled=true \
  --set osUI.software.databases.mode=cnpg --set "osUI.software.databases.imageName=${CNPG_OPERAND_CANDIDATE}" \
  --set osUI.software.databases.storage.size=1Gi \
  --set osUI.software.databases.resources.requests.cpu=20m --set osUI.software.databases.resources.requests.memory=128Mi \
  --set osUI.software.databases.resources.limits.memory=256Mi \
  --set "networkPolicies.apiserver.cidrs={${api_ip}/32}" --set "networkPolicies.apiserver.extraCidrs={${svc_ip}/32}" \
  --api-versions postgresql.cnpg.io/v1/Cluster \
  --show-only templates/base/os-ui/software-apps-envs.yaml \
  --show-only templates/base/os-ui/software-app-databases.yaml \
  --show-only templates/base/os-ui/software-app-databases-rbac.yaml >"$OUT/chart.yaml"
k apply --server-side -f "$OUT/chart.yaml" >/dev/null
for ns in apps-dev apps-prod; do
  k -n "$ns" wait --for=condition=Ready cluster/apps-pg --timeout=600s
done
token="$(k -n agentic-os create token os-ui --duration=2h)"
printf '%s' "$token" >"$OUT/token"
k config view --raw --minify -o jsonpath='{.clusters[0].cluster.certificate-authority-data}' | base64 -d >"$OUT/ca.crt"
k config view --raw --minify -o jsonpath='{.clusters[0].cluster.server}' >"$OUT/server"
echo "ready: $OUT (token, ca.crt, server)"
