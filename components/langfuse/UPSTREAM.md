# Langfuse

Upstream, unmodified. Nothing in this folder is ours — see the rule in `components/README.md`.

- **Licence:** MIT (core; the upstream `ee/` directory is commercially licensed and not enabled)
- **Source:** https://github.com/langfuse/langfuse
- **Pinned as:** Helm chart `langfuse` 1.5.36 (https://langfuse.github.io/langfuse-k8s)

**Why the OS ships it:** Run traces for the Monitoring tab. MIT is what permits offering the OS as a managed service.

The deployment that uses this pin lives in the chart
(`charts/sovereign-agentic-os/templates/`); any glue we wrote belongs there or in the
owning tab, never here.

## Server and SDK pins used by os-ui (WP-31)

| Piece | Version | Licence | Docs |
|---|---|---|---|
| Langfuse server (web + worker) | `langfuse/langfuse:3.194.1`, `langfuse/langfuse-worker:3.194.1` (the live version) | MIT outside `ee/` | https://langfuse.com/self-hosting/deployment/docker-compose |
| ClickHouse under it | `clickhouse/clickhouse-server:24.8@sha256:1ffa82ed…` (the live pin) | Apache-2.0 | https://langfuse.com/self-hosting/deployment/infrastructure/clickhouse |
| JS SDK, OpenTelemetry-based | `@langfuse/otel`, `@langfuse/tracing`, `@langfuse/client` 5.14.0 | MIT | https://langfuse.com/docs/observability/sdk/overview |
| OpenTelemetry for Node | `@opentelemetry/api` 1.9.0, `@opentelemetry/sdk-node` 0.223.0, `@opentelemetry/sdk-trace-base` 2.12.0, `@opentelemetry/core` 2.12.0, `@opentelemetry/exporter-trace-otlp-http` 0.223.0, `@opentelemetry/otlp-exporter-base` 0.223.0 | Apache-2.0 | https://opentelemetry.io/docs/languages/js/ |

- SDK v5 needs a self-hosted server ≥ 3.63.0 (3.194.1 qualifies); v6 needs ≥ 4.59.0, so v6 waits
  for the v4 server (https://langfuse.com/docs/observability/sdk/upgrade-path/).
- Trace ids: `createTraceId(seed)` is deterministic and W3C-shaped
  (https://langfuse.com/docs/observability/features/trace-ids-and-distributed-tracing).
- The tracing e2e harness `tests/langfuse/compose.yaml` is Langfuse's documented self-host
  compose (https://github.com/langfuse/langfuse/blob/v3.194.1/docker-compose.yml) pinned to the
  versions above.
- `@langfuse/langchain` (`CallbackHandler`) is not used: the engine's model calls and tools are
  not LangChain runnables, so it would only duplicate the node observations
  (`os-ui/ARCHITECTURE.md` "One trace per run").
