#!/bin/sh
# Layer A (docker compose) — replicates
# charts/sovereign-agentic-os/templates/litellm/agent-key.yaml's Job logic:
# poll LiteLLM readiness, then GET /key/info, then POST /key/generate only if
# the key is absent (idempotent). Runs in curlimages/curl, same image the
# chart's Job uses (agent-key.yaml line 64).
#
# MASTER_KEY / VIRTUAL_KEY come from the environment (compose.yaml), mirroring
# the chart Job's two Secret-sourced envs (agent-key.yaml lines 70-73). Every
# other field below (alias/models/budget/limits) is a literal, matching the
# chart's rendered PAYLOAD for the default litellmAgentKey values
# (values.yaml:688-720) exactly as Helm would have rendered them — the chart
# itself bakes these in as literals from values at render time, not as env
# vars, so hardcoding them here mirrors the chart 1:1.
set -e

B=http://agentic-os-litellm:4000

echo "waiting for LiteLLM readiness..."
i=1
while [ "$i" -le 60 ]; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "$B/health/readiness" || true)
  if [ "$code" = "200" ]; then
    echo "litellm ready"
    break
  fi
  i=$((i + 1))
  sleep 3
done

info=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $MASTER_KEY" \
  "$B/key/info?key=$VIRTUAL_KEY" || true)
if [ "$info" = "200" ]; then
  echo "virtual key already provisioned"
  exit 0
fi

echo "provisioning scoped virtual key (alias=sovereign-agents, budget=5, rpm=120, tpm=200000)..."
PAYLOAD='{"key":"'"$VIRTUAL_KEY"'","key_alias":"sovereign-agents","models":["sovereign-default","sovereign-mock","sovereign-reasoning","sovereign-embed"],"max_budget":5,"rpm_limit":120,"tpm_limit":200000,"max_parallel_requests":8}'
curl -fsS -X POST "$B/key/generate" \
  -H "Authorization: Bearer $MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" >/dev/null && echo "virtual key created"
