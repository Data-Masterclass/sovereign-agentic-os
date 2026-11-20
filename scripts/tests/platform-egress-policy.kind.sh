#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# platform-egress-policy.kind.sh — outbound HTTPS only through the egress proxy (or an explicit
# direct-HTTPS exception), the API-server rule narrowed to the API server, and the model gateway
# (the REAL LiteLLM image the chart pins) reaching its provider through the REAL proxy.
# Enforced by Calico on kind.
# =============================================================================
#   bash scripts/tests/platform-egress-policy.kind.sh [--keep]
#
# Needs docker, kind, kubectl, helm, python3+pyyaml and internet access from the kind node.
# Kubeconfig in $KIND_KUBECONFIG (never ~/.kube/config); CHART_DIR overrides the chart.
# Applies the chart's RENDERED egress policies (templates/base/network/egress-policies.yaml) and
# egress proxy (templates/base/egress/proxy.yaml, image built from images/base/egress-proxy),
# and runs LiteLLM with the chart's image and the chart's proxy env.
#   1. a platform pod (docling's labels) cannot open TCP to a public host on 443; it still
#      reaches the API server; an os-ui pod (direct-HTTPS exception) can;
#   2. LiteLLM reaches the allowlisted model host through the proxy (the provider answers:
#      an authentication error for the test key), the proxy log shows the CONNECT;
#   3. LiteLLM's call to a model host NOT on the allowlist is refused by the proxy;
#   negative twins: LiteLLM without the proxy env cannot reach the provider at all, and with
#   main's un-narrowed API-server rule the platform pod reaches the public host again.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
. scripts/tests/assert.sh
. tests/e2e/kind/versions.env
CLUSTER=${CLUSTER:-wpnetsecegress}
CHART=${CHART_DIR:-charts/sovereign-agentic-os}
KIND_KUBECONFIG=${KIND_KUBECONFIG:-$(mktemp -d)/kubeconfig}
CTX=kind-$CLUSTER
KEEP=${1:-}
CURL=curlimages/curl:8.11.1
LISTED=api.openai-compat.model-serving.eu01.onstackit.cloud
UNLISTED=api.openai.com
PUBLIC=www.wikipedia.org
cleanup() { [ "$KEEP" = --keep ] || kind delete cluster --name "$CLUSTER" --kubeconfig "$KIND_KUBECONFIG" >/dev/null 2>&1; }
trap cleanup EXIT
k() { kubectl --kubeconfig "$KIND_KUBECONFIG" --context "$CTX" "$@"; }

LITELLM_IMAGE=$(python3 - "$CHART" <<'PY'
import sys, yaml
v = yaml.safe_load(open(f"{sys.argv[1]}/values.yaml"))["litellm"]["image"]
tag, _, digest = v["tag"].partition("@")
print(f'{v["repository"]}@{digest}' if digest else f'{v["repository"]}:{tag}')
PY
)
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

docker build -q -t sovereign-os/egress-proxy:0.1.0 images/base/egress-proxy >/dev/null || exit 2
kind load docker-image --name "$CLUSTER" sovereign-os/egress-proxy:0.1.0 >/dev/null || exit 2
docker image inspect "$LITELLM_IMAGE" >/dev/null 2>&1 || docker pull -q "$LITELLM_IMAGE" >/dev/null || exit 2
docker tag "$LITELLM_IMAGE" sovereign-os/litellm-under-test:pinned
kind load docker-image --name "$CLUSTER" sovereign-os/litellm-under-test:pinned >/dev/null || exit 2

k create namespace agentic-os >/dev/null 2>&1
API=$(k get endpointslice -n default -l kubernetes.io/service-name=kubernetes -o jsonpath='{.items[0].endpoints[0].addresses[0]}')
[ -n "$API" ] || { echo "no API server endpoint" >&2; exit 2; }
render() { helm template agentic-os "$CHART" -n agentic-os --skip-schema-validation --set "networkPolicies.apiserver.cidrs={$API/32}" "$@" 2>/dev/null; }
render --show-only templates/base/network/egress-policies.yaml | k apply -n agentic-os -f - >/dev/null || exit 2
render --show-only templates/base/egress/proxy.yaml | k apply -n agentic-os -f - >/dev/null || exit 2
k -n agentic-os rollout status deploy/egress-proxy --timeout=180s >/dev/null || exit 2

