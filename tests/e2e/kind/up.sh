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
#   3. our images built from THIS checkout (same list as scripts/os) plus the model stub, loaded
#      into kind;
#   4. SeaweedFS + the chart's buckets (manifests/seaweedfs.yaml);
#   5. the chart: values.local.yaml (laptop sizing) + values.e2e.yaml (harness profile)
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
k -n kube-system rollout status daemonset/calico-node --timeout=600s
k wait --for=condition=Ready node --all --timeout=300s

say "3. images (built from this checkout, loaded into kind)"
image_ref() { python3 - "$1" <<'PY'
import sys, yaml
def merge(a, b):
    for k, v in (b or {}).items():
        a[k] = merge(a.get(k, {}), v) if isinstance(v, dict) and isinstance(a.get(k), dict) else v
    return a
v = {}
for f in ['charts/sovereign-agentic-os/values.yaml', 'values.local.yaml', 'tests/e2e/kind/values.e2e.yaml']:
    v = merge(v, yaml.safe_load(open(f)))
k = sys.argv[1]
img = v['dagster']['dagsterWebserver']['image'] if k == 'dagster' else v[k]['image']
print(f"{img['repository']}:{img['tag']}")
PY
}
# key → Dockerfile ('-' = <context>/Dockerfile) → context. Same list as scripts/os, plus the stub
# under the mockModel key (values.e2e.yaml points mockModel.image at it).
IMAGES="
osUI         images/base/os-ui/Dockerfile        .
egressProxy  -                                    images/base/egress-proxy
webFetch     -                                    images/base/web-fetch
mockModel    -                                    tests/e2e/kind/model-stub
dagster      images/extensions/dagster/Dockerfile images/extensions
dbt          -                                    images/extensions/dbt
dataRunner   -                                    images/extensions/data-runner
queryTool    -                                    images/extensions/query-tool
"
if [ "${E2E_SKIP_BUILD:-0}" != 1 ]; then
  echo "$IMAGES" | while read -r key dockerfile ctx; do
    [ -n "$key" ] || continue
    # E2E_BUILD_ONLY="mockModel dagster" limits the build to those keys (laptop iterations).
    if [ -n "${E2E_BUILD_ONLY:-}" ] && ! echo " $E2E_BUILD_ONLY " | grep -q " $key "; then continue; fi
    ref=$(image_ref "$key")
    if [ "$dockerfile" = "-" ]; then docker build -q -t "$ref" "$ctx" >/dev/null; else docker build -q -t "$ref" -f "$dockerfile" "$ctx" >/dev/null; fi
    kind load docker-image "$ref" --name "$CLUSTER" >/dev/null
    echo "   $ref"
  done
fi

say "4. SeaweedFS ($SEAWEEDFS_IMAGE) and the chart's buckets"
k create namespace "$NS" --dry-run=client -o yaml | k apply -f - >/dev/null
buckets=$(python3 -c "import yaml;print(' '.join(yaml.safe_load(open('$CHART/values.yaml'))['objectStorage']['buckets']))")
sed -e "s|__SEAWEEDFS_IMAGE__|$SEAWEEDFS_IMAGE|g" -e "s|__NAMESPACE__|$NS|g" -e "s|__BUCKETS__|$buckets|g" "$HERE/manifests/seaweedfs.yaml" | k apply -f - >/dev/null
k -n "$NS" rollout status deployment/seaweedfs --timeout=300s
k -n "$NS" wait --for=condition=complete job/seaweedfs-buckets --timeout=300s

[ "${E2E_STOP_AFTER_INFRA:-0}" = 1 ] && { say "stopping after infrastructure (E2E_STOP_AFTER_INFRA=1)"; exit 0; }

say "5. chart ($CHART) with values.local.yaml + values.e2e.yaml${E2E_VALUES:+ + $E2E_VALUES}"
helm dependency build "$CHART" >/dev/null
extra=""
[ -n "${E2E_VALUES:-}" ] && extra="-f $E2E_VALUES"
# shellcheck disable=SC2086  # $extra is a deliberate flag list
helm --kube-context "$CTX" upgrade --install "$REL" "$CHART" -n "$NS" \
  -f values.local.yaml -f "$HERE/values.e2e.yaml" $extra --timeout 30m --wait=false

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
