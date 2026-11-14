# Dashboards · Build

Saved, shareable views over governed data.

The authoritative contract is [`manifest.ts`](./manifest.ts) — this file explains it; the manifest is what the checks and the docs generator read. If the two disagree, the manifest is right.

## What this module owns

**Routes**

- `/dashboards`

**APIs**

- `/api/dashboards`

**MCP tools**

- `dashboard-write`

**Needs deployed**

- `trino`
- `opensearch`

## Layout

- `lib/`
- `lib/git/` — dashboard-as-code: the snapshot, the byte-stable generator, the reader/importer, the
  commit path, the `ingestFromRepo` contract for a `git push`, and the git-object resolver
- `mcp/`
- `ui/`

Charts are rendered through the OS's ONE chart surface, `@core/ui/charts` (a single Apache-ECharts
registration, one theme bridge, one formatter module, one `<Chart>` shell and one pure
`ChartSpec → EChartsOption` builder). This tab registers nothing of its own;
`lib/chart-spec.ts` maps a `Panel` onto that surface and is where the panel→chart logic is tested.
Line, area and bar are built by chart transformers derived from Apache Superset source, vendored
under `os-ui/vendor/superset/` and attributed — see that directory's README before touching it.

- `lib/` tab logic · `ui/` tab-specific components · `mcp/` this tab's MCP handlers

- `guide.md` — the golden path, shown in-product
- `context.md` — the system prompt context this tab gives an agent

## Rules that apply here

1. **Import only `@core/*` and this module.** A cross-tab need means the shared part belongs in `@core`.
2. **The kernel must not import this module.** `@core` does not know its tabs exist.
3. **Pages live in `os-ui/app/`**, thin, importing from here. Next.js serves routes only from there.
4. Every source file carries a `FEATURE:` / `USER STORY:` / `ARCHITECTURE:` header. `scripts/check-structure.mjs` enforces it as a ratchet.

See [`../../../CLAUDE.md`](../../../CLAUDE.md) for the full structure rules and [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) for the constraints this codebase punishes you for ignoring.
