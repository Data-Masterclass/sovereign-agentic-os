#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# rehearse.sh — the secret rotation of docs/ops/secret-rotation.md on the REAL components.
# =============================================================================
#   bash scripts/tests/secret-rotation/rehearse.sh            (KEEP=1 leaves the containers up)
#
# Docker only (no cluster): the chart's own gateway image, config and env (rendered from the chart,
# as scripts/tests/litellm-langfuse/run.sh does), Postgres 17, Langfuse 3.194.1 web + worker on its
# documented stack. The Kubernetes steps of rotate-secrets.sh are replaced by their effect on the
# containers' environment; the in-container steps are the SAME artifacts: the probe
# scripts/ops/litellm-stored-secrets.py (run with rotate-secrets.sh's loader), the Langfuse
# encrypted-table count, the bcrypt-12 hash by langfuse-web's bcryptjs and the one-row UPDATE.
#
#  A. LiteLLM, starting like a default install: the public default master key, no salt key.
#     Stored, the way the console/API stores them: a model, a credential, a console env var, a team
#     logging callback, an MCP server (credentials + static headers) — several of the 21 columns.
#     1. LiteLLM's own scan counts them (negative twin: under a random key, 0).
#     2. NEGATIVE TWIN: a new random salt key alone → the scan finds 0 decryptable values and the
#        stored model is gone (400). Back to the start: everything is there again.
#     3. Re-key step 1: master key S + LITELLM_MIGRATE_FROM_MASTER_KEY=<old> → LiteLLM logs the
#        re-encryption; every column has its full count under S, 0 under the old key.
#     4. Step 2: LITELLM_SALT_KEY=S, master key M, the variable empty → every column still full
#        under S, 0 under old; old key and S → 401, M → 200; the stored model is served; the
#        stored credential reads back; console password: new 200, old 401.
#  B. Langfuse.
#     5. nextauthSecret: a session cookie from before the rotation no longer signs in.
#     6. salt + new key pair: the new pair (created by the headless init under the new salt) → 200;
#        the OLD pair → still 200 (the fast hash re-heals from the bcrypt hash); after the old pair
#        is deleted → 401.
#     7. encryptionKey: the encrypted-table count is 0 → rotated, Langfuse healthy. Twin: an LLM
#        connection stored → the count says 1 (rotate-secrets.sh then keeps the key).
#     8. Admin password: bcrypt-12 by langfuse-web's bcryptjs, old hash saved, ONE row updated →
#        new password signs in, old refused; rollback → old signs in again.
# Ends with SECRET_ROTATION_REHEARSAL_OK.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
CHART=${CHART_DIR:-$REPO/charts/sovereign-agentic-os}
YAML_DIR=${JS_YAML_DIR:-$REPO/os-ui/node_modules/js-yaml}
LFV=${LANGFUSE_VERSION:-3.194.1}
W=${REHEARSAL_WORKDIR:-$HOME/.cache/secret-rotation-rehearsal}
NET=rotreh
GW=http://127.0.0.1:14100; LF=http://127.0.0.1:13100
mkdir -p "$W"
pass=0; failn=0
ok()   { pass=$((pass+1)); echo "   ok   $*"; }
bad()  { failn=$((failn+1)); echo "   FAIL $*"; }
want() { if [ "$2" = "$3" ]; then ok "$1 ($3)"; else bad "$1: got $3, want $2"; fi; }
step() { printf '\n==================== %s\n' "$*"; }
die()  { docker logs gwr > "$W/gw.log" 2>&1; docker logs lfwebr > "$W/lfweb.log" 2>&1; echo "SECRET_ROTATION_REHEARSAL_FAILED — $*"; exit 1; }
down() { docker rm -f gwr lfwebr lfworkerr lfchr lfredisr lfminior lfpgr stubr >/dev/null 2>&1; docker network rm $NET >/dev/null 2>&1; }
[ -n "${KEEP:-}" ] || trap down EXIT
rnd() { openssl rand -hex "$1"; }

