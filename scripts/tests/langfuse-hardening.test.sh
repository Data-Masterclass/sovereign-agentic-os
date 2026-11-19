#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# =============================================================================
# langfuse-hardening.test.sh — chart test for the Langfuse web settings.
# =============================================================================
#   bash scripts/tests/langfuse-hardening.test.sh
#
# Renders the chart (no cluster) and asserts:
#   * AUTH_DISABLE_SIGNUP is "true" on the Langfuse web pod, on the default and STACKIT profiles;
#     the headless-init Secret (`langfuse-init`) is still wired in, so the OS user/keys exist;
#   * the `langfuse-web-allow-os-only` NetworkPolicy renders by default, selects exactly the
#     labels the subchart puts on the web pod, admits os-ui, os-ui-worker, LiteLLM and the
#     Langfuse worker on TCP 3000, and nothing else;
#   * it admits the ingress controller ONLY when the console is deliberately published;
#   * it is off with `networkPolicies.langfuseWeb=false` or `networkPolicies.defaultDeny=false`;
#   * no template renders a TLS Secret or Certificate for a Langfuse/LiteLLM host that has no route.
# Skips (exit 0) without helm or the subchart .tgz files — but FAILS when CI is set.
set -uo pipefail
cd "$(dirname "$0")/../.."
CHART=charts/sovereign-agentic-os
STACKIT=values.stackit-managed.yaml
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

