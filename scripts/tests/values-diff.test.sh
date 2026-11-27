#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# =============================================================================
# values-diff.test.sh — scripts/lib/values-diff.py, which deploy.sh prints before an upgrade.
# =============================================================================
#   bash scripts/tests/values-diff.test.sh
#
# Fixtures are tiny YAML files: a chart, a "live" release that pins an old ClickHouse size
# (the 2026-11-19 shape: the chart default moved, the release did not), and an overlay that
# fixes it. The live values carry a fake secret and a URL with credentials; neither may print.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
# shellcheck source=scripts/tests/assert.sh
. scripts/tests/assert.sh
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/chart.yaml" <<'YAML'
clickhouse: {persistence: {enabled: false, size: 30Gi}}
ingress: {hosts: {}}
osUI: {sessionSecret: "", publicUrl: "", worker: {enabled: false}}
YAML
cat > "$TMP/live.yaml" <<'YAML'
clickhouse: {persistence: {enabled: true, size: 10Gi}}
ingress: {hosts: {osUI: os.example.test}}
osUI: {sessionSecret: FAKE_SESSION_SECRET_42, publicUrl: "https://user:FAKE_URL_PASS@os.example.test", worker: {enabled: true}}
removedComponent: {enabled: true}
YAML
# what deploy.sh derives: the live values minus the top-level key the chart no longer has
python3 -c "import yaml; d=yaml.safe_load(open('$TMP/live.yaml')); d.pop('removedComponent'); yaml.safe_dump(d, open('$TMP/derived.yaml','w'))"
echo 'clickhouse: {persistence: {size: 30Gi}}' > "$TMP/overlay.yaml"

diffv() { out=$(python3 scripts/lib/values-diff.py "$TMP/live.yaml" "$TMP/chart.yaml" "$TMP/derived.yaml" "$@" 2>&1); rc=$?; }

echo "== without an overlay: the pinned old value is shown to beat the chart"
diffv
rc_is "it exits 0" 0
check "the override is named, with both values" "clickhouse.persistence.size: release 10Gi, chart default 30Gi" "$out"
check "a dropped component is a change" "removedComponent.enabled: true -> (unset)" "$out"
check "children of a free-form chart map are defined" "does not define (no effect unless a subchart reads them): none" "$out"
absent "a secret-named value never prints" "FAKE_SESSION_SECRET" "$out"
absent "a URL with credentials never prints" "FAKE_URL_PASS" "$out"
check "a hidden value says so" "osUI.sessionSecret: release (hidden)" "$out"

echo "== with the overlay: the change is visible before it is applied"
diffv "$TMP/overlay.yaml"
check "the overlay's change is listed" "clickhouse.persistence.size: 10Gi -> 30Gi" "$out"
absent "the size no longer overrides the chart" "size: release" "$out"
absent "still no secret" "FAKE_SESSION_SECRET" "$out"

echo "== a key the chart does not define is listed"
echo 'osUI: {typoKey: 1}' > "$TMP/overlay2.yaml"
diffv "$TMP/overlay2.yaml"
check "an undefined key is listed by path" "osUI.typoKey" "$out"

echo "== ingress.hosts is free-form even though values.yaml no longer defaults it (PR #413)"
cat > "$TMP/chart-nohosts.yaml" <<'YAML'
ingress: {enabled: false, className: nginx}
osUI: {publicUrl: ""}
YAML
printf 'ingress: {enabled: true, hosts: {osUI: os.example.test, osUIApex: example.test, dagster: d.example.test}}\nosUI: {publicUrl: "https://os.example.test"}\n' > "$TMP/live-hosts.yaml"
out=$(python3 scripts/lib/values-diff.py "$TMP/live-hosts.yaml" "$TMP/chart-nohosts.yaml" "$TMP/live-hosts.yaml" 2>&1); rc=$?
rc_is "it exits 0" 0
check "live ingress.hosts.* keys are not reported as undefined" "does not define (no effect unless a subchart reads them): none" "$out"
absent "…not even one of them" "ingress.hosts.osUIApex" "$out"
printf 'ingress: {hostz: {osUI: x}}\n' > "$TMP/live-typo.yaml"
out=$(python3 scripts/lib/values-diff.py "$TMP/live-typo.yaml" "$TMP/chart-nohosts.yaml" "$TMP/live-typo.yaml" 2>&1)
check "twin: a sibling that is not the free-form map is still reported" "ingress.hostz.osUI" "$out"

echo "== usage"
out=$(python3 scripts/lib/values-diff.py 2>&1); rc=$?
holds "missing arguments exit non-zero" [ "$rc" -ne 0 ]
holds "deploy.sh runs it" grep -q 'scripts/lib/values-diff.py' scripts/deploy.sh

finish values-diff.test.sh || exit 1
echo "VALUES_DIFF_TESTS_OK"
