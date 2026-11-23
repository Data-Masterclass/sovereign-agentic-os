#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# =============================================================================
# smoke-test.sh — read-only checks that a deployed release is really up.
# =============================================================================
#   ./scripts/smoke-test.sh [--env dev|prod] [--expect-tag <version>] [--context <ctx>] [--namespace <ns>]
#                           [--release <rel>] [--host <public host>]
#
# WHY. `deploy.sh` ends when `helm upgrade` and one rollout return. That does not prove the
# worker booted, that no other pod is crash-looping, that the public URL answers, or that the
# restricted consoles stayed private. Each of those has gone wrong once. `scripts/release.sh`
# runs this after every deploy; it can also be run by hand at any time.
#
# READ-ONLY: kubectl get/logs/port-forward/exec (a TCP probe), helm get values, curl. It changes nothing.
#
# Checks (any FAIL makes the exit status 1; NOTE lines are information only):
#   1. Deployments os-ui and os-ui-worker run the expected image tag and are fully Ready; docling
#      (when deployed) is fully Ready on its own pinned tag.
#   2. No pod in the platform namespace is in CrashLoopBackOff / ImagePullBackOff /
#      ErrImagePull. Pods in the user-apps namespace are LISTED, never failed on: student code
#      crashing is not a platform fault.
#   3. GET https://<public host>/api/health answers 200.
#   4. The gateway (LiteLLM) and Langfuse are NOT served: no Ingress routes to their Services,
#      and their hostnames from the release values (if any are set) answer 404 or nothing.
#   5. The worker's log has its boot line with `systems=hydrated`.
#   6. The ClickHouse PVC is at least the size the chart's values.yaml asks for.
#   7. Every model in the LiteLLM ConfigMap carries `model_info` (prices; budgets need them), and the
#      ConfigMap's model names are exactly those of deploy/gateway-models.yaml — the one catalog
#      deploy.sh layers on dev and prod (scripts/check-gateway-catalog-parity.mjs gates the render).
#      Run it from the commit that was deployed. Names only: models an admin added in the LiteLLM UI
#      live in its database, not in the ConfigMap, and are not compared.
#   9. The Dagster daemon (the run launcher) can open a TCP connection to the API server address
#      its own pod uses (KUBERNETES_SERVICE_HOST:KUBERNETES_SERVICE_PORT), via `kubectl exec`. On
#      Gardener that address is the injected domain, which `allow-apiserver-egress` must admit
#      (networkPolicies.apiserver.extraCidrs); without it no run Job is ever created.
#  10. OPA (when deployed) is Ready and its Service `opa` has a ready endpoint (EndpointSlice).
#  11. The three model roles (sovereign-strong / -worker / -embedding) resolve at LiteLLM: each
#      `router_settings.model_group_alias` entry exists and names a model `/model/info` serves.
#      Two GETs from inside os-ui via `kubectl exec`; only alias and model names are printed.
#   8. Langfuse can read its ClickHouse tables: upstream `GET /api/public/health` with
#      `failIfDatabaseUnavailable=true&failIfNoRecentEvents=true`, through `kubectl port-forward`
#      (Langfuse is never published, and the API-server proxy is outside the default-deny policy).
#      That check queries the `traces` table, so a ClickHouse that lost its tables answers
#      503 "Couldn't fetch recent events" (dev, 21 Nov 2026: every trace read was a 500 while the
#      plain health answered 200). 503 "No traces within the last 3 minutes" means the tables
#      answer and nothing was traced lately: that passes.
#
# Hostnames, sizes and the apps namespace come from the release's computed values
# (`helm get values -a`), read by scripts/lib/smoke-facts.py, which prints only those keys.
#
# Environment: KUBE_CONTEXT (dmagenticos), NS (agentic-os), REL (agentic-os) — as deploy.sh;
# GATEWAY_CATALOG (deploy/gateway-models.yaml) — the catalog check 7 compares with.
# --env dev|prod picks the context like deploy.sh (dev: DEV_KUBE_CONTEXT or dmagosdev) and runs
# scripts/lib/env-guard.sh on it. Without --env the old behaviour holds (KUBE_CONTEXT / --context).
set -euo pipefail
cd "$(dirname "$0")/.."

CTX=''
ENV_NAME=''
CTX_GIVEN=''

NS=${NS:-agentic-os}
REL=${REL:-agentic-os}
CHART_VALUES=charts/sovereign-agentic-os/values.yaml
FACTS="python3 scripts/lib/smoke-facts.py"
GATEWAY_CATALOG=${GATEWAY_CATALOG:-deploy/gateway-models.yaml}   # the catalog deploy.sh layers on dev and prod
EXPECT_TAG='' HOST=''

