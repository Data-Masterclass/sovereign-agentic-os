#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Software Factory CI harness: a kind cluster with an ENFORCING CNI (Calico, so the chart's NetworkPolicies are
# real), Tekton Pipelines + Triggers installed exactly as upstream documents it (scripts/tekton/install.sh), and
# the OS-owned resources taken from the CHART (`helm template`, the same templates an install renders): the build
# namespace, listener, RBAC, quota, pruner, NetworkPolicies and the platform egress proxy. The domain git server
# is the OS's own `git-http` image (git's http-backend behind lighttpd) serving the bare repositories the OS writes.
# Nothing of the OS is installed beyond that; the test process plays os-ui against the real components.
#
# Uses its OWN kubeconfig ($SF_KUBECONFIG); never writes ~/.kube/config and never changes a current-context.
#   SF_KUBECONFIG=<file> SF_REPOS_DIR=<dir> bash tests/software-factory/tekton-up.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
# shellcheck source=/dev/null
. "$root/tests/e2e/kind/versions.env"
# shellcheck source=/dev/null
. "$root/scripts/tekton/versions.env"
: "${SF_KUBECONFIG:?set SF_KUBECONFIG to a file of its own}"
: "${SF_REPOS_DIR:?set SF_REPOS_DIR to the host directory that holds the bare domain repositories}"
CLUSTER="${SF_CLUSTER:-sf-tekton}"
PLATFORM_NS="${SF_PLATFORM_NS:-agentic-os}"
export KUBECONFIG="$SF_KUBECONFIG"
k() { kubectl --kubeconfig "$SF_KUBECONFIG" "$@"; }
say() { printf '\n==> %s\n' "$*"; }
for t in docker kind kubectl helm curl; do command -v "$t" >/dev/null || { echo "missing tool: $t" >&2; exit 1; }; done
mkdir -p "$SF_REPOS_DIR"

say "1. kind cluster $CLUSTER (default CNI off, repos mounted at /repos)"
if ! kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  cat <<YAML | kind create cluster --name "$CLUSTER" --image "$KIND_NODE_IMAGE" --kubeconfig "$SF_KUBECONFIG" --config=-
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
networking:
  disableDefaultCNI: true
  podSubnet: 192.168.0.0/16
nodes:
  - role: control-plane
    extraMounts:
      - hostPath: ${SF_REPOS_DIR}
        containerPath: /repos
YAML
fi

say "2. Calico $CALICO_VERSION (manifest verified by sha256)"
manifest="$(mktemp)"
curl -fsSL "https://raw.githubusercontent.com/projectcalico/calico/${CALICO_VERSION}/manifests/calico.yaml" -o "$manifest"
got="$( (sha256sum "$manifest" 2>/dev/null || shasum -a 256 "$manifest") | cut -d' ' -f1)"
[ "$got" = "$CALICO_MANIFEST_SHA256" ] || { echo "calico manifest sha256 $got != pinned $CALICO_MANIFEST_SHA256" >&2; exit 1; }
k apply -f "$manifest" >/dev/null
rm -f "$manifest"
k -n kube-system rollout status daemonset/calico-node --timeout=900s
k wait --for=condition=Ready node --all --timeout=300s

say "3. Tekton $TEKTON_PIPELINES_VERSION + Triggers $TEKTON_TRIGGERS_VERSION"
bash "$root/scripts/tekton/install.sh" --kubeconfig "$SF_KUBECONFIG"

say "4. images built from this checkout (git-http, egress-proxy), loaded into kind"
docker build -q -t sovereign-os/git-http:sf-e2e "$root/images/base/git-http" >/dev/null
docker build -q -t sovereign-os/egress-proxy:sf-e2e "$root/images/base/egress-proxy" >/dev/null
kind load docker-image --name "$CLUSTER" sovereign-os/git-http:sf-e2e sovereign-os/egress-proxy:sf-e2e >/dev/null

