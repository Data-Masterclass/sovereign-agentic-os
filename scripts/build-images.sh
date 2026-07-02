#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# Build + load the bespoke Sovereign OS images into the kind cluster.
# Idempotent; safe to re-run. Usage: ./scripts/build-images.sh [kind-cluster-name]
set -euo pipefail
CLUSTER="${1:-agentic-os}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# dir:tag (build context = images/<dir> unless noted)
IMAGES="
mock-model:0.1.1
sample-agent:0.1.0
agent-runtime:0.1.1
poet-agent:0.1.0
haystack-retriever:0.1.0
dbt:0.2.0
egress-proxy:0.1.0
web-fetch:0.1.0
query-tool:0.3.0
sandbox-duckdb:0.1.0
superset:6.1.0
mlflow:2.19.0
ml-agent:0.1.0
terminal-broker:0.1.0
sandbox-shell:0.1.0
workbench-broker:0.1.0
code-server-workbench:0.1.0
"

build_one() {
  local dir="$1" tag="$2" img="sovereign-os/$1:$2"
  echo "==> building $img"
  docker build -q -t "$img" "images/$dir" >/dev/null
  kind load docker-image "$img" --name "$CLUSTER" >/dev/null 2>&1 || true
}

for entry in $IMAGES; do
  build_one "${entry%%:*}" "${entry##*:}"
done

# Dagster needs the images/ dir as context (it COPYs dagster/ + dbt/).
echo "==> building sovereign-os/dagster:0.2.0 (context=images/)"
docker build -q -f images/dagster/Dockerfile -t sovereign-os/dagster:0.2.0 images/ >/dev/null
kind load docker-image sovereign-os/dagster:0.2.0 --name "$CLUSTER" >/dev/null 2>&1 || true

# OS UI needs the repo root as context (it COPYs os-ui/ + bakes in docs/components
# for the native Components surface). The standalone admin-console image is
# DEPRECATED — its functionality now lives natively in the OS UI; build it only
# if you explicitly want the legacy standalone service.
echo "==> building sovereign-os/os-ui:0.1.0 (context=repo root)"
docker build -q -t sovereign-os/os-ui:0.1.0 -f images/os-ui/Dockerfile . >/dev/null
kind load docker-image sovereign-os/os-ui:0.1.0 --name "$CLUSTER" >/dev/null 2>&1 || true

echo "All images built and loaded into kind cluster '$CLUSTER'."