step "render the chart: the gateway image, config and env"
helm template agentic-os "$CHART" -n agentic-os -f "${PROFILE_VALUES:-$(cd "$CHART/../.." && pwd)/values.local.yaml}" > "$W/rendered.yaml" 2>"$W/helm.err" || { cat "$W/helm.err"; die "helm template"; }
node "$REPO/scripts/tests/litellm-langfuse/mkconfig.mjs" "$W/rendered.yaml" "$W/config.yaml" "$W/gw.env" "$YAML_DIR" >/dev/null || die "mkconfig"
IMAGE=$(node -e '
const y=require(process.argv[2]);const d=y.loadAll(require("fs").readFileSync(process.argv[1],"utf8")).filter(Boolean)
 .find(x=>x.kind==="Deployment"&&/-litellm$/.test(x.metadata.name));console.log(d.spec.template.spec.containers[0].image)' "$W/rendered.yaml" "$YAML_DIR")
echo "gateway image $IMAGE; Langfuse $LFV"

OLD=sk-litellm-local-dev-master          # the chart default: the start of a default install
S=sk-salt-$(rnd 32); M=sk-$(rnd 32)
UI_OLD=litellm-admin-local-dev; UI_NEW=$(rnd 16)
LF_PK_OLD=pk-lf-localdev0000public; LF_SK_OLD=sk-lf-localdev0000secret
LF_PK_NEW=pk-lf-$(rnd 16); LF_SK_NEW=sk-lf-$(rnd 32)
NA_OLD=sovereign-os-local-dev-nextauth-secret; NA_NEW=$(openssl rand -base64 48 | tr -d '\n')
SALT_OLD=sovereign-os-local-dev-salt; SALT_NEW=$(rnd 32)
EK_OLD=a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90; EK_NEW=$(rnd 32)
PW_OLD=langfuse-local-dev-admin; PW_NEW=$(rnd 16); EMAIL=admin@example.invalid

step "the stack: Postgres 17, Langfuse $LFV on its documented stack, a model stub"
down; docker network create $NET >/dev/null
# Data on tmpfs: the rehearsal needs no disk (and leaves nothing behind).
docker run -d --name lfpgr --network $NET --tmpfs /var/lib/postgresql/data:size=1g -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=langfuse postgres:17 >/dev/null
docker run -d --name lfchr --network $NET --tmpfs /var/lib/clickhouse:size=1g,uid=101,gid=101 --tmpfs /var/log/clickhouse-server:size=256m,uid=101,gid=101 --user 101:101 -e CLICKHOUSE_DB=default -e CLICKHOUSE_USER=clickhouse -e CLICKHOUSE_PASSWORD=clickhouse clickhouse/clickhouse-server:24.8 >/dev/null
docker run -d --name lfredisr --network $NET --network-alias valkey redis:7 --requirepass redissecret --maxmemory-policy noeviction >/dev/null
docker run -d --name lfminior --network $NET --tmpfs /data:size=512m,mode=1777 --entrypoint sh -e MINIO_ROOT_USER=minio -e MINIO_ROOT_PASSWORD=miniosecret cgr.dev/chainguard/minio \
  -c 'mkdir -p /data/langfuse && minio server --address ":9000" /data' >/dev/null
docker run -d --name stubr --network $NET --network-alias stub --network-alias mock-model -v "$REPO/scripts/tests/litellm-langfuse":/h:ro -e DATA_DIR=/tmp -e PORT=8080 node:22-alpine node /h/stub.mjs >/dev/null
for i in $(seq 1 120); do
  docker exec lfpgr pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && docker exec lfchr clickhouse-client --user clickhouse --password clickhouse --query 'SELECT 1' >/dev/null 2>&1 && break; sleep 2
done
docker exec lfpgr psql -h 127.0.0.1 -U postgres -q -c 'CREATE DATABASE litellm' || die "create litellm database"

# Langfuse web + worker with the given core secrets and init pair. $1 salt $2 nextauth $3 encryptionKey $4 pk $5 sk
lf_up() {
  docker rm -f lfwebr lfworkerr >/dev/null 2>&1
  local env=(-e DATABASE_URL=postgresql://postgres:postgres@lfpgr:5432/langfuse -e SALT="$1" -e ENCRYPTION_KEY="$3" -e NEXTAUTH_URL=http://localhost:3000
    -e TELEMETRY_ENABLED=false -e CLICKHOUSE_MIGRATION_URL=clickhouse://lfchr:9000 -e CLICKHOUSE_URL=http://lfchr:8123 -e CLICKHOUSE_USER=clickhouse
    -e CLICKHOUSE_PASSWORD=clickhouse -e CLICKHOUSE_CLUSTER_ENABLED=false -e REDIS_HOST=lfredisr -e REDIS_PORT=6379 -e REDIS_AUTH=redissecret
    -e LANGFUSE_S3_EVENT_UPLOAD_BUCKET=langfuse -e LANGFUSE_S3_EVENT_UPLOAD_REGION=auto -e LANGFUSE_S3_EVENT_UPLOAD_ACCESS_KEY_ID=minio
    -e LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY=miniosecret -e LANGFUSE_S3_EVENT_UPLOAD_ENDPOINT=http://lfminior:9000 -e LANGFUSE_S3_EVENT_UPLOAD_FORCE_PATH_STYLE=true)
  docker run -d --name lfworkerr --network $NET "${env[@]}" "langfuse/langfuse-worker:$LFV" >/dev/null
  docker run -d --name lfwebr --restart on-failure:5 --network $NET -p 127.0.0.1:13100:3000 "${env[@]}" -e NEXTAUTH_SECRET="$2" -e AUTH_DISABLE_SIGNUP=true \
    -e LANGFUSE_INIT_ORG_ID=sovereign-os -e LANGFUSE_INIT_ORG_NAME=org -e LANGFUSE_INIT_PROJECT_ID=agent-core -e LANGFUSE_INIT_PROJECT_NAME=agent-core \
    -e LANGFUSE_INIT_PROJECT_PUBLIC_KEY="$4" -e LANGFUSE_INIT_PROJECT_SECRET_KEY="$5" \
    -e LANGFUSE_INIT_USER_EMAIL=$EMAIL -e LANGFUSE_INIT_USER_NAME=admin -e LANGFUSE_INIT_USER_PASSWORD="${LF_INIT_PW:-$PW_OLD}" "langfuse/langfuse:$LFV" >/dev/null
  for i in $(seq 1 150); do [ "$(curl -s -o /dev/null -w '%{http_code}' $LF/api/public/health || true)" = 200 ] && break; sleep 2; done
  # The headless init runs after health turns 200: wait until the init pair answers.
  for i in $(seq 1 60); do [ "$(lf_auth "$4" "$5")" = 200 ] && return 0; sleep 2; done
  docker logs --tail 40 lfwebr; return 1
}
lf_auth() { printf 'user = "%s:%s"\n' "$1" "$2" | curl -s -K - -o /dev/null -w '%{http_code}' $LF/api/public/projects || true; }
# Langfuse sign-in through NextAuth: prints signed-in | refused. $1 password [$2 cookie jar to keep]
lf_signin() {
  local jar=${2:-$W/jar.$$}; : > "$jar"
  local csrf; csrf=$(curl -s -c "$jar" $LF/api/auth/csrf | python3 -c 'import json,sys; print(json.load(sys.stdin)["csrfToken"])')
  printf 'data-urlencode = "email=%s"\ndata-urlencode = "password=%s"\ndata-urlencode = "csrfToken=%s"\ndata-urlencode = "json=true"\n' "$EMAIL" "$1" "$csrf" \
    | curl -s -K - -b "$jar" -c "$jar" -o /dev/null $LF/api/auth/callback/credentials
  lf_session "$jar"
}
lf_session() { curl -s -b "$1" $LF/api/auth/session | python3 -c 'import json,sys; print("signed-in" if (json.load(sys.stdin) or {}).get("user") else "refused")'; }

lf_up "$SALT_OLD" "$NA_OLD" "$EK_OLD" "$LF_PK_OLD" "$LF_SK_OLD" || die "Langfuse did not start"
echo "Langfuse up with the chart-default core secrets and pair"

# The gateway. $1 PROXY_MASTER_KEY  $2 LITELLM_SALT_KEY ("" = unset)  $3 LITELLM_MIGRATE_FROM_MASTER_KEY ("" = unset, EMPTY = set to "")  $4 UI_PASSWORD
gw_up() {
  docker rm -f gwr >/dev/null 2>&1
  local extra=(); [ -n "$2" ] && extra+=(-e "LITELLM_SALT_KEY=$2"); case $3 in "") ;; EMPTY) extra+=(-e "LITELLM_MIGRATE_FROM_MASTER_KEY=") ;; *) extra+=(-e "LITELLM_MIGRATE_FROM_MASTER_KEY=$3") ;; esac
  docker run -d --name gwr --network $NET -p 127.0.0.1:14100:4000 --env-file "$W/gw.env" ${extra[@]+"${extra[@]}"} \
    -e HOST=0.0.0.0 -e PORT=4000 -e DATABASE_URL=postgresql://postgres:postgres@lfpgr:5432/litellm -e PROXY_MASTER_KEY="$1" \
    -e LITELLM_LOG=INFO -e STORE_MODEL_IN_DB=true -e DISABLE_SCHEMA_UPDATE=true -e REDIS_PASSWORD=redissecret \
    -e UI_USERNAME=admin -e UI_PASSWORD="$4" -e LANGFUSE_PUBLIC_KEY=$LF_PK_OLD -e LANGFUSE_SECRET_KEY=$LF_SK_OLD -e LANGFUSE_HOST=http://lfwebr:3000 \
    -e STACKIT_API_BASE=http://stub:8080/v1 -e STACKIT_API_KEY=sk-upstream-test \
    -v "$W/config.yaml":/etc/litellm/config.yaml:ro "$IMAGE" --config /etc/litellm/config.yaml >/dev/null
  for i in $(seq 1 120); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' $GW/health/readiness || true)" = 200 ] && return 0
    docker inspect -f '{{.State.Running}}' gwr 2>/dev/null | grep -q true || { docker logs --tail 40 gwr; return 1; }
    sleep 2
  done
  docker logs --tail 40 gwr; return 1
}
api() { printf 'header = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\n' "$1" | curl -sS -K - -o "$W/body.json" -w '%{http_code}' -X "$2" "$GW$3" ${4:+--data "$4"} || true; }
chat() { api "$1" POST /v1/chat/completions "{\"model\":\"$2\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}],\"max_tokens\":5}"; }
ui_login() { printf '{"username":"admin","password":"%s"}' "$1" | curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' --data-binary @- $GW/v2/login || true; }
# LiteLLM's own scan, run exactly as rotate-secrets.sh runs it (same loader, same probe file).
scan() { # $1: JSON {"keys": {...}} → counts JSON
  local p=${1:-}; [ -n "$p" ] || p='{}'
  { printf '%s\n' "$p"; cat "$REPO/scripts/ops/litellm-stored-secrets.py"; } | docker exec -i gwr python -c '
import sys, json, asyncio
params = sys.stdin.readline(); code = sys.stdin.read()
ns = {"__name__": "litellm_stored_secrets"}; exec(code, ns)
asyncio.run(ns["main"](json.loads(params or "{}")))' 2>/dev/null | tail -n1
}
keys_json() { python3 -c 'import json,sys; p=sys.stdin.buffer.read().split(b"\0")[:-1]; print(json.dumps({"keys": {p[i].decode(): p[i+1].decode() for i in range(0,len(p),2)}}))'; }
per_column() { python3 -c 'import json,sys; d=json.loads(sys.argv[1]); print(json.dumps({k: v[sys.argv[2]] for k, v in sorted(d["columns"].items()) if v["rows"]}))' "$1" "$2"; }
total() { python3 -c 'import json,sys; print(json.loads(sys.argv[1])["total"][sys.argv[2]])' "$1" "$2"; }

step "A. LiteLLM 1.109.1: migrate its database, start like a default install (default master key, no salt key)"
docker run --rm --network $NET --entrypoint python -w /app -e DATABASE_URL=postgresql://postgres:postgres@lfpgr:5432/litellm \
  -e DISABLE_SCHEMA_UPDATE=false "$IMAGE" litellm/proxy/prisma_migration.py > "$W/migrate.log" 2>&1 || { tail -20 "$W/migrate.log"; die "migration"; }
gw_up "$OLD" "" "" "$UI_OLD" || die "gateway did not start"

step "store encrypted values the way an admin does (console / admin API)"
want "model stored (/model/new)" 200 "$(api $OLD POST /model/new '{"model_name":"console-stored-model","litellm_params":{"model":"openai/gpt-oss-20b","api_base":"http://stub:8080/v1","api_key":"sk-provider-stored-credential"},"model_info":{}}')"
want "credential stored (/credentials)" 200 "$(api $OLD POST /credentials '{"credential_name":"rehearsal-cred","credential_values":{"api_key":"sk-stored-credential-value","api_base":"http://stub:8080/v1"},"credential_info":{"custom_llm_provider":"openai"}}')"
want "console env var stored (/config/update)" 200 "$(api $OLD POST /config/update '{"environment_variables":{"REHEARSAL_PROVIDER_SECRET":"env-secret-value"}}')"
api $OLD POST /team/new '{"team_alias":"rehearsal-team"}' >/dev/null; TID=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["team_id"])' "$W/body.json")
want "team logging callback stored (/team/{id}/callback)" 200 "$(api $OLD POST "/team/$TID/callback" '{"callback_name":"langfuse","callback_type":"success","callback_vars":{"langfuse_public_key":"pk-lf-team","langfuse_secret_key":"sk-lf-team-secret","langfuse_host":"http://lfwebr:3000"}}')"
want "MCP server stored (/v1/mcp/server)" 201 "$(api $OLD POST /v1/mcp/server '{"server_name":"rehearsal_mcp","url":"http://stub:8080/mcp","transport":"http","auth_type":"bearer_token","credentials":{"auth_value":"mcp-token-value"},"static_headers":{"X-Rehearsal":"static-header-value"}}')"
sleep 3

