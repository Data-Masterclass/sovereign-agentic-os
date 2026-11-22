#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# home-chat/run.sh — a Home chat turn on REAL containers: ONE Langfuse trace per turn, and an OPA decision.
#
#   scripts/tests/home-chat/run.sh
#
# 1. Brings up the stack of scripts/tests/litellm-langfuse/run.sh (chart's LiteLLM image and config,
#    Langfuse on its documented stack, stub model provider) and keeps it (KEEP=1).
# 2. Starts OPA (the chart's image) with the chart's policies/authz.rego, a seed grant for the domain
#    `sales` only, and decision logging to the console.
# 3. Runs os-ui/core/runtime/home-chat.e2e.test.ts with HOME_CHAT_E2E_REQUIRED=1 (a skip is a failure).
# Prints HOME_CHAT_E2E_OK; always tears the containers down.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
CHART=$REPO/charts/sovereign-agentic-os
W=${LITELLM_LANGFUSE_WORKDIR:-$HOME/.cache/litellm-langfuse-test}
NET=lfgw
MASTER=sk-test-master-not-a-secret   # the throw-away gateway's own key, as in litellm-langfuse/run.sh
mkdir -p "$W"
down() { docker rm -f gw lfweb lfworker lfch lfredis lfminio lfpg lfstub lfopa >/dev/null 2>&1; docker network rm $NET >/dev/null 2>&1; }
[ -n "${HOME_CHAT_KEEP:-}" ] || trap down EXIT

