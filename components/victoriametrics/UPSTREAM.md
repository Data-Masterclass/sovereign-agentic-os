# VictoriaMetrics and VictoriaLogs (single-node)

Upstream, unmodified. Nothing in this folder is ours — see the rule in `components/README.md`.

- **Licence:** Apache-2.0, both (GitHub licence API, 2026-11-20:
  https://github.com/VictoriaMetrics/VictoriaMetrics/blob/master/LICENSE ,
  https://github.com/VictoriaMetrics/VictoriaLogs/blob/master/LICENSE). The single-node
  binaries used here are the open-source builds; no enterprise flag is set.
  Grafana and Loki (AGPL-3.0) are excluded by the licence rule (design 00 §6).
- **Pinned as:**
  - `victoriametrics/victoria-metrics:v1.156.0@sha256:da8a90ac0912f16589be2b96a6441a2fca4bca415c83783d972d92e3b5b66970`
    (https://github.com/VictoriaMetrics/VictoriaMetrics/releases/tag/v1.156.0, 2026-11-09)
  - `victoriametrics/victoria-logs:v1.54.0@sha256:ee4e820cac3721f5f5d91641b950c22439593adc4224f9655e5333d5a84c1dfe`
    (https://github.com/VictoriaMetrics/VictoriaLogs/releases/tag/v1.54.0, 2026-11-13)

**Why the OS ships them:** the metrics and log stores of design 00 §6, fed by the OpenTelemetry
Collector, each with its own web UI (vmui). Templates:
`charts/sovereign-agentic-os/templates/extensions/observability/victoria-{metrics,logs}.yaml`.

## Upstream docs this pin relies on
- VictoriaMetrics single-node, flags (`-storageDataPath`, `-retentionPeriod`, `-httpListenAddr`):
  https://docs.victoriametrics.com/victoriametrics/single-server-victoriametrics/
- OpenTelemetry ingestion `/opentelemetry/v1/metrics`, `-opentelemetry.usePrometheusNaming`:
  https://docs.victoriametrics.com/victoriametrics/integrations/opentelemetry/
- Query API `/api/v1/query` (PromQL; MetricsQL is a superset): https://docs.victoriametrics.com/victoriametrics/url-examples/
- VictoriaLogs, flags (`-retentionPeriod`, `-retention.maxDiskSpaceUsageBytes`): https://docs.victoriametrics.com/victorialogs/
- VictoriaLogs OpenTelemetry ingestion `/insert/opentelemetry/v1/logs`, `VL-Stream-Fields`:
  https://docs.victoriametrics.com/victorialogs/data-ingestion/opentelemetry/
- LogsQL and `/select/logsql/query`: https://docs.victoriametrics.com/victorialogs/querying/
- Version: every binary exports `vm_app_version{short_version="v…"}` on `/metrics` — what
  os-ui's health() reads.
