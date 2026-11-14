# dbt — transforms (dbt-trino)

**What it is:** dbt Core (Apache 2.0) with the **dbt-trino** adapter, executing on the central
governed Trino (Iceberg via the Polaris REST catalog). One adapter, one engine, one SQL dialect.

## What ships today, honestly

Two things exist side by side; be clear which one you are looking at.

**1. The demo project (`images/extensions/dbt/project`).** `raw_orders` → `stg_orders` →
`daily_revenue`, baked into the dbt and Dagster images. It runs once as a non-blocking
`post-install` Helm hook (`templates/extensions/dbt/dbt-build.yaml`) and on manual materialisation
in Dagster. **No OS dataset is part of it.** It is a leftover of the pre-rebuild world and is
scheduled for deletion; nothing in the OS path reads it.

**2. The generated project per domain (engine rebuild, Phases B1–B4 — `DATA_PROJECT_GIT`, ON by
default since B4).** With `osUI.dataProjectGit.enabled: true` (env `DATA_PROJECT_GIT=true`, the
default), every dataset,
composition, quality rule, sync, publish and retire change — made in the UI or through the OS MCP —
regenerates the owning domain's **dbt project** and commits it to a bare git repository the OS owns
(`/repos/<domain>.git`, PVC `os-repos`), authored as the acting user. The OS is the writer; users
read, export and mirror the repo (`GET /api/data/projects/<domain>`, `…/blob`, `…/export`; admin
`PUT /api/platform-admin/data-projects/<domain>/mirror`).

The generated project is what an engineer would write:

