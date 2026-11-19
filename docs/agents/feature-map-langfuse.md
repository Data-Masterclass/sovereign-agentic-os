# Feature map: Langfuse

Langfuse is the trace store. It keeps the record of every run: which steps ran, which model calls
were made, which tools were called, and how the run was scored. This page lists each Langfuse
feature and says how the OS uses it today and what we propose.

- "In the OS today" was verified by reading the code and chart at commit `b47e2cd5` (2026-11-19). Lines marked "live" were seen on the production system on 2026-11-19.
- "Target", "Simple mode default" and "Developer mode override" are the **agreed direction (2026-11-19), not built** unless a row says so. See [`design.md`](design.md).
- "Phase" refers to [`plan.md`](plan.md). A dash means no change is planned.
- Paths are relative to `os-ui/` unless they start with `charts/`, `docs/` or `values`. `observe.ts` means `tabs/agents/lib/engine/observe.ts`. `values.yaml` means `charts/sovereign-agentic-os/values.yaml`.

Status words:

| Word | Meaning |
|---|---|
| **Used** | The Langfuse feature itself is used. |
| **Hand-built** | The OS has its own code that does this job instead. |
| **Not used** | Neither exists. |
| **Misused** | The feature is used in a way that does not do what is intended. |
| **Blocked** | Langfuse Enterprise Edition only. Not usable under the licence rule (only Apache-2.0, MIT, BSD and ISC components). |

## Installed versus latest

| Item | Deployed | Latest (2026-11-19) | Gap |
|---|---|---|---|
| Langfuse server | 3.194.1 (live; chart 1.5.36, `charts/sovereign-agentic-os/Chart.yaml:45-48`) | 4.83.0 (chart 2.2.5) | One major version. Version 3 receives security fixes only until the end of January 2027. |
| JavaScript SDK in the OS | `langfuse` 3.39.2, the last of the old line (`package.json:34`) | `@langfuse/tracing`, `@langfuse/otel`, `@langfuse/langchain`, `@langfuse/client` 6.1.1 | A rewrite. Version 5 of the new SDK works with the deployed server; version 6 needs server 4.59.0 or later. |
| LiteLLM's Langfuse sender | The older `langfuse` callback in LiteLLM 1.90.0 | `langfuse_otel` (needs LiteLLM 1.109 or later) | See [`feature-map-litellm.md`](feature-map-litellm.md). |

## The five biggest gaps

1. **Two records for every model call.** The OS writes a redacted one. The gateway writes a second one with the full prompt and reply into the same trace. Redaction is bypassed and usage is counted twice (defect F16).
2. **Tool arguments are stored in full** in a second span per tool call, even at the strict redaction level (`core/infra/agent-governed.ts:329-354`).
3. **Nothing ever deletes traces.** Retention policies are Enterprise only, and the OS's own clean-up covers run state but not Langfuse (`tabs/agents/lib/engine/retention.ts`).
4. **The upgrade to version 4 breaks everything the OS sends and reads today:** the old SDK, the gateway's old callback, and the read endpoints the OS uses. It has to be done in a fixed order.
5. **The "session" is the system id.** All runs of a system, by all users, for ever, form one session (`observe.ts:225`; `core/runtime/runtime.ts:201`).

---

## What is recorded

