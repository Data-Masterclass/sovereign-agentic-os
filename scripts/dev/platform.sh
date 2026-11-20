#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# =============================================================================
# platform.sh — the dev cluster's platform add-ons, at the versions production runs.
# =============================================================================
#   scripts/dev/platform.sh
#
#   - ingress-nginx: the chart pinned in platform-versions.env with ingress-nginx-values.yaml
#     (the same release and values production is upgraded to: components/ingress-nginx/UPSTREAM.md).
#     Its LoadBalancer Service is pinned to the reserved dev IP (tofu output ingress_public_ip)
#     with lb.stackit.cloud/external-address, as in production.
#   - the node sysctl DaemonSet (manifests/node-sysctl.yaml) in kube-system, so OpenSearch needs
#     no privileged init container in agentic-os;
#   - cert-manager: v1.16.1 (production), CRDs from the chart, and the ClusterIssuer
#     letsencrypt-prod (HTTP-01 via nginx) that values.dev.yaml's ingress uses.
# Requests are set so the gate's budget (charts/sovereign-agentic-os/capacity.dev.yaml
# outsideChart) is true. Dev cluster only: refuses without the environment=dev marker.
. "$(dirname "$0")/lib.sh"
require_marked_dev
. "$REPO_ROOT/scripts/dev/platform-versions.env"
ACME_EMAIL=${ACME_EMAIL:-contact@datamasterclass.com}
IP=$(tf_out ingress_public_ip)
[ -n "$IP" ] || die "no ingress_public_ip in the dev state"

say "ingress-nginx $INGRESS_NGINX_CHART_VERSION (controller $INGRESS_NGINX_CONTROLLER_VERSION) on $IP"
helm --kube-context "$CTX" upgrade --install ingress-nginx ingress-nginx \
  --repo https://kubernetes.github.io/ingress-nginx --version "$INGRESS_NGINX_CHART_VERSION" \
  -n ingress-nginx --create-namespace --wait --timeout 10m \
  -f "$REPO_ROOT/scripts/dev/ingress-nginx-values.yaml" \
  --set controller.service.annotations."lb\.stackit\.cloud/external-address"="$IP"

say "cert-manager v1.16.1"
helm --kube-context "$CTX" upgrade --install cert-manager cert-manager \
  --repo https://charts.jetstack.io --version v1.16.1 \
  -n cert-manager --create-namespace --wait --timeout 10m \
  --set crds.enabled=true \
  --set resources.requests.cpu=10m --set resources.requests.memory=64Mi --set resources.limits.memory=128Mi \
  --set webhook.resources.requests.cpu=10m --set webhook.resources.requests.memory=64Mi --set webhook.resources.limits.memory=128Mi \
  --set cainjector.resources.requests.cpu=10m --set cainjector.resources.requests.memory=64Mi --set cainjector.resources.limits.memory=128Mi

say "vm.max_map_count for OpenSearch, from kube-system (agentic-os stays baseline)"
k apply -f "$REPO_ROOT/scripts/dev/manifests/node-sysctl.yaml" >/dev/null
k -n kube-system rollout status ds/sovereign-os-node-sysctl --timeout=5m

say "ClusterIssuer letsencrypt-prod"
k apply -f - <<YAML
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: $ACME_EMAIL
    privateKeySecretRef: { name: letsencrypt-prod-account }
    solvers:
      - http01: { ingress: { ingressClassName: nginx } }
YAML
echo "PLATFORM_OK context=$CTX ingress_ip=$IP"
