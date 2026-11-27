#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# up.sh — bring up the acceptance harness on kind.
#
#   tests/e2e/kind/up.sh            create cluster, Calico, images, SeaweedFS, chart; print status
#
# Steps, all with the pins in versions.env and the chart's own pins:
#   1. kind cluster $E2E_CLUSTER (default wp02) with the default CNI disabled;
#   2. Calico from its tagged manifest, verified by sha256, so NetworkPolicies are enforced;
#   3. our images built from THIS checkout (scripts/lib/local-images.py, as scripts/os) plus the model stub, loaded
#      into kind;
#   4. SeaweedFS + the chart's buckets (manifests/seaweedfs.yaml);
#   5. the chart: values.local.yaml (laptop sizing) + values.e2e.yaml (harness profile)
#      + values.e2e-limits.yaml (memory limits that fit a CI runner; checked by the capacity gate)
#      + $E2E_VALUES (optional extra file, e.g. a laptop file that turns components off).
# It never waits silently: it ends with a per-workload readiness table and exits non-zero when a
# workload is not Ready, naming it. E2E_ALLOW_PARTIAL=1 keeps going (laptop runs).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
cd "$ROOT"
# shellcheck source=/dev/null
. "$HERE/versions.env"
CLUSTER=${E2E_CLUSTER:-wp02}
NS=${E2E_NAMESPACE:-agentic-os}
REL=agentic-os
CHART=charts/sovereign-agentic-os
CTX="kind-$CLUSTER"
say() { printf '\n==> %s\n' "$*"; }
k() { kubectl --context "$CTX" "$@"; }

for t in docker kind kubectl helm python3 curl; do command -v "$t" >/dev/null || { echo "missing tool: $t" >&2; exit 1; }; done

say "1. kind cluster $CLUSTER ($KIND_NODE_IMAGE)"
if ! kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  kind create cluster --name "$CLUSTER" --config "$HERE/cluster.yaml" --image "$KIND_NODE_IMAGE"
fi

say "2. Calico $CALICO_VERSION (manifest verified by sha256)"
manifest=$(mktemp)
curl -fsSL "https://raw.githubusercontent.com/projectcalico/calico/${CALICO_VERSION}/manifests/calico.yaml" -o "$manifest"
got=$( (sha256sum "$manifest" 2>/dev/null || shasum -a 256 "$manifest") | cut -d' ' -f1)
[ "$got" = "$CALICO_MANIFEST_SHA256" ] || { echo "calico manifest sha256 $got != pinned $CALICO_MANIFEST_SHA256" >&2; exit 1; }
k apply -f "$manifest" >/dev/null
rm -f "$manifest"
k -n kube-system rollout status daemonset/calico-node --timeout="${E2E_CALICO_TIMEOUT:-1200}s"
k wait --for=condition=Ready node --all --timeout=300s

say "3. images (built from this checkout, loaded into kind)"
# The same list and the same build as scripts/os (scripts/lib/local-images.{py,sh}), with the model stub built
# under the mockModel key (values.e2e.yaml points mockModel.image at it). Every image the profile needs that is
# not public is in that list, including the Dagster and git images (values.local.yaml names their local tags).
# shellcheck source=scripts/lib/local-images.sh
. "$ROOT/scripts/lib/local-images.sh"
if [ "${E2E_SKIP_BUILD:-0}" != 1 ]; then
  plan=$(mktemp)
  python3 scripts/lib/local-images.py plan -f values.local.yaml -f tests/e2e/kind/values.e2e.yaml \
    -f tests/e2e/kind/values.e2e-limits.yaml --context mockModel=tests/e2e/kind/model-stub >"$plan"
  # E2E_BUILD_ONLY="mockModel dagster" limits the build to those keys (laptop iterations).
  LOCAL_IMAGES_ONLY="${E2E_BUILD_ONLY:-}" build_local_images "$CLUSTER" "$plan"
  rm -f "$plan"
fi

say "4. SeaweedFS ($SEAWEEDFS_IMAGE) and the chart's buckets"
k create namespace "$NS" --dry-run=client -o yaml | k apply -f - >/dev/null
buckets=$(python3 -c "import yaml;print(' '.join(yaml.safe_load(open('$CHART/values.yaml'))['objectStorage']['buckets']))")
sed -e "s|__SEAWEEDFS_IMAGE__|$SEAWEEDFS_IMAGE|g" -e "s|__NAMESPACE__|$NS|g" -e "s|__BUCKETS__|$buckets|g" "$HERE/manifests/seaweedfs.yaml" | k apply -f - >/dev/null
k -n "$NS" rollout status deployment/seaweedfs --timeout="${E2E_PULL_TIMEOUT:-1200}s"
k -n "$NS" wait --for=condition=complete job/seaweedfs-buckets --timeout="${E2E_PULL_TIMEOUT:-1200}s"

[ "${E2E_STOP_AFTER_INFRA:-0}" = 1 ] && { say "stopping after infrastructure (E2E_STOP_AFTER_INFRA=1)"; exit 0; }

say "5. chart ($CHART) with values.local.yaml + values.e2e.yaml + values.e2e-limits.yaml${E2E_VALUES:+ + $E2E_VALUES}"
bash scripts/lib/helm-deps.sh "$CHART" >/dev/null  # adds the chart repositories first (fresh runner/laptop)
extra=""
[ -n "${E2E_VALUES:-}" ] && extra="-f $E2E_VALUES"
# shellcheck disable=SC2086  # $extra is a deliberate flag list
helm --kube-context "$CTX" upgrade --install "$REL" "$CHART" -n "$NS" \
  -f values.local.yaml -f "$HERE/values.e2e.yaml" -f "$HERE/values.e2e-limits.yaml" $extra --timeout 30m  # Helm 4: no --wait = hookOnly, i.e. what --wait=false did on Helm 3

say "readiness (waits up to ${E2E_READY_TIMEOUT:-1500}s per workload)"
failed=""
for w in $(k -n "$NS" get deploy,statefulset -o name); do
  if k -n "$NS" rollout status "$w" --timeout="${E2E_READY_TIMEOUT:-1500}s" >/dev/null 2>&1; then
    printf '   %-60s Ready\n' "$w"
  else
    reason=$(k -n "$NS" get pods -l "$(k -n "$NS" get "$w" -o jsonpath='{.spec.selector.matchLabels}' | python3 -c 'import sys,json;print(",".join(f"{a}={b}" for a,b in json.load(sys.stdin).items()))')" \
      -o jsonpath='{range .items[*]}{.status.containerStatuses[*].state.waiting.reason}{.status.containerStatuses[*].lastState.terminated.reason}{.status.conditions[?(@.type=="PodScheduled")].message} {end}' 2>/dev/null)
    printf '   %-60s NOT READY %s\n' "$w" "${reason:-}"
    failed="$failed $w"
  fi
done
if [ -n "$failed" ]; then
  echo "workloads not ready:$failed" >&2
  [ "${E2E_ALLOW_PARTIAL:-0}" = 1 ] || exit 1
fi
