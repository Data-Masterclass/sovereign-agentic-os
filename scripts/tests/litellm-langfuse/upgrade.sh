#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# litellm-langfuse/upgrade.sh — the schema facts the upgrade procedure and the rollback rest on,
# measured on real images (pattern from PR #104's upgrade test).
#
#   OLD_IMAGE=ghcr.io/berriai/litellm-database:v1.90.0 scripts/tests/litellm-langfuse/upgrade.sh
#
# 1. a database initialised and used by OLD (a virtual key with spend);
# 2. RACE: the NEW proxy on the still-OLD schema (why docs/ops/litellm-upgrade.md migrates first);
# 3. migration with NEW, then the OLD proxy on the NEW schema: the window while
#    deploy/litellm-premigrate.sh runs, and the image-only rollback;
# 4. the NEW proxy on the migrated database: the key, its spend and a call survive.
# Exit 0 only when 3 and 4 hold. 2 is reported, not asserted (it documents the race).
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
CHART=${CHART_DIR:-$REPO/charts/sovereign-agentic-os}
YAML_DIR=${JS_YAML_DIR:-$REPO/os-ui/node_modules/js-yaml}
W=${LITELLM_LANGFUSE_WORKDIR:-$HOME/.cache/litellm-langfuse-upgrade}
OLD=${OLD_IMAGE:-ghcr.io/berriai/litellm-database:v1.90.0}
NET=lfup; MASTER=sk-test-master-not-a-secret; KEY=sk-test-upgrade-key; GW=http://127.0.0.1:14100
mkdir -p "$W/data"; fail=0
down() { docker rm -f upgw uppg upstub upredis >/dev/null 2>&1; docker network rm $NET >/dev/null 2>&1; }
trap down EXIT
must() { if "$@"; then :; else echo "  FAILED: $*"; fail=$((fail+1)); fi; }

