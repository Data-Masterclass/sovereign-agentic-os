#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# langfuse-oss/run.sh — parity of OUR Langfuse images (images/extensions/langfuse-oss) with upstream, for
# what the OS uses, plus migration parity.
# =============================================================================
#   OSS_WEB=langfuse-oss-web:local OSS_WORKER=langfuse-oss-worker:local bash scripts/tests/langfuse-oss/run.sh
#
# For each of the two image pairs it starts scripts/tests/langfuse-oss/compose.yaml on fresh backends,
# runs probe.mjs (health, ingestion API, OTel endpoint, traces, observations, metrics, scores, prompts,
# projects, the trace UI behind the NextAuth sign-in), for langfuse-oss also the console through the os-ui
# proxy (os-ui/core/infra/tool-proxy-langfuse.int.test.ts; needs os-ui/node_modules), and reads back what
# the migrations produced:
# the Postgres `_prisma_migrations` rows and the ClickHouse `schema_migrations` version.
#   langfuse-oss  at the base path /tools/langfuse (how it is built);
#   upstream      langfuse/langfuse(-worker):3.194.1 by digest, at the site root.
# PASS when every probe passes on both, the two result sets are identical, and the migrations match.
# The Enterprise Edition endpoints are printed, not compared (expected: 403 in langfuse-oss).
# Env: OSS_WEB, OSS_WORKER (required); UP_WEB, UP_WORKER (default: the upstream digests); LF_PORT.
set -uo pipefail
cd "$(dirname "$0")/../../.." || exit 2
HERE=scripts/tests/langfuse-oss
: "${OSS_WEB:?set OSS_WEB}" "${OSS_WORKER:?set OSS_WORKER}"
UP_WEB=${UP_WEB:-langfuse/langfuse:3.194.1@sha256:571446cb16a5d66707f094e638bb156cb9cebaa992d76a7213d2150ce9e1ee18}
UP_WORKER=${UP_WORKER:-langfuse/langfuse-worker:3.194.1@sha256:90df7fbd475abd66b1a9a2e10c99f542a94670a6fc898ddd5809ac3147e601f8}
export LF_PORT=${LF_PORT:-13041}
OUT=$(mktemp -d)
rc=0

one() { # <label> <web> <worker> <base path>
  local label=$1 proj="lfparity-$1"
  export LF_WEB_IMAGE=$2 LF_WORKER_IMAGE=$3 LF_BASE_PATH=$4
  echo "== $label: $2 + $3 (base path '${4:-/}')"
  docker compose -f "$HERE/compose.yaml" -p "$proj" up -d --wait --wait-timeout 600 >"$OUT/$label.up" 2>&1 \
    || { tail -30 "$OUT/$label.up"; docker compose -f "$HERE/compose.yaml" -p "$proj" logs --tail 80 langfuse-web langfuse-worker; rc=1; }
  node "$HERE/probe.mjs" "http://127.0.0.1:$LF_PORT$4" "$label" | tee "$OUT/$label.probe" || rc=1
  # langfuse-oss only: the console through the os-ui proxy itself (core/infra/tool-proxy-langfuse.int.test.ts)
  if [ -n "$4" ]; then
    if [ -d os-ui/node_modules ]; then
      (cd os-ui && LANGFUSE_OSS_PROXY_URL="http://127.0.0.1:$LF_PORT" node --experimental-test-module-mocks --import ./scripts/test-setup.mjs \
        --test core/infra/tool-proxy-langfuse.int.test.ts) > "$OUT/proxy.txt" 2>&1 && echo "ok   os-ui proxy: $(grep -E '^ℹ pass' "$OUT/proxy.txt")" \
        || { echo "FAIL os-ui proxy"; tail -40 "$OUT/proxy.txt"; rc=1; }
    else
      echo "FAIL os-ui proxy: os-ui/node_modules missing (npm ci in os-ui)"; rc=1
    fi
  fi
  # migration facts
  docker compose -f "$HERE/compose.yaml" -p "$proj" exec -T postgres psql -U postgres -tAc \
    "select count(*)||' '||max(migration_name) from _prisma_migrations where finished_at is not null" > "$OUT/$label.pg" 2>&1
  docker compose -f "$HERE/compose.yaml" -p "$proj" exec -T clickhouse clickhouse-client -u clickhouse --password clickhouse -q \
    "SELECT max(version), countIf(dirty) FROM schema_migrations" > "$OUT/$label.ch" 2>&1
  echo "postgres migrations: $(cat "$OUT/$label.pg") | clickhouse schema_migrations (version dirty): $(cat "$OUT/$label.ch")"
  # the worker registers no EE queue consumer
  docker compose -f "$HERE/compose.yaml" -p "$proj" logs langfuse-worker > "$OUT/$label.worker.log" 2>&1
  docker compose -f "$HERE/compose.yaml" -p "$proj" down -v >/dev/null 2>&1
}

one langfuse-oss "$OSS_WEB" "$OSS_WORKER" /tools/langfuse
one upstream "$UP_WEB" "$UP_WORKER" ""

echo "== comparison"
a=$(grep '^RESULT ' "$OUT/langfuse-oss.probe" | sed 's/^RESULT //' | python3 -c 'import sys,json; print(json.dumps(json.load(sys.stdin)["results"], sort_keys=True))' 2>/dev/null)
b=$(grep '^RESULT ' "$OUT/upstream.probe" | sed 's/^RESULT //' | python3 -c 'import sys,json; print(json.dumps(json.load(sys.stdin)["results"], sort_keys=True))' 2>/dev/null)
if [ -n "$a" ] && [ "$a" = "$b" ]; then echo "ok   probe results identical ($(grep -c '^ok ' "$OUT/langfuse-oss.probe") checks)"; else echo "FAIL probe results differ"; echo " oss: $a"; echo " up:  $b"; rc=1; fi
if [ -s "$OUT/langfuse-oss.pg" ] && cmp -s "$OUT/langfuse-oss.pg" "$OUT/upstream.pg"; then echo "ok   Postgres migrations identical: $(cat "$OUT/langfuse-oss.pg")"; else echo "FAIL Postgres migrations differ"; rc=1; fi
if [ -s "$OUT/langfuse-oss.ch" ] && cmp -s "$OUT/langfuse-oss.ch" "$OUT/upstream.ch"; then echo "ok   ClickHouse migrations identical: $(cat "$OUT/langfuse-oss.ch")"; else echo "FAIL ClickHouse migrations differ"; rc=1; fi
if grep -qiE 'data.?retention|cloud.?usage|spend.?alert|usage.?threshold|metering' "$OUT/langfuse-oss.worker.log"; then
  echo "info langfuse-oss worker log mentions an EE queue:"; grep -iE 'data.?retention|cloud.?usage|spend.?alert|usage.?threshold|metering' "$OUT/langfuse-oss.worker.log" | head -5
fi
if grep -q 'OssUnavailableError' "$OUT/langfuse-oss.worker.log"; then echo "FAIL an EE stub ran in the worker"; rc=1; else echo "ok   no EE stub ran in the langfuse-oss worker"; fi
echo "EE endpoints (informational): oss $(grep '^RESULT ' "$OUT/langfuse-oss.probe" | sed 's/.*"ee"://') | upstream $(grep '^RESULT ' "$OUT/upstream.probe" | sed 's/.*"ee"://')"
rm -rf "$OUT"
[ "$rc" -eq 0 ] && echo "LANGFUSE_OSS_PARITY_OK" || echo "LANGFUSE_OSS_PARITY_FAIL"
exit "$rc"
