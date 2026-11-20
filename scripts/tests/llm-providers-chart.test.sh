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
check "price map read locally" "True" "$(inspect 'cm("litellm-egress-env").get("LITELLM_LOCAL_MODEL_COST_MAP")')"
check "agent key holds the access group" "os-admin-models" "$(inspect 'keyjob()')"
absent "no STACKIT host when stackitPremium is off" "onstackit" "$(inspect 'filt()')"

echo "default profile + llmProviders.allowHosts"
render --set 'llmProviders.allowHosts={acme.openai.azure.com,api.mistral.ai}'
rc_is "renders" 0
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
check "agent key holds the access group" "os-admin-models" "$(inspect 'keyjob()')"

echo "NEGATIVE TWIN — llmProviders.viaEgressProxy=false"
render --set llmProviders.viaEgressProxy=false
rc_is "renders" 0
check "no proxy env" "None" "$(inspect 'cm("litellm-egress-env").get("HTTPS_PROXY")')"

echo "NEGATIVE TWIN — egressProxy.enabled=false"
render --set egressProxy.enabled=false
rc_is "renders" 0
check "never points at an absent proxy" "None" "$(inspect 'cm("litellm-egress-env").get("HTTPS_PROXY")')"

finish llm-providers-chart
