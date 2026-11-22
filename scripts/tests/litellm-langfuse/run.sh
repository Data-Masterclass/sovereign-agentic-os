#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# litellm-langfuse/run.sh — the gateway's Langfuse hop, proven on REAL containers (10 F1, WP-32).
#
#   scripts/tests/litellm-langfuse/run.sh
#   CHART_DIR=<other checkout>/charts/sovereign-agentic-os scripts/tests/litellm-langfuse/run.sh
#
# 1. Renders THIS chart (STACKIT profile) and takes the gateway's image, config text and OTel env
#    from the rendered manifests (mkconfig.mjs): the test runs what the cluster runs. Only the
#    model provider is a stub (stub.mjs).
# 2. Starts Langfuse $LANGFUSE_VERSION (web + worker) on its documented self-hosting stack
#    (https://langfuse.com/self-hosting/docker-compose: Postgres 17, ClickHouse — here the chart's
#    pinned digest —, Redis 7, MinIO), with headless init of one org, project and key pair.
# 3. Migrates the gateway's database with the gateway image (the chart's migration command), starts
#    the gateway, creates the shared agent key the os-ui test setup uses.
# 4. Runs os-ui/core/runtime/tracing.e2e.test.ts with TRACING_E2E_REQUIRED=1 (a skip is a failure):
#    one model call through os-ui's own gateway caller -> exactly one GENERATION, nested under the
#    app span via `traceparent`, carrying the call id, usage and cost; a spent virtual-key budget is
#    refused.
# 5. Reads the headers the gateway's OTLP exporter sends (x-langfuse-ingestion-version).
# 6. NEGATIVE TWIN: the same test with `success_callback: ["langfuse"]` added to the config. It
#    MUST fail on the generation count; if it passes, this script fails.
# Exit 0 only when 4 passed, 6 failed for the right reason, and the gateway reports its version.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
CHART=${CHART_DIR:-$REPO/charts/sovereign-agentic-os}
PROFILE=${PROFILE_VALUES:-$(cd "$CHART/../.." && pwd)/values.stackit-managed.yaml}
LANGFUSE_VERSION=${LANGFUSE_VERSION:-3.194.1}
YAML_DIR=${JS_YAML_DIR:-$REPO/os-ui/node_modules/js-yaml}
# A path the Docker VM shares (Colima and Docker Desktop share $HOME, not $TMPDIR).
W=${LITELLM_LANGFUSE_WORKDIR:-$HOME/.cache/litellm-langfuse-test}
NET=lfgw
MASTER=sk-test-master-not-a-secret
AGENT_KEY=sk-test-scoped-agent-key       # = LITELLM_AGENT_KEY in os-ui/scripts/test-setup.mjs
PK=pk-lf-test-not-a-secret; SK=sk-lf-test-not-a-secret
LF=http://127.0.0.1:13000; GW=http://127.0.0.1:${GW_PORT:-14000}
mkdir -p "$W/data"; rm -f "$W/data/sink.jsonl"
step() { printf '\n==================== %s\n' "$*"; }
die() { docker logs gw > "$W/gw.log" 2>&1 || true; docker logs lfweb > "$W/lfweb.log" 2>&1 || true; echo "LITELLM_LANGFUSE_TEST_FAILED — $*"; exit 1; }
down() { docker rm -f gw lfweb lfworker lfch lfredis lfminio lfpg lfstub >/dev/null 2>&1; docker network rm $NET >/dev/null 2>&1; }
[ -n "${KEEP:-}" ] || trap down EXIT
command -v docker >/dev/null && docker info >/dev/null 2>&1 || die "docker is not running"

