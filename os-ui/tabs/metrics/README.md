# KPIs · Context

Metric definitions and their values. Labelled **KPIs** in the UI — the folder name is deliberately stable while the label is not.

The authoritative contract is [`manifest.ts`](./manifest.ts) — this file explains it; the manifest is what the checks and the docs generator read. If the two disagree, the manifest is right.

## What a metric IS

A **dbt metric**. Defining one in the form, from chat or over the MCP writes a `metrics:` entry on a
`semantic_models:` measure into the owning domain's dbt project — `models/semantic/<model>.yml`
for a promoted dataset, `models/personal/<uid>/semantic/<model>.yml` while it is still personal —
through the Data tab's one commit path, authored as the acting user with
`OS-Object: metric:<datasetId>.<measure>`. The emitter, parser and spec validator live in
`../data/lib/dbt/semantic/` and target **dbt-semantic-interfaces 0.8.5 (= dbt-core 1.10)**, every
field also valid on the dbt 1.9 the images carry.

**Execution stays here.** A metric read is `lib/explorer.ts` compiling ONE governed Trino `SELECT`
run as the viewer (`lib/build/explore-server.ts` → `queryRun(sql, identities.trino.user)`), so
Trino + OPA apply row/column security per viewer. MetricFlow is never on the request path — it
would open one connection from its own profile and lose that impersonation. Where MetricFlow is
installed at all it is pinned `>= 0.209.0` (`<= 0.208.1` is BSL 1.1).

**Nothing unservable is emitted.** A leading window, a ratio carrying its own filter, a formula
over a metric that is not emitted, a filter outside the generated grammar: each is a named refusal
listed in the generated project's README under "Not emitted". A rolling window whose unit does not
match the slice grain returns a typed refusal (`window_grain_mismatch`), never a wrong number; one
that DOES match is served with a `warning` that the frame counts time buckets rather than calendar
units — the spine is generated (`models/os/os_time_spine_day.sql`) but not joined to yet. A dataset
with measures and no time column emits no semantic YAML at all: dbt requires an
`agg_time_dimension` for every measure, so each of those metrics is refused by name.

## What this module owns

**Routes**

- `/metrics`

**APIs**

- `/api/metrics`

**MCP tools**

- `metric-write`

**Needs deployed**

- `trino`
- `opensearch`
- `postgres`

## Layout

- `lib/`
- `mcp/`
- `ui/`

- `lib/` tab logic · `ui/` tab-specific components · `mcp/` this tab's MCP handlers

- `guide.md` — the golden path, shown in-product
- `context.md` — the system prompt context this tab gives an agent

## Rules that apply here

1. **Import only `@core/*` and this module.** A cross-tab need means the shared part belongs in `@core`.
2. **The kernel must not import this module.** `@core` does not know its tabs exist.
3. **Pages live in `os-ui/app/`**, thin, importing from here. Next.js serves routes only from there.
4. Every source file carries a `FEATURE:` / `USER STORY:` / `ARCHITECTURE:` header. `scripts/check-structure.mjs` enforces it as a ratchet.

See [`../../../CLAUDE.md`](../../../CLAUDE.md) for the full structure rules and [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) for the constraints this codebase punishes you for ignoring.
