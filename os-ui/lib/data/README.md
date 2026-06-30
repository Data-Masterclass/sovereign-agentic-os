<!-- SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt) -->

# The Data tab (`lib/data`)

The Data tab turns a plain-language flow — **datasets refined Bronze → Silver → Gold,
shared as assets and products** — into the real tool artifacts (dlt, dbt, Cube,
Superset) the platform runs, governed end-to-end. A user with no data background never
sees YAML; a Builder can open the native file or drive the same steps from the data
agent. This package is the engine room behind that surface.

It is deliberately framework-light and **pure where it can be**: the registry, schema,
policy compiler, conformance check, lineage and the Build adapter logic are all
dependency-free modules unit-tested with `node --test`. The server boundary (API routes,
`*/server.ts`, `live-clients.ts`) is the only place that touches the network.

---

## The model in one screen

Two orthogonal axes (`dataset-schema.ts`):

- **Refinement layer** — `bronze` (raw) → `silver` (cleaned, typed, keyed) → `gold`
  (harmonized star schema). One logical dataset has **three versions of itself**.
- **Sharing tier** — `dataset` (private, **DuckDB sandbox**) → `asset` (domain-shared,
  **Trino/Iceberg**) → `product` (certified, in the **marketplace**). The tier is the
  dataset's overall sharing state.

**The hard storage line** (`storageFor`): a `dataset` lives in the per-user DuckDB
sandbox; only promoted `asset`s and certified `product`s live in Trino/Iceberg.

**Separation of duties** (`canTransition`, mapped to the platform `Role`):
`participant` = **Creator** (creates datasets), `builder` **promotes** dataset→asset,
`admin` **certifies** asset→product. A Creator can't promote their own data: they
**request** it and a domain Builder **approves** in Governance (reusing the shared
approvals queue). Reverse moves (`unshare`, `decertify`) are lineage-aware — they refuse
to orphan a published dependency.

`dataset.yaml` is the **single source of truth** per dataset; the tool-native files
(dlt/dbt/cube) are projections addressed by each version's `artifact` path, so the
guided panel, the "Show the code" view and the data agent all edit the same source.

---

## Files

| Module | What it is |
|---|---|
| `dataset-schema.ts` | The `Dataset` shape + `dataset.yaml` parse/serialize; the storage line, role gates, visibility clamping. |
| `store.ts` | The in-process registry (maps 1:1 to Supabase later): scoping, create/build/version, docs, promote (request→approve), certify, import, files. |
| `store-fqn.ts` | The canonical handover FQNs (`assetTarget`/`productTarget`), shared with the compiler. |
| `transparency.ts` | The transparency gate (owner · domain · description · ≥1 column doc · visibility/tier · ≥1 upstream edge). |
| `panels.ts` | Plain-language copy + gates for the guided Bronze/Silver/Gold panels. |
| `metrics.ts` | The Cube handover: `cube_dbt`-style cube model, the dbt exposure (one per view) and the Superset bundle, generated from the Gold model. |
| `lineage.ts` | End-to-end lineage across both axes (refinement + consumption + trust) + the gate status. |
| `identity.ts` | Delegated identity — R2 (user-bound downscoped tokens, never a service account), R3 (one identity → Trino + Cube), personal-lane isolation. |
| `agent-tools.ts` | The scoped data-agent tools (`personal`/`domain`/`marketplace`) under the delegated identity. |
| `policy/compiler.ts` | One source → the OPA `data.governance` bundle **+** Cube access policies. |
| `policy/conformance.ts` | The conformance check: OPA path == Cube path, else ✗. |
| `build/*` | The Build adapter framework (interface, live adapters, real clients, offline-mock, orchestrator, server boundary). |

---

## Build = execute + verify (the adapter framework, `build/`)

Pressing **Build** for a stage runs that stage's **adapter-set** — each adapter does a
real `apply` against its tool, then a `verify` probe. **The cardinal rule
(`runAdapter`): a row is ✓ only when both apply *and* verify pass.** A network/HTTP
failure surfaces as ✗ — Build never claims success without a passing probe.

```
bronze  → dlt → om            silver → dbt → om          gold → dbt → om
metric  → cube → om           dashboard → superset → om
promote → dbt-trino → trino → om → policy                certify → om → policy
```

**Live vs offline-mock** (mirrors `lib/agents/build`): when the stack is reachable the
adapters run against the real services (`live-clients.ts`, server-only); otherwise the
**offline-mock** runs the *same adapter logic* against in-memory clients — so the two
paths **cannot drift** (a metric only "resolves" if its cube was actually reloaded; a
table is only "queryable" if dbt-trino actually materialized it). The mode is labelled
honestly. Adapters not present in the map are **skipped**, never faked as passing.

The `om` adapter enforces the **transparency gate** on the governed/consumption stages
(metric, dashboard, promote, certify) — a raw Bronze load isn't gated.

---

## Governance — one source, two enforcement points (`policy/`)

There are two access paths (engine vs metrics), so two enforcement points that must
**not** drift. We keep one policy source (a governed dataset's visibility + grants) and
**compile it to both**:

- **Trino OPA** — the compiler emits the `data.governance` bundle (tables + principals)
  that the **existing `package trino` rego already reads**. We don't re-author the rego;
  one additive clause (`shared_with_users`) honours named-individual grants.
- **Cube** — the parallel access policies (allowed domains/users + excluded columns).

**Mask-vs-hide** is intentional: a restricted column is **masked in Trino** and
**excluded in Cube**. The **conformance check** (`runConformance`) evaluates both
compiled structures independently and asserts they agree (same rows; `OPA.masked ==
Cube.excluded`). It runs on **Build** (the `policy` adapter's verify) and on **every
grant change** (the import route), and is proven to **fail on injected drift**.

**Delegated identity (R1/R2/R3)** is the linchpin. Agents act **as the user** — a
downscoped token (`delegate`), never a service account (R2). One identity propagates to
Trino (`user` + low-cardinality `groups`, R1) and to Cube (`securityContext`, R3). The
three agent tools reach exactly: `personal` (the user's own DuckDB prefix), `domain`
(their domain's Trino assets/products), `marketplace` (only imported products) — nothing
else.

---

## Where it is wired vs mocked (today)

- **Reused real backends:** the central Trino query-tool, the DuckDB **sandbox "My
  data" lane**, Cube + Superset on Trino, the governed-tool spine, the approvals/
  Governance queue, the `package trino` OPA policy.
- **Live adapters** call the real Cube / Superset / OpenMetadata / query-tool / OPA when
  reachable; on a laptop (`kind`, no services) the **offline-mock** runs the identical
  logic. The registry/store is in-process and maps 1:1 to Supabase.
- **Out-of-band by design:** dlt/dbt/dbt-trino run via Dagster/CI; their adapters
  **verify the result** (a probe SELECT — `dbt build` aborts dependents on a failed
  test, so a queryable mart is honest evidence its tests passed).

## Tests

`node --test 'lib/data/**/*.test.ts'` — schema, store, identity, panels, transparency,
promotion, certification, metrics, the live/mock adapters (incl. the cardinal rule and
mock↔live parity), the policy compiler + conformance (incl. drift detection), the agent
tools (R2/R3 + scope isolation), lineage, and the **"Orders" worked example end-to-end
both ways** (`orders-e2e.test.ts`: the guided lifecycle == what the data agent reads).