say "5. the chart's resources (helm template): build namespace, listener, RBAC, quota, pruner, NetworkPolicies, egress proxy"
k create namespace "$PLATFORM_NS" --dry-run=client -o yaml | k apply -f - >/dev/null
chart_yaml="$(mktemp)"
api="$(k -n default get endpoints kubernetes -o jsonpath='{.subsets[0].addresses[0].ip}')"
helm template agentic-os "$root/charts/sovereign-agentic-os" -n "$PLATFORM_NS" --skip-schema-validation \
  --set osUI.enabled=true --set osUI.software.tekton.enabled=true \
  --set "networkPolicies.apiserver.cidrs={${api}/32}" \
  --set egressProxy.enabled=true --set egressProxy.image.repository=sovereign-os/egress-proxy --set egressProxy.image.tag=sf-e2e \
  --set osUI.software.tekton.workspace.storage=1Gi \
  --show-only templates/base/priority-classes.yaml --show-only templates/base/os-ui/software-tekton.yaml --show-only templates/base/egress/proxy.yaml > "$chart_yaml"
k apply -f "$chart_yaml" >/dev/null
rm -f "$chart_yaml"

say "6. the domain git server: the OS's git-http image over the bare repositories"
cat <<YAML | k apply -f - >/dev/null
apiVersion: apps/v1
kind: Deployment
metadata: { name: os-git-http, namespace: ${PLATFORM_NS} }
spec:
  replicas: 1
  selector: { matchLabels: { app.kubernetes.io/component: os-ui } }
  template:
    metadata: { labels: { app.kubernetes.io/component: os-ui } }
    spec:
      securityContext: { runAsNonRoot: true, runAsUser: 65532, seccompProfile: { type: RuntimeDefault } }
      containers:
        - name: git-http
          image: sovereign-os/git-http:sf-e2e
          imagePullPolicy: Never
          ports: [{ name: git-http, containerPort: 9419 }]
          env:
            # The repositories are owned by the host user that wrote them, not by the CGI user.
            - { name: GIT_CONFIG_COUNT, value: "1" }
            - { name: GIT_CONFIG_KEY_0, value: safe.directory }
            - { name: GIT_CONFIG_VALUE_0, value: "*" }
          securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: [ALL] } }
          volumeMounts:
            - { name: repos, mountPath: /repos, readOnly: true }
            - { name: tmp, mountPath: /tmp }
      volumes:
        - { name: repos, hostPath: { path: /repos, type: Directory } }
        - { name: tmp, emptyDir: {} }
---
apiVersion: v1
kind: Service
metadata: { name: os-git-http, namespace: ${PLATFORM_NS} }
spec:
  selector: { app.kubernetes.io/component: os-ui }
  ports: [{ name: git-http, port: 9419, targetPort: git-http }]
