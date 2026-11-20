#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# =============================================================================
# platform.sh — the dev cluster's platform add-ons, at the versions production runs.
# =============================================================================
#   scripts/dev/platform.sh
#
#   - ingress-nginx: chart 4.11.3 = controller v1.11.3, the image production runs (read
#     2026-11-20). Its LoadBalancer Service is pinned to the reserved dev IP
#     (tofu output ingress_public_ip) with lb.stackit.cloud/external-address, as in production.
#   - cert-manager: v1.16.1 (production), CRDs from the chart, and the ClusterIssuer
#     letsencrypt-prod (HTTP-01 via nginx) that values.dev.yaml's ingress uses.
# Requests are set so the gate's budget (charts/sovereign-agentic-os/capacity.dev.yaml
# outsideChart) is true. Dev cluster only: refuses without the environment=dev marker.
. "$(dirname "$0")/lib.sh"
require_marked_dev
ACME_EMAIL=${ACME_EMAIL:-contact@datamasterclass.com}
IP=$(tf_out ingress_public_ip)
[ -n "$IP" ] || die "no ingress_public_ip in the dev state"

say "ingress-nginx 4.11.3 (controller v1.11.3) on $IP"
helm --kube-context "$CTX" upgrade --install ingress-nginx ingress-nginx \
  --repo https://kubernetes.github.io/ingress-nginx --version 4.11.3 \
  -n ingress-nginx --create-namespace --wait --timeout 10m \
  --set controller.service.annotations."lb\.stackit\.cloud/external-address"="$IP" \
  --set controller.resources.requests.cpu=100m --set controller.resources.requests.memory=90Mi \
  --set controller.resources.limits.memory=256Mi

say "cert-manager v1.16.1"
helm --kube-context "$CTX" upgrade --install cert-manager cert-manager \
  --repo https://charts.jetstack.io --version v1.16.1 \
  -n cert-manager --create-namespace --wait --timeout 10m \
  --set crds.enabled=true \
  --set resources.requests.cpu=10m --set resources.requests.memory=64Mi --set resources.limits.memory=128Mi \
  --set webhook.resources.requests.cpu=10m --set webhook.resources.requests.memory=64Mi --set webhook.resources.limits.memory=128Mi \
  --set cainjector.resources.requests.cpu=10m --set cainjector.resources.requests.memory=64Mi --set cainjector.resources.limits.memory=128Mi

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
