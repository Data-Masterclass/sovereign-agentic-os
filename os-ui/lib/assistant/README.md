<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# Assistant

`lib/assistant` is the **agentic assistant harness** — the two-tier PLAN→ACT loop
that powers every in-app helper and the Software build chat. The core loop
(`agentic.ts`) is pure and IO-injected for testability; `runtime.ts` wires it to
the OS system prompt, per-tab CONTEXT.md files, role-scoped MCP tool schemas, and
the governed executor — the same `handleRpc` path the MCP route uses, with no
privileged shortcut.

## Golden path

A tab assistant call follows this sequence:

1. **Route** — `app/api/assistant/[tab]/route.ts` (or the software build route)
   calls `runTabAssistant(req)` from `runtime.ts`.
2. **Compose context** — `runtime.ts` assembles: OS-rules system prompt + tab's
   `CONTEXT.md` + the caller's role-scoped MCP tool schemas.
3. **PLAN** — `runAgentic` sends the assembled context to the reasoning model
   (`resolveAssistantModelId('plan')`). The plan enumerates tool calls and
   expected outcomes.
4. **ACT** — The execution model (`resolveAssistantModelId('act')`) works through
   the plan, calling `governed executor → handleRpc` for each tool invocation.
   OPA-authorization and Langfuse tracing apply exactly as in the MCP route.
5. **Repeat** — steps 3–4 iterate up to `assistantMaxSteps` rounds; the loop
   breaks early on a final answer or on a hard stop signal.
6. **Stream** — `agent-loop.ts` wraps the loop output in SSE events consumed by
   the tab's `<AssistantPanel>`.

## Public API

- **`agentic.ts`** — `runAgentic(opts)`: the pure PLAN→ACT loop. IO is injected
  via `opts.planModel` / `opts.actModel` / `opts.executor` so the loop is fully
  unit-testable without network calls.
- **`runtime.ts`** — `runTabAssistant(req, tabId)`: server wiring. Resolves
  models, compiles context, binds the governed executor, then delegates to
  `runAgentic`. This is the only public entry point for route handlers.
- **`complete.ts`** — `resolveAssistantModelId(tier)`: maps `'plan'` / `'act'`
  to concrete model IDs from the admin-configured model table. Never hardcodes a
  model name.
- **`agent-loop.ts`** — SSE streaming wrapper. Translates `runAgentic` async
  generator output to a `ReadableStream` for `Response` objects.

Test suite: `agentic.test.ts` (loop logic), `runtime.test.ts` (context assembly
and executor binding), `budget-messages.test.ts` (context-window budgeting and
truncation behaviour).

## Invariants

- **No privileged tool path.** The governed executor calls `handleRpc`, the
  identical function used by the MCP route. OPA, tracing, and RLS apply to every
  assistant tool call — no exceptions.
- **Models are configurable.** `resolveAssistantModelId` reads from the admin
  model table. Hard-coding a model name here is a policy violation.
- **Loop is pure.** `agentic.ts` has no imports from `lib/infra` or `lib/tabs`;
  all IO arrives through injected options. Tests must not require a running
  backend.
- **Step cap is enforced.** The loop exits after `assistantMaxSteps` plan→act
  cycles regardless of tool results, preventing unbounded inference spend.

## Dependencies

| Imports from | — |
|---|---|
| Internal `lib/` | `lib/core`, `lib/infra`, `lib/mcp`, `lib/tabs`, `lib/models` |
| Entry point callers | `app/api/assistant/*/route.ts`, software build route |

`lib/assistant` is a leaf consumer — nothing in `lib/core` or `lib/infra`
imports it.
