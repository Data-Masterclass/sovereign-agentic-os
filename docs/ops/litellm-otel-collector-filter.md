# LiteLLM → Collector → Langfuse, with the orphan-span filter (option, off by default)

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
dropped as well. Before WP-31 every call was like that; after it, calls outside a run (for
example a direct API call by a user) still are. Turn the filter on only where every call that
matters carries a `traceparent`, or prefer `llm_only` (WP-32's shipped default) if not.

## Proof
`tests/observability/litellm-filter/run.sh on` and `run.sh off` (the negative twin) on the real
LiteLLM 1.109.1 and the chart-rendered Collector. With the filter on, no parentless LiteLLM span
arrives in 30 s of idling and a traced generation arrives nested under its caller; with it off,
the idle poll spans arrive.
