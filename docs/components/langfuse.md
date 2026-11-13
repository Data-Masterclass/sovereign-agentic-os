# Langfuse — observability & tracing

**What it is:** Langfuse v3 (MIT) is the trace store of the OS. Since the engine rebuild (A3)
the OS uses it the way an engineer would: **one trace per agent run, trace id = run id**, with
the graph's nodes as spans, every model call as a generation with token usage, every tool call
as a span carrying the governance decision, and the LLM-judge verdict as a score on that trace.
Backed by Postgres (metadata), ClickHouse (analytics), Valkey (queue) and MinIO (event blobs).

## What ships (and where in the code)

| Concern | Where | What |
|---|---|---|
| SDK client | `os-ui/core/infra/langfuse.ts` | the official `langfuse` JS SDK (3.39.2), one buffered client per process (`flushAt` 20 / `flushInterval` 2 s, one retry, 5 s timeout); `langfuseEnabled()`, `traceUrlFor(runId)`, `scoreTrace`, `readObservations` |
| Run observer | `os-ui/tabs/agents/lib/engine/observe.ts` | `langfuseRunObserver` — the trace, the node spans, the generations, the tool spans; `noopObserver` when no keys are configured |
| Node instrumentation | `os-ui/tabs/agents/lib/engine/build-graph.ts` `observed(...)` | every `plan_/act_/tools_/route_<id>` node body runs inside a span; the model caller handed to the node records generations; `tools_<id>` records tool spans |
| Governance spans | `os-ui/core/infra/agent-governed.ts` `trace()` | under a run (`event.run`) a governed tool call is a **span of the run trace**; outside a run (walker, build probes) it is its own trace, exactly as before |
| Gateway nesting | `os-ui/core/runtime/runtime.ts` `liteLlmCaller` | LiteLLM is told `existing_trace_id` / `parent_observation_id` so **its** Langfuse callback lands inside the run trace, under the OS generation |
| Scores | `app/api/agents/systems/[id]/evaluate/route.ts` | the judge verdict → `score { traceId: runId, name: 'judge', value: overall, comment }` |
| Reads | `app/api/agents/systems/[id]/run/diagnostics/route.ts` | observations **by trace id** (`?runId=`); without a run id, by the caller's user id AND a time window. `observationsQuery` refuses anything looser (typed error) |
| Deep link | `LastRun.traceUrl`, MCP `run_agent_system` / `get_agent_run` / `resume_agent_run` | `${LANGFUSE_CONSOLE_URL}/trace/<runId>` — the SDK's own URL shape; Langfuse redirects into the project |

## The trace tree

```
trace  id = runId · name = <system name> · userId = <runner id> · sessionId = <systemId>
       tags = domain:<d> · agent:<systemId> · run:<runId> · engine:langgraph
       input = { task }                               (one trace-create per run; a RESUME adds to it)
├── span plan_<agent>      metadata { agent, kind:'plan', visit, stepsUsed }
│   └── generation llm.plan_<agent>   model · usage {input,output,total} · input = roles + char counts
│       └── generation (LiteLLM's callback: full request/response + cost)   ← existing_trace_id
├── span act_<agent>
│   └── generation llm.act_<agent>    output = { chars, toolCalls[...] }
├── span tools_<agent>
│   ├── span tool.<name>  input { tool, callId, args } · metadata { decision: ok|denied|error|held|dedup|not_advertised, approvalId }
│   └── span agent.<name> (governance: OPA effect / hold)            ← core/infra/agent-governed.ts
├── span route_<agent>    (supervisor: generation llm.route_<agent>; routes[] in output)
└── span run.result       output { reachedEnd, parked, interrupted, failed, path, finalChars, stepsUsed }
```

A held write ends `tools_<agent>` as `parked` (statusMessage) with a `tool.<name>` span whose
decision is `held`; the decision in Governance resumes the thread and the next segment's spans
reference the same trace id.

**Redaction.** Model-call *content* is recorded as roles and character counts, never the text.
The tool-call *structure* (names, ids, args) is kept whole; tool results as a character count
and a 160-character preview. LiteLLM's own generation carries the full content and the cost —
that is the gateway's callback, configured in the chart, not the OS's record. PII in traces is a
checklist concern (A-section "PII handling"); the OS default is deliberately conservative.

## What the OS does NOT use

Prompts, datasets, dataset runs, evaluators and the public-trace flag are not used. Scores are
written for one thing (the judge). There is no per-domain Langfuse project: scoping is enforced
in the OS (every read filtered by run or user), and per-project RBAC is an `/ee` feature.

## Access
```bash
kubectl -n agentic-os port-forward svc/agentic-os-langfuse-web 3000:3000
# http://localhost:3000
```
**Login:** `admin@datamasterclass.com` / `langfuse-local-dev-admin`

## How to use it
- **Open a run's trace:** the Run panel's "Full trace: open in Langfuse", or `traceUrl` from
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
and into LiteLLM (`success_callback` + `failure_callback: ["langfuse"]`).

## FAQ
**Q: I don't see traces.** Ingestion is buffered in os-ui (≤ 2 s) and async in Langfuse (the
`agentic-os-langfuse-worker` pod). Monitoring's in-process ring (`recentTraces`) shows governance
events immediately, with no Langfuse at all.
**Q: Two generations per model call?** Yes, nested: the OS's (redacted, usage) and LiteLLM's
callback (full content, cost) as its child. One trace, no stray second trace.
**Q: The trace link is missing.** Langfuse is not configured (`langfuseEnabled()` false) or the
console URL is empty (`LANGFUSE_CONSOLE_URL`); the panel then shows the in-run steps only.
**Q: Per-project RBAC?** `/ee` feature, not bundled; the OS filters every read by run or user.
**Q: Is telemetry phoning home?** No — `telemetryEnabled: false` (sovereign/offline).
**Q: Where do the raw event blobs live?** MinIO (`langfuse` bucket); metadata in Postgres,
analytics in ClickHouse.
