#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# LiteLLM: restrict ingress to OS components (defence in depth) — the chart check and its
# negative twins. scripts/check-litellm-ingress-policy.mjs must PASS on the chart as committed and
# FAIL on a copy of the chart whose policy is wrong in each way that matters:
#   a. an extra peer (a component that does not call the gateway, here query-tool);
#   b. a missing caller (os-ui-worker removed);
#   c. a podSelector that no longer selects the gateway pods;
#   d. a namespaceSelector admitted on a default install (agent-built apps' namespace).
# Needs helm and the subchart .tgz files (helm dependency build charts/sovereign-agentic-os).
set -euo pipefail
cd "$(dirname "$0")/../.."
CHECK=scripts/check-litellm-ingress-policy.mjs
TPL=templates/base/network/litellm-ingress-policy.yaml
fail() { echo "FAIL: $*" >&2; exit 1; }

out=$(node "$CHECK" 2>&1) || fail "the check fails on the committed chart: $out"
grep -q 'check-litellm-ingress-policy: ok' <<<"$out" || fail "the check did not run (skipped?): $out"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
twin() { # twin <label> <expected message regex> <python mutation of the template text `s`>
  local label=$1 want=$2 mutation=$3
  rm -rf "$WORK/chart" && cp -R charts/sovereign-agentic-os "$WORK/chart"
  python3 - "$WORK/chart/$TPL" "$mutation" <<'PY'
import sys
p, code = sys.argv[1], sys.argv[2]
s = open(p).read()
before = s
s = eval(code)
assert s != before, 'mutation changed nothing'
open(p, 'w').write(s)
PY
  if out=$(CHART_DIR="$WORK/chart" node "$CHECK" 2>&1); then fail "twin $label: the check passed a broken policy"; fi
  grep -Eq "$want" <<<"$out" || fail "twin $label: failed for the wrong reason: $out"
  echo "litellm-ingress-policy: twin $label refused as expected"
}

twin "a (extra peer)" 'peers are \[.*query-tool' \
  "s.replace('              app.kubernetes.io/component: os-ui-worker\n', '              app.kubernetes.io/component: os-ui-worker\n        - podSelector:\n            matchLabels:\n              app.kubernetes.io/component: query-tool\n', 1)"
twin "b (missing caller)" 'os-ui-worker.*not admitted|peers are \[' \
  "s.replace('        - podSelector:\n            matchLabels:\n              app.kubernetes.io/component: os-ui-worker\n', '', 1)"
twin "c (selects nothing)" 'does not select the LiteLLM proxy pods' \
  "s.replace('  podSelector:\n    matchLabels:\n      app.kubernetes.io/name: litellm\n', '  podSelector:\n    matchLabels:\n      app.kubernetes.io/name: litellm-gateway\n', 1)"
twin "d (another namespace)" 'admit no namespaceSelector' \
  "s.replace('      ports:\n        - { protocol: TCP, port: {{ \$port }} }\n', '        - namespaceSelector:\n            matchLabels:\n              kubernetes.io/metadata.name: agentic-apps\n      ports:\n        - { protocol: TCP, port: {{ \$port }} }\n', 1)"
echo "litellm-ingress-policy: ok — the check passes the committed chart and refuses all four broken twins"
