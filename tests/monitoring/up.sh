#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Monitoring panels: the real components the panel adapters read, each on the image the chart (or
# the Dagster image) pins — VictoriaMetrics, VictoriaLogs, Postgres 17 (the agent run store) and
# dagster-webserver 1.13.31 over a tiny code location (tests/monitoring/dagster/defs.py).
#   up.sh        start (ports 127.0.0.1: VM 18529, VL 19529, PG 15532, Dagster 13570, OpenSearch 19200; env MON_PREFIX, MON_*_PORT override)
#   up.sh down   remove everything
# Run the tests with MON_IT=1 (os-ui/tabs/monitoring/lib/panels/*.int.test.ts).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
chart="$repo/charts/sovereign-agentic-os"
# MON_PREFIX / MON_*_PORT let a second harness run beside the first (defaults are the CI values).
p=${MON_PREFIX:-monit}
net=$p-net
VM_PORT=${MON_VM_PORT:-18529}; VL_PORT=${MON_VL_PORT:-19529}; PG_PORT=${MON_PG_PORT:-15532}; DAGSTER_PORT=${MON_DAGSTER_PORT:-13570}; OS_PORT=${MON_OS_PORT:-19200}
# The os-ui stand-in the drive-sync proof hosts on the host (the Dagster job calls it).
OSUI_PORT=${MON_OSUI_PORT:-18700}
if [ "${1:-}" = down ]; then
  docker rm -f $p-vm $p-vl $p-pg $p-dagster $p-os >/dev/null 2>&1 || true
  docker network rm $net >/dev/null 2>&1 || true
  exit 0
fi
img() { python3 -c "import yaml,sys; v=yaml.safe_load(open('$chart/values.yaml'))
for k in sys.argv[1].split('.'): v=v[k]
print(v['repository']+':'+str(v['tag'])+('@'+v['digest'] if v.get('digest') else ''))" "$1"; }
VM=$(img observability.victoriaMetrics.image)
VL=$(img observability.victoriaLogs.image)
PG=$(img postgres.image)
# OpenSearch: the base image of the one the chart ships (images/extensions/opensearch/Dockerfile).
OS=$(sed -n 's/^FROM \(opensearchproject\/opensearch:[^ ]*\).*/\1/p' "$repo/images/extensions/opensearch/Dockerfile" | head -1)
# The Dagster version the OS image pins (images/extensions/dagster/Dockerfile), read from it.
DAGSTER_V=$(sed -n 's/.*"dagster==\([0-9.]*\)".*/\1/p' "$repo/images/extensions/dagster/Dockerfile" | head -1)
PY=$(sed -n 's/^FROM \(python:[^ ]*\).*/\1/p' "$repo/images/extensions/dagster/Dockerfile" | head -1)

docker network create $net >/dev/null 2>&1 || true
docker rm -f $p-vm $p-vl $p-pg $p-dagster $p-os >/dev/null 2>&1 || true
docker run -d --name $p-vm --network $net -p 127.0.0.1:$VM_PORT:8428 "$VM" -search.latencyOffset=0s >/dev/null
docker run -d --name $p-vl --network $net -p 127.0.0.1:$VL_PORT:9428 "$VL" >/dev/null
docker run -d --name $p-pg --network $net -e PGDATA=/tmp/pgdata -e POSTGRES_PASSWORD=monit-not-a-secret -p 127.0.0.1:$PG_PORT:5432 "$PG" >/dev/null
docker run -d --name $p-os --network $net -e discovery.type=single-node -e DISABLE_SECURITY_PLUGIN=true -e DISABLE_INSTALL_DEMO_CONFIG=true -e OPENSEARCH_JAVA_OPTS='-Xms512m -Xmx512m' -p 127.0.0.1:$OS_PORT:9200 "$OS" >/dev/null
# Dagster: pip-install the pinned webserver into the image's own Python base, materialize the
# fixture runs with the Dagster CLI, then serve GraphQL. SQLite storage under DAGSTER_HOME.
# The scheduled Drive sync is the OS's own job (images/extensions/dagster/os_files_sync.py), mounted as is;
# it calls the os-ui stand-in on the host with the run token below (a stand-in for the projected
# ServiceAccount token — the TokenReview itself is not part of this harness). The webserver runs without
# the daemon, so runs are launched directly (DefaultRunCoordinator) instead of waiting in the queue.
docker run -d --name $p-dagster --network $net --add-host host.docker.internal:host-gateway -p 127.0.0.1:$DAGSTER_PORT:3000 \
  -v "$here/dagster:/fx:ro" -v "$repo/images/extensions/dagster/os_files_sync.py:/osx/os_files_sync.py:ro" \
  -e DAGSTER_HOME=/tmp/dh -e OS_UI_URL=http://host.docker.internal:$OSUI_PORT -e OS_RUN_TOKEN_FILE=/tmp/os-run-token "$PY" sh -c "
    set -e; mkdir -p /tmp/dh; echo harness-run-token-not-a-secret > /tmp/os-run-token; printf 'run_coordinator:\\n  module: dagster.core.run_coordinator\\n  class: DefaultRunCoordinator\\n' > /tmp/dh/dagster.yaml; pip install -q --no-cache-dir dagster==$DAGSTER_V dagster-webserver==$DAGSTER_V >/tmp/pip.log 2>&1
    cd /fx && python /fx/seed.py
    exec dagster-webserver -h 0.0.0.0 -p 3000 -f /fx/defs.py" >/dev/null

wait_for() { for _ in $(seq 1 "${3:-150}"); do curl -fsS -o /dev/null "$1" && return 0; sleep 2; done; echo "not up: $1" >&2; docker logs --tail 40 "$2" >&2; return 1; }
wait_for http://127.0.0.1:$VM_PORT/health $p-vm
wait_for http://127.0.0.1:$VL_PORT/health $p-vl
wait_for http://127.0.0.1:$OS_PORT/_cluster/health $p-os 90
for _ in $(seq 1 60); do docker exec $p-pg pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
wait_for http://127.0.0.1:$DAGSTER_PORT/server_info $p-dagster 300
echo "monitoring harness up (dagster $DAGSTER_V)"
