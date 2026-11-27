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
# The App Builder's os-ui Roles are operator-applied on dev (createOsUiRoles: false), as the admin, BEFORE the CI deploy.
K apply -f $M/app-builder-roles.yaml >/dev/null || { echo "apply of app-builder-roles.yaml failed"; exit 2; }
# So is os-ui's Role in the software scanner's namespace (osUI.software.scanner.createOsUiRoles: false).
K apply -f $M/scanner-roles.yaml >/dev/null || { echo "apply of scanner-roles.yaml failed"; exit 2; }
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
holds "it CAN manage secrets in agentic-os-conn-secrets (the credential store's Role needs it)" [ "$(can create secrets -n agentic-os-conn-secrets)" = yes ]
holds "it CAN create roles in agentic-os-conn-secrets" [ "$(can create roles -n agentic-os-conn-secrets)" = yes ]
holds "it cannot create pods in agentic-os-conn-secrets" [ "$(can create pods -n agentic-os-conn-secrets)" = no ]
holds "it CAN update the chart's own admission policy" [ "$(can update validatingadmissionpolicies/agentic-os-dagster-run-pod-shape)" = yes ]
holds "it CAN update the App Builder's admission policy (H)" [ "$(can update validatingadmissionpolicies/sovereign-os-app-env-prod-objects)" = yes ]
holds "it CAN update the build pod's admission policy (#398)" [ "$(can update validatingadmissionpolicies/app-checks-build-pod)" = yes ]
holds "it CAN create NetworkPolicies, quotas and limit ranges in apps-dev (H)" [ "$(can create networkpolicies.networking.k8s.io -n apps-dev)/$(can create resourcequotas -n apps-dev)/$(can create limitranges -n apps-dev)" = yes/yes/yes ]
for ns in apps-dev apps-prod; do
  for what in pods deployments.apps secrets configmaps services roles.rbac.authorization.k8s.io rolebindings.rbac.authorization.k8s.io; do
    holds "it cannot create $what in $ns (H)" [ "$(can create "$what" -n "$ns")" = no ]
  done
  holds "it cannot get, list or watch Secrets in $ns (H)" [ "$(can get secrets -n "$ns")/$(can list secrets -n "$ns")/$(can watch secrets -n "$ns")" = no/no/no ]
  holds "it cannot exec into pods, escalate or bind in $ns (H)" [ "$(can create pods/exec -n "$ns")/$(can escalate roles -n "$ns")/$(can bind roles/os-ui-app-env -n "$ns")" = no/no/no ]
done
holds "it CAN create NetworkPolicies in agentic-os-scans (the scanner namespace)" [ "$(can create networkpolicies.networking.k8s.io -n agentic-os-scans)" = yes ]
for what in pods jobs.batch secrets roles.rbac.authorization.k8s.io rolebindings.rbac.authorization.k8s.io; do
  holds "it cannot create $what in agentic-os-scans" [ "$(can create "$what" -n agentic-os-scans)" = no ]
done
holds "it CAN update the scanner's admission policy" [ "$(can update validatingadmissionpolicies/agentic-os-software-scanner-shape)" = yes ]
holds "it cannot patch the apps-prod namespace (its Pod Security labels)" [ "$(can patch namespace/apps-prod)" = no ]
holds "it cannot delete any other admission policy" [ "$(can delete validatingadmissionpolicies/some-other-policy)" = no ]
holds "it cannot delete any other admission policy binding" [ "$(can delete validatingadmissionpolicybindings/some-other-binding)" = no ]