helm template agentic-os "$CHART" -n agentic-os -f "$(cd "$CHART/../.." && pwd)/values.stackit-managed.yaml" > "$W/rendered.yaml" 2>/dev/null || { echo "helm template failed"; exit 2; }
node "$HERE/mkconfig.mjs" "$W/rendered.yaml" "$W/config.yaml" "$W/otel.env" "$YAML_DIR" >/dev/null || exit 2
NEW=${NEW_IMAGE:-$(node -e '
const y=require(process.argv[2]);const d=y.loadAll(require("fs").readFileSync(process.argv[1],"utf8")).filter(Boolean)
 .find(x=>x.kind==="Deployment"&&/-litellm$/.test(x.metadata.name));console.log(d.spec.template.spec.containers[0].image)' "$W/rendered.yaml" "$YAML_DIR")}
echo "OLD $OLD -> NEW $NEW"
down; docker network create $NET >/dev/null
docker run -d --name uppg --network $NET -e POSTGRES_USER=litellm -e POSTGRES_PASSWORD=test -e POSTGRES_DB=litellm postgres:17 >/dev/null
docker run -d --name upredis --network $NET --network-alias valkey redis:7 --requirepass test >/dev/null
docker run -d --name upstub --network $NET --network-alias stub -v "$HERE":/h:ro -v "$W/data":/data -e DATA_DIR=/data node:22-alpine node /h/stub.mjs >/dev/null
for i in $(seq 1 30); do docker exec uppg pg_isready -h 127.0.0.1 -U litellm >/dev/null 2>&1 && break; sleep 1; done; sleep 2
DB=postgresql://litellm:test@uppg:5432/litellm
migrate() { docker run --rm --network $NET --entrypoint python -w /app -e DATABASE_URL=$DB -e DISABLE_SCHEMA_UPDATE=false "$1" litellm/proxy/prisma_migration.py > "$W/migrate.log" 2>&1; echo "  migration with $1: exit $?"; }
up() { # $1 image; env file only for an image that knows OTel v2 (harmless otherwise)
  docker rm -f upgw >/dev/null 2>&1
  docker run -d --name upgw --network $NET -p 127.0.0.1:14100:4000 --env-file "$W/otel.env" -e HOST=0.0.0.0 -e PORT=4000 -e DATABASE_URL=$DB \
    -e PROXY_MASTER_KEY=$MASTER -e DISABLE_SCHEMA_UPDATE=true -e STORE_MODEL_IN_DB=true -e SERVER_ROOT_PATH=/tools/litellm -e REDIS_PASSWORD=test \
    -e LANGFUSE_PUBLIC_KEY=pk-lf-x -e LANGFUSE_SECRET_KEY=sk-lf-x -e LANGFUSE_HOST=http://stub:8080 -e STACKIT_API_BASE=http://stub:8080/v1 -e STACKIT_API_KEY=x \
    -v "$W/config.yaml":/etc/litellm/config.yaml:ro "$1" --config /etc/litellm/config.yaml >/dev/null
  for i in $(seq 1 90); do [ "$(curl -s -o /dev/null -w '%{http_code}' $GW/health/readiness || true)" = 200 ] && return 0; sleep 2; done
  docker logs --tail 30 upgw; return 1
}
chat() { curl -s -o "$W/data/chat.body" -w '%{http_code}' $GW/v1/chat/completions -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"model":"stackit-gpt-oss-20b","messages":[{"role":"user","content":"hi"}]}'; }
spend() { curl -s -H "Authorization: Bearer $MASTER" "$GW/key/info?key=$KEY" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("info",{}).get("spend") or 0)'; }
positive() { python3 -c "import sys; sys.exit(0 if float(sys.argv[1]) > 0 else 1)" "$1"; }

echo "== 1. database initialised and used by OLD"
migrate "$OLD"; up "$OLD" || { echo "OLD did not start"; exit 1; }
curl -s -o /dev/null -w '  /key/generate: %{http_code}\n' -H "Authorization: Bearer $MASTER" -H 'content-type: application/json' $GW/key/generate -d '{"key":"'$KEY'","models":["stackit-gpt-oss-20b"],"max_budget":5,"budget_duration":"7d"}'
for i in 1 2 3; do chat >/dev/null; done
# The gateway books spend asynchronously: poll until it is > 0 (timeout 120 s), never a fixed wait.
S0=0; for i in $(seq 1 60); do S0=$(spend); positive "$S0" && break; sleep 2; done
positive "$S0" || { echo "  FAILED: the OLD gateway booked no spend within 120 s"; exit 1; }
echo "  OLD: chat $(chat), key spend $S0"

echo "== 2. RACE: NEW proxy on the OLD schema (reported)"
if up "$NEW"; then echo "  NEW on OLD schema: ready; chat HTTP $(chat) $(head -c 160 "$W/data/chat.body")"; else echo "  NEW on OLD schema: did not become ready"; fi

echo "== 3. migrate with NEW, then OLD proxy on the NEW schema (premigrate window + image rollback)"
migrate "$NEW"; must grep -q 'Setup complete' "$W/migrate.log"
up "$OLD" || { echo "  FAILED: OLD did not start on the NEW schema"; fail=$((fail+1)); }
C=$(chat); echo "  OLD on NEW schema: chat HTTP $C, key spend $(spend), schema errors in log: $(docker logs upgw 2>&1 | grep -c -i -E 'does not exist|prisma.errors')"
must [ "$C" = 200 ]

echo "== 4. NEW proxy on the migrated database"
up "$NEW" || { echo "  FAILED: NEW did not start"; fail=$((fail+1)); }
C=$(chat); S1=$(spend); echo "  NEW: chat HTTP $C, key spend $S1 (was $S0 before the upgrade)"
must [ "$C" = 200 ]
must python3 -c "import sys; sys.exit(0 if float('$S1' or 0) >= float('$S0' or 0) > 0 else 1)"
if [ $fail = 0 ]; then echo "LITELLM_UPGRADE_SCHEMA_OK ($OLD -> $NEW)"; else echo "LITELLM_UPGRADE_SCHEMA_FAILED ($fail)"; exit 1; fi
