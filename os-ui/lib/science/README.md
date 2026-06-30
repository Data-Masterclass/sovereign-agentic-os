<!-- SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt) -->

# Science (Layer 4 / ML) — `lib/science`

The server-side spine for the **Science tab + golden path**: traditional/classic
ML (regression, classification, forecasting, clustering — **not LLMs**) taken from
a governed data product to a **governed, deployed model-as-service**, preview-first,
the tooling hidden. Wired onto the **running Layer-4 services** (JupyterHub,
Featureform, MLflow, KServe, Dagster) — **not the chart**; degrades to a
deterministic offline mock so the whole flow is demonstrable on a laptop with
`ml.enabled=false` and no cluster.

## Off by default

Science is **Layer 4: opt-in, off by default, GPU-cost-gated** (not in the
cohort-1 path). `config.mlEnabled` (`ML_ENABLED=true`) is the enablement gate —
an Admin turns Science on per domain. When off, the Science tab renders a disabled
surface and every `/api/science/*` route short-circuits. This is distinct from
backend **reachability**: with `mlEnabled=true` but no live backend, the flow
still renders from the seed.

## The golden path (what the user does ▸ what happens underneath)

1. **Explore** ▸ launch from a governed data product (Iceberg mart) — guided
   preview by default, JupyterHub notebook as the escape hatch.
2. **Build features** ▸ `features` artifact in **Featureform** (offline=Iceberg,
   online=Valkey). → `adapters.featuresAdapter`.
3. **Train & track** ▸ runs logged to **MLflow**, repeatable as a **Dagster** job.
   → `adapters.trainTrackAdapter`.
4. **Register & compare** ▸ versions + stages in the **MLflow registry**.
   → `adapters.registryAdapter`.
5. **Certify & go-live** ▸ a **Builder** certifies + approves Staging→Production.
   **Always a human — never the agent.** → `model-service.goLive` / `certifyModel`.
6. **Deploy & serve** ▸ **KServe** InferenceService exposed **two ways from one
   endpoint**: a governed **REST `predict` API** (Software/external) AND a governed
   **`predict` MCP tool** (agents). → `adapters.deployAdapter`, `serve.servePredict`.
7. **Consume** ▸ both front doors, identical governance (OPA + LiteLLM + Langfuse).
8. **Monitor & retrain** ▸ drift + metric history; **Dagster** retrain trigger,
   the **same signals** the Monitoring tab reads. → `adapters.monitoringAdapter`.

## Model-as-service, tier-gated (the spine — `model-service.ts`)

A deployed model is governed exactly like every other artifact. **One visibility
ladder** decides who may call its `predict` service through **either** front door:

```
Personal ──(Builder promote)──▶ Domain ──(Admin certify)──▶ Marketplace
  owner only            whole owning domain          cross-domain
```

- **`compilePredictPolicy(model)`** — the **policy-compiler mirror**: turns the
  model's tier into the OPA `predict` data bundle (`allowedPrincipals`,
  `allowedDomains`, `crossDomain`). This is the **single** source both front doors
  evaluate, so REST and MCP **cannot drift** — the same guarantee
  `data-policy-compiler.md` makes for Trino-vs-Cube.
- **`authorizePredict(model, caller)`** — the governed gate for a `predict` call:
  (1) **tier scope** (is the caller within the compiled callable scope?) AND
  (2) the **OPA `predict` grant** (live OPA first, offline mirror when down).
  Promoting/certifying the model is the **only** thing that widens scope — **no
  separate publish step**. The OPA authorizer is dependency-injected so the spine
  is unit-tested without the live chain.
- **`servePredict(...)`** (`serve.ts`) — the shared body for both routes:
  `app/api/science/predict` (**MCP**, agents) and `app/api/science/predict/rest`
  (**REST**, Software/external). Identical governance + Langfuse trace; the only
  difference is which door (`isAgent`) and the default principal.
- **Lifecycle (always human):** `promoteModel` (Builder), `goLive` (Builder),
  `certifyModel` (Admin, sets the consumption mode). `assertHuman()` rejects any
  **agent actor** — the agent proposes; a human ships.

## The ML agent — guided AutoML, two-mode (`agent-control.ts`)

`proposePlan(goal)` → explore → features → train → register → **deploy-to-Staging**.
The plan **stops at Staging**; it never proposes certify/go-live.
`authorizeAgentStep(step, ctx)` enforces the two modes:

- **in-tab** (human present) → writes/GPU need **inline approval**.
- **autonomous** → bounded by **safety presets** (`read-propose` / `bounded-writes`)
  + **GPU within quota**; out-of-policy ⇒ blocked + queued to Governance.

`assertAgentCannotCertify(step)` is the hard invariant (mirrors `assertHuman`): a
certify/go-live/promote step is **always blocked** for the agent.

## Marketplace consumption at certify (`marketplace.ts`)

The owner picks the mode **at certify time**, per artifact:

- **read-in-place** (default) — `importModel` returns a `predict` **grant** for the
  consumer domain; the model is **not copied** (single source, owner sees usage).
- **fork-allowed** — `importModel` drops a governed **fork** in the consumer
  domain (may drift from source).

Imports are policy-compiler grants, audited (Langfuse trace).

## The five adapters (`adapters.ts`)

Each wraps one live Layer-4 service, reports `live` from a real probe, and degrades
to a deterministic offline mock: **features** (Featureform), **train/track**
(MLflow + Dagster), **registry** (MLflow versions/stages + certify gate),
**deploy** (KServe → dual REST+MCP), **monitoring** (drift + metric history +
retrain trigger, shared with Monitoring). All plug into OPA + LiteLLM +
OpenMetadata + Langfuse via the governed routes.

## Files

| File | Role |
|---|---|
| `types.ts` | Pure shared types (client-safe). |
| `churn.ts` | The "Churn model" vertical slice + the `predictTool` body. |
| `model-service.ts` | **Model-as-service tier ladder + dual-front-door governance.** |
| `serve.ts` | Shared governed `predict` body for both front doors. |
| `agent-control.ts` | **Two-mode ML agent + the cannot-self-certify invariant.** |
| `marketplace.ts` | **Consumption-at-certify** (read-in-place / fork-to-retrain). |
| `adapters.ts` | The 5 verified Layer-4 adapters (live + offline-mock). |
| `model-service.test.ts` | 16 governance invariants (`node --test`). |

## Routes

| Route | Purpose |
|---|---|
| `GET /api/science` | Layer-4 service health + `mlEnabled`. |
| `GET /api/science/churn` | The 8-stage churn slice. |
| `GET /api/science/model` | Model-as-service state: tier, compiled scope, adapters, drift. |
| `POST /api/science/model` | `promote` / `go-live` / `certify` / `import` / `retrain` (human-gated). |
| `POST /api/science/predict` | **MCP** `predict` tool (agents). |
| `POST /api/science/predict/rest` | **REST** `predict` API (Software/external). |
| `POST /api/science/agent` | Two-mode guided-AutoML plan + per-step governance. |

## Tests

```
cd os-ui && node --test lib/science/model-service.test.ts
```

16 tests cover: scope-widening per tier, no REST/MCP drift, tier-scope deny vs OPA
grant, certify widening cross-domain, **agent-cannot-self-promote/certify/go-live**,
two-mode step governance, and read-in-place vs fork-allowed consumption.
