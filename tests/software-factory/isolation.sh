#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Software Factory isolation proof on a throwaway kind cluster with an ENFORCING CNI (Calico).
# kind's default CNI does not enforce NetworkPolicy, so a green run there would prove nothing; this builds the
# cluster with the default CNI disabled and installs Calico. It then
#   1. renders the chart's sandbox namespace (namespace, default-deny, DNS + egress-proxy only) with helm;
#   2. stands up stand-ins for os-ui, postgres, OPA and the egress proxy in the platform namespace;
#   3. runs a pod labelled like the gates sandbox that does what a hostile app test would do: connect to each
#      of them by name and by pod IP, and to the Kubernetes API;
#   4. asserts every platform target is BLOCKED and the egress proxy and DNS are reachable;
#   5. NEGATIVE TWIN: the same probe from a namespace with NO policy reaches every target, which proves the
#      probe, the targets and the CNI would show a hole if there were one.
# Own kubeconfig, never ~/.kube/config:   SF_ISO_KUBECONFIG=<own file> bash tests/software-factory/isolation.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
: "${SF_ISO_KUBECONFIG:?set SF_ISO_KUBECONFIG to a file of its own}"
export KUBECONFIG="$SF_ISO_KUBECONFIG"
CLUSTER="${SF_ISO_CLUSTER:-sf-iso}"
CALICO_VERSION="${CALICO_VERSION:-v3.30.3}"
PLATFORM_NS=agentic-os
work="$(mktemp -d)"
cleanup() { rm -rf "$work"; kind delete cluster --name "$CLUSTER" --kubeconfig "$SF_ISO_KUBECONFIG" >/dev/null 2>&1 || true; }
trap cleanup EXIT
fail() { echo "ISOLATION FAIL: $*" >&2; exit 1; }

cat >"$work/kind-config.yaml" <<'YAML'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
networking:
  disableDefaultCNI: true
  podSubnet: 192.168.0.0/16
YAML
kind create cluster --name "$CLUSTER" --kubeconfig "$SF_ISO_KUBECONFIG" --config "$work/kind-config.yaml" --wait 120s >/dev/null
kubectl apply -f "https://raw.githubusercontent.com/projectcalico/calico/${CALICO_VERSION}/manifests/calico.yaml" >/dev/null
kubectl -n kube-system rollout status ds/calico-node --timeout=300s
kubectl -n kube-system rollout status deploy/coredns --timeout=300s
kubectl wait --for=condition=Ready nodes --all --timeout=300s