| Feature | What it is for | In the OS today | Where | Target | Simple mode default | Developer mode override | Phase |
|---|---|---|---|---|---|---|---|
| Traces and observations | One trace per run, with one entry per step, model call and tool call inside. | **Used.** One trace per run; the trace id is the run id. | `observe.ts:206-332` | Keep one trace per run. | Always on. | None. | — |
| One generation per model call | A "generation" is the record of one model call with its usage and cost. | **Misused.** Two per call: the OS's and the gateway's. | `observe.ts:241-270`; `core/runtime/runtime.ts:196-202`; `values.yaml:519-524` | Exactly one, owned by the gateway, because the gateway knows the real usage and cost. Interim: the OS's own entry becomes a plain span. | Automatic. | None. | 3 |
| Observation types (`agent`, `tool`, `generation`, `retriever` and others) | Label each entry so the trace view can show what it is. | **Used** in part: spans and generations only. | `observe.ts:241-332` | Use `agent`, `tool` and `generation`. | Automatic. | None. | 3 |
| A second span per tool call from the governance layer | Record the policy decision for a tool call. | **Misused.** It duplicates the engine's tool span and stores the full arguments, outside the redaction setting. | `tabs/agents/lib/build/os-tools.ts:726-740`; `core/infra/agent-governed.ts:329-354` | One span per tool call, carrying the decision, passed through redaction. | Automatic. | None. | 3 |
| Sessions | Group the traces that belong to one conversation. | **Misused.** The session id is the system id, so the "session" never ends. | `core/runtime/runtime.ts:201`; `observe.ts:225` | Session = one conversation, or one schedule for timed runs. The system stays a tag. | Automatic. | None. | 3 |
| Users, tags, environments | Say who ran it, label it, and separate test from production. | **Used.** User id, tags `domain:`, `agent:`, `run:`, `engine:`, `env:`, and the environment. | `observe.ts:206-240` | Keep. | Automatic. | Extra tags. | — |
| Trace ids | A standard 32-character id lets other tools attach their records to the same trace. | **Hand-built.** The trace id is the run id (`run_<uuid>`), which is not the standard form. Linking the gateway relies on two LiteLLM-specific fields that the newer callback ignores. | `core/kernel/run-id.ts:18-20`; `core/runtime/runtime.ts:196-202` | A standard id derived from the run id, sent to the gateway in the W3C `traceparent` header. | Automatic. | None. | 3 |
| Token usage and cost | Show what a run used and what it cost. | **Hand-built.** The OS computes cost from its own price book and stores it in span metadata. It is only filled in when all models used have the same price. No model prices are defined in Langfuse. | `tabs/agents/lib/build/agentic-graph-server.ts:479-501`; `values.yaml:1427` | Usage and cost come from the gateway's generation. Model prices defined once in Langfuse from the same price list. | Automatic. | None. | 3 |
| Flushing | Make sure the last entries are sent before the process ends. | **Used.** Sent in the background at run end; awaited on shutdown in web and worker. A crash can lose up to 20 entries or 2 seconds. | `core/infra/langfuse.ts:50-76`; `tabs/agents/lib/engine/run.ts:226`; `worker/agent-runs.ts:188-191` | Keep. Force a flush at run end in the worker. | Automatic. | None. | 3 |
| Sampling | Record only a share of the runs. | **Not used.** Every run is traced. | — | Stay at 100 %. "Every run has a trace" is a product promise. | 100 %. | None. | — |

## Keeping content out

| Feature | What it is for | In the OS today | Where | Target | Simple mode default | Developer mode override | Phase |
|---|---|---|---|---|---|---|---|
| Client-side masking | Remove or shorten content before it leaves the OS. | **Hand-built.** Two levels in the OS's observer: `structure` (default: sizes, tool names, arguments in full, a 160-character preview of results) and `strict` (argument names and sizes only). One setting for the whole installation. | `observe.ts:241-332`; `core/kernel/config.ts:407-417` | The SDK's `mask` function on every entry, so nothing can bypass it. No document or image content is stored. | `strict` for any system with file or image inputs; `structure` otherwise. | `structure` per system, within what the admin allows. | 3 |
| Server-side masking at ingestion | Mask in Langfuse itself. | **Blocked.** Enterprise. | — | Not needed if client-side masking is complete. | — | — | — |
| Multi-modal content (images, files) | The SDK uploads images found in a trace to object storage. | **Not used** by intent: by owner decision, image prompts are not stored in traces. Whether the new SDK uploads before or after `mask` runs was not confirmed. | — | Strip images and file bodies before tracing; store type, size and a hash only. Test the upload order before relying on it. | Stripped. | None. | 3 |
| Gateway content logging | The gateway's own records of prompts and replies. | **Misused.** On, unredacted. See [`feature-map-litellm.md`](feature-map-litellm.md). | `values.yaml:519-524` | Off. | Off. | Per system, only with tenant-admin consent. | 0 |

## Evaluation and prompts

| Feature | What it is for | In the OS today | Where | Target | Simple mode default | Developer mode override | Phase |
|---|---|---|---|---|---|---|---|
| Scores | Attach a rating to a trace. | **Used**, by one caller: the Evaluate step's judge. | `app/api/agents/systems/[id]/evaluate/route.ts:125-133` | Also record user feedback and golden-run results. | Judge on demand. | Custom scores. | 4 |
| Datasets and experiments ("golden runs") | Keep a set of test inputs with expected results and compare runs against them. | **Not used.** | — | A few golden runs per system. Needs the new SDK (version 5 or later). | Off. | Golden runs per system. | 4 |
| Judge run by Langfuse | Langfuse scores entries itself with a model. | **Not used.** The OS has its own judge. | `tabs/agents/lib/evaluate-judge.ts:40-62` | Stay with the OS's judge. A Langfuse judge would spend tokens on the shared budget from outside the OS's controls. | — | — | — |
| Annotation queues | Let people review and label traces. | **Not used.** | — | Not planned. | — | — | Later |
| Prompt management | Keep prompt versions in Langfuse. | **Not used.** Prompts live in `system.yaml` and in git. | — | Stay unused. It would be a second source of truth. | — | — | — |
| Dashboards, metrics API, alerts, full-text search | Charts and alarms over traces. | **Not used.** Not available on the deployed version; they arrive with version 4. | — | Use after the upgrade. | — | — | 5 |