skip() {
  if [ -n "${CI:-}" ]; then echo "langfuse-hardening: $1 — FAILING because CI is set"; exit 1; fi
  echo "langfuse-hardening: $1 — SKIPPED"; exit 0
}
command -v helm >/dev/null 2>&1 || skip "helm not on PATH"
ls "$CHART"/charts/*.tgz >/dev/null 2>&1 || skip "no subchart .tgz (run: helm dependency build $CHART)"
command -v python3 >/dev/null 2>&1 || skip "python3 not on PATH"
python3 -c 'import yaml' 2>/dev/null || skip "python3 has no PyYAML"

pass=0; fail=0
ok()  { pass=$((pass+1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail+1)); printf '  FAIL %s\n     %s\n' "$1" "${2-}"; }

render() { # render <out> <helm template args...>
  local out=$1; shift
  helm template agentic-os "$CHART" -n agentic-os "$@" >"$out" 2>"$out.err"
}

# A small checker over the rendered YAML. Prints "ok" or a reason.
cat >"$TMP/check.py" <<'PY'
import sys, yaml
mode, path = sys.argv[1], sys.argv[2]
docs = [d for d in yaml.safe_load_all(open(path)) if isinstance(d, dict)]
def find(kind, name):
    return next((d for d in docs if d.get("kind") == kind and d["metadata"]["name"] == name), None)
pol = find("NetworkPolicy", "langfuse-web-allow-os-only")
web = find("Deployment", "agentic-os-langfuse-web")
EXPECTED = [
    {"app.kubernetes.io/component": "os-ui"},
    {"app.kubernetes.io/component": "os-ui-worker"},
    {"app.kubernetes.io/instance": "agentic-os", "app.kubernetes.io/name": "litellm"},
    {"app.kubernetes.io/instance": "agentic-os", "app.kubernetes.io/name": "langfuse", "app.kubernetes.io/component": "worker"},
]
def peers(p):
    rules = p["spec"].get("ingress") or []
    if len(rules) != 1: return None, None, f"expected 1 ingress rule, got {len(rules)}"
    r = rules[0]
    return r.get("from") or [], r.get("ports") or [], None

if mode == "signup":
    if not web: print("no agentic-os-langfuse-web Deployment"); sys.exit()
    c = web["spec"]["template"]["spec"]["containers"][0]
    env = {e["name"]: e.get("value") for e in c.get("env", [])}
    if env.get("AUTH_DISABLE_SIGNUP") != "true": print(f"AUTH_DISABLE_SIGNUP={env.get('AUTH_DISABLE_SIGNUP')!r}"); sys.exit()
    refs = [f.get("secretRef", {}).get("name") for f in c.get("envFrom", [])]
    if "langfuse-init" not in refs: print(f"langfuse-init not in envFrom ({refs})"); sys.exit()
    print("ok")
elif mode == "policy":
    if not pol: print("policy not rendered"); sys.exit()
    sel = pol["spec"]["podSelector"]["matchLabels"]
    podlabels = web["spec"]["template"]["metadata"]["labels"] if web else {}
    if any(podlabels.get(k) != v for k, v in sel.items()): print(f"selector {sel} does not match web pod labels {podlabels}"); sys.exit()
    if pol["spec"].get("policyTypes") != ["Ingress"]: print(f"policyTypes {pol['spec'].get('policyTypes')}"); sys.exit()
    frm, ports, err = peers(pol)
    if err: print(err); sys.exit()
    if ports != [{"protocol": "TCP", "port": 3000}]: print(f"ports {ports}"); sys.exit()
    got = [f.get("podSelector", {}).get("matchLabels") for f in frm]
    if got != EXPECTED: print(f"peers {frm}"); sys.exit()
    print("ok")
elif mode == "policy-ingress":
    if not pol: print("policy not rendered"); sys.exit()
    frm, _, err = peers(pol)
    if err: print(err); sys.exit()
    ns = [f["namespaceSelector"]["matchLabels"] for f in frm if "namespaceSelector" in f]
    if ns != [{"kubernetes.io/metadata.name": "ingress-nginx"}]: print(f"namespace peers {ns}"); sys.exit()
    print("ok")
elif mode == "no-policy":
    print("ok" if not pol else "policy rendered but should not be")
elif mode == "no-tls":
    bad = []
    for d in docs:
        k = d.get("kind")
        if k == "Certificate" or (k == "Secret" and d.get("type") == "kubernetes.io/tls"):
            blob = yaml.safe_dump(d)
            if "langfuse" in blob or "litellm" in blob: bad.append(f"{k}/{d['metadata']['name']}")
        if k == "Ingress":
            for t in d["spec"].get("tls", []):
                for h in t.get("hosts", []):
                    if "langfuse" in h or "litellm" in h: bad.append(f"Ingress/{d['metadata']['name']} tls {h}")
    print("ok" if not bad else "renders " + ", ".join(bad))
PY

expect() { # expect <name> <mode> <file>
  if [ ! -s "$3" ]; then bad "$1" "helm template failed: $(tail -1 "$3.err")"; return; fi
  local r; r=$(python3 "$TMP/check.py" "$2" "$3")
  [ "$r" = ok ] && ok "$1" || bad "$1" "$r"
}

ALLOW='nginx\.ingress\.kubernetes\.io/whitelist-source-range'

echo "== sign-up"
render "$TMP/default.yaml"
render "$TMP/stackit.yaml" -f "$STACKIT"
expect "default: AUTH_DISABLE_SIGNUP=true, langfuse-init still wired"  signup "$TMP/default.yaml"
expect "STACKIT: AUTH_DISABLE_SIGNUP=true, langfuse-init still wired"  signup "$TMP/stackit.yaml"

echo "== NetworkPolicy"
expect "default: policy renders, selects the web pod, admits the four OS callers on 3000" policy "$TMP/default.yaml"
expect "STACKIT: same"                                                                    policy "$TMP/stackit.yaml"
render "$TMP/exposed.yaml" -f "$STACKIT" --set ingress.hosts.langfuse=langfuse.example.test \
  --set ingress.restricted.langfuse.expose=true \
  --set-string "ingress.restricted.langfuse.annotations.$ALLOW=203.0.113.7/32"
expect "published console: the ingress controller namespace is admitted"  policy-ingress "$TMP/exposed.yaml"
render "$TMP/stale.yaml" -f "$STACKIT" --set ingress.hosts.langfuse=langfuse.example.test
expect "hostname without opt-in: still only the four OS callers"          policy "$TMP/stale.yaml"
render "$TMP/off.yaml" --set networkPolicies.langfuseWeb=false
expect "networkPolicies.langfuseWeb=false: no policy"                      no-policy "$TMP/off.yaml"
render "$TMP/nodeny.yaml" --set networkPolicies.defaultDeny=false
expect "networkPolicies.defaultDeny=false: no policy"                      no-policy "$TMP/nodeny.yaml"

echo "== TLS for Langfuse / LiteLLM hosts"
render "$TMP/stale2.yaml" -f "$STACKIT" --set ingress.hosts.langfuse=langfuse.example.test \
  --set ingress.hosts.litellm=litellm.example.test
expect "default: no TLS Secret / Certificate / Ingress TLS for either host" no-tls "$TMP/default.yaml"
expect "STACKIT + stale hostnames, no opt-in: none either"                  no-tls "$TMP/stale2.yaml"

echo
echo "langfuse-hardening: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