step "render the chart and derive the gateway image, config and env"
helm template agentic-os "$CHART" -n agentic-os -f "$PROFILE" > "$W/rendered.yaml" 2>"$W/helm.err" || { cat "$W/helm.err"; die "helm template failed (helm dependency build first?)"; }
node "$HERE/mkconfig.mjs" "$W/rendered.yaml" "$W/config.yaml" "$W/otel.env" "$YAML_DIR" || die "mkconfig"
# The twin can only be built from a config that does not already use the legacy callback.
TWIN=1; node "$HERE/mkconfig.mjs" "$W/rendered.yaml" "$W/config-twin.yaml" "$W/otel-twin.env" "$YAML_DIR" --legacy-twin >/dev/null 2>"$W/twin.err" || { TWIN=; echo "negative twin not built: $(tail -1 "$W/twin.err")"; }
IMAGE=${LITELLM_IMAGE:-$(node -e '
const y=require(process.argv[2]);const d=y.loadAll(require("fs").readFileSync(process.argv[1],"utf8")).filter(Boolean)
 .find(x=>x.kind==="Deployment"&&/-litellm$/.test(x.metadata.name));console.log(d.spec.template.spec.containers[0].image)' "$W/rendered.yaml" "$YAML_DIR")}
CH_IMAGE=$(node -e '
const y=require(process.argv[2]);const v=y.load(require("fs").readFileSync(process.argv[1],"utf8")).clickhouse.image;
console.log(`${v.repository}:${v.tag}${v.digest?"@"+v.digest:""}`)' "$CHART/values.yaml" "$YAML_DIR")
SCOPE=$(sed -n 's/^LITELLM_OTEL_LANGFUSE_SPAN_SCOPE=//p' "$W/otel.env")
echo "gateway image $IMAGE; ClickHouse $CH_IMAGE; Langfuse $LANGFUSE_VERSION; span scope ${SCOPE:-unset}"

step "Langfuse $LANGFUSE_VERSION on its documented stack"
down; docker network create $NET >/dev/null
docker run -d --name lfpg --network $NET -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=postgres postgres:17 >/dev/null
docker run -d --name lfch --network $NET --user 101:101 -e CLICKHOUSE_DB=default -e CLICKHOUSE_USER=clickhouse -e CLICKHOUSE_PASSWORD=clickhouse "$CH_IMAGE" >/dev/null
docker run -d --name lfredis --network $NET --network-alias valkey redis:7 --requirepass myredissecret --maxmemory-policy noeviction >/dev/null
docker run -d --name lfminio --network $NET --entrypoint sh -e MINIO_ROOT_USER=minio -e MINIO_ROOT_PASSWORD=miniosecret cgr.dev/chainguard/minio \
  -c 'mkdir -p /data/langfuse && minio server --address ":9000" /data' >/dev/null
docker run -d --name lfstub --network $NET --network-alias stub -v "$HERE":/h:ro -v "$W/data":/data -e DATA_DIR=/data node:22-alpine node /h/${STUB_FILE:-stub.mjs} >/dev/null
# Langfuse migrates ClickHouse over the native port at start: wait for it, not only for HTTP.
for i in $(seq 1 60); do
  docker exec lfpg pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 \
    && docker exec lfch clickhouse-client --user clickhouse --password clickhouse --query 'SELECT 1' >/dev/null 2>&1 && break
  sleep 2
done
docker exec lfpg psql -h 127.0.0.1 -U postgres -q -c 'CREATE DATABASE litellm' || die "create litellm database"
LFENV=(-e DATABASE_URL=postgresql://postgres:postgres@lfpg:5432/postgres -e SALT=mysalt -e NEXTAUTH_URL=http://localhost:3000
  -e ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 -e TELEMETRY_ENABLED=false
  -e CLICKHOUSE_MIGRATION_URL=clickhouse://lfch:9000 -e CLICKHOUSE_URL=http://lfch:8123 -e CLICKHOUSE_USER=clickhouse
  -e CLICKHOUSE_PASSWORD=clickhouse -e CLICKHOUSE_CLUSTER_ENABLED=false -e REDIS_HOST=lfredis -e REDIS_PORT=6379 -e REDIS_AUTH=myredissecret
  -e LANGFUSE_S3_EVENT_UPLOAD_BUCKET=langfuse -e LANGFUSE_S3_EVENT_UPLOAD_REGION=auto -e LANGFUSE_S3_EVENT_UPLOAD_ACCESS_KEY_ID=minio
  -e LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY=miniosecret -e LANGFUSE_S3_EVENT_UPLOAD_ENDPOINT=http://lfminio:9000
  -e LANGFUSE_S3_EVENT_UPLOAD_FORCE_PATH_STYLE=true -e LANGFUSE_S3_EVENT_UPLOAD_PREFIX=events/)
docker run -d --name lfworker --restart always --network $NET "${LFENV[@]}" "langfuse/langfuse-worker:$LANGFUSE_VERSION" >/dev/null
docker run -d --name lfweb --restart always --network $NET -p 127.0.0.1:13000:3000 "${LFENV[@]}" -e NEXTAUTH_SECRET=mysecret \
  -e LANGFUSE_INIT_ORG_ID=org-test -e LANGFUSE_INIT_ORG_NAME=test -e LANGFUSE_INIT_PROJECT_ID=agent-core -e LANGFUSE_INIT_PROJECT_NAME=agent-core \
  -e LANGFUSE_INIT_PROJECT_PUBLIC_KEY=$PK -e LANGFUSE_INIT_PROJECT_SECRET_KEY=$SK \
  -e LANGFUSE_INIT_USER_EMAIL=test@example.invalid -e LANGFUSE_INIT_USER_NAME=test -e LANGFUSE_INIT_USER_PASSWORD=test-password-1 \
  "langfuse/langfuse:$LANGFUSE_VERSION" >/dev/null
for i in $(seq 1 120); do
  code=$(curl -s -o "$W/data/health.json" -w '%{http_code}' $LF/api/public/health || true); [ "$code" = 200 ] && break; sleep 2
done
[ "$code" = 200 ] || { docker logs --tail 60 lfweb; die "Langfuse /api/public/health never answered 200"; }
echo "Langfuse health: $(cat "$W/data/health.json")"

# $1 config file, $2 env file, $3 LANGFUSE_HOST (default: the Langfuse web container)
gw_up() {
  docker rm -f gw >/dev/null 2>&1
  docker run -d --name gw --network $NET -p 127.0.0.1:${GW_PORT:-14000}:4000 --env-file "$2" \
    -e HOST=0.0.0.0 -e PORT=4000 -e DATABASE_URL=postgresql://postgres:postgres@lfpg:5432/litellm -e PROXY_MASTER_KEY=$MASTER \
    -e LITELLM_LOG=INFO -e SERVER_ROOT_PATH=/tools/litellm -e STORE_MODEL_IN_DB=true -e DISABLE_SCHEMA_UPDATE=true \
    -e REDIS_PASSWORD=myredissecret -e LANGFUSE_PUBLIC_KEY=$PK -e LANGFUSE_SECRET_KEY=$SK -e LANGFUSE_HOST="${3:-http://lfweb:3000}" \
    -e STACKIT_API_BASE=http://stub:8080/v1 -e STACKIT_API_KEY=sk-upstream-test \
    -v "$1":/etc/litellm/config.yaml:ro "$IMAGE" --config /etc/litellm/config.yaml >/dev/null
  for i in $(seq 1 90); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' $GW/health/readiness || true)" = 200 ] && return 0
    docker inspect -f '{{.State.Running}}' gw 2>/dev/null | grep -q true || { docker logs --tail 60 gw; return 1; }
    sleep 2
  done
  docker logs --tail 60 gw; return 1
}
# The gateway's response cache uses the chart's Valkey Service name `valkey`: here that alias is
# Langfuse's Redis (same protocol, password in REDIS_PASSWORD). The cache is opt-in per request
# (`mode: default_off`) and the test never opts in.

step "gateway: migrate its database with the gateway image, then start it"
docker run --rm --network $NET --entrypoint python -w /app -e DATABASE_URL=postgresql://postgres:postgres@lfpg:5432/litellm \
  -e DISABLE_SCHEMA_UPDATE=false "$IMAGE" litellm/proxy/prisma_migration.py > "$W/migrate.log" 2>&1 || { tail -30 "$W/migrate.log"; die "migration failed"; }
tail -2 "$W/migrate.log"
gw_up "$W/config.yaml" "$W/otel.env" || die "the gateway did not start"
# 1.109.1 reports its version and the callbacks it loaded on /health/readiness/details (admin).
readiness() { curl -s -H "Authorization: Bearer $MASTER" $GW/health/readiness/details > "$W/readiness.json"; python3 - "$W/readiness.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); cb=d.get('success_callbacks') or []
print(f"gateway ready: litellm_version={d.get('litellm_version','(absent)')}; Langfuse callbacks loaded: {[c for c in cb if 'angfuse' in c] or '(none)'}")
PY
}
readiness
VERSION=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("litellm_version","unknown"))' "$W/readiness.json")
curl -sS -o /dev/null -w 'shared agent key: HTTP %{http_code}\n' -H "Authorization: Bearer $MASTER" -H 'content-type: application/json' \
  $GW/key/generate -d '{"key":"'$AGENT_KEY'","key_alias":"sovereign-agents","models":["stackit-gpt-oss-20b"],"max_budget":25,"budget_duration":"7d"}'

run_test() { # $1 log file
  (cd "$REPO/os-ui" && LITELLM_URL=$GW LITELLM_E2E_MASTER_KEY=$MASTER LANGFUSE_E2E_URL=$LF LANGFUSE_E2E_PUBLIC_KEY=$PK \
    LANGFUSE_E2E_SECRET_KEY=$SK LITELLM_E2E_SPAN_SCOPE="${SCOPE:-full}" LITELLM_E2E_VERSION="$VERSION" TRACING_E2E_REQUIRED=1 \
    node --experimental-test-module-mocks --import ./scripts/test-setup.mjs --test --test-concurrency=1 core/runtime/tracing.e2e.test.ts) > "$1" 2>&1
}

step "the e2e test against the chart's config"
run_test "$W/e2e.log"; rc=$?
grep -E '^# (pass|fail)|^not ok|^ok|GENERATION|assert' "$W/e2e.log" | head -40
[ $rc = 0 ] || { die "the e2e test failed against the chart's config (log: $W/e2e.log)"; }

step "headers of the gateway's OTLP export (sink)"
gw_up "$W/config.yaml" "$W/otel.env" http://stub:8080 || die "gateway (sink) did not start"
curl -sS -o /dev/null -H "Authorization: Bearer $AGENT_KEY" -H 'content-type: application/json' $GW/v1/chat/completions \
  -d '{"model":"stackit-gpt-oss-20b","messages":[{"role":"user","content":"hi"}]}'
for i in $(seq 1 20); do grep -q '/otel/' "$W/data/sink.jsonl" 2>/dev/null && break; sleep 1; done
python3 - "$W/data/sink.jsonl" <<'PY' || die "the gateway exported nothing to the sink"
import json,sys
rows=[json.loads(l) for l in open(sys.argv[1]) if '/otel/' in l]
assert rows, 'no OTLP request'
h=rows[0]['headers']
print('OTLP', rows[0]['method'], rows[0]['url'], 'content-type', h.get('content-type'), 'x-langfuse-ingestion-version', h.get('x-langfuse-ingestion-version','(absent)'))
PY

[ -n "$TWIN" ] || die "the negative twin could not be built from this chart's config (it already uses the legacy callback)"
step "NEGATIVE TWIN: success_callback [\"langfuse\"] added — the test must fail on the generation count"
gw_up "$W/config-twin.yaml" "$W/otel-twin.env" || die "gateway (twin) did not start"
readiness
run_test "$W/e2e-twin.log"; trc=$?
grep -E '^# (pass|fail)|^not ok|GENERATION' "$W/e2e-twin.log" | head -20
[ $trc != 0 ] || die "the negative twin PASSED — the test cannot tell one generation from two"
grep -q 'GENERATION' "$W/e2e-twin.log" || die "the negative twin failed, but not on the generation count (log: $W/e2e-twin.log)"

echo
echo "logs: $W"
echo "LITELLM_LANGFUSE_TEST_OK (gateway $VERSION, Langfuse $LANGFUSE_VERSION, scope ${SCOPE:-unset}; twin red)"
