# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# Shared helpers for the LiteLLM upgrade test (see run.sh). Source me.
# H = this directory (scripts, read-only in the stub container); W = scratch (config, logs, data).
H=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# W must be a path the Docker VM can see: the config file is bind-mounted into the gateway.
# Colima and Docker Desktop share $HOME by default and NOT $TMPDIR — a path they cannot see is
# mounted as an empty directory and the proxy dies with "Is a directory: /etc/litellm/config.yaml".
W=${LITELLM_TEST_WORKDIR:-$HOME/.cache/litellm-upgrade-test}
mkdir -p "$W/data"
NET=gwtest
MASTER=sk-test-master-not-a-secret
DBURL='postgresql://litellm:test@gwpg:5432/litellm'
B=http://127.0.0.1:4000

infra_up() {
  docker network inspect $NET >/dev/null 2>&1 || docker network create $NET >/dev/null
  docker rm -f gwpg gwvalkey gwstub >/dev/null 2>&1
  docker run -d --name gwpg --network $NET -e POSTGRES_USER=litellm -e POSTGRES_PASSWORD=test -e POSTGRES_DB=litellm postgres:16-alpine >/dev/null
  docker run -d --name gwvalkey --network $NET --network-alias valkey valkey/valkey:8-alpine valkey-server --requirepass test >/dev/null
  docker run -d --name stub --network $NET --network-alias stub -v "$H":/h:ro -v "$W/data":/data -e DATA_DIR=/data node:22-alpine node /h/stub.mjs >/dev/null
  docker rename stub gwstub
  for i in $(seq 1 30); do docker exec gwpg pg_isready -U litellm >/dev/null 2>&1 && break; sleep 1; done
  echo "infra up"
}
infra_down() { docker rm -f gw gwpg gwvalkey gwstub >/dev/null 2>&1; docker network rm $NET >/dev/null 2>&1; echo "infra down"; }
reset_db() { docker exec gwpg psql -U litellm -d postgres -q -c 'DROP DATABASE IF EXISTS litellm WITH (FORCE)' -c 'CREATE DATABASE litellm' && echo "database reset (empty)"; }

# The chart's migration step, verbatim: `python litellm/proxy/prisma_migration.py`, workingDir /app,
# DISABLE_SCHEMA_UPDATE=false.
migrate() { # $1 image
  docker run --rm --network $NET --entrypoint python -w /app \
    -e DATABASE_URL="$DBURL" -e DISABLE_SCHEMA_UPDATE=false -e STORE_MODEL_IN_DB=true -e SERVER_ROOT_PATH=/tools/litellm \
    "$1" litellm/proxy/prisma_migration.py 2>&1 | tail -${2:-6}
  echo "migration exit: ${PIPESTATUS[0]:-$?}"
}
# The chart's proxy container: same env names, same args.
gw_up() { # $1 image  $2 config file  [extra docker args...]
  local img=$1 cfg=$2; shift 2
  docker rm -f gw >/dev/null 2>&1
  docker run -d --name gw --network $NET --network-alias agentic-os-litellm -p 127.0.0.1:4000:4000 \
    -e HOST=0.0.0.0 -e PORT=4000 -e DATABASE_URL="$DBURL" -e PROXY_MASTER_KEY=$MASTER \
    -e LITELLM_LOG=INFO -e SERVER_ROOT_PATH=/tools/litellm -e STORE_MODEL_IN_DB=true \
    -e REDIS_PASSWORD=test -e DISABLE_SCHEMA_UPDATE=true \
    -e LANGFUSE_PUBLIC_KEY=pk-lf-test -e LANGFUSE_SECRET_KEY=sk-lf-test -e LANGFUSE_HOST=${LANGFUSE_HOST_OVERRIDE:-http://stub:8080} \
    -e UI_USERNAME=admin -e UI_PASSWORD=test-ui -e STACKIT_API_BASE=http://stub:8080/v1 -e STACKIT_API_KEY=sk-upstream-test \
    -v "$cfg":/etc/litellm/config.yaml:ro "$@" "$img" --config /etc/litellm/config.yaml >/dev/null
  for i in $(seq 1 90); do
    code=$(curl -s -o /dev/null -w '%{http_code}' $B/health/readiness || true)
    [ "$code" = 200 ] && { echo "gateway ready after ~$((i*2))s ($img)"; return 0; }
    docker inspect -f '{{.State.Running}}' gw 2>/dev/null | grep -q true || { echo "gateway container exited"; docker logs --tail 40 gw; return 1; }
    sleep 2
  done
  echo "gateway NOT ready"; docker logs --tail 60 gw; return 1
}
adm() { curl -sS -H "Authorization: Bearer $MASTER" -H 'content-type: application/json' "$@"; }

# The chart's key reconcile Job, verbatim (script extracted from the rendered manifest).
keyjob() { # $1 script file
  docker run --rm --network $NET --entrypoint /bin/sh -e MASTER_KEY=$MASTER -e VIRTUAL_KEY=$AGENT_KEY \
    -v "$1":/job.sh:ro curlimages/curl:8.11.1 /job.sh
}
AGENT_KEY=sk-agents-test-shared-key
chat() { # $1 key  $2 model  $3 user text  [$4 extra json fields]
  curl -sS -D $W/data/last.headers -o $W/data/last.body -w '%{http_code}' $B/v1/chat/completions \
    -H "Authorization: Bearer $1" -H 'content-type: application/json' \
    -d '{"model":"'"$2"'","messages":[{"role":"system","content":"SYSTEM_SECRET_MARKER you are a test"},{"role":"user","content":"'"$3"'"}],"max_tokens":64,"user":"os-test","metadata":{"tags":["domain:test","agent:sys1","tab:agents","run:run1"],"existing_trace_id":"trace-run1","parent_observation_id":"obs-1","trace_user_id":"u1","session_id":"sys1"'"${CHAT_META:+,$CHAT_META}"'}'"${4:+,$4}"'}'
}
dbmodel_new() { adm -X POST $B/model/new -d '{"model_name":"db-added-model","litellm_params":{"model":"openai/db-upstream","api_base":"http://stub:8080/v1","api_key":"sk-db-stored-upstream-credential"},"model_info":{"input_cost_per_token":0.000001,"output_cost_per_token":0.000002}}' | python3 -c "import json,sys; d=json.load(sys.stdin); print('model/new ->', d.get('model_name') or d)"; }
dbmodel_call() { # $1 bearer
  local code; code=$(curl -sS -o $W/data/db.body -w '%{http_code}' $B/v1/chat/completions -H "Authorization: Bearer $1" -H 'content-type: application/json' -d '{"model":"db-added-model","messages":[{"role":"user","content":"hi"}]}')
  echo "db-added-model call -> HTTP $code $(head -c 160 $W/data/db.body | tr '\n' ' ')"
}
upstream_auth_seen() { docker logs gwstub 2>&1 | tail -1; }
