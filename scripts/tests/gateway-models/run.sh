#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# gateway-models — the OS model list IS LiteLLM's, proven against the REAL LiteLLM image.
#
# Starts postgres and the chart's own LiteLLM image (taken from the rendered chart, so the test moves
# with the pin) the way the chart runs it: a config file with a `model_list` (a config-managed model)
# AND `store_model_in_db` on (database-managed models), then runs
# os-ui/tabs/admin/lib/gateway-models.e2e.test.ts. That test adds and removes models and credentials
# through LiteLLM's OWN admin API — no OS code involved — and checks the OS reads (the same module the
# model picker and Platform -> Models & Providers use) follow: a model added in LiteLLM appears, one
# removed disappears, a config model is told apart from a database one, the OS removes only database
# models, and no credential value ever reaches the OS list.
# It then proves the OS-owned ROLE MAPPING (tabs/admin/lib/model-roles.e2e.test.ts): the OS writes
# router_settings.model_group_alias through /config/update; a remap changes the next call with no restart;
# a foreign edit is repaired and reported; a mapping to a missing model is refused; a catalog model removed
# under a role is a typed failure, not a silent fallback; an old alias still works and logs a deprecation.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
CHART=$REPO/charts/sovereign-agentic-os
W=${GATEWAY_MODELS_WORKDIR:-$HOME/.cache/gateway-models-test}
NET=gwm
MASTER=sk-test-master-not-a-secret
GW=http://127.0.0.1:14200
mkdir -p "$W"
die() { docker logs gwmgw > "$W/gw.log" 2>&1 || true; echo "GATEWAY_MODELS_TEST_FAILED — $*"; tail -40 "$W/gw.log" 2>/dev/null || true; exit 1; }
down() { docker rm -f gwmgw gwmpg >/dev/null 2>&1; docker network rm $NET >/dev/null 2>&1 || true; }
[ -n "${KEEP:-}" ] || trap down EXIT
command -v docker >/dev/null && docker info >/dev/null 2>&1 || die "docker is not running"

helm template agentic-os "$CHART" -n agentic-os > "$W/rendered.yaml" 2>"$W/helm.err" || { cat "$W/helm.err"; die "helm template failed (helm dependency build first?)"; }
IMAGE=${LITELLM_IMAGE:-$(node -e '
const y=require(process.argv[2]);const d=y.loadAll(require("fs").readFileSync(process.argv[1],"utf8")).filter(Boolean)
 .find(x=>x.kind==="Deployment"&&/-litellm$/.test(x.metadata.name));console.log(d.spec.template.spec.containers[0].image)' "$W/rendered.yaml" "$REPO/os-ui/node_modules/js-yaml")}
echo "gateway image: $IMAGE"

# The chart's shape: a config-file model + store_model_in_db (litellm.proxy_config.general_settings).
cat > "$W/config.yaml" <<'YAML'
model_list:
  - model_name: sovereign-default
    litellm_params: { model: openai/stub, api_base: "http://127.0.0.1:9/v1", api_key: unused }
general_settings:
  master_key: os.environ/PROXY_MASTER_KEY
  store_model_in_db: true
YAML

down
docker network create $NET >/dev/null
docker run -d --name gwmpg --network $NET -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=litellm postgres:17 >/dev/null
for i in $(seq 1 60); do docker exec gwmpg pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && break; sleep 1; done
docker run -d --name gwmgw --network $NET -p 127.0.0.1:14200:4000 -v "$W/config.yaml":/app/config.yaml:ro \
  -e DATABASE_URL=postgresql://postgres:postgres@gwmpg:5432/litellm -e PROXY_MASTER_KEY=$MASTER \
  -e LITELLM_SALT_KEY=sk-test-salt-not-a-secret -e STORE_MODEL_IN_DB=True \
  "$IMAGE" --config /app/config.yaml --port 4000 >/dev/null
ok=
for i in $(seq 1 120); do
  if curl -fsS -H "Authorization: Bearer $MASTER" "$GW/model/info" >/dev/null 2>&1; then ok=1; break; fi
  sleep 3
done
[ -n "$ok" ] || die "the gateway did not become ready"

cd "$REPO/os-ui"
LITELLM_URL=$GW LITELLM_MASTER_KEY=$MASTER GATEWAY_MODELS_E2E_REQUIRED=1 \
  node --experimental-test-module-mocks --import ./scripts/test-setup.mjs --test --test-concurrency=1 \
  tabs/admin/lib/gateway-models.e2e.test.ts tabs/admin/lib/model-roles.e2e.test.ts tabs/admin/lib/role-switch.e2e.test.ts || die "the e2e test failed"
echo "GATEWAY_MODELS_TEST_PASSED"
