> Research report, night run 2, read-only audit at main `31c0fc90`.

# R1 — Metrics as dbt metrics on top of the OS's data products

Research agent R1, night of 2026-11-13 → 14. Repo `sovereign-os-stack` @ `main` (31c0fc90), os-ui 0.8.0.
Read-only audit; no repo file was modified. Owner's ask: *"creating and leveraging metrics fully
leveraging DBT metrics on top of our data products" — "Defining simple and complex metrics using DBT
metrics on top of data products."*

> Sections 1 and 2 (spec + licences) are completed below from the web research sub-task; sections
> 3–7 are the code audit, the options and the plan.

---

## 1. How a data engineer does it by hand today (dbt Core 1.8–1.10)

### 1.0 A methodology warning that changes how you read the docs

`docs.getdbt.com` now serves the **dbt 1.12 ("Fusion") spec by default**, and the `?version=1.10`
selector is client-side only — a fetch of the docs always returns 1.12. **1.12 is a breaking
redesign of the semantic layer**, so the docs prose no longer describes what dbt Core 1.8–1.10
accepts. The authoritative source for 1.8–1.10 is the pydantic spec in `dbt-semantic-interfaces`
(DSI) at the version each dbt-core pins:

| dbt-core | dbt-semantic-interfaces |
|---|---|
| 1.8.9 | `>=0.5.1,<0.6` |
| 1.9.4 | `>=0.7.4,<0.8` |
| 1.10.0 | `>=0.8.3,<0.9` |
| 1.12.7 | **no DSI dependency** (Fusion / Rust) |

