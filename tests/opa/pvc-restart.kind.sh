#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# WP-11 C1 on a REAL Kubernetes API (kind): the chart's OPA in bundle mode with its persistent
# volume (`opa.dataBundle.persistence`) activates an os-data bundle, then the bundle server is
# deleted (os-ui down) and the OPA POD is deleted. The NEW pod must become Ready from the volume
# with the runtime-only grant still active.
# Negative twin: the same with `persistence.enabled=false` (emptyDir): the new pod stays unready
# (`/health?bundles` 500) — fail closed, which is exactly what the volume prevents.
#
# Uses its own kind cluster and kubeconfig file; never touches ~/.kube/config.
# usage: bash tests/opa/pvc-restart.kind.sh        (kind, kubectl, helm, node, python3+pyyaml)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../.."
CLUSTER="${WP11_KIND_CLUSTER:-wp11}"
WORK="$(mktemp -d "${OPA_IT_DIR:-${TMPDIR:-/tmp}}/wp11-kind-XXXX")"
export KUBECONFIG="$WORK/kubeconfig"
NS=wp11
K="kubectl --kubeconfig $KUBECONFIG -n $NS"
SETS=(--set opa.dataBundle.enabled=true --set "opa.dataBundle.serviceUrl=http://bundle-srv:8080/api/opa")

diagnose() {
  echo "--- diagnostics"; $K get deploy,rs,pods,pvc -o wide || true
  $K get events --sort-by=.lastTimestamp | tail -15 || true
  $K describe pod -l app.kubernetes.io/component=opa | tail -25 || true
  $K logs -l app.kubernetes.io/component=opa --tail=30 || true
}
cleanup() { kind delete cluster --name "$CLUSTER" --kubeconfig "$KUBECONFIG" >/dev/null 2>&1 || true; }
trap 'rc=$?; [ $rc -ne 0 ] && diagnose; cleanup' EXIT

kind create cluster --name "$CLUSTER" --kubeconfig "$KUBECONFIG" --wait 120s >/dev/null
kubectl --kubeconfig "$KUBECONFIG" create namespace $NS >/dev/null

# The bundle, written by os-ui's own writer from the chart's own seed.
SEED="$(python3 "$HERE/chart-env.py" OS_OPA_SEED --set opa.dataBundle.enabled=true)"
REV="$(cd "$ROOT/os-ui" && OS_OPA_SEED="$SEED" node --import ./scripts/test-setup.mjs ../tests/opa/make-bundle.ts "$WORK/os-data.tar.gz" | tail -1)"
echo "bundle revision $REV"

# A plain static server stands in for os-ui's bundle route (the route itself is proven in
# bundle.int.test.ts); what is under test here is the volume across a pod delete.
$K create configmap bundle --from-file=os-data.tar.gz="$WORK/os-data.tar.gz" >/dev/null
cat <<YAML | $K apply -f - >/dev/null
apiVersion: apps/v1
kind: Deployment
metadata: { name: bundle-srv }
spec:
  replicas: 1
  selector: { matchLabels: { app: bundle-srv } }
  template:
    metadata: { labels: { app: bundle-srv } }
    spec:
      containers:
        - name: httpd
          image: busybox:1.36
          command: ["sh", "-c", "mkdir -p /www/api/opa/bundles && cp /b/os-data.tar.gz /www/api/opa/bundles/ && exec httpd -f -p 8080 -h /www"]
          volumeMounts: [{ name: b, mountPath: /b }]
      volumes: [{ name: b, configMap: { name: bundle } }]
---
apiVersion: v1
kind: Service
metadata: { name: bundle-srv }
spec: { selector: { app: bundle-srv }, ports: [{ port: 8080 }] }
YAML

render() { helm template wp "$ROOT/charts/sovereign-agentic-os" --namespace $NS --show-only templates/base/opa/opa.yaml "${SETS[@]}" "$@"; }

opa_data() { # $1 = path; via a port-forward to the current OPA pod
  local pod; pod="$($K get pod -l app.kubernetes.io/component=opa -o jsonpath='{.items[0].metadata.name}')"
  $K port-forward "pod/$pod" 18299:8181 >/dev/null 2>&1 & local pf=$!
  sleep 2
  curl -s "http://127.0.0.1:18299$1" || true
  kill $pf 2>/dev/null || true; wait $pf 2>/dev/null || true
}

# The chart's own PriorityClasses (the OPA pod names one; a bare cluster has none).
helm template wp "$ROOT/charts/sovereign-agentic-os" --namespace $NS --show-only templates/base/priority-classes.yaml | kubectl --kubeconfig "$KUBECONFIG" apply -f - >/dev/null

# --- with the persistent volume --------------------------------------------------------------
render | $K apply -f - >/dev/null
$K rollout status deploy/opa --timeout=180s >/dev/null
$K get pvc opa-bundles -o jsonpath='{.status.phase}' | grep -q Bound
got="$(opa_data /v1/data/grants/user:pvc-proof)"
echo "$got" | grep -q '"query"' || { echo "FAIL: bundle grant not active: $got"; exit 1; }
echo "PASS: OPA activated the bundle from the server ($got)"

# os-ui down, for certain: busybox httpd as PID 1 ignores SIGTERM, so a plain delete would keep it
# serving through its grace period. Remove the Service and kill the pods outright, then check.
$K delete svc/bundle-srv deploy/bundle-srv --wait >/dev/null
$K delete pod -l app=bundle-srv --grace-period=0 --force --wait >/dev/null 2>&1 || true
$K wait --for=delete pod -l app=bundle-srv --timeout=60s >/dev/null 2>&1 || true
[ -z "$($K get pods -l app=bundle-srv -o name)" ] || { echo "FAIL: bundle server still running"; exit 1; }
[ -z "$($K get svc bundle-srv -o name --ignore-not-found)" ] || { echo "FAIL: bundle Service still present"; exit 1; }
old="$($K get pod -l app.kubernetes.io/component=opa -o jsonpath='{.items[0].metadata.name}')"
$K delete pod "$old" --wait >/dev/null                    # a NEW pod
$K wait --for=condition=Ready pod -l app.kubernetes.io/component=opa --timeout=90s >/dev/null
new="$($K get pod -l app.kubernetes.io/component=opa -o jsonpath='{.items[0].metadata.name}')"
[ "$new" != "$old" ] || { echo "FAIL: pod not replaced"; exit 1; }
got="$(opa_data /v1/data/grants/user:pvc-proof)"
echo "$got" | grep -q '"query"' || { echo "FAIL: new pod lost the grant: $got"; exit 1; }
rev="$(opa_data /v1/data/system/bundles/os-data/manifest/revision)"
echo "$rev" | grep -q "$REV" || { echo "FAIL: new pod revision $rev"; exit 1; }
echo "PASS: new pod $new Ready from the volume with os-ui down; grant and revision $REV kept"

# --- negative twin: emptyDir -----------------------------------------------------------------
$K delete deploy/opa --wait >/dev/null
render --set opa.dataBundle.persistence.enabled=false | $K apply -f - >/dev/null
sleep 40
ready="$($K get pod -l app.kubernetes.io/component=opa -o jsonpath='{.items[0].status.containerStatuses[0].ready}')"
[ "$ready" = "false" ] || { echo "FAIL: an emptyDir pod with no bundle server became ready"; exit 1; }
health="$(opa_data '/health?bundles')"
echo "$health" | grep -q "not activated" || { echo "FAIL: expected unready health, got $health"; exit 1; }
echo "PASS (negative twin): without the volume the new pod stays unready — $health"