step "1. LiteLLM's own scan of the 21 columns"
B=$(scan "$(printf '%s\0%s\0' random "sk-$(rnd 32)" | keys_json)")
[ -n "$B" ] || die "the scan returned nothing"
BEFORE=$(per_column "$B" effective); N=$(total "$B" effective)
echo "   columns with values: $BEFORE"
[ "$N" -ge 5 ] && ok "stored values found by the scan: $N in $(python3 -c 'import json,sys; print(len(json.loads(sys.argv[1])))' "$BEFORE") columns" || bad "the scan found only $N stored values"
want "negative twin: values decryptable with a random key" 0 "$(total "$B" random)"
want "stored model served before" 200 "$(chat $OLD console-stored-model)"

step "2. NEGATIVE TWIN: a new random salt key alone (the old 'none stored' path)"
gw_up "$OLD" "sk-salt-$(rnd 32)" "" "$UI_OLD" || die "gateway (twin)"
T=$(scan)
want "values decryptable with the key now in use" 0 "$(total "$T" effective)"
c=$(chat $OLD console-stored-model); [ "$c" != 200 ] && ok "stored model no longer served ($c)" || bad "stored model still served under a random salt"
gw_up "$OLD" "" "" "$UI_OLD" || die "gateway (back)"
want "back to the start: values decryptable again" "$N" "$(total "$(scan)" effective)"

