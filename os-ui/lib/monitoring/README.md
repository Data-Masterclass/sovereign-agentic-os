<!-- SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt) -->
# Monitoring — the read/observe plane

One place to **see health, watch spend, and trace any run** across the whole
platform. Monitoring is **READ-ONLY**: it shows what's happening and surfaces
operational alerts. It does **not** set policy or caps (that's **Governance**) and
it does **not** watch business KPIs (that's **Dashboards**). The boundary is
deliberate: *observe (Monitoring) · decide (Governance) · the business (Dashboards)*.

Spec: `stackit/monitoring-golden-path.md` + `monitoring-and-healing.md` (the infra
self-healing runbook this tab **surfaces**, never rebuilds).

## The five lenses (all read-only, each scoped by the viewer's Ory→OPA identity)
1. **Agent & run observability** — Langfuse runs → **drill into the full trace**.
2. **Data-pipeline health** — Dagster runs + dbt tests + source-freshness.
3. **Cost & usage** — LiteLLM spend by model/agent/domain **vs Governance caps**
   (we **read** the caps and **watch** the spend; we never **set** a cap).
4. **System & cluster health + self-heal** — k8s workload status (live, via the
   pod's ServiceAccount) + Prometheus/Alertmanager/Argo/SKE auto-repair (surfaced).
5. **Artifacts (all tabs incl. ML)** — unified health across data/metrics/
   dashboards/apps/connections/agents + MLflow/KServe serving, drift, latency.

## Architecture

```
app/api/monitoring/route.ts            → buildOverview(user)      (scoped overview)
app/api/monitoring/trace/[id]/route.ts → fetchTrace + assertInScope (drill, gated)
app/api/monitoring/correlate/route.ts  → correlate(scope, id, …)  (run→…→artifact)
                                  │
lib/monitoring/
  types.ts        the shared contract (HealthItem · Overview · TraceDetail · …)
  scope-core.ts   PURE scope predicates  ← unit-tested (the security heart)
  scope.ts        scopeForUser() — Ory identity → scope, best-effort OPA check
  adapters/       five READ-ONLY collectors (live read + offline-mock):
    run-trace.ts · pipeline-health.ts · cost.ts · system-health.ts · artifact-health.ts
  correlate.ts    trace/lineage correlation (scope-safe connected-component walk)
  rollup.ts       PURE attention-first ordering + worst-of roll-up ← unit-tested
  aggregate.ts    OPA-scoped multi-source aggregation (fan-out + filter + roll-up)
  mock.ts         offline fixtures that encode the validation-gate scenario
```

### OPA-scoping spine (the read filter)
Every signal carries the `owner` + `domain` it belongs to. **One** predicate,
`canSee(scope, item)`, governs every lens, alert and trace so no lens can widen
visibility:

| Role (session) | Scope level | Sees |
|---|---|---|
| `participant` | `user` | only items it **owns** (`item.owner === principal`) |
| `builder` | `builder` | its **domains** (`item.domain ∈ domains`) |
| `admin` | `admin` | **tenant + cluster** (incl. `cluster:true` node/self-heal signals) |

**Security invariant (tested):** a User cannot open another user's trace.
`assertInScope()` is the single gate the drill route awaits *before* any step or
log is returned, so the check can't be bypassed by guessing a trace id.

### Drill-into-trace (the core promise)
Any run/agent/pipeline/model → its full Langfuse trace (steps · tool calls · the
context pack · inputs/outputs) **+ logs**, via `GET /api/monitoring/trace/{id}`.

### Trace/lineage correlation
`correlate()` ties a signal back through **run ↔ pipeline ↔ system ↔ artifact**
and surfaces the Governance cross-links (→ audit entry, → cost cap). Relationships
are **link tokens** (each item's id + its `links` values), so correlation is
bidirectional and **scope-safe**: the component is grown only through items the
viewer may see — following a link never leaks an out-of-scope hop. On a live
cluster the tokens come from Langfuse trace metadata + OpenMetadata lineage + the
Governance audit/cap ids; offline they come from the fixtures.

### Live + offline-mock dual pattern
Each adapter attempts a **live read** (reusing the existing wiring: Langfuse, the
in-process governed trace ring in `lib/agent-governed.ts`, Dagster GraphQL,
LiteLLM spend, the k8s API via `lib/platform.ts`, KServe/MLflow) and falls back to
an **offline mock** when the backend is off — always marked `source:'mock'` so the
UI is honest. On `kind` (no Prometheus/Alertmanager/Argo in the bundle; no AGPL
Grafana) the system lens reads live k8s workload status and **surfaces** the
self-heal narrative from mock; STACKIT Observability is the Mode-B overlay.

### Operational alerts (the boundary)
`Overview.alerts` are **system/run health only** → self-heal-or-notify
(email/chat/in-app). Business-KPI alerts are **excluded by construction** — they
live in Dashboards. A cap **tripping** shows here; **setting** it happens in
Governance.

## The validation-gate story (encoded in `mock.ts`, runnable offline)
A Sales agent run (`run-2002`) **fails** overnight → run lens **red** → drill into
its Langfuse trace (the `metrics` tool errored on a stale mart) → its upstream
**dbt freshness** check went stale (`pl-3001`) → pipeline lens **red** → the
ingestion pod was **OOMKilled and auto-restarted** (`sys-4001`) → system lens
shows the **self-heal** → cost for the Sales domain (`cost-5001`) is **nearing**
the `$200` Governance cap (**shown, not set**) → the `mart_sales` artifact is
stale and the churn model drifts → a **User** sees only their own runs, a
**Builder** the domain, an **Admin** tenant+cluster (a User **cannot** open
another's trace) → a **system** alert notifies while a **KPI** alert does **not**
appear here.

## Tests
`node --test 'lib/monitoring/**/*.test.ts'` — `scope.test.ts` (the role matrix +
the no-side-channel invariant), `correlate.test.ts` (the chain + scope-safety),
`rollup.test.ts` (attention-first ordering + worst-of). The pure modules
(`scope-core`, `correlate`, `rollup`, `mock`, `types`) import only each other, so
the security + correlation spine runs with no backend.

## Read-only guarantees
- No adapter issues a write to any source (Dagster: query only; LiteLLM: spend
  read only; k8s: GET only; Langfuse: read only). The cost adapter has **no** cap
  write path.
- Scope is enforced **server-side**; the browser never receives out-of-scope
  signals (overview is pre-filtered; trace + correlate are gated per request).
