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

## Who can reach it, what it reads, what it masks
- **Ingress allow-lists** (`templates/extensions/observability/network-policies.yaml`):
  VictoriaMetrics and VictoriaLogs admit only the Collector (the only writer) and os-ui (reads);
  the Collector admits only os-ui and os-ui-worker. Dagster code and run pods, apps and every
  other pod are refused. os-ui never calls a write or delete path (checked in CI).
- **Pod logs of the platform namespaces only** (`observability.collector.podLogs.namespaces`,
  default the release namespace). The user-apps namespace is refused at render time.
- **Secret masking** (`transform/redact_secrets`) on every record before it is stored:
  `Bearer`/`Basic` credentials, `sk-…`/`pk-…` keys, `password=`/`token:`-style pairs, URL
  passwords; a field whose name says secret (`password`, `token`, `authorization`, …) is dropped.
- Checked on the rendered chart by `scripts/check-observability-chart.mjs` (twins in
  `scripts/tests/check-observability-chart.test.mjs`) and enforced on kind in
  `tests/observability/stack.int.test.mjs`.

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
os-ui shows its own running pod's image tag (else `OS_VERSION`, which the chart sets from that tag;
else "unknown"). VictoriaMetrics/VictoriaLogs show the version their binary states, verbatim.
Nodes come from `GET /api/v1/nodes` (ClusterRole `get,list nodes`). CI rule GLUE-4 fails any
typed-in version.

## LiteLLM → Langfuse through the Collector (option)
`observability.collector.litellmLangfuse` — see `docs/ops/litellm-otel-collector-filter.md`.

## Sizing
Requests 150m CPU / 640 Mi, limits 1.25 Gi in total (VictoriaLogs 512 Mi), lowest platform priority class
(`sovereign-os-observability`): under memory pressure observability is evicted first.
