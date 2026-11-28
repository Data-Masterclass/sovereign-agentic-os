#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# WP-05: the chart's observability stack (OpenTelemetry Collector, VictoriaMetrics, VictoriaLogs)
# plus the chart's OPA, rendered by `helm template` and applied UNCHANGED to a real Kubernetes
# cluster (kind), so the Collector's file_log and kubelet_stats receivers read real pod logs and a
# real kubelet, under the chart's own default-deny egress policies (kindnet enforces them). Then port-forwards the APIs for tests/observability/stack.int.test.mjs.
#   KUBE_CONTEXT   kube context to use (default kind-wp05; the cluster must exist)
#   OBS_NS         namespace (default obs-it)
#   EXTRA_SET      extra `--set` flags for helm template (the negative twins)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
ctx="${KUBE_CONTEXT:-kind-wp05}"
ns="${OBS_NS:-obs-it}"
chart="$repo/charts/sovereign-agentic-os"
k() { kubectl --context "$ctx" "$@"; }

rendered="$(mktemp)"
# The Collector's kubelet egress is narrowed to the node network, as in production
# (observability.collector.kubeletStats.nodeCidrs): here the kind nodes' InternalIPs.
node_cidrs="$(k get nodes -o jsonpath='{range .items[*]}{.status.addresses[?(@.type=="InternalIP")].address}/32,{end}' | sed 's/,$//')"
[ -n "$node_cidrs" ] || { echo "no node InternalIP found" >&2; exit 1; }
# shellcheck disable=SC2086
helm template agentic-os "$chart" --namespace "$ns" \
  --set "observability.collector.kubeletStats.nodeCidrs={$node_cidrs}" \
  --show-only templates/base/priority-classes.yaml \
  --show-only templates/base/network/egress-policies.yaml \
  --show-only templates/base/opa/opa.yaml \
  --show-only templates/base/opa/opa-tokens.yaml \
  --show-only templates/extensions/observability/otel-collector.yaml \
  --show-only templates/extensions/observability/victoria-metrics.yaml \
  --show-only templates/extensions/observability/victoria-logs.yaml \
  --show-only templates/extensions/observability/network-policies.yaml \
  ${EXTRA_SET:-} > "$rendered"
echo "rendered $(grep -c '^kind:' "$rendered") objects"

k create namespace "$ns" --dry-run=client -o yaml | k apply -f - >/dev/null
k apply -n "$ns" -f "$rendered"
# kube-state-metrics lives in its OWN namespace (<ns>-kube-state-metrics, restricted), so it is applied
# without `-n` (kubectl refuses a namespaced object whose namespace differs from the request's).
ksm_rendered="$(mktemp)"
# shellcheck disable=SC2086
helm template agentic-os "$chart" --namespace "$ns" \
  --show-only templates/extensions/observability/kube-state-metrics.yaml ${EXTRA_SET:-} > "$ksm_rendered"
k apply -f "$ksm_rendered"
k -n "$ns" rollout status statefulset/victoria-metrics --timeout="${ROLLOUT_TIMEOUT:-600s}"
k -n "$ns" rollout status statefulset/victoria-logs --timeout="${ROLLOUT_TIMEOUT:-600s}"
k -n "$ns" rollout status daemonset/otel-collector --timeout="${ROLLOUT_TIMEOUT:-600s}"
k -n "$ns" rollout status deployment/opa --timeout="${ROLLOUT_TIMEOUT:-600s}"
k -n "$ns-kube-state-metrics" rollout status deployment/kube-state-metrics --timeout="${ROLLOUT_TIMEOUT:-600s}"

# Port-forwards for the test (killed by kind-down.sh / the CI job end).
pids="$here/.port-forward.pids"; : > "$pids"
for pf in "svc/victoria-metrics 18428:8428" "svc/victoria-logs 19428:9428" "svc/otel-collector 14318:4318" "svc/otel-collector 18888:8888" "svc/opa 18181:8181"; do
  # shellcheck disable=SC2086
  k -n "$ns" port-forward $pf >/dev/null 2>&1 & echo $! >> "$pids"
done
for url in http://127.0.0.1:18428/health http://127.0.0.1:19428/health http://127.0.0.1:18181/health http://127.0.0.1:18888/metrics; do
  for _ in $(seq 1 30); do curl -fsS -o /dev/null "$url" && break; sleep 1; done
  curl -fsS -o /dev/null "$url" || { echo "not reachable: $url" >&2; exit 1; }
done
echo "observability stack up in $ctx/$ns"
