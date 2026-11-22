#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# reasoning-budget — a reasoning model that spends its whole output budget thinking, and the model limits
# the OS reads from the catalog, proven on the REAL LiteLLM image the chart pins (taken from the rendered
# chart). The provider behind the gateway is a stub served by the test process (no Lyceum, no network).
# Runs os-ui/core/runtime/reasoning-budget.e2e.test.ts. Starts one container, `rbgw`; removes it on exit.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
CHART=$REPO/charts/sovereign-agentic-os
W=${REASONING_BUDGET_WORKDIR:-$HOME/.cache/reasoning-budget-test}
PORT=${REASONING_E2E_PORT:-14210}
STUB_PORT=${REASONING_STUB_PORT:-18940}
mkdir -p "$W"
die() { docker logs rbgw > "$W/gw.log" 2>&1 || true; echo "REASONING_BUDGET_TEST_FAILED — $*"; tail -40 "$W/gw.log" 2>/dev/null || true; exit 1; }
down() { docker rm -f rbgw >/dev/null 2>&1 || true; }
[ -n "${KEEP:-}" ] || trap down EXIT
command -v docker >/dev/null && docker info >/dev/null 2>&1 || die "docker is not running"

helm template agentic-os "$CHART" -n agentic-os > "$W/rendered.yaml" 2>"$W/helm.err" || { cat "$W/helm.err"; die "helm template failed (helm dependency build first?)"; }
IMAGE=${LITELLM_IMAGE:-$(node -e '
const y=require(process.argv[2]);const d=y.loadAll(require("fs").readFileSync(process.argv[1],"utf8")).filter(Boolean)
 .find(x=>x.kind==="Deployment"&&/-litellm$/.test(x.metadata.name));console.log(d.spec.template.spec.containers[0].image)' "$W/rendered.yaml" "$REPO/os-ui/node_modules/js-yaml")}
echo "gateway image: $IMAGE"

down
docker run -d --name rbgw -p 127.0.0.1:$PORT:4000 --add-host host.docker.internal:host-gateway \
  -e LITELLM_MASTER_KEY=sk-test-scoped-agent-key -e STUB_API_BASE=http://host.docker.internal:$STUB_PORT/v1 \
  -v "$REPO/tests/reasoning-budget/litellm-config.yaml":/app/config.yaml:ro \
  "$IMAGE" --config /app/config.yaml --port 4000 >/dev/null
ok=
for i in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:$PORT/health/liveliness" >/dev/null 2>&1; then ok=1; break; fi
  sleep 3
done
[ -n "$ok" ] || die "the gateway did not become ready"

cd "$REPO/os-ui"
REASONING_E2E=1 REASONING_E2E_URL=http://127.0.0.1:$PORT REASONING_STUB_PORT=$STUB_PORT \
  node --experimental-test-module-mocks --import ./scripts/test-setup.mjs --test --test-concurrency=1 \
  core/runtime/reasoning-budget.e2e.test.ts || die "the e2e test failed"
echo "REASONING_BUDGET_TEST_PASSED"