# 1. the chart's sandbox objects, exactly as rendered
ls "$repo/charts/sovereign-agentic-os/charts"/*.tgz >/dev/null 2>&1 || helm dependency build "$repo/charts/sovereign-agentic-os" >/dev/null
kubectl create namespace "$PLATFORM_NS"
helm template agentic-os "$repo/charts/sovereign-agentic-os" -n "$PLATFORM_NS" --skip-schema-validation \
  --set osUI.enabled=true --set networkPolicies.defaultDeny=true --set 'networkPolicies.apiserver.cidrs={10.96.0.1/32}' --set egressProxy.enabled=true \
  --show-only templates/base/os-ui/software-sandbox.yaml >"$work/rendered-sandbox.yaml"
SANDBOX_NS="$(kubectl create --dry-run=client -f "$work/rendered-sandbox.yaml" -o jsonpath='{.items[?(@.kind=="Namespace")].metadata.name}' 2>/dev/null || true)"
[ -n "$SANDBOX_NS" ] || SANDBOX_NS="$(awk '/^kind: Namespace/{f=1} f&&/^  name:/{print $2; exit}' "$work/rendered-sandbox.yaml")"
[ -n "$SANDBOX_NS" ] || fail "the chart rendered no sandbox namespace"
kubectl apply -f "$work/rendered-sandbox.yaml" >/dev/null
kubectl create namespace sf-open >/dev/null   # the control: no policy at all

# 2. stand-ins in the platform namespace (busybox httpd on each port, labelled as the real components)
for spec in os-ui:3000 pg-rw:5432 opa:8181 egress-proxy:3128; do
  name="${spec%%:*}"; port="${spec##*:}"
  comp="$name"; [ "$name" = pg-rw ] && comp=postgres
  kubectl -n "$PLATFORM_NS" apply -f - >/dev/null <<YAML
apiVersion: v1
kind: Pod
metadata: { name: $name, labels: { app.kubernetes.io/component: $comp } }
spec:
  containers:
    - { name: c, image: busybox:1.37.0, command: ["sh","-c","mkdir -p /www && echo up > /www/index.html && exec httpd -f -p $port -h /www"] }
---
apiVersion: v1
kind: Service
metadata: { name: $name }
spec: { selector: { app.kubernetes.io/component: $comp }, ports: [ { port: $port, targetPort: $port } ] }
YAML
done
kubectl -n "$PLATFORM_NS" wait --for=condition=Ready pod --all --timeout=180s >/dev/null

probe() { # <namespace> <name> : prints one line per check, "<target> OPEN|BLOCKED"
  local ns="$1" job="$2" ips; ips="$(kubectl -n "$PLATFORM_NS" get pods -o jsonpath='{range .items[*]}{.metadata.name}={.status.podIP}{"\n"}{end}')"
  kubectl -n "$ns" delete job "$job" --ignore-not-found >/dev/null
  kubectl -n "$ns" apply -f - >/dev/null <<YAML
apiVersion: batch/v1
kind: Job
metadata: { name: $job, labels: { app.kubernetes.io/component: software-gates, app.kubernetes.io/name: software-gates } }
spec:
  backoffLimit: 0
  template:
    metadata: { labels: { app.kubernetes.io/component: software-gates, app.kubernetes.io/name: software-gates } }
    spec:
      restartPolicy: Never
      automountServiceAccountToken: false
      securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, seccompProfile: { type: RuntimeDefault } }
      containers:
        - name: probe
          image: busybox:1.37.0
          securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: [ALL] }, readOnlyRootFilesystem: true }
          command: ["sh","-c"]
          args:
            - |
              try() { if echo | nc -w 4 "\$2" "\$3" >/dev/null 2>&1; then echo "\$1 OPEN"; else echo "\$1 BLOCKED"; fi; }
              try os-ui-dns os-ui.$PLATFORM_NS.svc 3000
              try postgres-dns pg-rw.$PLATFORM_NS.svc 5432
              try opa-dns opa.$PLATFORM_NS.svc 8181
              try egress-proxy-dns egress-proxy.$PLATFORM_NS.svc 3128
$(echo "$ips" | awk -F= 'NF==2 && $1!="egress-proxy"{p=($1=="os-ui")?3000:($1=="pg-rw")?5432:8181; printf "              try %s-ip %s %s\n", $1, $2, p}')
              try apiserver kubernetes.default.svc 443
              if nslookup kubernetes.default.svc >/dev/null 2>&1; then echo "dns OPEN"; else echo "dns BLOCKED"; fi
YAML
  kubectl -n "$ns" wait --for=condition=complete "job/$job" --timeout=240s >/dev/null || kubectl -n "$ns" wait --for=condition=failed "job/$job" --timeout=5s >/dev/null || true
  kubectl -n "$ns" logs "job/$job"
}

echo "== sandbox namespace ($SANDBOX_NS) =="
sandbox="$(probe "$SANDBOX_NS" iso-probe)"; echo "$sandbox"
echo "== control namespace (no policy) =="
control="$(probe sf-open iso-control)"; echo "$control"

# 4. the sandbox: platform targets BLOCKED, proxy and DNS OPEN
for t in os-ui-dns postgres-dns opa-dns os-ui-ip pg-rw-ip opa-ip apiserver; do
  echo "$sandbox" | grep -q "^$t BLOCKED$" || fail "$t was not blocked from the sandbox namespace"
done
echo "$sandbox" | grep -q "^egress-proxy-dns OPEN$" || fail "the egress proxy is not reachable from the sandbox (npm would fail)"
echo "$sandbox" | grep -q "^dns OPEN$" || fail "DNS is not reachable from the sandbox"
# 5. negative twin: the same targets ARE reachable without the policy
for t in os-ui-dns opa-dns os-ui-ip pg-rw-ip opa-ip; do
  echo "$control" | grep -q "^$t OPEN$" || fail "control: $t unreachable even without a policy - the probe proves nothing"
done
echo "ISOLATION OK: sandbox blocked os-ui, postgres, OPA and the API server; proxy and DNS reachable; control reached them."
