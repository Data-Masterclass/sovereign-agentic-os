#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# WP-05: real component containers for os-ui's health() adapters (os-ui/core/adapters/health/
# health.int.test.ts), each on the image the chart pins, so "version equals the container's" is
# checked against the chart's own pin:
#   Trino, OpenSearch, OPA, Postgres, VictoriaMetrics, VictoriaLogs and the chart-rendered
#   OpenTelemetry Collector (its config from `helm template`, the node-local receivers off).
# Writes tests/observability/.health-it.json: { <id>: { url, expected, container } }.
#   health-up.sh        start      health-up.sh down   remove everything
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
chart="$repo/charts/sovereign-agentic-os"
net=wp05-health
p=wp05h
if [ "${1:-}" = down ]; then
  docker rm -f $p-trino $p-opensearch $p-pg $p-opa $p-vm $p-vl $p-collector >/dev/null 2>&1 || true
  docker network rm $net >/dev/null 2>&1 || true
  rm -f "$here/.health-it.json"; exit 0
fi

val() { python3 -c "import yaml,sys; v=yaml.safe_load(open('$chart/values.yaml'))
for k in sys.argv[1].split('.'): v=v[k]
print(v)" "$1"; }
img() { local r t d; r=$(val "$1.repository"); t=$(val "$1.tag"); d=$(python3 -c "import yaml; v=yaml.safe_load(open('$chart/values.yaml'))
for k in '$1'.split('.'): v=v[k]
print(v.get('digest',''))"); echo "$r:$t${d:+@$d}"; }

TRINO=$(img trino.image); TRINO_V=$(val trino.image.tag)
# The OpenSearch subchart's appVersion is the image tag it runs (charts/opensearch-<v>.tgz).
OS_V=$(ls "$chart/charts" | sed -n 's/^opensearch-\(.*\)\.tgz$/\1/p'); OS=opensearchproject/opensearch:$OS_V
PG=$(img postgres.image); PG_V=$(val postgres.image.tag)
OPA=$(img opa.image); OPA_V=$(val opa.image.tag)
VM=$(img observability.victoriaMetrics.image); VM_V=$(val observability.victoriaMetrics.image.tag)
VL=$(img observability.victoriaLogs.image); VL_V=$(val observability.victoriaLogs.image.tag)
COL=$(img observability.collector.image); COL_V=$(val observability.collector.image.tag)

docker network create $net >/dev/null 2>&1 || true
docker rm -f $p-trino $p-opensearch $p-pg $p-opa $p-vm $p-vl $p-collector >/dev/null 2>&1 || true
docker run -d --name $p-trino --network $net -p 127.0.0.1:18080:8080 --memory 1600m "$TRINO" >/dev/null
docker run -d --name $p-opensearch --network $net -p 127.0.0.1:19200:9200 --memory 1200m \
  -e discovery.type=single-node -e DISABLE_SECURITY_PLUGIN=true -e DISABLE_INSTALL_DEMO_CONFIG=true \
  -e OPENSEARCH_JAVA_OPTS="-Xms512m -Xmx512m" "$OS" >/dev/null
docker run -d --name $p-pg --network $net -p 127.0.0.1:15432:5432 -e POSTGRES_PASSWORD=health-it-not-a-secret "$PG" >/dev/null
docker run -d --name $p-opa --network $net -p 127.0.0.1:18182:8181 "$OPA" run --server --addr=0.0.0.0:8181 >/dev/null
docker run -d --name $p-vm --network $net --network-alias victoria-metrics -p 127.0.0.1:18429:8428 "$VM" >/dev/null
docker run -d --name $p-vl --network $net --network-alias victoria-logs -p 127.0.0.1:19429:9428 "$VL" >/dev/null

cfgdir="$here/.health-it-collector"; mkdir -p "$cfgdir"
helm template agentic-os "$chart" --show-only templates/extensions/observability/otel-collector.yaml \
  --set observability.collector.kubeletStats.enabled=false --set observability.collector.podLogs.enabled=false 2>/dev/null \
  | python3 -c "import sys,yaml
for d in yaml.safe_load_all(sys.stdin):
  if d and d['kind']=='ConfigMap': open('$cfgdir/config.yaml','w').write(d['data']['config.yaml'])"
docker run -d --name $p-collector --network $net -p 127.0.0.1:13134:13133 -p 127.0.0.1:18889:8888 \
  -e K8S_NODE_NAME=health-it -v "$cfgdir/config.yaml:/conf/config.yaml:ro" "$COL" --config=/conf/config.yaml >/dev/null

wait_for() { for _ in $(seq 1 120); do curl -fsS -o /dev/null "$1" && return 0; sleep 2; done; echo "not up: $1" >&2; docker logs --tail 30 "$2" >&2; return 1; }
wait_for http://127.0.0.1:18182/health $p-opa
wait_for http://127.0.0.1:18429/health $p-vm
wait_for http://127.0.0.1:19429/health $p-vl
wait_for http://127.0.0.1:13134/ $p-collector
wait_for http://127.0.0.1:19200/ $p-opensearch
for _ in $(seq 1 120); do curl -fsS http://127.0.0.1:18080/v1/info | grep -q '"starting":false' && break; sleep 2; done
for _ in $(seq 1 60); do docker exec $p-pg pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done

cat > "$here/.health-it.json" <<JSON
{
  "trino":            { "url": "http://127.0.0.1:18080", "expected": "$TRINO_V", "container": "$p-trino" },
  "opensearch":       { "url": "http://127.0.0.1:19200", "expected": "$OS_V", "container": "$p-opensearch" },
  "postgres":         { "url": "postgres://postgres:health-it-not-a-secret@127.0.0.1:15432/postgres", "expected": "$PG_V", "container": "$p-pg" },
  "opa":              { "url": "http://127.0.0.1:18182", "expected": "$OPA_V", "container": "$p-opa" },
  "victoria-metrics": { "url": "http://127.0.0.1:18429", "expected": "$VM_V", "container": "$p-vm" },
  "victoria-logs":    { "url": "http://127.0.0.1:19429", "expected": "$VL_V", "container": "$p-vl" },
  "otel-collector":   { "url": "http://127.0.0.1:13134", "metricsUrl": "http://127.0.0.1:18889", "expected": "$COL_V", "container": "$p-collector" }
}
JSON
echo "health-it stack up: $(tr -d '\n ' < "$here/.health-it.json" | head -c 200)…"