YAML
# A rollout that does not finish must say why in the CI log (pod state, events, container logs), not only time out.
diagnose() {
  echo "--- diagnostics: $1" >&2
  k -n "$PLATFORM_NS" get pods -o wide >&2 || true
  k -n "$PLATFORM_NS" describe "deployment/$1" >&2 || true
  k -n "$PLATFORM_NS" describe pods -l "app.kubernetes.io/component=$2" >&2 || true
  k -n "$PLATFORM_NS" logs -l "app.kubernetes.io/component=$2" --all-containers --tail=50 >&2 || true
  k get networkpolicy -A >&2 || true
  k -n "$PLATFORM_NS" get configmap egress-proxy-config -o yaml >&2 || true
  # The same image as pods that differ in ONE setting each (the container exits at once when the proxy cannot start).
  mkpod() { # name, pod securityContext, container securityContext, resources
    cat <<YAML | k apply -f - >/dev/null || true
apiVersion: v1
kind: Pod
metadata: { name: diag-$1, namespace: ${PLATFORM_NS} }
spec:
  restartPolicy: Never
  securityContext: $2
  containers:
    - name: look
      image: sovereign-os/egress-proxy:sf-e2e
      imagePullPolicy: Never
      command: ["sh", "-c", "id; timeout 2 tinyproxy -d -c /etc/tinyproxy/tinyproxy.conf 2>&1 | grep -E 'Could not|listening' | head -1"]
      securityContext: $3
      resources: $4
      volumeMounts: [{ name: config, mountPath: /etc/tinyproxy, readOnly: true }, { name: tmp, mountPath: /tmp }]
  volumes: [{ name: config, configMap: { name: egress-proxy-config } }, { name: tmp, emptyDir: {} }]
YAML
  }
  psc='{ runAsNonRoot: true, runAsUser: 65534, seccompProfile: { type: RuntimeDefault } }'
  csc='{ allowPrivilegeEscalation: false, capabilities: { drop: [ALL] }, readOnlyRootFilesystem: true }'
  res='{ requests: { cpu: 25m, memory: 32Mi }, limits: { cpu: 250m, memory: 96Mi } }'
  mkpod chart "$psc" "$csc" "$res"
  mkpod nolimits "$psc" "$csc" '{}'
  mkpod noseccomp '{ runAsNonRoot: true, runAsUser: 65534 }' "$csc" "$res"
  mkpod rwroot "$psc" '{ allowPrivilegeEscalation: false, capabilities: { drop: [ALL] } }' "$res"
  mkpod root '{ seccompProfile: { type: RuntimeDefault } }' '{}' "$res"
  mkpod bare '{}' '{}' '{}'
  # The syscall that fails: strace as root in a pod with the chart's volumes (installs strace from the Alpine mirror).
  cat <<YAML | k apply -f - >/dev/null || true
apiVersion: v1
kind: Pod
metadata: { name: diag-strace, namespace: ${PLATFORM_NS} }
spec:
  restartPolicy: Never
  containers:
    - name: look
      image: sovereign-os/egress-proxy:sf-e2e
      imagePullPolicy: Never
      securityContext: { runAsUser: 0, capabilities: { add: [SYS_PTRACE] } }
      command: ["sh", "-c", "apk add --no-cache strace >/dev/null 2>&1; cp /etc/tinyproxy/tinyproxy.conf /tmp/c.conf; strace -f -o /tmp/s.txt timeout 2 tinyproxy -d -c /etc/tinyproxy/tinyproxy.conf; echo STRACE-TAIL; tail -22 /tmp/s.txt; echo; cat /etc/resolv.conf; ls -la /etc/tinyproxy/"]
      volumeMounts: [{ name: config, mountPath: /etc/tinyproxy, readOnly: true }, { name: tmp, mountPath: /tmp }]
  volumes: [{ name: config, configMap: { name: egress-proxy-config } }, { name: tmp, emptyDir: {} }]
YAML
  sleep 45
  k -n "$PLATFORM_NS" logs diag-strace >&2 || true
  for n in chart nolimits noseccomp rwroot root bare; do
    printf '%s => ' "$n" >&2
    k -n "$PLATFORM_NS" logs "diag-$n" 2>&1 | tr '\n' ' ' >&2 || true
    echo >&2
  done
  k -n "$PLATFORM_NS" get pod diag-chart -o jsonpath='{.spec.securityContext}{"\n"}{.spec.containers[0].securityContext}{"\n"}' >&2 || true
  # The same image outside Kubernetes, with the same config: does the container runtime or Kubernetes decide?
  d="$(mktemp -d)"
  k -n "$PLATFORM_NS" get configmap egress-proxy-config -o jsonpath='{.data.tinyproxy\.conf}' > "$d/tinyproxy.conf" || true
  k -n "$PLATFORM_NS" get configmap egress-proxy-config -o jsonpath='{.data.filter}' > "$d/filter" || true
  chmod -R a+rX "$d"
  img=sovereign-os/egress-proxy:sf-e2e
  for v in "plain:" "uid65534:--user 65534" "readonly:--user 65534 --read-only --tmpfs /tmp" "seccomp-unconfined:--user 65534 --security-opt seccomp=unconfined" "cap-drop:--user 65534 --cap-drop ALL --security-opt no-new-privileges"; do
    printf '%s => ' "${v%%:*}" >&2
    # shellcheck disable=SC2086
    timeout 3 docker run --rm -v "$d:/etc/tinyproxy:ro" ${v#*:} "$img" 2>&1 | grep -E "Could not|listening" | head -1 >&2 || true
    echo >&2
  done
  uname -r >&2; docker version --format '{{.Server.Version}}' >&2 || true
}
k -n "$PLATFORM_NS" rollout status deployment/os-git-http --timeout=180s || { diagnose os-git-http os-ui; exit 1; }
k -n "$PLATFORM_NS" rollout status deployment/egress-proxy --timeout=180s || { diagnose egress-proxy egress-proxy; exit 1; }
k -n agentic-build wait --for=jsonpath='{.status.conditions[0].status}'=True eventlistener/app-checks --timeout=180s || true
k -n agentic-build get eventlistener app-checks
echo "tekton-up: cluster $CLUSTER ready (kubeconfig $SF_KUBECONFIG)"
