#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# docling-live.sh — run the live Docling test against the REAL derived image.
# =============================================================================
#   bash scripts/tests/docling-live.sh                 # builds images/extensions/docling first
#   DOCLING_LIVE_IMAGE=<ref> bash scripts/tests/docling-live.sh   # use an already-built image
#
# Starts the image with the SAME docling-serve settings the chart renders (limits, one worker,
# version info, an API key), waits for `/ready` (503 until the models are loaded), then runs
# os-ui/tabs/files/lib/ingest/docling-live.ci.test.ts with DOCLING_LIVE_REQUIRED=1, so the test
# cannot pass by skipping. The settings are read from the rendered chart when helm is present,
# so this test and the deployment cannot drift apart.
set -euo pipefail
cd "$(dirname "$0")/../.."

IMAGE=${DOCLING_LIVE_IMAGE:-}
if [ -z "$IMAGE" ]; then
  IMAGE=sovereign-os/docling:live-test
  docker build -t "$IMAGE" images/extensions/docling
fi
NAME=docling-live-$$
PORT=${DOCLING_LIVE_PORT:-15001}
KEY=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')

# The chart's docling env (minus the key, which comes from a Secret), as `-e NAME=VALUE`.
envargs=()
if command -v helm >/dev/null 2>&1 && ls charts/sovereign-agentic-os/charts/*.tgz >/dev/null 2>&1; then
  while IFS= read -r kv; do envargs+=(-e "$kv"); done < <(
    helm template t charts/sovereign-agentic-os -n agentic-os --show-only templates/extensions/docling/docling.yaml \
      | python3 -c '
import sys, yaml
for d in yaml.safe_load_all(sys.stdin):
    if d and d["kind"] == "Deployment":
        for e in d["spec"]["template"]["spec"]["containers"][0]["env"]:
            if "value" in e: print(e["name"] + "=" + str(e["value"]))
')
else
  [ -n "${CI:-}" ] && { echo "docling-live: helm + chart dependencies are required in CI" >&2; exit 1; }
  envargs=(-e DOCLING_SERVE_MAX_FILE_SIZE=52428800 -e DOCLING_SERVE_MAX_NUM_PAGES=400
           -e DOCLING_SERVE_MAX_DOCUMENT_TIMEOUT=900 -e DOCLING_SERVE_RESULT_REMOVAL_DELAY=600
           -e DOCLING_SERVE_ENG_LOC_NUM_WORKERS=1 -e DOCLING_SERVE_SHOW_VERSION_INFO=true)
fi
echo "docling-live: env ${envargs[*]}"

# The chart's memory limit (docling.resources.limits.memory, 4Gi) is enforced on the container, so
# an OOM here fails the run exactly as it would kill the pod. Peak usage is sampled every second.
MEM=${DOCLING_LIVE_MEMORY:-4g}
PEAK_FILE=$(mktemp)
cleanup() {
  [ -n "${SAMPLER:-}" ] && kill "$SAMPLER" 2>/dev/null
  docker logs "$NAME" > "${DOCLING_LIVE_LOG:-/dev/null}" 2>&1 || true
  echo "docling-live: OOMKilled=$(docker inspect -f '{{.State.OOMKilled}}' "$NAME" 2>/dev/null || echo '?')"
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  echo "docling-live: peak memory $(sort -n "$PEAK_FILE" | tail -1 | awk '{printf "%.0f MiB", $1/1048576}') of limit $MEM"
  rm -f "$PEAK_FILE"
}
trap cleanup EXIT
started=$(date +%s)
docker run -d --name "$NAME" --memory "$MEM" --memory-swap "$MEM" -p "127.0.0.1:$PORT:5001" "${envargs[@]}" -e "DOCLING_SERVE_API_KEY=$KEY" "$IMAGE" >/dev/null
( while sleep 1; do
    docker stats --no-stream --format '{{.MemUsage}}' "$NAME" 2>/dev/null | awk '{ v=$1; u=v; gsub(/[0-9.]/,"",u); n=v; gsub(/[^0-9.]/,"",n);
        m = (u=="GiB")?1073741824:(u=="MiB")?1048576:(u=="KiB")?1024:1; printf "%.0f\n", n*m }' >> "$PEAK_FILE" || break
  done ) &
SAMPLER=$!

for _ in $(seq 1 180); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/ready" || true)
  [ "$code" = 200 ] && break
  sleep 2
done
[ "$code" = 200 ] || { docker logs "$NAME" | tail -50; echo "docling-live: /ready never answered 200" >&2; exit 1; }
echo "docling-live: /ready answered 200 after $(( $(date +%s) - started ))s (boot loads the default-preset models)"

cd os-ui
DOCLING_LIVE_URL="http://127.0.0.1:$PORT" DOCLING_LIVE_API_KEY="$KEY" DOCLING_LIVE_IMAGE="$IMAGE" DOCLING_LIVE_CONTAINER="$NAME" DOCLING_LIVE_REQUIRED=1 \
  node --experimental-test-module-mocks --import ./scripts/test-setup.mjs --test --test-concurrency=1 \
  tabs/files/lib/ingest/docling-live.ci.test.ts
