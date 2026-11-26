#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# =============================================================================
# budget-check.sh — proof on the dev cluster that a LiteLLM budget BLOCKS, not just counts.
# =============================================================================
#   scripts/dev/budget-check.sh         (dev only; CI runs it after the smoke test)
#
# LiteLLM enforces budgets from its database; without one, spend is not tracked and a budget
# fails open. So, against the running gateway (a port-forward, the master key read from the
# release's litellm-credentials Secret and never printed):
#   1. /health/readiness must report the database as connected;
#   2. a throwaway virtual key with a TINY budget (max_budget 1e-7, 15-minute lifetime, the
#      standard model only) makes calls of one output token until LiteLLM refuses one for its
#      budget (HTTP 400, "budget"); it must do so within BUDGET_CHECK_SECONDS (default 180).
#      A refusal for any other reason, or none at all, fails the check;
#   3. the key is deleted.
# The same database-backed enforcement is what makes values.dev.yaml's TOTAL budget
# (litellm_settings.max_budget) hold. Cost: a few one-token calls, a fraction of a cent.
# Last line: BUDGET_CHECK_OK | BUDGET_CHECK_FAILED: <why>
. "$(dirname "$0")/lib.sh"
require_marked_dev
SVC=${LITELLM_SVC:-agentic-os-litellm}
WAIT=${BUDGET_CHECK_SECONDS:-180}
fail() { echo "BUDGET_CHECK_FAILED: $*"; exit 1; }

MASTER=$(k -n "$NS" get secret litellm-credentials -o jsonpath='{.data.masterkey}' | base64 -d) || fail "no litellm-credentials"
[ -n "$MASTER" ] || fail "empty master key"
[ -z "${GITHUB_ACTIONS:-}" ] || echo "::add-mask::$MASTER"
PF_LOG=$(mktemp); k -n "$NS" port-forward "svc/$SVC" :4000 > "$PF_LOG" 2>&1 & PF=$!
KEY=''
cleanup() {
  if [ -n "$KEY" ] && [ -n "${URL:-}" ]; then
    curl -s -o /dev/null -X POST "$URL/key/delete" -H "Authorization: Bearer $MASTER" \
      -H 'Content-Type: application/json' -d "{\"keys\": [\"$KEY\"]}" || true
  fi
  # Also by alias: a run cut off before KEY was set, or whose delete above failed, must not
  # leave the alias behind (LiteLLM refuses a second key with the same alias).
  if [ -n "${URL:-}" ]; then
    curl -s -o /dev/null -X POST "$URL/key/delete" -H "Authorization: Bearer $MASTER" \
      -H 'Content-Type: application/json' -d '{"key_aliases": ["dev-budget-check"]}' || true
  fi
  kill "$PF" 2>/dev/null || true; rm -f "$PF_LOG"
}
trap cleanup EXIT
for _ in $(seq 1 30); do
  port=$(sed -n 's/.*127\.0\.0\.1:\([0-9]*\).*/\1/p' "$PF_LOG" | head -1)
  [ -n "$port" ] && break; sleep 1
done
[ -n "${port:-}" ] || fail "no port-forward to svc/$SVC"
URL=http://127.0.0.1:$port
H=(-H "Authorization: Bearer $MASTER" -H 'Content-Type: application/json')

say "1. the gateway's database is connected"
ready=$(curl -s "$URL/health/readiness" "${H[@]}") || fail "/health/readiness unreachable"
db=$(printf '%s' "$ready" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("db",""))' 2>/dev/null || true)
[ "$db" = connected ] || fail "LiteLLM reports db='${db:-none}' — budgets would fail open"
echo "   db=connected"

say "2. a key with a tiny budget is refused once it is spent"
# A previous run that died before its cleanup leaves the alias taken; clear it first.
curl -s -o /dev/null -X POST "$URL/key/delete" "${H[@]}" -d '{"key_aliases": ["dev-budget-check"]}' || true
KEY=$(curl -s -X POST "$URL/key/generate" "${H[@]}" \
  -d '{"max_budget": 0.0000001, "duration": "15m", "models": ["sovereign-default"], "key_alias": "dev-budget-check"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("key",""))') || true
[ -n "$KEY" ] || fail "/key/generate returned no key"
[ -z "${GITHUB_ACTIONS:-}" ] || echo "::add-mask::$KEY"
deadline=$(( $(date +%s) + WAIT )); ok_calls=0; refused=''
while [ "$(date +%s)" -lt "$deadline" ]; do
  body=$(mktemp)
  code=$(curl -s -o "$body" -w '%{http_code}' -X POST "$URL/chat/completions" \
    -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
    -d '{"model": "sovereign-default", "max_tokens": 1, "messages": [{"role": "user", "content": "ping"}]}')
  if [ "$code" = 200 ]; then ok_calls=$((ok_calls+1))
  elif grep -qi 'budget' "$body"; then refused=$code; rm -f "$body"; break
  else msg=$(head -c 300 "$body"); rm -f "$body"; fail "call refused with HTTP $code, not for budget: $msg"
  fi
  rm -f "$body"; sleep 5
done
[ -n "$refused" ] || fail "no budget refusal within ${WAIT}s after $ok_calls successful call(s) — the budget does not block"
[ "$ok_calls" -ge 1 ] || fail "refused before any spend ($refused) — the check proved nothing"
echo "   $ok_calls call(s) succeeded, then HTTP $refused for the budget"
echo "BUDGET_CHECK_OK"
