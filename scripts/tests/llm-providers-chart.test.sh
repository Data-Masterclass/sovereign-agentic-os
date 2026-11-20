#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# llm-providers-chart.test.sh — the chart side of provider-agnostic LLM setup.
# =============================================================================
#   bash scripts/tests/llm-providers-chart.test.sh
#
# Renders the chart (no cluster) and asserts:
#   * the model gateway reads `litellm-egress-env` (envFrom ConfigMap): HTTP(S)_PROXY = the egress
#     proxy, NO_PROXY covering the in-cluster names it calls (Langfuse, mock-model, query-tool, .svc),
#     and LITELLM_LOCAL_MODEL_COST_MAP (no outbound fetch of the price map at start);
#   * the proxy filter carries `llmProviders.allowHosts`, plus the STACKIT host when
#     stackitPremium.enabled (so the STACKIT profile keeps working with the proxy in the path);
#   * os-ui gets the SAME list as LLM_EGRESS_ALLOWLIST (the flow's pre-check = the proxy's filter);
#   * the shared agent key's `models` carry the access group `llmProviders.accessGroup`, so a model an
#     admin registers into that group is callable without a values edit;
#   * negative twins: llmProviders.viaEgressProxy=false renders an EMPTY env (no proxy), and
#     egressProxy.enabled=false never points the gateway at a proxy that is not deployed.
# Skips (exit 0) without helm or the subchart .tgz files — but FAILS when CI is set.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
. scripts/tests/assert.sh
CHART=charts/sovereign-agentic-os
skip() {
  if [ -n "${CI:-}" ]; then echo "llm-providers-chart: $1 — FAILING because CI is set"; exit 1; fi
  echo "llm-providers-chart: $1 — SKIPPED"; exit 0
}
command -v helm >/dev/null 2>&1 || skip "helm not on PATH"
ls "$CHART"/charts/*.tgz >/dev/null 2>&1 || skip "chart dependencies not built"

render() {
  local e; e=$(mktemp)
  out=$(helm template t "$CHART" -n agentic-os --skip-schema-validation "$@" 2>"$e"); rc=$?
  [ "$rc" -eq 0 ] || out="$out$(cat "$e")"
  rm -f "$e"
}
inspect() {
  printf '%s' "$out" | PYEXPR="$1" python3 -c '
import json, os, sys, yaml
docs = [d for d in yaml.safe_load_all(sys.stdin) if isinstance(d, dict) and d.get("kind")]
by = {(d["kind"], d["metadata"]["name"]): d for d in docs}
def cm(name): return ((by.get(("ConfigMap", name)) or {}).get("data") or {})
def dep(suffix): return next(x for (k, n), x in by.items() if k == "Deployment" and n.endswith(suffix))
def gw_envfrom():
    c = dep("litellm")["spec"]["template"]["spec"]["containers"][0]
    return [e.get("configMapRef", {}).get("name") for e in c.get("envFrom", []) if "configMapRef" in e]
def osui_env(name):
    c = next(x for x in dep("os-ui")["spec"]["template"]["spec"]["containers"] if x["name"] == "os-ui")
    return next((e.get("value") for e in c.get("env", []) if e["name"] == name), None)
def filt(): return cm("egress-proxy-config").get("filter", "")
def np(name): return by.get(("NetworkPolicy", name))
def np_json(name): return json.dumps(np(name), sort_keys=True)
def pol4_excludes_gw():
    exprs = (np("allow-apiserver-egress") or {}).get("spec", {}).get("podSelector", {}).get("matchExpressions", [])
    return any(e["key"] == "app.kubernetes.io/name" and e["operator"] == "NotIn" and "litellm" in e["values"] for e in exprs)
def keyjob():
    return "\n".join(json.dumps(d) for (k, n), d in by.items() if k == "Job" and "agent-key" in n)
print(eval(os.environ["PYEXPR"]))' 2>&1
}

echo "default profile"
render
rc_is "renders" 0
check "gateway reads litellm-egress-env" "litellm-egress-env" "$(inspect 'gw_envfrom()')"
check "HTTPS_PROXY is the egress proxy" "http://egress-proxy:3128" "$(inspect 'cm("litellm-egress-env").get("HTTPS_PROXY")')"
check "HTTP_PROXY is the egress proxy" "http://egress-proxy:3128" "$(inspect 'cm("litellm-egress-env").get("HTTP_PROXY")')"
NP=$(inspect 'cm("litellm-egress-env").get("NO_PROXY")')
for n in t-langfuse-web agentic-os-langfuse-web mock-model query-tool .svc .cluster.local localhost; do check "NO_PROXY has $n" "$n" "$NP"; done
absent "NO_PROXY has no empty entry" ",," "$NP"
check "os-ui knows the same NO_PROXY" "mock-model" "$(inspect 'osui_env("LLM_NO_PROXY")')"
check "price map read locally" "True" "$(inspect 'cm("litellm-egress-env").get("LITELLM_LOCAL_MODEL_COST_MAP")')"
check "agent key holds the access group" "os-admin-registered" "$(inspect 'keyjob()')"
absent "no STACKIT host when stackitPremium is off" "onstackit" "$(inspect 'filt()')"

echo "default profile + llmProviders.allowHosts"
render --set 'llmProviders.allowHosts={acme.openai.azure.com,api.mistral.ai}' --set 'llmProviders.noProxy={ollama}'
rc_is "renders" 0
check "a bare in-cluster Service joins NO_PROXY" ",ollama" "$(inspect 'cm("litellm-egress-env").get("NO_PROXY")')"
check "… and os-ui's copy" ",ollama" "$(inspect 'osui_env("LLM_NO_PROXY")')"
check "proxy filter has the Azure host" 'acme\.openai\.azure\.com' "$(inspect 'filt()')"
check "proxy filter has the Mistral host" 'api\.mistral\.ai' "$(inspect 'filt()')"
check "os-ui pre-check list = proxy list" "acme.openai.azure.com" "$(inspect 'osui_env("LLM_EGRESS_ALLOWLIST")')"
check "os-ui pre-check keeps the base allowlist" "github.com" "$(inspect 'osui_env("LLM_EGRESS_ALLOWLIST")')"

echo "STACKIT profile (production shape)"
render -f values.stackit-managed.yaml
rc_is "renders" 0
check "proxy filter has the STACKIT model-serving host" 'api\.openai-compat\.model-serving\.eu01\.onstackit\.cloud' "$(inspect 'filt()')"
check "os-ui pre-check has the STACKIT host" "api.openai-compat.model-serving.eu01.onstackit.cloud" "$(inspect 'osui_env("LLM_EGRESS_ALLOWLIST")')"
check "gateway proxied on STACKIT too" "http://egress-proxy:3128" "$(inspect 'cm("litellm-egress-env").get("HTTPS_PROXY")')"
check "agent key holds the access group" "os-admin-registered" "$(inspect 'keyjob()')"

echo "NEGATIVE TWIN — llmProviders.viaEgressProxy=false"
render --set llmProviders.viaEgressProxy=false
rc_is "renders" 0
check "no proxy env" "None" "$(inspect 'cm("litellm-egress-env").get("HTTPS_PROXY")')"

echo "NEGATIVE TWIN — egressProxy.enabled=false"
render --set egressProxy.enabled=false
rc_is "renders" 0
check "never points at an absent proxy" "None" "$(inspect 'cm("litellm-egress-env").get("HTTPS_PROXY")')"

echo "NetworkPolicy — the gateway cannot go direct (default profile, proxy on)"
render
rc_is "renders" 0
check "gateway excluded from the any-443 policy" "True" "$(inspect 'pol4_excludes_gw()')"
check "litellm-egress policy exists" "litellm-egress" "$(inspect 'np("litellm-egress")["metadata"]["name"]')"
check "selects the gateway pods" '"app.kubernetes.io/name": "litellm"' "$(inspect 'np_json("litellm-egress")')"
check "allows the egress proxy on 3128" '"port": 3128' "$(inspect 'np_json("litellm-egress")')"
check "allows the egress proxy pods" '"app.kubernetes.io/component": "egress-proxy"' "$(inspect 'np_json("litellm-egress")')"
check "allows its database port" '"port": 5432' "$(inspect 'np_json("litellm-egress")')"
absent "no 443-anywhere for the gateway" '"port": 443' "$(inspect 'np_json("litellm-egress")')"

echo "local model servers (llmProviders.localModels / localModelNamespaces)"
render --set 'llmProviders.localModels={ollama,vllm.models.svc}' --set 'llmProviders.localModelNamespaces={models}'
rc_is "renders" 0
check "local models join NO_PROXY" ",ollama" "$(inspect 'cm("litellm-egress-env").get("NO_PROXY")')"
check "os-ui gets the local-model list" "ollama,vllm.models.svc" "$(inspect 'osui_env("LLM_LOCAL_MODELS")')"
check "gateway may reach the model namespace" '"kubernetes.io/metadata.name": "models"' "$(inspect 'np_json("litellm-egress")')"

echo "NEGATIVE TWIN — proxy off: no lock-down (the gateway must reach providers directly again)"
render --set llmProviders.viaEgressProxy=false
rc_is "renders" 0
check "gateway keeps the any-443 policy" "False" "$(inspect 'pol4_excludes_gw()')"
check "no litellm-egress policy" "None" "$(inspect 'np("litellm-egress")')"

echo "NEGATIVE TWIN — networkPolicies.defaultDeny=false renders no gateway policy"
render --set networkPolicies.defaultDeny=false
rc_is "renders" 0
check "no litellm-egress policy" "None" "$(inspect 'np("litellm-egress")')"

finish llm-providers-chart
