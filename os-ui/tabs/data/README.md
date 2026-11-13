# Data · Context

Datasets, SQL, the lakehouse and the catalog. Ingestion, federation of external warehouses, and scheduled syncs.

The authoritative contract is [`manifest.ts`](./manifest.ts) — this file explains it; the manifest is what the checks and the docs generator read. If the two disagree, the manifest is right.

## What this module owns

**Routes**

- `/data`

**APIs**

- `/api/data`
- `/api/tables`
- `/api/query`
- `/api/catalog`

**MCP tools**

- `data-query`
- `dataset-write`

**Needs deployed**

- `postgres`
- `opensearch`
- `minio`
- `trino`
- `polaris`
- `dbt`
- `dagster`
- `data-runner`
- `query-tool`

## Layout

- `lib/`
- `mcp/`
- `ui/`

- `lib/` tab logic · `ui/` tab-specific components · `mcp/` this tab's MCP handlers

- `guide.md` — the golden path, shown in-product
- `context.md` — the system prompt context this tab gives an agent

## Data products in git (engine rebuild B1 — flag `DATA_PROJECT_GIT`, default off)

With `DATA_PROJECT_GIT=true` (chart: `osUI.dataProjectGit.enabled`), every mutation of a dataset,
composition, quality rule, sync, publish or retire — through a route or an MCP tool — regenerates
the owning domain's **dbt project** and commits it to a bare repository the OS owns
(`$OS_REPOS_DIR/<domain>.git`, PVC `os-repos`), authored as the acting user, committed by
`Sovereign OS`, message `data(<domain>): <action> <object> — via ui:<route> | mcp:<tool>` with
trailers `OS-Action`, `OS-Object`, `OS-Surface`, `OS-Request-Id` (and `OS-Author-Email: synthesized`
when the user has no e-mail). A regeneration that changes nothing commits nothing.

**How it is wired.** `lib/store.ts` emits a `ProjectChange` from its one `persist()` and from the
writers that bypass it (`lib/project-events.ts`, pure — the store is reachable from the client bundle
and may not import git). `lib/dbt/commit.ts` subscribes at boot (`instrumentation.ts`), reads the
ambient request surface (`core/infra/request-surface`, set by `withRoute` for routes and by the data
MCP tools for `mcp:<tool>`), snapshots the domain (`lib/dbt/snapshot.ts`), generates
(`lib/dbt/generate.ts`, pure, byte-stable) and commits through `core/infra/git-store.ts`.
`lib/dbt/commit.test.ts` enumerates the store's exports: a new mutator fails until classified.

**Read access** (domain members only): `GET /api/data/projects/<domain>` → `{head, tree, log}`;
`GET …/blob?ref=&path=`; `GET …/export?ref=` (tar). Admin:
`PUT /api/platform-admin/data-projects/<domain>/mirror` `{url, tokenSecretRef:{name,key}}` — the
token is a Secret reference, pushed after every changed commit, failures reported never blocking.

**Generated layout** (`lib/dbt/fixtures/*.golden.json` are the three canonical shapes):

```
dbt_project.yml  profiles.yml (env_var() only; impersonation_user = OS_PRINCIPAL)  README.md  .gitignore
macros/generate_schema_name.sql          # +schema is the exact Iceberg schema
tests/generic/range.sql, not_blank.sql   # the OS rules dbt has no built-in for (predicates from dq.ts)
models/sources.yml                       # Bronze landings + federated tables (freshness on _loaded_at)
models/silver/, models/gold/             # promoted layers (domain schema)      + schema.yml
models/personal/<uid>/                   # un-promoted layers (+schema: personal_<uid>) + schema.yml
os/schedules.yml                         # {dataset, select "<model>+", cron, UTC, principal}
os/external.yml                          # Kafka-offset / API-batch syncs (Dagster assets, not models)
```

## Rules that apply here

1. **Import only `@core/*` and this module.** A cross-tab need means the shared part belongs in `@core`.
2. **The kernel must not import this module.** `@core` does not know its tabs exist.
3. **Pages live in `os-ui/app/`**, thin, importing from here. Next.js serves routes only from there.
4. Every source file carries a `FEATURE:` / `USER STORY:` / `ARCHITECTURE:` header. `scripts/check-structure.mjs` enforces it as a ratchet.

See [`../../../CLAUDE.md`](../../../CLAUDE.md) for the full structure rules and [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) for the constraints this codebase punishes you for ignoring.
