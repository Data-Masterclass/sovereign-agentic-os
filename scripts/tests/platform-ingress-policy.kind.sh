#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# platform-ingress-policy.kind.sh — default-deny ingress for the platform namespace plus the
# per-service allowlists, ENFORCED by a real CNI (Calico on kind), not just rendered.
# =============================================================================
#   bash scripts/tests/platform-ingress-policy.kind.sh [--keep]
#
# Needs docker, kind, kubectl, helm. Creates the kind cluster `$CLUSTER` (default `wpnetsec`) from
# tests/e2e/kind/cluster.yaml (kindnet off) with Calico at the pinned, sha256-verified manifest,
# writing its kubeconfig to $KIND_KUBECONFIG (never ~/.kube/config), and deletes it on exit
# unless --keep. CHART_DIR overrides the chart (a run against main's chart is the red run).
# It applies the chart's RENDERED policies only (platform-ingress-policies.yaml and the os-ui
# policy in os-repos.yaml). No component images: policies select by label, so stand-in HTTP
# servers carrying each service's pod labels on its port are the hops under test. The
# `agentic-apps` namespace gets NO policy of its own here, so a refusal there is the platform
# namespace's ingress side doing it.
#   1. admitted: the documented callers reach OPA, Trino, Postgres, object storage and os-ui;
#   2. refused:  an app pod in agentic-apps, a pod in another namespace, an unlabelled pod and the
#      Dagster code location/run pods (to OPA) are refused;
#   3. cert-manager's real HTTP-01 solver answers the ingress controller on :8089 and refuses an app
#      pod; without its policy default-deny cuts it off (the renewal outage it prevents);
#   4. negative twin: with the policies deleted, the app pod reaches OPA — so the refusal in 2
#      is the policy's doing, not a broken probe.
#   5. WP-05 observability (rendered ON, as in production; dev turns it off): the Collector reaches
#      VictoriaMetrics and VictoriaLogs, os-ui reaches both and the Collector's health port; a
#      Dagster run pod, an app pod and an unlabelled pod are refused at VictoriaLogs; twin: without
#      its allowlist the Collector is cut off from VictoriaLogs by default-deny.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
. scripts/tests/assert.sh
. tests/e2e/kind/versions.env
CLUSTER=${CLUSTER:-wpnetsec}
CHART=${CHART_DIR:-charts/sovereign-agentic-os}
KIND_KUBECONFIG=${KIND_KUBECONFIG:-$(mktemp -d)/kubeconfig}
export KUBECONFIG=$KIND_KUBECONFIG
CTX=kind-$CLUSTER
KEEP=${1:-}
BUSYBOX=busybox:1.37.0
cleanup() { [ "$KEEP" = --keep ] || kind delete cluster --name "$CLUSTER" --kubeconfig "$KIND_KUBECONFIG" >/dev/null 2>&1; }
trap cleanup EXIT
k() { kubectl --kubeconfig "$KIND_KUBECONFIG" --context "$CTX" "$@"; }

if ! kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  kind create cluster --name "$CLUSTER" --kubeconfig "$KIND_KUBECONFIG" --config tests/e2e/kind/cluster.yaml --image "$KIND_NODE_IMAGE" || exit 2
fi
manifest=$(mktemp)
curl -fsSL "https://raw.githubusercontent.com/projectcalico/calico/${CALICO_VERSION}/manifests/calico.yaml" -o "$manifest" || exit 2
got=$( (sha256sum "$manifest" 2>/dev/null || shasum -a 256 "$manifest") | cut -d' ' -f1)
[ "$got" = "$CALICO_MANIFEST_SHA256" ] || { echo "calico manifest sha256 mismatch" >&2; exit 2; }
k apply -f "$manifest" >/dev/null && rm -f "$manifest"
k -n kube-system rollout status daemonset/calico-node --timeout=900s >/dev/null || exit 2
k wait --for=condition=Ready node --all --timeout=300s >/dev/null || exit 2

for ns in agentic-os agentic-apps ingress-nginx other; do k create namespace "$ns" >/dev/null 2>&1; done
rendered=$(mktemp)
helm template agentic-os "$CHART" -n agentic-os --skip-schema-validation --set global.allowChartDefaultSecrets=true -f values.dev.yaml \
  --set observability.enabled=true > "$rendered" 2>/dev/null || exit 2
python3 - "$rendered" > "$rendered.np" <<'PY' || exit 2
import sys, yaml
docs = [d for d in yaml.safe_load_all(open(sys.argv[1])) if d]
print(yaml.safe_dump_all([d for d in docs if d['kind'] == 'NetworkPolicy' and d['metadata'].get('namespace') == 'agentic-os'
                          and 'Ingress' in d['spec'].get('policyTypes', [])]))
PY
k apply -n agentic-os -f "$rendered.np" >/dev/null || exit 2
rm -f "$rendered" "$rendered.np"

