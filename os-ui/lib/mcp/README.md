<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# MCP

The **governed MCP surface** of the Sovereign Agentic OS — the single JSON-RPC 2.0
server a user imports into Claude, ChatGPT, or any MCP-capable host. Every tool
exposed here delegates to the **exact same governed library function** that the UI
calls; there is no privileged side-channel. The HTTP shell lives in
`app/api/mcp/route.ts`; `server.ts` is a pure, transport-free dispatcher.

## Golden path

1. **Connect** — the user imports the MCP URL into their AI client. `oauth.ts` runs
   the Ory-based OAuth 2.1 flow; `token.ts` mints a short-lived bearer token that
   encodes identity + role.
2. **Initialize** — the client sends `initialize`; `buildInstructions()` returns
   tab-scoped usage guidance. `toolsForTab` + `listToolsForRole` filter the visible
   tool set to what this role may call on this tab.
3. **Discover** — `resources.ts` advertises `RESOURCES` and templates; `prompts.ts`
   provides the `PROMPTS` library so AI clients can offer guided actions.
4. **Call** — `handleRpc` routes each `tools/call` to the underlying governed
   function. Write-capable tools (`ALL_WRITE_TOOLS`) that carry `requires_approval`
   park their decision in `pending.ts` until a human approves.
5. **Approve or reject** — the platform admin or domain admin resolves the pending
   item; the queued call is replayed or discarded.

## Public API

Import via `@/lib/mcp/server` — no internal files directly.

- **`server.ts`** — `handleRpc`, `toolsForTab`, `listToolsForRole`. The authoritative
  dispatcher; all transport concerns live in `app/api/mcp/route.ts`.
- **`write-tools.ts`** — `ALL_WRITE_TOOLS`: the complete governed write surface.
- **`discovery-tools.ts`** — `DISCOVERY_TOOLS`: read/search tools, always safe.
- **`governance-tools.ts`**, **`strategy-tools.ts`**, **`marketplace-tools.ts`**,
  **`monitoring-tools.ts`**, **`manual-tools.ts`** — per-domain tool bundles assembled
  into the dispatcher.
- **`resources.ts`** — `RESOURCES`, `resourcesForTab`, `templatesForTab`.
- **`prompts.ts`** — `PROMPTS`, `renderPrompt`, `promptsForTab`.
- **`instructions.ts`** — `buildInstructions(tab)` for `initialize.instructions`.
- **`oauth.ts`** — MCP OAuth 2.1 token flow (Ory-backed).
- **`token.ts`** — bearer token mint + verify.
- **`pending.ts`** — pending-approval queue for `requires_approval` decisions.
- **`http.ts`** — Streamable-HTTP transport utilities.
- **`tabs.ts`** — tab-scoped tool visibility map.

Test coverage: `mcpv2-p0.test.ts` (promotion seam invariant), `wave-a.test.ts`,
`wave-b.test.ts`, and per-domain test files.

## Invariants & Dependencies

**Invariants**

- **No privileged path.** Every MCP tool calls the governed library function the UI
  calls — no bypassing OPA, egress proxy, or audit trace.
- **Role is a floor, not a ceiling.** `listToolsForRole` is conservative; the
  underlying governed function re-checks authorization on every invocation.
- **Promotion seam enforced.** `promoteConnection` is called only via
  `lib/governance/ladder.ts` — tested by `mcpv2-p0.test.ts`.
- **Write-behind approval.** Tools in `ALL_WRITE_TOOLS` that set `requires_approval`
  never execute inline; they park in `pending.ts`.

**Dependencies**

- `lib/core` — identity, config, types.
- `lib/infra` — OPA, Langfuse, secrets.
- All tab modules (`lib/connections`, `lib/data`, `lib/metrics`, `lib/dashboards`,
  `lib/knowledge`, `lib/files`, `lib/agents`, `lib/software`, `lib/governance`,
  `lib/strategy`, `lib/marketplace`, `lib/monitoring`).
