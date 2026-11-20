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
cd "$HERE"
if [ "$#" -gt 0 ]; then files=("$@"); else files=(selftest/harness.e2e.mjs journeys/journey-*.e2e.mjs); fi
# One file at a time: journeys share the cluster and AT-f scales os-ui down.
node --test --test-concurrency=1 --test-reporter=spec "${files[@]}"
status=$?
node "$HERE/lib/render-report.mjs" "$E2E_REPORT_DIR"
exit $status
