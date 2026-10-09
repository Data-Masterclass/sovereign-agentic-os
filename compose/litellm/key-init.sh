#!/bin/sh
# Provisions the scoped virtual key agent-runtime uses: poll LiteLLM
# readiness, GET /key/info, then POST /key/generate only if absent
# (idempotent). MASTER_KEY / VIRTUAL_KEY come from compose.yaml's environment.
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
