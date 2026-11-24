#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# litellm-oss/run.sh — what the OS uses of the LiteLLM gateway, exercised on REAL containers, so our
# permissive-only image (images/extensions/litellm-oss) can be compared call for call with upstream.
#
#   scripts/tests/litellm-oss/run.sh                               # our image, built locally as litellm-oss:dev
#   LITELLM_IMAGE=ghcr.io/berriai/litellm-database:1.109.1@sha256:932c… scripts/tests/litellm-oss/run.sh
#
# Starts postgres:17, an OpenAI-compatible stub (stub.py) and a one-tool MCP server (mcp_server.py), then
# the gateway the way the chart runs it: the `db-migrate` step first (`python litellm/proxy/prisma_migration.py`
# in /app, DISABLE_SCHEMA_UPDATE=false), then the proxy with DISABLE_SCHEMA_UPDATE=true,
# SERVER_ROOT_PATH=/tools/litellm, STORE_MODEL_IN_DB, a master key, a salt key and a UI login. Then:
#   models     /model/new (DB model with os.environ refs, an access group) and /model/info
#   keys       /key/generate with models, metadata.allowed_tools, object_permission.mcp_servers,
#              budget; /key/update; /key/info
#   calls      /chat/completions with the virtual key: a config model and a DB model
#   aliases    /config/update router_settings.model_group_alias, /router/settings, a call via the alias
#   spend      /spend/logs carries the key's calls with a non-zero spend
#   mcp        /v1/mcp/server (register), list, user-credential, oauth-user-credential (+ status),
#              and the MCP protocol through the gateway (/mcp: initialize, tools/list, tools/call)
#   ui         /tools/litellm/ui/ serves the console; POST /login sets a session cookie
# Prints one line per check ("ok"/"FAIL") and a summary; exit 1 on any FAIL. Secrets are test literals.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
IMAGE=${LITELLM_IMAGE:-litellm-oss:dev}
W=${LITELLM_OSS_WORKDIR:-$HOME/.cache/litellm-oss-test}
NET=lop
MASTER=sk-test-master-not-a-secret
P=${LITELLM_OSS_PORT:-14377}
GW=http://127.0.0.1:$P/tools/litellm
mkdir -p "$W"
down() { docker rm -f lopgw lopmig lopstub lopmcp loppg >/dev/null 2>&1; docker network rm $NET >/dev/null 2>&1 || true; }
[ -n "${KEEP:-}" ] || trap down EXIT
fails=0; passes=0
ok()   { passes=$((passes + 1)); echo "ok    $*"; }
bad()  { fails=$((fails + 1));  echo "FAIL  $*"; }
check() { local name=$1; shift; if "$@"; then ok "$name"; else bad "$name"; fi; }
json() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1], {'d': d}))" "$1" 2>/dev/null; }
api() { # api METHOD PATH [JSON] -> body in $W/body, status in $code
  local m=$1 p=$2 d=${3:-}
  code=$(curl -sS -o "$W/body" -w '%{http_code}' -X "$m" -H "Authorization: Bearer ${AUTH:-$MASTER}" \
    -H 'content-type: application/json' ${d:+--data "$d"} "$GW$p") || code=000
}

echo "image under test: $IMAGE"
down
docker network create $NET >/dev/null
docker run -d --name loppg --network $NET -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=litellm postgres:17 >/dev/null
docker run -d --name lopstub --network $NET -v "$HERE/stub.py":/stub.py:ro --entrypoint python litellm-oss:dev /stub.py >/dev/null 2>&1 \
  || docker run -d --name lopstub --network $NET -v "$HERE/stub.py":/stub.py:ro python:3.13-slim python /stub.py >/dev/null
# The MCP server runs on the SDK inside our image (it has `mcp`), whichever gateway image is under test.
docker run -d --name lopmcp --network $NET -v "$HERE/mcp_server.py":/mcp_server.py:ro --entrypoint python litellm-oss:dev /mcp_server.py >/dev/null
for i in $(seq 1 60); do docker exec loppg pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && break; sleep 1; done

cat > "$W/config.yaml" <<'YAML'
model_list:
  - model_name: stub-config-model
    litellm_params: { model: openai/stub, api_base: os.environ/STUB_API_BASE, api_key: os.environ/STUB_API_KEY }
    model_info: { mode: chat, input_cost_per_token: 0.00000015, output_cost_per_token: 0.00000025 }