## Access, retention, platform

| Feature | What it is for | In the OS today | Where | Target | Simple mode default | Developer mode override | Phase |
|---|---|---|---|---|---|---|---|
| Reading traces through the OS | Show a run's trace to the person allowed to see it. | **Hand-built.** The OS reads by trace id only after checking that the run is the caller's. Langfuse has no per-project roles in the open-source edition, so this filter is required. | `app/api/agents/systems/[id]/run/diagnostics/route.ts`; `core/infra/langfuse.ts` | Keep. Move to the newer read endpoints before version 4 removes the old ones. | — | — | 5 |
| Project-level roles, audit logs, SCIM | Fine-grained access inside Langfuse. | **Blocked.** Enterprise. | — | Not needed while people read traces through the OS. | — | — | — |
| Retention policies | Delete old traces automatically. | **Blocked.** Enterprise. Without one, Langfuse keeps everything. | — | An OS-run sweep that calls Langfuse's delete endpoint, with the same period as run state. | 30 days. | None (admin setting). | 3 |
| Delete endpoint | Delete traces on request. | **Not used.** | — | Used by the sweep above and when a system is deleted. | — | — | 3 |
| New SDK (`@langfuse/tracing`, `@langfuse/otel`) | The current way to send traces, built on OpenTelemetry. | **Not used.** The OS is on the old SDK. | `core/infra/langfuse.ts:50-76` | Move to version 5 now (works with the deployed server), version 6 after the server upgrade. | — | — | 3, 5 |
| Handler for LangGraph (`@langfuse/langchain`) | Record graph steps automatically. | **Not used.** The OS writes its spans by hand. | `tabs/agents/lib/engine/build-graph.ts:581-593` | Use it for step spans; keep OS code only for the governance decision. | — | — | 3 |
| OpenTelemetry endpoint | The standard intake for traces. | **Not used.** | — | Used through the new SDK and the gateway's new callback. | — | — | 3 |
| Server version 4 | Faster, entry-first data model; alerts and dashboards. | **Not used.** Needs a newer ClickHouse, a new chart major version, and about three times the ClickHouse disk during the data move. | `charts/sovereign-agentic-os/Chart.yaml:45-48` | Upgrade before the end of January 2027. | — | — | 5 |
| Telemetry to the vendor | Usage statistics sent to Langfuse. | **Used** as "off". | `values.yaml:246` | Keep off. | — | — | — |
| Build's "Langfuse" row | Tell the builder whether tracing works for this system. | **Misused.** It counts entries in the memory of the web process. Runs happen in the worker, so the count misses them (suspected defect S7). | `tabs/agents/lib/build/live.ts:255-268`; `core/infra/agent-governed.ts:311-322` | Ask Langfuse for one real trace of this system, or say "no run yet". | — | — | 4 |

## Sources

From the research of 2026-11-19.

- Licence boundary: https://langfuse.com/docs/open-source, https://langfuse.com/self-hosting/license-key
- Data model and ids: https://langfuse.com/docs/observability/data-model, https://langfuse.com/docs/observability/features/observation-types, https://langfuse.com/docs/observability/features/trace-ids-and-distributed-tracing
- SDK and instrumentation: https://langfuse.com/docs/observability/sdk/upgrade-path/, https://langfuse.com/docs/observability/sdk/instrumentation, https://langfuse.com/integrations/frameworks/langchain, https://langfuse.com/integrations/native/opentelemetry, https://langfuse.com/integrations/gateways/litellm
- Cost, masking, media, sampling: https://langfuse.com/docs/observability/features/token-and-cost-tracking, https://langfuse.com/docs/observability/features/masking, https://langfuse.com/self-hosting/security/data-masking, https://langfuse.com/docs/observability/features/multi-modality, https://langfuse.com/docs/observability/features/sampling
- Evaluation and prompts: https://langfuse.com/docs/evaluation/evaluation-methods/llm-as-a-judge, https://langfuse.com/docs/prompt-management/features/guaranteed-availability
- Access, deletion, alerts: https://langfuse.com/self-hosting/security/authentication-and-sso, https://langfuse.com/docs/administration/data-deletion, https://langfuse.com/docs/observability/features/alerts
- Upgrade: https://langfuse.com/self-hosting/upgrade/upgrade-guides/upgrade-v3-to-v4, https://langfuse.com/self-hosting/upgrade/versioning
- Gateway side: https://docs.litellm.ai/docs/observability/langfuse_integration, https://docs.litellm.ai/docs/observability/langfuse_to_otel_v2_migration

Points the research could not confirm: whether the new SDK uploads images before or after the
`mask` function runs; whether there is a switch to turn media upload off; whether Langfuse
dashboards today really show doubled token counts (suspected defect S3).
