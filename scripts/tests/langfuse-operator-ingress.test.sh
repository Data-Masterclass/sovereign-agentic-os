#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# =============================================================================
# langfuse-operator-ingress.test.sh — chart test for the operators' browser route to Langfuse.
# =============================================================================
#   bash scripts/tests/langfuse-operator-ingress.test.sh [<base git ref>]
#
# `ingress.restricted.langfuse.operatorIngress.enabled` (OFF by default; values.dev.yaml turns it
# on) publishes the Langfuse web UI on `ingress.hosts.langfuse`, behind nginx basic auth from an
# htpasswd Secret — the same protection the Dagster console has — with Langfuse's own login
# still in place behind it. Renders the chart (no cluster) and asserts:
#   1. OFF (default and STACKIT profiles) changes nothing: the render equals the render without the
#      `operatorIngress` key and with enabled=false; given a base git ref (argument or
#      LANGFUSE_RENDER_BASE), it also equals that commit's render. "Equal" is byte-identical apart
#      from the per-render random secrets: the lines that differ between two reference renders;
#   2. OFF: no Ingress has the Langfuse web Service as backend; NEXTAUTH_URL keeps its default;
#      the Langfuse NetworkPolicy does not admit the ingress controller;
#   3. ON (values.dev.yaml): exactly one Ingress to agentic-os-langfuse-web on
#      langfuse.dev.agentic.datamasterclass.com, with cert-manager TLS, basic auth from
#      `langfuse-basic-auth`, every annotation value ASCII; Langfuse's NEXTAUTH_URL (web AND
#      worker) and os-ui's LANGFUSE_CONSOLE_URL are https://<that host>/tools/langfuse; the Langfuse
#      NetworkPolicy admits the ingress controller;
#   4. negative twins — each must FAIL the render: ON without a host, ON with a NEXTAUTH_URL that
#      is not https://<host>, ON with an empty basicAuthSecret; and STACKIT + a langfuse host
#      WITHOUT the flag still renders no route (the restricted-console rule is unchanged).
# Skips (exit 0) without helm, PyYAML or the subchart .tgz files — but FAILS when CI is set.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
. scripts/tests/assert.sh
CHART=charts/sovereign-agentic-os
TMP=$(mktemp -d)
cleanup() { git worktree remove --force "$TMP/base" >/dev/null 2>&1; rm -rf "$TMP"; }
trap cleanup EXIT
NAME=langfuse-operator-ingress
skip() {
  if [ -n "${CI:-}" ]; then echo "$NAME: $1 — FAILING because CI is set"; exit 1; fi
  echo "$NAME: $1 — SKIPPED"; exit 0
}
command -v helm >/dev/null 2>&1 || skip "helm not on PATH"
ls "$CHART"/charts/*.tgz >/dev/null 2>&1 || skip "no subchart .tgz (run: helm dependency build $CHART)"
python3 -c 'import yaml' 2>/dev/null || skip "python3 has no PyYAML"

# A test render: it keeps the chart's published default secrets on purpose, which
# templates/base/secret-defaults-guard.yaml refuses for a real install.
T=(--skip-schema-validation --set global.allowChartDefaultSecrets=true)
render() { # render <chart> <out> <helm args...>
  local chart=$1 out=$2; shift 2
  helm template agentic-os "$chart" -n agentic-os "$@" >"$out" 2>"$out.err"
}
HOST=langfuse.dev.agentic.datamasterclass.com

cat >"$TMP/same.py" <<'PY'
import sys
b1, b2, head = (open(p).read().split("\n") for p in sys.argv[1:4])
if len(b1) != len(b2):
    print(f"the reference renders differ in length ({len(b1)} vs {len(b2)}): cannot isolate the random lines"); sys.exit(1)
if len(head) != len(b1):
    print(f"line count {len(head)} != reference {len(b1)}"); sys.exit(1)
volatile = {i for i, (x, y) in enumerate(zip(b1, b2)) if x != y}
diff = [i for i, (x, y) in enumerate(zip(b1, head)) if x != y and i not in volatile]
if diff:
    i = diff[0]; print(f"{len(diff)} line(s) differ, first at {i+1}: ref={b1[i][:160]!r} got={head[i][:160]!r}"); sys.exit(1)
print(f"identical ({len(volatile)} random-secret lines ignored)")
PY
# same <label> <ref chart> <chart> <ref args (one string, word-split)> <args...> — the render of
# <chart> with <args> equals the reference render, apart from the lines that differ between two
# renders of the reference (the per-render random secrets).
same() {
  local label=$1 rchart=$2 chart=$3 rargs=$4; shift 4
  # shellcheck disable=SC2086
  if ! { render "$rchart" "$TMP/r1" "${T[@]}" $rargs && render "$rchart" "$TMP/r2" "${T[@]}" $rargs; }; then
    bad "$label: the reference renders" "$(head -c 300 "$TMP/r1.err")"; return
  fi
  render "$chart" "$TMP/g" "${T[@]}" "$@" || { bad "$label: renders" "$(head -c 300 "$TMP/g.err")"; return; }
  out=$(python3 "$TMP/same.py" "$TMP/r1" "$TMP/r2" "$TMP/g"); rc=$?
  rc_is "$label — $out" 0
}

echo "== 1. OFF changes nothing (random secrets aside)"
# The new values key contributes nothing while off: the default render equals the render with the
# whole `operatorIngress` key deleted (helm: null removes a key), and with enabled=false.
for prof in default stackit; do
  pf=""; [ "$prof" = stackit ] && pf="-f values.stackit-managed.yaml"
  # shellcheck disable=SC2086
  same "OFF, $prof profile: = the render without the operatorIngress key" "$CHART" "$CHART" \
    "$pf --set ingress.restricted.langfuse.operatorIngress=null" $pf
  # shellcheck disable=SC2086
  same "OFF, $prof profile: = the render with operatorIngress.enabled=false" "$CHART" "$CHART" \
    "$pf --set ingress.restricted.langfuse.operatorIngress.enabled=false" $pf
done
# With a base git ref (the PR's base), also: the OFF render equals the base commit's render.
BASE=${1:-${LANGFUSE_RENDER_BASE:-}}
if [ -n "$BASE" ]; then
  git rev-parse -q --verify "$BASE^{commit}" >/dev/null && git worktree add --detach "$TMP/base" "$BASE" >/dev/null 2>&1 \
    || { bad "check out the base ref $BASE"; finish "$NAME"; exit 1; }
  mkdir -p "$TMP/base/$CHART/charts" && cp "$CHART"/charts/*.tgz "$TMP/base/$CHART/charts/"
  same "OFF, default profile: = the render of $BASE" "$TMP/base/$CHART" "$CHART" ""
  same "OFF, stackit profile: = the render of $BASE" "$TMP/base/$CHART" "$CHART" "-f $TMP/base/values.stackit-managed.yaml" -f values.stackit-managed.yaml
else
  echo "  (no base ref given: the comparison with the base commit's render is not run)"
fi
render "$CHART" "$TMP/h.default" "${T[@]}"
render "$CHART" "$TMP/h.stackit" "${T[@]}" -f values.stackit-managed.yaml

# The checker over one rendered file. Prints "ok" or the reason.
cat >"$TMP/check.py" <<'PY'
import sys, yaml
mode, path, host = sys.argv[1], sys.argv[2], sys.argv[3]
docs = [d for d in yaml.safe_load_all(open(path)) if isinstance(d, dict)]
def backends(ing):
    for r in ing.get("spec", {}).get("rules", []) or []:
        for p in (r.get("http") or {}).get("paths", []) or []:
            yield p["backend"]["service"]["name"]
lf = [d for d in docs if d.get("kind") == "Ingress" and "agentic-os-langfuse-web" in backends(d)]
def env_of(name, var):
    for d in docs:
        if d.get("kind") == "Deployment" and d["metadata"]["name"] == name:
            for c in d["spec"]["template"]["spec"]["containers"]:
                for e in c.get("env", []) or []:
                    if e.get("name") == var: return e.get("value")
    return None
pol = next((d for d in docs if d.get("kind") == "NetworkPolicy" and d["metadata"]["name"] == "langfuse-web-allow-os-only"), None)
def admits_controller():
    for rule in (pol or {}).get("spec", {}).get("ingress", []):
        for f in rule.get("from", []):
            if (f.get("namespaceSelector") or {}).get("matchLabels", {}).get("kubernetes.io/metadata.name") == "ingress-nginx": return True
    return False
errs = []
if mode == "off":
    if lf: errs.append(f"{len(lf)} Ingress(es) route to Langfuse: {[d['metadata']['name'] for d in lf]}")
    if env_of("agentic-os-langfuse-web", "NEXTAUTH_URL") != "http://localhost:3000/tools/langfuse": errs.append("NEXTAUTH_URL is " + repr(env_of("agentic-os-langfuse-web", "NEXTAUTH_URL")))
    if admits_controller(): errs.append("the Langfuse NetworkPolicy admits the ingress controller")
elif mode == "on":
    if len(lf) != 1: errs.append(f"want exactly 1 Langfuse Ingress, got {len(lf)}")
    else:
        i = lf[0]; a = i["metadata"].get("annotations", {}) or {}
        want = {"nginx.ingress.kubernetes.io/auth-type": "basic", "nginx.ingress.kubernetes.io/auth-secret": "langfuse-basic-auth",
                "cert-manager.io/cluster-issuer": "letsencrypt-prod"}
        for k, v in want.items():
            if a.get(k) != v: errs.append(f"annotation {k}={a.get(k)!r}, want {v!r}")
        if not a.get("nginx.ingress.kubernetes.io/auth-realm"): errs.append("no auth-realm")
        bad_ascii = {k: v for k, v in a.items() if not str(v).isascii()}
        if bad_ascii: errs.append(f"non-ASCII annotation values (ingress-nginx refuses them): {bad_ascii}")
        hosts = [r.get("host") for r in i["spec"].get("rules", [])]
        if hosts != [host]: errs.append(f"rule hosts {hosts}, want [{host}]")
        tls = i["spec"].get("tls", [])
        if not tls or tls[0].get("hosts") != [host] or tls[0].get("secretName") != f"{host}-tls": errs.append(f"tls {tls}")
        if i["spec"].get("ingressClassName") != "nginx": errs.append("class " + repr(i["spec"].get("ingressClassName")))
    for dep in ("agentic-os-langfuse-web", "agentic-os-langfuse-worker"):
        v = env_of(dep, "NEXTAUTH_URL")
        if v != f"https://{host}/tools/langfuse": errs.append(f"{dep} NEXTAUTH_URL={v!r}, want https://{host}/tools/langfuse")
    v = env_of("os-ui", "LANGFUSE_CONSOLE_URL")
    if v != f"https://{host}/tools/langfuse": errs.append(f"os-ui LANGFUSE_CONSOLE_URL={v!r}, want https://{host}/tools/langfuse")
    if not admits_controller(): errs.append("the Langfuse NetworkPolicy does not admit the ingress controller")
elif mode == "noroute":
    if lf: errs.append(f"{len(lf)} Ingress(es) route to Langfuse without the flag")
    v = env_of("os-ui", "LANGFUSE_CONSOLE_URL")
    if v != "": errs.append(f"os-ui LANGFUSE_CONSOLE_URL={v!r}, want empty (no route, no link)")
print("ok" if not errs else "; ".join(errs))
PY
verdict() { python3 "$TMP/check.py" "$1" "$2" "$HOST"; }

echo "== 2. OFF: no route, defaults unchanged"
for prof in default stackit; do
  [ -s "$TMP/h.$prof" ] || continue
  check "OFF, $prof profile: no Langfuse Ingress, defaults kept" ok "$(verdict off "$TMP/h.$prof")"
done

echo "== 3. ON (values.dev.yaml)"
if render "$CHART" "$TMP/dev" "${T[@]}" -f values.dev.yaml; then
  check "values.dev.yaml: one protected Langfuse Ingress; NEXTAUTH_URL and the OS's links use its host" ok "$(verdict on "$TMP/dev")"
else
  bad "values.dev.yaml renders" "$(grep -v level=INFO "$TMP/dev.err" | head -c 400)"
fi

echo "== 4. negative twins"
fails() { # fails <label> <expected error substring> <helm args...>
  local label=$1 want=$2; shift 2
  if render "$CHART" "$TMP/twin" "${T[@]}" -f values.dev.yaml "$@"; then
    bad "$label fails the render" "it rendered"
  else
    check "$label fails the render" "$want" "$(cat "$TMP/twin.err")"
  fi
}
fails "ON without ingress.hosts.langfuse" "operatorIngress" --set ingress.hosts.langfuse=
fails "ON with a NEXTAUTH_URL that is not https://<host>" "NEXTAUTH_URL" --set langfuse.langfuse.nextauth.url=http://localhost:3000
fails "ON with an empty basicAuthSecret" "basicAuthSecret" --set ingress.restricted.langfuse.operatorIngress.basicAuthSecret=
if render "$CHART" "$TMP/nr" "${T[@]}" -f values.stackit-managed.yaml --set ingress.hosts.langfuse=$HOST; then
  check "STACKIT + a langfuse host, flag OFF: still no route and no console link" ok "$(verdict noroute "$TMP/nr")"
else
  bad "STACKIT + a langfuse host renders" "$(head -c 300 "$TMP/nr.err")"
fi
finish "$NAME"
