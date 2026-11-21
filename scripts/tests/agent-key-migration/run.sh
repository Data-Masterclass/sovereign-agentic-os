#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# agent-key-migration — prove the make-before-break key migration against the REAL LiteLLM image.
#
# Starts postgres:17 and the chart's own LiteLLM image (taken from the rendered chart, so the test
# moves with the pin) with a master key and one model alias, then runs
# os-ui/tabs/agents/lib/build/system-key-migration.e2e.test.ts against it. That test:
#   - registers a system's OLD guessable key the way old releases did, and checks it works (200);
#   - migrates through os-ui's real LiteLLM admin client (`realLitellm`): stage → rename aside →
#     register → store → delete, polling the gateway's inference auth between steps;
#   - checks the old value is answered 401 afterwards, the new one 200, and a re-run is a no-op;
#   - crashes the pass after the rename, re-runs, and checks one new value and no leftover key.
# Negative twin, in the same file: a made-up key must be 401 (the gateway really authenticates).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
CHART=$REPO/charts/sovereign-agentic-os
W=${AGENT_KEY_MIGRATION_WORKDIR:-$HOME/.cache/agent-key-migration-test}
NET=akm
MASTER=sk-test-master-not-a-secret
GW=http://127.0.0.1:14100
mkdir -p "$W"
die() { docker logs akmgw > "$W/gw.log" 2>&1 || true; echo "AGENT_KEY_MIGRATION_TEST_FAILED — $*"; tail -40 "$W/gw.log" 2>/dev/null || true; exit 1; }
down() { docker rm -f akmgw akmpg >/dev/null 2>&1; docker network rm $NET >/dev/null 2>&1 || true; }
[ -n "${KEEP:-}" ] || trap down EXIT
command -v docker >/dev/null && docker info >/dev/null 2>&1 || die "docker is not running"

helm template agentic-os "$CHART" -n agentic-os > "$W/rendered.yaml" 2>"$W/helm.err" || { cat "$W/helm.err"; die "helm template failed (helm dependency build first?)"; }
IMAGE=${LITELLM_IMAGE:-$(node -e '
const y=require(process.argv[2]);const d=y.loadAll(require("fs").readFileSync(process.argv[1],"utf8")).filter(Boolean)
 .find(x=>x.kind==="Deployment"&&/-litellm$/.test(x.metadata.name));console.log(d.spec.template.spec.containers[0].image)' "$W/rendered.yaml" "$REPO/os-ui/node_modules/js-yaml")}
echo "gateway image: $IMAGE"

cat > "$W/config.yaml" <<'YAML'
model_list:
  - model_name: sovereign-default
    litellm_params: { model: openai/stub, api_base: "http://127.0.0.1:9/v1", api_key: unused }
general_settings:
  master_key: os.environ/PROXY_MASTER_KEY
YAML

down
docker network create $NET >/dev/null
docker run -d --name akmpg --network $NET -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=litellm postgres:17 >/dev/null
for i in $(seq 1 60); do docker exec akmpg pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && break; sleep 1; done
docker run -d --name akmgw --network $NET -p 127.0.0.1:14100:4000 -v "$W/config.yaml":/app/config.yaml:ro \
  -e DATABASE_URL=postgresql://postgres:postgres@akmpg:5432/litellm -e PROXY_MASTER_KEY=$MASTER -e STORE_MODEL_IN_DB=False \
  "$IMAGE" --config /app/config.yaml --port 4000 >/dev/null
ok=
for i in $(seq 1 120); do
  if curl -fsS -H "Authorization: Bearer $MASTER" "$GW/key/list?size=1" >/dev/null 2>&1; then ok=1; break; fi
  sleep 3
done
[ -n "$ok" ] || die "the gateway did not become ready"

cd "$REPO/os-ui"
LITELLM_URL=$GW LITELLM_MASTER_KEY=$MASTER AGENT_KEY_MIGRATION_E2E_REQUIRED=1 \
  node --experimental-test-module-mocks --import ./scripts/test-setup.mjs --test --test-concurrency=1 \
  tabs/agents/lib/build/system-key-migration.e2e.test.ts || die "the e2e test failed"
echo "AGENT_KEY_MIGRATION_TEST_PASSED"