while [ $# -gt 0 ]; do
  case $1 in
    --expect-tag) EXPECT_TAG=${2:?}; shift ;;
    --context)    CTX_GIVEN=${2:?}; shift ;;
    --env)        ENV_NAME=${2:?}; shift ;;
    --namespace)  NS=${2:?}; shift ;;
    --release)    REL=${2:?}; shift ;;
    --host)       HOST=${2:?}; shift ;;
    -h|--help)    sed -n '7,8p' "$0" | sed 's/^# //'; exit 0 ;;
    *) echo "smoke-test.sh: unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done

if [ -n "$ENV_NAME" ]; then
  if [ "$ENV_NAME" = dev ]; then CTX=${CTX_GIVEN:-${DEV_KUBE_CONTEXT:-dmagosdev}}
  else CTX=${CTX_GIVEN:-${KUBE_CONTEXT:-dmagenticos}}; fi
  guard=$(bash scripts/lib/env-guard.sh --env "$ENV_NAME" --context "$CTX" 2>/dev/null) \
    || { echo "SMOKE_FAILED: ${guard##*$'\n'}"; exit 1; }
else
  CTX=${CTX_GIVEN:-${KUBE_CONTEXT:-dmagenticos}}
fi
FAILED=()
pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; FAILED+=("$1"); }
note() { printf '  note  %s\n' "$1"; }
k()    { kubectl --context "$CTX" -n "$NS" "$@"; }

# fact <name> — one value from the release facts read once below.
fact() { printf '%s\n' "$RELEASE_FACTS" | sed -n "s/^$1=//p"; }

echo "smoke test: context $CTX, namespace $NS, release $REL${EXPECT_TAG:+, expecting tag $EXPECT_TAG}"
RELEASE_FACTS=$(helm --kube-context "$CTX" get values "$REL" -n "$NS" -a -o json | $FACTS values) \
  || { echo "SMOKE_FAILED: could not read the release values"; exit 1; }
HOST=${HOST:-$(fact public_host)}

check_deployment() { # check_deployment <name> [--any-tag]  (--any-tag: the image is not os-ui's, so EXPECT_TAG does not apply)
  local line image ready replicas updated
  line=$(k get deploy "$1" -o jsonpath='{.spec.template.spec.containers[0].image}|{.status.readyReplicas}|{.spec.replicas}|{.status.updatedReplicas}' 2>/dev/null) \
    || { fail "deployment $1 exists"; return; }
  IFS='|' read -r image ready replicas updated <<<"$line"
  if [ -n "$EXPECT_TAG" ] && [ "${2:-}" != --any-tag ]; then
    case $image in
      *":$EXPECT_TAG" | *":$EXPECT_TAG@"*) pass "$1 runs tag $EXPECT_TAG" ;;
      *) fail "$1 runs tag $EXPECT_TAG (it runs ${image##*/})" ;;
    esac
  fi
  if [ "${replicas:-0}" -ge 1 ] && [ "${ready:-0}" = "$replicas" ] && [ "${updated:-0}" = "$replicas" ]; then
    pass "$1 Ready ($ready/$replicas)"
  else
    fail "$1 Ready (ready ${ready:-0}, updated ${updated:-0}, wanted $replicas)"
  fi
}

# stuck_pods <namespace> — "<pod> <reason>" for every container waiting on a bad reason.
stuck_pods() {
  kubectl --context "$CTX" -n "$1" get pods -o jsonpath='{range .items[*]}{.metadata.name}{" "}{range .status.initContainerStatuses[*]}{.state.waiting.reason}{" "}{end}{range .status.containerStatuses[*]}{.state.waiting.reason}{" "}{end}{"\n"}{end}' \
    | grep -E 'CrashLoopBackOff|ImagePullBackOff|ErrImagePull' \
    | awk '{ print $1, $2 }' || true
}

check_pods() {
  local stuck apps
  stuck=$(stuck_pods "$NS")
  if [ -z "$stuck" ]; then pass "no pod crash-looping or failing to pull in $NS"
  else fail "pods stuck in $NS: $(echo "$stuck" | paste -sd, -)"; fi
  apps=$(fact apps_namespace)
  if [ "$(fact apps_enabled)" = true ] && [ -n "$apps" ]; then
    stuck=$(stuck_pods "$apps")
    if [ -z "$stuck" ]; then note "no stuck pods in the user-apps namespace $apps"
    else note "user-apps pods stuck in $apps (not a platform failure): $(echo "$stuck" | paste -sd, -)"; fi
  fi
}

