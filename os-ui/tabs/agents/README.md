# Agents · Build

Build, run and govern agents. Their grants, runs, traces and the scoped credential each run uses.

The authoritative contract is [`manifest.ts`](./manifest.ts) — this file explains it; the manifest is what the checks and the docs generator read. If the two disagree, the manifest is right.

## What this module owns

**Routes**

- `/agents`

**APIs**

- `/api/agents`
- `/api/agent`
- `/api/agent-chat`
- `/api/assistant`

**MCP tools**

- `agent-write`

**Needs deployed**

- `agent-runtime`
- `litellm`
- `opa`
- `langfuse`
- `opensearch`
- `postgres`

## Layout

- `lib/`
- `ui/`

- `lib/` tab logic · `ui/` tab-specific components · `mcp/` this tab's MCP handlers

- `guide.md` — the golden path, shown in-product
- `context.md` — the system prompt context this tab gives an agent

## Agent engine (rebuild in progress)

Runs execute in-process, as the signed-in user. Two executors exist behind one flag
(plan: `docs/superpowers/plans/2026-11-13-engine-rebuild.md`):

- `walker` (default) — the hand-rolled IR walker (`lib/build/agentic-graph.ts`).
- `langgraph` — the real `@langchain/langgraph` StateGraph under `lib/engine/`:
  `build-graph.ts` (IR → graph: four nodes per agent, supervisor `route` tool, `when` guards via
  `when.ts`, node-level tool narrowing, step budget → `recursionLimit`), `run.ts`
  (`runGraphEngine`: stream, resume, result), `checkpointer.ts` (Postgres or memory).

Environment:

- `AGENTS_ENGINE=walker|langgraph` — the platform default; a system pins the walker with
  `runtime: walker` in its `system.yaml`. `lib/engine/select.ts` is the one place that decision
  is made (route, scheduler and the MCP tool `run_agent_system` all use it, then `runOsTeam`
  branches).
- `AGENT_RUNS_DATABASE_URL` — the `agent_runs` Postgres database for LangGraph checkpoints
  (chart: `postgres.extraDatabases`; os-ui runs `PostgresSaver.setup()` at boot). Unset → an
  in-memory checkpointer, reported as `checkpointer: 'memory'` on every run.

Resume: a `langgraph` run has a `runId` (= its LangGraph thread id, on the run report and
`LastRun`). `POST /api/agents/systems/<id>/run { resume: true, runId }` continues it from its last
checkpoint; the Run panel offers **Resume** on an interrupted run. `run_agent_system` returns the
`runId` (resume over MCP arrives in A5).

Parity: `lib/engine/parity-harness.ts` + `lib/engine/fixtures/*.json` are the golden recordings
both engines must reproduce (`parity.test.ts`: P1 for both engines, HANDOFF-GUARD, P2 abort +
resume). Regenerate fixtures with ONE file, never the whole suite:
`REGEN_FIXTURES=1 node --experimental-test-module-mocks --import ./scripts/test-setup.mjs --test tabs/agents/lib/engine/fixtures.test.ts`.

## Rules that apply here

1. **Import only `@core/*` and this module.** A cross-tab need means the shared part belongs in `@core`.
2. **The kernel must not import this module.** `@core` does not know its tabs exist.
3. **Pages live in `os-ui/app/`**, thin, importing from here. Next.js serves routes only from there.
4. Every source file carries a `FEATURE:` / `USER STORY:` / `ARCHITECTURE:` header. `scripts/check-structure.mjs` enforces it as a ratchet.

See [`../../../CLAUDE.md`](../../../CLAUDE.md) for the full structure rules and [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) for the constraints this codebase punishes you for ignoring.
