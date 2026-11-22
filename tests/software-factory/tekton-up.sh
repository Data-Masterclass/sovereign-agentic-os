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
k -n "$PLATFORM_NS" rollout status deployment/os-git-http --timeout=180s
k -n "$PLATFORM_NS" rollout status deployment/egress-proxy --timeout=180s
k -n agentic-build wait --for=jsonpath='{.status.conditions[0].status}'=True eventlistener/app-checks --timeout=180s || true
k -n agentic-build get eventlistener app-checks
echo "tekton-up: cluster $CLUSTER ready (kubeconfig $SF_KUBECONFIG)"