Everything below is taken from **DSI v0.8.5 = dbt-core 1.10**
(<https://github.com/dbt-labs/dbt-semantic-interfaces/tree/v0.8.5/dbt_semantic_interfaces/implementations>),
with docs URLs for the prose. What changes in 1.12 (and therefore what the OS must be ready to
translate to) is listed in §7.

### 1.1 `semantic_models`

Docs: <https://docs.getdbt.com/docs/build/semantic-models> ·
spec: `implementations/semantic_model.py` @ v0.8.5

```yaml
semantic_models:
  - name: transactions
    description: ...
    model: ref('fct_transactions')      # → node_relation
    label: "Transactions"
    primary_entity: transaction         # needed when no column is a primary entity
    defaults:
      agg_time_dimension: ds
    config:
      meta: {owner: analytics}
    entities: [...]
    dimensions: [...]
    measures: [...]
```

`PydanticSemanticModel` fields: `name`, `defaults`, `description`, `node_relation`,
`primary_entity`, `entities`, `measures`, `dimensions`, `label`, `metadata`, `config`.

**Entities** (`implementations/elements/entity.py`): `name`, `description`, `type`, `role`, `expr`,
`metadata`, `label`, `config`. `EntityType` is exactly four values —
**`primary` · `unique` · `foreign` · `natural`** (`type_enums/entity_type.py`). Semantics
(<https://docs.getdbt.com/docs/build/entities>): `primary` = one row each, no nulls, all records;
`unique` = one row each, nulls allowed, may be a subset; `foreign` = join key, nulls and duplicates
allowed; `natural` = a real-world key, **SCD Type II only**.

**Dimensions** (`implementations/elements/dimension.py`): `name`, `description`,
`type` (`categorical` | `time`), `is_partition`, `type_params`, `expr`, `metadata`, `label`,
`config`. `PydanticDimensionTypeParams` = **`time_granularity` (required for a time dimension)** +
`validity_params` (`is_start`/`is_end`, SCD2). `TimeGranularity`:
`nanosecond … second, minute, hour, day, week, month, quarter, year`.
Docs: <https://docs.getdbt.com/docs/build/dimensions>

**Measures** (`implementations/elements/measure.py`): `name`, **`agg` (required)**, `description`,
`create_metric`, `expr`, `agg_params`, `metadata`, `non_additive_dimension`,
`agg_time_dimension`, `label`, `config`. `AggregationType` is exactly nine —
**`sum` · `min` · `max` · `count_distinct` · `sum_boolean` · `average` · `percentile` · `median` ·
`count`**. `agg_params` = `{percentile, use_discrete_percentile, use_approximate_percentile}`.
`non_additive_dimension` = `{name (a TIME dimension), window_choice (default min), window_groupings}`.
Docs: <https://docs.getdbt.com/docs/build/measures>

> Note for the OS: dbt has **no `count_distinct_approx` agg** (there is
> `agg_params.use_approximate_percentile`, which is a different thing). The OS's
> `count_distinct_approx` has **no faithful dbt form** — `semantic.ts:28-45` already admits this by
> excluding it. Decide: emit it as `count_distinct` with a `meta` note (wrong number vs. dbt),
> or `expr: approx_distinct(col)` with `agg: sum`-style trickery (ugly), or keep it OS-only and say
> so. Recommended: emit `count_distinct` + `config.meta.os_agg: count_distinct_approx` and have the
> OS compiler honour the approximation while dbt's own form stays exact.

### 1.2 `metrics` — the five types

Docs: <https://docs.getdbt.com/docs/build/metrics-overview> ·
spec: `implementations/metric.py` @ v0.8.5

`PydanticMetric`: `name`, `description`, **`type`**, **`type_params`**, `filter`, `metadata`,
`label`, `config`, `time_granularity`. `MetricType` = `simple` · `ratio` · `cumulative` ·
`derived` · `conversion`. **`meta` lives under `config.meta`** (`config` is
`PydanticSemanticLayerElementConfig`: `meta`, `group`, `enabled`, `tags`).

`PydanticMetricTypeParams` @ v0.8.5: `measure`, `numerator`, `denominator`, `expr`,
`window` *(legacy)*, `grain_to_date` *(legacy)*, `metrics`, `conversion_type_params`,
`cumulative_type_params`, `input_measures` *(computed)*.

Two input shapes matter:
- `PydanticMetricInput` (numerator / denominator / derived `metrics`): **`name`, `filter`, `alias`,
  `offset_window`, `offset_to_grain`**.
- `PydanticMetricInputMeasure` (simple / conversion): **`name`, `filter`, `alias`,
  `join_to_timespine`, `fill_nulls_with`**.

**simple** (<https://docs.getdbt.com/docs/build/simple>)
```yaml
- name: revenue
  type: simple
  type_params: {measure: net_amount}
  filter: "{{ Dimension('order__is_food_order') }} = true"
```

**ratio** (<https://docs.getdbt.com/docs/build/ratio>) — each side may carry its **own** filter:
```yaml
- name: food_order_pct
  type: ratio
  type_params:
    numerator:
      name: food_orders
      filter: "{{ Dimension('order__is_food_order') }} = true"
      alias: ny_food_orders
    denominator: orders
```

**cumulative** (<https://docs.getdbt.com/docs/build/cumulative>) —
`PydanticCumulativeTypeParams` = **`window` · `grain_to_date` · `period_agg`** (default `first`;
`PeriodAggregation` = `first` | `last` | `average`). `window` and `grain_to_date` are mutually
exclusive. `PydanticMetricTimeWindow` parses the string `"<count> <granularity>"` (e.g.
`28 days`); an invalid form raises `ParsingException`.
```yaml
- name: revenue_t7d
  type: cumulative
  type_params:
    measure: net_amount
    cumulative_type_params: {window: 7 days}
```
> **Version delta, verified:** `cumulative_type_params` **does not exist in DSI 0.5.1 (dbt 1.8)** —
> on 1.8 you must use legacy `type_params.window` / `type_params.grain_to_date`. It appears from
> DSI 0.7.x (dbt 1.9). In DSI 0.9.1+ it gains a `metric:` input. Custom granularities are allowed
> in `window` (a free `str`) but **not** in legacy `grain_to_date` (the enum).

**derived** (<https://docs.getdbt.com/docs/build/derived>)
```yaml
- name: order_total_mom_growth
  type: derived
  type_params:
    expr: (order_total - order_total_prev_month) * 100 / order_total_prev_month
    metrics:
      - name: order_total
      - name: order_total
        alias: order_total_prev_month
        offset_window: 1 month
```

**conversion** (<https://docs.getdbt.com/docs/build/conversion>) —
`PydanticConversionTypeParams` = **`base_measure` (req) · `conversion_measure` (req) ·
`entity` (req) · `calculation` (`conversion_rate` default | `conversions`) · `window` ·
`constant_properties: [{base_property, conversion_property}]`**.

**Filter syntax** — Jinja pseudo-functions DSI parses into a `WhereFilterIntersection` plus
structured call-parameter sets (`call_parameter_sets.py`, `implementations/filters/where_filter.py`):
```
{{ Dimension('order__is_food_order') }} = true
{{ TimeDimension('metric_time', 'month') }} >= '2024-01-01'
{{ Entity('customer') }} is not null
{{ Metric('lifetime_value', group_by=['customer']) }} > 100      -- filter-by-metric; group_by required
```
Dimension references use the `entity__dimension` double-underscore join path.

### 1.3 Time spine

Docs: <https://docs.getdbt.com/docs/build/metricflow-time-spine>

- **Legacy (dbt ≤ 1.8):** a model literally named `metricflow_time_spine.sql`, daily grain,
  discovered **by name**. Deprecated.
- **Current (dbt 1.9+):** a `time_spine` property on any model:
```yaml
models:
  - name: time_spine_daily
    time_spine:
      standard_granularity_column: date_day
      custom_granularities:
        - {name: fiscal_year, column_name: fiscal_year_column}
    columns:
      - name: date_day
        granularity: day          # must match standard_granularity_column
```
- **The change landed in dbt v1.9.** At least one **daily**-grain spine is required; several are
  allowed but must not overlap grains; the column must be a date/time type declared under `columns`
  with its `granularity`.
- **Required for:** cumulative metrics, metric offsets (`offset_window` / `offset_to_grain`),
  conversion metrics, SCD2, and any measure input with `join_to_timespine: true`.

### 1.4 `saved_queries` and `exports`

Docs: <https://docs.getdbt.com/docs/build/saved-queries> ·
<https://docs.getdbt.com/docs/use-dbt-semantic-layer/exports> ·
spec: `implementations/saved_query.py`, `implementations/export.py` @ v0.8.5

```
PydanticSavedQuery:            name, query_params, description, metadata, label, exports, tags
PydanticSavedQueryQueryParams: metrics (req), group_by, order_by, limit, where
PydanticExport:                name, config
PydanticExportConfig:          export_as (req), schema_name (yaml key `schema`), alias
```
`ExportDestinationType` is **`table` | `view` only** — no `csv`, and **no `database` field** in the
1.10 spec (the docs show one; it is not in DSI 0.8.5).

```yaml
saved_queries:
  - name: order_metrics
    query_params:
      metrics: [order_total, food_order_total]
      group_by: ["Dimension('order__is_food_order')", "TimeDimension('metric_time', 'day')"]
      where: ["{{ Dimension('order__is_food_order') }} = true"]
    exports:
      - name: order_metrics_table
        config: {export_as: table, schema: analytics, alias: my_export_alias}
```

**How exports actually run — the load-bearing finding.** `dbt sl export` / `dbt sl export-all` and
`dbt build --resource-type saved_query` are **dbt platform (Cloud) only**. **There is no
`mf export` command**: the `dbt-metricflow` CLI's full command set is `tutorial`, `query`,
`list {metrics,dimensions,entities,dimension-values,saved-queries}`, `health-checks`,
`validate-configs`
(<https://github.com/dbt-labs/metricflow/blob/main/dbt-metricflow/dbt_metricflow/cli/main.py>).
`query` accepts `--saved-query` (it *reads* one) but nothing writes an export table. So:
**saved-query definitions are open and parseable; materialising an export is a dbt Cloud feature
anyone self-hosting must reimplement** (run the compiled SQL as `CREATE TABLE/VIEW`). That is a few
hundred lines, not a blocker — and for the OS it is naturally a dbt **model** that Dagster
materialises (see §7.9 and M14).

### 1.5 How metrics are queried

Docs: <https://docs.getdbt.com/docs/build/metricflow-commands> ·
<https://docs.getdbt.com/docs/dbt-cloud-apis/sl-api-overview>

- **`mf <cmd>`** — dbt **Core / self-hosted**, runs locally; installed as
  `pip install "dbt-metricflow[dbt-<adapter>]"`. Needs a `dbt parse` after any metric change to
  refresh `target/semantic_manifest.json`.
- **`dbt sl <cmd>`** — **dbt platform only**, executes remotely (Studio, platform CLI, VS Code);
  needs `dbt_cloud.yml` + a token.
- Shared: `list metrics|dimensions|dimension-values|entities`, `query`. Core-only:
  `validate-configs`, `health-checks`, `tutorial`. Cloud-only: `list saved-queries`, `export`,
  `export-all`.
- **The Semantic Layer APIs are dbt Cloud only**, on paid tiers — the overview page's availability
  banner reads verbatim *"dbt platform | Starter, Enterprise, Enterprise+"*. Currently listed:
  **GraphQL API, JDBC API, Python SDK**. **ADBC is no longer listed** — do not design against it.
  There is no self-hostable Semantic Layer API from dbt Labs.

### 1.6 Trino support in MetricFlow — it exists

This is directly relevant to the options. `SupportedAdapterTypes` in
`dbt-metricflow/dbt_metricflow/cli/dbt_connectors/adapter_backed_client.py` is
`ATHENA, DATABRICKS, POSTGRES, SNOWFLAKE, REDSHIFT, BIGQUERY, DUCKDB, **TRINO**, VERTICA,
CLICKHOUSE`, and there is a dedicated renderer `metricflow/sql/render/trino.py`
(<https://github.com/dbt-labs/metricflow/tree/main/metricflow/sql/render>), with an install extra
`pip install "dbt-metricflow[dbt-trino]"`. Iceberg needs no special handling — it is transparent
beneath dbt-trino. **Caveat:** Trino is a community/vendor-contributed adapter, not in dbt Labs'
Tier-1 test matrix, and the Trino renderer carries a workaround comment pointing at
<https://github.com/trinodb/trino/issues/130>.

Also worth knowing: the MetricFlow repo now ships a **stdio sidecar**
(<https://github.com/dbt-labs/metricflow/tree/main/sidecar>, releases tagged
`mf-stdio-sidecar/v0.213.0+`) — an IPC shim for driving MetricFlow out-of-process. That is a clean
seam for a TypeScript host to call it as a subprocess.

---

## 2. Licence due diligence

### 2.1 🔴 The headline: MetricFlow is **no longer BSL**

**MetricFlow was relicensed from Business Source License 1.1 to Apache-2.0 on 2025-10-14.**
Verified three independent ways:

1. The commit on `LICENSE`: *"Change License to Apache 2.0 (#1905)"*, 2025-10-14T16:00:35Z —
   `https://api.github.com/repos/dbt-labs/metricflow/commits?path=LICENSE`
2. The tag boundary: `v0.208.1`'s LICENSE begins *"License text copyright © 2017 MariaDB
   Corporation Ab … Business Source License"*; **`v0.209.0`** (published 2025-10-14T16:06:48Z, six
   minutes after the commit) begins *"Apache License / Version 2.0"*. So **v0.209.0 is the first
   Apache-2.0 release; ≤ v0.208.1 is BSL.**
3. Packaging: `pyproject.toml` on `main` declares `license = "Apache-2.0"` for both `metricflow`
   and `dbt-metricflow`; PyPI `dbt-metricflow` 0.15.0 reports `license_expression: Apache-2.0`.

Full history: Apache-2.0 at the initial commit (2022-04-06) → **BSL on 2023-04-28** ("Update
MetricFlow License to BSL (#462)") → Apache-2.0 again on 2025-10-14.

**The BSL Additional Use Grant, verbatim** (historical — applies to `v0.208.1` and earlier only;
from <https://raw.githubusercontent.com/dbt-labs/metricflow/v0.207.0/LICENSE>):

> **Licensed Work:** MetricFlow
> **Change Date:** The change date for each release of the Licensed Work will be the 3rd
> anniversary of the initial release date of that release of the Licensed Work.
> **Change License:** Apache 2.0 https://www.apache.org/licenses/LICENSE-2.0
> **Additional Use Grant:** The Licensor hereby grants you the right to use the Licensed Work for
> production purposes that consist of your internal business purposes, but not for the purpose of
> providing managed services or software-as-a-service to others.

**Can the OS run MetricFlow server-side as part of its own product?**

- **Under the old BSL (≤ v0.208.1): no.** The grant covered production use only for *your own
  internal business purposes* and expressly excluded *"providing managed services or
  software-as-a-service to others"* — which is precisely a hosted or customer-licensed Sovereign OS
  embedding MetricFlow as its metric engine. It would have needed a commercial licence from dbt
  Labs, or that release's Change Date.
- **Under Apache-2.0 (≥ v0.209.0, current v0.213.0): yes, freely.** No field-of-use restriction, no
  SaaS carve-out. Ordinary Apache-2.0 obligations only: preserve copyright/licence/NOTICE, state
  changes to modified files, patent grant and termination. **BSL applies per version and does not
  relax retroactively**, so the operational requirement is: pin `metricflow >= 0.209.0`, and ensure
  no vendored or lockfile-pinned ≤ 0.208.1 copy survives anywhere in the build.

### 2.2 Table

| Candidate | Licence | Verified at | Notes |
|---|---|---|---|
| **dbt-core** | **Apache-2.0** | `License.md` @ <https://raw.githubusercontent.com/dbt-labs/dbt-core/v1.10.0/License.md> | `github.com/dbt-labs/dbt-core` now 301-redirects to `github.com/dbt-labs/dbt` (the Fusion monorepo), whose root LICENSE is also Apache-2.0. The Python dbt-core tree exists only under version tags. Already declared in the OS: `THIRD-PARTY-LICENSES.md:95`, `licenses/components.tsv:24` |
| **dbt-semantic-interfaces** | **Apache-2.0** — confirmed | <https://github.com/dbt-labs/dbt-semantic-interfaces/blob/main/LICENSE> | Spec + validation **only**; see §2.3 |
| **metricflow** | **Apache-2.0 from v0.209.0 (2025-10-14)**; BSL 1.1 at ≤ v0.208.1 | <https://github.com/dbt-labs/metricflow/blob/main/LICENSE> | All SQL generation lives here (dataflow planner, `sql/render/trino.py`, join resolution) |
| **dbt-metricflow** (CLI) | **Apache-2.0** | `dbt-metricflow/pyproject.toml` on `main`; PyPI 0.15.0 | Same monorepo, same LICENSE; historically inherited the BSL |
| **dbt Semantic Layer (Cloud)** | **Proprietary SaaS** | <https://docs.getdbt.com/docs/dbt-cloud-apis/sl-api-overview> | Banner: *"dbt platform \| Starter, Enterprise, Enterprise+"*. Not self-hostable |
| **Cube** | **Apache-2.0** (root LICENSE offers Apache-2.0 **or** MIT; Apache-2.0 is the default) | <https://github.com/cube-js/cube/blob/master/LICENSE> | All 58 `LICENSE*` files in the tree enumerated, incl. `cubejs-backend-cloud`, `cubejs-schema-compiler`, `cubejs-backend-native`, `rust/cubesql`, `rust/cubestore` — **all Apache-2.0; no BSL/ELv2/commercial-source directory in the OSS repo.** GitHub shows `NOASSERTION` only because of the dual-licence preamble. **Cube Cloud is a separate closed product.** Already declared in the OS: `THIRD-PARTY-LICENSES.md:97` |
| **Lightdash** | **MIT, except a source-available carve-out** | <https://github.com/lightdash/lightdash/blob/main/LICENSE> + <https://github.com/lightdash/lightdash/blob/main/packages/backend/src/ee/LICENSE> | `packages/backend/src/ee` is **"The Lightdash Source Available License"** (Telescope Technology Ltd): production use **only** with a valid Lightdash Enterprise Subscription + their ToS; licensor retains title to your modifications; copy/merge/publish/distribute/sublicense/sell **forbidden**; dev-and-test allowed; **auto-terminates on breach, incl. a lapsed subscription**. **`ee/` is unusable for this product.** |
| **Evidence** | **MIT** | <https://github.com/evidence-dev/evidence/blob/main/LICENSE> | Clean |
| **Malloy** | **MIT** (not GPL — relicensed; GitHub shows `NOASSERTION` only because of the custom header line) | <https://github.com/malloydata/malloy/blob/main/LICENSE> | Clean, but it is **a different semantic model**, not a dbt-manifest compiler |
| **Rill** | **Apache-2.0** | <https://github.com/rilldata/rill/blob/main/LICENSE.md> | Clean; DuckDB-based (DuckDB MIT, already declared `THIRD-PARTY-LICENSES.md:102`) |
| **Holistics** | Proprietary SaaS (AML modelling language, no OSS core) | — | Not an option |
| **Looker** | Proprietary (Google Cloud; LookML is a closed spec) | — | Not an option |

### 2.3 `dbt-semantic-interfaces` contains the spec only — no SQL generation (confirmed)

The package root contains exactly: `call_parameter_sets.py`, `dataclass_serialization.py`,
`enum_extension.py`, `errors.py`, `implementations/`, `naming/`, `parsing/`, `pretty_print.py`,
`protocols/`, `references.py`, `test_helpers/`, `test_utils.py`, `transformations/`,
`type_enums/`, `validations/`. **No `sql/`, no `render/`, no `plan/`, no query compiler.** The only
thing resembling compilation is `call_parameter_sets.py` + `implementations/filters/where_filter.py`,
which parse the `{{ Dimension(…) }}` / `{{ TimeDimension(…) }}` / `{{ Metric(…) }}` Jinja calls into
*structured reference sets* — they record which dimensions a filter touches; they do not render SQL.

So before October 2025 the split was: you could **parse and validate** dbt metrics permissively but
could not legally **execute** them server-side in a product. Since v0.209.0 the whole stack is
permissive.

Is there another permissive dbt-manifest→SQL compiler? **Effectively no, and the question has
dissolved** — MetricFlow itself is now the permissive reference implementation. Web search surfaced
small/early projects (*Boring Semantic Layer* MIT/Ibis, *Dosi*, *SLayer*, *OpenSemanticLayer* — a
BSL-era MetricFlow fork), **none verified** for licence, maintenance or manifest compatibility;
several surfaced from Cube's own comparison marketing. Do not put weight on them. The genuine
permissive alternatives are *different* semantic models (Cube, Malloy), not dbt-manifest compilers.

### 2.4 The OS's own licence gate already decides part of this

Independently of the legal analysis, the repo has a CI gate with a hard-deny list:
`licenses/denied-licenses.txt` denies `SSPL, Elastic-2.0, ELv2, **BUSL, BSL-1.1**, Commons-Clause,
AGPL` as case-insensitive substrings, enforced by `scripts/license-check.sh` and
`.github/workflows/license-gate.yml` (`THIRD-PARTY-LICENSES.md:187`);
`licenses/allowed-licenses.txt` allows `Apache-2.0, MIT, BSD-2/3-Clause, ISC, 0BSD, PostgreSQL,
MPL-2.0, GPL-3.0-only/or-later`. So:

- A BSL-era MetricFlow (≤ 0.208.1) **cannot enter the bundle** — the gate fails the build. Good.
- An Apache-2.0 MetricFlow (≥ 0.209.0) **passes** the gate, and must be added to
  `licenses/components.tsv` + `THIRD-PARTY-LICENSES.md` if it is ever bundled in an image.
- Lightdash's `ee/` is not an SPDX id the gate would catch — it would pass the substring deny list
  while being unusable. **Add `Lightdash Source Available` (or a generic `Source Available`
  substring) to `denied-licenses.txt`** if Lightdash is ever considered.

### 2.5 Conclusion

**What the OS may ship under Apache-2.0 without a conflict:** the dbt metric **spec itself** (YAML
is not code), dbt-core and dbt-trino (already bundled), `dbt-semantic-interfaces`, **and — since
v0.209.0 — MetricFlow and `dbt-metricflow` themselves**, plus Cube, Rill, Evidence and Malloy if
ever wanted. **What it must NOT embed:** any MetricFlow ≤ v0.208.1 (BSL, and the Additional Use
Grant excludes exactly this product's use), Lightdash's `packages/backend/src/ee` (source-available,
subscription-gated, non-redistributable), and the dbt Cloud Semantic Layer / Holistics / Looker
(proprietary, not shippable at all).

### 2.6 What the licence change does and does not change

It removes the licence objection to Option B — but **not** the identity, latency and runtime
objections (§4). It also hands the programme something valuable it could not have before: a
**licence-clean parity oracle**, which converts checklist item M7 from *"untestable here"* into a
real differential test, and a legitimate option for the **batch** half of the design where Python
and dbt already live (the Dagster run pod).

---

## 3. Audit — what a "metric" is in the OS today

### 3.1 The artifact: a metric IS a `Measure` on a `Dataset`

There is **no metric store**. A metric is one entry in `dataset.measures[]`, and the metric
registry is a read model over the Data tab's dataset store.

| Fact | Where |
|---|---|
| `Measure` type: `{name, type, sql, label?, filters?, rollingWindow?, format?, drillMembers?, dimensions?, formula?, description?}` | `os-ui/tabs/data/lib/dataset-schema.ts:92-124` (`MeasureFilter` `:80`, `RollingWindow` `:85`) |
| `type` ∈ `count · count_distinct · count_distinct_approx · sum · avg · min · max · number` | `tabs/data/lib/metrics.ts` (`MEASURE_TYPES`), used at `tabs/metrics/lib/model.ts:87` |
| The canonical identity: `member = ${ViewNoSpaces}.${measure.name}` — frozen across renames (a rename writes `label`) | `tabs/metrics/lib/model.ts:123-125`, `:184-191`; `dataset-schema.ts:96-100` |
| Metric id = `` `${dataset.id}.${measure.name}` `` | `tabs/metrics/lib/store.ts:48`, `governance.ts:41` |
| Write path (UPSERT by measure name) | `tabs/data/lib/store.ts:1440-1468` `defineMeasure`; delete at `:1479-1492` `removeMeasure` |
| Registry read model (no second store) | `tabs/metrics/lib/store.ts:9-15`, `:45-67`, `listMetrics` `:99-113`, `getMetric` `:116+` |
| Lifecycle overlay (archive/restore/folders/version log) — a measure can't carry it | `tabs/metrics/lib/lifecycle.ts:23-40` |
| Governance: tiers `personal → domain → marketplace`, reusing the data lifecycle gate + a consistency gate | `tabs/metrics/lib/governance.ts:10-23`, `governMetric` `:62-80`, `canPromote/canCertify` `:83-88` |
| Consistency: form/agent/YAML converge on ONE `Measure`; every consumer resolves the same member | `tabs/metrics/lib/consistency.ts:17-30`; `sameMeasure` `tabs/metrics/lib/model.ts:378-394` |

Three authoring doors converge on the identical `Measure`:
`measureFromForm` (`model.ts:177-239`), `measureFromAgent` (`:310-312`), `measureFromYaml`
(`:318-331`, parsing a **Cube** `cubes:/measures:` block). Guided filters compile to a Cube-style
predicate `{CUBE}.<col> = 'x'` (`filterSql` `model.ts:143-155`) and parse back (`parseFilterSql`
`:251-262`). Columns are validated against `/^[A-Za-z_][A-Za-z0-9_]*$/` before reaching SQL
(`assertColumn` `model.ts:95-110`) — the injection gate.

**So the OS's metric model is Cube's measure model**, not dbt's. Vocabulary: `measure` with a
`type` (not `agg`), `rolling_window`, `drill_members`, `format`, `{CUBE}.` placeholders,
`{measure}` curly references for ratios/formulas.

### 3.2 Compilation and execution: already TS → Trino SQL (no Cube server on the read path)

This is the most important finding for the options below: **the OS already owns a metric→SQL
compiler** and Cube is no longer on the read path.

- `tabs/metrics/lib/explorer.ts` is the compiler. `exploreSpec` (`:45-84`) reconciles the slice
  against the view's member set and records **dropped** members loudly (`:58-72`). `baseAggExpr`
  (`:106-141`) emits the per-group aggregate: `COUNT(*)`, `COUNT(DISTINCT x)`, `approx_distinct(x)`,
  `SUM/AVG(CAST(x AS double))`, `MIN/MAX(x)`, with guided filters as `FILTER (WHERE …)` (the
  `{CUBE}.` prefix is stripped — the mart *is* the model's table, `:107-109`) and a ratio expanded
  **one level** by substituting sibling aggregates (`:125-138`).
- `previewTrinoSql` (`:247-281`) is the serve SQL: `SELECT <dims>, date_trunc('<grain>', "<t>") AS "<t>", <agg> AS "<name>" FROM <goldFqn> [WHERE …] GROUP BY 1..n LIMIT n`.
  It deliberately emits **no SQL comments** because the governed query path rejects statements
  containing `--` or `/* */` (`:274-276`).
- Cumulative / trailing windows: `windowTrinoSql` (`:209-232`) wraps the bucketed series —
  `SUM(SUM(x)) OVER (PARTITION BY dims ORDER BY date_trunc(grain, t) <frame>)`; `windowFrame`
  (`:171-194`) maps `trailing: 'unbounded'` → `ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`
  and `trailing: 'N unit'` → `ROWS BETWEEN N-1 PRECEDING AND CURRENT ROW`, **but only when the
  window unit equals the slice granularity**; otherwise it returns `null` → honest `pending`
  (`:182-193`). The comment at `:188-193` admits the semantics: the frame counts *existing* buckets,
  not calendar units — there is **no time spine**.
- Server boundary `tabs/metrics/lib/build/explore-server.ts`: tier-aware gold FQN
  (`goldReadTarget` `:57-60` — `iceberg.personal_<uid>.gold_<slug>` for a personal dataset, else
  `iceberg.<domain>.gold_<slug>`), `propagate(token)` asserts the token is user-delegated (R2/R3)
  and `queryRun(sql, identities.trino.user)` runs it **as the viewer** (`:151-180`). The honesty
  gate (`metricsMustBeLive` `:42-44`, `:118-132`) returns `mode: 'unavailable'` with no number when
  Trino is unreachable on a real deployment; the hash-seeded offline mock (`mockRows` `:67-82`) is
  local/teaching only and still enforces the region RLS.
- Build (apply→verify) adapter: `tabs/metrics/lib/build/live.ts:50-70` — one adapter, `trino`;
  a ✓ means the member actually resolved to a number (`verify` `:60-67`).
- Dashboards consume the **same** path: `tabs/dashboards/lib/build/panel-query.ts:13-24` calls
  `exploreMetric`; `registryResolver` (`:54-67`) maps a panel's `View.measure` member back to
  (dataset, measure) through the RLS-scoped registry, so a chart's number is the explorer's number
  by construction. Panel model: `tabs/dashboards/lib/model.ts:32` (`PanelFilter`), `:47-54`
  (`metrics`/`metric` members, group-by dims, time dim), `:163-187` (`missingMembers` — the loud
  "the served model does not expose this member" check), `panel-views.ts:22-49`.

### 3.3 The MetricFlow-shaped artifact that already exists (and where it stops)

`os-ui/tabs/data/lib/semantic.ts` already emits a **dbt MetricFlow-style declaration** per dataset:

- Header (`:8-26`): *"the MetricFlow-style SEMANTIC DECLARATION artifact (Phase 1 of the Cube→Trino
  migration) … the dbt MetricFlow YAML shape (`semantic_models:` + `metrics:`) is the PORTABLE
  contract, and our own compiler (previewTrinoSql) serves it as governed Trino SQL. It does NOT need
  to be executed by MetricFlow."*
- `scaffoldSemanticYaml` (`:76-124`): one `semantic_models:` entry per dataset,
  `model: ref('mart_<slug>')`, `entities:` = the inferred primary key (`primaryKeyColumn` `:47-50`),
  `dimensions:` = every non-PK gold output column with `type: time|categorical` and
  `type_params.time_granularity: day` for time dims (`:92-97`), `measures:` with MetricFlow `agg`
  (`AGG_OF` `:31-38`: `count/count_distinct/sum/average/min/max`) + `expr`, then `metrics:` — one
  `type: simple` per aggregate and one `type: derived` per ratio with
  `expr: "{{ metric('a') }} / {{ metric('b') }}"` (`:108-120`).
- Artifact path `semantic/<modelName>.yml` (`:126-128` `SEMANTIC_ARTIFACT`), written on every
  define/remove (`store.ts:1463`, `:1487`).

**Where it stops — three gaps that matter:**

1. **It never reaches the dbt project.** `generateProject` (`tabs/data/lib/dbt/generate.ts:30-49`)
   emits `dbt_project.yml`, `profiles.yml`, `README.md`, `.gitignore`, `macros/`, `tests/generic/`,
   `models/sources.yml`, the model `.sql` files, `models/**/schema.yml`, `os/schedules.yml`,
   `os/external.yml`, `os/sources.yml` — and **nothing semantic**. `grep -rn semantic
   tabs/data/lib/dbt/` returns only two unrelated prose hits (`schedules.ts:11`, `parity.ts:194`),
   and none of the three goldens in `tabs/data/lib/dbt/fixtures/*.golden.json` contains a semantic
   model. So the metric a user defines is **not** in the data product's git repo, is **not** in the
   commit log, and is invisible to `dbt parse`, to the Dagster code location and to anyone who
   clones the project.
2. **It is lossy.** `isSimpleMeasure` (`:43-45`) excludes every rolling-window and
   `count_distinct_approx` measure, and `scaffoldSemanticYaml` silently drops a ratio whose refs
   aren't all simple measures (`:115`). A composite `formula` metric is emitted as `derived` only via
   the ratio path. There is no `agg_time_dimension`, no `defaults:`, no `filter:`, no metric `label`
   / `description` / `meta`, no `type: ratio`, no `type: cumulative`, no `saved_queries`.
3. **It is a string builder, not a model.** 124 lines of `lines.push()`; no schema type, no
   validation against the dbt spec, no round-trip parser. (Contrast the dbt generator, which goes
   through `emit.ts` `yml()` and is golden-tested.)

Also note the parallel, Cube-shaped artifact that *is* the one the UI reads:
`tabs/data/lib/metrics.ts` `scaffoldMetricYaml` (`:262-265`) — cube + view declaration, with the
whole `modelName`/`viewName` namespacing problem documented at `:28-118`. Lineage treats a measure
as an **OS** node, not a dbt node: `tabs/data/lib/dbt/lineage.ts:103-108` —
*"Consumption axis stays the OS's own: a measure is an OS metric, not a dbt node."*

### 3.4 The data product repo layout a new YAML section would land in

From `generateProject` (`generate.ts:30-49`) and `docs/components/dbt.md`:

```
<domain>.git (bare, /repos/<domain>.git, PVC os-repos)
  dbt_project.yml            name=<domainSchema>, profile=sovereign, per-layer +schema (project.ts:24-52)
  profiles.yml               trino target, env_var() only, impersonation_user=env_var('OS_PRINCIPAL') (project.ts:78-108)
  macros/generate_schema_name.sql, macros/os_maintenance.sql       (project.ts:110-150)
  tests/generic/{range,not_blank}.sql                              (project.ts:153-188)
  models/sources.yml         bronze + federated tables             (sources.ts)
  models/silver/*.sql, models/gold/*.sql, models/personal/<uid>/*.sql   (models.ts:planModels)
  models/**/schema.yml       descriptions + quality rules as data_tests (schema.ts)
  os/schedules.yml           {dataset, select:"<model>+", cron, timezone:UTC, principal, enabled} (schedules.ts:28-49)
  os/external.yml            what dbt cannot model                 (schedules.ts:51-68)
  os/sources.yml             observable source assets              (source-assets.ts)
  README.md, .gitignore
```

Every mutation is one commit authored as the acting user: `tabs/data/lib/dbt/commit.ts:1-21`,
`commitDataProject` `:78+`; trailers `OS-Action / OS-Dataset / OS-Surface / OS-Request-Id`
(worked example in `docs/superpowers/plans/2026-11-13-data-products-concept.md:164-183`). One door
for UI and MCP: `tabs/data/lib/mutations-server.ts` (checklist D2/D18).

### 3.5 How a new YAML section becomes Dagster assets

`images/extensions/dagster/os_projects.py` + `repo.py`:

- `discover()` (`os_projects.py:565+`) lists `<checkout>/<domain>/current -> <sha>`; `load_project`
  (`:487-519`) requires `target/manifest.json` (written by `dbt parse`, `:134-140` under the
  allowlisted `parse_env` `:120-131`), then reads `os/schedules.yml` (`:492-498` →
  `parse_schedules` `:176-208`) and `os/sources.yml` (`:499-506` → `parse_source_assets` `:270+`).
  A domain whose manifest is missing is **skipped with a reason**, never fatal (`:489-490`).
- `repo.py:296+` `_wire_project` builds `@dbt_assets(manifest=…)` per domain (`:315-321`) under a
  prefixing `DagsterDbtTranslator` (`:80-90`), plus per-domain jobs (`all_job_name`
  `os_projects.py:217`), schedules, the maintenance job (`repo.py:428-440`), source observations
  (`_source_assets` `:160-208`) and sensors (`os_quarantine` `:243`, `os_principals` `:265`).
- **Consequence:** anything the OS writes into the dbt project *as dbt* (a `semantic_models:` /
  `metrics:` / `saved_queries:` block in a `models/**/*.yml`) appears in `manifest.json`
  automatically and is carried by `dagster-dbt` without a new parser. Anything the OS writes into a
  new `os/*.yml` section needs a new `parse_*` function in `os_projects.py` and wiring in `repo.py`
  — the pattern to copy is `parse_source_assets` + `_source_assets` + `observe_job_name`
  (`os_projects.py:270-400`, `repo.py:160-208`).
- Note: `dagster-dbt` builds assets from `manifest.json` nodes. `saved_queries`/`exports` are
  manifest nodes in dbt ≥1.8, but `dagster-dbt`'s `@dbt_assets` selects models/seeds/snapshots —
  an **export** would most cleanly become its own asset wrapping `dbt sl export` / a materialised
  `metrics_<name>` model (see M5 in §6 and the open question in §7).

### 3.6 MCP surface today (and its parity with the UI)

| Tool | File:line | Notes |
|---|---|---|
| `suggest_metrics` | `tabs/metrics/mcp/metric-write-tools.ts:117-135` | reasoning model, read-only, grounded in strategy/OM/process/datasets |
| `define_metric` | `:137-232` | full Cube measure model in the description (`:141`); UPSERT by name; returns member + **Cube YAML** |
| `preview_metric` | `:233-276` | transient, no persist |
| `promote_metric` | `:277+` | creator files a request; builder+ runs the consistency-gated transition |
| `list_metrics` | `tabs/admin/mcp/discovery-read-tools.ts:296-303` | DLS-scoped registry |
| `query_metric` | `tabs/admin/mcp/discovery-read-tools.ts:305-352` | **no `sql` parameter by construction** (`core/mcp/wave-a.test.ts:96-98`); slices by `dimensions`/`timeDimension`/`granularity`; runs `exploreMetric` under a delegated token (`:333-341`) |

Two things to fix in passing: `query_metric`'s description still says *"the tool builds a Cube load
query … and Cube applies per-viewer row-level security"* (`discovery-read-tools.ts:309`) and
`define_metric` still promises *"the generated Cube YAML"* (`:141`) — both are stale since the
Trino migration. `tabs/metrics/context.md:3-20` has the same Cube framing.

### 3.7 Summary — "a metric today" vs "a dbt metric"

| | OS today | dbt / MetricFlow |
|---|---|---|
| Unit | `Measure` on a `Dataset` (`dataset-schema.ts:92`) | `measure` inside a `semantic_model`, plus a separate `metric` |
| Identity | `View.measure` member (`model.ts:123`) | metric `name` in the semantic manifest |
| Where it lives | the OS dataset record (Postgres/OpenSearch) + a non-committed `semantic/*.yml` artifact | a `.yml` file in `models/` in the dbt project, in git |
| Types | `count/count_distinct/approx/sum/avg/min/max/number(ratio|formula)` + `rollingWindow` | `simple`, `ratio`, `derived`, `cumulative`, `conversion` |
| Entities/joins | none — a metric is bound to **one** gold mart | `entities` enable multi-model joins |
| Time | slice-time `timeDimension` + `granularity`; frames count existing buckets | `agg_time_dimension` + a required **time spine** model; calendar-correct grains and offsets |
| Filters | one guided filter per measure + slice-time equality filters | `filter:` on metric, numerator, denominator, measure; `{{ Dimension() }}` / `{{ TimeDimension() }}` / `{{ Metric() }}` |
| Query | OS compiler → one governed Trino `SELECT` as the viewer | `mf`/`dbt sl query`, or the dbt Cloud Semantic Layer APIs |
| Versioning | OS version log + archive overlay (`lifecycle.ts`) | a git commit on the YAML file |
| Materialisation | none | `saved_queries` + `exports` |

---

## 4. Options and recommendation

### Option A (recommended) — spec-compatible dbt YAML in the repo + the OS's own compiler

Write real `semantic_models:` + `metrics:` (+ later `saved_queries:` / `exports:`) into the domain's
dbt project, under `models/semantic/<model>.yml`, through the existing generator/commit path; keep
**execution** in the OS's own TypeScript compiler over Trino, extended to the dbt metric types.

- **Licence:** clean twice over. The YAML *spec* is not code at all, `dbt-core` + `dbt-trino` are
  already bundled Apache-2.0 (`THIRD-PARTY-LICENSES.md:95`, `licenses/components.tsv:24`,
  `2026-11-13-data-products-concept.md:161`), and since MetricFlow's October 2025 relicensing
  (§2.1) even the reference implementation is Apache-2.0 — so there is nothing to avoid and no
  constraint on shipping the artifact. See §2.
- **Identity:** unchanged and already correct — `propagate(token)` + `queryRun(sql, trino.user)`
  (`explore-server.ts:151-173`), Trino impersonation via `OS_PRINCIPAL` (`project.ts:78-108`), OPA +
  the chained file-based rules (`core/infra/trino-rules.ts`). **MetricFlow cannot do this**: it opens
  one warehouse connection from its own profile, so per-viewer RLS would be lost.
- **Git-based working:** a metric change becomes a commit in the domain repo with the existing
  trailers — the thing that does **not** happen today (§3.3 gap 1).
- **Parity with how an engineer does it:** they can clone the repo, read the metric YAML they
  recognise, and run `mf query`/`dbt sl query` against it themselves if they want (they supply their
  own MetricFlow, under their own licence — the OS neither ships nor runs it).
- **Effort:** medium. The compiler exists; the work is (a) a typed model + emitter + round-trip
  parser for the dbt spec, (b) the metric types the OS lacks (`ratio` with per-side filters, true
  `cumulative`, `derived` with `offset_window`), (c) a time-spine model, (d) wiring the files into
  `generateProject`.
- **Cost:** two vocabularies during migration (the Cube `Measure` stays the internal model until a
  later phase makes the dbt metric the source of truth). Also: the OS compiler must not silently
  disagree with MetricFlow's semantics — that is the real risk, mitigated by §6 M7.

### Option B — run MetricFlow server-side (now licence-clean; still not the interactive path)

The October 2025 relicensing (§2.1) removes the reason this option was previously a non-starter, and
two facts make it genuinely viable in part: **dbt-trino is a supported MetricFlow adapter** with a
dedicated `sql/render/trino.py` (§1.6), and dbt-trino's `impersonation_user` is already wired to
`env_var('OS_PRINCIPAL')` in the generated `profiles.yml` (`tabs/data/lib/dbt/project.ts:91`) — so a
MetricFlow process launched **with the viewer as `OS_PRINCIPAL`** would, under authenticated Trino,
genuinely run as that viewer. The honest objections are now operational, not legal:

1. **Runtime in the wrong place.** MetricFlow is Python; the metric read path is TypeScript in
   os-ui. Serving an interactive KPI tile would mean a Python subprocess (or the stdio sidecar,
   §1.6) per request, each needing a parsed `semantic_manifest.json` and an adapter connection.
   Against the memory-pressure guardrails this programme is already operating under, putting a
   Python process on the request path of every dashboard tile is the wrong trade.
2. **Latency and identity together.** Per-viewer RLS means per-viewer process (or at least a
   per-principal connection pool) — you cannot share one warm MetricFlow across users without
   giving up the R2/R3 guarantee that is the OS's whole point. One warm process per principal does
   not scale; one cold process per request is seconds.
3. **Adapter tier.** Trino is a community-contributed MetricFlow adapter, not in dbt Labs' Tier-1
   matrix, and the Trino renderer carries a known-limitation workaround
   (<https://github.com/trinodb/trino/issues/130>). Fine for batch; thin ice for the surface that
   must never show a wrong number.
4. **Trino does not authenticate clients today** (`docs/components/trino.md`, deviation B3-2), so
   `impersonation_user` has nothing to match until `http-server.authentication.type` is set. The
   same caveat applies to dbt runs today — it is a deploy decision, not a code one — but it means
   "MetricFlow runs as the viewer" is not true until that is done.

**Where it IS the right answer — take both:**

- **As a parity oracle in CI (B′).** Run `mf query` against a DuckDB or Trino fixture over the same
  committed YAML and assert the OS compiler's numbers match. This is a real differential test and it
  is now licence-clean. It converts M7 from "untestable here" into a test.
- **For batch / exports (B″).** The Dagster run pod already has Python, dbt, dbt-trino, `git` and
  `OS_PRINCIPAL` (`images/extensions/dagster/Dockerfile`, `repo.py`, `os_projects.py`). Adding
  `dbt-metricflow[dbt-trino]` there, to materialise `saved_queries` → exports as the declared
  principal, costs nothing on the request path and is exactly how an engineer would do it.

### Option C — bundle Cube as a component

Cube's core is Apache-2.0, so it is shippable, and it is where the OS came *from*. But: it is a
second semantic layer with its own YAML (so the owner's ask — *dbt* metrics — is not met), it is a
second service to operate, and the OS has just finished removing it from the read path
(`explorer.ts` header, `explore-server.ts:20-27`). Its RLS story (`securityContext`) is also a
per-request JWT the OS would have to mint, duplicating the Trino impersonation that already works.
Keep Cube deleted.

### Recommendation

**Option A for the interactive read path, plus MetricFlow (B′/B″) as the CI parity oracle and the
batch/export engine.** Concretely: the dbt metric YAML becomes the *portable, committed contract*
written into the domain's dbt project by the existing generator and commit path, and the OS's own
TypeScript compiler keeps serving every interactive read as one governed Trino `SELECT` under the
signed-in user — which is the only way the R2/R3 identity guarantee survives, and is the direction
`semantic.ts:8-26` already states. Because MetricFlow is now Apache-2.0, the OS additionally gains
what it could not have before: a licence-clean reference implementation to **test the compiler
against** in CI, and a legitimate engine for **saved-query exports** inside the Dagster run pod
where Python, dbt and `OS_PRINCIPAL` already live.

Scoring against the owner's criteria: **licence** — A and B are both clean now, so licence stops
deciding and the OS should pick on merit; **identity** — A wins decisively (per-viewer Trino
impersonation on a TS path vs. a Python process per principal); **git-based working** — A delivers
it (metric = commit, which does not happen today); **parity with how an engineer does it** — A plus
B′ is stronger than A alone, because the artifact is the engineer's artifact *and* it is proven to
mean the same thing; **effort** — A is medium and incremental on existing code, B-as-the-read-path
is a new runtime on the hot path.

### What to support first (in order)

1. `semantic_models` done properly: `entities` (primary + foreign), `dimensions` (categorical +
   time with `type_params.time_granularity`), `measures` with `agg` + `expr` +
   `agg_time_dimension`, and `defaults.agg_time_dimension`.
2. `metrics: type: simple` with `filter:`.
3. `metrics: type: ratio` (numerator/denominator, each with its own optional `filter`). The OS's
   `number`/ratio measure maps here — and it is strictly better than today's one-level sibling
   expansion.
4. `metrics: type: derived` — `expr` over other metrics, `offset_window` second (that is the one
   that needs the time spine).
5. `metrics: type: cumulative` — `window` and `grain_to_date`. Replaces `rollingWindow` /
   `runningTotal` and fixes the calendar-vs-bucket bug (`explorer.ts:188-193`).
6. A **time spine** model in the generated project (`models/os/metricflow_time_spine.sql` or the
   newer `time_spine` config) — prerequisite for 4, 5 and for honest grains.
7. Query-time `group_by` + `where` with the `{{ Dimension('entity__dim') }}` filter syntax.
8. `saved_queries` + `exports` → a Dagster asset (§6 M5).
9. `conversion` metrics last — they need entity-level windowed joins, the most SQL and the least
   immediate value.

### Compiler sketch (one SQL shape per metric type)

Let `M` = the semantic model's `model: ref('gold_<slug>')` resolved to the tier-aware physical FQN
(`goldReadTarget`, `explore-server.ts:57-60`), `G` = the requested grain, `D` = the group-by
dimensions, `T` = the measure's `agg_time_dimension`.

```
simple(metric m over measure u, filter f)
  SELECT <D>, date_trunc(G, T) AS t, AGG(u.expr) FILTER (WHERE f) AS m
  FROM M [WHERE <query filters>] GROUP BY <D>, t

ratio(n, d)                         -- each side its own filtered aggregate, one pass
  SELECT <D>, t,
         CAST(AGG(n.expr) FILTER (WHERE f_n) AS double)
         / NULLIF(AGG(d.expr) FILTER (WHERE f_d), 0) AS m
  FROM M ... GROUP BY <D>, t

derived(expr over metrics m1..mk)   -- CTE per input metric at the same grain, then the expr
  WITH m1 AS (...), m2 AS (...)
  SELECT <D>, t, <expr with mi.value substituted> FROM m1 FULL JOIN m2 USING (<D>, t)

derived with offset_window('1 month')
  ... LEFT JOIN m1 AS prev ON prev.t = date_add('month', -1, m1.t) AND prev.<D> = m1.<D>
  -- requires the SPINE so a missing bucket is still a row

cumulative(window = '7 day' | grain_to_date = month)
  WITH spine AS (SELECT d FROM os_time_spine WHERE d BETWEEN ... ),
       base  AS (SELECT <D>, date_trunc(G,T) AS t, AGG(u.expr) AS v FROM M GROUP BY <D>, t),
       dense AS (SELECT <D>, spine.d AS t, COALESCE(v,0) AS v FROM spine LEFT JOIN base ON base.t = spine.d ...)
  SELECT <D>, t,
         SUM(v) OVER (PARTITION BY <D> ORDER BY t RANGE BETWEEN INTERVAL '7' DAY PRECEDING AND CURRENT ROW)  -- window
      -- SUM(v) OVER (PARTITION BY <D>, date_trunc('month', t) ORDER BY t ROWS UNBOUNDED PRECEDING)           -- grain_to_date
  FROM dense
```

The `RANGE BETWEEN INTERVAL … PRECEDING` form (and the spine) is what makes "last 7 days" mean seven
calendar days instead of "the last 7 rows that happen to exist", which is today's behaviour
(`explorer.ts:188-193`). Trino supports `RANGE` frames with an interval over a date/timestamp
`ORDER BY` key — this must be verified on the deployed Trino version (§7).

### Worked example — Northpeak `gold_northpeak_commerce` (domain `sales`)

The seed's real gold mart (`seed/ecommerce/lib/narrative.mjs:132-183`): columns `order_id`,
`customer_id`, `region`, `product`, `net_amount`, `order_total`, `converted`, `order_month`,
`is_churned`; seeded metrics `Revenue (sum net_amount)`, `AOV (avg order_total)`,
`Conversion (avg converted)`, `ChurnRate (avg is_churned)` (`:186-191`).

**What the OS would commit** (new file, `models/semantic/northpeak_commerce.yml`):

```yaml
semantic_models:
  - name: northpeak_commerce
    description: "Northpeak order-level revenue and churn base mart (OS dataset ds_… )."
    model: ref('gold_northpeak_commerce')
    defaults:
      agg_time_dimension: order_month
    entities:
      - name: order
        type: primary
        expr: order_id
      - name: customer
        type: foreign
        expr: customer_id
    dimensions:
      - name: order_month
        type: time
        type_params:
          time_granularity: day
      - name: region
        type: categorical
      - name: product
        type: categorical
    measures:
      - name: net_amount
        agg: sum
        expr: net_amount
        agg_time_dimension: order_month
      - name: order_total_avg
        agg: average
        expr: order_total
      - name: orders
        agg: count
        expr: order_id
      - name: converted_orders
        agg: sum
        expr: converted

metrics:
  - name: revenue                       # simple
    label: Revenue
    type: simple
    type_params:
      measure: net_amount
    config:
      meta: {os_metric_id: "ds_….revenue", os_member: "NorthpeakCommerce.revenue", os_tier: domain}

  - name: conversion_rate               # ratio
    label: Conversion Rate
    type: ratio
    type_params:
      numerator: converted_orders
      denominator: orders

  - name: revenue_per_order             # derived
    label: Revenue per Order
    type: derived
    type_params:
      expr: revenue / orders
      metrics:
        - name: revenue
        - name: orders

  - name: revenue_mom_growth            # derived + offset_window (needs the spine)
    type: derived
    type_params:
      expr: (revenue - revenue_prev) / revenue_prev
      metrics:
        - name: revenue
        - name: revenue
          offset_window: 1 month
          alias: revenue_prev

  - name: revenue_t7d                   # cumulative
    label: Trailing 7d Revenue
    type: cumulative
    type_params:
      measure: net_amount
      cumulative_type_params:
        window: 7 days

  - name: eu_west_revenue               # simple + filter
    type: simple
    type_params:
      measure: net_amount
    filter: "{{ Dimension('northpeak_commerce__region') }} = 'eu-west'"
```

**And the SQL the OS compiler serves** for `revenue_t7d` by `region`, day grain, as the signed-in
user (`queryRun(sql, identities.trino.user)`):

```sql
WITH spine AS (
  SELECT d FROM iceberg.sales.os_time_spine_day WHERE d >= date '2026-01-01' AND d <= current_date
), base AS (
  SELECT "region", date_trunc('day', "order_month") AS t, SUM(CAST("net_amount" AS double)) AS v
  FROM iceberg.sales.gold_northpeak_commerce
  GROUP BY 1, 2
), dense AS (
  SELECT r."region", s.d AS t, COALESCE(b.v, 0) AS v
  FROM spine s CROSS JOIN (SELECT DISTINCT "region" FROM iceberg.sales.gold_northpeak_commerce) r
  LEFT JOIN base b ON b.t = s.d AND b."region" = r."region"
)
SELECT "region", t,
       SUM(v) OVER (PARTITION BY "region" ORDER BY t RANGE BETWEEN INTERVAL '6' DAY PRECEDING AND CURRENT ROW) AS "revenue_t7d"
FROM dense
ORDER BY "region", t
LIMIT 100
```

(`INTERVAL '6' DAY` + `CURRENT ROW` = a 7-day inclusive window, matching MetricFlow's `window: 7 days`.
No `--` comments: the governed path rejects them, `explorer.ts:274-276`.)

**And the commit it lands as** (same shape as the concept's worked example at
`2026-11-13-data-products-concept.md:164-183`):

```
commit 9ab12cd
Author:    Riley Sales <riley@…>
Committer: Sovereign OS <os@tenant>

    metrics(sales): define revenue_t7d on northpeak_commerce — via mcp:define_metric

    OS-Action: define_metric
    OS-Dataset: ds_9kq2 (northpeak-commerce)
    OS-Metric: ds_9kq2.revenue_t7d
    OS-Surface: mcp:define_metric
    OS-Request-Id: req_01HX…

 models/semantic/northpeak_commerce.yml | 14 ++
```

---

## 5. User stories and requirements (numbered, testable)

Convention: **US-n** a story, **R-n.m** its testable requirements. "as the signed-in user" always
means a user-delegated token through `propagate` + `queryRun` (`explore-server.ts:151-173`).

### Defining metrics

**US-1 — simple metric.** As a creator I define "Revenue" as the sum of `net_amount` over
`order_month`, in the form, from chat or from the MCP, and the three doors produce one artifact.
- R-1.1 The definition is persisted as a dbt `metrics:` entry of `type: simple` referencing a
  `measures:` entry with `agg: sum`, `expr: net_amount`, `agg_time_dimension: order_month`, in
  `models/semantic/<model>.yml` of the owning domain's dbt project.
- R-1.2 The emitted YAML validates against the dbt semantic spec (test: a schema validator in the
  suite; `kind`: `dbt parse` succeeds on the committed project).
- R-1.3 Form, agent proposal and hand-edited YAML converge on the identical artifact — extend
  `consistency.ts` `convergence` to the dbt shape, with YAML as a real round-trip
  (parse(emit(x)) == x), not a one-way string builder.
- R-1.4 Re-defining the same metric name is an UPSERT in place (today's behaviour,
  `store.ts:1452-1457`), and emits exactly one changed YAML file.

**US-2 — ratio / derived metric.** As a creator I define "Conversion Rate" as converted orders ÷
orders, and "Revenue per Order" as `revenue / orders`.
- R-2.1 A ratio persists as `type: ratio` with `numerator`/`denominator` (not a `number` measure
  with `1.0 * {a} / {b}` sql).
- R-2.2 Each side accepts its own `filter:`.
- R-2.3 A derived metric persists as `type: derived` with `expr` + `metrics:` (with `alias` where
  the expression renames an input).
- R-2.4 A zero denominator yields `NULL`, never a division error (`NULLIF`), and the UI shows "—".
- R-2.5 A derived metric over a metric that does not exist is refused at define time with a named
  reason (today: `assertFormulaRefs`, `model.ts:199`).

**US-3 — cumulative metric.** As a creator I define "Trailing 7d Revenue" and "Revenue MTD".
- R-3.1 Persists as `type: cumulative` with `cumulative_type_params.window: 7 days` /
  `grain_to_date: month`.
- R-3.2 A trailing window is **calendar-correct**: a day with no orders contributes 0 and does not
  shift the window (fixes `explorer.ts:182-193`). Test: a fixture series with a gap.
- R-3.3 A cumulative metric queried at a grain coarser than its window returns an honest typed
  refusal, not a wrong number.
- R-3.4 A cumulative query requires the time spine; a domain without one gets a named, actionable
  error (and the OS generates the spine — R-11.1).

**US-4 — dimensions, filters, grains.** As a user I slice any metric by its dimensions, filter it,
and change the time grain.
- R-4.1 Query-time `group_by` accepts the semantic model's dimensions and the entities' joinable
  dimensions; a requested member the model does not expose is reported, never silently dropped
  (today's loud-degradation contract: `explorer.ts:58-72`, `explore-server.ts:139-144`,
  `dashboards/lib/model.ts:178-187`) — keep it.
- R-4.2 Query-time `where` supports the dbt filter syntax `{{ Dimension('e__dim') }}`,
  `{{ TimeDimension('e__t', 'month') }}`, with values parameterised, never string-concatenated
  from user input (the `assertColumn` gate at `model.ts:95-110` must extend to the filter parser).
- R-4.3 Grains `day|week|month|quarter|year` all return correctly bucketed series; a metric's
  `time_granularity` is the floor (a day-grained measure cannot be queried at hour).
- R-4.4 A metric defined on a semantic model with a `foreign` entity can be grouped by a dimension
  of the joined model (the entity join), or the limitation is documented and the attempt refused.

### Versioning, promotion, identity

**US-5 — every change is a commit, authored as me.**
- R-5.1 Defining, editing, renaming, archiving or deleting a metric regenerates the domain project
  and commits it, authored as the acting user, with `OS-Action`, `OS-Metric`, `OS-Surface`,
  `OS-Request-Id` trailers (reuse `commit.ts`; add `OS-Metric`).
- R-5.2 The same metric change made through the MCP and through the UI produces a deep-equal
  committed file map, author and trailers except the `via mcp:<tool>` / `via ui:<route>` subject
  half (extend `tabs/data/lib/mcp-parity.test.ts` to the metric tools — checklist D18 for metrics).
- R-5.3 Regeneration is idempotent: the same OS state yields byte-identical semantic YAML (golden
  test, as `generate.test.ts` does for models).
- R-5.4 The metric's version history in the UI is the git log of its YAML file plus the existing
  version-log overlay (`lifecycle.ts`), with no third ledger.

**US-6 — promotion My → Domain → Company.**
- R-6.1 A metric's tier follows its dataset's tier ladder with the existing role gate and
  consistency gate (`governance.ts:62-80`); a creator files `request_promotion`, a domain_admin
  approves.
- R-6.2 The consistency gate for a dbt metric additionally asserts: the YAML validates, the metric
  resolves to a number as the requester, and every consumer (explorer, dashboard panel, `query_metric`)
  resolves the identical value (extend `consistency.ts` `numbersMatch`).
- R-6.3 Promotion moves the metric's YAML from the personal lane to the domain lane in the project
  tree in exactly the way models already move (`models/personal/<uid>/` → `models/semantic/`), in
  one commit.
- R-6.4 A metric may not be promoted above its dataset's tier (a domain metric over a personal
  gold is refused with a named reason).

**US-7 — preview and query as me.**
- R-7.1 `preview_metric` computes an unsaved draft and persists nothing.
- R-7.2 Every metric read runs as the signed-in user's Trino principal; two users of the same
  metric and slice get different row sets under OPA/RLS (existing test shape:
  `core/mcp/wave-a.test.ts:263-281`).
- R-7.3 On a real deployment with Trino unreachable, a metric returns no number and an honest
  outage message (`explore-server.ts:118-132`) — never a fabricated value.
- R-7.4 The exact SQL that ran is returned to the caller for transparency (today:
  `ExploreServerResult.sql`).

### Consumption

**US-8 — dashboards, chat and agents.**
- R-8.1 A dashboard panel addresses a metric by its stable id/member; its number is the same number
  the explorer shows for the same slice and viewer (keep `panel-query.ts` on the one compiler).
- R-8.2 Renaming a metric never moves its identity (`label` vs `name`, `model.ts:184-191`) and never
  breaks a dashboard.
- R-8.3 Chat answers "what is revenue this month" through `query_metric`, which accepts **no SQL**
  (keep `wave-a.test.ts:96-98`).
- R-8.4 An agent's `query_data`/`use_data` grant over a dataset also exposes that dataset's
  **metrics** by id, with the metric definition (label, description, type, dimensions, grain) in the
  tool's context, so an agent prefers the governed metric over re-deriving a number from rows.
- R-8.5 Agents and chat see the metric's `description`/`label`/`meta` from the YAML — one place.

**US-9 — MCP parity with the UI.**
- R-9.1 `define_metric`, `preview_metric`, `query_metric`, `list_metrics`, `promote_metric` cover
  every metric operation the UI offers, each going through the same governed service.
- R-9.2 `define_metric` accepts the dbt metric model (`type` ∈ simple|ratio|derived|cumulative,
  `measure`, `numerator`/`denominator`, `expr`+`metrics`, `cumulative_type_params`, `filter`,
  `label`, `description`) and its description stops promising "Cube YAML"
  (`metric-write-tools.ts:141`).
- R-9.3 `query_metric`'s description stops claiming Cube applies RLS
  (`discovery-read-tools.ts:309`); it states Trino + OPA as the viewer.
- R-9.4 A metric on a dataset the caller cannot see returns a byte-identical `not_found` to a
  non-existent one (existing contract).
- R-9.5 New: `list_metrics` returns the metric **type** and its time grain so a client can pick a
  valid slice without a round trip.

### Materialisation and freshness

**US-10 — a metric's export is a Dagster asset.**
- R-10.1 A metric (or a set) can be declared as a `saved_queries:` entry with an `exports:` block in
  the project; the OS writes it on an explicit user action, not by default.
- R-10.2 Each export becomes a Dagster asset in the `sovereign` code location, materialising as the
  declared principal, with the existing tags (`os/dataset`, `os/principal`, `os/commit`).
- R-10.3 The exported table's freshness is readable in the OS from Dagster (asset checks/
  observations), the way sync freshness already is (`sync-status-server.ts`).
- R-10.4 A dashboard tile may read the exported table instead of recomputing, and says which it did.

**US-11 — time spine.**
- R-11.1 The generated project contains a time-spine model per domain, materialised in the domain
  schema, covering the span of the domain's time dimensions, built by Dagster like any other model.
- R-11.2 A cumulative/offset metric query uses the spine; the spine's grain is at least as fine as
  the finest `time_granularity` declared in the domain.

---

## 6. Checklist items (style of `docs/superpowers/plans/2026-11-13-engineering-checklist.md`)

| # | Must be true | Test | Owner phase |
|---|---|---|---|
| M1 | A metric defined in the OS is a dbt **`metrics:`** entry (with its `semantic_models:` measure) in a `.yml` file inside the owning domain's dbt project — not only an OS record. `models/semantic/<model>.yml` appears in the generated tree. | `unit` golden on `generateProject` (a new fixture with measures, alongside the three in `tabs/data/lib/dbt/fixtures/`); `inspect` a checkout | M1 |
| M2 | The emitted semantic YAML is **spec-valid** and parses: `dbt parse` on the generated project succeeds with the semantic block present, and the manifest contains the metric node. | `unit` schema validation of the emitted YAML; `kind` `python /opt/dagster/app/os_projects.py --parse /repos-checkout/<domain>/current` then grep `metrics` in `target/manifest.json` | M1 |
| M3 | Emission round-trips: a hand-edited metric YAML parses back into the OS model and re-emits byte-identically; two regenerations of the same state are byte-identical. | `unit` (parse∘emit = id on 10 fixtures, incl. every metric type; idempotence golden like `generate.test.ts` D3) | M1 |
| M4 | Every metric write (define / edit / rename / archive / delete / promote) is a **git commit** in the domain repo authored as the acting user, with `OS-Action` / `OS-Metric` / `OS-Surface` / `OS-Request-Id`. | `unit` extend `tabs/data/lib/dbt/commit.test.ts`'s mutator enumeration with the metric writers × flag on/off; `kind` `git log --stat` | M2 |
| M5 | The MCP and the UI produce the **same** commit, the same project files and the same Dagster launch for the same metric change. | `unit` extend `tabs/data/lib/mcp-parity.test.ts` to `define_metric`/`promote_metric`; `mcp` drive define → query end to end | M2 |
| M6 | `simple`, `ratio`, `derived` and `cumulative` metrics all **resolve to a number** through the OS compiler, as the signed-in user, over the governed Trino. | `unit` compiler goldens (SQL string per type, per grain, with and without dims/filters); `kind` one of each against the Northpeak seed and assert the value | M3 |
| M7 | The OS compiler's numbers **agree with MetricFlow's** for the same committed YAML on the same data — a real differential harness, the way `dbt/parity.ts` gates the model translation. Possible because MetricFlow is Apache-2.0 from v0.209.0 (§2.1). | `unit`/CI: `pip install "dbt-metricflow[dbt-duckdb]"` (or `[dbt-trino]` in `kind`), load the fixture + the OS-emitted YAML, run `mf query` per metric × grain × slice and assert the OS compiler's SQL returns the same rows. Pin `metricflow >= 0.209.0`. `kind` for the Trino adapter half | M3 |
| M8 | A **time spine** model exists in every generated project whose domain declares a time dimension, is materialised by Dagster, and is what cumulative/offset metrics join to. | `unit` generator golden; `kind` the spine asset materialises and `revenue_t7d` over a gapped series is calendar-correct | M3 |
| M9 | A cumulative trailing window counts **calendar units, not existing buckets** — a gap day contributes 0. | `unit` the gap fixture (this is the regression test for `explorer.ts:188-193`) | M3 |
| M10 | Query-time `group_by` / `where` use the dbt filter syntax, are fully parameterised, and a member the model does not expose is reported **loudly**, never silently dropped. | `unit` injection suite over the filter parser (the `assertColumn`/`qcol` discipline) + the dropped-member warning cases | M4 |
| M11 | A metric's **tier** follows the data ladder with the role gate and the extended consistency gate; promotion moves its YAML lane in one commit. | `unit` `governance.test.ts` + a lane-move golden; `mcp` creator files, domain_admin approves | M4 |
| M12 | Every metric read runs as the signed-in user: two viewers of the same metric and slice get different rows; a Trino outage yields **no number**. | `unit` (existing shapes in `core/mcp/wave-a.test.ts`, `explore-server` honesty gate); `stackit` two real users on one dashboard | M4 |
| M13 | Dashboards, chat, `query_metric` and the explorer return the **identical** value for the same member/slice/viewer. | `unit` `consistency.ts` `numbersMatch` extended to the dbt metric types + the panel path | M4 |
| M14 | `saved_queries` → `exports` are declared in the project and become Dagster assets materialising as the declared principal; the OS reads their freshness from Dagster. | `unit` generator golden + a new `parse_saved_queries` in `os_projects.py` with `test_os_projects.py` cases; `kind` the asset materialises and the table exists | M5 |
| M15 | Agents' `query_data`/`use_data` over a dataset expose its metrics by id with their definitions, and an agent asked for a number uses the metric rather than re-deriving it. | `unit` the grant→tool-context mapping; `unit` an agent-run fixture that calls `query_metric` | M5 |
| M16 | Every metric-layer dependency is on the allowlist, **`metricflow` resolves to ≥ 0.209.0 wherever it is installed** (≤ 0.208.1 is BSL — §2.1), and `licenses/components.tsv` + `THIRD-PARTY-LICENSES.md` + the SBOM carry it. | `unit` a version floor assertion in the existing licence gate (`scripts/license-check.sh`, `licenses/denied-licenses.txt`, `.github/workflows/license-gate.yml`); `inspect` the Dagster image requirements | M1 |
| M18 | The 1.12 ("Fusion") spec divergence is handled deliberately: the emitter targets one pinned DSI version, says which, and a translation layer (or a documented refusal) exists for the models-nested `semantic_model:` / `input_metric(s)` redesign. | `inspect` the pinned version constant + its test; `unit` the translation on one fixture per changed field | M5 |
| M17 | The Cube vocabulary is gone from the metric surfaces users and agents read: no tool description, context.md or UI string claims Cube serves or secures a number. | `inspect` grep for `Cube` under `tabs/metrics`, `tabs/dashboards`, `core/mcp` — only historical comments remain | M2 |

---

## 7. Risks and open questions

1. **Time spine on Iceberg/Trino.** A spine is a dense date table. Options: a dbt model built from
   `UNNEST(sequence(date '2015-01-01', current_date, interval '1' day))` (Trino-native, cheap, but
   needs a rebuild to extend its upper bound), or a view over `sequence(...)` with no materialisation
   (recomputed per query, no Iceberg file churn). Open: which, and who owns the span. Also: dbt
   changed the spine declaration between 1.8 and 1.9+ (`metricflow_time_spine` model vs the
   `time_spine` model config) — pin the form to the dbt version the images carry, and say which.
2. **Cumulative windows in Trino SQL.** `RANGE BETWEEN INTERVAL '6' DAY PRECEDING` requires Trino
   to accept an interval range frame over the `ORDER BY` key's type; verify on the deployed Trino
   (and for `timestamp` vs `date` keys). If unsupported, the fallback is a self-join against the
   spine, which is correct but much more expensive. `grain_to_date` is a `PARTITION BY
   date_trunc(grain, t)` + unbounded-preceding frame — cheap, but note it resets at the boundary,
   which is the point.
3. **Semantics divergence — now testable.** The OS compiler and MetricFlow must agree, and since
   MetricFlow is Apache-2.0 (§2.1) and supports `dbt-trino` (§1.6), the OS **can** run it in CI to
   check (M7). Residual risk is in the corners the harness must deliberately cover: non-additive
   dimensions (`window_choice` defaults to `min`), `count_distinct` inside a derived metric
   (non-additive — the ratio of distincts is not the distinct of the ratio), offset windows across
   DST and unequal month lengths, null handling in ratios, `period_agg` (`first`/`last`/`average`),
   and the OS's `count_distinct_approx`, which **has no dbt agg at all** (§1.1) and will therefore
   never match MetricFlow by construction — it must be excluded from the harness with a stated
   reason rather than quietly passing.
4. **Dimension cardinality.** The `dense` CTE in the cumulative shape cross-joins the spine with
   `SELECT DISTINCT <dims>`; at high cardinality (customer_id) that is a product. Mitigations: cap
   the group-by cardinality, require a `LIMIT`, refuse a cumulative metric grouped by a
   high-cardinality dimension with a named reason, or compute the dense frame only for the
   dimension values present in the window. Needs a decision before M6.
5. **Caching.** There is none today — every tile is a Trino query as the viewer. Per-viewer RLS
   makes a shared cache unsafe unless the cache key includes the full security context. Options:
   (a) no cache, rely on Trino + Iceberg; (b) `saved_queries`/`exports` as the *explicit*,
   governed cache (preferred — it is the dbt-native answer and it is auditable); (c) a per-session
   result cache keyed by (sql, principal, dataset snapshot). Note that (b) changes the security
   model: an exported table is one table with one set of rows, so it must be written per entitled
   audience or treated as a domain-tier artifact. **Open question for the owner.**
6. **Two models during migration.** The internal `Measure` (Cube-shaped) stays while the dbt YAML
   becomes the committed contract. Risk of drift: the YAML is derived from `Measure`, so a dbt-only
   concept (per-side ratio filters, `offset_window`, `conversion`) has nowhere to live until
   `Measure` is replaced. Decide now whether M1–M3 extend `Measure` or introduce the dbt metric as
   the source of truth with `Measure` derived from it (recommended: the latter, from M3 onwards).
7. **Entity joins.** Today a metric is bound to one gold mart (`goldReadTarget`). `entities` make
   multi-model metrics expressible in YAML that the compiler cannot serve. Either implement the
   entity join (a real join planner — the OS already has `goldJoinPlan` for compositions) or refuse
   a cross-model metric at define time with a reason, and never emit YAML the OS cannot execute.
8. **Who may read a metric definition.** The domain repo is readable by every domain member
   (`docs/components/dbt.md`, "Who can read the project"), so a personal-lane metric's *definition*
   becomes domain-visible the moment it is committed — the same deliberate trade-off models already
   make, but it is new for metrics and should be stated in the UI.
9. **`saved_queries`/`exports` execution.** Verified: `dbt sl export` / `dbt build --resource-type
   saved_query` are **dbt Cloud only**, and **there is no `mf export`** — the `dbt-metricflow` CLI
   has no command that writes an export table (§1.4). So the executable form must be the OS's own.
   Two shapes, pick one and say which: (a) the OS compiles each export into a plain dbt **model**
   (`models/metrics/metrics_<name>.sql`) that Dagster materialises with everything else — simplest,
   fully within the existing machinery, and the `exports:` block becomes portable documentation; or
   (b) the Dagster image gains `dbt-metricflow[dbt-trino]` and an asset runs
   `mf query --saved-query <name>` into a `CREATE TABLE AS` as the declared principal — closer to
   the dbt semantics, a new Python dependency, and still OS-written `CREATE TABLE`. **Recommended:
   (a) first, (b) only if the compiler and MetricFlow disagree on a shape that matters.** Either
   way, do not imply dbt is running the export.
10. **dbt 1.12 "Fusion" is a breaking redesign of this exact spec** (§1.0). `semantic_models:` moves
    to a `semantic_model:` block nested inside `models:`; `measures:` are **deprecated** in favour
    of "simple metrics"; `type_params.metrics` → `input_metrics`; `type_params.measure` →
    `input_metric`; `cumulative_type_params` flattens; `conversion`'s `base_measure`/
    `conversion_measure` → `base_metric`/`conversion_metric`; `expr` fields move into
    `derived_semantics:`. Whatever the OS emits will be wrong for *some* dbt version. Decide the
    pin explicitly (recommended: **DSI 0.8.5 / dbt 1.10 field names**, matching what the images
    carry), state it in the generated README, and keep the emitter behind one version constant so
    the 1.12 form is a translation layer rather than a rewrite. Open: which dbt version the Dagster
    and dbt images actually carry today — this must be read off the images before M1 starts, since
    `cumulative_type_params` does not exist at all on dbt 1.8.
11. **Trino client authentication is off** (`docs/components/trino.md`, deviation B3-2;
    `project.ts:56-77`). Every "runs as the viewer" claim in §4 and §5 rests on the network
    boundary making a claimed session user trustworthy, not on authentication. That is true of the
    metric read path **today** and is not made worse by this work — but any statement that
    MetricFlow or dbt "runs as the viewer" via `impersonation_user` is false until
    `http-server.authentication.type` is set. Do not let the metric design be the place that claim
    first gets made.
12. **Stale Cube claims in agent-facing text** (`discovery-read-tools.ts:309`,
    `metric-write-tools.ts:141`, `tabs/metrics/context.md:3-20`): agents are being told Cube secures
    the number. Low effort, high honesty value — M17.
