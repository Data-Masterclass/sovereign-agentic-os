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

1. **Connect** — the user imports the MCP URL into their AI client. `oauth.ts` is the
   **OS-native OAuth 2.1 Authorization Server** (AS + Resource Server on one origin, no
   external IdP); `token.ts` mints a **long-lived** bearer token (no `exp` — a one-time
   copy-paste import) that encodes identity + role.
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

Import via `@core/mcp/server` (and the named modules below) — the dispatcher is the authority.

- **`server.ts`** — `handleRpc`, `ALL_MCP_TOOLS`, `toolsForTab`, `listToolsForRole`, `structuredError`.
  Transport concerns live in `http.ts` (`serveMcp`), called by `app/api/mcp/route.ts` and
  `app/api/mcp/[tab]/route.ts`.
- **`registry.ts`** + **`register-base.ts`** / **`register-experimental.ts`** — tool bundles register
  here (flag-gated by the install's enabled tabs); the tabs' `mcp/` folders hold the tool definitions.
- **`fast-surface.ts`** / **`find-tools.ts`** — the external `/api/mcp` door: a small read/find core,
  named toolsets loaded with `load_toolset`, compact paginated lists and the cross-artifact `find`.
- **`resources.ts`** (filters `tabs/admin/mcp/resources.ts`) — guides, `my/*` inventories, by-id templates.
- **`prompts.ts`** — one prompt per golden path. **`instructions.ts`** — `initialize.instructions`.
- **`deprecated-aliases.ts`** — old tool names that still resolve for one release.
- **`oauth.ts`** — OS-native OAuth 2.1 authorization server. **`token.ts`** — bearer mint + verify.
- **`reference.ts`** — renders `docs/mcp/tool-reference.md` (`scripts/gen-mcp-reference.ts`).
- **`pending.ts`** — approver lookup for held writes.

User-facing docs: `docs/mcp/` (how-to, connecting clients, OAuth, the generated tool reference).

Test coverage: `surface-matrix.test.ts` (every tool × role: schema, examples, floors on both doors,
name hygiene, guides, doc freshness), `mcp-conformance.test.ts` (typed refusals per tool),
`fast-surface.test.ts`, `mcpv2-p0.test.ts`, `wave-a.test.ts`, `wave-b.test.ts`, and per-domain files.

## Invariants & Dependencies

**Invariants**

- **No privileged path.** Every MCP tool calls the governed library function the UI
  calls — no bypassing OPA, egress proxy, or audit trace.
- **Role is a floor, not a ceiling.** `listToolsForRole` is conservative; the
  underlying governed function re-checks authorization on every invocation.
- **Promotion seam enforced.** `promoteConnection` is called only via
  the governance ladder — tested by `mcpv2-p0.test.ts`.
- **Write-behind approval.** Tools in `ALL_WRITE_TOOLS` that set `requires_approval`
  never execute inline; they park in `pending.ts`.

**Dependencies**

- `core/kernel` — identity, config, roles.
- `core/infra` — OPA, Langfuse, secrets, request surface.
- The tab modules' `mcp/` and `lib/` folders (through the registry, never a privileged import).
