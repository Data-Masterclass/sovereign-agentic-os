#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# =============================================================================
# smoke-test.sh — read-only checks that a deployed release is really up.
# =============================================================================
#   ./scripts/smoke-test.sh [--expect-tag <version>] [--context <ctx>] [--namespace <ns>]
#                           [--release <rel>] [--host <public host>]
#
# WHY. `deploy.sh` ends when `helm upgrade` and one rollout return. That does not prove the
# worker booted, that no other pod is crash-looping, that the public URL answers, or that the
# restricted consoles stayed private. Each of those has gone wrong once. `scripts/release.sh`
# runs this after every deploy; it can also be run by hand at any time.
#
# READ-ONLY: kubectl get/logs, helm get values, curl. It changes nothing.
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
#   7. Every model in the LiteLLM ConfigMap carries `model_info` (prices; budgets need them).
#
# Hostnames, sizes and the apps namespace come from the release's computed values
# (`helm get values -a`), read by scripts/lib/smoke-facts.py, which prints only those keys.
#
# Environment: KUBE_CONTEXT (dmagenticos), NS (agentic-os), REL (agentic-os) — as deploy.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

CTX=${KUBE_CONTEXT:-dmagenticos}
NS=${NS:-agentic-os}
REL=${REL:-agentic-os}
CHART_VALUES=charts/sovereign-agentic-os/values.yaml
FACTS="python3 scripts/lib/smoke-facts.py"
EXPECT_TAG='' HOST=''

while [ $# -gt 0 ]; do
  case $1 in
    --expect-tag) EXPECT_TAG=${2:?}; shift ;;
    --context)    CTX=${2:?}; shift ;;
    --namespace)  NS=${2:?}; shift ;;
    --release)    REL=${2:?}; shift ;;
    --host)       HOST=${2:?}; shift ;;
    -h|--help)    sed -n '7,8p' "$0" | sed 's/^# //'; exit 0 ;;
    *) echo "smoke-test.sh: unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done

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
  backends=$(k get ingress -o jsonpath='{range .items[*].spec.rules[*].http.paths[*]}{.backend.service.name}{"\n"}{end}')
  for name in "$REL-litellm" "$REL-langfuse-web"; do
    if printf '%s\n' "$backends" | grep -qxF "$name"; then fail "no Ingress routes to $name"
    else pass "no Ingress routes to $name"; fi
  done
  for host in "$(fact gateway_host)" "$(fact langfuse_host)"; do
    [ -n "$host" ] || continue
    # -k: an unrouted host gets the controller's default certificate. Verifying it would fail
    # the TLS handshake and hide whether a route exists; this probe asks only about the route.
    code=$(curl -k -sS -o /dev/null -w '%{http_code}' --max-time 15 "https://$host/" 2>/dev/null || true)
    case $code in
      404|000|'') pass "https://$host is not served (${code:-no answer})" ;;
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

if [ ${#FAILED[@]} -eq 0 ]; then echo "SMOKE_OK"; exit 0; fi
echo "SMOKE_FAILED (${#FAILED[@]}): $(printf '%s; ' "${FAILED[@]}")"
exit 1
