#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# docling-chart.test.sh — chart test for the Docling deployment settings.
# =============================================================================
#   bash scripts/tests/docling-chart.test.sh
#
# Renders the chart (no cluster), on the default and STACKIT profiles, and asserts:
#   * the image tag is a version (not `latest`) of OUR derived image, pinned by a digest that is
#     REQUIRED (an empty digest fails the render), pulled with global.imagePullSecrets;
#   * docling-serve's limits and settings are set: 50 MiB, 400 pages, 900 s, one worker,
#     version info on, and DOCLING_SERVE_API_KEY comes from a Secret (never a literal);
#   * probes: readiness/startup on /ready, liveness on /livez;
#   * os-ui and os-ui-worker read DOCLING_API_KEY from the SAME Secret the docling pod reads;
#   * the `docling-allow-os-ui-only` NetworkPolicy selects the docling pod and admits exactly
#     os-ui and os-ui-worker on TCP 5001; `docling.networkPolicy.enabled=false` removes it;
#   * `docling.apiKey.existingSecret` switches every reference to that Secret and drops ours;
#   * `docling.image.localBuild` renders only for a local cluster: it is refused together with the
#     STACKIT profile, an enabled Ingress, or a public osUI.publicUrl / ingress host.
# Skips (exit 0) without helm or the subchart .tgz files — but FAILS when CI is set.
set -uo pipefail
cd "$(dirname "$0")/../.."
CHART=charts/sovereign-agentic-os
skip() {
  if [ -n "${CI:-}" ]; then echo "docling-chart: $1 — FAILING because CI is set"; exit 1; fi
  echo "docling-chart: $1 — SKIPPED"; exit 0
}
command -v helm >/dev/null 2>&1 || skip "helm not on PATH"
ls "$CHART"/charts/*.tgz >/dev/null 2>&1 || skip "chart dependencies not built"

check() { # $1 label, rest: helm args
  local label=$1; shift
  helm template t "$CHART" -n agentic-os --set osUI.worker.enabled=true --set 'global.imagePullSecrets[0].name=registry-pull-secret' "$@" \
    | LABEL="$label" python3 -c '
import os, sys, yaml
label = os.environ["LABEL"]
docs = [d for d in yaml.safe_load_all(sys.stdin) if d]
by = {(d["kind"], d["metadata"]["name"]): d for d in docs}
fails = []
def need(cond, msg):
    if not cond: fails.append(msg)
existing = "--existing" in label
nop = "--no-netpol" in label
secret = "ops-docling" if existing else "docling-api-key"
dep = by.get(("Deployment", "docling"))
need(dep is not None, "no docling Deployment")
c = dep["spec"]["template"]["spec"]["containers"][0]
tag = c["image"].split("@")[0].rsplit(":", 1)[1]
need(c["image"].split("@")[0].rsplit(":", 1)[0] == "ghcr.io/data-masterclass/sovereign-os/docling", "image is not our derived image: " + c["image"])
import re
need(re.fullmatch(r"sha256:[0-9a-f]{64}", c["image"].split("@", 1)[1] if "@" in c["image"] else "") is not None, "image is not pinned by a real digest: " + c["image"])
pull = dep["spec"]["template"]["spec"].get("imagePullSecrets")
need(pull == [{"name": "registry-pull-secret"}], f"imagePullSecrets {pull}")
need(tag != "latest" and tag[0].isdigit(), "image tag is not a version: " + tag)
env = {e["name"]: e for e in c["env"]}
want = {"DOCLING_SERVE_MAX_FILE_SIZE": "52428800", "DOCLING_SERVE_MAX_NUM_PAGES": "400",
        "DOCLING_SERVE_MAX_DOCUMENT_TIMEOUT": "900", "DOCLING_SERVE_ENG_LOC_NUM_WORKERS": "1",
        "DOCLING_SERVE_SHOW_VERSION_INFO": "true"}
for k, v in want.items():
    need(env.get(k, {}).get("value") == v, f"{k} != {v}: {env.get(k)}")
key = env.get("DOCLING_SERVE_API_KEY", {})
need("value" not in key, "DOCLING_SERVE_API_KEY is a literal")
need(key.get("valueFrom", {}).get("secretKeyRef", {}).get("name") == secret, f"api key not from {secret}: {key}")
need(c["readinessProbe"]["httpGet"]["path"] == "/ready", "readiness not /ready")
need(c["startupProbe"]["httpGet"]["path"] == "/ready", "startup not /ready")
need(c["livenessProbe"]["httpGet"]["path"] == "/livez", "liveness not /livez")
need(c["resources"]["requests"]["memory"] == "1Gi" and c["resources"]["limits"]["memory"] == "4Gi", "resources")
for name in ("os-ui", "os-ui-worker"):
    d = by.get(("Deployment", name))
    need(d is not None, f"no {name}")
    if not d: continue
    cc = [x for x in d["spec"]["template"]["spec"]["containers"] if x["name"] in ("os-ui", "worker", "os-ui-worker")]
    refs = [e.get("valueFrom", {}).get("secretKeyRef", {}).get("name") for x in cc for e in x.get("env", []) if e["name"] == "DOCLING_API_KEY"]
    need(refs == [secret], f"{name} DOCLING_API_KEY refs {refs}, want [{secret}]")
need((("Secret", "docling-api-key") in by) != existing, "chart Secret presence wrong")
np = by.get(("NetworkPolicy", "docling-allow-os-ui-only"))
if nop:
    need(np is None, "netpol rendered although disabled")
else:
    need(np is not None, "no docling NetworkPolicy")
    if np:
        sel = np["spec"]["podSelector"]["matchLabels"]
        tl = dep["spec"]["template"]["metadata"]["labels"]
        need(all(tl.get(k) == v for k, v in sel.items()), f"netpol selector {sel} does not match the pod")
        need(np["spec"]["policyTypes"] == ["Ingress"], "policyTypes")
        rules = np["spec"]["ingress"]
        need(len(rules) == 1, "exactly one ingress rule")
        peers = sorted(p["podSelector"]["matchLabels"]["app.kubernetes.io/component"] for p in rules[0]["from"])
        need(peers == ["os-ui", "os-ui-worker"], f"peers {peers}")
        need(all(set(p) == {"podSelector"} for p in rules[0]["from"]), "a peer is not a plain podSelector")
        need(rules[0]["ports"] == [{"protocol": "TCP", "port": 5001}], "ports: " + str(rules[0]["ports"]))
if fails:
    print(f"docling-chart [{label}] FAIL:"); [print("  - " + f) for f in fails]; sys.exit(1)
print(f"docling-chart [{label}] ok")
'
}
rc=0
check default || rc=1
check stackit -f values.stackit-managed.yaml || rc=1
check "stackit --existing" -f values.stackit-managed.yaml --set docling.apiKey.existingSecret=ops-docling || rc=1
check "default --no-netpol" --set docling.networkPolicy.enabled=false || rc=1
# The digest is required: an empty one must fail the render, naming the value to set.
out=$(helm template t "$CHART" -n agentic-os --set docling.image.digest= 2>&1)
if [ $? -ne 0 ] && grep -q 'docling.image.digest must be set' <<<"$out"; then echo "docling-chart [no digest] ok (render refused)"
else echo "docling-chart [no digest] FAIL: rendered without a digest"; rc=1; fi
# localBuild (values.local.yaml) is the only way to render without one.
img=$(helm template t "$CHART" -n agentic-os -f values.local.yaml --show-only templates/extensions/docling/docling.yaml 2>/dev/null | sed -n 's/^ *image: "\(.*docling.*\)"$/\1/p')
case $img in *@*|'') echo "docling-chart [local] FAIL: $img"; rc=1 ;; *) echo "docling-chart [local] ok ($img)";; esac
# ...and localBuild must never render with a production signal (it is an unpinned image).
guard() { # guard <label> <want: refuse|render> helm-args...
  local label=$1 want=$2; shift 2
  # dataRunner.image.localBuild off: its own (identical) production refusal would stop the render
  # before docling's is reached; it has its own test (deploy-data-runner-image.test.sh).
  local out; out=$(helm template t "$CHART" -n agentic-os -f values.local.yaml --set dataRunner.image.localBuild=false "$@" --show-only templates/extensions/docling/docling.yaml 2>&1)
  if grep -q 'docling.image.localBuild=true is for a local kind cluster only' <<<"$out"; then got=refuse; else got=render; fi
  if [ "$got" = "$want" ]; then echo "docling-chart [localBuild $label] ok ($got)"; else echo "docling-chart [localBuild $label] FAIL: wanted $want, got $got"; rc=1; fi
}
guard "+ stackit profile"   refuse -f values.stackit-managed.yaml
guard "+ public URL"        refuse --set osUI.publicUrl=https://os.example.com
guard "+ ingress enabled"   refuse --set ingress.enabled=true
guard "+ public ingress host" refuse --set ingress.hosts.osUI=os.example.com
guard "+ localhost URL"     render --set osUI.publicUrl=http://localhost:8080
guard "+ *.local URL"       render --set osUI.publicUrl=https://os.example.local
exit $rc
