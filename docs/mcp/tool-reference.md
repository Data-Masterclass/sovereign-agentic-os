<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# MCP tool reference

> GENERATED from the tool registry by `os-ui/scripts/gen-mcp-reference.ts` — do not edit by hand.
> Regenerate: `cd os-ui && node --import ./scripts/test-setup.mjs scripts/gen-mcp-reference.ts`.
> `core/mcp/surface-matrix.test.ts` fails when this file is stale. It describes a full install
> (every tab enabled); an install with tabs switched off serves fewer tools.

136 tools. **Floor** is the lowest role that sees and may call the tool (creator < builder < domain_admin < admin);
the governed function behind it re-checks scope on every call. **External door** says whether the
tool is listed from the start on `/api/mcp` or appears after `load_toolset({name})`; the per-tab
endpoints `/api/mcp/<tab>` list their tools without toolsets.

## Deprecated names

Still accepted for one release (same governed tool, logged), never listed:

- `author_knowledge` → `author_workflow`
- `index_knowledge` → `index_workflow`
- `publish_knowledge` → `publish_workflow`
- `retire_knowledge` → `retire_workflow`

## Contents

- [meta](#tab-meta) — 7
- [data](#tab-data) — 28
- [knowledge](#tab-knowledge) — 6
- [workflows](#tab-workflows) — 6
- [files](#tab-files) — 5
- [metrics](#tab-metrics) — 7
- [dashboards](#tab-dashboards) — 3
- [agents](#tab-agents) — 8
- [software](#tab-software) — 26
- [connections](#tab-connections) — 19
- [governance](#tab-governance) — 13
- [monitoring](#tab-monitoring) — 4
- [operating-manual](#tab-operating-manual) — 4

## Tab: meta

<a id="tab-meta"></a>

### `find`

Floor: **creator** · Tab: meta · External door: core (always listed)

Search EVERYTHING you can see in one call — datasets, KPIs, files, knowledge notes, workflows, dashboards, agents and software — and get compact hits (kind, id, name, domain, scope, status, updated). Use it when you do not know which tab holds something; for a plain list ("my datasets") call the matching list_* tool instead. Governance: runs the same governed list/search tools as you, so you only ever see what you are entitled to.

| Argument | Type | Required | Description |
|---|---|---|---|
| `query` | string | yes | What to look for, e.g. "refund policy". Every word must match. |
| `kinds` | string[] |  | OPTIONAL. Limit to some kinds: dataset, metric, file, knowledge, workflow, dashboard, agent, software. |
| `limit` | number |  | OPTIONAL. Max hits (default 20). |

Example arguments:

```json
{"query":"refund"}
```

### `get_conversation`

Floor: **creator** · Tab: meta · External door: toolset `platform`

Read one of YOUR Home chat conversations by id (the messages and a one-line trace of the tools that ran). Before: list_conversations. Governance: read-only; a conversation that is not yours answers not_found, exactly like one that does not exist.

| Argument | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | The conversation id from list_conversations. |

Example arguments:

```json
{"id":"c-0123456789abcdef"}
```

### `get_engineering_view`

Floor: **creator** · Tab: meta · External door: toolset `platform`

The tool-native artefacts behind one OS object — the dbt model SQL and YAML as committed with its repo path, the Dagster asset keys, job, schedule and last run, the compiled LangGraph graph (nodes, edges, guards, channels, interrupts), the git file list and head commit, and the Langfuse trace — each with a deep link and the exact command to run it yourself (dbt build --select …, dagster asset materialize --select …, mf query --metrics …). Same structure the "Under the hood" panel renders. Read-only, scoped to your identity: an object you cannot see answers exactly as its tab answers.

| Argument | Type | Required | Description |
|---|---|---|---|
| `kind` | `dataset` \| `metric` \| `dashboard` \| `agent_system` \| `app` | yes | The object kind: dataset (data product), metric (KPI), dashboard, agent_system or app. |
| `id` | string | yes | The object id, as the tab's own list tool returns it. |

Example arguments:

```json
{"kind":"dataset","id":"ds_ab12cd"}
```

### `get_guide`

Floor: **creator** · Tab: meta · External door: core (always listed)

Read a golden-path GUIDE (the same markdown as the sovereign-os://guide/* resources) so tools-only clients get the full pathway. Call with NO argument (or path="how-to-use") for a "How to use this MCP" orientation: what the OS is, your first 3 moves, the role summary, all pathway names, and the build-on-what-exists rule. Valid paths: how-to-use, overview, governance, data, knowledge, workflows, connections, agents, software, metrics, dashboards, files, monitoring. Governance: read-only, identical for every role.

| Argument | Type | Required | Description |
|---|---|---|---|
| `path` | `how-to-use` \| `overview` \| `governance` \| `data` \| `knowledge` \| `workflows` \| `connections` \| `agents` \| `software` \| `metrics` \| `dashboards` \| `files` \| `monitoring` |  | Which guide to read. Omit (or pass "how-to-use") for the "How to use this MCP" orientation. |

Example arguments:

```json
{}
```

### `list_capabilities`

Floor: **creator** · Tab: meta · External door: core (always listed)

List every OS tool with its tab, role floor and toolset, split into what THIS caller can call now vs. what is gated (and why). Purpose: the map to read before a multi-step build across tabs. On the external door, a tool in a toolset is callable after load_toolset({name}). Governance: read-only; the floor is re-checked on every call.

No arguments.

Example arguments:

```json
{}
```

### `list_conversations`

Floor: **creator** · Tab: meta · External door: toolset `platform`

List YOUR Home chat conversations, newest first (id, title, last update, message count). Purpose: find a conversation to reopen. Governance: read-only; private by default — you only ever see your own, whatever your role.

No arguments.

Example arguments:

```json
{}
```

### `whoami`

Floor: **creator** · Tab: meta · External door: core (always listed)

Return the caller’s delegated identity (id, name, role, domains) and a plain-language read of what this role can and cannot do. Purpose: call it before BUILDING or PROMOTING (a plain question needs no whoami — call the read tool). After: list_capabilities, get_guide. Governance: every tool runs AS this user.

No arguments.

Example arguments:

```json
{}
```

## Tab: data

<a id="tab-data"></a>

### `add_dataset_version`

Floor: **creator** · Tab: data · External door: toolset `data`

Commit one medallion version (bronze→silver→gold) of a dataset you can edit — the guided panel’s “Confirm”. Pass an authored dbt-SQL `body` for silver/gold, or `passThrough:true` to carry the prior layer forward. The prior layer must exist first. Honesty contract: silver/gold register ONLY after a real materialization — a pass-through runs a governed CTAS copy of the prior layer, an authored commit is probed against its physical table (build it first, e.g. via transform_silver); a ✗ registers nothing. Offline it degrades to an honestly-labelled offline-mock.

| Argument | Type | Required | Description |
|---|---|---|---|
| `datasetId` | string | yes | Target dataset id (from create_dataset). |
| `layer` | `bronze` \| `silver` \| `gold` | yes | Medallion layer to build. |
| `body` | string |  | Authored dbt SQL (+ tests) for silver/gold. Ignored for passThrough. |
| `quality` | string |  | Optional quality label for the built version. |
| `passThrough` | boolean |  | Carry the prior layer forward unchanged (silver/gold only). |

Example arguments:

```json
{"datasetId":"ds_ab12cd","layer":"bronze"}
```

### `adopt_exposed_table`

Floor: **domain_admin** · Tab: data · External door: toolset `data`

ADOPT one exposed table as a governed Domain-tier dataset (⛔ domain_admin — the adoption gate). The exposure is RE-RESOLVED server-side (active, shared with one of your domains) so governance is never trusted from the args; the `schema.table` must be one the exposure actually lists; a short `description` is REQUIRED (feeds the documentation gate). The dataset is born `origin:"connected"` at the exposure's tier: a LIVE exposure federates every read through the external FQN; a SYNC exposure attaches a validated sync config (connection + source PINNED to the exposure) and provisions the per-dataset CronJob. This is the SAME `/api/data/adopt` path the Adopt panel runs. Before: list_exposed_tables. After: profile_dataset / query_data / define_metric (on a synced copy). Governance: domain_admin re-gated; WAREHOUSE adoption additionally requires the external-connectors flag, but OPERATIONAL sources (Salesforce/Kajabi/OData/Workday) are user-facing and adoptable without it; `dataset_adopted` trace.

| Argument | Type | Required | Description |
|---|---|---|---|
| `exposureId` | string | yes | Exposure set id from list_exposed_tables. |
| `schema` | string | yes | Source schema (must be one the exposure lists). |
| `table` | string | yes | Source table (must be one the exposure lists). |
| `name` | string |  | Dataset name (defaults to the table name). |
| `description` | string | yes | REQUIRED short description of the table and its purpose. |
| `sync` | object |  | SYNC-mode config (ignored for a live exposure). Omit to use the exposure's declared defaults (full refresh, its schedule). |

Example arguments:

```json
{"exposureId":"exp_ab12cd","schema":"sales","table":"orders","description":"Order lines for the Commerce team."}
```

### `apply_quality_fixes`

Floor: **creator** · Tab: data · External door: toolset `data`

APPLY accepted DQ remediations for ONE rule — the Validate stage’s "Apply" buttons, the SAME governed path as POST /api/data/datasets/:id/dq/apply. Modes: batch (ONE column-transform expression, re-validated server-side by the fix guard — statements/subqueries/unknown identifiers are refused) or rows ({pk,proposed} pairs bound as escaped literals, matched on the dataset’s DECLARED unique key — refused honestly when no key is declared). Executes ONE whitelisted MERGE through the governed /execute AS YOU (the query-tool re-gates statement shape + schema/role floor), then RE-RUNS the rule — the response’s `recheck` is the real post-fix verdict (a fix that didn’t fix stays red). Records a durable remediation run (batch id + pre-apply Iceberg snapshot id; revert is via Console — no governed rollback shape exists). NOTHING applies except through this explicit call. Before: propose_quality_fixes (or your own expression). Governance: edit scope (owner / in-domain domain_admin+), re-checked in-lib; role floor for the physical write re-enforced by the query-tool.

| Argument | Type | Required | Description |
|---|---|---|---|
| `datasetId` | string | yes | Dataset id (from list_datasets). |
| `checkId` | string | yes | The rule’s check id (from run_quality_checks). |
| `mode` | `batch` \| `rows` | yes | batch = one column-transform expression; rows = explicit per-row values. |
| `sqlExpr` | string |  | batch only: the column-transform expression (guard-validated). |
| `fixes` | object[] |  | rows only: the accepted fixes. |

Example arguments:

```json
{"datasetId":"ds_ab12cd","checkId":"chk_1","mode":"batch","sqlExpr":"trim(lower(email))"}
```

### `approve_promotion`

Floor: **domain_admin** · Tab: data, files · External door: toolset `data`

APPLY a filed promotion request (dataset or file) — the Domain-admin/Admin half of the split. Path: the approve step of the Data/Files golden paths. Before: a creator filed `request_promotion`. Governance: the SAME per-item `canApprove` gate the Governance inbox uses — rank ≥ the item’s approver role AND in its scope, re-checked here and again in-lib; a creator/builder is refused with a typed forbidden. You may clear a rung-1 request you filed on your OWN artifact (otherwise an owner who is also the approver could never promote it), but NOT one raised by a parked agent run — that is decided in Governance so the write executes as the RUNNER. Idempotency: an already-decided request returns a `conflict`.

| Argument | Type | Required | Description |
|---|---|---|---|
| `approvalId` | string | yes | The approval id from request_promotion. |

Example arguments:

```json
{"approvalId":"apr_ab12cd34"}
```

### `build_gold_join`

Floor: **creator** · Tab: data · External door: toolset `data`

Build a dataset’s physical GOLD by JOINING its Silver with other governed datasets you may read — this produces a curated dataset (also called: 360 view, data mart, aggregated dataset, platinum dataset). The Data tab’s stage-4 reuse, compiled into ONE governed CTAS. You pass dataset IDS to join (never table names — each is re-resolved through the canView guard), the join keys, projected dimensions and derived measures (sum/avg/count/count_distinct/min/max, or count(*) with agg "count" and no col). Column refs are {ref, column} where ref 0 = your Silver base and 1..n = the joined datasets in order. KEY MAPPING / RECONCILE: same-name keys auto-match with no extra config; when the two sides differ, set the join key’s optional `adapt` to reconcile them symmetrically (both sides wrapped): `{mode:"text"}` normalizes to lower(trim(cast … as varchar)) so keys differing only by case/whitespace/format line up, `{mode:"cast",type}` coerces both sides to one Trino type (varchar|integer|bigint|double|boolean|date|timestamp) — e.g. an id stored as varchar on one side, integer on the other. Purpose: the reuse step of the physical Data golden path — the measures recorded here feed define_metric after promotion. Before: transform_silver (Silver must be built); pick join partners from list_datasets — a join partner is either (a) a governed asset/product dataset you can read, OR (b) one of your OWN personal (My-tier) datasets built to Silver/Gold (compose a curated dataset from your own private data — its personal lane is read AS you). Each pick is still re-resolved through the canView guard and the CTAS runs AS you. After: document_dataset → request_promotion → define_metric. Governance: the CTAS targets YOUR OWN schema and executes AS YOU (Trino→OPA masks every joined read); a non-visible pick is a typed forbidden; Gold + lineage + measures are recorded ONLY on a ✓ apply+verify.

| Argument | Type | Required | Description |
|---|---|---|---|
| `datasetId` | string | yes | The base dataset (its Silver must be built). |
| `picks` | object[] | yes | Datasets to join (1..n). |
| `dimensions` | object[] |  | Projected columns: {col: {ref, column}, as?}. Grouped when measures are present. |
| `measures` | object[] |  | Derived measures: {name, agg} for count(*), {name, agg, col} for a column aggregate, or {name, agg, left, op, right} for an expression. |
| `rematerializeOnly` | boolean |  | REPAIR MODE: true skips the build and just re-runs the publish CTAS (owner’s personal gold → domain schema) for an ALREADY-PROMOTED dataset whose domain table is missing or stale. Builder+ only; picks are ignored (pass []). Never touches versions/lineage/measures. |

Example arguments:

```json
{"datasetId":"ds_ab12cd","picks":[{"datasetId":"ds_customers","type":"left","on":[{"left":{"ref":0,"column":"customer_id"},"right":"customer_id"}]}],"dimensions":[{"col":{"ref":1,"column":"region"}}],"measures":[{"name":"revenue","agg":"sum","col":{"ref":0,"column":"net_amount"}}]}
```

### `create_dataset`

Floor: **creator** · Tab: data · External door: toolset `data`

Create a new PRIVATE dataset (also called: table, data product) — a Bronze→Silver→Gold spine — in one of your domains, the same governed path as the Data tab’s “New dataset”. Starts Personal/owner-only; sharing is the separate governed `request_promotion` (kind `dataset`), approved by a Domain admin. Optionally seed column docs. Idempotency: each call creates a distinct dataset.

| Argument | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Human dataset name, e.g. "Orders". |
| `domain` | string |  | One of YOUR domains; defaults to your first domain. |
| `folder` | string |  | Optional folder path in My data to file the dataset in, e.g. "/Finance/Processed". Omit for the top level. |
| `columns` | object[] |  | Optional column docs to seed (name + description). |

Example arguments:

```json
{"name":"Orders","domain":"sales","columns":[{"name":"order_id","description":"Primary key"},{"name":"net_amount","description":"Order value in EUR"}]}
```

### `define_quality_rules`

Floor: **creator** · Tab: data · External door: toolset `data`

Add one or more data-quality RULES to a dataset you can edit — the Data tab’s "Data quality" editor. Each rule is executable: not_null(column), not_blank(column), unique(column), accepted_values(column, values[]), range(column, min?, max?), reference(column, toDataset, toColumn). Rules are stored on the dataset.yaml spine (versioned + discoverable) and become dbt tests in your domain’s project, so the SCHEDULED build enforces them. `reference` is referential integrity — every value of `column` must exist in `toDataset`.`toColumn` — emitted as dbt’s `relationships` test; it is the one rule the ad-hoc `run_quality_checks` probe reports as `not_run` (it needs the target table, which the probe does not resolve), so read its verdict from the build’s asset checks. `toDataset` must be a dataset you can see, must not be the dataset itself, and `toColumn` must be a plain identifier. Before: get_dataset (to see the real column names, and the referenced dataset’s). After: run_quality_checks to get a real pass/fail for the other rules. Governance: Creator+ on a dataset you own (or domain Admin); each rule needs a column. Idempotent-ish: re-running appends rules.

| Argument | Type | Required | Description |
|---|---|---|---|
| `datasetId` | string | yes | Target dataset id (from list_datasets / get_dataset). |
| `rules` | object[] | yes | The rules to add. |

Example arguments:

```json
{"datasetId":"ds_ab12cd","rules":[{"rule":"not_null","column":"order_id"},{"rule":"range","column":"net_amount","min":0},{"rule":"accepted_values","column":"status","values":["open","shipped","closed"]},{"rule":"reference","column":"customer_id","toDataset":"ds_cust01","toColumn":"customer_id"}]}
```

### `diff_dataset_data`

Floor: **creator** · Tab: data · External door: toolset `data`

Compare the DATA of two versions of a dataset: `added` rows (in `to`, not in `from`) and `removed` rows, counted as multisets with `EXCEPT ALL` over two Iceberg time-travel reads (`FOR VERSION AS OF`), plus up to `limit` example rows marked `+`/`-`. A version is a snapshot id or a tag/branch name from get_dataset_versions. Read as YOU. An updated row shows as one removed plus one added. Schema changes between the versions make the comparison fail with Trino’s own error.

| Argument | Type | Required | Description |
|---|---|---|---|
| `datasetId` | string | yes | Dataset id. |
| `from` | string | yes | Older version: snapshot id or tag/branch name. |
| `to` | string | yes | Newer version: snapshot id or tag/branch name. |
| `layer` | `bronze` \| `silver` \| `gold` |  | Medallion layer; default: the layer the dataset is served from. |
| `limit` | number |  | Example rows per side (default 50, max 1000). |

Example arguments:

```json
{"datasetId":"ds_ab12cd","from":"promoted-ap_12","to":"8954597067493422955"}
```

### `document_dataset`

Floor: **creator** · Tab: data · External door: toolset `data`

Write the promotion-gate documentation (description + column docs) onto a dataset you can edit — the Data tab’s “Document” form. Idempotent: re-running overwrites the docs.

| Argument | Type | Required | Description |
|---|---|---|---|
| `datasetId` | string | yes | Target dataset id. |
| `description` | string |  | What this dataset is and how to use it. |
| `columns` | object[] |  | Column docs (name + description). |

Example arguments:

```json
{"datasetId":"ds_ab12cd","description":"One row per order.","columns":[{"name":"net_amount","description":"EUR value"}]}
```

### `get_dagster_run`

Floor: **creator** · Tab: data · External door: toolset `data`

Read ONE Dagster run by the `dagsterRunId` a build or sync handed back (`ingest_dataset`, `transform_silver`, `build_gold_join`, `sync_dataset_now`, `run_quality_checks` — each returns `run.dagsterRunId` when DATA_PROJECT_GIT is on). Returns the run’s `status` (Dagster’s own QUEUED…SUCCESS/FAILURE/CANCELED) plus `syncStatus` in the ok|error|running vocabulary the sync panel uses, `startedAt`/`endedAt`, the `jobName`, the `assetSelection` it materialised, the OS’s own `os/*` tags (dataset, commit, principal, batch id, action — Dagster’s internal tags are not returned), the `commit` the layer was launched from, and `failure` (a recorded `launchError` when no run could be launched, else a line naming the failed run and pointing at the Dagster event log for the step error — never an invented cause). `dagsterError` is non-null when Dagster itself could not be read, and then `status` is honestly null rather than guessed. Path: the POLL step of every Data build — launch returns a run id, this reads it; `get_sync_status(datasetId)` remains the whole-history read when you have the dataset id instead. Governance: read-only. The run is the addressed object and is hidden like an agent run — a run id that was never minted and a run launched for a dataset you cannot see are the SAME not_found, so polling cannot enumerate other people’s builds.

| Argument | Type | Required | Description |
|---|---|---|---|
| `runId` | string | yes | The `dagsterRunId` a build/sync returned. |

Example arguments:

```json
{"runId":"7f3c1a9e-2b44-4f0a-9f1c-0d2e5a6b7c8d"}
```

### `get_dataset`

Floor: **creator** · Tab: data · External door: core (always listed)

Read one dataset you can see (also called: table, data product) — medallion versions, docs, tier, data-quality rules — plus its metric state: `metrics.ready` is true when its Gold is built — its view (`metrics.view`, dimensions from the gold columns, count fallback) is then queryable as governed SQL WITHOUT any define_metric step. `queryable` names the physical FQN + layer this dataset resolves to for YOU — Gold by default, or the medallion `layer` your data grant selects (bronze/silver). Path: DISCOVERY for the Data golden path. Before: list_datasets. After: add_dataset_version / document_dataset / define_quality_rules → run_quality_checks / define_metric (only to ADD measures — the model is already queryable). Governance: read-only; an id you cannot see returns not_found (no existence leak).

| Argument | Type | Required | Description |
|---|---|---|---|
| `datasetId` | string | yes | Dataset id from list_datasets. |
| `layer` | `bronze` \| `silver` \| `gold` |  | Which medallion layer to resolve the queryable FQN for (default: your granted layer, else the furthest built — Gold is the serving default). |

Example arguments:

```json
{"datasetId":"ds_ab12cd"}
```

### `get_dataset_versions`

Floor: **creator** · Tab: data · External door: toolset `data`

List the DATA versions of a dataset: its Iceberg table’s snapshots, newest first, each with its commit time, operation, row counts and the tags/branches on it; `current` is the snapshot the table reads now. Read as YOU from the table’s own `$snapshots` and `$refs` — the OS stores no version record. Before: get_dataset. After: diff_dataset_data, rollback_dataset_version, tag_dataset_version. For the dataset’s DEFINITION history use get_history/get_version/diff_versions (git). Refusals: `shared_table` when another dataset (archived included) maps to the same table — its history is not this dataset’s alone; `not_built` when there is no table yet.

| Argument | Type | Required | Description |
|---|---|---|---|
| `datasetId` | string | yes | Dataset id. |
| `layer` | `bronze` \| `silver` \| `gold` |  | Medallion layer; default: the layer the dataset is served from. |
| `legacy` | boolean |  | Also return `legacy`: the dataset.yaml snapshots the OS kept before versions became Iceberg snapshots (read-only). |

Example arguments:

```json
{"datasetId":"ds_ab12cd"}
```

### `get_sync_status`

Floor: **creator** · Tab: data · External door: toolset `data`

Read a dataset’s SCHEDULED-SYNC state (also called: refresh, data pipeline, ETL) — the same payload as GET /api/data/datasets/:id/sync: the saved config (mode, cursor, schedule, enabled), the source connection’s platform (kafka/salesforce/kajabi/warehouse — the per-source lock context), the estimated `nextRunAt` (UTC; null when the sync is disabled or the cron isn’t a simple preset shape — an honest omission, never a guess), the recent run history newest-first (per run: status ok|error|skipped|running, rowsAffected, cursor window, batchId, the honest error message), the current cursor `watermark` (cursorAfter of the latest ok run; null = never synced), and the QUARANTINE state (≥10 trailing consecutive errors auto-pauses scheduled runs; any successful run — e.g. sync_dataset_now — clears it, no flag to reset). Path: the read half of the sync loop. Before: set_dataset_sync. After: sync_dataset_now to run/resume, or set_dataset_sync to adjust. Governance: read-only, DLS-scoped like get_dataset — an unseeable id is not_found (no existence leak); an unresolvable connection reports platform:null honestly rather than failing the read.

| Argument | Type | Required | Description |
|---|---|---|---|
| `datasetId` | string | yes | Dataset id from list_datasets. |

Example arguments:

```json
{"datasetId":"ds_ab12cd"}
```

### `ingest_dataset`

Floor: **creator** · Tab: data · External door: toolset `data`

Ingest inline CSV/JSON text as the PHYSICAL Bronze of a dataset you can edit — the same pipeline as the Data tab’s "Upload a file": your bytes land in MinIO under uploads/<your-id>/, the data-runner writes the real iceberg.personal_<you>.bronze_<slug> table, and the Bronze version is registered ONLY when apply + a governed verify SELECT both pass (no dot without a queryable landing; offline it degrades to an honestly-labelled offline-mock). Purpose: make the physical golden path AI-drivable end-to-end. Before: create_dataset (or get_dataset to reuse). After: profile_dataset to explore it, then transform_silver. Governance: runs AS YOU — the object key is forced under your own uploads/ prefix from the session identity, and the verify probe is OPA-masked to you. Limit: ~2 MB of in-band text; bigger files → the UI upload (same pipeline, streaming multipart).

| Argument | Type | Required | Description |
|---|---|---|---|
| `datasetId` | string | yes | Target dataset id (from create_dataset / list_datasets). |
| `content` | string | yes | The raw CSV (or JSON) text to ingest — max ~2 MB in-band. |
| `fileName` | string |  | File name for the object store (default upload.csv; the extension drives parsing). |

Example arguments:

```json
{"datasetId":"ds_ab12cd","fileName":"orders.csv","content":"order_id,net_amount\n1001,250.00\n1002,90.50"}
```

### `list_datasets`

Floor: **creator** · Tab: data · External door: core (always listed)

List the datasets you can see (My · Domain · Company), grouped by tier (also called: table, data product). Path: DISCOVERY for the Data golden path (guide: sovereign-os://guide/path/data). Before: whoami. After: reuse an id with get_dataset / define_metric, or create_dataset only if nothing fits. Governance: read-only, DLS-scoped to your identity — you never see rows you are not entitled to.

| Argument | Type | Required | Description |
|---|---|---|---|
| `lifecycle` | `draft` \| `testing` \| `live` |  | OPTIONAL. Show only objects at this point of their life: `draft` (being built), `testing` (a draft being tried out right now) or `live` (the version the OS runs). Omit to see everything, which is the default and what every existing caller gets. This is INDEPENDENT of My · Domain · Company, which says who may use an object rather than which version runs. |

Example arguments:

```json
{}
```

### `list_exposed_tables`

Floor: **creator** · Tab: data · External door: toolset `data`

List the warehouse tables exposed TO YOUR DOMAIN(S) that you may adopt as governed datasets — grouped connection → exposure set (name, mode live|sync, tier, the granted tables). This is the domain-intersection view of the exposure registry (only non-revoked exposures sharing one of your domains appear). Path: DISCOVERY for the Adopt flow (replaces "pull from a product"). Before: whoami (your domains). After: ⛔ domain_admin adopt_exposed_table. Governance: read-only, scoped to your domains — you never see an exposure not shared with you.

No arguments.

Example arguments:

```json
{}
```

### `profile_dataset`

Floor: **creator** · Tab: data · External door: toolset `data`

Profile one built medallion version of a dataset you can see — rowCount, per-column null%, distinct count, min/max (numeric/temporal), top values, and a small row preview. The same Explore profiler as the Data tab: the profiling SQL is generated server-side and run through the governed query path AS YOU, so OPA row filters + column masks apply (a masked column profiles the masked values — that is the point). Path: DISCOVERY for the physical Data golden path. Before: ingest_dataset (or any built layer). After: transform_silver with the real column names, or query_data for ad-hoc reads. Governance: read-only; an unseeable id → not_found; a version whose physical table is not queryable yet returns {available:false, reason} — never a fake profile.

| Argument | Type | Required | Description |
|---|---|---|---|
| `datasetId` | string | yes | Dataset id from list_datasets. |
| `layer` | `bronze` \| `silver` \| `gold` |  | Which built layer to profile (default: the furthest built one). |

Example arguments:

```json
{"datasetId":"ds_ab12cd","layer":"bronze"}
```

### `propose_quality_fixes`

Floor: **creator** · Tab: data · External door: toolset `data`

PROPOSE AI remediations for ONE failing quality rule — the Validate stage’s "Propose fixes" button, the SAME governed path as POST /api/data/datasets/:id/dq/propose. The rule is re-run FOR REAL first (a passing rule proposes nothing); failing rows are sampled (honest "showing N of M"); the REASONING model establishes the fix and the STANDARD model fills per-row values (the model split). Returns EITHER a batch proposal (ONE guard-validated column-transform expression, previewed before→after with a MEASURED residual — estimatedFix is derived by SQL, never trusted from the model), OR per-row fixes (ONLY when the dataset declares a unique key column and ≤200 rows fail — row identity is NEVER guessed), OR an honest kind:"none" diagnosis for rules a single-column edit cannot fix (e.g. unique). Model unconfigured/over-cap/unreachable ⇒ offline:true, never a fake proposal. READ-ONLY: nothing is applied — apply_quality_fixes is the explicit, edit-gated write door. Before: run_quality_checks (to find the failing rule id). Governance: Creator+ on a dataset you can see.

| Argument | Type | Required | Description |
|---|---|---|---|
| `datasetId` | string | yes | Dataset id (from list_datasets). |
| `checkId` | string | yes | The failing rule’s check id (from run_quality_checks results). |

Example arguments:

```json
{"datasetId":"ds_ab12cd","checkId":"chk_1"}
```

### `query_data`

Floor: **creator** · Tab: data · External door: core (always listed)

Run a read-only SQL query over the governed Iceberg marts. The SQL runs on Trino, so write Trino SQL (not PostgreSQL or T-SQL): e.g. listagg(x, ', ') WITHIN GROUP (ORDER BY x) for string aggregation, LIMIT n, and the fully qualified table name from get_dataset → `queryable.fqn`. OPA-authorized on your domain and Langfuse-audited, exactly like the UI data tool. A Trino SQL mistake returns code `sql_error` with a hint. Before: list_datasets / get_dataset (for the fqn and real columns). For a governed KPI use query_metric instead — one definition of the number.

| Argument | Type | Required | Description |
|---|---|---|---|
| `sql` | string | yes | One read-only statement in Trino SQL. |

Example arguments:

```json
{"sql":"SELECT region, sum(net_amount) AS revenue FROM iceberg.sales.orders GROUP BY region ORDER BY revenue DESC LIMIT 10"}
```

### `reconcile_domain_tables`

Floor: **builder** · Tab: data · External door: toolset `data`

SELF-HEAL the recurring "domain gold table not materialized" drift (#96 / #151): a promoted dataset whose registry says served (tier=asset, queryable, metric-ready) but whose PHYSICAL domain table `iceberg.<domain>.gold_<slug>` has vanished from the warehouse (a catalog/warehouse event, or a demote→re-promote round-trip) — so Dashboards and every metric read dead-end with "not materialized". This SWEEP enumerates the promoted domain tables you govern (optionally scoped to one `domain`), PROBES each physical Iceberg table, and RE-MATERIALIZES any that are MISSING or STALE by re-running the SAME stored publish CTAS the Data tab runs (source = the owner’s built Gold → target = the domain schema; preserves grain + measures — it re-runs the stored plan, never reconstructs). Best-effort per dataset (one failure never aborts the sweep) and IDEMPOTENT (a healthy, in-sync table is skipped — no CTAS re-run). Returns an honest per-dataset report {datasetId, name, fqn, before: missing|stale|ok, after: refreshed|failed|skipped, error?}. Governance: Builder+ heals their OWN domain (the domain-schema write floor); Admin heals every domain. Use after a warehouse re-provision, or when a dashboard reports a governed dataset "not materialized". The SAME sweep the governed route POST /api/platform-admin/reconcile-domain-tables runs.

| Argument | Type | Required | Description |
|---|---|---|---|
| `domain` | string |  | Optional — scope the sweep to ONE domain (e.g. "agentic-leader-q3-2026"). Omit to sweep every domain you govern. |

Example arguments:

```json
{}
```

### `request_promotion`

Floor: **creator** · Tab: data, files · External door: toolset `data`

FILE a rung-1 promotion request (My → a governed DOMAIN asset) for ANY ownable artifact: a dataset, file, workflow (`kind: "workflow"`, id `wf_…`), knowledge note (`kind: "personal_knowledge"`, id `pk_…`), connection, dashboard, artifact, app or agent system. Path: the promote step of every tab’s golden path — the ONE governed ladder. Before: create + document the artifact (creating in My scope needs no approval; only this promotion up a scope is gated). After: a domain admin (or tenant admin) in the domain runs `decide_approval` (or `approve_promotion` for dataset/file). Governance: OWNER-ONLY trigger — edit rights are not enough; it does NOT promote, it enqueues the governed request and returns the pending handle. If you are the owner AND already hold the rung-1 authority (a domain admin or platform admin promoting your OWN artifact), you may then decide your own request: the rank and scope gates still apply, and blocking it would simply leave your artifact unpromotable. Certification (Domain → Company) is the separate `request_certification`. Idempotency: filing while a request is pending returns the existing handle.

| Argument | Type | Required | Description |
|---|---|---|---|
| `kind` | `dataset` \| `file` \| `workflow` \| `knowledge` \| `personal_knowledge` \| `connection` \| `dashboard` \| `artifact` \| `app` \| `agent_system` | yes | What to promote (you must OWN it). A metric is NOT on this list: a metric IS a measure on a dataset, so its audience is its dataset’s — promote the dataset. |
| `id` | string | yes | The artifact id you own and have documented. |
| `visibility` | string |  | Requested asset visibility (dataset/file only; default domain). |
| `grants` | any[] |  | Optional explicit policy grants (dataset/file only; else a domain read grant). |

Example arguments:

```json
{"kind":"dataset","id":"ds_ab12cd","visibility":"domain"}
```

### `retire_dataset`

Floor: **creator** · Tab: data · External door: toolset `data`

RETIRE a dataset you can edit — the Data tab’s lifecycle, the counterpart to `retire_workflow`: `archive` (the default: reversible soft-hide, retains the record + medallion versions + history; it just stops showing in the default list) or `delete` (PHYSICAL, irreversible removal of the registry record). Same governed store the Data tab + `/api/data/datasets/[id]` call. LINEAGE-AWARE on delete: blocked with a typed 409 if any domain still imports the data product (mirrors deleteDataset — remove subscribers first). Role gate (edit scope, re-checked in-lib): the OWNER may retire their own Personal/unshared dataset; a SHARED/domain dataset needs a same-domain Builder+ (or Admin). Idempotency: retiring a missing dataset is a typed not_found (no existence leak). Use to clean up stray/duplicate datasets (e.g. leftovers from a runaway agent loop).

| Argument | Type | Required | Description |
|---|---|---|---|
| `datasetId` | string | yes | The dataset id to retire (from list_datasets). |
| `action` | `archive` \| `delete` |  | archive = reversible soft-hide (default); delete = physical, irreversible removal. |

Example arguments:

```json
{"datasetId":"ds_ab12cd"}
```

### `rollback_dataset_version`

Floor: **creator** · Tab: data · External door: toolset `data`

Restore a dataset’s data to an earlier version: Iceberg’s own `ALTER TABLE … EXECUTE rollback_to_snapshot(<id>)` on the dataset’s table, through the governed write path (your own lane, or your domain as a builder+). Nothing is deleted: the newer snapshots stay in the history until expiry, so a restore can itself be undone by rolling forward. Refused on a table another dataset maps to (`shared_table`, archived siblings included) and on a legacy name-only lane table (`legacy_lane`); the refusal touches nothing.

| Argument | Type | Required | Description |
|---|---|---|---|
| `datasetId` | string | yes | Dataset id you can edit. |
| `snapshotId` | string | yes | The snapshot id to make current (from get_dataset_versions). |
| `layer` | `bronze` \| `silver` \| `gold` |  | Medallion layer; default: the layer the dataset is served from. |

Example arguments:

```json
{"datasetId":"ds_ab12cd","snapshotId":"8954597067493422955"}
```

### `run_quality_checks`

Floor: **creator** · Tab: data · External door: toolset `data`

Run a dataset’s data-quality rules and READ the result — the "Run checks" button. Each structured rule is compiled to a governed COUNT-of-violations SQL and executed through the SAME governed query path AS THE OWNER (a private dataset’s personal_<uid> table is read as its owner, OPA-governed), producing a REAL pass/fail per rule plus an aggregate badge (passing | failing | unknown). Honesty: a rule that can’t run (nothing materialised yet, or a free-text intention) is reported "not_run", NEVER a fake pass. Before: define_quality_rules (+ a built layer to check). After: propose_quality_fixes on a failing rule to get AI-proposed remediations. Governance: Creator+ on a dataset you can see; read-only.

| Argument | Type | Required | Description |
|---|---|---|---|
| `datasetId` | string | yes | Dataset id whose rules to run (from get_dataset). |

Example arguments:

```json
{"datasetId":"ds_ab12cd"}
```

### `set_dataset_sync`

Floor: **creator** · Tab: data · External door: toolset `data`

Configure (or enable/disable) SCHEDULED INCREMENTAL SYNC (also called: refresh, data pipeline, ETL) on a connector-backed dataset you can edit — the Data tab’s "Keep this in sync" panel, the SAME governed path as PUT /api/data/datasets/:id/sync (one service, `saveDatasetSyncService`): the per-source locks below are applied, the strict store gate validates, and the SCHEDULE is then owned by Dagster — it is committed into your domain’s repository as an `os/schedules.yml` entry and run by the `sovereign` code location, so NO Kubernetes CronJob is provisioned and a pre-B2 one is removed. The `cron` field reports that honestly (`live:false` when the cluster could not be reached — never a claim). Modes: full-refresh (re-copy each run) · append (rows newer than the cursor; late rows may re-deliver) · merge (upsert by mergeKeys — warehouse sources only, daily-ish cadence). PER-SOURCE LOCKS (the panel’s rules, enforced server-side): kafka → append ONLY, cursor auto-locked to partition offsets; salesforce → no merge, incremental cursor auto-locked to SystemModstamp; kajabi → no merge, cursor auto-locked to the resource’s DOCUMENTED field — `purchases` is true incremental (updated_at: new AND changed), contacts/customers/orders/form_submissions are created_at-only (NEW records append; EDITS are not detected — full-refresh to capture them), cursorless resources (offers, products, transactions, …) are full-refresh ONLY (a typed bad_request otherwise, never fake incremental). Warehouse sources pass their own `cursor` {column, kind}. Schedule: a preset (every-15-minutes|every-30-minutes|hourly|daily|weekly) or a 5-field cron. Before: create_dataset + a first import/ingest from the connection. After: sync_dataset_now to run immediately, get_sync_status to watch. Pass `clear: true` (and nothing else) to REMOVE the sync entirely, exactly as the panel’s "Remove sync" does. Governance: edit scope (owner / domain admin) re-checked in-lib; the sync executes AS the dataset OWNER, never a service principal.

| Argument | Type | Required | Description |
|---|---|---|---|
| `datasetId` | string | yes | Target dataset id (from list_datasets). |
| `connectionId` | string |  | The source connection id (from list_connections) — warehouse/Kafka, Salesforce or Kajabi. Required unless `clear: true`. |
| `source` | object |  | What to pull: {schema, table}. For API sources, table is the object/resource (e.g. Salesforce "Account", Kajabi "purchases") and schema is a label (e.g. "salesforce"). Required unless `clear: true`. |
| `mode` | `full-refresh` \| `append` \| `merge` |  | full-refresh \| append \| merge (see the per-source locks in the tool description). Required unless `clear: true`. |
| `cursor` | object |  | Warehouse sources only — the new-rows column: {column, kind: timestamp\|number}. Kafka/Salesforce/Kajabi lock the cursor automatically; anything passed here is ignored for them. |
| `mergeKeys` | string[] |  | merge mode only: the upsert key column(s). |
| `schedule` | string |  | A preset — every-15-minutes (*/15 * * * *) \| every-30-minutes (*/30 * * * *) \| hourly (0 * * * *) \| daily (0 6 * * *) \| weekly (0 6 * * 1) — or a raw 5-field cron (UTC). Required unless `clear: true`. |
| `enabled` | boolean |  | false keeps the config but deletes the schedule trigger (default true). |
| `clear` | boolean |  | true REMOVES the sync configuration entirely (the UI panel’s "Remove sync"): the schedule is dropped from os/schedules.yml, any pre-B2 CronJob is deleted, and no other field is read. Use `enabled: false` to keep the config and only stop the schedule. |

Example arguments:

```json
{"datasetId":"ds_ab12cd","connectionId":"conn_x1","source":{"schema":"sales","table":"orders"},"mode":"append","cursor":{"column":"updated_at","kind":"timestamp"},"schedule":"hourly"}
```

### `sync_dataset_now`

Floor: **creator** · Tab: data · External door: toolset `data`

Trigger ONE immediate sync run (also called: refresh, data pipeline, ETL) of a dataset you can edit — the panel’s "Sync now" (or, with reset:true, "Reset & full re-sync": replace the copy and restart the cursor from now), the SAME governed executor as POST /api/data/datasets/:id/sync. Returns the outcome HONESTLY: {run} with the real run record (status ok|error, rowsAffected, cursor window, batchId) after the write confirmed — the cursor advances ONLY on success; or {skipped, reason} when another run holds the lease or nothing is due (skip-not-queue, never a phantom success); a dataset with no sync configured is a typed conflict. A successful manual run also clears quarantine. Before: set_dataset_sync. After: get_sync_status for history + watermark. Governance: edit scope re-checked (same gate as the route’s manual trigger); the sync itself executes AS the dataset OWNER through the governed query path — never a service principal.

| Argument | Type | Required | Description |
|---|---|---|---|
| `datasetId` | string | yes | Dataset id with a configured sync (from set_dataset_sync / list_datasets). |
| `reset` | boolean |  | true = full re-sync: replace the copy and restart the cursor from now. |

Example arguments:

```json
{"datasetId":"ds_ab12cd"}
```

### `tag_dataset_version`

Floor: **creator** · Tab: data · External door: toolset `data`

Name a version of a dataset’s data: an Iceberg TAG (immutable; kept by every snapshot expiry, whatever the retention) or a BRANCH, committed to the Polaris catalog. Any engine then reads it by name: `SELECT * FROM <table> FOR VERSION AS OF '<name>'` and lists it in `"<table>$refs"`. Names: letters, digits, `.`, `_`, `-` (not `main`); a taken name is refused, never moved. Same edit gate and shared-table refusal as rollback_dataset_version.

| Argument | Type | Required | Description |
|---|---|---|---|
| `datasetId` | string | yes | Dataset id you can edit. |
| `snapshotId` | string | yes | The snapshot id to name. |
| `name` | string | yes | Tag or branch name. |
| `kind` | `tag` \| `branch` |  | Default tag. |
| `layer` | `bronze` \| `silver` \| `gold` |  | Medallion layer; default: the layer the dataset is served from. |

Example arguments:

```json
{"datasetId":"ds_ab12cd","snapshotId":"8954597067493422955","name":"q3-close"}
```

### `transform_silver`

Floor: **creator** · Tab: data · External door: toolset `data`

Clean a dataset’s Bronze into its physical SILVER via guided ops compiled into ONE governed CTAS — the same compiler + Build adapter as the Data tab’s Transform panel. Ops: rename {column,to} · cast {column,type: varchar|integer|bigint|double|boolean|date|timestamp} · trim {column} · normalize {column} (lower+trim) · drop {column} · filter {column, op: =|<>|>|>=|<|<=|not_null|not_blank, value?} · dedupe {keys[]} (empty keys ⇒ DISTINCT). Purpose: step 3 of the physical Data golden path. Before: ingest_dataset (Bronze must be built); profile_dataset to see the columns. After: build_gold_join, or add_dataset_version(gold). Governance: the SQL is compiled server-side from your ops (a client can never send raw SQL), the CTAS targets YOUR OWN schema and executes AS YOU — Trino→OPA masks every read — and the Silver version is registered ONLY on a ✓ apply+verify (an honest ✗ registers nothing).

| Argument | Type | Required | Description |
|---|---|---|---|
| `datasetId` | string | yes | Target dataset id (Bronze must be built). |
| `columns` | string[] | yes | The SOURCE Bronze column names to project (from profile_dataset). |
| `ops` | object[] |  | Guided cleaning ops (see the tool description for the op kinds). Empty = plain projection. |

Example arguments:

```json
{"datasetId":"ds_ab12cd","columns":["order_id","net_amount","region"],"ops":[{"kind":"cast","column":"net_amount","type":"double"},{"kind":"filter","column":"order_id","op":"not_null"},{"kind":"dedupe","keys":["order_id"]}]}
```

## Tab: knowledge

<a id="tab-knowledge"></a>

### `export_okf_bundle`

Floor: **creator** · Tab: knowledge · External door: toolset `knowledge`

Export a workflow (wf_…) you can see as an OKF (Open Knowledge Format) v0.2 bundle — a portable, human-readable directory of markdown + YAML frontmatter (the interchange format; the retrieval engine is untouched). The bundle is zipped and written as a governed Files-tab artifact (MCP cannot return a zip inline), and this tool returns its file `id` + `deepLink` so you can Download it or share it. Round-trip is lossless for our own artifacts (steps/actors/rules/tacit + tier/owner survive), and conformance is validated on export. Governance: read-scoped on the source workflow; the bundle file is created AS YOU at Personal tier.

| Argument | Type | Required | Description |
|---|---|---|---|
| `workflowId` | string | yes | The workflow id (wf_…) to export (from list_workflows). |

Example arguments:

```json
{"workflowId":"wf_ab12cd"}
```

### `get_knowledge`

Floor: **creator** · Tab: knowledge · External door: core (always listed)

Read one knowledge note you can see — its title, markdown text, folder and scope. Path: DISCOVERY for the Knowledge golden path. Before: list_knowledge / search_knowledge. Governance: read-only; an unseeable id → not_found. A workflow is a different artifact: read it with get_workflow.

| Argument | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Knowledge note id (pk_…) from list_knowledge or a search_knowledge hit. |
| `workflowId` | string |  | DEPRECATED, removed next release: a workflow id. Use get_workflow for a workflow. |

Example arguments:

```json
{"id":"pk_ab12cd"}
```

### `import_okf_bundle`

Floor: **creator** · Tab: knowledge · External door: toolset `knowledge`

Import an OKF (Open Knowledge Format) v0.2 bundle (a zip of markdown + YAML frontmatter) into the Knowledge tab. The bundle is validated for conformance, then its concepts land as GOVERNED artifacts at PERSONAL tier with YOU as owner, through the normal author ladder (never a governance bypass) — publish/certify them afterwards as usual. Idempotent: a concept whose `resource` matches an artifact you already own becomes a NEW VERSION (no silent duplicates). Unknown types + unknown fields + broken links are ACCEPTED (an unknown type is kept + shown, mapped to a general knowledge doc); only a truly malformed bundle (unparseable frontmatter, missing `type`) is rejected, with an honest reason. SECURITY: paths are zip-slip-sanitised and hard caps (≤ 50 MB unpacked, ≤ 2,000 files) are enforced. Provide the zip as standard base64 in `base64Content` (~4 MB MCP in-band limit; larger bundles import through the Knowledge tab UI).

| Argument | Type | Required | Description |
|---|---|---|---|
| `base64Content` | string | yes | The OKF bundle .zip encoded as standard base64. |
| `domain` | string |  | One of YOUR domains to home the imported artifacts in; defaults to your first. |

Example arguments:

```json
{"base64Content":"UEsDBBQAAAAI…"}
```

### `list_knowledge`

Floor: **creator** · Tab: knowledge · External door: core (always listed)

List the knowledge notes you can see — the free-form markdown documents of the Knowledge tab (My · Domain · Company), each with its id (pk_…), title and folder. Pass `folder` to list ONE folder (and its subfolders). Path: DISCOVERY for the Knowledge golden path (guide: sovereign-os://guide/path/knowledge). Before: whoami. After: get_knowledge for a note's text, or search_knowledge for content across notes. Governance: read-only, scope-checked.

| Argument | Type | Required | Description |
|---|---|---|---|
| `folder` | string |  | Optional folder path, e.g. "/results". |
| `lifecycle` | `draft` \| `testing` \| `live` |  | OPTIONAL. Show only objects at this point of their life: `draft` (being built), `testing` (a draft being tried out right now) or `live` (the version the OS runs). Omit to see everything, which is the default and what every existing caller gets. This is INDEPENDENT of My · Domain · Company, which says who may use an object rather than which version runs. |

Example arguments:

```json
{}
```

### `save_knowledge_note`

Floor: **creator** · Tab: knowledge · External door: toolset `knowledge`

Save a knowledge NOTE — a titled, free-form markdown document — into YOUR My knowledge, optionally in a folder. This is the entry the Knowledge tab lists under My knowledge (not a workflow: use author_workflow for steps, actors and rules). Purpose: keep a result, a summary or a piece of know-how where you and the agent systems you grant it to can use it. After: grant it (or its folder) to an agent system, or share it with your domain through request_promotion({kind:"personal_knowledge"}). Governance: created AS YOU, Personal and owner-only; sharing is the separate governed promotion. Idempotency: pass `sourceKey` to make the call repeatable — a second call with the same key returns the note you already saved (`already: true`) instead of writing another. Search: the note is indexed so search_knowledge finds it — for YOU only (a Personal note is owner-only in search too); `searchable` says whether indexing worked.

| Argument | Type | Required | Description |
|---|---|---|---|
| `title` | string | yes | The note’s title. |
| `md` | string | yes | The note’s body, as markdown. |
| `folder` | string |  | Optional folder path in My knowledge, e.g. "/results". Created when the first note is saved there. |
| `domain` | string |  | One of YOUR domains; defaults to your first. |
| `sourceKey` | string |  | Optional. A key that identifies this save; repeating the call with it returns the note already saved. |
| `refresh` | boolean |  | Optional, with `sourceKey`: when the key matches a note you already saved, replace its title and body (kept in its version history) instead of returning it unchanged. Used to re-import a source. |

Example arguments:

```json
{"title":"Invoice run — 2026-11-19","md":"## Summary\n12 invoices processed.","folder":"/results"}
```

### `search_knowledge`

Floor: **creator** · Tab: knowledge · External door: core (always listed)

Governed hybrid knowledge retrieval (dense + lexical, reranked) with provenance for citations. Runs the same OPA `retrieve` gate + document-level grant filter as the Knowledge tab — you only ever see units you are entitled to. Hits cover knowledge notes (ids `pk_…`) and indexed workflows (ids `wf_…`); read one with get_knowledge or get_workflow.

| Argument | Type | Required | Description |
|---|---|---|---|
| `query` | string | yes | What to retrieve. |
| `k` | number |  | Max hits (default 6, capped at 20). |

Example arguments:

```json
{"query":"how do we handle a refund over 500 EUR","k":6}
```

## Tab: workflows

<a id="tab-workflows"></a>

### `author_workflow`

Floor: **creator** · Tab: workflows · External door: toolset `knowledge`

Author a Personal (draft) WORKFLOW (also called: process workflow, SOP (Standard Operating Procedure)) — the documentation of a business process, the runbook for a task: an optional markdown body, ordered `steps` (each with an actor and optional per-step `tacit` note), process `rules`, an optional `actors` registry, and an optional process-level `tacit` string (the TACIT.md companion — unstructured know-how that resists formalization: the gotchas, the "why", the tribal memory). Actors have five categories — Human · Software · Agent · Customer · Partner — where Customer and Partner are EXTERNAL (outside the organisation). The optional `actors` array lets you describe each actor once (name · category · description) and steps reference them by name; if you omit it, a registry is derived from the steps automatically. Same governed store as the Workflows tab. A workflow is NOT a knowledge note: to save a report, an answer or any free-form text, use `save_knowledge_note` instead. Before: list_workflows (extend before duplicating). After: index_workflow; share via request_promotion({kind:"workflow"}) — a domain admin approves (publish_workflow). Governance: created AS YOU in My scope, no approval.

| Argument | Type | Required | Description |
|---|---|---|---|
| `title` | string | yes | Business process title, e.g. "Refund handling". |
| `domain` | string |  | One of YOUR domains; defaults to your first. |
| `markdown` | string |  | Optional free markdown body (context/prose). |
| `steps` | object[] |  | Ordered steps. |
| `actors` | object[] |  | Optional actor registry — describe each actor once so steps can reference it by name. Five categories: Human · Software · Agent · Customer · Partner (Customer and Partner are external). Omit to derive a registry from the steps automatically. |
| `rules` | object[] |  | Business process decision rules. |
| `tacit` | string |  | Process-level tacit knowledge (the sibling TACIT.md). Use this for unstructured know-how that resists formalization — the gotchas, the "why behind the why", institutional memory, cultural nuances that don't fit into steps or rules. Markdown is fine; headings split it into separately-retrievable chunks. Per-step inline notes go in `steps[].tacit` instead. |

Example arguments:

```json
{"title":"Refund handling","domain":"support","actors":[{"name":"Support Agent","category":"Human","description":"Front-line agent who verifies the order."},{"name":"Billing System","category":"Software","description":"Issues the refund via the payments API."},{"name":"Customer","category":"Customer","description":"Requests the refund (external)."}],"steps":[{"title":"Request refund","actor":"Customer","actor_name":"Customer","outputs":["Refund request"]},{"title":"Verify order","actor":"Human","actor_name":"Support Agent","outputs":["Verified order"],"tacit":"Check section 4 — the date field is frequently missed by new agents."},{"title":"Issue refund","actor":"Software","actor_name":"Billing System","inputs":["Verified order"]}],"rules":[{"text":"Refunds over 500 EUR need a manager","hard":true}],"tacit":"## Edge cases\nHigh-value refunds (> 1 000 EUR) route to the finance team even on weekends — the on-call number is in the finance Notion.\n\n## Cultural note\nThe support team uses \"RT\" as shorthand for \"refund ticket\" in Slack."}
```

### `get_workflow`

Floor: **creator** · Tab: workflows · External door: core (always listed)

Read one workflow you can see — steps, actors, rules, tacit note, status. Returns `knowledgeLinks: { links: [{id,title}], unresolved: [{href,label}] }` — the first-class references from THIS workflow to OTHER documents, so you can walk a certified bundle deterministically instead of re-searching; unresolvable links are flagged, not dropped. Path: DISCOVERY for the Workflows golden path. Before: list_workflows. After: index_workflow or (Domain admin) publish_workflow. Governance: read-only; an unseeable id → not_found.

| Argument | Type | Required | Description |
|---|---|---|---|
| `workflowId` | string | yes | Workflow id (wf_…) from list_workflows. |

Example arguments:

```json
{"workflowId":"wf_ab12cd"}
```

### `index_workflow`

Floor: **creator** · Tab: workflows · External door: toolset `knowledge`

Re-run the indexing pipeline (unit-chunk → embed → hybrid index) for a workflow you can see + its domain card, so `search_knowledge` can return its text. Governance: read-scoped on the workflow; runs AS you. Idempotent — safe to re-run.

| Argument | Type | Required | Description |
|---|---|---|---|
| `workflowId` | string | yes | Workflow id (wf_…) to (re)index. |

Example arguments:

```json
{"workflowId":"wf_ab12cd"}
```

### `list_workflows`

Floor: **creator** · Tab: workflows · External door: core (always listed)

List the workflows you can see — the documented business processes of the Workflows tab — My · Domain · Company. Path: DISCOVERY for the Workflows golden path. Before: whoami. After: get_workflow. Governance: read-only, DLS-scoped.

| Argument | Type | Required | Description |
|---|---|---|---|
| `lifecycle` | `draft` \| `testing` \| `live` |  | OPTIONAL. Show only objects at this point of their life: `draft` (being built), `testing` (a draft being tried out right now) or `live` (the version the OS runs). Omit to see everything, which is the default and what every existing caller gets. This is INDEPENDENT of My · Domain · Company, which says who may use an object rather than which version runs. |

Example arguments:

```json
{}
```

### `publish_workflow`

Floor: **domain_admin** · Tab: workflows · External door: toolset `knowledge`

Publish a draft workflow My → Domain (draft→live) and re-index it for retrieval. Domain-admin+ only (the My→Domain approval gate). This is the "approve half" of the ladder: the flip runs THROUGH the governance effect seam (no direct publish back door). Before: get_workflow (a creator files request_promotion({kind:"workflow"}) instead). Governance: domain_admin+ in the workflow’s domain. Idempotency: publishing an already-live workflow returns a `conflict`.

| Argument | Type | Required | Description |
|---|---|---|---|
| `workflowId` | string | yes | Draft workflow id (wf_…) to publish. |

Example arguments:

```json
{"workflowId":"wf_ab12cd"}
```

### `retire_workflow`

Floor: **creator** · Tab: workflows · External door: toolset `knowledge`

RETIRE a workflow you can edit — the Workflows tab’s lifecycle: `archive` (the default: reversible soft-hide, retains the record + history) or `delete` (PHYSICAL + irreversible: removes the record, its version history, and purges its indexed units from OpenSearch + the offline mirror so it stops being retrievable). Same governed store the Workflows tab + `/api/knowledge/workflows/[id]` call. LINEAGE-AWARE: blocked with a typed 409 if any App or Agent system still consumes it (never orphan a live dependency) — remove those uses first. Role gate (edit scope, re-checked in-lib): the OWNER may retire their own Personal/unshared workflow; a SHARED/domain workflow needs a same-domain Builder+. Physical `delete` additionally refuses a still-published (`live`) workflow — archive/unpublish it first (mirrors the store). Idempotency: retiring a missing workflow is a typed not_found.

| Argument | Type | Required | Description |
|---|---|---|---|
| `workflowId` | string | yes | The workflow id (wf_…) to retire. |
| `action` | `archive` \| `delete` |  | archive = reversible soft-hide (default); delete = physical, irreversible removal + index purge. |

Example arguments:

```json
{"workflowId":"wf_ab12cd"}
```

## Tab: files

<a id="tab-files"></a>

### `get_file`

Floor: **creator** · Tab: files · External door: core (always listed)

Read ONE governed file you are entitled to — metadata (name, folder, tags, description, sensitivity, tier, version history) plus the extracted text. Purpose: read back what upload_file stored so agents can quote the actual content, not a guess. Before: list_files or search_files. After: request_promotion once documented, or reference the content in knowledge/agent work. Governance: read-only through the SAME document-level entitlement filter (DLS) as the Files tab — an unentitled id is a typed not_found/forbidden. Honesty: `restricted` files return metadata ONLY (the text is stored but never returned or indexed), and long text comes in pages of ~8k characters: the note and `nextOffset` say how to read the next one — never silently.

| Argument | Type | Required | Description |
|---|---|---|---|
| `fileId` | string | yes | File id from list_files / search_files. |
| `offset` | number |  | Optional. Character offset to start reading at (from a previous answer's `nextOffset`). Omit for the start. |

Example arguments:

```json
{"fileId":"as_ab12cd34"}
```

### `list_files`

Floor: **creator** · Tab: files · External door: core (always listed)

List the files you can see (My · Domain · Company). Pass `folder` to list ONE folder (and its subfolders) instead of everything. Path: DISCOVERY for the Files golden path (guide: sovereign-os://guide/path/files). Before: whoami. After: search_files for content, or upload_file only if nothing fits. Governance: read-only, DLS-scoped.

| Argument | Type | Required | Description |
|---|---|---|---|
| `folder` | string |  | Optional. Only files in this folder and its subfolders, e.g. "/Invoices". Omit to list everything you can see. |

Example arguments:

```json
{}
```

### `reindex_corpus`

Floor: **admin** · Tab: files, knowledge · External door: toolset `files`

ADMIN ONLY. Re-parse and re-embed the Files or Knowledge OpenSearch index through the REAL services (Docling for files; the embeddings gateway for both) — the remedy the CHANGELOG records as the UPGRADE ACTION for rows written before the production offline-mock guard, when an unreachable parser invented a document’s text and an unreachable gateway wrote HASH vectors. The SAME governed services as POST /api/platform-admin/reindex and the Platform → Re-index panel. `mode:"plan"` is a DRY RUN: it writes nothing, works while the engines are down, and returns counts per reason (marked · missing-representation · missing-vector · dimension-mismatch · all) plus `ready`/`blockedReason` and a sample of the units a run would touch. `mode:"run"` does ONE BOUNDED BATCH and returns the job — call it again to continue from its cursor until `status` is "done"; a run already in flight for that target reports `started:false, reason:"already-running"` with that job’s real progress rather than starting a twin (skip-not-queue, like sync_dataset_now). HONESTY, and read this before reporting a clean corpus: `filter:"marked"` can only find rows that still carry EVIDENCE (a persisted stand-in label, no vector at all, or an index whose knn dimension no longer matches the configured one). Neither index persisted the embed source, so a hash vector is indistinguishable from a real one — `filter:"all"` re-parses and re-embeds everything and is the only complete answer. Every reply carries that sentence as `caveat`. An unreachable parser or gateway is a typed ENGINE_UNAVAILABLE refusal and NOTHING is read, replaced or deleted — it never falls back to a stand-in, and a unit whose re-parse or re-embedding came back as one is reported failed with its existing rows left in place. Before: nothing. After: poll with mode:"run" (or mode:"plan") until done. Governance: admin re-checked in-lib at both doors; the embedding spend is billed to the acting admin with the object’s domain.

| Argument | Type | Required | Description |
|---|---|---|---|
| `target` | `files` \| `knowledge` | yes | Which index: "files" or "knowledge". |
| `mode` | `plan` \| `run` \| `abandon` |  | "plan" = dry run, writes nothing. "run" = one bounded batch (resumes a running job without re-planning). "abandon" = give up on the running job and free the target. |
| `filter` | `marked` \| `all` |  | "marked" = only units with detectable evidence (cheap, INCOMPLETE — see `caveat`). "all" = every unit (complete, and it spends real gateway budget). |
| `batch` | number |  | Units in this run call (default 25, max 200). Ignored by mode:"plan". |
| `status` | boolean |  | true = report the target’s current job and do nothing else. |

Example arguments:

```json
{"target":"files","mode":"plan","filter":"marked"}
```

### `search_files`

Floor: **creator** · Tab: files · External door: core (always listed)

Semantic + lexical search over the files you are entitled to (restricted files are stored-not-indexed, so never surface). Returns { mode, total, hits, note? }: mode `hybrid` = meaning + words; `lexical` = words only (embedding gateway down); `keyword-only` = the search index is unavailable and only name/tag/text words were matched. Path: DISCOVERY for the Files golden path. Before: list_files. After: reference a hit, or upload_file if absent. Governance: read-only; the same document-level grant filter as the Files tab.

| Argument | Type | Required | Description |
|---|---|---|---|
| `query` | string | yes | What to find. |

Example arguments:

```json
{"query":"refund policy"}
```

### `upload_file`

Floor: **creator** · Tab: files · External door: toolset `files`

Upload a governed file (private object-store file at v1) into the Files tab — the SAME governed path as the UI upload. For BINARY files (PDFs, images, Office docs, etc.) provide the raw bytes as `base64Content` (standard base64) and set `mimeType` (e.g. "application/pdf"). The decoded bytes are stored in the governed object store so Download returns the REAL file byte-for-byte. A binary DOCUMENT (PDF, DOCX, PPTX, XLSX) then has its text read from those bytes by the document parser and stored with the file, so `get_file` returns it and search finds it; if the parser cannot read it the upload still succeeds and the returned `indexing.extraction.reason` says exactly why (nothing is invented). For plain-text files (Markdown, CSV, JSON, TXT) you may omit `base64Content` and pass the content as `text` instead; it is indexed for search. Do NOT pass a markdown description of a binary file as `text` and omit the bytes — that produces a misleading text-only record. MCP in-band limit: ~4 MB of base64 (≈3 MB decoded). Larger files must be uploaded through the Files tab UI. `restricted` sensitivity is stored-but-not-indexed. A `description` + ≥1 tag make the file eligible for `request_promotion` (kind `file`).

| Argument | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | File name including extension, e.g. "invoice-2026-01.pdf". |
| `base64Content` | string |  | The file's raw bytes encoded as standard base64. Required for binary files (PDF, PNG, DOCX, XLSX, …). Must be paired with `mimeType`. Omit for plain-text files where `text` carries the content. |
| `mimeType` | string |  | MIME type of the file, e.g. "application/pdf", "image/png", "application/vnd.openxmlformats-officedocument.wordprocessingml.document". Required when `base64Content` is provided. |
| `folder` | string |  | Optional folder path. |
| `text` | string |  | Extracted/preview text for search indexing. For plain-text files pass the full content here. For binary files this is OPTIONAL supplemental text (e.g. a pre-extracted transcript or summary) — do NOT use it as a substitute for the real bytes. |
| `tags` | string[] |  | Optional tags (≥1 needed to promote). |
| `description` | string |  | What this file is (needed to promote it). |
| `sensitivity` | `public` \| `internal` \| `confidential` \| `restricted` |  | Governs indexing (restricted ⇒ not indexed). |
| `domain` | string |  | One of YOUR domains; defaults to your first. |

Example arguments:

```json
{"name":"invoice-2026-01.pdf","base64Content":"JVBERi0xLjQK…","mimeType":"application/pdf","folder":"invoices","tags":["invoice","finance"],"description":"January 2026 supplier invoice","sensitivity":"confidential"}
```

## Tab: metrics

<a id="tab-metrics"></a>

### `define_metric`

Floor: **creator** · Tab: metrics · External door: toolset `analytics`

Define a governed metric (also called: KPI, measure, indicator) on a dataset’s built GOLD version — the one definition of a number (its `View.measure` member). The dataset must already be a governed asset/product (promote it in Data first). Returns the canonical member, the dbt metric type it is emitted as, and the dbt `semantic_models:` + `metrics:` YAML the OS committed into your domain’s dbt project (`models/semantic/<model>.yml`). THE FULL MEASURE MODEL (same as the Metrics tab form — all optional, a plain call yields exactly {name,type,sql}): `aggregation` — count · count_distinct · count_distinct_approx (fast approximate distinct) · sum · avg · min · max · number (a DERIVED/ratio measure). `filter` — a FILTERED measure: aggregate only rows where {column op value} (op: equals|notEquals|gt|gte|lt|lte|set|notSet). `runningTotal` — a cumulative running total from the beginning of time. `rollingWindow` — a trailing time window (last N day|week|month|quarter|year), mutually exclusive with runningTotal. `ratio` — for aggregation "number", a numerator/denominator over two OTHER metrics on the same dataset (emitted as a dbt `type: ratio` metric). `format` — display format (currency|percent|number…). `drillMembers` — drill-down members exposed for exploration. `dimensions` — the slice-by columns this metric is meant to be explored by (a curation hint, persisted on the measure and rehydrated on edit). `timeDimension`+`granularity` are query-time (query_metric), not part of the definition. UPSERT: define is keyed by the metric name — re-defining a metric of the SAME name on the same dataset UPDATES it in place (no false "already defined"), a new name adds one.

| Argument | Type | Required | Description |
|---|---|---|---|
| `datasetId` | string | yes | Gold, governed (asset/product) dataset id. |
| `name` | string | yes | Human metric name, e.g. "Revenue". |
| `aggregation` | `count` \| `count_distinct` \| `count_distinct_approx` \| `sum` \| `avg` \| `min` \| `max` \| `number` | yes | The aggregation. count/count_distinct/count_distinct_approx count rows; sum/avg/min/max aggregate a column; number is a derived (ratio) measure. |
| `column` | string |  | Gold column to aggregate (omit for count/count_distinct-of-rows and for number/ratio). |
| `dimensions` | string[] |  | Dimensions the metric can be sliced by. |
| `filter` | object |  | Optional FILTERED measure — aggregate only rows matching {column op value}. |
| `runningTotal` | boolean |  | Cumulative running total from the beginning of time (mutually exclusive with rollingWindow). |
| `rollingWindow` | object |  | Trailing time window — last `amount` `unit` (mutually exclusive with runningTotal). |
| `ratio` | object |  | For aggregation "number": a derived measure = numerator / denominator, each an EXISTING measure member name on the same dataset. |
| `format` | string |  | Display format — e.g. currency, percent, number. |
| `drillMembers` | string[] |  | Drill-down members exposed for exploration. |

Example arguments:

```json
{"datasetId":"ds_ab12cd","name":"Revenue","aggregation":"sum","column":"net_amount","dimensions":["order_date","region"]}
```

### `get_metric`

Floor: **creator** · Tab: metrics · External door: core (always listed)

Read ONE governed metric (also called: KPI, measure, indicator) — its definition (aggregation + aggregated column), the gold dataset it is defined on, its tier + owner, the canonical member every consumer resolves, and the generated metric YAML. Purpose: read back exactly what define_metric registered so you iterate on the real definition instead of guessing. Before: list_metrics (take the `id`, shaped `<datasetId>.<measure>`). After: query_metric to evaluate the number, or create_dashboard to chart the member. Governance: read-only, resolved through the SAME dataset canView gate as list_metrics — a metric on a dataset you cannot see is a typed not_found/forbidden (no existence leak).

| Argument | Type | Required | Description |
|---|---|---|---|
| `metricId` | string | yes | Metric id from list_metrics — `<datasetId>.<measure>`, e.g. "ds_ab12cd.revenue". |

Example arguments:

```json
{"metricId":"ds_ab12cd.revenue"}
```

### `list_metrics`

Floor: **creator** · Tab: metrics · External door: core (always listed)

List the governed metric members you can see (also called: KPIs, measures, indicators) — the one definition of every number. Each row carries its `metricType` (the dbt semantic-layer type it is emitted as: simple · ratio · derived · cumulative) and its `grain` (the finest time bucket it can be sliced at, absent when the dataset exposes no time dimension), so you can pick a valid slice for query_metric without a round trip. Path: DISCOVERY for the Metrics + Dashboards golden paths (guide: sovereign-os://guide/path/metrics). Before: whoami. After: reuse a member on a dashboard, or define_metric only if missing. Governance: read-only, DLS-scoped.

| Argument | Type | Required | Description |
|---|---|---|---|
| `lifecycle` | `draft` \| `testing` \| `live` |  | OPTIONAL. Show only objects at this point of their life: `draft` (being built), `testing` (a draft being tried out right now) or `live` (the version the OS runs). Omit to see everything, which is the default and what every existing caller gets. This is INDEPENDENT of My · Domain · Company, which says who may use an object rather than which version runs. |

Example arguments:

```json
{}
```

### `preview_metric`

Floor: **creator** · Tab: metrics · External door: toolset `analytics`

Preview the number a metric definition will produce, without persisting anything. Use this BEFORE define_metric to validate the number. Every number here comes from ONE governed Trino SELECT run as YOU (Trino + OPA apply your row/column security) — an unsaved draft is labelled mode "live (sql)" and a saved metric "live"; offline degrades to the honestly-labelled "offline-mock". Returns rows + mode + the exact SQL that ran. pending: true only for a shape the OS compiler cannot yet serve (a rolling window at a grain it cannot express) — an honest refusal, never a number.

| Argument | Type | Required | Description |
|---|---|---|---|
| `datasetId` | string | yes | Gold, governed dataset id. |
| `name` | string | yes | Proposed metric name. |
| `aggregation` | `count` \| `count_distinct` \| `count_distinct_approx` \| `sum` \| `avg` \| `min` \| `max` \| `number` | yes |  |
| `column` | string |  |  |
| `dimensions` | string[] |  |  |
| `timeDimension` | string |  | Time column to slice by. |
| `granularity` | `day` \| `week` \| `month` \| `quarter` \| `year` |  |  |
| `limit` | number |  | Max rows (default 20, max 100). |

Example arguments:

```json
{"datasetId":"ds_ab12cd","name":"Revenue","aggregation":"sum","column":"net_amount","dimensions":["region"]}
```

### `promote_metric`

Floor: **creator** · Tab: metrics · External door: toolset `analytics`

Walk a metric one rung on the AUDIENCE ladder. Read this first: a metric is NOT an artefact with an audience of its own — it IS a measure on a governed dataset, and its tier is read straight off that dataset. So My→Domain is the DATASET’s move and this tool refuses it with the dataset named (promote the dataset with request_promotion; the metric follows). Domain→Company is an Admin act here, because certifying the measure and certifying the table it reads are the same decision. Governance: the consistency gate (documented + defined + resolves on its canonical member) and the dataset-tier ceiling both apply, and their refusal reaches you verbatim. Mirrors the Metrics tab promote button.

| Argument | Type | Required | Description |
|---|---|---|---|
| `metricId` | string | yes | Metric id: <datasetId>.<measureName>, e.g. "ds_ab12cd.revenue". |

Example arguments:

```json
{"metricId":"ds_ab12cd.revenue"}
```

### `query_metric`

Floor: **creator** · Tab: metrics · External door: core (always listed)

EVALUATE a governed metric (also called: KPI, measure, indicator) — resolve its canonical member and return the number(s), optionally sliced by dimensions/time. This is how "what is revenue this month" resolves through the SEMANTIC LAYER, not raw SQL: no SQL is accepted or generated here BY CONSTRUCTION — the tool compiles the member into ONE governed Trino SELECT over the gold mart and runs it under YOUR delegated Trino identity, so Trino + OPA apply row- and column-level security to the number itself (the same `exploreMetric` path the Metrics explorer and every dashboard panel use). The metric itself is a dbt `metrics:` entry in the owning domain’s dbt project. Two viewers get two different row sets; the number can never drift from the charts. Path: the read half of the Metrics golden path. Before: list_metrics (take a metric `id`, shaped `<datasetId>.<measure>`). After: chart the same member with create_dashboard, or wire it into an agent. Governance: read-only; a metric on a dataset you cannot see → not_found; offline the OS answers with the honestly-labelled offline-mock resolver (mode is always stated).

| Argument | Type | Required | Description |
|---|---|---|---|
| `metricId` | string | yes | The metric id from list_metrics — `<datasetId>.<measure>`, e.g. "ds_ab12cd.revenue". |
| `dimensions` | string[] |  | Gold column names to slice by (become dimension members on the same view). |
| `timeDimension` | string |  | A time column to bucket by (use with granularity). |
| `granularity` | `day` \| `week` \| `month` \| `quarter` \| `year` |  | Time bucket for timeDimension. |
| `limit` | number |  | Max rows (default 100). |

Example arguments:

```json
{"metricId":"ds_ab12cd.revenue"}
```

### `suggest_metrics`

Floor: **creator** · Tab: metrics · External door: toolset `analytics`

Suggest 3–6 high-value candidate metrics grounded in the caller's OPERATING MODEL, business PROCESSES (workflows) and the datasets they can see — the same governed context the Metrics tab "Suggest metrics" button uses. Read-only: proposes candidates, defines nothing. Each candidate carries name/description/why, an optional real processId (workflow) it grounds on, a visible datasetId, a ready-to-define `form` (aggregation + real column + dimensions), and an optional `crossEntity` flag when its inputs span datasets (build a curated/joined dataset in Data first — never an invented join). Candidates whose dataset isn't visible or whose columns aren't real are dropped; `grounding` reports how much OM/process/data context actually informed the suggestions. Runs the reasoning model AS you; audited + cost-capped.

| Argument | Type | Required | Description |
|---|---|---|---|
| `goal` | string |  | Optional free-text goal to steer the suggestions (e.g. "metrics for our checkout funnel"). Omit to propose the metrics this business most needs. |

Example arguments:

```json
{}
```

## Tab: dashboards

<a id="tab-dashboards"></a>

### `create_dashboard`

Floor: **creator** · Tab: dashboards · External door: toolset `analytics`

Create (or replace) a dashboard (also called: report, business intelligence (BI), data visualization) you own — tiles/charts that reference GOVERNED metric members. Runs in YOUR My scope with no approval; this call PERSISTS the spec. Panels render NATIVELY at View time (Apache ECharts over governed Trino SQL) — there is no external BI import step, and every panel re-queries AS THE VIEWER so per-viewer row-level security is enforced live (a best-effort offline-mock only if the lakehouse is unreachable). Same governed path as the Dashboards tab. Sharing it wider is the separate governed promote ladder (owner files request_promotion → a domain admin approves).

| Argument | Type | Required | Description |
|---|---|---|---|
| `id` | string |  | Stable id (to replace an existing one you own); auto-generated if omitted. |
| `name` | string | yes | Dashboard name, e.g. "Sales Overview". |
| `view` | string | yes | The governed view (one gold dataset’s view) the charts bind to. |
| `domain` | string |  | The domain the dashboard belongs to — one of YOUR domains (see whoami). Omit for your home domain (your first domain). Never `platform`. Ignored when replacing by `id`, except that a different domain is refused. |
| `charts` | object[] | yes | At least one chart on a governed metric member. |

Example arguments:

```json
{"name":"Sales Overview","view":"Orders","charts":[{"name":"Total revenue","vizType":"big_number_total","metric":"Orders.revenue"}]}
```

### `get_dashboard`

Floor: **creator** · Tab: dashboards · External door: toolset `analytics`

Read ONE dashboard you can see (also called: report, business intelligence (BI), data visualization) — its charts with their governed metric members, the governed view they bind to, tier and owner. Purpose: read back exactly what create_dashboard saved so you can iterate (create_dashboard with the same `id` replaces it) Before: list_dashboards. After: query_metric on a chart’s member to read the same number. Governance: read-only, the SAME visibility rule as list_dashboards (My · Domain · Company) — an unseeable id is a typed not_found/forbidden (no existence leak).

| Argument | Type | Required | Description |
|---|---|---|---|
| `dashboardId` | string | yes | Dashboard id from list_dashboards. |

Example arguments:

```json
{"dashboardId":"dash_sales_overview_ab12cd"}
```

### `list_dashboards`

Floor: **creator** · Tab: dashboards · External door: core (always listed)

List the dashboards you can see (also called: reports, business intelligence (BI), data visualizations) — My · Domain · Company. Path: DISCOVERY for the Dashboards golden path (guide: sovereign-os://guide/path/dashboards). Before: whoami. After: create_dashboard. Governance: read-only, DLS-scoped.

| Argument | Type | Required | Description |
|---|---|---|---|
| `lifecycle` | `draft` \| `testing` \| `live` |  | OPTIONAL. Show only objects at this point of their life: `draft` (being built), `testing` (a draft being tried out right now) or `live` (the version the OS runs). Omit to see everything, which is the default and what every existing caller gets. This is INDEPENDENT of My · Domain · Company, which says who may use an object rather than which version runs. |

Example arguments:

```json
{}
```

## Tab: agents

<a id="tab-agents"></a>

### `build_agent_system`

Floor: **creator** · Tab: agents · External door: toolset `agents`

Build (execute + verify) an agent system you can edit across the adapters, landing Langfuse traces. Returns ✓/✗ rows. Idempotent — re-run any time. First, every agent with `model: auto` gets its model decided (strong or standard, one short call to the strong model) and stored in system.yaml as `model_resolved` + `model_reason`; the `models` row reports each choice (and a warning when it fell back to strong). The system key then allows exactly the models its agents use.

| Argument | Type | Required | Description |
|---|---|---|---|
| `systemId` | string | yes | System id to build. |

Example arguments:

```json
{"systemId":"sys_ab12cd"}
```

### `commit_agent_files`

Floor: **creator** · Tab: agents · External door: toolset `agents`

Commit one or more whitelisted files into an agent system you can edit (only `system.yaml` and `agents/<id>/AGENT.md` | `agents/<id>/MEMORY.md`). system.yaml is validated on write. Idempotent per identical content. GRANTS (what the team "can use") are authored IN system.yaml under `grants`, grouped exactly like the Agents-builder "What your team can use" surface: CONTEXT grants — `data` · `knowledge` · `metrics` · `connections` (each a list of { id, capability } items, plus `data` items may carry a `layer`) and `files` (folder grants only); and PLAN-ITEM grants — `plan` (the Operating Model, Strategic Pillars and Big Bets an agent may load as read context). CAPABILITIES: the system's Define grants are default-on — every sub-agent INHERITS the FULL set by default; narrow a sub-agent to REDUCE its reach, never to widen it. Per-item ACCESS LEVEL is the `capability`: `Read` (read-only) · `Write-approval` (read + propose — a write is DRAFTED/held for a human) · `Write-bounded` (read + write — this is what gives the agent that resource's write tools). The write GATE is scope-aware: a My (personal) write runs directly run-as-you with no hold; only a Domain/Company write is held for the right admin. A grant may instead target a whole FOLDER — set `folder: { path, scope }` (scope = personal|domain) with an empty `id`; it late-binds to every item currently under that folder at build/run time, each still per-item DLS-checked. Sub-agent grants ⊆ system grants; nothing here can exceed the caller's own entitlements or role. MODEL per agent: `model: strong | standard | auto` — the ONE model that agent runs on (strong = most capable, standard = faster and cheaper; no field = strong). `auto` is decided by build_agent_system, which writes `model_resolved` (strong|standard) and a one-line `model_reason` back into system.yaml; set strong or standard to override. (The interactive labelled selector, category headings and folder-tree picker are the Agents-tab UI over this same schema.)

| Argument | Type | Required | Description |
|---|---|---|---|
| `systemId` | string | yes | Target system id. |
| `files` | object[] |  | Files to write. |
| `path` | string |  | Single-file shortcut (use with `content`). |
| `content` | string |  | Single-file content (use with `path`). |

Example arguments:

```json
{"systemId":"sys_ab12cd","files":[{"path":"agents/analyst/AGENT.md","content":"# Analyst\nYou classify incoming tickets."}]}
```

### `create_agent_system`

Floor: **creator** · Tab: agents · External door: toolset `agents`

Create a new agent system (also called: AI team, assistant team). Always starts My-scope/owner-only — in My scope you have full rights and the system (which runs AS you) needs no approval. Sharing is the governed promote ladder (a domain admin approves the flip to Domain, an Admin certifies to Company). Optionally start from a server-authored template.

| Argument | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | System name, e.g. "Support triage". |
| `domain` | string |  | One of YOUR domains; defaults to your first. |
| `template` | `blank` \| `analyze` \| `evaluate` \| `recommend` |  | Optional starter template. |
| `model` | `strong` \| `standard` \| `auto` |  | Which model the starter agent(s) use: strong (most capable), standard (faster, cheaper) or auto (default: build_agent_system picks one of the two per agent and stores the choice and a one-line reason as model_resolved / model_reason). |

Example arguments:

```json
{"name":"Support triage","domain":"support","template":"analyze"}
```

### `get_agent_run`

Floor: **creator** · Tab: agents · External door: toolset `agents`

READ the state of one agent run by its runId: the agents visited so far, whether it finished, FAILED (`status: "failed"`, `failed: true`, with `failedNode` and `failureReason` — an agent failed and the run stopped there), is PARKED on held writes awaiting approval (with their approvalIds and who can decide), or was interrupted; the budget used; compile warnings; the run’s DECLARED OUTPUTS (`outputs`: per output its `state`, the saved item’s `id`/`link`, a requested Domain `promotion`, or the `reason` it was not saved — read from the run’s own event log, including a later “Try saving again”); AND the tail of the run's event log (node-started / tool-step / node-completed / approval-required / resumed / done / error) — pass `afterSeq` (the `nextSeq` from your last call) to get only what happened since, so following a long run is a cheap poll rather than a re-read. Purpose: follow a run started by run_agent_system (or the UI) through hold → approve → completion over MCP alone. Before: run_agent_system (take its runId). After: decide_approval if parked, resume_agent_run after a restart, get_run_trace(runId) for the Langfuse trace. Governance: only the RUNNER of the run (the user who started it) can read it, and only on their own system; any other runId is a typed not_found — a run id is a capability, not an index.

| Argument | Type | Required | Description |
|---|---|---|---|
| `runId` | string | yes | The run id returned by run_agent_system (run_<uuid>). |
| `afterSeq` | number |  | Return only events with seq > this (the `nextSeq` of your last call). Omit for the whole log. |
| `limit` | number |  | Max events to return (default 50, capped 200). |

Example arguments:

```json
{"runId":"run_1b4e28ba-2fa1-11d2-883f-0016d3cca427"}
```

### `get_agent_system`

Floor: **creator** · Tab: agents · External door: core (always listed)

Read one agent system (also called: AI team, assistant team) you can see — system.yaml, agents, grants, status, and (when the OS commits to git) `git`: the commit this system is AT (sha, author, time) plus the last 10 commits that touched it, read from the domain repository itself rather than from an OS ledger. Path: DISCOVERY for the Agents golden path (guide: sovereign-os://guide/path/agents). Before: list_agent_systems. After: commit_agent_files / build_agent_system. Governance: read-only; unseeable id → not_found.

| Argument | Type | Required | Description |
|---|---|---|---|
| `systemId` | string | yes | System id from list_agent_systems. |

Example arguments:

```json
{"systemId":"sys_ab12cd34"}
```

### `list_agent_systems`

Floor: **creator** · Tab: agents · External door: core (always listed)

List the agent systems you can see (also called: AI teams, assistant teams) — My · Domain · Company. Path: DISCOVERY for the Agents golden path. After: get_agent_system, run_agent_system. Governance: read-only, scoped to your identity — the same visibility rule as the Agents tab.

| Argument | Type | Required | Description |
|---|---|---|---|
| `lifecycle` | `draft` \| `testing` \| `live` |  | OPTIONAL. Show only objects at this point of their life: `draft` (being built), `testing` (a draft being tried out right now) or `live` (the version the OS runs). Omit to see everything, which is the default and what every existing caller gets. This is INDEPENDENT of My · Domain · Company, which says who may use an object rather than which version runs. |

Example arguments:

```json
{}
```

### `resume_agent_run`

Floor: **creator** · Tab: agents · External door: toolset `agents`

RESUME an interrupted agent run (LangGraph engine) from its last checkpoint — restart recovery after a pod restart or a dropped request. NOT for a run parked on an approval: that one resumes by itself when the approval is decided (decide_approval). Governance: only the RUNNER can resume their run (typed not_found otherwise); a finished run is a typed conflict; the resumed run executes AS YOU through the same governed door. Returns the completed report (or the next parked state).

| Argument | Type | Required | Description |
|---|---|---|---|
| `runId` | string | yes | The run id to continue. |

Example arguments:

```json
{"runId":"run_1b4e28ba-2fa1-11d2-883f-0016d3cca427"}
```

### `run_agent_system`

Floor: **creator** · Tab: agents · External door: toolset `agents`

RUN an agent system (a real LangGraph StateGraph over your OS-MCP tool grants) for one turn and return the reply + the per-node governed tool steps — the SAME queue, engine and executor the Agents tab uses. Purpose: close the Agents golden path (build → RUN → approval → resume → trace) over MCP. Before: list_agent_systems / get_agent_system (and build_agent_system for a ✓ build). After: get_agent_run(runId) to follow it, decide_approval if it parks, resume_agent_run after a restart, get_run_trace(runId) for the trace. Returns `runId` (= the LangGraph thread id AND the Langfuse trace id) and `traceUrl`. Governance + recursion, stated honestly: the team’s OWN tool calls dispatch through the SAME governed door as this call (grant-scoped, OPA `os-<systemId>` pre-gated, then handleRpc AS YOU) — so a team can never exceed its declared grants NOR your role; there is no escalation in the loop. You must own the system or be entitled to run it (a domain-Shared system is runnable by in-domain members); a non-runnable id is a typed forbidden. A grant naming a tool with no governed MCP tool behind it is a typed bad_request that names the tool. A run that hits a write needing approval PARKS (`parked: true` + `heldApprovals`) instead of executing it. DECLARED OUTPUTS: when the system declares where its results go, the engine saves them itself as the run finishes and `outputs` lists each one — `state` (`saved` | `not_saved` | `failed` | `pending`), the saved item’s `id` and `link`, `promotion` when the target is a Domain folder (`requested` = waiting for a domain admin), and `reason` when it was not saved; `completedWithUnsavedOutputs: true` means the run finished but an output was not saved. A run in which an agent fails stops there and returns `status: "failed"`, `failed: true`, `failedNode` and `failureReason` — it is not reported as done. Note: the run drives a live LLM; each node takes seconds, and in worker mode it may return `queued: true` with the runId to follow.

| Argument | Type | Required | Description |
|---|---|---|---|
| `systemId` | string | yes | The agent system to run (from list_agent_systems). |
| `message` | string | yes | The user message for this turn. |
| `messages` | object[] |  | Optional multi-turn conversation (overrides `message`); last 20 kept. |

Example arguments:

```json
{"systemId":"sys_ab12cd","message":"Analyze last quarter’s refund workflow and summarize the risks."}
```

## Tab: software

<a id="tab-software"></a>

### `archive`

Floor: **creator** · Tab: software · External door: toolset `software`

ARCHIVE the app: disable it (no preview, no deploy, no serving) while RETAINING its records, spec and lineage — the reversible counterpart to `delete`, which is lineage-blocked and permanent. Use it to retire an app without losing what it collected (ingest its records with the Data tools first if they should become a dataset). Owner or an Admin. Governance: an unseeable app id → not_found; an app you can see but may not archive → forbidden.

| Argument | Type | Required | Description |
|---|---|---|---|
| `appId` | string | yes | Target app id (from list_software). |

Example arguments:

```json
{"appId":"app_ab12cd"}
```

### `build_software`

Floor: **creator** · Tab: software · External door: toolset `software`

STAGE 4 · BUILD APP. Build a SPECIFIC unit — the whole app, one `epic`, or one `story` (pass `target`) — from its FINALIZED Design spec and its ALREADY-GRANTED context. Context (datasets / knowledge / metrics / connections) is bound or created earlier in CHOOSE CONTEXT (design_software `grants` + create_dataset) — build WRITES CODE against that frozen, injected schema; it does NOT discover, list or query data. Enforces the design-before-build gate (refuses stories with no spec, naming them), and returns the governed BUILD directive + Define context + the granted-context schema + the target's spec + the code-structure convention (write each story under src/epics/<epic>/<story>/, src/App.tsx/main.tsx stay thin) + the current committed files and honest built-vs-pending progress. You then author the code and call `commit` — a story counts as BUILT only after its files land in a SUCCESSFUL commit (an empty/failed commit builds nothing), never from a status you set by hand. DATA IS PRESENT ⇒ BUILD IT: when the returned granted-context block carries dataset columns, the data need is ALREADY MET — build against those columns; do NOT refuse or claim the app has no data (the grant IS the authorization, resolved as you). ONLY when the granted-context block is genuinely empty of the dataset a story needs, go back to Choose Context and grant/create it — do not try to discover data from Build, and do not dead-end. VENDORED-API CONTRACT (the returned directive spells it out; breaking it FAILS the compile gate): a page imports ONLY from `react`, `@sovereign-os/ui` and the OS `os` client — NEVER `react-router-dom`/any router or other 3rd-party lib (no client-side router; navigation is the auto-registered section page), and a story page returns its CONTENT (`<Section><Card>…`) and NEVER renders `<AppShell>` (template-only; it requires `nav`) — mirror src/template/pages/Overview.tsx. "DONE" = status:'done' AND committed files, NEVER the spec: asked to build a story that is not done and has no files, BUILD IT — never reply "already implemented / no further build needed" or recite acceptance criteria as proof; `read_app_files` its path if unsure. ROLES: `useIdentity()` returns IdentityState — a DISCRIMINATED UNION with `.phase` ({phase:'loading'}|{phase:'signed-out'}|{phase:'error',message}|{phase:'ready',user}), NO `id` field; never `const { id } = useIdentity()`, never `.id`, never `.user` without narrowing `.phase === 'ready'` first. Copy exactly (mirror src/template/pages/Overview.tsx): `const identity = useIdentity(); const user = identity.phase === 'ready' ? identity.user : null; const canEdit = !!user && roleAtLeast(user.role, 'domain_admin');`. Gate with `roleAtLeast(user.role, '<floor>')` from src/template/roles.ts — NEVER an exact `role === 'admin'` (it hard-blocks a real admin; ladder creator<builder<domain_admin<admin), never invent app roles, and make client checks ADVISORY (hide/disable, not a blocking error — the OS data layer enforces). Next: verify_software.

| Argument | Type | Required | Description |
|---|---|---|---|
| `appId` | string | yes | App id from list_software. |
| `target` | object |  | The unit to act on. Omit for the whole app; pass epicId for an epic; epicId+storyId for one story. |

Example arguments:

```json
{"appId":"app_ab12cd","target":{"kind":"story","epicId":"epic_1","storyId":"story_1"}}
```

### `commit`

Floor: **builder** · Tab: software · External door: toolset `software`

DEVELOPER MODE — writes files DIRECTLY to the app folders, BYPASSING the staged Design→Build→Test governance and the design-before-build gate. Role-gated to builder/admin; a Creator cannot use it. Use the governed stage tools (design_software → build_software → verify_software) for the normal flow; reach for commit only as a deliberate exception.

| Argument | Type | Required | Description |
|---|---|---|---|
| `appId` | string | yes |  |
| `message` | string |  | Commit message. |
| `name` | string |  |  |
| `description` | string |  |  |
| `files` | object[] |  | Files to commit. |

Example arguments:

```json
{"appId":"app_ab12cd","message":"hotfix the list page","files":[{"path":"src/App.tsx","content":"export default () => null;\n"}]}
```

### `create_software`

Floor: **creator** · Tab: software · External door: toolset `software`

STAGE 1 · DEFINE APP. Create a new governed app. DEFAULT `kind: 'spec'` — a DECLARATIVE app: a validated AppSpec of cookbook-pattern tabs over governed data, served SAME-ORIGIN by the OS renderer (NO source tree / registry / pod), authored with set_app_spec or scaffolded in one call with generate_app_spec. This is the golden path. Pass `name`, an optional `domain`, an optional `purpose` (the app's stated intent, ≤2000 chars), and optionally DECLARE its surface (surface: 'ui' | 'api' | 'both') — declaring wins over auto-detection. `kind: 'code'` is the ADVANCED coded path (raw generated code + image build; no git server, no CI) — it is DISABLED by default and only works when a platform admin has enabled coded apps (createApp fails closed with 403 otherwise). The `template` arg (`sovereign-app` default, `website`, `api-service`, `empty`) only shapes a coded app's scaffold. Next: design_software.

| Argument | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | App name. |
| `description` | string |  |  |
| `template` | string |  | Only shapes a CODED app's scaffold (kind:'code'): 'sovereign-app' (Application — OS look, sign-in, admin; the default), 'website' (public site, no sign-in), 'api-service' (APIs only, headless), or 'empty' (blank canvas). Ignored for the default declarative (spec) app. Legacy keys (e.g. 'nextjs-supabase') stay accepted for existing apps. |
| `domain` | string |  | Domain to create in (must be one of yours). |
| `surface` | `ui` \| `api` \| `both` |  | Declare the app's surface — 'ui' (serves a frontend), 'api' (headless / tool surface), or 'both'. Declaring it wins over auto-detection, so a UI app is never mislabelled as API. Omit to let the OS infer it from the code. |
| `purpose` | string |  | The app's stated purpose (Define stage), ≤2000 chars. Optional at creation; update later with set_app_design. |
| `kind` | `spec` \| `code` |  | Serving kind. 'spec' (DEFAULT) creates a DECLARATIVE app served same-origin by the OS renderer — no source tree / registry / pod; author it with set_app_spec or scaffold it with generate_app_spec (the spec IS the app). 'code' is the ADVANCED coded path (raw code + image build) — DISABLED unless a platform admin has enabled coded apps (createApp fails closed with 403 otherwise). |

Example arguments:

```json
{"name":"Order triage","purpose":"Let the sales team triage open orders","surface":"ui"}
```

### `decide_deploy`

Floor: **builder** · Tab: software · External door: toolset `software`

STAGE 5 · TEST & PUBLISH. Approve/deny a deploy (Builder/Admin only — role-gated, requires a passing security scan).

| Argument | Type | Required | Description |
|---|---|---|---|
| `cardId` | string | yes | Deploy review card id. |
| `decision` | `approve` \| `deny` | yes |  |
| `note` | string |  |  |
| `acknowledgeNoScan` | boolean |  | ADMIN ONLY, and only when the card's security scan is `unavailable` (no scanner engine ran). Explicitly approve a deploy that has NO security verdict. Requires `reason`. Refused for a scan that RAN and FAILED — a real finding still blocks. The acknowledgement, the reason and your identity are written to the approval record and the audit log. |
| `reason` | string |  | Mandatory with `acknowledgeNoScan` (at least 20 characters): why this deploy is going ahead without a security verdict. It becomes the permanent audit record. |

Example arguments:

```json
{"cardId":"rev_ab12cd","decision":"approve","note":"Scan green, diff reviewed"}
```

### `delete`

Floor: **creator** · Tab: software · External door: toolset `software`

DELETE the app permanently: tears down its runner and removes its record and source tree. LINEAGE-AWARE: a typed conflict names every app that still depends on it — remove those uses first; to keep its records use `archive` instead. Governance: the owner (a My app is owner-only), or for a Domain/Company app an in-domain domain admin or an admin; an unseeable app id → not_found.

| Argument | Type | Required | Description |
|---|---|---|---|
| `appId` | string | yes | Target app id (from list_software). |

Example arguments:

```json
{"appId":"app_ab12cd"}
```

### `design_software`

Floor: **creator** · Tab: software · External door: toolset `software`

STAGE 2 · DESIGN EPICS (and STAGE 3 · CHOOSE CONTEXT). Author or update the app's specification tree — `purpose`, `epics` (each with user stories and per-story `spec` of features / non-functional requirements / rules), and governed context `grants` (bind existing connections / data / knowledge / files / metrics — this is the Choose Context bind-existing surface). This is the SAME governed write the UI uses (patchAppDesign): owner / owning-domain admin / platform admin only. A story must have a spec AND, if it needs data, a bound/created dataset before build_software will build it (the design-before-build + data-need gates). Next: build_software.

| Argument | Type | Required | Description |
|---|---|---|---|
| `appId` | string | yes | App id from list_software. |
| `purpose` | string |  | The app's stated purpose (Define/Design), ≤2000 chars. |
| `epics` | object[] |  | Design epics. Each groups user stories under technical/UX/governance requirements; each story carries a spec (features/NFRs/rules) and a build status. |
| `grants` | object |  | Governed context grants (capability metadata — never raw credentials). |

Example arguments:

```json
{"appId":"app_ab12cd","epics":[{"id":"epic_1","title":"Ticket triage","stories":[{"id":"story_1","title":"Auto-label","asA":"agent","iWant":"tickets labelled on arrival","soThat":"I triage faster","spec":{"features":["Label on arrival"],"nfrs":["<200ms"],"rules":["No PII in logs"]}}]}]}
```

### `generate_app_spec`

Floor: **creator** · Tab: software · External door: toolset `software`

SCAFFOLD A DECLARATIVE APP from its DESIGN. Reads the app's epics + user stories + per-story spec (features/NFRs/rules) and its GRANTED context (datasets with their REAL columns, metrics, agents), then asks the OS reasoning model to compose a complete, validated AppSpec whose tabs are cookbook patterns wired ONLY to granted ids + real columns. Returns `{ ok: true, spec }` (a validated AppSpec — NOT yet persisted; review it with the returned `spec` / get_app_spec, then author it live with set_app_spec) or `{ ok: false, error, issues? }` when the design is empty (grant/design first) or the model can't produce a valid spec. The failure `issues[]` are the SAME machine-actionable `{ path, reason, fix }` the validator emits — each names the exact fix (grant the missing dataset via design_software / Choose Context, restore a deleted dataset, or use a real column) — so on failure, ACT on the issues and retry, never dead-end; bind an EXISTING granted dataset before assuming a new one must be created. This is the AI-coder scaffold: one call to go from a designed app to a valid spec, without hand-writing tabs. Role: owner or an owning-domain builder+ (same gate as set_app_spec). Next: set_app_spec to publish it live.

| Argument | Type | Required | Description |
|---|---|---|---|
| `appId` | string | yes | App id from list_software (must have designed epics + granted context). |

Example arguments:

```json
{"appId":"app_ab12cd"}
```

### `get_app_spec`

Floor: **creator** · Tab: software · External door: toolset `software`

READ A DECLARATIVE APP for read-modify-write. Returns `{ spec, serveMode, describe }` for one app you can see (same visibility gate as `get_software`): `spec` is the current validated AppSpec or null (null ⇒ not a spec app / no spec yet); `serveMode` is 'spec' | 'image' | 'runtime'; `describe` is the plain-language legibility summary (`describeApp` — name, themed flag, and each tab's kind / what-it-does / data source / role gate). Use it to fetch the live spec, edit tabs/patterns/theme/functions, and write it back with `set_app_spec`. Governance: read-only, unseeable id → not_found.

| Argument | Type | Required | Description |
|---|---|---|---|
| `appId` | string | yes | App id from list_software. |

Example arguments:

```json
{"appId":"app_ab12cd"}
```

### `get_app_template`

Floor: **creator** · Tab: software · External door: toolset `software`

SOFTWARE FACTORY · the golden-path TEMPLATE and its RULES. Without `template` it lists the templates. With `template` (e.g. `nextjs-web`) it returns the template version of record: `rules.agents` (AGENTS.md: language, structure, documentation, unit-test, security, identity/OPA, data-access and secrets rules), `rules.claude`, the Rego policy the gates evaluate, the platform-owned paths you must not edit, the required gates, and every file. To start an app: `create_software` with `template: '<key>'` (kind `code`), then read its tree with `read_app_files` or `git clone` its domain repository, follow AGENTS.md, and use `verify_app_gates` before `request_deploy`. Read-only.

| Argument | Type | Required | Description |
|---|---|---|---|
| `template` | string |  | Template key, e.g. 'nextjs-web'. Omit to list the templates. |

Example arguments:

```json
{"template":"nextjs-web"}
```

### `get_software`

Floor: **creator** · Tab: software · External door: toolset `software`

Read one app you can see (template, consumed resources, lifecycle state, plus `purpose` / `epics` / `grants`). `grants` is capability metadata (kind + access level) — never raw credentials. Path: DISCOVERY for the Software golden path. Before: list_software. After: commit / start_preview / request_deploy / set_app_design. Governance: read-only; unseeable id → not_found.

| Argument | Type | Required | Description |
|---|---|---|---|
| `appId` | string | yes | App id from list_software. |

Example arguments:

```json
{"appId":"app_ab12cd"}
```

### `get_software_status`

Floor: **creator** · Tab: software · External door: toolset `software`

Read ONE app’s HONEST status card: preview state (with a URL only when a runner actually serves one — never fabricated), deploy state (requested / approved / denied, with the reviewer and note), release count and the last governed commit. Purpose: the single read that tells you where an app truly is in create → preview → review → live, so you never act on a claimed-but-not-served URL. Before: list_software / get_software. After: start_preview or request_deploy (or fix and re-commit after a denial). Governance: read-only, the same visibility gate as get_software — an unseeable app is a typed not_found. Honesty rule, enforced: `preview.url` and `deploy.liveUrl` are null unless the workload is actually served; a pending runner or an offline cluster is SAID, not papered over.

| Argument | Type | Required | Description |
|---|---|---|---|
| `appId` | string | yes | App id from list_software. |

Example arguments:

```json
{"appId":"app_ab12cd34"}
```

### `list_software`

Floor: **creator** · Tab: software · External door: core (always listed)

List the apps you can see (My · Domain · Company). Each app includes `purpose` (Define stage intent), `epics` (Design epics + stories), and `grants` (capability metadata — kind/level only, never raw credentials). Path: DISCOVERY for the Software golden path (guide: sovereign-os://guide/path/software). Before: whoami. After: get_software, or create_software only if nothing fits. Governance: read-only, same visibility rule as the Software tab.

| Argument | Type | Required | Description |
|---|---|---|---|
| `lifecycle` | `draft` \| `testing` \| `live` |  | OPTIONAL. Show only objects at this point of their life: `draft` (being built), `testing` (a draft being tried out right now) or `live` (the version the OS runs). Omit to see everything, which is the default and what every existing caller gets. This is INDEPENDENT of My · Domain · Company, which says who may use an object rather than which version runs. |

Example arguments:

```json
{}
```

### `promote`

Floor: **builder** · Tab: software · External door: toolset `software`

STAGE 5 · TEST & PUBLISH. Promote the app one tier (role-gated, same as UI).

| Argument | Type | Required | Description |
|---|---|---|---|
| `appId` | string | yes | Target app id (from list_software). |

Example arguments:

```json
{"appId":"app_ab12cd"}
```

### `push_app_files`

Floor: **creator** · Tab: software · External door: toolset `software`

PUSH FILES to an app's source tree — the ONE documented verb for "code in Claude, deploy to the OS". Writes `files` into `apps/<slug>/` of the app's DOMAIN GIT REPOSITORY through the same governed commit path the UI uses, authored as YOU, with the OS-Action / OS-Object / OS-Surface / OS-Request-Id trailers. Returns `{ commit, changed, gate, previewUrl }`: `commit` is the real sha (null + a reason when the domain repository is off or the app has no domain), `changed` is FALSE when the bytes are identical — pushing the same files twice yields ONE commit, never two — and `gate` is the compile gate's verdict. THE GATE RUNS BEFORE THE WRITE: a red gate is a 422 carrying the diagnostics and NOTHING is committed, so fix them and push again in the same turn. A push is a CHANGESET merged over the app's current tree, so a partial push never makes the untouched files disappear. Declared agent-callable actions in `actions.yml` are parsed on every push and any malformed entry comes back in `actionIssues` rather than being silently dropped. Role: owner or an owning-domain admin (the same gate as design_software). Before: list_software / read_app_files. After: start_preview, request_deploy.

| Argument | Type | Required | Description |
|---|---|---|---|
| `appId` | string | yes | App id from list_software. |
| `files` | object[] | yes | The files to push, as a CHANGESET merged over the app's current tree (so a partial push never makes the untouched files disappear). Paths are relative to the app root and must not escape it. |
| `message` | string |  | Why you are pushing — it becomes part of the commit subject. |

Example arguments:

```json
{"appId":"app_ab12cd34","files":[{"path":"src/App.tsx","content":"export default () => null;\n"}],"message":"add the list page"}
```

### `read_app_files`

Floor: **creator** · Tab: software · External door: toolset `software`

Read an app’s FILE TREE — or, when `path` is given, one FILE’s content (kind "file") OR a DIRECTORY’s immediate entries (kind "dir"). The read-back counterpart of `commit`: what you committed is what you read. Purpose: iterate on the real code instead of re-guessing it. Before: list_software / get_software (you must be able to SEE the app — the same gate). After: commit changed files, start_preview, get_software_status. Governance: read-only under YOUR identity; an unseeable app is a typed not_found (no existence leak). Honesty: returns the tree as it was COMMITTED through the governed commit door (the app’s source lives in the domain git repository under `apps/<slug>/`, mirrored to a read cache), or the template seed for a fresh app — labelled `source` so you always know which. There is no external git forge, no CI runner and no image registry in the OS. Large files come in pages of ~24k characters: `contentNote` and `nextOffset` say how to read the next one.

| Argument | Type | Required | Description |
|---|---|---|---|
| `appId` | string | yes | App id from list_software. |
| `path` | string |  | Optional. A FILE path returns its content; a DIRECTORY path returns its entries (drill down); omit it for the whole tree. |
| `offset` | number |  | Optional. Character offset to start reading at (from a previous answer's `nextOffset`). Omit for the start. |

Example arguments:

```json
{"appId":"app_ab12cd34"}
```

### `request_deploy`

Floor: **creator** · Tab: software · External door: toolset `software`

STAGE 5 · TEST & PUBLISH (publish half). Request a domain deploy → opens the Builder review gate (security scan + envelope + diff). Cannot self-approve a go-live.

| Argument | Type | Required | Description |
|---|---|---|---|
| `appId` | string | yes | Target app id (from list_software). |

Example arguments:

```json
{"appId":"app_ab12cd"}
```

### `set_app_design`

Floor: **creator** · Tab: software · External door: toolset `software`

Set or update the app's Define/Design fields: `purpose` (stated intent, ≤2000 chars), `epics` (Design epics + user stories), and `grants` (governed context grants — Connections · Data · Knowledge · Files · Metrics at read-only | read-propose | read-write). Each field is optional; unset fields are untouched. Governance: owner, owning-domain admin, or platform admin only — same edit scope as the UI PATCH (`patchAppDesign`). Grants are capability metadata (id + access level), never raw credentials. Before: list_software / get_software (need the appId). After: get_software to read the updated design back.

| Argument | Type | Required | Description |
|---|---|---|---|
| `appId` | string | yes | App id from list_software. |
| `purpose` | string |  | The app's stated purpose (Define stage), ≤2000 chars. |
| `epics` | object[] |  | Design epics. Each groups user stories under technical/UX/governance requirements. |
| `grants` | object |  | Governed context grants: which OS artifacts this app may access and at what level. Each kind maps to { id, access } entries. Grants are capability metadata — never raw credentials. |

Example arguments:

```json
{"appId":"app_ab12cd","purpose":"Track and resolve customer support tickets in real time."}
```

### `set_app_spec`

Floor: **creator** · Tab: software · External door: toolset `software`

AUTHOR A DECLARATIVE APP (author = PUBLISH — this writes the LIVE spec and snapshots a version). Set the app's validated AppSpec — the spec IS the app, served SAME-ORIGIN by the trusted OS renderer under the viewer's session (NO image / CI / registry / pod). An AppSpec is `{ version: 2, name, description, theme?, functions?, tabs: [] }`. `theme` is an app-wide `{ css }` (scoped under the app root; may not contain `<`/`>`). `functions` are governed query/expression DSL functions (aggregate or expression over granted data) a `kpi-overview` card can render by `functionId`. Each TAB is `{ id, label, body }`, and its `body` is EITHER a cookbook PATTERN (`{ kind: 'pattern', pattern, config }`) OR a sandboxed CUSTOM block (`{ kind: 'custom', html, css?, js?, data? }` — a null-origin iframe that can never act as the user). Implemented patterns — VIEW (read): `records-table` (A searchable, filterable, sortable, paged table over a dataset), `master-detail` (A list on the left, the selected record’s detail on the right), `detail` (Pick one record and read its fields as a label/value sheet), `status-board` (Records grouped into columns by a status field, shown as tiles), `kpi-overview` (A grid of headline metric cards), `chart-explorer` (A governed metric charted by dimension and time), `card-gallery` (Records as a responsive gallery of cards), `timeline` (Records ordered along a time axis, newest first), `calendar` (Records placed on a month calendar by their date), `landing` (A composed home page of prose, KPIs and a featured table); INTERACTIVE (write via the governed `os.records` door + role gates, never arbitrary code): `form` (A single-screen form that writes one governed record), `intake-wizard` (A multi-step form that collects fields and writes one governed record), `editable-grid` (An inline-editable table that writes governed records), `kanban-workflow` (A status board whose tiles can be moved between columns (writes the status)), `approval-queue` (List pending items and approve or reject each, appending a governed decision), `assignment` (Pick an item and an assignee, then append a governed assignment record), `task-checklist` (A checklist whose completions are appended as governed records), `action-detail` (A record detail with governed actions attached). A data-backed pattern's `config.source.datasetId` MUST be a dataset GRANTED to the app (bind it first via Choose Context / `design_software` grants) and every referenced column (`columns[].field`, `keyField`, `statusField`, `dateField`, filter fields, …) MUST exist in that dataset's real schema — call `get_dataset` to discover the exact column names. VALIDATION runs author-time and is the gate: on any BLOCKING issue the tool returns `{ ok: false, issues: [{ path, reason, fix }] }` and PERSISTS NOTHING (each fix is machine-actionable — grant the source, restore the dataset, or use a real column). On success it persists the spec as the LIVE served surface (serveMode flips to 'spec') AND snapshots a version, and returns `{ ok: true, servedUrl: '/apps/<slug>', version, warnings }` — the app is live at servedUrl with no build latency. Role: owner or an owning-domain builder+ (same gate as design_software). Scaffold a whole app in one call with generate_app_spec first; read-modify-write with get_app_spec.

| Argument | Type | Required | Description |
|---|---|---|---|
| `appId` | string | yes | App id from list_software. |
| `spec` | object | yes | The declarative AppSpec: { version: 2, name, description, theme?, functions?, tabs: [] }. Each tab is { id, label, body } where body is a cookbook PATTERN ({ kind:'pattern', pattern, config }) or a sandboxed CUSTOM block ({ kind:'custom', html, css?, js?, data? }). View-pattern sources must be a GRANTED dataset with REAL columns (get_dataset to discover). Validated author-time; blocking issues return { path, reason, fix } and persist nothing. |

Example arguments:

```json
{"appId":"app_ab12cd","spec":{"version":2,"name":"Order triage","description":"Triage and view orders","tabs":[{"id":"tab_orders","label":"Orders","body":{"kind":"pattern","pattern":"records-table","config":{"source":{"datasetId":"ds_ab12cd"},"columns":[{"field":"order_id"},{"field":"net_amount"}]}}}]}}
```

### `start_preview`

Floor: **creator** · Tab: software · External door: toolset `software`

Start the app's PRIVATE preview, with no review and no promotion. WHAT THIS ACTUALLY GIVES YOU DEPENDS ON THE APP'S KIND, stated honestly. A DECLARATIVE app (`serveMode:'spec'`, the default) is already served SAME-ORIGIN by the OS at `/apps/<slug>` under the viewer's own session, gated by the app's visibility — so this returns that URL and provisions nothing; with no spec yet it says so and names `set_app_spec`/`generate_app_spec`. A CODED app is deployed from its OWN committed `k8s/` manifests (apps/<slug>/k8s/), whose image must be on the platform registry and pinned by digest: THE OS BUILDS NO IMAGES (the app's Dockerfile is built by its CI workflow or any OCI builder) and generates no Kubernetes objects, so where the manifests are missing, the image is not built yet, or the Kubernetes API is unreachable, NOTHING is provisioned, `previewUrl` stays null and `runnerNote` says which of the two it was — a placeholder container is never substituted and a URL is never fabricated. Role: the owner, or a Builder in the app's domain. Governance: an unseeable app id → not_found; an app you can see but may not preview → forbidden. Next: `get_software_status` reports the preview URL and readiness.

| Argument | Type | Required | Description |
|---|---|---|---|
| `appId` | string | yes | Target app id (from list_software). |

Example arguments:

```json
{"appId":"app_ab12cd"}
```

### `use_as_data`

Floor: **creator** · Tab: software · External door: toolset `software`

MARK the app as used as Data: sets the app’s `usedAsData` flag (shown by get_software and on the app’s Software page) and nothing else. No rows are copied and no dataset or dataset version is created — the data artifact registered with the app at creation (`dataArtifactId`) is left as it is. To turn the app’s records into a governed dataset, ingest them with the Data tools (`create_dataset` / `ingest_dataset`). Owner-only (not a domain colleague). Governance: an unseeable app id → not_found; an app you can see but do not own → forbidden.

| Argument | Type | Required | Description |
|---|---|---|---|
| `appId` | string | yes | Target app id (from list_software). |

Example arguments:

```json
{"appId":"app_ab12cd"}
```

### `use_connection`

Floor: **creator** · Tab: software · External door: toolset `software`

GRANT the app a Connection it may consume, BY REFERENCE — the app receives the connection id, never raw credentials (the OS resolves the secret at call time, as the acting user). `ref` is the connection id from `list_connections`. The app must be yours (or you a Builder+ who can see it); the ref is recorded, not checked for visibility here, and is resolved as the acting user when used — so name a connection you can see. Idempotent: re-granting the same ref changes nothing. Governance: an app id you cannot see → not_found; an app you may see but not grant for → forbidden. Next: `get_software` shows the app’s `grants.connections`.

| Argument | Type | Required | Description |
|---|---|---|---|
| `appId` | string | yes | App consuming the resource (from list_software). |
| `ref` | string | yes | The connection id (from list_connections). A reference, never a raw credential. |
| `label` | string |  | Human label for the consumed resource (defaults to ref). |
| `scope` | `read` \| `write-bounded` |  | Consumption scope (default 'read'). |

Example arguments:

```json
{"appId":"app_ab12cd","ref":"conn_ab12cd","label":"CRM"}
```

### `use_data`

Floor: **creator** · Tab: software · External door: toolset `software`

GRANT the app a Data product it may read, BY REFERENCE — the app receives the dataset id and reads through the governed path under the acting user’s row-level scope, never a warehouse credential. `ref` is the dataset id from `list_datasets` (a built, governed GOLD/asset version is what an app should consume). The app must be yours (or you a Builder+ who can see it); reads resolve as the viewer, so a dataset they cannot see returns nothing. Idempotent. Governance: an unseeable app id → not_found; an app you may see but not grant for → forbidden. Next: `get_software` shows `grants.data`.

| Argument | Type | Required | Description |
|---|---|---|---|
| `appId` | string | yes | App consuming the resource (from list_software). |
| `ref` | string | yes | The dataset id (from list_datasets). A reference, never a raw credential. |
| `label` | string |  | Human label for the consumed resource (defaults to ref). |
| `scope` | `read` \| `write-bounded` |  | Consumption scope (default 'read'). |

Example arguments:

```json
{"appId":"app_ab12cd","ref":"ds_ab12cd","label":"Orders"}
```

### `use_knowledge`

Floor: **creator** · Tab: software · External door: toolset `software`

GRANT the app a Workflow or a Knowledge note it may consume, BY REFERENCE — the app receives the id and retrieves through the governed index, never a raw store credential. `ref` is a workflow id (`wf_…`, from `list_workflows`) or a knowledge-note id (`pk_…`, from `list_knowledge`); Domain/Company items are what an app should consume. The app must be yours (or you a Builder+ who can see it). Idempotent. Governance: an unseeable app id → not_found; an app you may see but not grant for → forbidden. Next: `get_software` shows `grants.knowledge`.

| Argument | Type | Required | Description |
|---|---|---|---|
| `appId` | string | yes | App consuming the resource (from list_software). |
| `ref` | string | yes | A workflow id (wf_…, from list_workflows) or a knowledge-note id (pk_…, from list_knowledge). A reference, never a raw credential. |
| `label` | string |  | Human label for the consumed resource (defaults to ref). |
| `scope` | `read` \| `write-bounded` |  | Consumption scope (default 'read'). |

Example arguments:

```json
{"appId":"app_ab12cd","ref":"wf_ab12cd","label":"Refund process"}
```

### `verify_app_gates`

Floor: **creator** · Tab: software · External door: toolset `software`

SOFTWARE FACTORY · run the app's quality checks (type check, lint, unit tests, build, policy rules via OPA, and a Trivy source scan) as a Tekton PipelineRun on its COMMITTED head and return the verdict per check - the same run (one per commit; a push starts it too) and the same verdict `request_deploy` applies, so a green result here means the deploy request will not be blocked on checks. A check that fails, is unavailable, or is missing blocks; an engine that cannot run blocks with its reason. The call waits for the run up to a limit; a longer run returns `status: running` with its `runRef` - call again to read it. Push your changes first (`push_app_files` or git); uncommitted local files are not tested. Owner or an owning-domain builder. For every app served as a container; judged by the PLATFORM's gate script and policy, not the copies in your tree. A GOVERNED ACTION (it starts a CI run, so it needs the present user's confirmation) with a per-user ceiling.

| Argument | Type | Required | Description |
|---|---|---|---|
| `appId` | string | yes | Target app id (from list_software). |

Example arguments:

```json
{"appId":"app_ab12cd"}
```

### `verify_software`

Floor: **creator** · Tab: software · External door: toolset `software`

STAGE 5 · TEST & PUBLISH (test half). Verify a built unit against its Design spec across the FIVE dimensions (Functionality · User Experience · Code Structure · Security · Documentation). Returns the governed TEST directive + spec + committed files to verify against (read-only). Report PASS/FAIL per dimension; pass any shortfalls as `findings` (each { storyId, note, dimension }) and they are normalized into dimension-tagged REFINEMENTS via the SAME refinement model the UI uses — a missed-spec item is a rebuild, a requirement change routes to Design first. Next (if PASS): request_deploy.

| Argument | Type | Required | Description |
|---|---|---|---|
| `appId` | string | yes | App id from list_software. |
| `target` | object |  | The unit to act on. Omit for the whole app; pass epicId for an epic; epicId+storyId for one story. |
| `findings` | object[] |  | Shortfalls found while verifying. Each is normalized into a dimension-tagged refinement. |

Example arguments:

```json
{"appId":"app_ab12cd","target":{"kind":"story","epicId":"epic_1","storyId":"story_1"},"findings":[{"storyId":"story_1","note":"Empty state missing","dimension":"ux"}]}
```

## Tab: connections

<a id="tab-connections"></a>

### `adopt_entity_actions`

Floor: **domain_admin** · Tab: connections · External door: toolset `connections`

ADOPT an operational exposure's ENTITY ACTIONS into your domain (⛔ domain_admin — the action-adoption gate) so your domain's agents can be granted them. The exposure is RE-RESOLVED server-side (active, shared with one of your domains) and the connection's DOMAIN + id are taken from it — never trusted from the args. This is a thin delegate over the SAME `adoptActions` lib the Adopt panel runs: it supersedes any prior adoption for this exposure+domain and audit-traces `entity_actions_adopted`. Read/search become callable immediately; create/update additionally require the exposure's admin `exposure_action_enable` approval to have cleared. Adopting nothing is a no-op error. Before: list_adoptable_actions. After: ⛔ Builder+ grants the connection's action tools to an agent. Governance: domain_admin re-gated in-lib; the four-layer intersection re-checks every call, so a later revoke narrows immediately.

| Argument | Type | Required | Description |
|---|---|---|---|
| `exposureId` | string | yes | Exposure id from list_adoptable_actions. |
| `entities` | string[] | yes | Entity/object names (lowercased) whose actions to adopt — each must be one the exposure grants actions for. |

Example arguments:

```json
{"exposureId":"exp_ab12cd","entities":["account","opportunity"]}
```

### `classify_catalog`

Floor: **admin** · Tab: connections · External door: toolset `connections`

ORGANIZE a warehouse catalog with AI (admin only) — run the names-first classifier (capped column-enriched second pass) to place every snapshot table into the CURRENT taxonomy. It NEVER invents folders; a table it cannot place (or below the confidence floor) lands in Unsorted with a plain reason; human moves (overrides) are never touched. `mode:"run"` reclassifies all; `mode:"run-new"` only tables with no entry yet. This is the SAME action the Organize stage's "Organize with AI" button runs — a taxonomy seed must already be chosen (else an honest error). Returns the honest run tally + `lastRunDetail` ("132 classified, 12 unsorted, 3 batches escalated, …") + the resulting category counts — never a fabricated tally. Governance: admin re-gated in-lib; `catalog_classified` trace.

| Argument | Type | Required | Description |
|---|---|---|---|
| `connId` | string | yes | Warehouse connection id you can see. |
| `mode` | `run` \| `run-new` |  | 'run' reclassifies all snapshot tables; 'run-new' only tables with no AI entry yet (default run). |

Example arguments:

```json
{"connId":"conn_ab12cd"}
```

### `configure_connection`

Floor: **creator** · Tab: connections · External door: toolset `connections`

Configure a connection you can edit: `rename` (DISPLAY name only — the frozen physical identity is untouched), `move` (into a folder), `demote` (lower one tier: Certified→Shared→Personal — Builder+), or `capabilities` (set per-tool modes Off|Read|Write-approval|Write-bounded|Blocked + limits, recompiled into OPA — Builder+). The MCP peer of the connection detail controls. Before: get_connection. Governance: edit-scoped in-lib; demote/capabilities require a Builder/Admin.

| Argument | Type | Required | Description |
|---|---|---|---|
| `connId` | string | yes | Connection id from list_connections. |
| `action` | `rename` \| `move` \| `demote` \| `capabilities` | yes | Which configuration to apply. |
| `name` | string |  | For action="rename": the new display name. |
| `folder` | string |  | For action="move": the target folder path (empty = root). |
| `capabilities` | object[] |  | For action="capabilities": per-tool mode/limit updates. |

Example arguments:

```json
{"connId":"conn_ab12cd","action":"rename","name":"CRM (prod)"}
```

### `create_connection`

Floor: **creator** · Tab: connections · External door: toolset `connections`

Create a PERSONAL connection (also called: integration, data source, Google, Microsoft, AWS, Snowflake, Databricks) via per-user OAuth. UNDER CONSTRUCTION (PREVIEW): connectors are not yet end-to-end tested — creating one is fine for exploration, but warn the user it may not work reliably yet and should not be relied on in production. Path: step 2 of the Connections golden path. Before: list_connections (reuse first). After: test_connection, then Builder promote_connection to share. Governance: any user may connect a personal account; SHARED (service-credential) templates require a Builder/Admin (the lib re-gates). The credential is stored server-side—the model never sees it.

| Argument | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Human name for the connection. |
| `template` | `gdrive` \| `onedrive` \| `notion-mcp` \| `salesforce-api` \| `kajabi-api` \| `sap-odata` \| `odata-v4` \| `workday-raas` \| `generic-mcp` \| `generic-api` \| `database` \| `warehouse` \| `airflow` \| `github` \| `supabase` \| `atlassian` \| `slack` \| `gmail` \| `gcal` \| `outlook` \| `teams` \| `entra` \| `purview` \| `ai-foundry` \| `sagemaker` \| `gcp-identity` \| `gcp-directory` \| `snowflake-governance` | yes | Connection template (adapter family). |
| `endpoint` | string |  | Endpoint/URL (defaults to the template hint). |
| `credential` | string |  | Secret/token — stored server-side, fingerprinted, never returned. |
| `domain` | string |  | One of YOUR domains; defaults to your first. |
| `warehouse` | object |  | For template="warehouse" ONLY (external connectors must be enabled): the federation config. Secret-keyed fields go to Secrets Manager, the rest onto the record. |
| `airflow` | object |  | For template="airflow" ONLY: the non-secret REST config. The endpoint is the Airflow base URL; credential is the Bearer token (or the Basic-auth password). |
| `atlassian` | object |  | For template="atlassian" ONLY: the non-secret auth config. credential is the API token (Basic) or OAuth access token (Bearer). Basic auth REQUIRES the account email or the connection cannot authenticate. |
| `odata` | object |  | For template="sap-odata" or "odata-v4" ONLY: the non-secret auth config. credential is user:password (Basic) or client_id:client_secret (OAuth-CC). |
| `workday` | object |  | For template="workday-raas" ONLY: the RaaS report catalog. Each report IS an entity — a Workday connection has NO data until at least one report is registered here. |

Example arguments:

```json
{"name":"Ops MCP","template":"generic-mcp","endpoint":"https://mcp.example.com/sse","credential":"secret_xxx"}
```

### `create_exposure_set`

Floor: **admin** · Tab: connections · External door: toolset `connections`

CREATE an exposure set (admin only) — grant the listed tables of a warehouse connection to one or more domains, live-federated or as a scheduled synced copy, at silver|gold. On success it COMPILES STRAIGHT TO OPA: each table becomes a `data.governance.tables` entry shared with those domains, so the live external catalog opens to exactly them and stays fail-closed for everyone else. This is the SAME governed path the Expose panel's Create button runs. Before: get_catalog_snapshot (real tables) + real domain ids. After: a domain admin runs adopt_exposed_table. Governance: admin re-gated in-lib; every table must exist in the snapshot; audit-traced. Response carries the OPA push result (honest — deferred if OPA is unreachable).

| Argument | Type | Required | Description |
|---|---|---|---|
| `connId` | string | yes | Warehouse connection id from list_connections. |
| `name` | string | yes | A short name for the exposure set. |
| `domains` | string[] | yes | Domain ids that may read the listed tables. |
| `mode` | `live` \| `sync` |  | 'live' federates every read (default); 'sync' lands a scheduled copy. |
| `tier` | `silver` \| `gold` |  | Curation tier the tables are declared at (default silver). |
| `tables` | object[] | yes | Tables to expose, each `{schema, table}` (or a "schema.table" string). They must exist in this connection's catalog snapshot. |
| `actions` | object |  | OPERATIONAL sources only (Salesforce, …): optional per-entity agent-action grant, keyed by the entity/object name (lowercased), each with read/search/create/update booleans. Absent = data-only (the safe default). read/search activate immediately; create/update enqueue an admin `exposure_action_enable` approval (they compile only once approved). Ignored for warehouse exposures and when the operational-actions flag is off. |
| `note` | string |  | Optional note stored on the set. |

Example arguments:

```json
{"connId":"conn_ab12cd","name":"Sales → Commerce","domains":["commerce"],"mode":"live","tier":"gold","tables":[{"schema":"sales","table":"orders"}]}
```

### `get_catalog_classification`

Floor: **creator** · Tab: connections · External door: toolset `connections`

READ the AI folder organization of a warehouse connection's catalog you can see — the taxonomy (folders), the merged per-table placement (a human move ?? the AI suggestion ?? Unsorted), the category counts, the last-run detail, and (when unseeded) the smart-default seed the chooser would pre-select. Honest: a table with no AI entry and no human move resolves to Unsorted; every placement is "suggested, not verified". Before: get_catalog_snapshot. After: classify_catalog (admin) to (re)run, or create_exposure_set by folder. Governance: read-only; an unseeable connection → not_found.

| Argument | Type | Required | Description |
|---|---|---|---|
| `connId` | string | yes | Warehouse connection id from list_connections. |

Example arguments:

```json
{"connId":"conn_ab12cd"}
```

### `get_catalog_snapshot`

Floor: **creator** · Tab: connections · External door: toolset `connections`

READ the cached catalog snapshot of a warehouse connection you can see — the schema.table listing built from governed SHOW SCHEMAS/SHOW TABLES, with `takenAt` (freshness is always "snapshot from <takenAt>", never fabricated), `status` (live|stale|unreachable), and `prevDiff` (drift: tables added/removed since the previous snapshot). Returns `{snapshot:null}` when none has been taken — call refresh_connection_catalog first. Before: register + test the warehouse catalog. After: create_exposure_set with real tables, or classify_catalog to organize them. Governance: read-only; an unseeable connection → not_found; never invents tables.

| Argument | Type | Required | Description |
|---|---|---|---|
| `connId` | string | yes | Warehouse connection id from list_connections. |

Example arguments:

```json
{"connId":"conn_ab12cd"}
```

### `get_connection`

Floor: **creator** · Tab: connections · External door: toolset `connections`

Read one connection (also called: integration, data source, Google, Microsoft, AWS, Snowflake, Databricks) you can see — template, endpoint, tier, sync state — NEVER the raw credential. Path: DISCOVERY for the Connections golden path. Before: list_connections. After: test_connection, or consume it from an app via use_connection BY REFERENCE. Governance: read-only; unseeable id → not_found.

| Argument | Type | Required | Description |
|---|---|---|---|
| `connId` | string | yes | Connection id from list_connections. |

Example arguments:

```json
{"connId":"conn_ab12cd"}
```

### `list_adoptable_actions`

Floor: **domain_admin** · Tab: connections · External door: toolset `connections`

List the OPERATIONAL exposures shared with YOUR domain(s) that carry AGENT ACTIONS you may adopt — grouped connection → exposure, with each entity's granted actions (read/search/create/update) and whether the exposure's write actions are admin-approved yet. Adoption is the CONSENT step: an exposure never silently arms your domain's agents; a `domain_admin` must adopt the entities first (the third of the four fail-closed layers: capability ∩ exposure ∩ ADOPTION ∩ grant). Before: this. After: ⛔ domain_admin adopt_entity_actions. Governance: read-only, scoped to your domains; only exposures that actually carry actions appear (data-only exposures are omitted).

No arguments.

Example arguments:

```json
{}
```

### `list_connection_templates`

Floor: **creator** · Tab: connections · External door: toolset `connections`

UNDER CONSTRUCTION (PREVIEW): every connector in this catalog is a preview that has NOT been end-to-end tested yet — configure and explore them, but do not rely on any connector in production until it is verified. Tell the user this plainly before you connect one. List what CAN be connected — the connection template catalog (also called: integration, data source, Google, Microsoft, AWS, Snowflake, Databricks): each template’s key, label, what it connects (Drive / Database / API / MCP / SaaS), whether it is PERSONAL (per-user OAuth — any user may connect their own account) or SHARED (service credentials — creating it needs a Builder/Admin), the endpoint hint, the fields create_connection needs, and the safe preset capability profile (reads on · writes opt-in · deletes blocked). Purpose: step 0 of the Connections golden path — know the catalog before you connect. Before: whoami. After: list_connections (reuse first!), then create_connection with a template key from here. Governance: read-only and identical for every role; this reads the SAME template registry create_connection validates against, so a key listed here is always accepted there (one source of truth).

No arguments.

Example arguments:

```json
{}
```

### `list_connections`

Floor: **creator** · Tab: connections · External door: core (always listed)

List the connections you can see (also called: integration, data source, Google, Microsoft, AWS, Snowflake, Databricks) — personal + shared. Path: step 1 (reuse!) of the Connections golden path (guide: sovereign-os://guide/path/connections). Before: whoami. After: get_connection, or create_connection only if nothing fits. Governance: read-only, DLS-scoped — you never see another user’s personal connection.

| Argument | Type | Required | Description |
|---|---|---|---|
| `lifecycle` | `draft` \| `testing` \| `live` |  | OPTIONAL. Show only objects at this point of their life: `draft` (being built), `testing` (a draft being tried out right now) or `live` (the version the OS runs). Omit to see everything, which is the default and what every existing caller gets. This is INDEPENDENT of My · Domain · Company, which says who may use an object rather than which version runs. |

Example arguments:

```json
{}
```

### `list_exposure_sets`

Floor: **creator** · Tab: connections · External door: toolset `connections`

List the exposure sets on a warehouse connection you can see — each says "these tables are readable by these domains" (name, domains, mode live|sync, tier silver|gold, table count, revoked?). An exposure is the SECURITY gate that opens a live external catalog to exactly its domains (unexposed external tables read zero rows for everyone). Before: list_connections → get_catalog_snapshot to see what CAN be exposed. After: create_exposure_set / update_exposure_set / revoke_exposure_set (admin). Governance: read-only; an unseeable connection → not_found.

| Argument | Type | Required | Description |
|---|---|---|---|
| `connId` | string | yes | Warehouse connection id from list_connections. |

Example arguments:

```json
{"connId":"conn_ab12cd"}
```

### `promote_connection`

Floor: **domain_admin** · Tab: connections · External door: toolset `connections`

Promote a Personal connection → a SHARED domain data source (Domain admin+ only — the creator/builder lockdown). Path: step 4 of the Connections golden path. Before: create_connection + test_connection. After: apps in the domain consume it via use_connection BY REFERENCE. Governance: Domain admin/Admin; re-promoting an already-shared connection returns a conflict.

| Argument | Type | Required | Description |
|---|---|---|---|
| `connId` | string | yes | Personal connection id you own to promote. |

Example arguments:

```json
{"connId":"conn_ab12cd"}
```

### `refresh_connection_catalog`

Floor: **admin** · Tab: connections · External door: toolset `connections`

REFRESH a warehouse connection's catalog snapshot (admin only) — re-run governed SHOW SCHEMAS/SHOW TABLES AS the connection's domain and cache the new listing, computing the drift diff against the previous snapshot. This is the SAME action the Expose panel's Refresh button runs. Before: the catalog must be registered + queryable (else `status:"unreachable"` with the real reason — never a fabricated listing). After: get_catalog_snapshot / classify_catalog / create_exposure_set. Governance: admin re-gated (a catalog re-probe is a Company-tier act).

| Argument | Type | Required | Description |
|---|---|---|---|
| `connId` | string | yes | Warehouse connection id you can see. |

Example arguments:

```json
{"connId":"conn_ab12cd"}
```

### `retire_connection`

Floor: **creator** · Tab: connections · External door: toolset `connections`

Retire a connection you can edit — `archive` (reversible soft-hide; secret + token KEPT so it reconnects with no re-auth) or `delete` (PHYSICAL: revoke its exposures + action adoptions, remove any live Trino catalog, purge the vault secret — irreversible). The MCP peer of the Connections archive/delete controls. Before: list_connections. Governance: edit-scoped in-lib (owner or the owning-domain admin); a delete returns the honest physical-teardown report.

| Argument | Type | Required | Description |
|---|---|---|---|
| `connId` | string | yes | Connection id from list_connections. |
| `mode` | `archive` \| `unarchive` \| `delete` |  | archive (default) \| unarchive \| delete. |

Example arguments:

```json
{"connId":"conn_ab12cd","mode":"archive"}
```

### `revoke_action_adoption`

Floor: **domain_admin** · Tab: connections · External door: toolset `connections`

Revoke a domain’s adoption of an exposed operational entity’s WRITE actions (⛔ domain_admin of the adoption’s domain). After this the domain can no longer arm those actions and the action intersection re-keys. The MCP peer of the expose panel’s revoke control. Governance: re-gated in-lib to a domain admin of the adoption’s domain (or Admin).

| Argument | Type | Required | Description |
|---|---|---|---|
| `adoptionId` | string | yes | The action-adoption id to revoke. |

Example arguments:

```json
{"adoptionId":"adopt_ab12cd"}
```

### `revoke_exposure_set`

Floor: **admin** · Tab: connections · External door: toolset `connections`

REVOKE an exposure set (admin only) — withdraw its tables from OPA so live reads drop to ZERO ROWS on the next recompile (the fail-closed floor takes over). REVOCATION PROPAGATES honestly, exactly as the Expose panel's Revoke button does (shared `revokeExposureAndPropagate`): every dataset adopted from this exposure is frozen (`connected.status="source-revoked"`), its sync CronJob torn down, its owner notified, and a `dataset_source_revoked` trace written per dataset — never silent. A synced copy keeps its last-landed data; a live one shows the banner. Before: list_exposure_sets. Governance: admin re-gated in-lib. Response reports the OPA push + how many datasets were frozen.

| Argument | Type | Required | Description |
|---|---|---|---|
| `exposureId` | string | yes | Exposure set id from list_exposure_sets. |

Example arguments:

```json
{"exposureId":"exp_ab12cd"}
```

### `test_connection`

Floor: **creator** · Tab: connections · External door: toolset `connections`

Test a connection you can see — returns live | offline + a detail string. Path: step 3 of the Connections golden path. Before: create_connection. After: Builder promote_connection, or consume it from an app. Governance: read-only probe under your identity; unseeable id → not_found.

| Argument | Type | Required | Description |
|---|---|---|---|
| `connId` | string | yes | Connection id to test. |

Example arguments:

```json
{"connId":"conn_ab12cd"}
```

### `update_exposure_set`

Floor: **admin** · Tab: connections · External door: toolset `connections`

EDIT an exposure set (admin only) — change its name, domains, mode, tier, tables or note. The FQNs it mapped to BEFORE the edit are snapshotted, so any table the edit DROPS (or a domain it removes) is WITHDRAWN from OPA and the full active set is recompiled — a dropped table closes to zero rows immediately. This is the SAME `updateExposureAndRecompile` seam the Expose panel's Update button runs. Before: list_exposure_sets (find the id). Governance: admin re-gated in-lib; audit-traced. Response carries the OPA push result.

| Argument | Type | Required | Description |
|---|---|---|---|
| `exposureId` | string | yes | Exposure set id from list_exposure_sets. |
| `name` | string |  |  |
| `domains` | string[] |  |  |
| `mode` | `live` \| `sync` |  |  |
| `tier` | `silver` \| `gold` |  |  |
| `tables` | object[] |  | Tables to expose, each `{schema, table}` (or a "schema.table" string). They must exist in this connection's catalog snapshot. |
| `actions` | object |  | OPERATIONAL sources only (Salesforce, …): optional per-entity agent-action grant, keyed by the entity/object name (lowercased), each with read/search/create/update booleans. Absent = data-only (the safe default). read/search activate immediately; create/update enqueue an admin `exposure_action_enable` approval (they compile only once approved). Ignored for warehouse exposures and when the operational-actions flag is off. |
| `note` | string |  |  |

Example arguments:

```json
{"exposureId":"exp_ab12cd","domains":["commerce","finance"]}
```

## Tab: governance

<a id="tab-governance"></a>

### `decide_approval`

Floor: **builder** · Tab: governance · External door: toolset `governance`

APPROVE or DENY a request you are entitled to decide — and on approve, EXECUTE the governed effect (the approval IS the action: promote/certify/grant/deploy runs now). Path: the decide step of every gated golden path. AGENT RUNS: when the request came from a PARKED agent run (a write the run interrupted on), approving RESUMES that run from its checkpoint instead of performing the write here — the write then executes exactly once as the RUNNER, not as you; the result carries `resume: { status, runId }` and `get_agent_run(runId)` shows the run continuing. Nothing was written before your decision. Governance: rank-aware canApprove re-gate PER ITEM — a domain item needs a Builder/Domain-admin of that domain; a certification (scope tenant) needs a platform Admin; a creator can never decide, and neither can the requester. `remember:true` writes a standing policy where the item is rememberable — NOTE: standing policy is currently IN-PROCESS only (session-scoped), so it is not yet a durable tenant rule. Idempotency: an already-decided request → conflict.

| Argument | Type | Required | Description |
|---|---|---|---|
| `requestId` | string | yes | The requestId to decide. |
| `decision` | `approve` \| `deny` | yes | approve (run the effect) or deny. |
| `remember` | boolean |  | On approve, also write a standing policy (where rememberable; in-process only today). |

Example arguments:

```json
{"requestId":"apr_ab12cd34","decision":"approve"}
```

### `delete_domain`

Floor: **admin** · Tab: governance · External door: toolset `governance`

ADMIN ONLY. Delete a whole domain and every artifact in it, every owner's, through each component's own API (OS stores, Trino DROP TABLE with Polaris purge, the domain git repo + Dagster reload, OPA data, LiteLLM team and keys, members, the domain record). DRY RUN BY DEFAULT: returns the plan — every object per component that will be removed, and every object KEPT because something outside the domain still maps to it, and every BLOCKED object. This tool ONLY plans: the run itself is available only to a signed-in admin in Admin → Domains, with the typed confirmation and a fresh backup (deploy/pre-upgrade-backup.sh). dryRun:false is refused.

| Argument | Type | Required | Description |
|---|---|---|---|
| `domain` | string | yes | The domain id. |

Example arguments:

```json
{"domain":"sales"}
```

### `diff_versions`

Floor: **creator** · Tab: governance · External door: toolset `governance`

Diff an OS object between two commits — a unified diff per changed file, and the concatenated patch an engineer could pipe into `git apply`. Purpose: answer "what actually changed between these two versions" in the tool's own format, with no OS-invented diff view. Before: get_history, for the two shas. After: act on the change, or ask the tab for the current state. Governance: read-only, gated exactly as get_history. REDACTION: the same secret scrub as get_version runs over every patch, and `redacted: true` says so; the COMPARE still runs on the raw bytes, so a change that is entirely inside redacted content is reported as a redacted change rather than as "no change". HONESTY: `identical: true` (and `files: []`) means the object is byte-identical at both commits; a binary file is reported as `Binary files … differ` instead of as bytes; a file too large to diff line-by-line is reported as such instead of being silently skipped.

| Argument | Type | Required | Description |
|---|---|---|---|
| `kind` | `dataset` \| `metric` \| `dashboard` \| `agent-system` \| `software` \| `lifecycle-pin` \| `knowledge-workflow` \| `connection-config` \| `metric-alert` | yes | The object kind — dataset (dbt model) · metric (dbt metric) · dashboard · agent-system (LangGraph) · software (app) · lifecycle-pin. |
| `id` | string | yes | The object id, as its own tab returns it (never a slug or a directory name). |
| `shaA` | string | yes | The OLDER commit sha (full or abbreviated). |
| `shaB` | string | yes | The NEWER commit sha (full or abbreviated). |

Example arguments:

```json
{"kind":"dataset","id":"ds_1b2c","shaA":"3f81d0c","shaB":"9c1f2ab"}
```

### `get_cost`

Floor: **creator** · Tab: governance · External door: toolset `governance`

Read the spend caps in your scope + their live status (projected spend vs limit, and which are near/over). Purpose: know the cost guardrails before running metered work. Governance: read-only; scope is derived from your identity — a creator/Builder sees their own domain’s caps (+ key caps), an Admin sees tenant-wide. HONESTY: cap ENFORCEMENT is live (checkCap), but spend accrual is in-process today (a real deploy reconciles LiteLLM usage); setting a cap is a governance mutation gated elsewhere (Builder+), not exposed here.

No arguments.

Example arguments:

```json
{}
```

### `get_history`

Floor: **creator** · Tab: governance · External door: toolset `governance`

Read the git history of ANY OS object: the commit it is at (sha, author, time, action, surface) and its recent commits, from the domain repository itself. Purpose: "which version is this, who changed it and why" for a dbt model, a dbt metric, a dashboard, a LangGraph system or an app — one tool, one answer shape. Before: the tab's own list/get tool, for the id. After: get_version(sha) to read the files, diff_versions(a, b) to see what changed. Governance: read-only; the owning tab's own visibility check runs as YOU, and an object you cannot see answers the same `not_found` as one that does not exist. HONESTY: `truncated: true` means the bounded scan window ran out, not that the history is complete; `via` says whether the answer came from the commit trailer, from the path log, or both. Repo layout: dataset → data/dbt/dbt_project.yml, data/dbt/profiles.yml, data/dbt/models/, data/dagster/, os/generated.yml, os/schedules.yml, os/external.yml · metric → data/dbt/models/semantic/<model>.yml · dashboard → dashboards/index.yml, dashboards/<slug>/ · agent-system → agents/index.yml, agents/<slug>/ · software → apps/<slug>/ · lifecycle-pin → os/lifecycle/pins.yml · knowledge-workflow → knowledge/workflows/<slug>/ · connection-config → connections/<catalog>/catalog.properties, connections/<catalog>/os.yaml · metric-alert → metrics/alerts/<name>.yml.

| Argument | Type | Required | Description |
|---|---|---|---|
| `kind` | `dataset` \| `metric` \| `dashboard` \| `agent-system` \| `software` \| `lifecycle-pin` \| `knowledge-workflow` \| `connection-config` \| `metric-alert` | yes | The object kind — dataset (dbt model) · metric (dbt metric) · dashboard · agent-system (LangGraph) · software (app) · lifecycle-pin. |
| `id` | string | yes | The object id, as its own tab returns it (never a slug or a directory name). |
| `limit` | number |  | Commits to return (default 10, capped 100). |

Example arguments:

```json
{"kind":"agent-system","id":"sys_7f3a"}
```

### `get_lineage`

Floor: **creator** · Tab: governance, data, metrics, dashboards, software · External door: toolset `governance`

Get ONE normalized lineage graph `{nodes, edges}` for any artifact: `dataset:<id>`, `metric:<id>`, `dashboard:<id>` or `app:<id>`. Path: understand what an artifact is built from + who consumes it, across tabs. Governance: read-only, scoped — an unseeable ROOT is not_found; individual nodes you cannot see render as `{redacted:true, kind}` (existence, never content).

| Argument | Type | Required | Description |
|---|---|---|---|
| `ref` | string | yes | A "<kind>:<id>" reference, e.g. "dataset:ds_ab12cd" or "app:app_ab12cd34". |

Example arguments:

```json
{"ref":"dataset:ds_ab12cd"}
```

### `get_policy_view`

Floor: **builder** · Tab: governance · External door: toolset `governance`

Read the consolidated, READ-ONLY policy plane — who-can-do-what end-to-end: role-derived grants + dynamic access grants + egress allowlist + standing policies, each labelled with the engine it compiles to (`OPA` or `OpenSearch-DLS` per grant row, and `OPA/DLS` on the capability-profile rows — those are the only engines this view names; nothing here compiles to a semantic-layer product), PLUS the capability-profile catalogue. Purpose: understand the governance posture before you act. Governance: gated on the `policy.view` right (re-checked in-lib, NOT just the Builder floor) — a creator is refused; a Builder/Domain-admin sees ONLY their own domain(s); an Admin sees tenant-wide. Read-only: editing lives in each tab, overrides are Admin-only.

No arguments.

Example arguments:

```json
{}
```

### `get_request`

Floor: **creator** · Tab: governance · External door: toolset `governance`

Read the status of ONE approval request you can see — its kind, decision, who can approve it, and (once decided) the executed effect. Path: the poll step of any gated golden path. Before: you filed a request (request_promotion / request_certification) and got a requestId. Governance: scoped by rank-aware canSee — your own requests always; +your domain if Builder+; tenant-wide if Admin. An id you cannot see is not_found (no existence leak).

| Argument | Type | Required | Description |
|---|---|---|---|
| `requestId` | string | yes | The requestId from a pending handle. |

Example arguments:

```json
{"requestId":"apr_ab12cd34"}
```

### `get_version`

Floor: **creator** · Tab: governance · External door: toolset `governance`

Read ONE version of an OS object: every file of it exactly as it was at a commit, plus the commit that made it. Purpose: see the real bytes (the dbt YAML, the system.yaml, the dashboard-as-code file) rather than a paraphrase of them. Before: get_history, for the sha. After: diff_versions to compare two. Governance: read-only, gated exactly as get_history; an object you cannot see and one that never existed answer identically. REDACTION: anything secret-shaped (a `password:`/`token:`/`api_key:` value, a PEM private key, a credential in a URL, a provider key) is replaced with `***REDACTED-BY-OS***` before the bytes leave the server; `redacted: true` and `redactedPaths` say exactly which files were altered and by which pattern, so you never read a redacted file as if it were the original. A RESTORE re-applies the real bytes, never the redacted ones. HONESTY: `present: false` means the object had NO files at that commit — a real answer, not an error; `binary: true` on a file means it is a binary blob, reported with its size and an EMPTY content rather than decoded as text; `truncated`/`truncatedBy` say when the version holds more files or bytes than one read returns.

| Argument | Type | Required | Description |
|---|---|---|---|
| `kind` | `dataset` \| `metric` \| `dashboard` \| `agent-system` \| `software` \| `lifecycle-pin` \| `knowledge-workflow` \| `connection-config` \| `metric-alert` | yes | The object kind — dataset (dbt model) · metric (dbt metric) · dashboard · agent-system (LangGraph) · software (app) · lifecycle-pin. |
| `id` | string | yes | The object id, as its own tab returns it (never a slug or a directory name). |
| `sha` | string | yes | A commit sha (full or abbreviated), from get_history. Not a ref expression. |

Example arguments:

```json
{"kind":"agent-system","id":"sys_7f3a","sha":"9c1f2ab"}
```

### `go_live`

Floor: **creator** · Tab: governance · External door: toolset `governance`

Go live: pin this version as the one the OS RUNS (also called: publish a version, make it the running version). Lifecycle is Draft · Testing · Live and is INDEPENDENT of audience (My · Domain · Company) — your own My object can be Live, and going live needs no approval. Everything that operates then reads the pin: an agent schedule runs the pinned definition and Run serves the pinned spec. Editing afterwards creates a new draft and does NOT change what Run shows until you go live again. Path: after you have built and tried the draft from Studio. Before: the matching list_*/get_* tool for the id. Governance: refused, naming the culprit, if anything this object depends on is not itself Live.

| Argument | Type | Required | Description |
|---|---|---|---|
| `kind` | `dataset` \| `metric` \| `dashboard` \| `agent` \| `app` \| `knowledge` \| `connection` | yes | Which kind of object: dataset, metric, dashboard, agent (an agent system), app (a software app), knowledge or connection. |
| `id` | string | yes | The object id, exactly as the matching list_* tool returned it. |
| `sha` | string |  | OPTIONAL. The commit or tag to pin. Omit to pin what you are looking at now (the object’s current draft). |

Example arguments:

```json
{"kind":"dashboard","id":"dash_7a1c22"}
```

### `list_approvals`

Floor: **creator** · Tab: governance · External door: core (always listed)

List the approval queue SCOPED to you: your own requests always; +your domain’s items if you are a Builder/Domain-admin; tenant-wide if Admin. Filter by `status` (pending|approved|rejected), `kind`, or `mine:true` (only requests you raised). Path: a decider’s daily loop — list_approvals → get_request → decide_approval. Governance: rank-aware canSee filters every row; nothing outside your scope is ever returned.

| Argument | Type | Required | Description |
|---|---|---|---|
| `status` | `pending` \| `approved` \| `rejected` \| `withdrawn` |  | Filter by decision status (`withdrawn` = the requester took their own agent run's held call back; it was not executed). |
| `kind` | string |  | Filter by approval kind (e.g. artifact_promote, promote_certify, dataset_promote). |
| `mine` | boolean |  | Only requests YOU raised. |

Example arguments:

```json
{"status":"pending"}
```

### `request_certification`

Floor: **builder** · Tab: governance · External door: toolset `governance`

FILE a rung-2 CERTIFICATION request (a Domain asset → Company scope, visible across every domain) — the domain vouches for its artifact. Works for any kind: dataset, workflow, personal_knowledge (a note), connection, dashboard, model, app. Path: the certify step of the ladder. Before: the artifact is already a Domain asset (promote it to Domain first with request_promotion). After: a platform ADMIN runs `decide_approval`. Governance: TRIGGER = a Builder/Domain-admin IN the artifact’s domain (owner-not-required — the domain vouches); APPROVE = a platform Admin only. Returns the pending handle; it does NOT certify.

| Argument | Type | Required | Description |
|---|---|---|---|
| `kind` | `dataset` \| `workflow` \| `knowledge` \| `personal_knowledge` \| `connection` \| `dashboard` \| `artifact` \| `app` \| `agent_system` | yes | What to certify (a Domain asset). A file is certified directly by an Admin (there is no request rung for it), and a metric follows its dataset. |
| `id` | string | yes | The domain asset id. |
| `mode` | string |  | Optional marketplace consumption mode (e.g. read-in-place \| fork-allowed for models). |

Example arguments:

```json
{"kind":"workflow","id":"wf_ab12cd"}
```

### `retire`

Floor: **creator** · Tab: governance · External door: toolset `governance`

Retire: unpin this object so the OS stops running it (also called: take it out of Run, stop the running version). Run stops showing it; the draft, its history and every version are kept exactly as they are, and you can go live again at any time. This is NOT a delete and NOT a demotion: it changes only the lifecycle axis, never the audience — use the promotion tools for My · Domain · Company. Path: when a live version should stop operating. Before: the matching list_*/get_* tool for the id.

| Argument | Type | Required | Description |
|---|---|---|---|
| `kind` | `dataset` \| `metric` \| `dashboard` \| `agent` \| `app` \| `knowledge` \| `connection` | yes | Which kind of object: dataset, metric, dashboard, agent (an agent system), app (a software app), knowledge or connection. |
| `id` | string | yes | The object id, exactly as the matching list_* tool returned it. |

Example arguments:

```json
{"kind":"dashboard","id":"dash_7a1c22"}
```

## Tab: monitoring

<a id="tab-monitoring"></a>

### `get_monitoring_overview`

Floor: **creator** · Tab: monitoring · External door: toolset `platform`

Read the attention-first monitoring overview scoped to YOU: the few things needing attention (worst-first, not a wall of green), the per-lens roll-ups (runs · pipelines · cost · artifacts), and operational alerts. Purpose: one read of "is my work healthy" — the same overview the Monitoring tab renders. Before: whoami. After: list_runs / get_run_trace to drill in. Governance: read-only; scope is derived server-side from your identity (creator = own · builder = your domain · admin = tenant + cluster) — you never receive out-of-scope signals. HONESTY: each item carries a `source` ("live" | "mock"); pipeline/cost/artifact lenses include mock adapters today (as the UI shows), runs are live Langfuse + fallback.

No arguments.

Example arguments:

```json
{}
```

### `get_monitoring_panels`

Floor: **creator** · Tab: monitoring · External door: toolset `platform`

Read one Monitoring view — the same payload the Monitoring tab renders. `agents`: per agent system you can see — runs per day (done · failed · held for approval) from the run store, p50/p95 latency, traces and tokens from the Langfuse Metrics API, the system key's spend from LiteLLM, OPA denials and approval holds from OPA's decision log (VictoriaLogs), the last failures with Langfuse deep links, and approvals waiting. `data`: per dataset you can see — Dagster run health and last success per job and schedule, dbt test / source-test results with the failing ones, the quality trend (Dagster check executions) and the assets impacted downstream (Dagster lineage). `files`: per file you can see — Docling conversion status and failure reason (as recorded), indexing status checked against the rows OpenSearch itself holds; plus per connected drive (Google Drive / OneDrive) in your scope — last sync and its result (added · changed · unchanged · duration · error text), lag since the last successful sync, files imported, paused state and reason, and whether its connection needs reconnecting, with the Dagster schedule and its last run (removals in the drive and per-file sync failures are not recorded upstream). `knowledge`: per knowledge workflow you can see — OpenSearch rows and last ingest time, stale when edited after it (admin also gets OpenSearch's index-wide search latency). `data` also lists every dbt test (Dagster asset check) per dataset with type, pass/fail/warn, failing rows, last run, failing-since, severity, Dagster run link and trend. `kpis`: per metric you can see — registry load errors, last successful build of its dataset (Dagster), alerts firing, and each alert's Dagster evaluation runs (a failed run is a MetricFlow error). `dashboards`: per dashboard you can see — panels asking for members the served model does not expose (render errors and query latency are not available upstream). `software`: per app you can see — the honest status word (Live only when a runner really serves), the security scan of its newest review card (verdict, engine, severity counts, the categories no engine covered; `no_verdict` when no engine ran), pod health from the Kubernetes API (image apps only; crash-loops, restarts) and the share of log lines that are errors from VictoriaLogs (CI/CD results are not recorded upstream: the stack has no CI runner). `workflows`: per workflow you can see — draft · live · stale (edited after going live) from the workflow store, and the promotion requests waiting on workflows that you may see (Governance's canSee) with how long each has waited and the median time to a decision; workflow runs are not recorded upstream (run_jobs carries no workflow id). `platform` (admin only): component probes, node and pod pressure (VictoriaMetrics), error-log counts (VictoriaLogs), backups and the alerts firing now. Purpose: the first look for an operator, an agentic engineer or a data engineer. Before: whoami. After: list_runs / get_run_trace / get_dagster_run to drill in. Governance: read-only; every upstream read is narrowed server-side to your systems and datasets; `platform` answers forbidden below admin. HONESTY: `sources.*.state` says whether each component answered (`unavailable` + reason otherwise — its numbers are then absent, never zero); `notUpstream` lists what the components do not offer.

| Argument | Type | Required | Description |
|---|---|---|---|
| `view` | `agents` \| `data` \| `platform` \| `files` \| `knowledge` \| `kpis` \| `dashboards` \| `software` \| `workflows` |  | agents (default) · data · files · knowledge · kpis · dashboards · software · workflows · platform (admin only). |

Example arguments:

```json
{"view":"agents"}
```

### `get_run_trace`

Floor: **creator** · Tab: monitoring · External door: toolset `platform`

Drill into ONE run trace: its steps (LLM calls, tool calls, spans), context pack, inputs/outputs, tokens and logs. Purpose: the core promise of Monitoring — see exactly what a governed run did. For an AGENT run the trace id IS the run id (`run_<uuid>` from run_agent_system): agents are spans, model calls are generations with token usage, tool calls are spans carrying the governance decision — one run, one trace. Before: list_runs, or the `runId` run_agent_system / get_agent_run returned. After: act on what you find. Governance: HARD gate, BEFORE any step/log is returned. An AGENT run id (`run_<uuid>`) is OWNER-only — only the user who started that run can read it, and any other id is a typed not_found, never a forbidden, so a run id cannot be probed for existence (the same gate `get_agent_run` uses). Any other trace id is scope-gated: out-of-scope is a typed forbidden, a missing id a typed not_found. LIVE from Langfuse; offline-mock fallback carries `source: "mock"`.

| Argument | Type | Required | Description |
|---|---|---|---|
| `runId` | string | yes | Run/trace id — from list_runs, or an agent run id (run_<uuid>). |

Example arguments:

```json
{"runId":"trace_ab12cd"}
```

### `list_runs`

Floor: **creator** · Tab: monitoring · External door: toolset `platform`

List recent agent RUNS (and governed tool-call traces) you are entitled to see, newest first — each with its health (green/amber/red), a one-line detail, owner, domain and, for an agent run, its `status` (queued · running · done · failed · parked · interrupted · incomplete) and `links.systemId`. Purpose: the run-trace lens as a list — find a run to inspect. Before: whoami / get_monitoring_overview. After: get_run_trace(runId) or get_agent_run(runId) to drill into one. READS: agent runs from the durable RUN STORE (the `run_jobs` rows every run is filed in, wherever it executed — a run the worker finished a moment ago is listed even before Langfuse has ingested it; a failed run reads `failed`, red); governed tool-call traces from Langfuse + this process’s trace ring. `systemId` and `status` filter agent runs (a filtered list holds agent runs only). If the run store does not answer, `runStore.available` is false with a reason — agent runs are then NOT listed, which does not mean there are none. Governance: read-only and HARD-scoped — every row is passed through `filterScope`, so a creator sees ONLY their own runs, a builder their own and their domain’s. NOTE the ladder (A5-review-L-4): this LISTING is scope-wide, so a builder sees that a colleague’s run exists and its health; the run CONTENTS are owner-only — `get_agent_run` and `get_run_trace` on an agent run id answer not_found unless you started it. Each row carries `source`.

| Argument | Type | Required | Description |
|---|---|---|---|
| `limit` | number |  | Max runs to return (default 25, capped 50). |
| `systemId` | string |  | Only agent runs of this agent system (id from list_agent_systems). |
| `status` | `queued` \| `running` \| `done` \| `failed` \| `parked` \| `interrupted` \| `incomplete` |  | Only agent runs with this status. |

Example arguments:

```json
{}
```

## Tab: operating-manual

<a id="tab-operating-manual"></a>

### `get_operating_manual`

Floor: **creator** · Tab: operating-manual · External door: toolset `platform`

Read an Operating Model at one scope — its guided sections (general · strategy · business · organization · architecture · data · glossary). Purpose: the canonical "how we operate" card that grounds a domain or the whole org. Before: whoami (to know your domains). After: update_operating_manual to edit (if you may). Governance: view is per-scope via resolveManual — a My operating model is your own; a Domain model is readable by anyone in that domain; the Company model by everyone. A scope you cannot view is a typed forbidden.

| Argument | Type | Required | Description |
|---|---|---|---|
| `scope` | `my` \| `domain` \| `company` | yes | Which manual: my (personal, owner-only) · domain (your domain — everyone reads, domain_admin+ edits) · company (tenant-wide — everyone reads, Admin edits). |
| `domain` | string |  | For scope=domain: one of YOUR domains (defaults to your first). |

Example arguments:

```json
{"scope":"my"}
```

### `list_operating_manual_versions`

Floor: **creator** · Tab: operating-manual · External door: toolset `platform`

List the version history of an Operating Model at one scope (newest first) — every edit is snapshotted, so you can see what changed and restore. Purpose: audit + pick a version to roll back to. Before: get_operating_manual. After: restore_operating_manual_version with a chosen version number. Governance: view is per-scope via resolveManual (same as get_operating_manual) — a scope you cannot view is a typed forbidden.

| Argument | Type | Required | Description |
|---|---|---|---|
| `scope` | `my` \| `domain` \| `company` | yes | Which manual: my (personal, owner-only) · domain (your domain — everyone reads, domain_admin+ edits) · company (tenant-wide — everyone reads, Admin edits). |
| `domain` | string |  | For scope=domain: one of YOUR domains (defaults to your first). |

Example arguments:

```json
{"scope":"domain","domain":"sales"}
```

### `restore_operating_manual_version`

Floor: **creator** · Tab: operating-manual · External door: toolset `platform`

Restore a prior version of an Operating Model at one scope. Restore is itself reversible — the current card is snapshotted first, then the chosen version's sections are applied. Purpose: roll the operating model back to an earlier state. Before: list_operating_manual_versions (to get the version number). After: get_operating_manual to read the restored card. Governance: edit is per-scope via resolveManual and enforced server-side (My = owner; Domain = domain_admin+ / owner; Company = Admin) — anyone else is refused (forbidden).

| Argument | Type | Required | Description |
|---|---|---|---|
| `scope` | `my` \| `domain` \| `company` | yes | Which manual: my (personal, owner-only) · domain (your domain — everyone reads, domain_admin+ edits) · company (tenant-wide — everyone reads, Admin edits). |
| `domain` | string |  | For scope=domain: one of YOUR domains (defaults to your first). |
| `versionId` | number | yes | The version number to restore (from list_operating_manual_versions). |

Example arguments:

```json
{"scope":"domain","domain":"sales","versionId":2}
```

### `update_operating_manual`

Floor: **creator** · Tab: operating-manual · External door: toolset `platform`

Edit an Operating Model at one scope by patching its guided sections (general · strategy · business · organization · architecture · data · glossary). Only the sections you pass are changed; a no-op save creates no version churn. Purpose: keep the "how we operate" card current. Before: get_operating_manual (read the current sections + their ids). After: get_operating_manual to read it back. Governance: edit is per-scope via resolveManual and enforced server-side — My = the owner (any role); Domain = a domain_admin of that domain (or the owner); Company = a platform Admin. Anyone else is refused (forbidden). Section ids are fixed: general · strategy · business · organization · architecture · data · glossary.

| Argument | Type | Required | Description |
|---|---|---|---|
| `scope` | `my` \| `domain` \| `company` | yes | Which manual: my (personal, owner-only) · domain (your domain — everyone reads, domain_admin+ edits) · company (tenant-wide — everyone reads, Admin edits). |
| `domain` | string |  | For scope=domain: one of YOUR domains (defaults to your first). |
| `sections` | object[] | yes | The sections to overwrite. Each is { id, content }; id ∈ general \| strategy \| business \| organization \| architecture \| data \| glossary. |

Example arguments:

```json
{"scope":"my","sections":[{"id":"strategy","content":"Ship the Q3 retention playbook."}]}
```
