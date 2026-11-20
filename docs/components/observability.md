# Observability — OpenTelemetry Collector, VictoriaMetrics, VictoriaLogs

**What it is:** one Apache-2.0 pipeline for metrics and logs (design 00 §6). The OpenTelemetry
Collector (a DaemonSet, one pod per node) receives OTLP, reads every pod's log from
`/var/log/pods` and the kubelet's pod CPU and memory, and ships metrics to **VictoriaMetrics**
and logs to **VictoriaLogs**. Grafana and Loki are AGPL-3.0 and are not used. Pins and docs:
`components/otel-collector/UPSTREAM.md`, `components/victoriametrics/UPSTREAM.md`.
Values: `observability.*` (on by default; `observability.enabled=false` removes all of it).

## Access (their own UIs and APIs)
```bash
kubectl -n agentic-os port-forward svc/victoria-metrics 8428:8428   # vmui: http://localhost:8428/vmui
curl 'http://localhost:8428/api/v1/query?query=k8s_pod_memory_working_set_bytes'
kubectl -n agentic-os port-forward svc/victoria-logs 9428:9428      # UI: http://localhost:9428/select/vmui
curl 'http://localhost:9428/select/logsql/query?query=k8s.container.name:os-ui'
```

## OPA decision logs
OPA writes one JSON line per decision to its console (`opa.decisionLogs`). The Collector parses
JSON lines into fields, so one decision is:
```bash
curl 'http://localhost:9428/select/logsql/query?query=decision_id:"<id>"'
```
They carry principal ids and are kept 7 days (`observability.victoriaLogs.retentionPeriod`).

## Versions and health on the Platform page
Every version is read from the component itself (`os-ui/core/adapters/<component>/health.ts`;
the table is in design 00 §6). A component that cannot be reached shows the reason, never a
version. A component without a version endpoint shows its running pod's image tag, labelled so.
Nodes come from `GET /api/v1/nodes` (ClusterRole `get,list nodes`). CI rule GLUE-4 fails any
typed-in version.

## LiteLLM → Langfuse through the Collector (option)
`observability.collector.litellmLangfuse` — see `docs/ops/litellm-otel-collector-filter.md`.

## Sizing
Requests 150m CPU / 640 Mi, limits 1.75 Gi in total, lowest platform priority class
(`sovereign-os-observability`): under memory pressure observability is evicted first.
