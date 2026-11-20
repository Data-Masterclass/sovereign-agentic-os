#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# =============================================================================
# dev-pod-security.kind.sh — the dev namespaces' Pod Security and the CI account's limits, on a
# REAL API server (kind), with server-side dry runs. Nothing is scheduled.
# =============================================================================
#   bash scripts/tests/dev-pod-security.kind.sh        (needs docker, kind, kubectl, helm)
#
# Applies the SAME manifests the dev scripts apply (scripts/dev/manifests/namespaces.yaml,
# ci-rbac.yaml, node-sysctl.yaml) and proves, from the API server:
#   1. a privileged pod with a hostPath and LiteLLM's label is REFUSED in agentic-os, as the
#      admin and as the CI account; the same pod in an unlabelled namespace is accepted
#      (the negative twin: the label is what refuses it);
#   2. the CI account cannot create pods in kube-system or dev-model-key, cannot change
#      namespace labels, cannot read the model-key Secret — and CAN deploy in agentic-os;
#   3. the dev chart render (values.dev.yaml), applied AS THE CI ACCOUNT with --dry-run=server,
#      is accepted and draws no baseline warning; the chart's default (privileged OpenSearch
#      sysctl init) does draw one (the twin: values.dev.yaml's sysctlInit=false matters);
#   4. the node-sysctl DaemonSet is accepted in kube-system.
# Uses its own kind cluster and kubeconfig, deleted at the end; never touches ~/.kube/config.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
# shellcheck source=scripts/tests/assert.sh
. scripts/tests/assert.sh
for b in docker kind kubectl helm; do command -v "$b" >/dev/null || { echo "$b not on PATH"; exit 2; }; done
ls charts/sovereign-agentic-os/charts/*.tgz >/dev/null 2>&1 || { echo "no subchart .tgz (helm dependency build charts/sovereign-agentic-os)"; exit 2; }
NAME=${PSS_KIND_NAME:-infra-dev-pss}
TMP=$(mktemp -d)
export KUBECONFIG=$TMP/kubeconfig
cleanup() { [ -n "${PSS_KEEP:-}" ] || kind delete cluster --name "$NAME" --kubeconfig "$KUBECONFIG" >/dev/null 2>&1; rm -rf "$TMP"; }
trap cleanup EXIT
kind create cluster --name "$NAME" --kubeconfig "$KUBECONFIG" --wait 120s >/dev/null 2>&1 || { echo "kind create failed"; exit 2; }
K() { kubectl --context "kind-$NAME" "$@"; }
SA=system:serviceaccount:sovereign-os-ci:sovereign-os-ci
M=scripts/dev/manifests

K apply -f $M/namespaces.yaml >/dev/null && K apply -f $M/ci-rbac.yaml >/dev/null || { echo "apply failed"; exit 2; }
K create namespace pss-control >/dev/null

pod() { # pod <namespace> — a privileged hostPath pod wearing LiteLLM's label
  cat <<YAML
apiVersion: v1
kind: Pod
metadata: { name: steal, namespace: $1, labels: { app.kubernetes.io/name: litellm } }
spec:
  containers:
    - name: x
      image: busybox:1.37.0
      securityContext: { privileged: true }
      volumeMounts: [{ name: host, mountPath: /host }]
  volumes: [{ name: host, hostPath: { path: / } }]
YAML
}

echo "== 1. the privileged hostPath pod"
out=$(pod agentic-os | K apply --dry-run=server -f - 2>&1); rc=$?
rc_is "REFUSED in agentic-os (admin)" 1
check "by Pod Security baseline" 'violates PodSecurity "baseline' "$out"
out=$(pod agentic-os | K apply --dry-run=server --as "$SA" -f - 2>&1); rc=$?
rc_is "REFUSED in agentic-os (the CI account)" 1
check "by Pod Security, not by RBAC" "violates PodSecurity" "$out"
out=$(pod agentic-apps | K apply --dry-run=server --as "$SA" -f - 2>&1); rc=$?
rc_is "REFUSED in agentic-apps (the CI account)" 1
out=$(pod pss-control | K apply --dry-run=server -f - 2>&1); rc=$?
rc_is "NEGATIVE TWIN: accepted in an unlabelled namespace — the label is what refuses it" 0

echo "== 2. what the CI account may and may not do"
can() { K auth can-i "$@" --as "$SA" 2>/dev/null; }
holds "it cannot create pods in kube-system" [ "$(can create pods -n kube-system)" = no ]
holds "it cannot create pods in dev-model-key" [ "$(can create pods -n dev-model-key)" = no ]
holds "it cannot read secrets in dev-model-key" [ "$(can get secrets -n dev-model-key)" = no ]
holds "it cannot patch the agentic-os namespace (its Pod Security labels)" [ "$(can patch namespace/agentic-os)" = no ]
holds "it cannot update namespaces" [ "$(can update namespaces)" = no ]
holds "it cannot create cluster role bindings" [ "$(can create clusterrolebindings)" = no ]
holds "it CAN create deployments in agentic-os" [ "$(can create deployments -n agentic-os)" = yes ]
holds "it CAN read nodes (the DEV_NODE check)" [ "$(can get nodes)" = yes ]

echo "== 3. the dev chart, applied as the CI account"
cat > "$TMP/private.yaml" <<'YAML'
osUI: { usersSeed: '[{"id":"nova-admin","email":"nova@northpeak.demo","password":"p","domains":["platform"],"role":"admin"}]' }
YAML
render() { helm template agentic-os charts/sovereign-agentic-os -n agentic-os --skip-schema-validation "$@" 2>/dev/null; }
render -f values.dev.yaml -f "$TMP/private.yaml" > "$TMP/dev.yaml"
out=$(K apply --dry-run=server --as "$SA" -n agentic-os -f "$TMP/dev.yaml" 2>&1); rc=$?
rc_is "the dev render is accepted, as the CI account" 0
# The namespace WARNS at restricted; a baseline breach would name privileged or a host path.
bad=$(printf '%s\n' "$out" | grep 'would violate PodSecurity' | grep -E 'privileged|hostPath|host namespaces' || true)
holds "and no workload would break baseline (no privileged, hostPath or host namespace): [${bad:0:300}]" [ -z "$bad" ]
render -f values.dev.yaml -f "$TMP/private.yaml" --set opensearch.sysctlInit.enabled=true > "$TMP/priv.yaml"
out=$(K apply --dry-run=server -n agentic-os -f "$TMP/priv.yaml" 2>&1)
bad=$(printf '%s\n' "$out" | grep 'would violate PodSecurity' | grep 'privileged' || true)
check "NEGATIVE TWIN: with the subchart's privileged sysctl init, OpenSearch would break baseline" 'privileged' "$bad"
check "on the OpenSearch sysctl init container" 'container "sysctl" must not set securityContext.privileged=true' "$bad"

echo "== 4. the node sysctl DaemonSet"
out=$(K apply --dry-run=server -f $M/node-sysctl.yaml 2>&1); rc=$?
rc_is "accepted in kube-system (operator)" 0
out=$(K apply --dry-run=server --as "$SA" -f $M/node-sysctl.yaml 2>&1); rc=$?
rc_is "NEGATIVE TWIN: the CI account cannot create it" 1

finish dev-pod-security.kind || exit 1
echo "DEV_POD_SECURITY_KIND_OK"