check_health() {
  local code
  [ -n "$HOST" ] || { fail "public host known (ingress.hosts.osUI is empty; pass --host)"; return; }
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "https://$HOST/api/health" 2>/dev/null || true)
  if [ "$code" = 200 ]; then pass "https://$HOST/api/health answers 200"
  else fail "https://$HOST/api/health answers 200 (got ${code:-nothing})"; fi
}

check_consoles_private() {
  local backends name host code
  # One line per Ingress: "<auth-type>|<auth-secret>|<backend>,<backend>,…". The gateway
  # (LiteLLM) must never be routed. Langfuse may be routed ONLY by the operator route (#276),
  # i.e. behind nginx basic auth from a Secret; any other route to it fails.
  backends=$(k get ingress -o jsonpath='{range .items[*]}{.metadata.annotations.nginx\.ingress\.kubernetes\.io/auth-type}{"|"}{.metadata.annotations.nginx\.ingress\.kubernetes\.io/auth-secret}{"|"}{range .spec.rules[*].http.paths[*]}{.backend.service.name}{","}{end}{"\n"}{end}')
  local line atype asecret svcs lf_protected=0 lf_open=0 gw_routed=0
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    case $line in *"|"*) atype=${line%%|*}; line=${line#*|}; asecret=${line%%|*}; svcs=${line#*|} ;; *) atype=''; asecret=''; svcs=$line ;; esac
    case ",$svcs," in *",$REL-litellm,"*) gw_routed=1 ;; esac
    case ",$svcs," in *",$REL-langfuse-web,"*)
      if [ "$atype" = basic ] && [ -n "$asecret" ]; then lf_protected=1; else lf_open=1; fi ;;
    esac
  done <<EOF_ING
$(printf '%s\n' "$backends")
EOF_ING
  if [ "$gw_routed" = 1 ]; then fail "no Ingress routes to $REL-litellm"; else pass "no Ingress routes to $REL-litellm"; fi
  if [ "$lf_open" = 1 ]; then fail "no Ingress routes to $REL-langfuse-web without basic auth"
  elif [ "$lf_protected" = 1 ]; then pass "$REL-langfuse-web is routed only behind basic auth (operator route)"
  else pass "no Ingress routes to $REL-langfuse-web"; fi
  for host in "$(fact gateway_host)" "$(fact langfuse_host)"; do
    [ -n "$host" ] || continue
    # -k: an unrouted host gets the controller's default certificate. Verifying it would fail
    # the TLS handshake and hide whether a route exists; this probe asks only about the route.
    code=$(curl -k -sS -o /dev/null -w '%{http_code}' --max-time 15 "https://$host/" 2>/dev/null || true)
    case $code in
      404|000|'') pass "https://$host is not served (${code:-no answer})" ;;
      401) if [ "$host" = "$(fact langfuse_host)" ] && [ "$lf_protected" = 1 ]; then pass "https://$host asks for credentials (operator route)"
           else fail "https://$host is not served (it answers 401)"; fi ;;
      *) fail "https://$host is not served (it answers $code)" ;;
    esac
  done
}

check_worker_boot() {
  # Captured first, not piped into `grep -q`: under pipefail an early-exiting grep makes kubectl
  # die of SIGPIPE, and the pipeline would report a failure for a log that matched.
  local log
  log=$(k logs deploy/os-ui-worker 2>/dev/null || true)
  if grep -q 'systems=hydrated' <<<"$log"; then
    pass "os-ui-worker logged its boot line with systems=hydrated"
  else
    fail "os-ui-worker logged its boot line with systems=hydrated"
  fi
}

check_clickhouse_volume() {
  local want have
  if [ "$(fact clickhouse_persistence)" != true ]; then note "ClickHouse persistence is off: no volume to check"; return; fi
  want=$($FACTS chart-size "$CHART_VALUES")
  have=$(k get pvc clickhouse-data -o jsonpath='{.status.capacity.storage}' 2>/dev/null || true)
  [ "$(fact clickhouse_size)" = "$want" ] \
    || note "the release pins clickhouse.persistence.size=$(fact clickhouse_size); the chart asks for $want"
  if [ -n "$have" ] && $FACTS ge "$have" "$want"; then pass "ClickHouse volume $have >= chart $want"
  else fail "ClickHouse volume ${have:-missing} >= chart $want"; fi
}

