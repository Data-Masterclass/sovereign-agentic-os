#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Monitoring → Software: a real Kubernetes API (kind) with the runner namespace and four app Deployments
# labelled as the OS's app runner labels them (app.kubernetes.io/name = app-<slug>, part-of = sovereign-os-apps):
#   app-healthy (runs) · app-crashy (exits 1 → CrashLoopBackOff) · app-foo / app-foo-bar (look-alike names).
# os-ui reads pods through its ServiceAccount token + CA (core/infra/k8s.ts); here a ServiceAccount with the chart's
# pod read right stands in, and its token + CA are written where `k8s()` looks (OS_K8S_SA_DIR).
#   software.kind.sh up | down
# Uses its OWN kubeconfig ($MON_SW_KUBECONFIG); never writes ~/.kube/config. Writes $MON_SW_ENV (sourceable).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/../e2e/kind/versions.env"
: "${MON_SW_CLUSTER:=monsw}"
: "${MON_SW_KUBECONFIG:?set MON_SW_KUBECONFIG to a file of its own}"
: "${MON_SW_DIR:?set MON_SW_DIR to a scratch directory}"
NS="${MON_SW_NAMESPACE:-agentic-apps}"
if [ "${1:-}" = down ]; then kind delete cluster --name "$MON_SW_CLUSTER" --kubeconfig "$MON_SW_KUBECONFIG" >/dev/null 2>&1 || true; exit 0; fi
export KUBECONFIG="$MON_SW_KUBECONFIG"
mkdir -p "$MON_SW_DIR/sa"
kind create cluster --name "$MON_SW_CLUSTER" --image "$KIND_NODE_IMAGE" --kubeconfig "$MON_SW_KUBECONFIG" --wait 120s >/dev/null
IMG=busybox:1.36
kubectl create namespace "$NS" >/dev/null
kubectl -n "$NS" create serviceaccount os-ui >/dev/null
# The chart's rule for os-ui's pod reads in the runner namespace (templates/base/os-ui/apps-runner.yaml).
kubectl -n "$NS" create role os-ui-apps-pods --verb=get,list,watch --resource=pods >/dev/null
kubectl -n "$NS" create rolebinding os-ui-apps-pods --role=os-ui-apps-pods --serviceaccount="$NS:os-ui" >/dev/null
dep() { # name, command
  cat <<YAML | kubectl -n "$NS" apply -f - >/dev/null
apiVersion: apps/v1
kind: Deployment
metadata: { name: $1, labels: { app.kubernetes.io/name: $1, app.kubernetes.io/part-of: sovereign-os-apps } }
spec:
  replicas: 1
  selector: { matchLabels: { app.kubernetes.io/name: $1 } }
  template:
    metadata: { labels: { app.kubernetes.io/name: $1, app.kubernetes.io/part-of: sovereign-os-apps } }
    spec:
      containers: [ { name: app, image: $IMG, imagePullPolicy: IfNotPresent, command: [ sh, -c, "$2" ] } ]
YAML
}
dep app-healthy 'sleep 3600'
dep app-foo 'sleep 3600'
dep app-foo-bar 'sleep 3600'
dep app-crashy 'exit 1'
kubectl -n "$NS" wait --for=condition=Available deployment/app-healthy deployment/app-foo deployment/app-foo-bar --timeout=240s >/dev/null
# Wait on Kubernetes' own record of the crash loop, not on one transient word: the kubelet reports `waiting: CrashLoopBackOff`
# only between restarts, so a restart count of 2 with the container not ready is the same fact. Five minutes covers a cold runner.
crashy() { kubectl -n "$NS" get pods -l app.kubernetes.io/name=app-crashy -o jsonpath="{.items[0].status.containerStatuses[0].$1}" 2>/dev/null || true; }
for _ in $(seq 1 150); do
  w=$(crashy state.waiting.reason); n=$(crashy restartCount)
  { [ "$w" = CrashLoopBackOff ] || [ "${n:-0}" -ge 2 ]; } && break; sleep 2
done
if ! { [ "$w" = CrashLoopBackOff ] || [ "${n:-0}" -ge 2 ]; }; then
  echo "app-crashy did not reach a crash loop (waiting reason: '${w}', restarts: '${n}')" >&2
  kubectl -n "$NS" describe pods -l app.kubernetes.io/name=app-crashy >&2 || true
  exit 1
fi
kubectl -n "$NS" create token os-ui --duration=2h > "$MON_SW_DIR/sa/token"
kubectl config view --raw --minify -o jsonpath='{.clusters[0].cluster.certificate-authority-data}' | base64 -d > "$MON_SW_DIR/sa/ca.crt"
API=$(kubectl config view --raw --minify -o jsonpath='{.clusters[0].cluster.server}')
printf 'export KUBERNETES_API=%s\nexport OS_K8S_SA_DIR=%s\nexport SOFTWARE_RUNNER_NAMESPACE=%s\n' "$API" "$MON_SW_DIR/sa" "$NS" > "$MON_SW_DIR/env.sh"
echo "monitoring software: cluster $MON_SW_CLUSTER up — source $MON_SW_DIR/env.sh"