step "3. re-key step 1: master key S, LITELLM_MIGRATE_FROM_MASTER_KEY=<old>, no salt key"
gw_up "$S" "" "$OLD" "$UI_OLD" || die "gateway (step 1)"
docker logs gwr 2>&1 | grep -oE "Done re-encrypting [0-9]+ stored value\(s\)[^.]*" | head -1 | sed 's/^/   LiteLLM: /'
GWLOG=$(docker logs gwr 2>&1)   # captured first: grep -q on a pipe would SIGPIPE the writer under pipefail
case $GWLOG in *"Done re-encrypting $N stored value"*) ok "LiteLLM re-encrypted all $N values" ;; *) bad "LiteLLM did not log 'Done re-encrypting $N'" ;; esac
R1=$(scan "$(printf '%s\0%s\0' old "$OLD" | keys_json)")
want "per column, decryptable with S" "$BEFORE" "$(per_column "$R1" effective)"
want "values left under the old master key" 0 "$(total "$R1" old)"
want "old master key" 401 "$(api $OLD GET /model/info)"
want "S as master key" 200 "$(api $S GET /model/info)"
want "stored model served" 200 "$(chat $S console-stored-model)"

step "4. step 2: LITELLM_SALT_KEY=S, master key M, the variable emptied (as the chart renders it), new console password"
gw_up "$M" "$S" EMPTY "$UI_NEW" || die "gateway (step 2)"
R2=$(scan "$(printf '%s\0%s\0%s\0%s\0' old "$OLD" m "$M" | keys_json)")
want "per column, decryptable with the salt key S" "$BEFORE" "$(per_column "$R2" effective)"
want "values under the old master key" 0 "$(total "$R2" old)"
want "values under the new master key M (it encrypts nothing)" 0 "$(total "$R2" m)"
want "old master key" 401 "$(api $OLD GET /model/info)"
want "S as master key" 401 "$(api $S GET /model/info)"
want "new master key M" 200 "$(api $M GET /model/info)"
want "stored model served" 200 "$(chat $M console-stored-model)"
want "stored credential reads back" 200 "$(api $M GET /credentials/by_name/rehearsal-cred)"
want "console login, new password" 200 "$(ui_login "$UI_NEW")"
want "console login, old password" 401 "$(ui_login "$UI_OLD")"
gw_up "$M" "$S" EMPTY "$UI_NEW" || die "gateway (restart)"
want "after another restart: per column under S" "$BEFORE" "$(per_column "$(scan)" effective)"

