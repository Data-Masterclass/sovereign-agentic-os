# Monitoring — golden path

Monitoring is the **read/observe plane**: recent runs, pipeline/cost/artifact
health, and drill-into-trace. It is **read-only** and **hard-scoped** — every item
passes through the same OPA-scoping spine the UI uses, derived server-side from
your identity. A creator sees ONLY their own runs; a builder/domain-admin only
their domain's; an admin the tenant (plus cluster signals).

## Tool sequence
1. `whoami` — your identity IS the scope. There is no way to widen it from the
   client.
2. `get_monitoring_overview` — the attention-first overview (worst-first, not a
   wall of green): the few things needing attention, per-lens roll-ups (runs ·
   pipelines · cost · artifacts), and operational alerts. Scoped to you.
3. `list_runs` — your recent runs with health (green/amber/red), a one-line
   detail, owner, domain and cost.
4. `get_run_trace` — drill into ONE trace: steps (LLM calls, tool calls, spans),
   context pack, inputs/outputs, tokens and logs.

## The hard invariant
`get_run_trace` fetches the trace, then `assertInScope` throws **before any step or
log is returned**. Guessing another user's run id returns `forbidden` (out of
scope) or `not_found` (missing) — a creator can never open another user's trace.
Same for `list_runs`: `filterScope` removes anything you may not see.

## Honesty
Every item carries a `source` field: `live` or `mock`. The runs/traces lens is
**live** (Langfuse public API + the in-process governed trace ring) with an
offline-mock fallback when nothing live is found. The pipeline / cost / artifact
lenses in the overview include **mock adapters** today — the overview surfaces them
exactly as the UI renders them (parity holds), never claiming live telemetry it
does not have.

Excluded (deliberate): there is **no write** on this surface — no ack, no silence.
Investigate here, then fix the underlying artifact in its own tab.