| OS object | In the project |
|---|---|
| Ingested Bronze (`iceberg.personal_<uid>.bronze_<slug>`, written by the data-runner) | `models/sources.yml` source — dbt never writes Bronze; `freshness` on `_loaded_at` when the table carries it |
| A layer the OS did **not** compile (`add_dataset_version`'s free-text `body`, a seeded or adopted table) | a `models/sources.yml` **source** with `meta.os_built: out-of-band` — dbt reads that table and never rewrites it. The dataset's quality rules attach to it as source tests, so `dbt build` still runs them. This is why the store records *provenance* (`compiled: true`) alongside the body: an authored body must never be handed to Jinja at `dbt parse`, and a scheduled `<model>+` run must never replace someone's table with a copy of the layer below |
| Silver (guided clean / pass-through) | `models/…/silver_<slug>.sql`, `materialized: table`, `+on_table_exists: replace`; body = the compiled SELECT the OS recorded, FQNs rewritten to `{{ source() }}` |
| Gold / composition | `models/…/gold_<slug>.sql`; body = today's `compileGoldJoin` SELECT with every joined dataset as `{{ ref() }}` and another domain's product as `{{ source('<domain>', …) }}` |
| Personal lane vs promoted | un-promoted dataset → `models/personal/<uid>/` with `+schema: personal_<uid>`; promoted → `models/<layer>/` in the domain schema (`generate_schema_name` returns the custom schema verbatim) |
| Quality rules | `schema.yml` `data_tests`: `not_null`, `unique`, `accepted_values`, plus generator-shipped `tests/generic/range.sql` and `not_blank.sql` carrying the predicates of `dq.ts`. A column name is interpolated **unquoted** into the test SQL, so a rule whose column is not `/^[A-Za-z_][A-Za-z0-9_]*$/` — or an `accepted_values` with no values, or a `range` with neither bound — is recorded as `meta.os_intentions`, never emitted as a test (the store refuses such a column at the gate too). Free-text intentions likewise: never a fake test |
| Sync full-refresh | `materialized: table` over the federated `{{ source() }}` |
| Sync append (cursor, 15-min lookback, `_batch_id`) | `incremental`, `incremental_strategy: delete+insert`, `unique_key: _batch_id`, `where cursor > (select max(cursor) from {{ this }}) - interval '15' minute` |
| Sync merge | `incremental`, `incremental_strategy: merge`, `unique_key: [merge keys]`, `on_schema_change: append_new_columns` |
| Kafka offsets / API-batch sources | **not** faked as models: listed in `os/external.yml`. Still not assets — the Dagster Python asset that calls the OS's governed slice executor is NOT in B4 either; it needs the slice executor's HTTP contract and is a recorded follow-up. These syncs run through the OS executor, triggered manually or by the OS's own path |
| A federated sync **source** | `os/sources.yml` (engine rebuild B3) → one **observable source asset** per entry, keyed `[<domain>, <source>, <table>]` so the silver model that reads it depends on it. Freshness = two schedule intervals, derived from the sync's own cron; `max_updated` on a timestamp cursor, else `row_count`. See `dagster.md` → "External sources are assets too" |
| Sync schedule | `os/schedules.yml` `{dataset, select: "<model>+", cron, timezone: UTC, principal, enabled}` → one UTC `ScheduleDefinition` in the Dagster `sovereign` location |
| Iceberg maintenance | `macros/os_maintenance.sql` — `ALTER TABLE … EXECUTE optimize` + `expire_snapshots(retention_threshold => '7d')` per schema, run weekly by Dagster as the schema's owner |

**One door, both surfaces (engine rebuild B4).** The project is regenerated and committed by exactly
one service per mutation (`os-ui/tabs/data/lib/mutations-server.ts`), which the Data tab's route and
the MCP tool both call — so a dataset built through the MCP produces the same files, the same author
and the same Dagster launch as one built in the UI (`tabs/data/lib/mcp-parity.test.ts`, checklist
X8). At boot the OS also commits the difference between the generated project and the repository
HEAD for every domain (`OS-Reason: boot-reconcile`), which is both the migration for an install that
ran with the flag off and the repair for a crash between a store write and its commit.

`profiles.yml` uses `env_var()` only: `TRINO_HOST/PORT/USER/CATALOG`, `TRINO_AUTH_METHOD`
(default `none`) and **`impersonation_user: env_var('OS_PRINCIPAL')`** with no default — a run
without a principal fails loudly instead of impersonating the domain. No credential is ever in the
repository.

The Dagster user-code pod's `repo-sync` sidecar fetches each domain repo over the read-only git
daemon and runs `dbt parse` in a worktree, repointing `current` only on success; the `sovereign` code
location then loads that checkout, so the project is parsed *and* run — `dbt build --select <assets>`
in a Dagster run pod, launched by the OS after the commit or by the schedule (see `dagster.md`).

**The Trino side of `impersonation_user` (engine rebuild B3).** Trino now chains a **file-based**
system access control after the OPA plugin, whose `rules.json` lets `dbt-runner` act as an OS
principal and as **nothing else**, and makes a domain's Iceberg schema writable only by that
domain's principals. The file is generated — `core/infra/trino-rules.ts` (pure, golden-tested), with
the chart rendering a bootstrap and os-ui reconciling the real membership into the same ConfigMap.
Read `docs/components/trino.md` before relying on it: **Trino does not authenticate clients today**
(`http-server.authentication.type` is unset), so the impersonation section has no authenticated
`original_user` to match and the network boundary is still what makes a claimed session user
trustworthy. The schema-ownership rules bite immediately; the impersonation rules need
authentication, which is a deploy decision with a new secret in it.

**Parity before deletion.** `tabs/data/lib/dbt/parity.ts` + `parity.test.ts` compare, per fixture,
the SQL the OS runs today (`CREATE OR REPLACE TABLE … AS <select>`) with the SQL dbt will run (the
model body with `ref()`/`source()` resolved back to FQNs): same projection with aliases in order,
same FROM + JOIN sequence with the same ON predicates, same WHERE conjuncts, same GROUP BY. Note
what that can and cannot prove — the model body **is** the recorded CTAS after rewriting, so the test
proves the TRANSLATION is faithful and invertible and catches any future change to the rewriter, the
stripper or the lane/FQN mapping. It does not prove the two produce the same ROWS; that needs two
materialisations and an `EXCEPT ALL` both ways on a cluster (checklist D15's `kind` half).

**Who can read the project.** `GET /api/data/projects/<domain>` is gated on **domain membership**,
and the repository is the whole domain's project — so every member of a domain can read every
member's dataset *definitions*: model SQL, column descriptions, quality rules, sync schedules and
the commit log naming who changed what, including un-promoted personal-lane models under
`models/personal/<uid>/`. That is deliberate (it is how an engineering team works) but it is wider
than the dataset list: a dataset whose **rows** you cannot see still has a readable definition here.
The data itself stays governed — a model reads only what Trino→OPA allows the impersonated
principal — and no credential is ever in the tree. Definition-level privacy inside a domain would be
a new per-path read gate, not a property of this design.

## Metrics are dbt metrics (the semantic layer)

A metric defined in the OS — in the form, from chat or over the MCP — is a real dbt
`metrics:` entry on a `semantic_models:` measure, committed into the owning domain's dbt project:

```
models/semantic/<model>.yml              promoted (domain) datasets
models/personal/<uid>/semantic/<model>.yml   a personal dataset's lane (promotion moves the file)
models/os/os_time_spine_day.sql          the daily time spine (a view over Trino's sequence())
models/os/schema.yml                     the spine's dbt >= 1.9 `time_spine` property
```

**One pinned spec version.** The emitter targets **dbt-semantic-interfaces 0.8.5 = dbt-core 1.10**
field names, and every field it writes is *also* valid on **dbt-core 1.9** — which is what the
images actually carry (`images/extensions/{dbt,dagster}/Dockerfile` pin `dbt-core>=1.8,<1.10`, so
pip resolves 1.9.x). The pin is one constant, `DBT_SEMANTIC_SPEC` in
`tabs/data/lib/dbt/semantic/spec.ts`, it is named in every generated project's README, and a test
asserts it. Why a pin at all: `docs.getdbt.com` now serves the dbt 1.12 ("Fusion") spec by default
and its `?version=` selector is client-side only, so the prose does not describe what dbt 1.8–1.10
accepts; the authoritative source is the DSI pydantic spec at the version dbt-core pins. 1.12 is a
breaking redesign of this exact spec, so it becomes a translation layer, not a rewrite.
`cumulative_type_params` does **not** exist on dbt 1.8 — that is why the floor is 1.9.

**What is emitted, and what is refused.** `simple`, `ratio`, `derived` and `cumulative` YAML are
emitted from today's OS `Measure`. `count_distinct_approx` has no faithful dbt agg, so it emits
`count_distinct` plus `config.meta.os_agg: count_distinct_approx`: dbt's own number stays exact, the
OS compiler keeps `approx_distinct`, and a parity oracle must exclude it for a stated reason.
Anything with no faithful form — a leading window, an unparseable trailing window, a ratio carrying
its own filter (the OS compiler drops it), a formula over a metric that is not emitted, a filter
outside the generated grammar — is a **named refusal**, listed in the project README under
"Not emitted", and **nothing** is written for it. Emitting YAML the OS compiler cannot serve would
put a wrong number in a tool an engineer trusts; and one unknown key fails `dbt parse` for the
**whole** domain, so each document is validated against the pinned spec before it is written and a
document with violations is dropped with the violations recorded.

**Execution stays in the OS.** MetricFlow is never on the interactive request path — a metric read
is `tabs/metrics/lib/explorer.ts` compiling one governed Trino `SELECT` run as the **viewer**
(`queryRun(sql, identities.trino.user)`). MetricFlow would open one connection from its own
profile and lose the per-viewer impersonation that is the point of the OS. Where MetricFlow is
installed at all it is pinned `metricflow >= 0.209.0`: `<= 0.208.1` is BSL 1.1, whose Additional Use
Grant excludes this product's use, and BSL does not relax retroactively (`0.209.0` is the first
Apache-2.0 release). `scripts/license-check.sh` asserts that floor.

**What the OS compiler serves, exactly.** `simple` and `ratio` always. `derived` **one level deep**
— a formula over sibling metrics, each substituted for its own aggregate; a ratio of ratios is
refused. `cumulative` **only at a matching grain** — the frame is `ROWS BETWEEN n PRECEDING AND
CURRENT ROW` over the bucketed series, so the window's unit must equal the slice's granularity;
every other grain is refused with a typed `window_grain_mismatch`. And because the frame counts
BUCKETS rather than calendar units, a served cumulative result carries a `warning` saying so: the
time spine is generated but **not joined to yet**, so a sparse series trails the last n *present*
buckets, not the last n days. A refusal is `{ code, metricType, reason }`
(`tabs/metrics/lib/explorer.ts` `serveRefusal`), never a number.

**Not true yet.** The spine join (which is what makes a trailing window calendar-correct at any
grain), `saved_queries:` / `exports:`, entity joins across semantic models, the dbt filter-syntax
parser on the query path, and the MetricFlow parity oracle. Also: a dataset with measures and **no
time column** emits no semantic YAML at all — dbt requires an `agg_time_dimension` for every
measure, so those metrics are refused by name in the project README and served by the OS only.

## Code

- Generator: `os-ui/tabs/data/lib/dbt/{generate,models,sources,schema,schedules,project}.ts`
  (pure; golden tests in `generate.test.ts`, fixtures in `fixtures/*.golden.json`).
- Commit path: `tabs/data/lib/dbt/commit.ts` over `core/infra/git-store.ts` (isomorphic-git, MIT).
- Read access + mirror: `tabs/data/lib/dbt/{read,mirror}.ts`; repo index `GET /api/data/projects`.
- Launch after commit: `tabs/data/lib/dbt/{launch,asset-keys}.ts` over `core/infra/dagster.ts`.
- Read-back: `tabs/data/lib/{sync-status-server,dq-status-server}.ts`.
- Source assets: `tabs/data/lib/dbt/source-assets.ts` → `os/sources.yml`;
  `images/extensions/dagster/os_projects.py` `parse_source_assets` / `observe_sql`.
- Lineage from the manifest: `tabs/data/lib/dbt/lineage.ts` (pure) +
  `tabs/data/lib/lineage-server.ts` (one `assetGraph()` call, registry fallback).
- Parity harness: `tabs/data/lib/dbt/parity.ts` + `parity.test.ts`.
- Semantic layer: `tabs/data/lib/dbt/semantic/{spec,model,validate,from-measures,time-spine,render}.ts`
  (pure; the pinned spec, the typed document + emitter + parser, the spec validator, the
  `Measure` → dbt bridge, the time spine and the project renderer). Preview artefact:
  `tabs/data/lib/semantic.ts`. Golden: `fixtures/metrics-semantic-layer.golden.json`.
- Trino access rules: `core/infra/trino-rules.ts` + `trino-rules-server.ts`.

## Engineering view ("Under the hood")

Every data product and every KPI carries an **Under the hood** panel (and the MCP twin
`get_engineering_view({kind, id})`) whose **dbt** tab shows the artefacts of THIS project, read out
of the domain repository at `main` — not re-rendered from the generator:

- the `dbt model` SQL (`models/<layer>/<layer>_<slug>.sql`, or `models/personal/<uid>/…` in the
  personal lane), with its repo path;
- the `models/**/schema.yml` properties and the dbt tests attached to it;
- `models/sources.yml` where the product reads a source;
- `models/semantic/<model>.yml` — the `semantic_models:` and `metrics:` blocks — **once the
  semantic emitter has written it**. Until then the KPI's dbt tab says so in its own words and
  states that `mf query --metrics <name>` would not resolve yet; it does not pretend otherwise.

**Membership decides how much of the project you see.** A Company-tier data product is visible to
a caller outside its domain, but the domain *repository* is members-only (`requireMember` in
`tabs/data/lib/dbt/read.ts`, which every project route goes through). So a non-member's panel shows
that product's own model file and says why it shows nothing else, and the tarball is offered as
unavailable with the reason — rather than printing bytes, or a download, that the project API would
answer 403 to.

The commands the panel prints are the ones you would type in a checkout:

```sh
dbt build --select <node>     # the model and the tests attached to it
dbt test --select <node>      # only its tests
dbt ls --select metric:<name> # the dbt metric node, when the semantic file exists
mf query --metrics <name> --group-by metric_time__month
```

**Take it elsewhere.** The panel's export is the project tarball
(`GET /api/data/projects/<domain>/export`, built by `core/infra/git-store.ts` `archive()`):

```sh
curl -fsSLO <os>/api/data/projects/<domain>/export   # <domain>-<sha>.tar
tar -xf <domain>-<sha>.tar -C <domain> && cd <domain>
export TRINO_HOST=trino TRINO_PORT=8080 TRINO_USER=dbt-runner OS_PRINCIPAL=<your-principal>
dbt parse --profiles-dir .
dbt build --profiles-dir . --select <model>+
```

`os-ui/tabs/data/lib/engineering-export.test.ts` asserts the round trip offline: the tarball
carries every file byte for byte, `dbt_project.yml` and `profiles.yml` are present, every `.yml`
still parses, every `ref()` names a model that is in the tarball, and no credential rode along.
The cluster step (Part C) runs a real `dbt parse` on a downloaded tarball.

## FAQ
**Q: Can I run the generated project myself?** Yes — export it (`GET …/export?ref=<sha>`), set the
`TRINO_*` env vars and `OS_PRINCIPAL`, `dbt parse --profiles-dir .`. Inside the cluster only the
Dagster user-code pod may reach the git daemon (NetworkPolicy).
**Q: Why dbt-trino?** Trino is the single governed engine: it writes/maintains Iceberg natively and
applies OPA row/column governance to the impersonated principal — the same identity the UI uses.
