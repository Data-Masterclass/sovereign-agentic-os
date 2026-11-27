#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# app-token-chart.test.sh — chart test for the App Builder app identity token (workstream E, spec section 8).
# =============================================================================
#   bash scripts/tests/app-token-chart.test.sh
#
# Renders the chart (no cluster) with the App Builder switch OFF and ON and asserts:
#   OFF: no OS_APP_TOKEN_* env, no os-app-token-key volume, no app_identity.rego in OPA, none of the three
#        NetworkPolicies (scripts/check-app-builder-flag-off.mjs proves the whole render byte-identical);
#   ON:  os-ui (not os-ui-worker) gets OS_APP_TOKEN_KEY_FILE pointing into a read-only mount of the referenced Secret
#        (never rendered by the chart, never optional); OPA loads app_identity.rego (file list, ConfigMap); os-ui
#        admits app pods of apps-dev/apps-prod on :3000 only; app pods may egress to os-ui :3000 only; os-ui may egress
#        to app pods on :8080 only; an empty existingSecret refuses to render.
# Skips (exit 0) without helm or the subchart .tgz files — but FAILS when CI is set.
set -uo pipefail
cd "$(dirname "$0")/../.."
CHART=charts/sovereign-agentic-os
skip() {
  if [ -n "${CI:-}" ]; then echo "app-token-chart: $1 — FAILING because CI is set"; exit 1; fi
  echo "app-token-chart: $1 — SKIPPED"; exit 0
}
command -v helm >/dev/null 2>&1 || skip "helm not on PATH"
ls "$CHART"/charts/*.tgz >/dev/null 2>&1 || skip "chart dependencies not built"

check() { # $1 on|off, rest: helm args
  local mode=$1; shift
  helm template t "$CHART" -n agentic-os --set osUI.worker.enabled=true --set networkPolicies.defaultDeny=true "$@" \
    | MODE="$mode" python3 -c '
import os, sys, yaml
on = os.environ["MODE"] == "on"
docs = [d for d in yaml.safe_load_all(sys.stdin) if d]
by = {(d["kind"], d["metadata"].get("namespace", ""), d["metadata"]["name"]): d for d in docs}
fails = []
def need(c, m):
    if not c: fails.append(m)
def dep(name):
    return next(d for d in docs if d["kind"] == "Deployment" and d["metadata"]["name"] == name)
def env(d):
    return {e["name"]: e for c in d["spec"]["template"]["spec"]["containers"] for e in c.get("env", [])}
ui, worker = dep("os-ui"), dep("os-ui-worker")
uienv = env(ui)
vols = {v["name"]: v for v in ui["spec"]["template"]["spec"].get("volumes", [])}
mounts = {m["name"]: m for c in ui["spec"]["template"]["spec"]["containers"] if c["name"] == "os-ui" for m in c.get("volumeMounts", [])}
opa_cm = by[("ConfigMap", "agentic-os", "opa-policy")]
nps = {(d["metadata"]["namespace"], d["metadata"]["name"]): d for d in docs if d["kind"] == "NetworkPolicy"}
mine = [("agentic-os", "os-ui-allow-app-pods"), ("apps-dev", "apps-egress-os-ui"), ("apps-prod", "apps-egress-os-ui"), ("agentic-os", "allow-os-ui-egress-app-actions")]
if not on:
    need(not any(k.startswith("OS_APP_TOKEN") for k in uienv), "off: OS_APP_TOKEN env rendered")
    need("os-app-token-key" not in vols and "os-app-token-key" not in mounts, "off: key volume rendered")
    need("app_identity.rego" not in opa_cm["data"], "off: app_identity.rego in the OPA ConfigMap")
    need(not [k for k in mine if k in nps], "off: app-token NetworkPolicies rendered")
else:
    need(uienv.get("OS_APP_TOKEN_KEY_FILE", {}).get("value") == "/var/run/secrets/os-app-token/keys.json", "on: OS_APP_TOKEN_KEY_FILE")
    need(not any(k.startswith("OS_APP_TOKEN") for k in env(worker)), "on: the worker must not hold the signing key")
    v = vols.get("os-app-token-key", {}).get("secret", {})
    need(v.get("secretName") == "os-app-token-key" and not v.get("optional"), "on: the key volume is the referenced, required Secret")
    need(mounts.get("os-app-token-key", {}).get("readOnly") is True, "on: the key is mounted read-only")
    need(not [d for d in docs if d["kind"] == "Secret" and d["metadata"]["name"] == "os-app-token-key"], "on: the chart must never render the key")
    need("app_identity.rego" in opa_cm["data"], "on: app_identity.rego missing in the OPA ConfigMap")
    opa_args = " ".join(dep("opa")["spec"]["template"]["spec"]["containers"][0].get("args", []))
    need("/policies/app_identity.rego" in opa_args, "on: OPA does not load app_identity.rego")
    for k in mine: need(k in nps, f"on: NetworkPolicy {k} missing")
    ing = nps[("agentic-os", "os-ui-allow-app-pods")]["spec"]
    need(ing["podSelector"]["matchLabels"] == {"app.kubernetes.io/component": "os-ui"}, "on: ingress selects os-ui only")
    need(ing["ingress"][0]["ports"] == [{"protocol": "TCP", "port": 3000}], "on: ingress on :3000 only")
    need(sorted(f["namespaceSelector"]["matchLabels"]["kubernetes.io/metadata.name"] for f in ing["ingress"][0]["from"]) == ["apps-dev", "apps-prod"], "on: ingress from the app namespaces only")
    need(all(f["podSelector"]["matchLabels"] == {"app.kubernetes.io/part-of": "sovereign-os-apps"} for f in ing["ingress"][0]["from"]), "on: ingress from app pods only")
    eg = nps[("apps-dev", "apps-egress-os-ui")]["spec"]["egress"][0]
    need(eg["ports"] == [{"protocol": "TCP", "port": 3000}] and eg["to"][0]["podSelector"]["matchLabels"] == {"app.kubernetes.io/component": "os-ui"}, "on: app egress to os-ui :3000 only")
    act = nps[("agentic-os", "allow-os-ui-egress-app-actions")]["spec"]
    need(act["egress"][0]["ports"] == [{"protocol": "TCP", "port": 8080}], "on: os-ui egress to apps on :8080 only")
for f in fails: print("  FAIL", f)
verdict = "ok" if not fails else str(len(fails)) + " failure(s)"
print("app-token-chart [" + os.environ["MODE"] + "]: " + verdict)
sys.exit(1 if fails else 0)
'
}
rc=0
check off || rc=1
check on --set softwareRunner.environments.enabled=true || rc=1
if helm template t "$CHART" -n agentic-os --set softwareRunner.environments.enabled=true --set osUI.appToken.existingSecret= >/dev/null 2>&1; then
  echo "  FAIL an empty osUI.appToken.existingSecret must refuse to render"; rc=1
else
  echo "app-token-chart [no secret]: ok (refused)"
fi
exit $rc
