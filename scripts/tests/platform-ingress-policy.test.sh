#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Platform ingress (default-deny + per-service allowlists) — the chart check and its negative
# twins. scripts/check-platform-ingress-policy.mjs must PASS on the chart as committed and FAIL on
# a copy of the chart that is wrong in each way that matters:
#   a. the default-deny policy is gone;
#   b. a missing caller (the dbt Job no longer admitted to Trino);
#   c. another namespace admitted to Postgres;
#   d. an extra OPA caller (the Dagster code location and its run pods);
#   e. a rule with no `from` on object storage (admits every namespace);
#   f. the Polaris JDBC metastore no longer admitted to Postgres;
#   g. cert-manager's HTTP-01 solver no longer reachable from the ingress controller on :8089;
#   h. the OTel Collector no longer admitted to VictoriaLogs (WP-05: logs would stop under default-deny);
#   i. os-ui no longer admitted to VictoriaMetrics (Monitoring and Platform health would go dark);
#   j. another namespace admitted to the Collector.
# Needs helm, js-yaml (os-ui/node_modules) and the subchart .tgz files.
set -euo pipefail
cd "$(dirname "$0")/../.."
CHECK=scripts/check-platform-ingress-policy.mjs
TPL=templates/base/network/platform-ingress-policies.yaml
fail() { echo "FAIL: $*" >&2; exit 1; }

out=$(node "$CHECK" 2>&1) || fail "the check fails on the committed chart: $out"
grep -q 'check-platform-ingress-policy: OK' <<<"$out" || fail "the check did not run (skipped?): $out"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
twin() { # twin <label> <expected message regex> <python mutation of the template text `s`>
  local label=$1 want=$2 mutation=$3 tpl=${TWIN_TPL:-$TPL}
  rm -rf "$WORK/chart" && cp -R charts/sovereign-agentic-os "$WORK/chart"
  python3 - "$WORK/chart/$tpl" "$mutation" <<'PY'
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
  echo "platform-ingress-policy: twin $label refused as expected"
}

twin "a (no default deny)" 'default-deny-ingress is not rendered' \
  "s.replace('  name: default-deny-ingress', '  name: default-deny-ingress-off', 1)"
twin "b (missing caller)" 'Job dbt-build calls trino:8080 but no ingress policy admits it' \
  "s.replace('(list \"query-tool\" \"dbt\" \"marts-init\")', '(list \"query-tool\" \"marts-init\")', 1)"
twin "f (Polaris metastore missing)" 'Deployment polaris calls pg-rw:5432 but no ingress policy admits it' \
  "s.replace('(list \"polaris\" \"polaris-init\" \"pg-dump\"', '(list \"pg-dump\"', 1)"
twin "g (ACME solver unreachable)" 'HTTP-01 solver pods are not reachable from the ingress controller' \
  "s.replace('        - { protocol: TCP, port: 8089 }', '        - { protocol: TCP, port: 8090 }', 1)"
twin "c (another namespace)" 'postgres-allow-callers: admits another namespace' \
  "s.replace('      ports:\n        - { protocol: TCP, port: 5432 }\n', '        - namespaceSelector:\n            matchLabels:\n              kubernetes.io/metadata.name: agentic-apps\n      ports:\n        - { protocol: TCP, port: 5432 }\n', 1)"
twin "d (extra OPA caller)" 'opa-allow-callers admits .*user-deployments' \
  "s.replace('(list \"web-fetch\" \"trino\" \"opa-reassert-principals\"))', '(list \"web-fetch\" \"trino\" \"opa-reassert-principals\") \"extra\" (list (dict \"component\" \"user-deployments\")))', 1)"
twin "e (no from)" 'object-storage-allow-callers: a rule with no .from.' \
  "s.replace('      ports:\n        - { protocol: TCP, port: 9000 }\n', '    - ports:\n        - { protocol: TCP, port: 9000 }\n', 1)"
OBS=templates/extensions/observability/network-policies.yaml
TWIN_TPL=$OBS twin "h (Collector cut off from VictoriaLogs)" 'DaemonSet otel-collector calls victoria-logs:9428 but no ingress policy admits it' \
  "s.replace('              app.kubernetes.io/component: otel-collector\n        - podSelector:\n            matchLabels:\n              app.kubernetes.io/component: os-ui\n      ports:\n        - { protocol: TCP, port: 9428 }', '              app.kubernetes.io/component: os-ui\n      ports:\n        - { protocol: TCP, port: 9428 }', 1)"
TWIN_TPL=$OBS twin "i (os-ui cut off from VictoriaMetrics)" 'os-ui calls victoria-metrics:8428 but no ingress policy admits it' \
  "s.replace('              app.kubernetes.io/component: os-ui\n      ports:\n        - { protocol: TCP, port: 8428 }', '              app.kubernetes.io/component: os-ui-gone\n      ports:\n        - { protocol: TCP, port: 8428 }', 1)"
TWIN_TPL=$OBS twin "j (another namespace at the Collector)" 'otel-collector-allow-os-only: admits another namespace' \
  "s.replace('              app.kubernetes.io/component: os-ui-worker\n', '              app.kubernetes.io/component: os-ui-worker\n        - namespaceSelector:\n            matchLabels:\n              kubernetes.io/metadata.name: agentic-apps\n', 1)"
echo "platform-ingress-policy: ok — the check passes the committed chart and refuses all ten broken twins"
