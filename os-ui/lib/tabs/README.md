<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# Tabs

`lib/tabs/` provides per-tab context loading, in-app guide content, and Software-tab
build-spec utilities consumed by the agentic assistant, the MCP layer, and the
`get_guide` / `sovereign-os://guide/*` resource surface. It is `server-only` — nothing
here is imported by client components.

## Public API

### `context.ts` (`server-only`)

- **`loadTabContext(tab: McpTab)`** — reads `lib/tabs/<tab>.context.md` from disk once
  (Map-cached per process). Returns the token-minimal brief fed into the agent's system
  prompt and the MCP `initialize.instructions` field. Missing file → empty string (the
  assistant still works, just ungrounded for that tab).
- **`tabTitle(tab)`** — returns the human-readable tab name for a given `McpTab` key.
- **`contextForAgentKey(agent)`** — returns the tab context for a given agent-system
  key (e.g. `'campaign-manager'` → `data` tab context).
- **`tabForAgentKey(agent)`** — resolves an agent-system key to its `McpTab`, or `null`
  if unmapped.

Called by `lib/assistant/runtime.ts` (system-prompt assembly) and `lib/mcp/server.ts`
(`initialize` handler).

### `<tab>.context.md` files

One per OS tab (14 total): `agents`, `bigbets`, `connections`, `dashboards`, `data`,
`files`, `governance`, `knowledge`, `marketplace`, `metrics`, `monitoring`, `science`,
`software`, `strategy`. These are the tab-scoped briefs the agent receives; editing them
tunes assistant behaviour for that tab without a code change.

### `build-spec.ts` / `build-spec/`

- **`loadBuildSpec()`** — reads `lib/tabs/build-spec/software.md` from disk (cached).
  Serves the `sovereign-os://guide/build-spec/software` MCP resource, consulted by the
  Software-tab agent when scaffolding an application build spec.
- `software.build-spec.test.ts` asserts the file is present and non-empty on every CI run.

### `guides.ts` / `guides/`

- **`GUIDE_PATHS`** — exhaustive list of guide slugs available as
  `sovereign-os://guide/<path>` MCP resources.
- **`GuidePath`** type / **`isGuidePath(x)`** predicate.
- **`loadGuide(path)`** — reads `lib/tabs/guides/<path>.md` (cached). Missing file → empty
  string.
- **`guideTitle(path)`** — human title for a guide path (used in MCP resource listings).

Called from `lib/mcp/server.ts` (resource list + read handlers) and the `get_guide` tool.

## Dependencies

- **`lib/mcp/server`** — for the `McpTab` type (import type only).
- Node.js `fs` / `path` — disk reads at startup (server-only).

## Invariants

- **`server-only`** guard at the top of `context.ts` — prevents accidental client bundle
  inclusion of disk-read code.
- **Graceful degradation on missing files.** Both `loadTabContext` and `loadGuide` return
  `''` on `ENOENT`; the assistant continues with a degraded (ungrounded) prompt rather
  than crashing.
- **All context loading is cached per process.** Files are read once; subsequent calls
  return the cached string. Cache is not invalidated at runtime — a pod restart picks up
  any edited `.context.md` or guide file.