# The chart's LiteLLM proxy env, exactly as rendered on the gateway Deployment.
envjson=$(helm template agentic-os "$CHART" -n agentic-os --skip-schema-validation 2>/dev/null | python3 -c '
import sys, yaml, json
for d in yaml.safe_load_all(sys.stdin):
    if d and d["kind"] == "Deployment" and d["metadata"]["name"] == "agentic-os-litellm":
        env = [e for c in d["spec"]["template"]["spec"]["containers"] for e in c.get("env", []) if e["name"].lower() in ("https_proxy", "http_proxy", "no_proxy")]
        print(json.dumps(env))
')
[ -n "$envjson" ] || envjson="[]"
[ "$(echo "$envjson" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))')" -ge 3 ] && ok "the chart renders LiteLLM's proxy env" || bad "the chart renders LiteLLM's proxy env"

k -n agentic-os create configmap litellm-test-config --from-literal=config.yaml="model_list:
  - model_name: listed
    litellm_params: { model: openai/test, api_base: https://$LISTED/v1, api_key: sk-test-not-a-key }
  - model_name: unlisted
    litellm_params: { model: openai/test, api_base: https://$UNLISTED/v1, api_key: sk-test-not-a-key }
litellm_settings: { request_timeout: 20, num_retries: 0 }
" >/dev/null
gateway() { # gateway <name> <env-json>
  cat <<YAML | k apply -n agentic-os -f - >/dev/null
apiVersion: v1
kind: Pod
metadata:
  name: $1
  labels: { app.kubernetes.io/name: litellm, app.kubernetes.io/instance: agentic-os, test: $1 }
spec:
  containers:
    - name: litellm
      image: sovereign-os/litellm-under-test:pinned
      imagePullPolicy: Never
      command: ["litellm", "--config", "/c/config.yaml", "--port", "4000"]
      env: $2
      volumeMounts: [{ name: c, mountPath: /c }]
      readinessProbe: { httpGet: { path: /health/liveliness, port: 4000 }, periodSeconds: 3 }
  volumes: [{ name: c, configMap: { name: litellm-test-config } }]
YAML
  k -n agentic-os expose pod "$1" --port=4000 >/dev/null
}
gateway gw "$envjson"
gateway gw-noproxy "[]"
k -n agentic-os wait --for=condition=Ready pod/gw pod/gw-noproxy --timeout=600s >/dev/null || exit 2

n=0
# run_curl <labels> <args…> — prints curl's stdout; exit = curl's exit code.
run_curl() {
  local labels=$1; shift; n=$((n + 1))
  k -n agentic-os run "p$n" --image="$CURL" --restart=Never --labels="$labels" --command -- curl "$@" >/dev/null
  for _ in $(seq 1 90); do
    phase=$(k -n agentic-os get pod "p$n" -o jsonpath='{.status.phase}' 2>/dev/null)
    case $phase in Succeeded|Failed) break ;; esac; sleep 2
  done
  k -n agentic-os logs "p$n" 2>/dev/null
  [ "$phase" = Succeeded ]
}
# connects <labels> <host> — 0 when a TCP+TLS connection to host:443 opens (any HTTP status).
connects() { local code; code=$(run_curl "$1" -s -o /dev/null -w '%{http_code}' --connect-timeout 6 -m 10 "https://$2/"); [ -n "$code" ] && [ "$code" != 000 ]; }
chat() { # chat <svc> <model> — the gateway's response body
  run_curl app.kubernetes.io/component=os-ui -s -m 60 "http://$1.agentic-os.svc.cluster.local:4000/v1/chat/completions" \
    -H 'content-type: application/json' -d "{\"model\":\"$2\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
}
DOC=app.kubernetes.io/component=docling
echo "== direct HTTPS is closed; the API server stays reachable"
if connects "$DOC" "$PUBLIC"; then bad "a platform pod cannot reach $PUBLIC:443 directly"; else ok "a platform pod cannot reach $PUBLIC:443 directly"; fi
code=$(run_curl "$DOC" -sk -o /dev/null -w '%{http_code}' --connect-timeout 6 "https://kubernetes.default.svc/version")
[ -n "$code" ] && [ "$code" != 000 ] && ok "a platform pod still reaches the API server ($code)" || bad "a platform pod still reaches the API server" "code=$code"
connects app.kubernetes.io/component=os-ui "$PUBLIC" && ok "os-ui (direct-HTTPS exception) reaches $PUBLIC:443" || bad "os-ui (direct-HTTPS exception) reaches $PUBLIC:443"
echo "== the model gateway goes through the proxy"
body=$(chat gw listed)
check "LiteLLM reaches the allowlisted provider $LISTED (the provider rejects the test key)" "401" "$body"
check "the proxy logged the CONNECT to $LISTED" "$LISTED" "$(k -n agentic-os logs deploy/egress-proxy 2>/dev/null)"
body=$(chat gw unlisted)
absent "LiteLLM gets no provider answer from $UNLISTED (not on the allowlist)" "invalid_api_key" "$body"
check "the proxy refused $UNLISTED" "$UNLISTED" "$(k -n agentic-os logs deploy/egress-proxy 2>/dev/null | grep -i -E 'filter|refus|denied|403')"
echo "== negative twins"
body=$(chat gw-noproxy listed)
absent "LiteLLM without the proxy env cannot reach the provider" "401" "$body"
helm template agentic-os "$CHART" -n agentic-os --skip-schema-validation --show-only templates/base/network/egress-policies.yaml 2>/dev/null \
  | python3 -c '
import sys, yaml
for d in yaml.safe_load_all(sys.stdin):
    if d and d["metadata"]["name"] == "allow-apiserver-egress":
        for r in d["spec"]["egress"]: r.pop("to", None)
        print(yaml.safe_dump(d))
' | k apply -n agentic-os -f - >/dev/null
connects "$DOC" "$PUBLIC" && ok "with an un-narrowed API-server rule the platform pod reaches $PUBLIC again" || bad "un-narrowed twin reaches $PUBLIC"
finish platform-egress-policy.kind
