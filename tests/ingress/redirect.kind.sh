#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# `ingress.redirectHosts` on the REAL controller: ingress-nginx controller-v1.11.3 (the version
# production runs, upstream's own kind manifest, default flags) in a kind cluster. The chart's
# rendered redirect Ingress is applied UNCHANGED (cert-manager is not installed, so its
# annotation is inert and the controller serves its fake certificate). Then:
#   - HTTPS  https://platform.../a/b?x=1&y=two  → 308, Location https://os.../a/b?x=1&y=two
#   - HTTPS  /                                   → 308, Location https://os.../
#   - the canonical host (osUI.publicUrl) and os.<zone> are NOT redirected (twin), and no
#     request reaches a backend (the backend Service does not exist).
#   KUBE_CONTEXT  default kind-ingress-redirect (the cluster must exist; KUBECONFIG is honoured)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; repo="$(cd "$here/../.." && pwd)"
ctx="${KUBE_CONTEXT:-kind-ingress-redirect}"
k() { kubectl --context "$ctx" "$@"; }
FROM=platform.sovereign-agentic.com; TO=https://agentic.datamasterclass.com   # = osUI.publicUrl below
fail() { echo "FAIL: $*" >&2; exit 1; }

# upstream's kind manifest schedules the controller on a node labelled ingress-ready=true
k label node --all ingress-ready=true --overwrite >/dev/null
k apply -f "https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.11.3/deploy/static/provider/kind/deploy.yaml" >/dev/null
k -n ingress-nginx rollout status deployment/ingress-nginx-controller --timeout=300s
k -n ingress-nginx wait --for=condition=complete job/ingress-nginx-admission-patch --timeout=120s >/dev/null 2>&1 || true

k create namespace agentic-os --dry-run=client -o yaml | k apply -f - >/dev/null
helm template agentic-os "$repo/charts/sovereign-agentic-os" -n agentic-os \
  --set ingress.enabled=true --set ingress.hosts.osUI=os.agentic.datamasterclass.com \
  --set ingress.hosts.osUIApex=agentic.datamasterclass.com --set "osUI.publicUrl=$TO" \
  --set "ingress.redirectHosts[0].host=$FROM" \
  --show-only templates/base/ingress-redirects.yaml --show-only templates/base/ingress.yaml > "$here/.rendered.yaml"
# The admission webhook validates the nginx config of each Ingress — retry until it is up.
for _ in $(seq 1 30); do k apply -n agentic-os -f "$here/.rendered.yaml" >/dev/null 2>&1 && break; sleep 4; done
k apply -n agentic-os -f "$here/.rendered.yaml" >/dev/null

k -n ingress-nginx port-forward svc/ingress-nginx-controller 18443:443 >/dev/null 2>&1 & pf=$!
trap 'kill $pf 2>/dev/null || true' EXIT
probe() { # host path → "code location"
  curl -sk -o /dev/null -w '%{http_code} %{redirect_url}' --resolve "$1:18443:127.0.0.1" "https://$1:18443$2"
}
for _ in $(seq 1 40); do
  out=$(probe "$FROM" '/a/b?x=1&y=two' || true); [ "${out%% *}" = 308 ] && break; sleep 3
done
echo "redirect: $out"
[ "$out" = "308 $TO/a/b?x=1&y=two" ] || fail "path+query redirect: got '$out'"
out=$(probe "$FROM" '/'); echo "root: $out"
[ "$out" = "308 $TO/" ] || fail "root redirect: got '$out'"
out=$(probe "$FROM" '/api/mcp?session=1'); echo "mcp path: $out"
[ "$out" = "308 $TO/api/mcp?session=1" ] || fail "MCP path redirect: got '$out'"
# Twin: the canonical host and the extra os.* host are served (here: no os-ui pod, so 503),
# never redirected.
for h in agentic.datamasterclass.com os.agentic.datamasterclass.com; do
  out=$(probe "$h" '/a'); echo "served $h: $out"
  [ "${out%% *}" != 308 ] || fail "$h must not redirect: '$out'"
done
echo "PASS: ingress-nginx v1.11.3 answers $FROM with 308 to $TO, path and query kept"