litellm_settings:
  drop_params: true
  turn_off_message_logging: true
general_settings:
  master_key: os.environ/PROXY_MASTER_KEY
  store_model_in_db: true
  store_prompts_in_spend_logs: false
YAML
ENVS=(-e DATABASE_URL=postgresql://postgres:postgres@loppg:5432/litellm -e PROXY_MASTER_KEY=$MASTER
      -e LITELLM_SALT_KEY=sk-test-salt-not-a-secret -e STORE_MODEL_IN_DB=true -e SERVER_ROOT_PATH=/tools/litellm
      -e STUB_API_BASE=http://lopstub:8080/v1 -e STUB_API_KEY=sk-stub-unused
      -e UI_USERNAME=probe-admin -e UI_PASSWORD=probe-ui-password-not-a-secret -e LITELLM_LOCAL_MODEL_COST_MAP=True
      -e LITELLM_LOG=${PROBE_LITELLM_LOG:-INFO})   # PROBE_LITELLM_LOG=DEBUG shows each guarded enterprise import

# 1. db-migrate, exactly as the chart's initContainer runs it.
start=$(date +%s)
if docker run --name lopmig --network $NET -w /app "${ENVS[@]}" -e DISABLE_SCHEMA_UPDATE=false \
     --entrypoint python "$IMAGE" litellm/proxy/prisma_migration.py > "$W/migrate.log" 2>&1; then
  ok "db-migrate (python litellm/proxy/prisma_migration.py) exit 0 in $(( $(date +%s) - start ))s"
else
  bad "db-migrate exited non-zero (tail of $W/migrate.log):"; tail -5 "$W/migrate.log"
fi
docker rm -f lopmig >/dev/null 2>&1

# 2. the proxy, schema updates disabled (the chart sets DISABLE_SCHEMA_UPDATE=true on the proxy container).
docker run -d --name lopgw --network $NET -p 127.0.0.1:$P:4000 -v "$W/config.yaml":/etc/litellm/config.yaml:ro \
  "${ENVS[@]}" -e DISABLE_SCHEMA_UPDATE=true "$IMAGE" --config /etc/litellm/config.yaml --port 4000 >/dev/null
ready=
for i in $(seq 1 100); do curl -fsS "$GW/health/liveliness" >/dev/null 2>&1 && { ready=1; break; }; sleep 3; done
if [ -z "$ready" ]; then docker logs lopgw 2>&1 | tail -30; bad "the proxy did not become ready"; echo "SUMMARY $passes ok, $fails FAIL"; exit 1; fi
ok "proxy ready (/tools/litellm/health/liveliness)"

# --- models ------------------------------------------------------------------------------------------
api POST /model/new '{"model_name":"stub-db-model","litellm_params":{"model":"openai/stub","api_base":"os.environ/STUB_API_BASE","api_key":"os.environ/STUB_API_KEY"},"model_info":{"mode":"chat","access_groups":["os-admin-registered"],"input_cost_per_token":0.000001,"output_cost_per_token":0.000002}}'
check "/model/new (DB model, os.environ refs, access group) -> $code" test "$code" = 200
api GET /model/info
check "/model/info lists the config model and the DB model (db_model=true)" sh -c "python3 -c \"
import json; d=json.load(open('$W/body'))['data']; n={m['model_name']: m.get('model_info',{}) for m in d}
assert 'stub-config-model' in n and 'stub-db-model' in n, n.keys(); assert n['stub-db-model'].get('db_model') is True
\""

# --- virtual keys --------------------------------------------------------------------------------------
api POST /key/generate '{"key_alias":"probe-key","models":["stub-config-model","os-admin-registered","sovereign-worker"],"max_budget":5,"budget_duration":"7d","metadata":{"allowed_tools":["probe-echo"],"os_owner":"probe"},"object_permission":{"mcp_servers":[]}}'
KEY=$(json "d['key']" < "$W/body")
check "/key/generate (models, metadata.allowed_tools, object_permission, budget) -> $code" test "$code" = 200 -a -n "$KEY"
api POST /key/update "{\"key\":\"$KEY\",\"metadata\":{\"allowed_tools\":[\"probe-echo\",\"probe-other\"],\"os_owner\":\"probe\"},\"max_budget\":6}"
check "/key/update (metadata, budget) -> $code" test "$code" = 200
api GET "/key/info?key=$KEY"
check "/key/info shows the updated metadata and budget" sh -c "python3 -c \"
import json; i=json.load(open('$W/body'))['info']
assert i['metadata']['allowed_tools']==['probe-echo','probe-other'], i['metadata']; assert i['max_budget']==6, i['max_budget']
\""

