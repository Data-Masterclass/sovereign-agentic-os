#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
#
# WP-55 chart guards: `osUI.dataProjectGit.layout.migration`
#   - off (default) renders, and new repos stay v1 (OS_REPO_LAYOUT_V2=false);
#   - an unknown value fails the render;
#   - `apply` FAILS while the Dagster code location or its repo-sync sidecar is older than
#     layout.dagsterMinVersion (deploy order, verifier F9), and renders once both are new enough;
#   - the git daemon carries its access hook, and the hook script is the chart's file.
set -uo pipefail
cd "$(dirname "$0")/../.."
CHART=charts/sovereign-agentic-os
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
fail=0
skip() {
  if [ -n "${CI:-}" ]; then echo "repo-layout-chart: $1 — FAILING because CI is set"; exit 1; fi
  echo "repo-layout-chart: $1 — SKIPPED"; exit 0
}
command -v helm >/dev/null 2>&1 || skip "helm not on PATH"
python3 -c 'import yaml' 2>/dev/null || skip "python3 with PyYAML not available"
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }

helm template t "$CHART" > "$TMP/off.yaml" 2>"$TMP/off.err" || { cat "$TMP/off.err"; skip "the default render failed (run helm dependency build)"; }
check "default: migration off" "grep -A1 'name: OS_REPO_LAYOUT_MIGRATION' '$TMP/off.yaml' | grep -q '\"off\"'"
check "default: new repos stay v1" "grep -A1 'name: OS_REPO_LAYOUT_V2' '$TMP/off.yaml' | grep -q '\"false\"'"
check "git daemon has the access hook" "grep -q -- '--access-hook=/hooks/access-hook.sh' '$TMP/off.yaml'"
check "the hook refuses user and platform repos" "grep -q 'user-\*|platform)' '$TMP/off.yaml'"
check "an unknown migration value fails" "! helm template t '$CHART' --set osUI.dataProjectGit.layout.migration=bogus >/dev/null 2>&1"
# Deploy order: an image older than layout.dagsterMinVersion is refused. The chart's own image is now
# 0.4.0 (>= 0.3.3), so the "too old" case is simulated by raising the minimum above it.
check "apply with a Dagster image below dagsterMinVersion FAILS (deploy order)" "! helm template t '$CHART' --set osUI.dataProjectGit.layout.migration=apply --set osUI.dataProjectGit.layout.dagsterMinVersion=9.9.9 >/dev/null 2>'$TMP/apply.err' && grep -q 'deploy that Dagster image first' '$TMP/apply.err'"
check "apply with today's Dagster image still FAILS while no layout digest is recorded" "! helm template t '$CHART' --set osUI.dataProjectGit.layout.migration=apply >/dev/null 2>&1"

python3 - "$CHART/values.yaml" "$TMP" <<'PY'
import re, sys, yaml
v = yaml.safe_load(open(sys.argv[1])); out = sys.argv[2]
mn = v['osUI']['dataProjectGit']['layout']['dagsterMinVersion']
NEW = 'sha256:' + 'a' * 64
def write(name, code, sidecar, digests=(NEW,), digest=NEW):
    deps = yaml.safe_load(open(sys.argv[1]))['dagster']['dagster-user-deployments']['deployments']
    d = deps[0]; d['image']['tag'] = code; d['image']['digest'] = digest
    for c in d['sidecarContainers']:
        if c['name'] == 'repo-sync':
            c['image'] = re.sub(r':[^:@/]+@sha256:[0-9a-f]{64}', f':{sidecar}@{digest}', c['image'])
    layout = {'migration': 'apply', 'dagsterLayoutDigests': list(digests)}
    yaml.safe_dump({'dagster': {'dagster-user-deployments': {'deployments': deps}}, 'osUI': {'dataProjectGit': {'layout': layout}}}, open(f'{out}/{name}.yaml', 'w'))
write('new', mn, mn)
write('oldsidecar', mn, '0.3.2')
write('unlisted', mn, mn, digests=())
write('movedtag', mn, mn, digests=('sha256:' + 'b' * 64,))
PY
check "apply with both images >= the minimum renders, and makes new repos v2" "helm template t '$CHART' -f '$TMP/new.yaml' 2>/dev/null | grep -A1 'name: OS_REPO_LAYOUT_V2' | grep -q '\"true\"'"
check "apply with an old repo-sync sidecar FAILS" "! helm template t '$CHART' -f '$TMP/oldsidecar.yaml' >/dev/null 2>&1"
check "apply with no layout-capable digest recorded FAILS" "! helm template t '$CHART' -f '$TMP/unlisted.yaml' >/dev/null 2>&1"
check "apply with the right tag but an unlisted digest FAILS (a moved tag)" "! helm template t '$CHART' -f '$TMP/movedtag.yaml' >/dev/null 2>'$TMP/moved.err' && grep -q 'dagsterLayoutDigests' '$TMP/moved.err'"
check "the ConfigMap carries the tested hook file" "grep -q 'not served over the in-cluster git protocol' '$TMP/off.yaml'"
[ "$fail" = 0 ] && echo "repo-layout-chart: ok" || { echo "repo-layout-chart: FAILED"; exit 1; }
