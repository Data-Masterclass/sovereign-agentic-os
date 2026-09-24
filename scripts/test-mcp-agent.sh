#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
#
# One-shot end-to-end test of mcp-test-agent: build + load the image, mint the
# demo user's MCP token, deploy/upgrade it into the cluster, ask it a question,
# print the result. See docs/components/mcp-test-agent.md for the manual,
# step-by-step version of everything this script does.
#
# Prereqs: a kind cluster with the rest of the OS already deployed (base tier),
# and kubectl pointed at it. Requires a port-forward to os-ui on localhost:8080
# (started for you if not already running).
#
# Skips the build/load/deploy steps when the agent is already Running — pass
# --redeploy as the first argument to force them anyway (e.g. after an app.py
# change, or to rotate the token).
#
# Usage: ./scripts/test-mcp-agent.sh [--redeploy] <username> <password> "<question>" [cluster] [namespace]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

USAGE="Usage: $0 [--redeploy] <username> <password> \"<question>\" [cluster] [namespace]"

REDEPLOY=false
if [ "${1:-}" = "--redeploy" ]; then
  REDEPLOY=true
  shift
fi

USERNAME="${1:?$USAGE}"
PASSWORD="${2:?$USAGE}"
QUESTION="${3:?$USAGE}"
CLUSTER="${4:-agentic-os}"
NAMESPACE="${5:-agentic-os}"

# The shipped `sovereign-mock` LiteLLM model routes through STACKIT and breaks
# whenever STACKIT_API_KEY is unset (the case on most local kind clusters, and
# after a litellm pod restart even when it briefly worked before — sample-agent
# hits the exact same failure, it's not specific to this agent). Rather than
# depend on that shared, fragile alias, this script registers its OWN dedicated
# model pointing straight at the local mock-model service, every run — cheap
# and idempotent, so a restart of anything never breaks this script's own test.
MOCK_MODEL_NAME="local-mock"
LITELLM_MASTER_KEY="${LITELLM_MASTER_KEY:-sk-litellm-local-dev-master}"

OS_UI_PF_PID=""
LITELLM_PF_PID=""
AGENT_PF_PID=""
cleanup() {
  [ -n "$OS_UI_PF_PID" ] && kill "$OS_UI_PF_PID" 2>/dev/null || true
  [ -n "$LITELLM_PF_PID" ] && kill "$LITELLM_PF_PID" 2>/dev/null || true
  [ -n "$AGENT_PF_PID" ] && kill "$AGENT_PF_PID" 2>/dev/null || true
}
trap cleanup EXIT

ALREADY_RUNNING=false
if [ "$REDEPLOY" = false ] && kubectl -n "$NAMESPACE" get deployment mcp-test-agent >/dev/null 2>&1; then
  READY=$(kubectl -n "$NAMESPACE" get deployment mcp-test-agent -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "")
  [ "$READY" = "1" ] && ALREADY_RUNNING=true
fi

if [ "$ALREADY_RUNNING" = true ]; then
  echo "==> mcp-test-agent is already Running — skipping build/load/deploy (pass --redeploy to force)"
else
echo "==> 1/6 building sovereign-os/mcp-test-agent:0.1.0"
docker build -q -t sovereign-os/mcp-test-agent:0.1.0 images/base/mcp-test-agent >/dev/null

echo "==> 2/6 loading into kind cluster '$CLUSTER'"
kind load docker-image sovereign-os/mcp-test-agent:0.1.0 --name "$CLUSTER" >/dev/null

echo "==> 3/6 minting MCP token for $USERNAME"
if ! curl -sS -o /dev/null "http://localhost:8080/api/health" 2>/dev/null; then
  kubectl -n "$NAMESPACE" port-forward svc/os-ui 8080:3000 >/dev/null 2>&1 &
  OS_UI_PF_PID=$!
  sleep 3
fi
TOKEN=$(./scripts/get-mcp-token.sh "$USERNAME" "$PASSWORD" | grep '^soa_mcp_' )

echo "==> 4/6 ensuring the '$MOCK_MODEL_NAME' LiteLLM model is registered"
if ! curl -sS -o /dev/null "http://localhost:4000/health/liveliness" 2>/dev/null; then
  kubectl -n "$NAMESPACE" port-forward svc/agentic-os-litellm 4000:4000 >/dev/null 2>&1 &
  LITELLM_PF_PID=$!
  sleep 3
fi
# Idempotent: if it's already registered this errors (harmlessly) and we move on —
# sovereign-mock itself proved that depending on ONE shared model breaks under a
# restart, so this script owns its own, dedicated, always-local model instead.
curl -sS -X POST http://localhost:4000/model/new \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" -H "Content-Type: application/json" \
  -d "{\"model_name\": \"$MOCK_MODEL_NAME\", \"litellm_params\": {\"model\": \"openai/mock-model\", \"api_base\": \"http://mock-model:8080/v1\", \"api_key\": \"sk-mock-unused\"}}" \
  >/dev/null 2>&1 || true

# Registering a model does NOT grant existing scoped keys access to it — the
# agent's key (agent-litellm-key) has an explicit model allowlist. Re-set it
# every run (idempotent: same list in, same list out if already current) so
# this agent can actually call the model we just ensured exists.
AGENT_KEY=$(kubectl -n "$NAMESPACE" get secret agent-litellm-key -o jsonpath='{.data.apiKey}' | base64 -d)
curl -sS -X POST http://localhost:4000/key/update \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" -H "Content-Type: application/json" \
  -d "{\"key\": \"$AGENT_KEY\", \"models\": [\"sovereign-default\", \"sovereign-mock\", \"sovereign-reasoning\", \"sovereign-embed\", \"$MOCK_MODEL_NAME\"]}" \
  >/dev/null 2>&1 || true

echo "==> 5/6 deploying (helm upgrade --reuse-values)"
helm upgrade agentic-os charts/sovereign-agentic-os -n "$NAMESPACE" --reuse-values \
  --set mcpTestAgent.enabled=true \
  --set mcpTestAgent.image.repository=sovereign-os/mcp-test-agent \
  --set mcpTestAgent.image.tag=0.1.0 \
  --set mcpTestAgent.chatModel="$MOCK_MODEL_NAME" \
  --set mcpTestAgent.resources.requests.cpu=50m \
  --set mcpTestAgent.resources.requests.memory=128Mi \
  --set mcpTestAgent.resources.limits.cpu=250m \
  --set mcpTestAgent.resources.limits.memory=256Mi \
  --set mcpTestAgent.mcpToken="$TOKEN" >/dev/null
kubectl -n "$NAMESPACE" rollout status deployment/mcp-test-agent --timeout=120s
fi

echo "==> asking: $QUESTION"
kubectl -n "$NAMESPACE" port-forward svc/mcp-test-agent 8001:8000 >/dev/null 2>&1 &
AGENT_PF_PID=$!
sleep 2
curl -sS -X POST http://localhost:8001/ask -H "Content-Type: application/json" \
  -d "{\"question\": \"$QUESTION\"}" | python3 -m json.tool
