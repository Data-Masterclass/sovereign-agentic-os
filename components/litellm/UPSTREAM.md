# LiteLLM

Upstream. Nothing in this folder is ours — see the rule in `components/README.md`. Our image carries
one documented patch to MIT core (`images/extensions/litellm-oss/patches/`), unrelated to the
enterprise code.

- **Licence:** MIT (outside the upstream `enterprise/` directory, which the OS does not ship)
- **Source:** https://github.com/BerriAI/litellm
- **Pinned as:**
  - Helm chart `litellm-helm` **1.109.1** (oci://ghcr.io/berriai);
  - image (from 2026-11-24): **our own** `ghcr.io/data-masterclass/sovereign-os/litellm-oss`, built in
    `images/extensions/litellm-oss` from the MIT `litellm==1.109.1` wheel **without** the proprietary
    `litellm-enterprise` package — see `docs/components/litellm-oss.md` (what is in it, every enterprise
    import site and how it behaves, the one patch, the licence gate, rollback). values.yaml
    `litellm.image`; the digest is authoritative.
  - the upstream image it replaces, kept as the rollback target
    (`deploy/overlays/litellm-upstream-image.yaml`):
    `ghcr.io/berriai/litellm-database:1.109.1@sha256:932c54440654f8f8466a85887612d95dcfb04ae2fc01257844332f4bf3b96986`.
    Signed by the upstream release workflow: `cosign verify --certificate-identity https://github.com/BerriAI/project-releaser/.github/workflows/release.yml@refs/heads/main --certificate-oidc-issuer https://token.actions.githubusercontent.com <image>`.

**Why the OS ships it:** The only model gateway: virtual keys, budgets, routing to the configured provider, and the one Langfuse generation per model call.

## Why 1.109.1 (chosen 2026-11-20)

- **≥ 1.109.0** is the baseline of LiteLLM's `langfuse_otel` migration guide
  (https://docs.litellm.ai/docs/observability/langfuse_to_otel_v2_migration, "Prepare"). The
  legacy `langfuse` callback is what Langfuse v4 drops (10 F1).
- **Stable**, not `-rc`/`-dev` (https://github.com/BerriAI/litellm/releases).
- **Fixes the published advisories** that affect 1.90.0: GHSA-3cv6-jpf6-8222, GHSA-g5ff-637f-6q2m,
  GHSA-w4c7-34wj-hqm8, and GHSA-2rwg-2wh4-7c4f. 1.109.0 is still affected by the last one; its
  fix in the 1.109 line is 1.109.1.
- **Published 2026-11-12.** 1.109.2, 1.109.3 and 1.110.x (0–2 days old on 2026-11-20) are
  candidates for the next bump, through `scripts/tests/litellm-langfuse/run.sh` with
  `LITELLM_IMAGE=<ref>`.
- 1.108.12 (LTS, the earlier PR #104) is superseded: it is below the migration baseline.

## How the OS uses it for tracing (05 §5.1, 10 F1)

| Setting | Value | Source |
|---|---|---|
| `litellm_settings.callbacks` | `["langfuse_otel"]` | migration guide, step 2 |
| `success_callback` / `failure_callback` | never `langfuse` ("running both callbacks logs every request twice") | migration guide, step 2; gate `scripts/check-litellm-model-info.mjs` |
| `LITELLM_OTEL_V2` | `true` | https://docs.litellm.ai/docs/observability/opentelemetry_v2 |
| `LITELLM_OTEL_LANGFUSE_SPAN_SCOPE` | `llm_only` (see "Span scope" below) | same page, "Send only the model calls to Langfuse" |
| `LITELLM_OTEL_BAGGAGE_PROMOTED_KEYS` | not set under `llm_only`; under `full` the default list without `gen_ai.request.model` and `litellm.provider.model` (gate rule 8) | same page, "Request identity on every span" |
| `LANGFUSE_HOST`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` | in-cluster Langfuse web; the gateway's own key pair (Secret `litellm-credentials`) | migration guide, "Default host" |
| message content | off (V2's default) plus `turn_off_message_logging: true` | migration guide, "Prompt capture" |
| nesting | W3C `traceparent` from the caller; `x-litellm-call-id` sets the call id | migration guide, "Field changes"; `os-ui/core/runtime/gateway-trace.ts` |

### Span scope

10 F1 point 4 left this to the test. Measured on 1.109.1 with a caller span sent first and the call
made with its `traceparent`:

| Scope | GENERATIONs per call | Where the GENERATION sits | Other gateway observations |
|---|---|---|---|
| `llm_only` (**chosen**) | 1 | in the caller's trace, but as a **root** (`parentObservationId: null`); joined to the caller's span by the call id | none: 0 background traces per second |
| `full`, default baggage | **6** (request, route, cache and Redis spans are typed GENERATION too) | under the gateway request span, under the caller's span | — |
| `full`, baggage without the two model keys (needs WP-05) | 1 | `chat <model>` → `POST /v1/chat/completions` → the caller's span | about 15 SPANs per call (auth, Postgres, Redis, route, cache), and LiteLLM's background database and cache work as traces of their own: 143 traces in 2 idle minutes in the test rig |

**`llm_only` is chosen** (changed from `full` on 2026-11-20 after the idle-rate check):

- Under `full`, LiteLLM exports its own background database and cache polls (`postgres.select
  LiteLLM_Config`, `postgres.ping`, `redis.set config_params`, …) as trace roots with no parent
  context: 0.667 per second idle in the test rig, against a 0.2 per second budget.
- 1.109.1 has **no setting that keeps them from the operator's own exporter** (read in its
  source, `litellm/integrations/otel`):
  - `LITELLM_OTEL_EXCLUDED_SERVICES` / `callback_settings.otel.excluded_services` withholds
    datastore spans from key/team destinations only ("the operator's own exporters still receive
    them");
  - the sampling rates are per destination (Arize);
  - `OTEL_PYTHON_FASTAPI_EXCLUDED_URLS` covers HTTP routes, not background work;
  - an OTel sampler would drop generations too and is not used.
- Under `llm_only` the background rate is 0 (measured) and every call is still exactly one
  GENERATION in the caller's trace. The OS joins it to the `llm.<node>` span that made the call by
  the call id (`litellm.call_id` = the span's `litellm_call_id`); run diagnostics attribute per-agent
  cost that way (`run-diagnostics.ts`). What is given up: Langfuse's tree does not show the
  generation under the span.
- **Back to `full` (true nesting) only with an OTel Collector filter: WP-05** (below).

#### What WP-05 (OTel Collector) must do before the scope may go back to `full`

1. Run `otel/opentelemetry-collector-contrib` (pinned by digest) in the namespace, with an OTLP HTTP
   receiver whose traces path is `/api/public/otel/v1/traces`. Point the gateway at it with
   `LANGFUSE_OTEL_HOST` (LiteLLM's documented override; it appends `/api/public/otel`).
2. Export with `otlphttp` to `http://agentic-os-langfuse-web:3000/api/public/otel`, forwarding the
   gateway's `Authorization` (Basic, the gateway key pair) and `x-langfuse-ingestion-version: 4`
   (`headers_setter` extension, or static headers from a Secret).
3. Add a `filter` processor that drops LiteLLM's datastore spans, the background polls included:
   OTTL `span: attributes["db.system.name"] != nil`. It must NOT drop root spans in general: a call
   without a caller `traceparent` has the gateway's request span as its root and the generation's
   parent. Verify the attribute name on 1.109.1's spans in WP-05's own test before relying on it.
4. Then set `LITELLM_OTEL_LANGFUSE_SPAN_SCOPE: "full"` with `LITELLM_OTEL_BAGGAGE_PROMOTED_KEYS`
   without `gen_ai.request.model` and `litellm.provider.model` (gate rule 8). Then run:
   - `scripts/tests/litellm-langfuse/run.sh` with the collector in the path, plus
     `tests/langfuse/compose.yaml`; both e2e tests switch to the nesting assertions by themselves;
   - `deploy/langfuse-idle-rate.sh`, which must report ≤ 0.2 per second.
5. Rollback: scope back to `llm_only` and `LANGFUSE_OTEL_HOST` unset (direct export again).

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

## Provider setup APIs (Models & Providers flow)

Read from the 1.109.1 image's own `/openapi.json` and exercised by `scripts/tests/llm-providers/run.sh`:
`GET /public/providers/fields`, `POST|GET /credentials` (`credential_values` encrypted with
`LITELLM_SALT_KEY`; values masked on read), `POST /health/test_connection`, `GET
/public/litellm_model_cost_map`, `POST /model/new` with `litellm_credential_name` and
`model_info.access_groups`, and a virtual key whose `models` names the access group. Proxy env:
`HTTP(S)_PROXY`/`NO_PROXY` honoured by the gateway's provider calls (shown against tinyproxy);
`LITELLM_LOCAL_MODEL_COST_MAP=True` (the bundled price map, no fetch at start).
Docs: https://docs.litellm.ai/docs/proxy/model_access_groups, https://docs.litellm.ai/docs/providers,
https://docs.litellm.ai/docs/providers/azure/azure, https://docs.litellm.ai/docs/providers/ollama.

## Delete domain (2026-11-20)

Admin API, master key: `GET /team/list`, `GET /key/list`, `POST /team/delete {team_ids}`,
`POST /key/delete {keys}` (https://docs.litellm.ai/docs/proxy/team_based_routing,
https://docs.litellm.ai/docs/proxy/virtual_keys). Run against the pinned image with its own
Postgres in `tests/domain-delete`.
