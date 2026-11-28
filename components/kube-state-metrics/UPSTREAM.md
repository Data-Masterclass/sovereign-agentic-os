# kube-state-metrics

Upstream, unmodified. Nothing in this folder is ours — see the rule in `components/README.md`.

- **Licence:** Apache-2.0 (https://github.com/kubernetes/kube-state-metrics/blob/v2.20.0/LICENSE). A
  Kubernetes SIG Instrumentation project; the image is built FROM a distroless static base.
- **Pinned as:** `registry.k8s.io/kube-state-metrics/kube-state-metrics:v2.20.0@sha256:42cfe3723a5f058171c627537fb57a3ea0f26e4380fa18555a95cb1a1b4cfc5b`
  (multi-arch index; https://github.com/kubernetes/kube-state-metrics/releases/tag/v2.20.0, image created 2026-08-18).

**Why the OS ships it:** Monitoring → Platform → Capacity needs per-container resource requests, node
allocatable, pod phase and the last termination reason. kube-state-metrics turns them into metrics that
VictoriaMetrics scrapes, so os-ui runs PromQL instead of holding a cluster-wide pod grant itself.
Template: `charts/sovereign-agentic-os/templates/extensions/observability/kube-state-metrics.yaml`
(switch `observability.kubeStateMetrics.enabled`); checked by `scripts/check-kube-state-metrics-chart.mjs`.

## Upstream docs this pin relies on
- CLI flags (`--resources`, `--metric-allowlist`, `--metric-labels-allowlist`, `--port`, `--telemetry-port`):
  https://github.com/kubernetes/kube-state-metrics/blob/v2.20.0/docs/developer/cli-arguments.md
- Pod metrics (`kube_pod_container_resource_requests`, `kube_pod_init_container_resource_requests`,
  `kube_pod_init_container_info` with `restart_policy`, `kube_pod_status_phase`,
  `kube_pod_container_status_last_terminated_reason` / `_timestamp`, `kube_pod_container_status_restarts_total`,
  `kube_pod_labels`): https://github.com/kubernetes/kube-state-metrics/blob/v2.20.0/docs/metrics/workload/pod-metrics.md
- Node metrics (`kube_node_status_allocatable`, `kube_node_labels`):
  https://github.com/kubernetes/kube-state-metrics/blob/v2.20.0/docs/metrics/cluster/node-metrics.md
- RBAC: list + watch on the resources it exports (upstream `examples/standard/cluster-role.yaml`, narrowed
  here to pods and nodes).
- Health: `/livez` on the metrics port, `/readyz` on the telemetry port.