# serve <name> <port> <labels> — a stand-in HTTP server with the service's pod labels.
serve() {
  k -n agentic-os run "$1" --image="$BUSYBOX" --restart=Never --labels="$3" \
    --command -- sh -c "mkdir -p /w && echo ok > /w/index.html && httpd -f -p $2 -h /w" >/dev/null
  k -n agentic-os expose pod "$1" --port="$2" >/dev/null
}
serve opa 8181 app.kubernetes.io/component=opa,app.kubernetes.io/name=opa,app.kubernetes.io/instance=agentic-os
serve trino 8080 app.kubernetes.io/component=trino,app.kubernetes.io/name=trino,app.kubernetes.io/instance=agentic-os
serve pg 5432 app.kubernetes.io/component=postgres,app.kubernetes.io/name=postgres,app.kubernetes.io/instance=agentic-os
serve minio 9000 app.kubernetes.io/component=object-storage,app.kubernetes.io/name=object-storage,app.kubernetes.io/instance=agentic-os
serve os-ui 3000 app.kubernetes.io/component=os-ui,app.kubernetes.io/name=os-ui,app.kubernetes.io/instance=agentic-os
serve victoria-metrics 8428 app.kubernetes.io/component=victoria-metrics,app.kubernetes.io/name=victoria-metrics,app.kubernetes.io/instance=agentic-os
serve victoria-logs 9428 app.kubernetes.io/component=victoria-logs,app.kubernetes.io/name=victoria-logs,app.kubernetes.io/instance=agentic-os
serve otel-collector 13133 app.kubernetes.io/component=otel-collector,app.kubernetes.io/name=otel-collector,app.kubernetes.io/instance=agentic-os
k -n agentic-os wait --for=condition=Ready pod/opa pod/trino pod/pg pod/minio pod/os-ui pod/victoria-metrics pod/victoria-logs pod/otel-collector --timeout=180s >/dev/null || exit 2

n=0
# probe <ns> <labels|-> <svc> <port> — 0 when the stand-in answers, 1 when refused/timed out.
probe() {
  local ns=$1 labels=$2 svc=$3 port=$4 args=() name
  n=$((n + 1)); name=c$n
  [ "$labels" = - ] || args=(--labels="$labels")
  k -n "$ns" run "$name" --image="$BUSYBOX" --restart=Never ${args[@]+"${args[@]}"} \
    --command -- sh -c "wget -T 4 -qO- http://$svc.agentic-os.svc.cluster.local:$port/ >/dev/null" >/dev/null
  for _ in $(seq 1 60); do
    phase=$(k -n "$ns" get pod "$name" -o jsonpath='{.status.phase}' 2>/dev/null)
    case $phase in Succeeded) return 0 ;; Failed) return 1 ;; esac
    sleep 2
  done
  return 2
}
expect() { # expect <reach|refuse> <label> <ns> <labels> <svc> <port>
  local want=$1 label=$2; shift 2
  probe "$@"; local r=$?
  if [ "$want" = reach ]; then [ $r -eq 0 ] && ok "$label reaches $3:$4" || bad "$label reaches $3:$4" "probe rc=$r"
  else [ $r -eq 1 ] && ok "$label is refused at $3:$4" || bad "$label is refused at $3:$4" "probe rc=$r"; fi
}
UI=app.kubernetes.io/component=os-ui
echo "== documented callers are admitted"
expect reach  "os-ui"                     agentic-os "$UI" opa 8181
expect reach  "os-ui-worker"              agentic-os app.kubernetes.io/component=os-ui-worker trino 8080
expect reach  "web-fetch"                 agentic-os app.kubernetes.io/component=web-fetch opa 8181
expect reach  "trino"                     agentic-os app.kubernetes.io/component=trino opa 8181
expect reach  "query-tool"                agentic-os app.kubernetes.io/component=query-tool trino 8080
expect reach  "a Dagster run pod"         agentic-os component=user-deployments,dagster/run-id=r1 trino 8080
expect reach  "a Dagster run pod"         agentic-os component=user-deployments,dagster/run-id=r2 pg 5432
expect reach  "polaris (JDBC metastore)"  agentic-os app.kubernetes.io/component=polaris pg 5432
expect reach  "langfuse"                  agentic-os app.kubernetes.io/name=langfuse,app.kubernetes.io/instance=agentic-os,app.kubernetes.io/component=worker minio 9000
expect reach  "the ingress controller"    ingress-nginx app.kubernetes.io/name=ingress-nginx os-ui 3000
expect reach  "an agent schedule pod"     agentic-os app.kubernetes.io/component=agent-schedule os-ui 3000
echo "== everything else is refused"
expect refuse "an agentic-apps app pod"   agentic-apps app.kubernetes.io/component=software-runner opa 8181
expect refuse "an agentic-apps app pod"   agentic-apps app.kubernetes.io/component=software-runner trino 8080
expect refuse "an agentic-apps app pod"   agentic-apps app.kubernetes.io/component=software-runner pg 5432
expect refuse "an agentic-apps app pod"   agentic-apps app.kubernetes.io/component=software-runner os-ui 3000
expect refuse "an app pod labelled os-ui" agentic-apps "$UI" opa 8181
expect refuse "a pod in another namespace" other - pg 5432
expect refuse "a pod in another namespace" other - trino 8080
expect refuse "an unlisted platform pod (docling)" agentic-os app.kubernetes.io/component=docling trino 8080
expect refuse "an unlabelled pod"         agentic-os - trino 8080
expect refuse "the ingress controller"    ingress-nginx app.kubernetes.io/name=ingress-nginx opa 8181
expect refuse "a Dagster run pod"         agentic-os component=user-deployments,dagster/run-id=r3 opa 8181
expect refuse "an unlabelled pod"         agentic-os - opa 8181
expect refuse "an unlabelled pod"         agentic-os - minio 9000
echo "== cert-manager's HTTP-01 solver (the real acmesolver, cert-manager v1.16.1 as on STACKIT)"
# The solver answers /.well-known/acme-challenge/<token> with the key, for its --domain only.
ACMESOLVER=quay.io/jetstack/cert-manager-acmesolver:v1.16.1@sha256:14304826ab1a1184e185f952ef7e0bf8e620568b5c17939179efe6f4c6049d8e
k -n agentic-os run acme-solver --image="$ACMESOLVER" --restart=Never --labels=acme.cert-manager.io/http01-solver=true \
  -- --listen-port=8089 --domain=renew.example --token=tok123 --key=tok123.keyauth >/dev/null
