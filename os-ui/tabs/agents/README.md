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

Runs execute in-process, as the signed-in user, through the hand-rolled IR walker
(`lib/build/agentic-graph.ts`). A real LangGraph engine is being built under `lib/engine/`
(plan: `docs/superpowers/plans/2026-11-13-engine-rebuild.md`). The platform flag
`AGENTS_ENGINE=walker|langgraph` (default `walker`) picks the executor; a system can pin the
walker with `runtime: walker` in its `system.yaml`. `lib/engine/select.ts` is the one place
that decision is made; `lib/engine/parity-harness.ts` + `lib/engine/fixtures/*.json` are the
golden recordings both engines must reproduce (`REGEN_FIXTURES=1 npm test` rewrites them).

## Rules that apply here

1. **Import only `@core/*` and this module.** A cross-tab need means the shared part belongs in `@core`.
2. **The kernel must not import this module.** `@core` does not know its tabs exist.
3. **Pages live in `os-ui/app/`**, thin, importing from here. Next.js serves routes only from there.
4. Every source file carries a `FEATURE:` / `USER STORY:` / `ARCHITECTURE:` header. `scripts/check-structure.mjs` enforces it as a ratchet.

See [`../../../CLAUDE.md`](../../../CLAUDE.md) for the full structure rules and [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) for the constraints this codebase punishes you for ignoring.
