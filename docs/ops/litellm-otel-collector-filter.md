# LiteLLM → Collector → Langfuse, with the orphan-span filter (option, off by default)

> **UNSAFE TODAY — KEEP IT OFF.** Do not set `observability.collector.litellmLangfuse.enabled`
> or `dropOrphanSpans` in any environment until both items below are fixed
> (`scripts/check-observability-chart.mjs` fails a render that switches it on):
> 1. **Generations would be dropped silently.** Many OS calls reach LiteLLM without a
>    `traceparent`, so their generation is a root span and the filter drops it, with its usage and
>    cost: embeddings (`tabs/knowledge/lib/embed.ts`, `tabs/files/lib/embed.ts`), `/api/classify`,
>    and every virtual-key call through the LLM Gateway, the tool SSO and MCP. Only
>    `core/runtime/runtime.ts` sends `traceparent` (via `gatewayTraceHeaders`).
> 2. **The export would be blocked.** Langfuse's ingress policy (`langfuse-web-allow-os-only`)
>    admits os-ui, os-ui-worker, litellm and langfuse-worker — not the Collector.
>
> Before it could be used: match the poll spans themselves (for example
> `IsRootSpan() and IsMatch(name, "^postgres\\.")`, or root spans without `gen_ai.*`
> attributes) instead of every root span, and add the Collector to the Langfuse allow-list.
> WP-32's `llm_only` span scope is the safe way to avoid the idle traces today.

**Who this is for:** an operator running LiteLLM ≥ 1.109 with the `langfuse_otel` callback and
`LITELLM_OTEL_LANGFUSE_SPAN_SCOPE=full` (WP-32), who sees LiteLLM's background jobs land in
Langfuse as a stream of one-span traces.

## Why
Under span scope `full`, LiteLLM 1.109.1 exports every span of a request to Langfuse — which is
what nests the gateway's GENERATION under the caller's trace — and also its background jobs
(database polls, spend writes). Those jobs have no parent, so each one starts its own trace:
about 0.67 traces per second idle in WP-32's test rig. LiteLLM has no setting that keeps them
out of the operator's own export (WP-32, `components/litellm/UPSTREAM.md`).

The OpenTelemetry Collector's `filter` processor can drop them on the way: a span from LiteLLM's
service **with no parent** is dropped; every span of a call made with a W3C `traceparent` has a
parent and passes.

## How it works
- LiteLLM's Langfuse OTel exporter posts to `<LANGFUSE_OTEL_HOST>/api/public/otel/v1/traces`.
  Pointing `LANGFUSE_OTEL_HOST` at a collector is a documented deployment choice (LiteLLM
  `integrations/otel/presets/destinations.py`: "an internal collector there is a deployment
  choice").
- The Collector listens on port 4319 at exactly that path (`traces_url_path`), keeps the request's
  `Authorization` header (`include_metadata` + `batch.metadata_keys`) and forwards it to Langfuse
  (`headers_setter`). **The Collector holds no Langfuse key.**
- With `dropOrphanSpans: true`, the pipeline runs
  `filter: resource.attributes["service.name"] == "litellm" and IsRootSpan()`.

## Turn it on
```yaml
observability:
  collector:
    litellmLangfuse:
      enabled: true
      dropOrphanSpans: true
litellm:
  envVars:
    LANGFUSE_OTEL_HOST: http://otel-collector:4319
```
Rollback: remove both blocks (LiteLLM exports to Langfuse directly again).

## The caveat
A model call that arrives **without** `traceparent` is a root span too, so its generation is
dropped as well — see the warning at the top: today that is embeddings, classify and every
virtual-key call.

## Proof (of the mechanism only — not of safety)
`tests/observability/litellm-filter/run.sh on` and `run.sh off` (the negative twin) on the real
LiteLLM 1.109.1 and the chart-rendered Collector. With the filter on, no parentless LiteLLM span
arrives in 30 s of idling and a traced generation arrives nested under its caller; with it off,
the idle poll spans arrive.
