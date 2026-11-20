#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# litellm-ingress-policy.kind.sh — LiteLLM: restrict ingress to OS components (defence in depth),
# ENFORCED by a real CNI (Calico on kind), not just rendered.
# =============================================================================
#   bash scripts/tests/litellm-ingress-policy.kind.sh [--keep]
#
# Needs docker, kind, kubectl, helm, curl. Creates the kind cluster `gwguard` from
# tests/e2e/kind/cluster.yaml (kindnet off) with Calico at the pinned, sha256-verified manifest
# (tests/e2e/kind/versions.env), deletes it on exit unless --keep. Not run in CI (it needs a
# cluster). It applies the chart's RENDERED policy only — no LiteLLM image: the policy selects by
# label, so a stand-in HTTP server carrying the gateway's pod labels on :4000 is the hop under test.
#   1. admitted: pods labelled component os-ui, os-ui-worker, litellm-key-init reach :4000;
#   2. refused:  component query-tool, an unlabelled pod, and a pod in namespace agentic-apps;
#   3. negative twin: with the policy deleted, the refused pod reaches :4000 — so the refusal in 2
#      is the policy's doing, not a broken probe.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
. scripts/tests/assert.sh
. tests/e2e/kind/versions.env
CLUSTER=gwguard
CTX=kind-$CLUSTER
KEEP=${1:-}
BUSYBOX=busybox:1.37.0
cleanup() { [ "$KEEP" = --keep ] || kind delete cluster --name "$CLUSTER" >/dev/null 2>&1; }
trap cleanup EXIT
k() { kubectl --context "$CTX" "$@"; }

if ! kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  kind create cluster --name "$CLUSTER" --config tests/e2e/kind/cluster.yaml --image "$KIND_NODE_IMAGE" || exit 2
fi
manifest=$(mktemp)
curl -fsSL "https://raw.githubusercontent.com/projectcalico/calico/${CALICO_VERSION}/manifests/calico.yaml" -o "$manifest" || exit 2
got=$( (sha256sum "$manifest" 2>/dev/null || shasum -a 256 "$manifest") | cut -d' ' -f1)
[ "$got" = "$CALICO_MANIFEST_SHA256" ] || { echo "calico manifest sha256 mismatch" >&2; exit 2; }
k apply -f "$manifest" >/dev/null && rm -f "$manifest"
k -n kube-system rollout status daemonset/calico-node --timeout=900s >/dev/null || exit 2
k wait --for=condition=Ready node --all --timeout=300s >/dev/null || exit 2

k create namespace agentic-os >/dev/null 2>&1; k create namespace agentic-apps >/dev/null 2>&1
helm template agentic-os charts/sovereign-agentic-os -n agentic-os --skip-schema-validation \
  --show-only templates/base/network/litellm-ingress-policy.yaml > /tmp/gwguard-policy.$$.yaml || exit 2
k apply -f /tmp/gwguard-policy.$$.yaml >/dev/null && rm -f /tmp/gwguard-policy.$$.yaml

# The stand-in gateway: the proxy's pod labels, HTTP on :4000, behind a Service of the chart's name.
k -n agentic-os run gw --image="$BUSYBOX" --restart=Never \
  --labels=app.kubernetes.io/name=litellm,app.kubernetes.io/instance=agentic-os \
  --command -- sh -c 'mkdir -p /w && echo ok > /w/index.html && httpd -f -p 4000 -h /w' >/dev/null
k -n agentic-os expose pod gw --name=agentic-os-litellm --port=4000 >/dev/null
k -n agentic-os wait --for=condition=Ready pod/gw --timeout=180s >/dev/null || exit 2

# probe <ns> <name> <labels|-> — 0 when the gateway answers.
probe() {
  local ns=$1 name=$2 labels=$3 args=()
  [ "$labels" = - ] || args=(--labels="$labels")
  k -n "$ns" delete pod "$name" --ignore-not-found >/dev/null 2>&1
  k -n "$ns" run "$name" --image="$BUSYBOX" --restart=Never ${args[@]+"${args[@]}"} \
    --command -- sh -c 'wget -T 4 -qO- http://agentic-os-litellm.agentic-os.svc.cluster.local:4000/ >/dev/null' >/dev/null
  for _ in $(seq 1 60); do
    phase=$(k -n "$ns" get pod "$name" -o jsonpath='{.status.phase}' 2>/dev/null)
    case $phase in Succeeded) return 0 ;; Failed) return 1 ;; esac
    sleep 2
  done
  return 2
}
expect() { # expect <reach|refuse> <label> <probe args…>
  local want=$1 label=$2; shift 2
  probe "$@"; local r=$?
  if [ "$want" = reach ]; then [ $r -eq 0 ] && ok "$label reaches :4000" || bad "$label reaches :4000" "probe rc=$r"
  else [ $r -eq 1 ] && ok "$label is refused" || bad "$label is refused" "probe rc=$r"; fi
}

echo "== admitted callers"
expect reach "os-ui"            agentic-os c-ui     app.kubernetes.io/component=os-ui
expect reach "os-ui-worker"     agentic-os c-worker app.kubernetes.io/component=os-ui-worker
expect reach "litellm-key-init" agentic-os c-key    app.kubernetes.io/component=litellm-key-init
echo "== everything else"
expect refuse "query-tool"                agentic-os   c-qt   app.kubernetes.io/component=query-tool
expect refuse "an unlabelled pod"         agentic-os   c-none -
expect refuse "an agentic-apps app pod"   agentic-apps c-app  app.kubernetes.io/component=os-ui
echo "== negative twin: without the policy the refused pod gets through"
k -n agentic-os delete networkpolicy litellm-allow-os-clients-only >/dev/null
expect reach "query-tool (policy deleted)" agentic-os c-qt2 app.kubernetes.io/component=query-tool
finish litellm-ingress-policy.kind
