#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# The query-tool pin: outside the local profile the chart REFUSES a tag without a digest (a missing
# or re-pushed image must fail the render, never the rollout). Twins: the STACKIT overlay with its
# digest renders; the same overlay with a bare tag, or an empty one, does not.
set -euo pipefail
cd "$(dirname "$0")/../.."
C=charts/sovereign-agentic-os
fails=0
ok()  { if helm template x "$C" --skip-schema-validation "$@" >/dev/null 2>&1; then echo "ok   renders: $*"; else echo "FAIL should render: $*"; fails=$((fails+1)); fi; }
bad() { if out=$(helm template x "$C" --skip-schema-validation "$@" 2>&1); then echo "FAIL should refuse: $*"; fails=$((fails+1)); elif grep -q "must pin a digest" <<<"$out"; then echo "ok   refused: $*"; else echo "FAIL refused for another reason: $*"; fails=$((fails+1)); fi; }
ok                                   # local profile: a local build, tag only
ok -f values.stackit-managed.yaml    # the overlay's pin carries a digest
bad -f values.stackit-managed.yaml --set queryTool.image.tag=0.6.3
bad -f values.stackit-managed.yaml --set-string queryTool.image.tag=
bad -f values.stackit-managed.yaml --set 'queryTool.image.tag=0.6.3@sha256:short'
[ "$fails" = 0 ] || { echo "query-tool-pin.test.sh: $fails failed"; exit 1; }
echo "query-tool-pin.test.sh: all checks passed"