step "B5. Langfuse nextauthSecret: a session from before the rotation"
JAR=$W/jar.session
want "signed in with the default secret" signed-in "$(lf_signin "$PW_OLD" "$JAR")"
step "B6+7. Langfuse salt, nextauthSecret, encryptionKey and a new key pair, one restart"
enc=$( { echo "BEGIN TRANSACTION READ ONLY;"; for t in llm_api_keys blob_storage_integrations posthog_integrations mixpanel_integrations actions sso_configs slack_integrations web_callout_endpoints; do
  printf "SELECT '%s', CASE WHEN to_regclass('public.%s') IS NULL THEN -1 ELSE (xpath('/row/c/text()', query_to_xml('SELECT count(*) AS c FROM public.%s', false, true, '')))[1]::text::int END;\n" "$t" "$t" "$t"
done; echo "COMMIT;"; } | docker exec -i lfpgr psql -v ON_ERROR_STOP=1 -U postgres -d langfuse -tA -q)
echo "$enc" | sed 's/^/   /'
want "encrypted Langfuse entries (rotate-secrets.sh's count)" 0 "$(awk -F'|' '$2>0{s+=$2} END{print s+0}' <<<"$enc")"
lf_up "$SALT_NEW" "$NA_NEW" "$EK_NEW" "$LF_PK_NEW" "$LF_SK_NEW" || die "Langfuse (rotated) did not start"
want "the old session after the nextauthSecret change" refused "$(lf_session "$JAR")"
want "new pair (headless init, new salt)" 200 "$(lf_auth $LF_PK_NEW $LF_SK_NEW)"
want "OLD pair after the salt change (the fast hash re-heals from bcrypt)" 200 "$(lf_auth $LF_PK_OLD $LF_SK_OLD)"
docker exec lfredisr redis-cli -a redissecret --no-auth-warning --scan --pattern 'api-key*' | xargs -r docker exec lfredisr redis-cli -a redissecret --no-auth-warning del >/dev/null
docker exec lfpgr psql -U postgres -d langfuse -tAc "DELETE FROM api_keys WHERE public_key = '$LF_PK_OLD'" | sed 's/^/   delete the old pair (what the UI does; cache cleared): /'
want "OLD pair after its deletion" 401 "$(lf_auth $LF_PK_OLD $LF_SK_OLD)"
want "Langfuse healthy with the new encryptionKey" 200 "$(curl -s -o /dev/null -w '%{http_code}' $LF/api/public/health)"
c=$(printf 'user = "%s:%s"\n' $LF_PK_NEW $LF_SK_NEW | curl -s -K - -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' $LF/api/public/llm-connections \
     -X PUT -o "$W/llmconn.json" --data '{"provider":"rehearsal","adapter":"openai","secretKey":"sk-llm-connection-secret"}')
echo "   twin: an LLM connection stored ($c)"; [ "$c" = 200 ] || head -c 300 "$W/llmconn.json"
want "twin: the count now finds it" 1 "$(docker exec lfpgr psql -U postgres -d langfuse -tAc 'SELECT count(*) FROM llm_api_keys')"

step "B8. Langfuse admin password: bcrypt 12 by langfuse-web's bcryptjs, one row"
want "signed in with the old password" signed-in "$(lf_signin "$PW_OLD")"
OLDHASH=$(docker exec lfpgr psql -U postgres -d langfuse -tAc "SELECT password FROM users WHERE email = '$EMAIL'")
NEWHASH=$(printf '%s' "$PW_NEW" | docker exec -i lfwebr sh -c 'node -e "const fs=require(\"fs\"),d=\"/app/node_modules/.pnpm\",p=fs.readdirSync(d).find(x=>/^bcryptjs@/.test(x)),b=require(d+\"/\"+p+\"/node_modules/bcryptjs\");let s=\"\";process.stdin.on(\"data\",c=>s+=c).on(\"end\",async()=>console.log(await b.hash(s,12)))"')
case $NEWHASH in '$2'[aby]'$12$'*) ok "bcrypt cost-12 hash from langfuse-web's bcryptjs" ;; *) bad "no bcrypt-12 hash from langfuse-web: ${NEWHASH:0:20}" ;; esac
r=$( { printf "\\\\set e '%s'\n\\\\set h '%s'\n\\\\set o '%s'\n" "$EMAIL" "$NEWHASH" "$OLDHASH"; printf "UPDATE users SET password = :'h' WHERE email = :'e' AND password = :'o';\n"; } | docker exec -i lfpgr psql -v ON_ERROR_STOP=1 -U postgres -d langfuse -tA)
want "one row updated" "UPDATE 1" "$r"
want "new password signs in" signed-in "$(lf_signin "$PW_NEW")"
want "old password refused" refused "$(lf_signin "$PW_OLD")"
want "user id and membership unchanged (OWNER)" OWNER "$(docker exec lfpgr psql -U postgres -d langfuse -tAc "SELECT m.role FROM users u JOIN organization_memberships m ON m.user_id = u.id WHERE u.email = '$EMAIL'")"
r=$( { printf "\\\\set e '%s'\n\\\\set h '%s'\n" "$EMAIL" "$OLDHASH"; printf "UPDATE users SET password = :'h' WHERE email = :'e';\n"; } | docker exec -i lfpgr psql -v ON_ERROR_STOP=1 -U postgres -d langfuse -tA)
want "rollback: one row" "UPDATE 1" "$r"
want "rollback: old password signs in again" signed-in "$(lf_signin "$PW_OLD")"

echo
echo "$pass passed, $failn failed (logs: $W)"
[ "$failn" -eq 0 ] && echo "SECRET_ROTATION_REHEARSAL_OK" || { echo "SECRET_ROTATION_REHEARSAL_FAILED"; exit 1; }
