# OpenTelemetry Collector

Upstream, unmodified. Nothing in this folder is ours — see the rule in `components/README.md`.

- **Licence:** Apache-2.0 (https://github.com/open-telemetry/opentelemetry-collector-releases/blob/main/LICENSE)
- **Source:** https://github.com/open-telemetry/opentelemetry-collector-releases (distribution `otelcol-k8s`)
- **Pinned as:** Image `otel/opentelemetry-collector-k8s:0.165.0@sha256:ce55d0a38923c83120e4ba613fbdf446786652d2ce9f29d1cd7879e5d869829f`
  (release https://github.com/open-telemetry/opentelemetry-collector-releases/releases/tag/v0.165.0, 2026-11-07).
  The Kubernetes distribution: it carries every component the chart uses (`file_log`,
  `kubelet_stats`, `otlp`, `memory_limiter`, `batch`, `resource`, `filter`, `otlp_http`,
  `headers_setter`, `health_check`) and, for the tests, `file` and `basicauth`. Checked with
  `otelcol-k8s components`.

**Why the OS ships it:** one Apache-2.0 pipeline for metrics and logs (design 00 §6). Config:
`charts/sovereign-agentic-os/templates/extensions/observability/otel-collector.yaml`.

## Upstream docs this pin relies on
- Configuration: https://opentelemetry.io/docs/collector/configuration/
- Component names in 0.165 are snake_case (`file_log`, `kubelet_stats`, `otlp_http`); the
  camel-case names are the older aliases.
- File log receiver + `container` operator (CRI/docker format, k8s fields from the path):
  https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/receiver/filelogreceiver ,
  https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/pkg/stanza/docs/operators/container.md
- Kubelet stats receiver (`auth_type: serviceAccount`, RBAC `nodes/stats get`):
  https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/receiver/kubeletstatsreceiver
- "Important components for Kubernetes" (file_log and kubelet_stats run per node, i.e. as a
  DaemonSet): https://opentelemetry.io/docs/platforms/kubernetes/collector/components/
- Filter processor and OTTL `IsRootSpan()`:
  https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/processor/filterprocessor ,
  https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/pkg/ottl/contexts/ottlspan
- OTLP receiver `traces_url_path`, `include_metadata`; headers setter `from_context`; batch
  `metadata_keys`: https://github.com/open-telemetry/opentelemetry-collector/tree/main/receiver/otlpreceiver ,
  https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/extension/headerssetterextension
- Health check extension: https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/extension/healthcheckextension
- Internal telemetry (`service.telemetry.metrics.readers`, `service_version` label):
  https://opentelemetry.io/docs/collector/internal-telemetry/

## Deviation from the plan, and why
MASTER-PLAN WP-05 says "one Collector Deployment". It is a **DaemonSet**: `file_log` reads
`/var/log/pods` and `kubelet_stats` the local kubelet, so a single Deployment would silently miss
every other node once the second node (O6) joins. On today's single node it is the same one pod.
