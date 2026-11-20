#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Negative twin of scripts/check-opensearch-client.mjs (WP-21): a caller that bypasses the one
# OpenSearch client must fail the check, and the client module itself must not.
set -euo pipefail
cd "$(dirname "$0")/../.."
FIX=scripts/tests/fixtures/opensearch-bypass
if out=$(node scripts/check-opensearch-client.mjs --root "$FIX" 2>&1); then
  echo "FAIL: the check passed on a tree with a bypassing caller"; echo "$out"; exit 1
fi
grep -q 'tabs/x/bypass.ts:4' <<<"$out" || { echo "FAIL: the bypass was not reported by file:line"; echo "$out"; exit 1; }
if grep -q 'core/adapters/opensearch/client.ts' <<<"$(grep '^  - ' <<<"$out")"; then
  echo "FAIL: the client module itself was flagged"; echo "$out"; exit 1
fi
echo "check-opensearch-client negative twin: ok (bypass flagged, client allowed)"
