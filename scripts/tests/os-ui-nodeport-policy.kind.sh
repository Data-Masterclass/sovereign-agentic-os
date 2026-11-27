#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# os-ui-nodeport-policy.kind.sh — the os-ui NodePort under default-deny ingress, on kind's own CNI.
# =============================================================================
#   bash scripts/tests/os-ui-nodeport-policy.kind.sh [--keep]
#   NODEPORT_CONTEXT=kind-x NODEPORT_NODE=x-control-plane bash scripts/tests/os-ui-nodeport-policy.kind.sh
#
# kind >= v0.24 enforces NetworkPolicy out of the box (kube-network-policies). A pilot install on kind
# found http://localhost:8080 (NodePort 30080) dead: `default-deny-ingress` dropped the NodePort traffic,
# whose source kube-proxy rewrites to a node/bridge address. Installs the chart's REAL
# platform-ingress-policies.yaml and os-ui-nodeport-policy.yaml (stub chart, nothing else), a stand-in
# os-ui pod (agnhost, :3000, label component=os-ui) and a NodePort Service, then calls the NodePort
# from a container OUTSIDE the cluster on the kind docker network (the path the port mapping takes):
#   1. RED: nodePort unset -> no allow policy -> the call is refused (proves enforcement);
#   2. GREEN: nodePort set -> os-ui-allow-nodeport renders -> the call answers;
#   3. narrow: the same pod's port 8080 (not 3000) through a second NodePort stays closed.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
. scripts/tests/assert.sh
CHART=charts/sovereign-agentic-os
NS=nodeport-test
CTX=${NODEPORT_CONTEXT:-}
NODE=${NODEPORT_NODE:-}
KCFG=${KUBECONFIG:-}
CREATED=""
T=$(mktemp -d)
AGNHOST=registry.k8s.io/e2e-test-images/agnhost:2.53
cleanup() {
  kubectl --context "$CTX" delete ns "$NS" --wait=false >/dev/null 2>&1
  [ -n "$CREATED" ] && [ "${1:-}" != --keep ] && kind delete cluster --name nodeport --kubeconfig "$KCFG" >/dev/null 2>&1
  rm -rf "$T"
}
if [ -z "$CTX" ]; then
  KCFG=$(mktemp); export KUBECONFIG=$KCFG
  kind create cluster --name nodeport --kubeconfig "$KCFG" --wait 120s >/dev/null || { echo "kind create failed"; exit 2; }
  CTX=kind-nodeport; NODE=nodeport-control-plane; CREATED=1
fi
trap 'cleanup "${1:-}"' EXIT
k() { kubectl --context "$CTX" "$@"; }

mkdir -p "$T/c/templates/base/external-secrets" "$T/c/templates/base/network"
sed '/^dependencies:/,$d' "$CHART/Chart.yaml" > "$T/c/Chart.yaml"
cp "$CHART/values.yaml" "$T/c/values.yaml"
cp "$CHART/templates/base/_helpers.tpl" "$T/c/templates/base/"
cp "$CHART/templates/base/external-secrets/_eso.tpl" "$T/c/templates/base/external-secrets/"
cp "$CHART/templates/base/network/platform-ingress-policies.yaml" "$CHART/templates/base/network/os-ui-nodeport-policy.yaml" "$T/c/templates/base/network/"

k create ns "$NS" >/dev/null
k -n "$NS" apply -f - >/dev/null <<YAML
apiVersion: v1
kind: Pod
metadata: { name: os-ui, labels: { app.kubernetes.io/component: os-ui } }
spec:
  containers:
    - { name: a, image: $AGNHOST, args: ["netexec", "--http-port=3000", "--udp-port=-1"] }
    - { name: b, image: $AGNHOST, args: ["netexec", "--http-port=8080", "--udp-port=-1"] }
---
apiVersion: v1
kind: Service
metadata: { name: os-ui }
spec:
  type: NodePort
  selector: { app.kubernetes.io/component: os-ui }
  ports:
    - { name: http, port: 3000, targetPort: 3000, nodePort: 30080 }
    - { name: other, port: 8080, targetPort: 8080, nodePort: 30081 }
YAML
k -n "$NS" wait --for=condition=Ready pod/os-ui --timeout=180s >/dev/null || { echo "stand-in os-ui pod not ready"; exit 2; }
call() { # call <nodePort> -> sets out (HTTP body or curl error)
  out=$(docker run --rm --network kind "$AGNHOST" connect --timeout=4s "$NODE:$1" 2>&1); rc=$?
}
settle() { sleep 5; }

echo "1. RED: nodePort unset, default-deny only"
helm --kube-context "$CTX" install t "$T/c" -n "$NS" --skip-schema-validation >/dev/null || { echo "install failed"; exit 2; }
holds "  no os-ui-allow-nodeport policy" bash -c "! kubectl --context $CTX -n $NS get networkpolicy os-ui-allow-nodeport >/dev/null 2>&1"
settle; call 30080
rc_is "  the NodePort is refused (kind enforces NetworkPolicy)" 1

echo "2. GREEN: nodePort set"
helm --kube-context "$CTX" upgrade t "$T/c" -n "$NS" --skip-schema-validation --set osUI.service.nodePort=30080 >/dev/null || { echo "upgrade failed"; exit 2; }
holds "  os-ui-allow-nodeport exists" bash -c "kubectl --context $CTX -n $NS get networkpolicy os-ui-allow-nodeport >/dev/null"
settle; call 30080
rc_is "  the NodePort answers on :3000" 0

echo "3. narrow: only :3000"
call 30081
rc_is "  another port of the same pod stays closed" 1
finish os-ui-nodeport-policy-kind
