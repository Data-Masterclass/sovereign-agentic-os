#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# WP-21 chart guards (no cluster needed unless WP21_KUBE_CONTEXT is set):
#  1. A PLAIN release with live-like values (fs snapshots on, no overlay) renders NO cleanup Job
#     and NO S3 Job, and the egress-proxy checksum is the same formula as before WP-21, over the chart's
#     joined host list (allowlist + llmProviders.allowHosts + llmProviders.platformHosts) (so the
#     proxy does not restart when its allowlist does not change).
#  2. The STACKIT overlay as committed (REPLACE placeholders) refuses to render.
#  3. The overlay with real values renders the cleanup Job, snapshotting to stackit-s3 only,
#     and adds the object-storage host to the proxy allowlist.
#  4. With WP21_KUBE_CONTEXT (a throwaway kind cluster), `helm template --dry-run=server` refuses
#     a missing keystore Secret and one with the wrong keys, and accepts exactly the two keys.
set -euo pipefail
cd "$(dirname "$0")/../.."
CHART=charts/sovereign-agentic-os
OVERLAY=deploy/overlays/opensearch-s3-snapshots.stackit.yaml
fail() { echo "FAIL: $*" >&2; exit 1; }
render() { helm template agentic-os "$CHART" -n agentic-os --skip-schema-validation "$@" 2>&1; }

# 1. plain release, live-like values
out=$(render --set opensearchSnapshots.enabled=true) || fail "plain render failed: $out"
grep -q 'name: opensearch-orphan-cleanup' <<<"$out" && fail "a plain release renders the cleanup Job"
grep -q 'name: register-opensearch-s3-repo' <<<"$out" && fail "a plain release renders the S3 Job"
grep -q 'name: register-opensearch-snapshot-repo' <<<"$out" || fail "the fs registration Job vanished"
# The proxy's host list for a plain release is the chart's own, in soa.egressHosts order: the egress
# allowlist, then the LLM provider hosts (operators' llmProviders.allowHosts, then the platform's
# llmProviders.platformHosts), de-duplicated keeping the first occurrence (sprig `uniq`). The checksum
# must be exactly this formula of exactly that list — so it changes only when the list does.
want=$(python3 - "$CHART/values.yaml" <<'PY'
import hashlib, json, sys, yaml
v = yaml.safe_load(open(sys.argv[1]))
llm = v.get('llmProviders') or {}
hosts = []
for h in v['egressProxy']['allowlist'] + (llm.get('allowHosts') or []) + (llm.get('platformHosts') or []):
    if h not in hosts:
        hosts.append(h)
print(hashlib.sha256((json.dumps(hosts, separators=(',', ':')) + '-tinyproxy').encode()).hexdigest())
PY
)
grep -q "checksum/config: $want" <<<"$out" || fail "egress-proxy checksum changed for an unchanged allowlist"
again=$(render --set opensearchSnapshots.enabled=true) || fail "second plain render failed"
grep -q "checksum/config: $want" <<<"$again" || fail "egress-proxy checksum is not deterministic across two renders of the same values"

# 2. overlay with placeholders
if out=$(render -f "$OVERLAY"); then fail "the overlay with REPLACE placeholders rendered"; fi
grep -q 'REPLACE placeholder' <<<"$out" || fail "placeholder refusal not explained: $out"
if out=$(render -f "$OVERLAY" --set opensearchSnapshots.s3.bucket=b); then fail "a REPLACE image digest rendered"; fi
grep -q 'opensearch.image.tag still holds a REPLACE' <<<"$out" || fail "image placeholder refusal not explained: $out"

# 3. overlay filled in
REAL=(-f "$OVERLAY" --set opensearchSnapshots.s3.bucket=soa-snapshots --set "opensearch.image.tag=3.7.0-soa.1@sha256:0000000000000000000000000000000000000000000000000000000000000000")
out=$(render "${REAL[@]}") || fail "filled overlay did not render: $out"
grep -q 'name: opensearch-orphan-cleanup' <<<"$out" || fail "the overlay does not opt in to the cleanup"
grep -q 'OS_CLEANUP_SNAPSHOT_REPO, value: "stackit-s3"' <<<"$out" || fail "cleanup does not snapshot to stackit-s3"
grep -q 'object\\.storage\\.eu01\\.onstackit\\.cloud' <<<"$out" || fail "the S3 host is not on the proxy allowlist"

# 4. keystore Secret keys, against a real API server
if [ -n "${WP21_KUBE_CONTEXT:-}" ]; then
  K=(kubectl --context "$WP21_KUBE_CONTEXT")
  H=(helm template agentic-os "$CHART" -n agentic-os --kube-context "$WP21_KUBE_CONTEXT" --dry-run=server --skip-schema-validation "${REAL[@]}")
  "${K[@]}" create namespace agentic-os --dry-run=client -o yaml | "${K[@]}" apply -f - >/dev/null
  "${K[@]}" -n agentic-os delete secret opensearch-s3-keystore --ignore-not-found >/dev/null
  if out=$("${H[@]}" 2>&1); then fail "rendered without the keystore Secret"; fi
  grep -q 'must exist before this upgrade' <<<"$out" || fail "missing Secret not explained: $out"
  "${K[@]}" -n agentic-os create secret generic opensearch-s3-keystore --from-literal=access_key=x --from-literal=secret_key=y >/dev/null
  if out=$("${H[@]}" 2>&1); then fail "rendered with wrong Secret keys"; fi
  grep -q 'must hold exactly the keys' <<<"$out" || fail "wrong keys not explained: $out"
  "${K[@]}" -n agentic-os delete secret opensearch-s3-keystore >/dev/null
  "${K[@]}" -n agentic-os create secret generic opensearch-s3-keystore --from-literal=s3.client.default.access_key=x --from-literal=s3.client.default.secret_key=y >/dev/null
  out=$("${H[@]}" 2>&1) || fail "rendered refused with the right keys: $out"
  echo "opensearch-chart: keystore Secret key check ok against $WP21_KUBE_CONTEXT"
else
  echo "opensearch-chart: WP21_KUBE_CONTEXT unset — keystore lookup check skipped (CI sets it)"
  [ -z "${CI:-}" ] || fail "CI must run the keystore check (set WP21_KUBE_CONTEXT)"
fi
echo "opensearch-chart: ok — plain release renders no cleanup/S3 Job and keeps the proxy checksum; placeholders refuse; the filled overlay opts in to stackit-s3"