check_model_info() {
  local out missing count
  out=$(k get configmap "$REL-litellm-config" -o jsonpath='{.data.config\.yaml}' 2>/dev/null | $FACTS models-without-info) \
    || { fail "LiteLLM ConfigMap $REL-litellm-config readable"; return; }
  count=$(printf '%s\n' "$out" | sed -n 's/^models=//p')
  missing=$(printf '%s\n' "$out" | grep -v '^models=' | paste -sd, - || true)
  if [ "${count:-0}" -gt 0 ] && [ -z "$missing" ]; then pass "all $count LiteLLM models carry model_info"
  else fail "all LiteLLM models carry model_info (models: ${count:-0}; missing: ${missing:-none})"; fi
}

check_model_catalog() {
  local cm out miss extra
  cm=$(k get configmap "$REL-litellm-config" -o jsonpath='{.data.config\.yaml}' 2>/dev/null) \
    || { fail "LiteLLM ConfigMap $REL-litellm-config readable"; return; }
  if out=$(printf '%s\n' "$cm" | $FACTS catalog-diff "$GATEWAY_CATALOG"); then
    pass "LiteLLM catalog = $GATEWAY_CATALOG ($(printf '%s\n' "$out" | sed -n 's/^models=//p') models)"
  else
    miss=$(printf '%s\n' "$out" | sed -n 's/^missing=//p'); extra=$(printf '%s\n' "$out" | sed -n 's/^extra=//p')
    fail "LiteLLM catalog = $GATEWAY_CATALOG (committed but not live: ${miss:-none}; live but not committed: ${extra:-none})"
  fi
}

check_langfuse_traces() {
  local svc="$REL-langfuse-web" log pf port='' resp code body status i
  if [ "$(fact langfuse_enabled)" != true ]; then note "Langfuse is off: no trace store to check"; return; fi
  log=$(mktemp)
  k port-forward "svc/$svc" :3000 >"$log" 2>&1 &
  pf=$!
  for i in $(seq 1 40); do
    port=$(sed -n 's/^Forwarding from 127\.0\.0\.1:\([0-9]*\).*/\1/p' "$log" | head -1)
    [ -n "$port" ] && break
    kill -0 "$pf" 2>/dev/null || break
    sleep 0.25
  done
  if [ -z "$port" ]; then
    kill "$pf" 2>/dev/null || true; wait "$pf" 2>/dev/null || true; rm -f "$log"
    fail "Langfuse reachable through kubectl port-forward (svc/$svc)"; return
  fi
  resp=$(curl -sS --max-time 30 -w '\n%{http_code}' "http://127.0.0.1:$port/api/public/health?failIfDatabaseUnavailable=true&failIfNoRecentEvents=true" 2>/dev/null || true)
  kill "$pf" 2>/dev/null || true; wait "$pf" 2>/dev/null || true; rm -f "$log"
  code=${resp##*$'\n'}; body=${resp%$'\n'*}
  status=$(printf '%s' "$body" | python3 -c 'import json,sys
try: d=json.load(sys.stdin); print(d.get("status",""), "|", d.get("version",""))
except Exception: print("|")' 2>/dev/null || echo '|')
  case "$code:${status%% |*}" in
    200:*) pass "Langfuse reads ClickHouse: ${status%% |*} (Langfuse ${status##*| })" ;;
    503:"No traces within"*|503:"No observations within"*|503:"No events within"*)
      pass "Langfuse reads ClickHouse: the tables answer, no trace in the last 3 minutes" ;;
    *) fail "Langfuse reads ClickHouse (${code:-no answer}: ${status%% |*})" ;;
  esac
}

check_dagster_apiserver() {
  local dep="$REL-dagster-daemon" out
  k get deploy "$dep" >/dev/null 2>&1 || { note "no Dagster daemon: no run launcher to check"; return; }
  out=$(k exec "deploy/$dep" -c dagster -- python3 -c 'import os, socket
h, p = os.environ.get("KUBERNETES_SERVICE_HOST", ""), int(os.environ.get("KUBERNETES_SERVICE_PORT", "443"))
try:
    socket.create_connection((h, p), timeout=5).close(); print("connected", h, p)
except Exception as e:
    print("refused", h, p, type(e).__name__)' 2>/dev/null || true)
  case $out in
    connected*) pass "Dagster daemon reaches the API server (${out#connected })" ;;
    refused*)   fail "Dagster daemon reaches the API server (${out#refused }; networkPolicies.apiserver.extraCidrs)" ;;
    *)          fail "Dagster daemon reaches the API server (kubectl exec gave no answer)" ;;
  esac
}