echo "== 3. the dev chart, applied as the CI account"
cat > "$TMP/private.yaml" <<'YAML'
osUI: { usersSeed: '[{"id":"nova-admin","email":"nova@northpeak.demo","password":"p","domains":["platform"],"role":"admin"}]' }
YAML
# A pod-security render, not a secrets test: the overlay keeps the chart's default secrets, which the
# chart refuses for an install with an Ingress (secret-defaults-guard.yaml) — allowed for this render.
render() { helm template agentic-os charts/sovereign-agentic-os -n agentic-os --skip-schema-validation --set global.allowChartDefaultSecrets=true "$@" 2>/dev/null; }
# The render spans several namespaces: agentic-os, the connection-credential store's
# agentic-os-conn-secrets (its Role + RoleBinding) and the App Builder's apps-dev / apps-prod (quota, limit
# range, NetworkPolicies, os-ui's Role; values.dev.yaml softwareRunner.environments with createNamespaces false).
# `kubectl apply -n X` refuses an object whose own namespace differs (Helm does not), so split the render by
# metadata.namespace and apply each part to its own namespace — as the CI account, which is what helm does on dev.
CS=agentic-os-conn-secrets
SIDE_NS="$CS apps-dev apps-prod agentic-os-scans"
split_ns() { # split_ns <render> — writes <render>.main (everything else) and <render>.<ns> per namespace of $SIDE_NS
  for n in $SIDE_NS; do : > "$1.$n"; done
  awk -v base="$1" -v side="$SIDE_NS" '
    BEGIN { n = split(side, names, " ") }
    function flush() { if (doc != "") { printf "%s", doc > (tgt != "" ? base "." tgt : base ".main") }; doc = ""; tgt = "" }
    /^---/ { flush(); doc = $0 "\n"; next }
    { doc = doc $0 "\n"; for (i = 1; i <= n; i++) if ($0 == "  namespace: " names[i]) tgt = names[i] }
    END { flush() }' "$1"
}
# The side parts are applied FOR REAL (this throwaway cluster only): a RoleBinding's RBAC escalation check
# resolves its roleRef, which a dry-run Role never creates — helm applies the Role first, and so do we.
dry_as_ci() { # dry_as_ci <render> — every part as the CI account (main: server dry run); sets out and rc
  split_ns "$1"
  local o r n
  o=$(K apply --dry-run=server --as "$SA" -n agentic-os -f "$1.main" 2>&1); rc=$?
  out="$o"
  for n in $SIDE_NS; do
    [ -s "$1.$n" ] || continue
    o=$(K apply --as "$SA" -n "$n" -f "$1.$n" 2>&1); r=$?
    out=$(printf '%s\n%s\n' "$out" "$o"); rc=$(( rc || r ))
  done
}
render -f values.dev.yaml -f "$TMP/private.yaml" > "$TMP/dev.yaml"
dry_as_ci "$TMP/dev.yaml"
rc_is "the dev render is accepted, as the CI account" 0
check "including the credential store's Role in $CS" "role.rbac.authorization.k8s.io/os-ui-connection-secrets created" "$out"
check "and its RoleBinding (the RBAC escalation check passes as the CI account)" "rolebinding.rbac.authorization.k8s.io/os-ui-connection-secrets created" "$out"
absent "the dev render does not create the $CS namespace (operator-owned on dev)" "namespace/$CS" "$out"
# App Builder on dev (H): the env namespaces are operator-owned too; the chart's objects inside them and its admission
# policies are accepted as the CI account.
absent "the dev render does not create the apps-dev namespace (operator-owned on dev)" "namespace/apps-dev" "$out"
absent "the dev render does not carry os-ui's Roles there (operator-applied: createOsUiRoles false)" "role.rbac.authorization.k8s.io/os-ui-app-env" "$out"
check "the App Builder's NetworkPolicies in apps-dev are created as the CI account" "networkpolicy.networking.k8s.io/app-env-default-deny created" "$out"
holds "os-ui's Role in apps-dev is there (the operator's manifest)" K -n apps-dev get role os-ui-app-env -o name
absent "the dev render does not create the agentic-os-scans namespace (operator-owned on dev)" "namespace/agentic-os-scans" "$out"
absent "the dev render does not carry os-ui's scanner Role (operator-applied: createOsUiRoles false)" "role.rbac.authorization.k8s.io/os-ui-software-scanner" "$out"
check "the scanner's NetworkPolicies in agentic-os-scans are created as the CI account" "networkpolicy.networking.k8s.io/software-scanner-default-deny created" "$out"
check "the scanner admission policy is accepted as the CI account" "validatingadmissionpolicy.admissionregistration.k8s.io/agentic-os-software-scanner-shape" "$out"
holds "os-ui's scanner Role is there (the operator's manifest)" K -n agentic-os-scans get role os-ui-software-scanner -o name
check "the App Builder admission policy is accepted as the CI account" "validatingadmissionpolicy.admissionregistration.k8s.io/sovereign-os-app-env-dev-objects created" "$out"
# The namespace WARNS at restricted; a baseline breach would name privileged or a host path.
bad=$(printf '%s\n' "$out" | grep 'would violate PodSecurity' | grep -E 'privileged|hostPath|host namespaces' || true)
holds "and no workload would break baseline (no privileged, hostPath or host namespace): [${bad:0:300}]" [ -z "$bad" ]
render -f values.dev.yaml -f "$TMP/private.yaml" --set opensearch.sysctlInit.enabled=true > "$TMP/priv.yaml"
split_ns "$TMP/priv.yaml"
out=$(K apply --dry-run=server -n agentic-os -f "$TMP/priv.yaml.main" 2>&1)
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
