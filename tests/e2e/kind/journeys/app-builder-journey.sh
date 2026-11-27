#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# FEATURE: App Builder (workstream H) - the kind end-to-end journey: requirement → agreed story → push with a story
#   ref → criteria lights → automatic Dev release + preview slot → Domain go-live approved by a domain admin (never the
#   requester) → Prod → rollback, with the live pin following Prod.
# USER STORY: As the owner I want the App Builder's whole path proven on a real API server with the chart's own
#   namespaces, Roles and admission policies, in CI, without a builder (CI has no build pool and no gated builder digest).
# ARCHITECTURE: its own kind cluster (pinned node image; kindnet enforces NetworkPolicy) and kubeconfig, never
#   ~/.kube/config. A local OCI registry the node pulls from (kind's documented local-registry setup, shared with
#   tests/app-databases/migrate-image.sh, which also builds the PREBUILT test image: the nextjs-web@2 template's `run`
#   stage, built once by the runner's Docker - no BuildKit in the cluster). The chart is rendered with the App Builder
#   switch on and applied: software-apps-envs.yaml (apps-dev/apps-prod, Pod Security restricted, default-deny, quotas,
#   os-ui's Role, the admission policies) and software-app-databases-rbac.yaml (os-ui's env rights and policies).
#   The registry pull identity Secret `zot-pull` and os-ui's right to read it (the chart grants both in
#   software-registry.yaml, which renders only with a gated builder) are created here. os-ui's own code runs in the test
#   process with the os-ui ServiceAccount's token, so every Kubernetes call goes through the chart's RBAC.
#   OPTIONAL: AB_JOURNEY_APPDB=1 installs the pinned CloudNativePG operator (scripts/cnpg/install.sh) and renders the
#   app databases (mode cnpg, the candidate operand of scripts/cnpg/versions.env - a TEST of the pending owner decision):
#   the Dev release then runs the template's migrations from the release image.
#   Usage: bash tests/e2e/kind/journeys/app-builder-journey.sh      (needs docker, kind, kubectl, helm, node >= 22, git;
#          `npm --prefix os-ui ci` and `helm dependency build charts/sovereign-agentic-os` first)
#   KEEP=1 leaves the cluster and the registry up; AB_KIND_NAME names the cluster (default ab-journey).
set -euo pipefail
root="$(cd "$(dirname "$0")/../../../.." && pwd)"
NAME="${AB_KIND_NAME:-ab-journey}"
DIR="${AB_JOURNEY_DIR:-$(mktemp -d "${RUNNER_TEMP:-$HOME}/.ab-journey.XXXXXX")}"
KCFG="$DIR/kubeconfig"
SA_DIR="$DIR/sa"
APPDB="${AB_JOURNEY_APPDB:-0}"
for b in docker kind kubectl helm node git; do command -v "$b" >/dev/null || { echo "$b not on PATH" >&2; exit 2; }; done
ls "$root"/charts/sovereign-agentic-os/charts/*.tgz >/dev/null 2>&1 || { echo "no subchart .tgz (helm dependency build charts/sovereign-agentic-os)" >&2; exit 2; }
# shellcheck source=/dev/null
. "$root/tests/e2e/kind/versions.env"
k() { kubectl --kubeconfig "$KCFG" "$@"; }

cleanup() {
  rc=$?
  if [ "$rc" != 0 ] && [ -s "$KCFG" ]; then
    echo "--- diagnostics (exit $rc)" >&2
    for ns in apps-dev apps-prod; do
      k -n "$ns" get deploy,rs,pods,svc,ingress,secrets,configmaps -o wide >&2 2>&1 || true
      k -n "$ns" get events --sort-by=.lastTimestamp 2>&1 | tail -40 >&2 || true
    done
  fi
  if [ "${KEEP:-}" != "1" ]; then
    kind delete cluster --name "$NAME" >/dev/null 2>&1 || true
    docker rm -f kind-registry >/dev/null 2>&1 || true
    rm -rf "$DIR"
  else
    echo "KEEP=1: cluster $NAME, kubeconfig $KCFG" >&2
  fi
}
trap cleanup EXIT

echo "== 1. kind cluster $NAME (${KIND_NODE_IMAGE%@*})"
mkdir -p "$DIR" "$SA_DIR"
cat >"$DIR/cluster.yaml" <<'YAML'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
# The local registry (kind's documented setup): containerd reads per-host config from certs.d.
containerdConfigPatches:
  - |-
    [plugins."io.containerd.grpc.v1.cri".registry]
      config_path = "/etc/containerd/certs.d"
YAML
kind create cluster --name "$NAME" --image "$KIND_NODE_IMAGE" --config "$DIR/cluster.yaml" --kubeconfig "$KCFG" --wait 180s

echo "== 2. the prebuilt test image (nextjs-web@2 'run' stage; local registry localhost:5001)"
ref="$(bash "$root/tests/app-databases/migrate-image.sh" "$NAME" run)"
base="localhost:5001/appdb-run:test"
echo "built $ref (local tag $base)"

echo "== 3. App Builder objects from the chart (switch on${APPDB:+, app databases: $APPDB})"
api_ip="$(k get endpointslice -n default -l kubernetes.io/service-name=kubernetes -o jsonpath='{.items[0].endpoints[0].addresses[0]}')"
svc_ip="$(k get svc kubernetes -n default -o jsonpath='{.spec.clusterIP}')"
k create namespace agentic-os --dry-run=client -o yaml | k apply -f - >/dev/null
k -n agentic-os create serviceaccount os-ui --dry-run=client -o yaml | k apply -f - >/dev/null
db_args=()
if [ "$APPDB" = "1" ]; then
  # shellcheck source=/dev/null
  . "$root/scripts/cnpg/versions.env"
  bash "$root/scripts/cnpg/install.sh" --kubeconfig "$KCFG"
  db_args=(--set osUI.software.databases.mode=cnpg --set "osUI.software.databases.imageName=${CNPG_OPERAND_CANDIDATE}"
    --set osUI.software.databases.storage.size=1Gi --set "osUI.software.databases.jobImagePrefix=localhost:5001/apps/"
    --set osUI.software.databases.resources.requests.cpu=20m --set osUI.software.databases.resources.requests.memory=128Mi
    --set osUI.software.databases.resources.limits.memory=256Mi
    --api-versions postgresql.cnpg.io/v1/Cluster --show-only templates/base/os-ui/software-app-databases.yaml)
fi
helm template agentic-os "$root/charts/sovereign-agentic-os" -n agentic-os --skip-schema-validation \
  --set osUI.enabled=true --set softwareRunner.environments.enabled=true \
  --set "networkPolicies.apiserver.cidrs={${api_ip}/32}" --set "networkPolicies.apiserver.extraCidrs={${svc_ip}/32}" \
  ${db_args[@]+"${db_args[@]}"} \
  --show-only templates/base/os-ui/software-apps-envs.yaml \
  --show-only templates/base/os-ui/software-app-databases-rbac.yaml >"$DIR/chart.yaml"
k apply --server-side -f "$DIR/chart.yaml" >/dev/null
if [ "$APPDB" = "1" ]; then
  for ns in apps-dev apps-prod; do k -n "$ns" wait --for=condition=Ready cluster/apps-pg --timeout=600s; done
fi

echo "== 4. the registry pull identity os-ui reads (the chart's software-registry.yaml grant, without a builder)"
k -n agentic-os create secret generic zot-pull --from-literal=username=journey-pull --from-literal=password="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')" --dry-run=client -o yaml | k apply -f - >/dev/null
k apply -f - >/dev/null <<'YAML'
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: os-ui-zot-pull, namespace: agentic-os }
rules:
  - { apiGroups: [""], resources: ["secrets"], resourceNames: ["zot-pull"], verbs: ["get"] }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: os-ui-zot-pull, namespace: agentic-os }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: Role, name: os-ui-zot-pull }
subjects: [{ kind: ServiceAccount, name: os-ui, namespace: agentic-os }]
YAML

echo "== 5. the os-ui ServiceAccount's token for os-ui's own Kubernetes client"
k -n agentic-os create token os-ui --duration=2h >"$SA_DIR/token"
k config view --raw --minify -o jsonpath='{.clusters[0].cluster.certificate-authority-data}' | base64 -d >"$SA_DIR/ca.crt"
k config view --raw --minify -o jsonpath='{.clusters[0].cluster.server}' >"$SA_DIR/server"

echo "== 6. the journey"
cd "$root/os-ui"
AB_JOURNEY_KUBECONFIG="$KCFG" AB_JOURNEY_SA_DIR="$SA_DIR" AB_JOURNEY_BASE_IMAGE="$base" AB_JOURNEY_APPDB="$APPDB" \
  node --experimental-test-module-mocks --import ./scripts/test-setup.mjs --test --test-concurrency=1 --test-timeout=3600000 \
  tabs/software/lib/app-builder-journey.kind.test.ts
echo "APP_BUILDER_JOURNEY_OK"
