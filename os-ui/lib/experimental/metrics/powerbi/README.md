<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# Power BI — TMDL semantic-model bridge (#143)

Emits a Power BI **TMDL** (Tabular Model Definition Language) semantic model **from** a
governed OS Cube view, so a business user in Power BI sees the OS's governed
measures/dimensions **without redefining them**. This EXTENDS the shipped `.pbids`
connect (`lib/powerbi/`): `.pbids` gets Power BI *pointed at* the endpoint; this bridge
generates the *model* (tables, measures-as-DAX, dimensions) on top of that same governed
endpoint.

**One-way, generated.** The Cube view (from the Gold mart → `/meta`) is the single source
of truth. There is never a hand-maintained second definition — re-export to pick up
changes.

## Public API (pure — `tmdl.ts`)

- `datasetToTmdl(dataset, { endpoint })` — the TMDL `table` text for a dataset's Cube view.
- `daxForMeasure(measure, tableRef)` — one Cube measure → its DAX expression.
- `measureMappings(dataset)` — the Cube-measure → DAX rows (for a preview / this doc).
- `tmdlFilename(dataset)` — the download name (`<View>.tmdl`).
- `CUBE_TO_DAX` — the aggregation map (below).

All pure + dependency-free (only sibling pure imports): unit-tested against a fake dataset
with no Cube server, no Power BI SDK, no I/O.

## Cube measure → DAX mapping

| Cube measure `type`      | DAX emitted                        | Notes |
|--------------------------|------------------------------------|-------|
| `count`                  | `COUNTROWS(<Table>)`               | counts rows; no source column |
| `count_distinct`         | `DISTINCTCOUNT(<Table>[<col>])`    | |
| `count_distinct_approx`  | `DISTINCTCOUNT(<Table>[<col>])`    | Power BI has no approx-distinct DAX → **exact** is the honest mirror |
| `sum`                    | `SUM(<Table>[<col>])`              | |
| `avg`                    | `AVERAGE(<Table>[<col>])`          | |
| `min`                    | `MIN(<Table>[<col>])`              | |
| `max`                    | `MAX(<Table>[<col>])`              | |
| `number`                 | the Cube `sql` expression verbatim | a raw/derived measure — the author already wrote the expression |

`<col>` is the measure's Cube `sql` (its source column); `<Table>` is the Cube **view**
name. Cube `format:` (percent/currency/number) → a TMDL `formatString`. Gold columns
become typed TMDL columns via `inferDimType` (string→`string`, number→`double`,
time→`dateTime`, boolean→`boolean`).

## RLS / identity — preserved

The generated model's partition is a **DirectQuery** M source pointed at the Cube SQL
endpoint, logging in as the domain's read-only **`bi_<domain>`** principal (the SAME
identity the `.pbids` connect uses). So every Power BI query flows **Cube → Trino → OPA**,
domain-scoped, on every refresh. DirectQuery (never Import) so the governed filter re-runs
live and no ungoverned snapshot is cached. **No password is ever embedded** — Power BI
prompts; the value comes from the vault/secret out-of-band (see
`../../../docs/powerbi-consumption.md`).

## Export affordance (governed)

`GET /api/powerbi/tmdl?metricId=<datasetId.measure>` (or `?datasetId=<id>`) downloads the
`.tmdl`. `&format=json` returns `{ tmdl, filename, mappings }` for a UI preview. The model
is resolved through the **governed store** (`getMetric` / `getDataset`), so a caller can
only export a metric/dataset they can already **view** (same `canView` scope). Returns
`503` if the Cube SQL API is off (the model would bind to a dead port).

## Honest round-trip scope — what does NOT cross over

- **No live write-back.** Cube → Power BI only. Editing the model in Power BI does **not**
  change the OS metric.
- **No full/self-hosted XMLA endpoint.** We emit the TMDL *text*; we do not stand up a
  Tabular server Power BI queries over XMLA (decision #141/#143).
- **No per-viewer RLS.** `bi_<domain>` is domain-scoped and shared — every report viewer
  sees the same domain rows (per-viewer RLS = Entra ID → Cube JWT, a later phase).
- **Cube `filters` / `rolling_window` are not re-encoded into DAX.** They stay enforced
  server-side inside the Cube view; the DAX aggregates the governed, already-filtered
  column the view exposes. The number stays governed; the DAX text is a plain aggregation.

## Dependencies

- `lib/data/metrics.ts` — Cube view/name, Gold mart FQN, dimension-type inference.
- `lib/data/dataset-schema.ts` — the `Dataset`/`Measure`/`MeasureType` shapes.
- `lib/powerbi/principal.ts` — the `bi_<domain>` BI principal (RLS identity).
