# LiteLLM

Upstream, unmodified. Nothing in this folder is ours — see the rule in `components/README.md`.

- **Licence:** MIT (outside the upstream `enterprise/` directory, which the OS does not use)
- **Source:** https://github.com/BerriAI/litellm
- **Pinned as:**
  - Helm chart `litellm-helm` **1.109.1** (oci://ghcr.io/berriai);
  - image `ghcr.io/berriai/litellm-database:1.109.1@sha256:932c54440654f8f8466a85887612d95dcfb04ae2fc01257844332f4bf3b96986`
    (values.yaml `litellm.image`; the digest is authoritative). Signed by the upstream release
    workflow: `cosign verify --certificate-identity https://github.com/BerriAI/project-releaser/.github/workflows/release.yml@refs/heads/main --certificate-oidc-issuer https://token.actions.githubusercontent.com <image>`.

**Why the OS ships it:** The only model gateway: virtual keys, budgets, routing to the configured provider, and the one Langfuse generation per model call.

## Why 1.109.1 (chosen 2026-11-20)

- **≥ 1.109.0** is the baseline of LiteLLM's `langfuse_otel` migration guide
  (https://docs.litellm.ai/docs/observability/langfuse_to_otel_v2_migration, "Prepare"). The
  legacy `langfuse` callback is what Langfuse v4 drops (10 F1).
- **Stable**, not `-rc`/`-dev` (https://github.com/BerriAI/litellm/releases).
- **Fixes the published advisories** that affect 1.90.0: GHSA-3cv6-jpf6-8222, GHSA-g5ff-637f-6q2m,
  GHSA-w4c7-34wj-hqm8, and GHSA-2rwg-2wh4-7c4f. 1.109.0 is still affected by the last one; its
  fix in the 1.109 line is 1.109.1.
- **Age:** published 2026-11-12 02:07 UTC. Under the programme's 14-day age rule the earliest
  deploy is **Thu 2026-11-26 02:07 UTC** (inside the 11 Dec deadline). No newer ≥ 1.109 release
  can be 14 days old before then; 1.109.2, 1.109.3 and 1.110.x (0–2 days old on 2026-11-20)
  are candidates for the next bump, through `scripts/tests/litellm-langfuse/run.sh` with
  `LITELLM_IMAGE=<ref>`.
- 1.108.12 (LTS, the earlier PR #104) is superseded: it is below the migration baseline.

## How the OS uses it for tracing (05 §5.1, 10 F1)

| Setting | Value | Source |
|---|---|---|
| `litellm_settings.callbacks` | `["langfuse_otel"]` | migration guide, step 2 |
| `success_callback` / `failure_callback` | never `langfuse` ("running both callbacks logs every request twice") | migration guide, step 2; gate `scripts/check-litellm-model-info.mjs` |
| `LITELLM_OTEL_V2` | `true` | https://docs.litellm.ai/docs/observability/opentelemetry_v2 |
| `LITELLM_OTEL_LANGFUSE_SPAN_SCOPE` | `full` (see "Span scope" below) | same page, "Send only the model calls to Langfuse" |
| `LITELLM_OTEL_BAGGAGE_PROMOTED_KEYS` | the default list without `gen_ai.request.model` and `litellm.provider.model` | same page, "Request identity on every span" |
| `LANGFUSE_HOST`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` | in-cluster Langfuse web; the gateway's own key pair (Secret `litellm-credentials`) | migration guide, "Default host" |
| message content | off (V2's default) plus `turn_off_message_logging: true` | migration guide, "Prompt capture" |
| nesting | W3C `traceparent` from the caller; `x-litellm-call-id` sets the call id | migration guide, "Field changes"; `os-ui/core/runtime/gateway-trace.ts` |

### Span scope

10 F1 point 4 left this to the test. Measured on 1.109.1 with a caller span sent first and the call
made with its `traceparent`:

| Scope | GENERATIONs per call | Where the GENERATION sits | Other gateway observations |
|---|---|---|---|
| `llm_only` | 1 | in the caller's trace, but as a **root** (`parentObservationId: null`) — not under the caller's span | none |
| `full`, default baggage | **6** (request, route, cache and Redis spans are typed GENERATION too) | under the gateway request span, under the caller's span | — |
| `full`, baggage without the two model keys (**chosen**) | 1 | `chat <model>` → `POST /v1/chat/completions` → the caller's span | about 15 SPANs per call (auth, Postgres, Redis, route, cache), and LiteLLM's background database and cache work as traces of their own: 143 traces in 2 idle minutes in the test rig |

`full` is chosen because it is the only setting that nests the generation under the caller's span.
Its cost is ingestion volume into Langfuse (ClickHouse). If that volume is not acceptable, `llm_only`
is a one-line change (`litellm.envVars.LITELLM_OTEL_LANGFUSE_SPAN_SCOPE`) that keeps one generation
per call in the right trace but gives up the parent link; `tracing.e2e.test.ts` follows the scope
(under `llm_only` it asserts the root placement). The post-deploy rule: measure the untagged-trace
rate for 10 minutes with `deploy/langfuse-idle-rate.sh`; above 0.2 per second, switch to
`llm_only` (docs/ops/litellm-upgrade.md §1 step 7). Sampling (`parentbased_always_off`) is not
an option: it drops generations with the rest. Measured in the test rig with
`deploy/langfuse-idle-rate.sh 1` against the real Langfuse: `full` 0.667 untagged traces per second
(above the threshold, so the rig itself would switch); `llm_only` 0.000 per second. Under
`llm_only` the e2e test passes with the root placement (3/3). Production's rate is measured after
the deploy.

### Measured on 1.109.1 against Langfuse 3.194.1

`scripts/tests/litellm-langfuse/run.sh` (real images, the chart's rendered config and env, a stub
model provider): 

- one call through os-ui's `liteLlmCaller` → exactly one GENERATION `chat sovereign-default`,
  usage 1000 / 500 / 1500 (the provider's, once), `calculatedTotalCost` 0.000275 (the chart's
  `model_info` prices), `metadata.attributes["litellm.call_id"]` = the `x-litellm-call-id` the
  OS sent; the trace carries `userId`, `sessionId` and the `domain:` / `agent:` / `tab:` / `run:`
  tags from the request metadata; no prompt or completion text in any gateway observation;
- negative twin, `success_callback: ["langfuse"]` added: 2 GENERATIONs for one call
  (`litellm:<key alias>` from the legacy callback, as a root, and `chat <model>`) → the test fails;
- the OTLP export goes to `/api/public/otel/v1/traces` (protobuf) and already sends
  `x-langfuse-ingestion-version: 4`, so no `OTEL_EXPORTER_OTLP_TRACES_HEADERS` is set (10 F1 point 5);
- `/health/readiness/details` (admin key) reports `litellm_version: 1.109.1` and the loaded
  callback `LangfuseContentOpenTelemetryV2` (plus `LangfusePromptManagement` when the legacy
  callback is configured); plain `/health/readiness` no longer reports the version;
- a virtual key with `max_budget` 0.0004 serves its calls until the spend passes the budget and
  is then refused, which os-ui reads as `BudgetExceededError` (`isBudgetRejection` accepts the
  400, 422 and 429 forms; the HTTP status 1.109.1 uses was not recorded by the test).

Measured with the combined WP-31 + WP-32 code (`tests/langfuse/compose.yaml`, the real engine run
through `liteLlmCaller`, `os-ui/tabs/agents/lib/engine/tracing.e2e.test.ts`):

- every model call is one GENERATION `chat <model>` → `POST /v1/chat/completions` → the OS's
  `llm.<node>` span; `litellm.call_id` equals the span's `litellm_call_id`; the second-writer twin
  is red;
- **caller metadata is not exported**: with `LITELLM_OTEL_BAGGAGE_METADATA_KEYS` including
  `requester_metadata.node` (and a probe `requester_metadata.correlation_id`), neither attribute
  appeared on any span, with the master key or a virtual key, although the OTel v2 page documents
  it. So the chart does not set it, and run diagnostics attribute a generation to its agent through
  its `llm.<node>` ancestor instead;
- **1.109.1 refuses to start without a master key** (`UnsafeMasterKeyError`). The chart always sets
  one (`PROXY_MASTER_KEY`); the DB-less test stack sets `LITELLM_MASTER_KEY`.

`scripts/tests/litellm-langfuse/upgrade.sh` (1.90.0 → 1.109.1, a database with a key and spend):

- the 1.109.1 proxy on the un-migrated schema reports ready and refuses every call
  (`401 … column t.tpd_limit does not exist`) — hence the pre-migration step;
- the migration with 1.109.1 exits 0; the 1.90.0 proxy then runs on the new schema (chat 200,
  no schema errors) — the pre-migration window and the image-only rollback;
- the 1.109.1 proxy on the migrated database: the key, its spend and a call survive.

The deployment that uses this pin lives in the chart
(`charts/sovereign-agentic-os/templates/`); any glue we wrote belongs there or in the
owning tab, never here.
