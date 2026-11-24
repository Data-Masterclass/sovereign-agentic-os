#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Resolve the chart's subcharts (Chart.lock versions) for a CI job, then make their values schemas validate
# offline (scripts/lib/offline-subchart-schemas.py).
#
# The subchart archives come from GitHub releases / GitHub Pages; a slow answer there ("could not download
# …langfuse-1.5.36.tgz: context deadline exceeded", CI 22 Nov 2026) failed whole jobs before a single test ran.
# The download is retried a bounded number of times (3), each failure logged; a third failure fails the step.
# The versions are the locked ones: the repos are added first, so `helm dependency build` (Chart.lock) works
# and the old `|| helm dependency update` fallback (which re-resolves the version ranges) is not needed.
#   helm-deps.sh [chart-dir]
set -euo pipefail
chart="${1:-charts/sovereign-agentic-os}"
# The repositories Chart.yaml names, added under stable names so `helm dependency build` can fetch from Chart.lock.
repos_file=$(mktemp); trap 'rm -f "$repos_file"' EXIT
python3 - "$chart/Chart.yaml" >"$repos_file" <<'PY'
import sys, re, hashlib  # no PyYAML: not every job installs it; `repository:` lines are one URL each
for r in sorted(set(re.findall(r'^\s*repository:\s*["\']?(https?://[^"\'\s]+)', open(sys.argv[1]).read(), re.M))):
    print("soa-" + hashlib.sha1(r.encode()).hexdigest()[:10], r)
PY
fetch() {
  while read -r name url; do
    [ -n "$name" ] || continue
    helm repo add --force-update "$name" "$url" >/dev/null || return 1
  done <"$repos_file"
  helm dependency build "$chart"
}
for attempt in 1 2 3; do
  if fetch; then break; fi
  if [ "$attempt" = 3 ]; then echo "helm-deps: subcharts could not be fetched after 3 attempts" >&2; exit 1; fi
  echo "helm-deps: fetching subcharts failed (attempt $attempt/3), retrying in $((attempt * 15)) s" >&2
  sleep $((attempt * 15))
done
python3 "$(dirname "$0")/offline-subchart-schemas.py" "$chart"
