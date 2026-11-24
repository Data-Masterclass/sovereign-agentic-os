#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# WP-05 / WP-32: the Collector's LiteLLM orphan-span filter, on the real LiteLLM 1.109.1.
#   LiteLLM (langfuse_otel, span scope `full`, a real Postgres so its background jobs run)
#     -> the CHART-RENDERED Collector (observability.collector.litellmLangfuse.enabled=true)
#     -> a sink that requires LiteLLM's Langfuse Basic credentials and writes spans to a file.
# Mode `on`  (dropOrphanSpans=true):  idle poll spans must be dropped; a real generation must pass.
# Mode `off` (dropOrphanSpans=false): the NEGATIVE TWIN — the idle poll spans must arrive.
#   run.sh <on|off>        run.sh down
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
chart="$repo/charts/sovereign-agentic-os"
mode="${1:-on}"
net=wp05-ll; p=wp05ll
down() { docker rm -f $p-litellm $p-pg $p-collector $p-sink >/dev/null 2>&1 || true; docker network rm $net >/dev/null 2>&1 || true; }
if [ "$mode" = down ]; then down; exit 0; fi
[ "$mode" = on ] && drop=true || drop=false
down
work="$here/.work"
mkdir -p "$work/out" && chmod 777 "$work/out" && : > "$work/out/spans.jsonl" && chmod 666 "$work/out/spans.jsonl"

val() { python3 -c "import yaml,sys; v=yaml.safe_load(open('$chart/values.yaml'))
for k in sys.argv[1].split('.'): v=v[k]
print(v)" "$1"; }
# The chart's own gateway image (litellm-oss since 2026-11-24), unless LITELLM_IMAGE overrides it.
LITELLM_IMAGE="${LITELLM_IMAGE:-$(val litellm.image.repository):$(val litellm.image.tag)}"
COL="$(val observability.collector.image.repository):$(val observability.collector.image.tag)@$(val observability.collector.image.digest)"
PG="$(val postgres.image.repository):$(val postgres.image.tag)@$(val postgres.image.digest)"

helm template agentic-os "$chart" --show-only templates/extensions/observability/otel-collector.yaml \
  --set observability.collector.kubeletStats.enabled=false --set observability.collector.podLogs.enabled=false \
  --set observability.collector.litellmLangfuse.enabled=true --set observability.collector.litellmLangfuse.dropOrphanSpans=$drop \
  --set observability.collector.litellmLangfuse.langfuseEndpoint=http://langfuse-sink:4318 2>/dev/null \
  | python3 -c "import sys,yaml
for d in yaml.safe_load_all(sys.stdin):
  if d and d['kind']=='ConfigMap': open('$work/collector.yaml','w').write(d['data']['config.yaml'])"
grep -q "filter/litellm_orphan_spans" "$work/collector.yaml" && echo "collector: filter ON" || echo "collector: filter OFF"

docker network create $net >/dev/null
docker run -d --name $p-sink --network $net --network-alias langfuse-sink -v "$here/sink.yaml:/conf/sink.yaml:ro" -v "$work/out:/out" "$COL" --config=/conf/sink.yaml >/dev/null
docker run -d --name $p-collector --network $net --network-alias otel-collector -p 127.0.0.1:18890:8888 -e K8S_NODE_NAME=filter-it -v "$work/collector.yaml:/conf/config.yaml:ro" "$COL" --config=/conf/config.yaml >/dev/null
docker run -d --name $p-pg --network $net -e PGDATA=/tmp/pgdata -e POSTGRES_PASSWORD=filter-it-not-a-secret -e POSTGRES_DB=litellm "$PG" >/dev/null
for _ in $(seq 1 60); do docker exec $p-pg pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
# The env WP-32 ships (litellm.envVars on wp32/litellm-otel), plus the Collector as LiteLLM's
# Langfuse OTel host — the documented way to put a collector in front of Langfuse.
docker run -d --name $p-litellm --network $net -p 127.0.0.1:14000:4000 \
  -e DATABASE_URL=postgresql://postgres:filter-it-not-a-secret@$p-pg:5432/litellm \
  -e PROXY_MASTER_KEY=sk-filter-it-not-a-secret \
  -e LITELLM_OTEL_V2=true -e LITELLM_OTEL_LANGFUSE_SPAN_SCOPE=full \
  -e LITELLM_OTEL_BAGGAGE_PROMOTED_KEYS=litellm.team.id,litellm.team.alias,litellm.team.metadata,litellm.api_key.hash \
  -e LANGFUSE_OTEL_HOST=http://otel-collector:4319 \
  -e LANGFUSE_PUBLIC_KEY=pk-lf-filter-it -e LANGFUSE_SECRET_KEY=sk-lf-filter-it-not-a-secret \
  -v "$here/litellm-config.yaml:/app/config.yaml:ro" "$LITELLM_IMAGE" --config /app/config.yaml --port 4000 >/dev/null
# Ready = the proxy answers AND its database is connected (its background jobs need it).
for _ in $(seq 1 300); do curl -fsS http://127.0.0.1:14000/health/readiness 2>/dev/null | grep -q '"db":"connected"' && break; sleep 2; done
curl -fsS http://127.0.0.1:14000/health/readiness | grep -q '"db":"connected"' || { docker logs --tail 60 $p-litellm >&2; exit 1; }
echo "litellm ready; filter mode=$mode"
FILTER_IT=1 FILTER_MODE=$mode FILTER_SPANS="$work/out/spans.jsonl" node --test --test-concurrency=1 "$here/filter.int.test.mjs"