# --- model calls with the virtual key --------------------------------------------------------------------
AUTH=$KEY api POST /chat/completions '{"model":"stub-config-model","messages":[{"role":"user","content":"hi"}]}'
check "chat via the virtual key, config model -> $code" sh -c "test $code = 200 && grep -q 'stub-ok' '$W/body'"
AUTH=$KEY api POST /chat/completions '{"model":"stub-db-model","messages":[{"role":"user","content":"hi"}]}'
check "chat via the virtual key, DB model (access group) -> $code" sh -c "test $code = 200 && grep -q 'stub-ok' '$W/body'"
AUTH=$KEY api POST /chat/completions '{"model":"not-allowed-model","messages":[{"role":"user","content":"hi"}]}'
check "a model outside the key's list is refused -> $code" test "$code" != 200

# --- router aliases (how the OS writes the role mapping) --------------------------------------------------
api POST /config/update '{"router_settings":{"model_group_alias":{"sovereign-worker":"stub-db-model"}}}'
check "/config/update router_settings.model_group_alias -> $code" test "$code" = 200
alias_ok=
for i in $(seq 1 20); do
  api GET /router/settings
  if python3 -c "import json,sys; d=json.load(open('$W/body')); s=json.dumps(d); sys.exit(0 if 'sovereign-worker' in s else 1)" 2>/dev/null; then alias_ok=1; break; fi
  sleep 3
done
check "/router/settings shows the alias" test -n "$alias_ok"
call_ok=
for i in $(seq 1 20); do
  AUTH=$KEY api POST /chat/completions '{"model":"sovereign-worker","messages":[{"role":"user","content":"hi"}]}'
  [ "$code" = 200 ] && grep -q 'stub-ok' "$W/body" && { call_ok=1; break; }; sleep 3
done
check "chat via the alias sovereign-worker -> $code" test -n "$call_ok"

# --- spend logs -------------------------------------------------------------------------------------------
spend_ok=
for i in $(seq 1 30); do
  api GET "/spend/logs?api_key=$KEY"
  if python3 -c "
import json,sys; d=json.load(open('$W/body')); rows=d if isinstance(d,list) else d.get('data',[])
sys.exit(0 if len(rows)>=2 and sum(float(r.get('spend') or 0) for r in rows)>0 else 1)" 2>/dev/null; then spend_ok=1; break; fi
  sleep 3
done
check "/spend/logs has the key's calls with non-zero spend" test -n "$spend_ok"

