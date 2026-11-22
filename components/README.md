# components/

One folder per upstream component the OS deploys. **Only upstream material belongs here:**
an `UPSTREAM.md` naming the project, its licence and the exact pin (image digest or chart
version). No Dockerfile that adds layers, no templates, no scripts, no configuration.

Every component here must carry a licence allowed by `licenses/policy.json` (owner decision of 2026-11-22; the gate
reads `licenses/components.tsv`). Copyleft and source-available components are not added.

Everything we wrote — Helm templates, init jobs, policies, clients — lives in the chart or in
the tab that owns it. If a file here would contain our code, it is in the wrong place.

The images we build ourselves (os-ui, egress-proxy, web-fetch, mock-model, dbt,
dagster user code, data-runner, query-tool) are under `images/`, not here.

| Component | Licence |
|---|---|
| [Calico](calico/UPSTREAM.md) (acceptance harness only) | Apache-2.0 |
    | [ClickHouse](clickhouse/UPSTREAM.md) | Apache-2.0 |
| [Dagster](dagster/UPSTREAM.md) | Apache-2.0 |
| [Docling](docling/UPSTREAM.md) | MIT |
| [External Secrets Operator](external-secrets/UPSTREAM.md) | Apache-2.0 |
| [git + backup-tools packages](git/UPSTREAM.md) | GPL-2.0-only (git, separate process) · Apache-2.0 · MIT |
| [ingress-nginx](ingress-nginx/UPSTREAM.md) (cluster add-on, beside the chart) | Apache-2.0 |
| [kind](kind/UPSTREAM.md) (test clusters only) | Apache-2.0 |
| [Langfuse](langfuse/UPSTREAM.md) | MIT (core; the upstream `ee/` directory is commercially licensed and not enabled) |
| [LangGraph JS](langgraph/UPSTREAM.md) | MIT (in-process library, not a deployment) |
| [LiteLLM](litellm/UPSTREAM.md) | MIT |
| [MinIO](minio/UPSTREAM.md) | AGPL-3.0-or-later |
| [node-pg-migrate](node-pg-migrate/UPSTREAM.md) | MIT |
| [Open Policy Agent](opa/UPSTREAM.md) | Apache-2.0 |
| [OpenSearch](opensearch/UPSTREAM.md) | Apache-2.0 |
| [pg-boss](pg-boss/UPSTREAM.md) | MIT |
| [Apache Polaris (incubating)](polaris/UPSTREAM.md) | Apache-2.0 |
| [PostgreSQL (CloudNativePG)](postgresql/UPSTREAM.md) | PostgreSQL License (server) · Apache-2.0 (CloudNativePG operator) |
| [SeaweedFS](seaweedfs/UPSTREAM.md) (dev/CI S3) | Apache-2.0 |
| [Trino](trino/UPSTREAM.md) | Apache-2.0 |
| [Valkey](valkey/UPSTREAM.md) | BSD-3-Clause |
| [Vega-Lite + vl-convert](vega-lite/UPSTREAM.md) (file format; renderer in CI only) | BSD-3-Clause |
| [Velero](velero/UPSTREAM.md) | Apache-2.0 |
