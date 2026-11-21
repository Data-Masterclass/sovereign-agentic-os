#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Dagster run-pod shape — the chart check and its negative twins. The check must PASS on the chart
# as committed and FAIL on a copy that is wrong in each way that matters:
#   a. a launcher identity left out (the daemon's ServiceAccount);
#   b. the run config's image form missing from the allowlist (real run pods would be refused);
#   c. the run ServiceAccount not allowed;
#   d. the binding only warns instead of denying.
set -euo pipefail
cd "$(dirname "$0")/../.."
CHECK=scripts/check-dagster-pod-admission.mjs
TPL=templates/extensions/dagster/run-pod-admission.yaml
fail() { echo "FAIL: $*" >&2; exit 1; }
out=$(node "$CHECK" 2>&1) || fail "the check fails on the committed chart: $out"
grep -q "$(basename "$CHECK" .mjs): OK" <<<"$out" || fail "the check did not run (skipped?): $out"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
twin() { # twin <label> <expected message regex> <python mutation of the template text `s`>
  local label=$1 want=$2 mutation=$3
  rm -rf "$WORK/chart" && cp -R charts/sovereign-agentic-os "$WORK/chart"
  python3 - "$WORK/chart/$TPL" "$mutation" <<'PY'
import sys
p, code = sys.argv[1], sys.argv[2]
s = open(p).read(); before = s; s = eval(code)
assert s != before, 'mutation changed nothing'
open(p, 'w').write(s)
PY
  if out=$(CHART_DIR="$WORK/chart" node "$CHECK" 2>&1); then fail "twin $label: the check passed a broken policy"; fi
  grep -Eq "$want" <<<"$out" || fail "twin $label: failed for the wrong reason: $out"
  echo "dagster-pod-admission: twin $label refused as expected"
}
twin "a (launcher left out)" 'agentic-os-dagster may write Pods/Jobs .* not held' \
  "s.replace('(list (printf \"%s-dagster\" .Release.Name) (printf', '(list (printf', 1)"
twin "b (run image form missing)" 'is not on the run-pod image allowlist' \
  "s.replace('{{- \$images = append \$images (printf \"%s:%s@%s\" \$i.repository (toString \$i.tag) \$i.digest) }}\n', '', 1)"
twin "c (run SA not allowed)" 'not an allowed run ServiceAccount' \
  "s.replace('(list (printf \"%s-dagster-user-deployments-user-deployments\" .Release.Name)) }}', '(list \"someone-else\") }}', 1)"
twin "d (warn only)" 'the binding must Deny' \
  "s.replace('validationActions: [\"Deny\"]', 'validationActions: [\"Warn\"]', 1)"
echo "dagster-pod-admission: ok — the check passes the committed chart and refuses all four broken twins"
