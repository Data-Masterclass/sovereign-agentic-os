#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# run.sh — run the harness self-test, then journeys AT-a … AT-f, and render the report.
#
#   tests/e2e/kind/run.sh [file-glob]      default: selftest + every journey
#
# Output: $E2E_REPORT_DIR (default tests/e2e/kind/report/) holds results.jsonl, report.json and
# report.md (one row per assertion and twin, with the hop and the reason it is red).
# Exit status is node --test's: 0 when every self-test is green and every expected-fail is red
# (or green without a marker); non-zero on a broken self-test or an unexpected green.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
export E2E_CLUSTER=${E2E_CLUSTER:-wp02}
export E2E_REPORT_DIR=${E2E_REPORT_DIR:-$HERE/report}
mkdir -p "$E2E_REPORT_DIR"
: > "$E2E_REPORT_DIR/results.jsonl"
cd "$HERE" || exit 2
if [ "$#" -gt 0 ]; then files=("$@"); else files=(selftest/harness.e2e.mjs journeys/journey-*.e2e.mjs); fi

# A REAL cluster (E2E_KUBE_CONTEXT, the dev environment) must pass the same env guard as a deploy:
# the marker kube-public/sovereign-os-environment=dev, never the production context or server.
if [ -n "${E2E_KUBE_CONTEXT:-}" ]; then
  bash "$HERE/../../../scripts/lib/env-guard.sh" --env dev --context "$E2E_KUBE_CONTEXT" \
    || { echo "E2E_REFUSED: $E2E_KUBE_CONTEXT is not the marked dev cluster"; exit 1; }
fi

# Journeys that drive the scriptable model stub (lib/records/stub.mjs, /__stub/*) need the stub
# image that only the kind cluster has. Off kind, and unless E2E_MODEL_STUB=1 says the stub is
# deployed, they are SKIPPED with that reason (listed in the report), not run to a meaningless red.
: > "$E2E_REPORT_DIR/skipped.jsonl"
if [ -n "${E2E_KUBE_CONTEXT:-}" ] && [ "${E2E_MODEL_STUB:-}" != 1 ]; then
  kept=()
  for f in "${files[@]}"; do
    for g in $f; do
      if grep -q "records/stub.mjs" "$g" 2>/dev/null; then
        printf '{"file": "%s", "reason": "needs the kind-only scriptable model stub (/__stub); not deployed on %s"}\n' "$g" "$E2E_KUBE_CONTEXT" >> "$E2E_REPORT_DIR/skipped.jsonl"
        echo "skip $g: needs the kind-only model stub"
      else
        kept+=("$g")
      fi
    done
  done
  files=("${kept[@]+"${kept[@]}"}")
fi
if [ "${#files[@]}" -eq 0 ]; then
  echo "no journey to run"
  node "$HERE/lib/render-report.mjs" "$E2E_REPORT_DIR"
  exit 0
fi
# One file at a time: journeys share the cluster and AT-f scales os-ui down.
node --test --test-concurrency=1 --test-reporter=spec "${files[@]}"
status=$?
node "$HERE/lib/render-report.mjs" "$E2E_REPORT_DIR"
exit $status