# --- MCP ----------------------------------------------------------------------------------------------------
# Two registrations of the same server: an open one for the protocol calls, and a BYOK one (bearer token
# supplied per user) for the per-user credential endpoints.
api POST /v1/mcp/server '{"server_name":"probe_mcp","alias":"probe_mcp","url":"http://lopmcp:8000/mcp","transport":"http","description":"probe"}'
check "/v1/mcp/server register (http, no auth) -> $code" sh -c "test '$code' = 200 -o '$code' = 201"
api POST /v1/mcp/server '{"server_name":"probe_byok","alias":"probe_byok","url":"http://lopmcp:8000/mcp","transport":"http","description":"probe byok","auth_type":"bearer_token","is_byok":true}'
SID=$(json "d['server_id']" < "$W/body")
check "/v1/mcp/server register (http, bearer_token, BYOK) -> $code" sh -c "test '$code' = 200 -o '$code' = 201 && test -n '$SID'"
api GET /v1/mcp/server
check "/v1/mcp/server lists both" sh -c "test $code = 200 && grep -q probe_mcp '$W/body' && grep -q probe_byok '$W/body'"
# Per-user credentials belong to a USER: a key with a user_id, granted the BYOK server through
# object_permission.mcp_servers, stands in for the OS's per-user key.
api POST /key/generate "{\"key_alias\":\"probe-user-key\",\"user_id\":\"probe-user\",\"models\":[\"stub-config-model\"],\"object_permission\":{\"mcp_servers\":[\"$SID\"]}}"
UKEY=$(json "d['key']" < "$W/body")
AUTH=$UKEY api POST "/v1/mcp/server/$SID/user-credential" '{"credential":"probe-user-token-not-a-secret","save":true}'
check "/v1/mcp/server/{id}/user-credential store (user key) -> $code" sh -c "test $code = 200 && grep -q '\"has_credential\": *true' '$W/body'"
# A second user for the OAuth token: LiteLLM refuses to overwrite a user's BYOK credential with an OAuth one.
api POST /key/generate "{\"key_alias\":\"probe-oauth-key\",\"user_id\":\"probe-oauth-user\",\"models\":[\"stub-config-model\"],\"object_permission\":{\"mcp_servers\":[\"$SID\"]}}"
OKEY=$(json "d['key']" < "$W/body")
AUTH=$OKEY api POST "/v1/mcp/server/$SID/oauth-user-credential" '{"access_token":"probe-oauth-token-not-a-secret","expires_in":3600,"scopes":["read"]}'
check "/v1/mcp/server/{id}/oauth-user-credential store (user key) -> $code" test "$code" = 200
AUTH=$OKEY api GET "/v1/mcp/server/$SID/oauth-user-credential/status"
check "/v1/mcp/server/{id}/oauth-user-credential/status shows it (user key) -> $code" sh -c "test $code = 200 && grep -q '\"has_credential\": *true' '$W/body'"
# MCP protocol through the gateway, as the master key (sees every server).
mcp() { curl -sS -D "$W/mcp.h" -o "$W/mcp.body" -w '%{http_code}' -X POST "$GW/mcp/" -H "Authorization: Bearer $MASTER" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' ${SESSION:+-H "mcp-session-id: $SESSION"} --data "$1"; }
code=$(mcp '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}')
SESSION=$(tr -d '\r' < "$W/mcp.h" | sed -n 's/^mcp-session-id: //Ip' | head -1)
check "MCP initialize via /tools/litellm/mcp/ -> $code" test "$code" = 200
[ -n "$SESSION" ] && mcp '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null
code=$(mcp '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')
cp "$W/mcp.body" "$W/mcp-tools-list.body"
TOOL=$(grep -oE '"name": ?"[^"]*echo[^"]*"' "$W/mcp-tools-list.body" | grep -v byok | head -1 | sed -E 's/"name": ?"//;s/"$//')
check "MCP tools/list shows the probe tool (${TOOL:-none}) -> $code" sh -c "test $code = 200 && test -n '$TOOL'"
code=$(mcp "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"${TOOL:-probe_mcp-echo}\",\"arguments\":{\"text\":\"hello\"}}}")
check "MCP tools/call ${TOOL:-?} returns the tool's answer -> $code" sh -c "test $code = 200 && grep -q 'probe-echo:hello' '$W/mcp.body'"

# --- admin console ----------------------------------------------------------------------------------------------
code=$(curl -sS -o "$W/ui.html" -w '%{http_code}' -L "$GW/ui/")
check "/tools/litellm/ui/ serves the console -> $code" sh -c "test $code = 200 && grep -qi '<html' '$W/ui.html'"
code=$(curl -sS -o /dev/null -D "$W/login.h" -w '%{http_code}' -X POST "$GW/login" \
  --data-urlencode username=probe-admin --data-urlencode password=probe-ui-password-not-a-secret)
check "POST /login (form) -> $code with a session cookie" sh -c "grep -qiE '^set-cookie: (token|litellm_session|session_token)=' '$W/login.h'"

docker logs lopgw > "$W/gateway.log" 2>&1
echo "enterprise import notes in the gateway log (first 10):"
grep -iE "enterprise|litellm_enterprise" "$W/gateway.log" | sed 's/sk-[A-Za-z0-9_-]*/sk-…/g' | head -10 || true
echo "SUMMARY $passes ok, $fails FAIL  ($IMAGE)"
[ "$fails" -eq 0 ]