KEEP=1 STUB_FILE=${STUB_FILE:-stub.mjs} "$REPO/scripts/tests/litellm-langfuse/run.sh" > "$W/stack.log" 2>&1 || true
docker ps --format '{{.Names}}' | grep -qx gw && docker ps --format '{{.Names}}' | grep -qx lfweb || { tail -20 "$W/stack.log"; echo "HOME_CHAT_E2E_FAILED: the gateway/Langfuse stack is not up"; exit 1; }
IMAGE=$(node -e '
const y=require(process.argv[2]);const d=y.loadAll(require("fs").readFileSync(process.argv[1],"utf8")).filter(Boolean).find(x=>x.kind==="Deployment"&&/-litellm$/.test(x.metadata.name));console.log(d.spec.template.spec.containers[0].image)' "$W/rendered.yaml" "$REPO/os-ui/node_modules/js-yaml")
# the stack script ends with the legacy-callback twin gateway; restart the gateway on the chart config
docker rm -f gw >/dev/null 2>&1
docker run -d --name gw --network $NET -p 127.0.0.1:${GW_PORT:-14000}:4000 --env-file "$W/otel.env" \
  -e HOST=0.0.0.0 -e PORT=4000 -e DATABASE_URL=postgresql://postgres:postgres@lfpg:5432/litellm -e PROXY_MASTER_KEY=$MASTER \
  -e LITELLM_LOG=INFO -e SERVER_ROOT_PATH=/tools/litellm -e STORE_MODEL_IN_DB=true -e DISABLE_SCHEMA_UPDATE=true \
  -e REDIS_PASSWORD=myredissecret -e LANGFUSE_PUBLIC_KEY=pk-lf-test-not-a-secret -e LANGFUSE_SECRET_KEY=sk-lf-test-not-a-secret -e LANGFUSE_HOST=http://lfweb:3000 \
  -e STACKIT_API_BASE=http://stub:8080/v1 -e STACKIT_API_KEY=sk-upstream-test \
  -v "$W/config.yaml":/etc/litellm/config.yaml:ro "$IMAGE" \
  --config /etc/litellm/config.yaml >/dev/null
for i in $(seq 1 90); do [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${GW_PORT:-14000}/health/readiness || true)" = 200 ] && break; sleep 2; done
curl -sS -o /dev/null -w 'shared agent key: HTTP %{http_code}\n' -H "Authorization: Bearer $MASTER" -H 'content-type: application/json' \
  http://127.0.0.1:${GW_PORT:-14000}/key/generate -d '{"key":"sk-test-scoped-agent-key","key_alias":"sovereign-agents","models":["stackit-gpt-oss-20b","stackit-qwen3-vl-235b","sovereign-strong","sovereign-worker","sovereign-embedding"],"max_budget":25,"budget_duration":"7d"}'
# The key already exists from the stack script (generate answers 400): widen its model list with the documented /key/update.
curl -sS -o /dev/null -w 'shared agent key models: HTTP %{http_code}\n' -H "Authorization: Bearer $MASTER" -H 'content-type: application/json' \
  http://127.0.0.1:${GW_PORT:-14000}/key/update -d '{"key":"sk-test-scoped-agent-key","models":["stackit-gpt-oss-20b","stackit-qwen3-vl-235b","sovereign-strong","sovereign-worker","sovereign-embedding"]}'

# The OS calls only the role names; as the OS does at boot (os/models.yml), map them onto TWO DISTINCT catalog models
# (strong -> the 235B, worker -> the 20B), so the proof can tell which role a call really ran on.
curl -sS -o /dev/null -w 'role aliases: HTTP %{http_code}\n' -H "Authorization: Bearer $MASTER" -H 'content-type: application/json' \
  http://127.0.0.1:${GW_PORT:-14000}/config/update -d '{"router_settings":{"model_group_alias":{"sovereign-strong":"stackit-qwen3-vl-235b","sovereign-worker":"stackit-gpt-oss-20b","sovereign-embedding":"stackit-gpt-oss-20b"}}}'

OPA_IMAGE=$(node -e '
const y=require(process.argv[2]);const o=y.load(require("fs").readFileSync(process.argv[1],"utf8")).opa.image;
console.log(`${o.repository}:${o.tag}@${o.digest}`)' "$CHART/values.yaml" "$REPO/os-ui/node_modules/js-yaml")
mkdir -p "$W/opa" && cp "$CHART/policies/authz.rego" "$W/opa/authz.rego"
echo '{"seed_grants":{"sales":["retrieve"]},"requires_approval":[]}' > "$W/opa/data.json"
docker run -d --name lfopa --network $NET -p 127.0.0.1:18181:8181 -v "$W/opa":/policy:ro "$OPA_IMAGE" \
  run --server --addr 0.0.0.0:8181 --set decision_logs.console=true /policy/authz.rego /policy/data.json >/dev/null
for i in $(seq 1 30); do [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18181/health || true)" = 200 ] && break; sleep 1; done

[ -z "${HOME_CHAT_STACK_ONLY:-}" ] || { echo "HOME_CHAT_STACK_UP (gateway :${GW_PORT:-14000}, Langfuse :13000, OPA :18181)"; exit 0; }
(cd "$REPO/os-ui" && LITELLM_URL=http://127.0.0.1:${GW_PORT:-14000} OPA_URL=http://127.0.0.1:18181   LANGFUSE_E2E_URL=http://127.0.0.1:13000 LANGFUSE_E2E_PUBLIC_KEY=pk-lf-test-not-a-secret LANGFUSE_E2E_SECRET_KEY=sk-lf-test-not-a-secret \
  HOME_CHAT_E2E_OPA_CONTAINER=lfopa HOME_CHAT_E2E_REQUIRED=1 HOME_CHAT_E2E_STUB_LOG="$W/data/models.jsonl" \
  node --experimental-test-module-mocks --import ./scripts/test-setup.mjs --test --test-concurrency=1 core/runtime/home-chat.e2e.test.ts) 2>&1 | tee "$W/home-chat-e2e.log" | grep -E '^# (pass|fail)|^not ok|^ok|ℹ (pass|fail)|✔|✖|Error' 
grep -q 'ℹ fail 0' "$W/home-chat-e2e.log" && grep -q 'ℹ pass 8' "$W/home-chat-e2e.log" && { echo HOME_CHAT_E2E_OK; exit 0; }
echo "HOME_CHAT_E2E_FAILED (log: $W/home-chat-e2e.log)"; exit 1
