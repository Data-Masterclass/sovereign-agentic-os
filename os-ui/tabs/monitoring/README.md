# Monitoring · Manage

Run traces, component health, and gateway spend. Observation only; configuration lives in Platform.

The authoritative contract is [`manifest.ts`](./manifest.ts) — this file explains it; the manifest is what the checks and the docs generator read. If the two disagree, the manifest is right.

## What this module owns

**Routes**

- `/monitoring`

**APIs**

- `/api/monitoring`
- `/api/traces`
- `/api/status`
- `/api/platform-admin/billing`

**MCP tools**

_No MCP tools yet. Every user-facing action should grow one — the MCP server is a front door to the same governed code, not a back door around it._

**Needs deployed**

- `langfuse`
- `clickhouse`
- `opensearch`

## Layout

- `lib/`
- `ui/`

- `lib/` tab logic · `ui/` tab-specific components · `mcp/` this tab's MCP handlers

- `guide.md` — the golden path, shown in-product
- `context.md` — the system prompt context this tab gives an agent

## Where the numbers come from (engine rebuild B2)

- **Pipelines lens** (`lib/adapters/pipeline-health.ts`) reads **Dagster runs** through the one typed
  client (`core/infra/dagster.ts` `recentOsRuns`, READ-ONLY — no launch or terminate here) and
  labels each row from the run's `os/*` tags: `os/dataset`, `os/domain`, `os/principal`,
  `os/action`, `os/commit`. A run without those tags keeps its job name rather than being hidden.
  Dagster unreachable ⇒ nothing, or the demo fixtures where `monitoringDemoFixtures` is on — never a
  red alert no one can act on.
- **Data quality and last-sync** (`lib/artifacts-view.ts`, `lib/detail-view.ts`) read
  `@tabs/data/lib/dq-status-server` and `@tabs/data/lib/sync-status-server`, which resolve to
  **Dagster asset checks and runs** when `DATA_PROJECT_GIT` is on and to the OS's own
  `os-dq-results` / `os-sync-runs` series when it is off. One function per signal, shared with the
  Data tab, so the two tabs cannot disagree. Unknown is `null`, never a guess.
- **Agent run traces** still come from Langfuse / the in-process ring (Part A of the engine rebuild).

## Rules that apply here

1. **Import only `@core/*` and this module.** A cross-tab need means the shared part belongs in `@core`.
2. **The kernel must not import this module.** `@core` does not know its tabs exist.
3. **Pages live in `os-ui/app/`**, thin, importing from here. Next.js serves routes only from there.
4. Every source file carries a `FEATURE:` / `USER STORY:` / `ARCHITECTURE:` header. `scripts/check-structure.mjs` enforces it as a ratchet.

See [`../../../CLAUDE.md`](../../../CLAUDE.md) for the full structure rules and [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) for the constraints this codebase punishes you for ignoring.
