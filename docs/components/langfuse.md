# Langfuse — observability & tracing

**What it is:** Langfuse v3 (MIT) is the trace store of the OS. Since the engine rebuild (A3)
the OS uses it the way an engineer would: **one trace per agent run, trace id = run id**, with
the graph's nodes as spans, every model call as a generation with token usage, every tool call
as a span carrying the governance decision, and the LLM-judge verdict as a score on that trace.
Backed by Postgres (metadata), ClickHouse (analytics), Valkey (queue) and MinIO (event blobs).

## Not reachable from the internet

Langfuse has **no public route** unless an operator turns on the protected operators' route
(below). It holds every prompt, completion and tool
result of every run behind a single login, and nothing outside the cluster needs it: os-ui, the
worker and the gateway send traces to the in-cluster Service `agentic-os-langfuse-web:3000`
(`LANGFUSE_URL`, `LANGFUSE_HOST`), and the OS reads traces back the same way.

* `ingress.hosts.langfuse` alone renders nothing — also for a release whose values still carry
  the hostname. The route needs `ingress.restricted.langfuse.expose: true` **and** a protection
  annotation (the render fails without one); see `docs/components/litellm.md` for the shape.
  `scripts/check-consoles-not-public.mjs` enforces it in `gate.sh`.
* **Trace links.** With no route the chart gives the OS an **empty** `LANGFUSE_CONSOLE_URL`, and
  every "open in Langfuse" affordance disappears instead of pointing at a dead host: the Run
  panel's "Full trace" link, `traceUrl` from `run_agent_system` / `get_agent_run` /
  `resume_agent_run` (absent), Monitoring's run rows and "Langfuse traces" link, the Components
  page's "Open" button, and the engineering view (which says the trace exists but has no address
  here). A run recorded while the console was public no longer shows its stored link either: the
  address is derived from the current console URL. What stays in the OS, for everyone it is
  meant for: the Run panel's own steps and Monitoring's own trace reads.
* **Why there is no in-OS view.** Langfuse cannot be embedded through the OS tool proxy: it is a
  Next.js app whose assets and API calls are root-absolute and collide with the OS's own routes
  (`core/infra/tool-proxy.ts`, `ownTab`). The entry therefore shows "opens in its own tab" with
  no button when the console has no address.
* **Operator access:**
  ```bash
  kubectl -n agentic-os port-forward svc/agentic-os-langfuse-web 3000:3000   # http://localhost:3000
  ```
  Langfuse redirects to its own base URL after sign-in
  (`langfuse.langfuse.nextauth.url`; the STACKIT profile now sets `http://localhost:3000`). **A
  release that still carries the old public value there keeps redirecting to the removed host**
  until that value is changed — not verified on a cluster. If operators need the console from
  their desks, publish it behind an IP allowlist with the opt-in above and set
  `nextauth.url` to that host in the same overlay.