k -n agentic-os expose pod acme-solver --port=8089 >/dev/null
k -n agentic-os wait --for=condition=Ready pod/acme-solver --timeout=180s >/dev/null || bad "acme solver pod ready"
acme() { # acme <ns> <labels> — 0 when the solver returns the key authorization
  local ns=$1 name=a$RANDOM; n=$((n + 1))
  k -n "$ns" run "$name" --image="$BUSYBOX" --restart=Never --labels="$2" --command -- sh -c \
    'wget -T 4 -qO- --header "Host: renew.example" http://acme-solver.agentic-os.svc.cluster.local:8089/.well-known/acme-challenge/tok123 | grep -q tok123.keyauth' >/dev/null
  for _ in $(seq 1 60); do
    phase=$(k -n "$ns" get pod "$name" -o jsonpath='{.status.phase}' 2>/dev/null)
    case $phase in Succeeded) return 0 ;; Failed) return 1 ;; esac
    sleep 2
  done
  return 2
}
acme ingress-nginx app.kubernetes.io/name=ingress-nginx && ok "the ingress controller reaches the HTTP-01 solver (challenge answered)" || bad "the ingress controller reaches the HTTP-01 solver"
acme agentic-apps app.kubernetes.io/component=software-runner; [ $? -eq 1 ] && ok "an app pod is refused at the HTTP-01 solver" || bad "an app pod is refused at the HTTP-01 solver"
k -n agentic-os delete networkpolicy acme-http01-solver-allow-controller >/dev/null
acme ingress-nginx app.kubernetes.io/name=ingress-nginx; [ $? -eq 1 ] && ok "twin: without its policy the solver is cut off by default-deny (renewals would fail)" || bad "twin: solver cut off without its policy"
echo "== WP-05 observability under default-deny"
COL=app.kubernetes.io/component=otel-collector
expect reach  "the OTel Collector"        agentic-os "$COL" victoria-metrics 8428
expect reach  "the OTel Collector"        agentic-os "$COL" victoria-logs 9428
expect reach  "os-ui"                     agentic-os "$UI" victoria-metrics 8428
expect reach  "os-ui"                     agentic-os "$UI" victoria-logs 9428
expect reach  "os-ui"                     agentic-os "$UI" otel-collector 13133
expect refuse "a Dagster run pod"         agentic-os component=user-deployments,dagster/run-id=r4 victoria-logs 9428
expect refuse "an agentic-apps app pod"   agentic-apps app.kubernetes.io/component=software-runner victoria-logs 9428
expect refuse "an unlabelled pod"         agentic-os - otel-collector 13133
k -n agentic-os delete networkpolicy victoria-logs-allow-collector-and-os-ui >/dev/null
expect refuse "twin: the OTel Collector without its allowlist" agentic-os "$COL" victoria-logs 9428
echo "== negative twin: without the policies the app pod gets through"
k -n agentic-os delete networkpolicy default-deny-ingress opa-allow-callers >/dev/null
expect reach  "an agentic-apps app pod (policies deleted)" agentic-apps app.kubernetes.io/component=software-runner opa 8181
finish platform-ingress-policy.kind