# check_opa — the Deployment is Ready AND its Service has a ready endpoint. A pod whose readiness
# probe (`/health?bundles`) fails has no endpoint: every OPA-checked action then answers
# `opa-unreachable` while os-ui and the worker stay green (dev, 21-22 Nov 2026, 16 hours).
check_opa() {
  local ready
  if ! k get deploy opa >/dev/null 2>&1; then note "no OPA Deployment: no policy decision point to check"; return; fi
  check_deployment opa --any-tag
  ready=$(k get endpointslices -l kubernetes.io/service-name=opa \
    -o jsonpath='{range .items[*].endpoints[?(@.conditions.ready==true)]}{.addresses[0]}{" "}{end}' 2>/dev/null || true)
  if [ -n "${ready// /}" ]; then pass "opa Service has a ready endpoint"
  else fail "opa Service has a ready endpoint (none: every OPA-checked action answers opa-unreachable)"; fi
}

# check_role_aliases — the three model roles resolve at the gateway: LiteLLM's
# `router_settings.model_group_alias` maps sovereign-strong / -worker / -embedding to a model that `/model/info`
# serves. Without it every role call answers "Invalid model name" while every pod is green (prod 0.9.32,
# 23 Nov 2026: the first mapping timed out at boot). Two GETs from inside os-ui (`kubectl exec`), with the master
# key os-ui already holds; only alias and model NAMES are printed, never the key. The first mapping retries without
# end (5 s, 15 s, 30 s, 60 s, 120 s, then every 300 s); after ~50 s of failures it is also the Monitoring alert
# "Model roles not mapped". This check waits up to ~2 min (8 tries, 15 s apart), so a boot that only maps on the 5th
# attempt (~110 s plus boot time) or later can FAIL here BY DESIGN: a release whose roles are not mapped within
# ~2 min of the rollout is not a healthy release, even if the retry heals it later.
ROLE_ALIASES_JS='
const base = (process.env.LITELLM_URL || "").replace(/\/+$/, ""), key = process.env.LITELLM_MASTER_KEY || "";
const get = async (p) => { const r = await fetch(base + p, { headers: { authorization: "Bearer " + key }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(p + " HTTP " + r.status); return r.json(); };
(async () => {
  const s = await get("/router/settings"), info = await get("/model/info");
  const aliases = (s.current_values && s.current_values.model_group_alias) || {};
  const rows = Array.isArray(info) ? info : (info.data || []);
  const models = new Set(rows.map((m) => m.model_name).filter((n) => n && !(n in aliases)));
  for (const role of ["sovereign-strong", "sovereign-worker", "sovereign-embedding"]) {
    const t = aliases[role];
    console.log(role + "=" + (t === undefined ? "UNMAPPED" : models.has(t) ? String(t) : "NOT-IN-CATALOG:" + String(t)));
  }
})().catch((e) => { console.log("error=" + String(e && e.message || e).slice(0, 200)); });'
# SMOKE_ROLE_ALIAS_TRIES / SMOKE_ROLE_ALIAS_INTERVAL (seconds): 8 and 15 for a real run; the test harness sets 1 and 0.
check_role_aliases() {
  local out bad i tries=${SMOKE_ROLE_ALIAS_TRIES:-8} interval=${SMOKE_ROLE_ALIAS_INTERVAL:-15}
  for ((i = 1; i <= tries; i++)); do
    out=$(k exec deploy/os-ui -c os-ui -- node -e "$ROLE_ALIASES_JS" 2>/dev/null || true)
    bad=$(printf '%s\n' "$out" | grep -E '^(error=|[a-z-]+=(UNMAPPED|NOT-IN-CATALOG))' | paste -sd, - || true)
    if [ -n "$out" ] && [ -z "$bad" ] && [ "$(printf '%s\n' "$out" | grep -c '^sovereign-')" = 3 ]; then
      pass "model roles resolve at the gateway ($(printf '%s\n' "$out" | paste -sd' ' -))"; return
    fi
    [ "$i" -ge "$tries" ] || sleep "$interval"
  done
  fail "model roles resolve at the gateway (${bad:-no answer from kubectl exec}; map them in Platform → Models → Roles)"
}

check_deployment os-ui
check_deployment os-ui-worker
# Docling serves os-ui's document conversions; its own tag is pinned in the chart.
if k get deploy docling >/dev/null 2>&1; then check_deployment docling --any-tag; fi
check_pods
check_health
check_consoles_private
check_worker_boot
check_clickhouse_volume
check_model_info
check_model_catalog
check_langfuse_traces
check_dagster_apiserver
check_opa
check_role_aliases

if [ ${#FAILED[@]} -eq 0 ]; then echo "SMOKE_OK"; exit 0; fi
echo "SMOKE_FAILED (${#FAILED[@]}): $(printf '%s; ' "${FAILED[@]}")"
exit 1
