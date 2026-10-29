# components/

One folder per upstream component the OS deploys. **Only upstream material belongs here:**
an `UPSTREAM.md` naming the project, its licence and the exact pin (image digest or chart
version). No Dockerfile that adds layers, no templates, no scripts, no configuration.

Everything we wrote — Helm templates, init jobs, policies, clients — lives in the chart or in
the tab that owns it. If a file here would contain our code, it is in the wrong place.

The images we build ourselves (os-ui, agent-runtime, egress-proxy, web-fetch, mock-model, dbt,
dagster user code, data-runner, query-tool) are under `images/`, not here.

| Component | Licence |
|---|---|
    | [ClickHouse](clickhouse/UPSTREAM.md) | Apache-2.0 |
| [Dagster](dagster/UPSTREAM.md) | Apache-2.0 |
| [Docling](docling/UPSTREAM.md) | MIT |
| [Langfuse](langfuse/UPSTREAM.md) | MIT (core; the upstream `ee/` directory is commercially licensed and not enabled) |
| [LiteLLM](litellm/UPSTREAM.md) | MIT |
| [MinIO](minio/UPSTREAM.md) | AGPL-3.0-or-later |
| [Open Policy Agent](opa/UPSTREAM.md) | Apache-2.0 |
| [OpenSearch](opensearch/UPSTREAM.md) | Apache-2.0 |
| [Apache Polaris (incubating)](polaris/UPSTREAM.md) | Apache-2.0 |
| [PostgreSQL (CloudNativePG)](postgresql/UPSTREAM.md) | PostgreSQL License (server) · Apache-2.0 (CloudNativePG operator) |
| [Trino](trino/UPSTREAM.md) | Apache-2.0 |
| [Valkey](valkey/UPSTREAM.md) | BSD-3-Clause |
