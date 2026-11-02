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

## Rules that apply here

1. **Import only `@core/*` and this module.** A cross-tab need means the shared part belongs in `@core`.
2. **The kernel must not import this module.** `@core` does not know its tabs exist.
3. **Pages live in `os-ui/app/`**, thin, importing from here. Next.js serves routes only from there.
4. Every source file carries a `FEATURE:` / `USER STORY:` / `ARCHITECTURE:` header. `scripts/check-structure.mjs` enforces it as a ratchet.

See [`../../../CLAUDE.md`](../../../CLAUDE.md) for the full structure rules and [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) for the constraints this codebase punishes you for ignoring.