* **The operators' browser route** (`ingress.restricted.langfuse.operatorIngress.enabled`, OFF
  by default and in the STACKIT profile; `values.dev.yaml` turns it on). The Langfuse web UI gets
  an Ingress on `ingress.hosts.langfuse`, protected exactly like the Dagster console: nginx basic
  auth from an htpasswd Secret (`operatorIngress.basicAuthSecret`, default `langfuse-basic-auth`,
  key `auth`; ingress-nginx answers 503 while it is missing). Langfuse's own login stays behind
  it — the OS runs no OIDC provider Langfuse could use for SSO
  (https://langfuse.com/self-hosting/security/authentication-and-sso). The render fails unless
  `langfuse.langfuse.nextauth.url` is `https://<that host>` ("Public URL of your Langfuse web
  deployment", https://langfuse.com/self-hosting/configuration). With the route on, the chart
  derives `LANGFUSE_CONSOLE_URL` from the same host, so the Run panel's trace link and each
  Monitoring run row open that run's trace there. Create the Secret (password from a file you
  keep, never on a command line):
  ```bash
  kubectl -n agentic-os create secret generic langfuse-basic-auth \
    --from-literal=auth="operator:$(openssl passwd -apr1 -in <password-file>)"
  ```
  `scripts/tests/langfuse-operator-ingress.test.sh` (render) and
  `scripts/tests/app-ingress-admission.kind.sh` (real ingress-nginx: admission and 401/200) test it.

* **Sign-up is off** (`langfuse.langfuse.features.signUpDisabled: true`, i.e.
  `AUTH_DISABLE_SIGNUP=true`): only existing users can sign in, and an invite cannot create an
  account. The OS's own user, org, project and API keys come from headless initialisation
  (`LANGFUSE_INIT_*` in the `langfuse-init` Secret), which creates them directly at start-up and
  does not go through sign-up. To add another console user, set `signUpDisabled: false` in a
  private overlay for the time it takes them to register, then set it back.
  Docs: <https://langfuse.com/self-hosting/security/authentication-and-sso>,
  <https://langfuse.com/self-hosting/administration/headless-initialization>.
* **NetworkPolicy** `langfuse-web-allow-os-only`
  (`templates/base/langfuse/web-ingress-policy.yaml`): the web pod accepts TCP 3000 only from
  os-ui, os-ui-worker, LiteLLM and the Langfuse worker — plus the ingress controller's namespace
  when the console is published with the opt-in above. `kubectl port-forward` is unaffected.
  Rendered with `networkPolicies.defaultDeny`; `networkPolicies.langfuseWeb: false` turns this
  one policy off. `scripts/tests/langfuse-hardening.test.sh` checks both settings.

**After upgrading a cluster that had the route:** Helm deletes `agentic-os-langfuse-web-ingress`
(and any annotation added to it by hand) and its Certificate; the TLS Secret
`langfuse.<zone>-tls` and the DNS record remain and can be removed by hand.

## What ships (and where in the code)

| Concern | Where | What |
|---|---|---|
| The one writer | `os-ui/core/infra/langfuse.ts` | the official OpenTelemetry-based Langfuse JS SDK v5 (`@langfuse/otel`, `@langfuse/tracing`, `@langfuse/client` 5.14.0): `NodeSDK` + `LangfuseSpanProcessor` (in-cluster `baseUrl`, `osMask`, `shouldExportSpan` = `exportOsSpan`), `withRunTrace`, `recordObservation`, `traceUrlFor`, `scoreTrace`, `readObservations`. No other os-ui file imports a Langfuse package or names a Langfuse write endpoint (`core/infra/writers.test.ts`) |
| Port and redaction | `os-ui/core/infra/trace-port.ts` | `RunObserver` / `SpanHandle` (what the engine reports into), `noopObserver`, `redactRequest` / `redactCompletion` / `boundedResult`, `runTraceTags`, `runSessionId` |
| Node instrumentation | `os-ui/tabs/agents/lib/engine/build-graph.ts` `observed(...)` | every `plan_/act_/tools_/route_<id>` node is a `chain` observation; the model caller handed to the node wraps each call in a `llm.<node>` span; `tools_<id>` records `tool` observations |
| Governed calls | `core/infra/agent-governed.ts`, `core/infra/governed.ts`, `tabs/knowledge/lib/knowledge-trace.ts` | through `recordObservation` only. Under a run the run's observer writes the tool observation, so an agent tool call is not written twice; a data tool or a context pack nests in the active observation, or is its own small trace outside one. The governance audit is NOT mirrored to Langfuse: audit lives in the OS audit store |
| Gateway nesting | `os-ui/core/runtime/runtime.ts` `liteLlmCaller`, `core/runtime/gateway-trace.ts` | LiteLLM ≥ 1.109 records the call's generation through its OTel v2 `langfuse_otel` callback. Every call sends `x-litellm-call-id` (the `llm.<node>` span records it as `litellm_call_id`) and a W3C `traceparent` built from the `llm.<node>` span's OTel ids, so the generation nests under that span (via the gateway's request span; `components/litellm/UPSTREAM.md` "Span scope"). Also sent: `trace_user_id` (bare uid), `session_id` (`system:<id>`), the tags. The legacy `existing_trace_id` / `parent_observation_id` are ignored on V2 and are not sent |
| Scores | `app/api/agents/systems/[id]/evaluate/route.ts` | the judge verdict → `score.create { traceId: createTraceId(runId), name: 'judge', value: overall, comment }` |
| Reads | `app/api/agents/systems/[id]/run/diagnostics/route.ts` | observations **by trace id** (`createTraceId(runId)`) — only after `assertRunVisible` says that run is the caller's and this system's. Without a run id, by the caller's user id AND a time window. `observationsQuery` refuses anything looser (typed error) |
| Deep link | `LastRun.traceUrl`, MCP `run_agent_system` / `get_agent_run` / `resume_agent_run` | `${LANGFUSE_CONSOLE_URL}/trace/<createTraceId(runId)>`; a run traced before the OTel writer (20 Nov 2026) links to its raw run id when only that trace exists (one bounded lookup) |
| Per-agent cost | `run-diagnostics.ts` `attributeNode`, `langfuse.ts` `readTraceObservations` | diagnostics read the run's whole trace and attribute each gateway generation to the agent on its `llm.<node>` ancestor (`metadata.node`). LiteLLM 1.109.1 OTel v2 puts no caller metadata on the generation (measured; `LITELLM_OTEL_BAGGAGE_METADATA_KEYS` `requester_metadata.*` exported nothing). `liteLlmCaller` still sends `metadata.node` for a gateway rolled back to the legacy callback |
| Credentials | `core/kernel/config.ts`, chart `soa.osUI.env` / `adminEnv` | no built-in key or console login: the project keys and `LANGFUSE_SSO_EMAIL` / `LANGFUSE_SSO_PASSWORD` (web only, from `langfuse-init` `LANGFUSE_INIT_USER_*`) come from the chart; a production boot without them stops with `MissingLangfuseCredentialError` |

## The trace tree

One model call has exactly ONE generation, and the gateway writes it (design 05 §5.1). The app
exports no generation: `exportOsSpan` drops any span typed `generation` before export.

```
trace  id = createTraceId(runId) · name = run <system name> · userId = <runner uid> · sessionId = system:<systemId>
       tags = domain:<d> · agent:<systemId> · system:<systemId> · run:<runId> · engine:langgraph [· env:<word>]
(fixed root span id = createTraceId('root:'+runId)[0:16], never exported: every segment hangs on it)
└── agent run <system name>        input = { task }        (a RESUME adds a sibling `run segment`)
    ├── chain plan_<agent>         metadata { agent, kind:'plan', visit, stepsUsed }
    │   └── span llm.plan_<agent>  input = roles + char counts · output = { chars, toolCalls }
    │       └── span POST /v1/chat/completions (the gateway's request span, nested by traceparent)
    │           └── generation chat <model> (LiteLLM langfuse_otel: usage, cost, model; no content)
    ├── chain act_<agent>
    │   └── span llm.act_<agent>
    │       └── generation (gateway)
    ├── chain tools_<agent>
    │   └── tool tool.<name>  input { tool, callId, args } · metadata { decision, approvalId }
    │       └── retriever knowledge.context_pack / tool data.<tool>   (nested by OTel context)
    ├── chain route_<agent>
    └── event run.result     output { reachedEnd, parked, interrupted, failed, path, finalChars, stepsUsed }
```

A held write ends `tools_<agent>` as `parked` (statusMessage) with a `tool.<name>` span whose
decision is `held`; the decision in Governance resumes the thread and the next segment's spans
reference the same trace id.

**Redaction — two levels, one switch.** `LANGFUSE_REDACTION` (chart: `osUI.langfuseRedaction`;
code: `config.langfuseRedaction`, applied in `os-ui/core/infra/trace-port.ts`):

| Level | Message content | Tool-call arguments | Tool result |
|---|---|---|---|
| `structure` (default) | role + character count, never the text | **kept whole** (names, ids, the argument object) | character count **+ a 160-character preview** |
| `strict` | role + character count, never the text | argument **key names** and the character count of each value — no values | character count only, **no preview** |

Pick `strict` when tool arguments can carry personal data (a query predicate with an identifier,
a document body, a customer name): the trace still shows which tool ran with which fields, which
is what a debugging session needs, without the values. The level is recorded on the `llm.<node>`
span (`input.redaction`) and on each tool observation (`metadata.redaction`), so a trace always
says how it was written.

**What the gateway writes.** Since LiteLLM 1.109.1 the gateway writes through its
OpenTelemetry v2 `langfuse_otel` callback (`LITELLM_OTEL_V2=true`): the call's only generation,
nested under the OS's `llm.<node>` span by `traceparent` (through the gateway's request span), with
**no message content** (V2's default; `turn_off_message_logging` stays on). `mask_output` and the
legacy nesting fields are ignored on V2; what the gateway sends and how it nests is measured in
`components/litellm/UPSTREAM.md`. The paragraphs below describe the legacy `langfuse` callback of
1.90.0, which is what a rollback returns to. It is the gateway's record of the call — usage, cost, model, latency, tags — and since 2026-11-19 it
carries **no prompt and no completion** (owner decision: no document or image content in traces
by default, the gateway's records included):

* `litellm.proxy_config.litellm_settings.turn_off_message_logging: true` (chart default). LiteLLM
  replaces the request messages with one `{"role":"user","content":"redacted-by-litellm"}` and
  the completion text with `redacted-by-litellm` **before** any callback runs. An image or a
  document part is inside the messages, so it goes with them.
* The OS sends `metadata.mask_output: true` on every run-path call
  (`core/runtime/runtime.ts`). On LiteLLM 1.90 the setting above leaves the completion's
  **tool-call arguments** in the logged output — model-written values that can quote a document.
  The mask replaces the whole logged output. The caller still receives the full response.
* `general_settings.store_prompts_in_spend_logs: false` — the gateway's Postgres spend logs keep
  metadata only (`messages: {}`, `response: {}`).
* **No `failure_callback: ["langfuse"]`.** When the proxy itself refuses a request — a rate
  limit, a spent budget, a model outside the key's list — LiteLLM logs the request body as the
  generation's *model parameters*, and the redaction switch does not reach that copy: the full
  system and user prompt of every refused call was written to Langfuse. A rate-limited run is
  the run with the most documents in it. The chart therefore does not register the callback for
  failures. The OS records a refused or failed call on its own span, at its own redaction level,
  so the event is still in the run's trace; what is gone is the gateway's duplicate, and with
  it the gateway's record of calls that failed **upstream**.

Measured on LiteLLM 1.90.0 with the chart's rendered config and a recording Langfuse endpoint
(markers placed in the system prompt, the user message, the completion, a tool-call argument and
a tool description):

| | system / user prompt | completion text | tool-call arguments | tool definitions | usage + cost |
|---|---|---|---|---|---|
| before | logged | logged | logged | logged | usage only (cost 0, unpriced) |
| `turn_off_message_logging` | **absent** on a served call; **logged in full on a refused call** | **absent** | logged | logged | logged |
| + `mask_output` (run path) | as above | **absent** | **absent** | logged | logged |
| + no failure callback (now) | **absent** | **absent** | **absent** | logged | logged |

Per kind of call, with redaction on (the same on 1.90.0 and 1.108.12):

| Call | with `failure_callback: ["langfuse"]` | without (now) |
|---|---|---|
| served | no content | no content |
| failed upstream (500) | no content; a failed generation is written | nothing written by the gateway |
| refused: rate limit (429) | **system and user prompt written** | nothing written |
| refused: model not on the key (403) | **system and user prompt written** | nothing written |
| refused: budget spent | **system and user prompt written** | nothing written |

What is still written, deliberately: the **tool definitions** of a call (names, descriptions,
parameter schemas — the system's static configuration, not user data), the model, token usage,
cost, the tags (`domain:` `agent:` `tab:` `run:`), `trace_user_id` / `session_id`, the key's
alias and hash, and the requester's IP address.

What it does not cover: a caller holding a gateway key can switch redaction off for its own
request with the header `litellm-disable-message-redaction: true`. Only the OS holds keys and it
never sends that header; treat a key as able to do this when you hand one out. To read real
prompts for one debugging session, use the Run panel (`run_events` holds them, see below) — not
the gateway. If you must see what the gateway forwarded, set `turn_off_message_logging: false`
through `VALUES_OVERLAY` for that session and set it back; the logged **output** stays masked.

`LANGFUSE_REDACTION=strict` reduces what the **OS** writes into its own generation and tool
spans; it is independent of the gateway settings above.

**`LANGFUSE_REDACTION` does not reach `run_events`.** The switch governs what the OS writes to
the TRACE. The run's own event log — `run_events` in the `agent_runs` database, the rows the Run
panel tails — is written unredacted by design: it IS the panel's stream, and a redacted
`node-completed` would show the user less than the page they are looking at. So the same tool
arguments and results a `strict` trace reduces to key names and character counts sit in full in
`run_events.data`, next to the LangGraph `checkpoints` in the same database. Treat the two as one
disclosure surface: anyone with read access to `agent_runs` sees raw run content regardless of
`LANGFUSE_REDACTION`.

**That exemption now has a retention answer.** `AGENT_RUNS_RETENTION_DAYS` (default 30, chart
`osUI.agentRunsRetentionDays`) bounds how long it lasts: a run that settled outside the window
loses its checkpoint thread, its `run_events` rows and its `run_jobs` row to a periodic sweep.
So `LANGFUSE_REDACTION` still decides what the trace SHOWS and retention decides how long the
unredacted copy EXISTS — they are different controls and both are needed. A `parked` run is
exempt at any age (its checkpoint is the only thing that can resume the approval), which is the
one place raw content is kept deliberately. See `docs/components/os-ui.md` →
"Retention for `agent_runs`".

PII in traces remains a checklist concern (A-section "PII handling"). The A13 follow-up — that
LangGraph checkpoints **and `run_events`** kept raw tool results with NO retention — is closed by
`AGENT_RUNS_RETENTION_DAYS` above; what remains open from it is the held approval ARGUMENTS, which
live in the approvals queue rather than in `agent_runs` and are not swept by this window.

## What the OS does NOT use

Prompts, datasets, dataset runs, evaluators and the public-trace flag are not used. Scores are
written for one thing (the judge). There is no per-domain Langfuse project: scoping is enforced
in the OS (every read filtered by run or user), and per-project RBAC is an `/ee` feature.

## Enterprise code in the upstream images

The chart runs the upstream images `langfuse/langfuse` and `langfuse/langfuse-worker` 3.194.1. Langfuse's
root `LICENSE` puts `ee/`, `web/src/ee/` and `worker/src/ee/` under the Langfuse Enterprise License; the
rest is MIT. **The upstream images contain that EE code, compiled** (container image licence audit
2026-11-24): the web server bundle and client chunks include `web/src/ee/features/*`, and the worker
imports `worker/src/ee/*` statically. There is no upstream OSS-only build. `packages/shared/src/server/ee/`
is outside those three directories, so the root `LICENSE` makes it MIT.

How the OS keeps EE code from running:

- **No licence key.** Neither `LANGFUSE_EE_LICENSE_KEY` nor `NEXT_PUBLIC_LANGFUSE_CLOUD_REGION` is set, so
  `isEnterpriseLicenseAvailable()` is false and the web EE features stay off (the runtime gate upstream uses).
- **Worker EE queue consumers off** (`langfuse.langfuse.worker.pod.additionalEnv` in `values.yaml`). The
  data-retention consumer is the one that ran before: upstream registers it whenever
  `QUEUE_CONSUMER_DATA_RETENTION_QUEUE_IS_ENABLED` is `"true"`, its default. The others also need Stripe or
  cloud settings; they are set off so no future default turns them on.

  | Flag (`"false"`) | Handler under `worker/src/ee/` |
  |---|---|
  | `QUEUE_CONSUMER_DATA_RETENTION_QUEUE_IS_ENABLED` | `dataRetention` |
  | `QUEUE_CONSUMER_CLOUD_USAGE_METERING_QUEUE_IS_ENABLED` | `cloudUsageMetering` |
  | `QUEUE_CONSUMER_CLOUD_SPEND_ALERT_QUEUE_IS_ENABLED` | `cloudSpendAlerts` |
  | `QUEUE_CONSUMER_FREE_TIER_USAGE_THRESHOLD_QUEUE_IS_ENABLED` | `usageThresholds` |
  | `LANGFUSE_POSTGRES_METERING_DATA_EXPORT_IS_ENABLED` | `meteringDataPostgresExport` |

  Effect: per-project data-retention settings (an EE feature, not settable without a licence) are not
  enforced. Nothing the OS uses depends on these queues. The batch retention cleaners
  (`LANGFUSE_BATCH_DATA_RETENTION_CLEANER_ENABLED`, `worker/src/features/`) are MIT and unaffected.
  Checked by `scripts/tests/langfuse-ee-queues-chart.test.sh` (default, STACKIT and dev profiles, with a
  negative twin).
- **Not redistributed by us.** The chart pulls the images from Docker Hub.

The upstream images still contain the EE code. **The chart now runs our own images instead,
`langfuse-oss`**, built without the EE directories, at the base path `/tools/langfuse`
(`docs/components/langfuse-oss.md`). The upstream images stay available as the rollback
(`deploy/overlays/langfuse-upstream-image.yaml`), with the worker queue flags above still applied.

## Access
```bash
kubectl -n agentic-os port-forward svc/agentic-os-langfuse-web 3000:3000
# http://localhost:3000/tools/langfuse/   (langfuse-oss serves under its base path; the upstream rollback image at /)
```
**Login:** `admin@datamasterclass.com` / `langfuse-local-dev-admin`

## How to use it
- **Open a run's trace** (only on a deployment that publishes the console — see "Not reachable from the internet"): the Run panel's "Full trace: open in Langfuse", or `traceUrl` from
  `run_agent_system` / `get_agent_run`. The link opens that one trace, never a list.
- **See what one agent spent:** filter traces by tag `agent:<systemId>`; one run by `run:<runId>`.
  The same vocabulary is what LiteLLM tags its spend with (`docs/components/litellm.md`).
- **API (server-side, project-scoped key):**
  ```bash
  curl -u pk-lf-localdev0000public:sk-lf-localdev0000secret \
    "http://localhost:3000/api/public/traces/<runId>"
  curl -u pk-lf-localdev0000public:sk-lf-localdev0000secret \
    "http://localhost:3000/api/public/scores?traceId=<runId>"
  ```

## Project keys (demo)
- Public: `pk-lf-localdev0000public`  ·  Secret: `sk-lf-localdev0000secret`
- Host (in-cluster): `http://agentic-os-langfuse-web:3000`
These are injected into os-ui (`LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` / `LANGFUSE_URL`)
and into LiteLLM (`callbacks: ["langfuse_otel"]` on OpenTelemetry v2; no `langfuse` in any callback list — see "What the gateway writes").

## Masking switch (Platform → Settings → Traces)

A platform admin can switch masking on for everything the OS sends to Langfuse. It is **off by
default**, which is today's behaviour. The switch is a platform setting (`langfuseMasking`,
`{ enabled, level }`), changed through the admin-only settings route, which is checked like every
other admin setting and writes an audit row with the new value. Server-side masking is a Langfuse
Enterprise feature and is **not** used; masking happens in the sender, with the upstream hooks:

| Where traces are written | Mechanism (upstream docs) | Applies |
|---|---|---|
| os-ui and the run worker (run, node, model-call, tool and standalone observations, scores) | Langfuse's `mask` option of `LangfuseSpanProcessor` ([masking](https://langfuse.com/docs/observability/features/masking)) scrubs every observation's input and output at export, and at level `content` reduces any text the writer did not already reduce; a processor in front of it applies the same policy to each metadata key and to status messages, which the SDK's `mask` is never given; at level `content` the writer also replaces text by sizes where it builds an observation | next export / next run segment, no restart |
| LiteLLM's `langfuse_otel` generation of each model call | LiteLLM's per-request header `x-litellm-enable-message-redaction: true` ([logging](https://docs.litellm.ai/docs/proxy/logging#redact-messages-response-content)), sent on every model call, from one shared helper (`core/adapters/litellm/gateway-fetch.ts`, guarded by a test), while masking is on or unknown | next model call, no restart |

Levels. `pii` replaces e-mail addresses, phone numbers, IBANs (mod-97 checked) and card numbers
(Luhn checked) with `[email]`, `[phone]`, `[iban]`, `[card]` and keeps the rest of the text. `content`
replaces every message, task, tool argument, tool result, error text and score comment by its size
(`{ redacted, chars }`); model, tokens, latency, cost, tool names, governance decisions, status,
tags, user and session stay, so Monitoring is unaffected.

Until the switch has been read. A pod that has just restarted, or a settings store that cannot be
read, does not know the switch yet. In that state the OS applies the strictest level (`content`) and
the redaction header, never the default "off", logs the fact, tags new run traces with
`masking: content (switch unknown)` and reports it in the settings read (`maskingStatus.known`).
The state ends at the next successful read of the store (retried every few seconds). A store that
answers "no settings saved yet" is a known answer: masking is off.

What the patterns do not catch. `pii` is pattern-based: e-mail addresses (including international and
quoted forms), phone numbers, IBANs and card numbers. **Names, postal addresses and dates of birth
are not recognised by any pattern and stay in the text at `pii`. The `content` level is the one that
covers them.** Bare digit runs are matched only where they have a telephone shape (for example
`555-123-4567`, `5551234567`, `01701234567`, `49 170 1234567`); dates, amounts, ids such as `wf_...`,
ISO timestamps and version numbers are deliberately left alone.

What it does not do. Nothing already stored in Langfuse is changed. A run segment already in progress
keeps the level it started with for its message text (personal data is scrubbed on every export
either way). The gateway's tool definitions and ids are not message content. **No part of the switch
needs a restart or a redeploy.** The chart's `turn_off_message_logging: true` stays as the gateway's
baseline; on OTel v2 the gateway captures no message content at all unless an operator sets
`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=span_only` or a per-key `capture_message_content`
([migration guide](https://docs.litellm.ai/docs/observability/langfuse_to_otel_v2_migration)); the header
makes masking hold in that case too.

Proof. `tabs/agents/lib/engine/masking.e2e.test.ts` and `tabs/agents/lib/engine/masking-gateway.e2e.test.ts` run a real agent
run through the real gateway against the real Langfuse container (stack
`tests/langfuse/compose.yaml` + `compose.masking.yaml`). A recording forwarder in front of Langfuse
captures the exact ingestion payload: with masking off a seeded e-mail, IBAN and phone number are in
it and in the stored trace; with it on they are in neither, while tokens, cost, latency, model and
tool names remain. The gateway case uses a second LiteLLM with content capture on: off, its
generation holds the prompt; on, it does not.

## Engineering view ("Under the hood")

An agent system's **Langfuse** tab carries the `Langfuse trace` of its last run: the trace id **is**
the OS run id (which is also the LangGraph `thread_id`), with the deep link to
`<console>/trace/<runId>`. When the console is not exposed, the panel says the trace exists but has
no address here, rather than hiding the row.

It also states, on every surface that shows a trace, **what is redacted and why**:

- tool arguments and results are recorded; **secret values are not** — a connection secret, a token
  or a model key never leaves the OS, and a LiteLLM key is referenced by its **alias** only;
- every Langfuse READ the OS performs is filtered by run, user or scope, so no surface can list
  another user's observations (`observationsQuery` refuses an unfiltered query).

Kinds with no model call say so: a dbt build is traced by Dagster, and a KPI or dashboard read is a
Trino query, so neither has a Langfuse trace of its own.

## FAQ
**Q: I don't see traces.** Ingestion is buffered in os-ui (≤ 2 s) and async in Langfuse (the
`agentic-os-langfuse-worker` pod). Monitoring's in-process ring (`recentTraces`) shows governance
events immediately, with no Langfuse at all.
**Q: Two generations per model call?** Yes, nested: the OS's (redacted, usage) and LiteLLM's
callback (full content, cost) as its child. One trace, no stray second trace.
**Q: The trace link is missing.** Langfuse is not configured (`langfuseEnabled()` false) or the
console URL is empty (`LANGFUSE_CONSOLE_URL`); the panel then shows the in-run steps only.
**Q: Per-project RBAC?** `/ee` feature, not licensed (see "Enterprise code in the upstream images"); the OS filters every read by run or user.
**Q: Is telemetry phoning home?** No. `langfuse.langfuse.features.telemetryEnabled: false` (owner decision
2026-11-25: "telemetry off makes sense."), which the subchart renders as `TELEMETRY_ENABLED="false"` on both
langfuse-web and langfuse-worker. `scripts/tests/langfuse-oss-chart.test.sh` asserts it for every profile and
both image overlays, with a negative twin (telemetry on is caught).
**Q: Where do the raw event blobs live?** MinIO (`langfuse` bucket); metadata in Postgres,
analytics in ClickHouse.
