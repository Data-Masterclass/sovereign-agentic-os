<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# The OS MCP server

The Sovereign Agentic OS serves one governed MCP server. Claude, ChatGPT, Codex, Claude Code
or any other MCP client can connect to it and work **as the signed-in user**: every call is
role-checked, OPA-policy-checked, row/document-level filtered and audit-traced, through the same
governed functions the UI calls. It is a front door, not a back door. Nothing an MCP client does
can exceed what the same user could do in the UI.

| Page | What it covers |
|---|---|
| [connect-clients.md](connect-clients.md) | Connecting Claude (claude.ai / Desktop), Claude Code, ChatGPT, Codex and other clients |
| [oauth.md](oauth.md) | How sign-in works: OAuth 2.1 (managed authorization) and the personal bearer token |
| [tool-reference.md](tool-reference.md) | Every tool: role floor, toolset, arguments, an example. Generated from the registry |

The code lives in `os-ui/core/mcp/` (dispatcher `server.ts`, transport `http.ts`, OAuth `oauth.ts`,
token `token.ts`, the fast external surface `fast-surface.ts`), see
[`os-ui/core/mcp/README.md`](../../os-ui/core/mcp/README.md).

## Endpoints

| Endpoint | Serves |
|---|---|
| `POST /api/mcp` | The **external door**: every tool, but only a small core of read/find tools is listed at connect. Build, promote and admin tools are grouped into named **toolsets** that a client loads with `load_toolset({name})` (the server then sends `notifications/tools/list_changed`). Lists come back compact and paginated (`limit`, `offset`, `detail: true` for full records). `Mcp-Session-Id` is assigned at `initialize`. |
| `POST /api/mcp/<tab>` | A **per-tab lens** (`data`, `knowledge`, `workflows`, `files`, `metrics`, `dashboards`, `agents`, `software`, `connections`, `governance`, `monitoring`, `operating-manual`): that tab's tools plus `whoami` / `list_capabilities` / `get_guide`, all listed at once, no toolsets. Same governance. |
| `GET /api/mcp` | The idle server-to-client SSE stream (Streamable HTTP; hosted Claude opens it on connect). |

The toolsets on `/api/mcp` are `data`, `knowledge`, `files`, `analytics` (metrics and
dashboards), `agents`, `software`, `connections`, `governance` and `platform`. A tool whose
toolset is not loaded answers `toolset_not_loaded` with the exact `load_toolset` call that fixes
it. Loading widens the list only: every tool still runs as you and passes its role floor.

## What a model should do

The server sends this orientation in `initialize.instructions`; in short:

1. **A question** ("which datasets do I have?", "what was revenue last quarter?") — call the
   matching read tool directly: `list_datasets` / `query_data`, `list_metrics` / `query_metric`,
   `list_files` / `search_files`, `list_knowledge` / `list_workflows` / `search_knowledge`,
   `list_dashboards`, `list_agent_systems`, `list_software`, `list_connections`,
   `list_approvals`, or `find` when unsure where something lives. No `whoami` first.
2. **Building or promoting** — call `whoami` (the role decides what is allowed), read the
   golden-path guide (`get_guide('<pathway>')` or the `sovereign-os://guide/path/<pathway>`
   resource), discover what already exists with the matching `list_*` tool, and reuse its ids.
3. **Errors** are typed `{code, reason, hint}` in `structuredContent.error` with `isError: true`.
   Follow the hint. The codes are `forbidden`, `not_found`, `bad_request`, `conflict`,
   `sql_error`, `toolset_not_loaded`, `upstream_error`, `ENGINE_UNAVAILABLE`, `not_built`,
   `invalid_identifier` and `invalid_cron`. An id you cannot see is `not_found`, the same as an
   id that does not exist.

## Guides, resources and prompts

| Kind | What |
|---|---|
| Guides | `sovereign-os://guide/how-to-use`, `…/overview`, `…/governance`, and one golden path per area: `sovereign-os://guide/path/<data\|knowledge\|workflows\|connections\|agents\|software\|metrics\|dashboards\|files\|monitoring>`. The same text comes from the `get_guide` tool for clients without resources. Software's advanced coded path has its own build spec: `sovereign-os://guide/build-spec/software`. |
| Inventories | `sovereign-os://my/<identity\|datasets\|knowledge\|workflows\|connections\|files\|metrics\|dashboards\|agents\|software>` — what the caller can see, from the same governed store calls as the UI. |
| By id | `sovereign-os://<dataset\|workflow\|file\|connection\|agent\|app\|dashboard>/{id}` |
| Prompts | One per golden path (e.g. `build_data_product`, `author_and_publish_workflow`, `build_and_ship_software`, `build_dashboard`, `upload_and_share_file`). A prompt renders text; it executes nothing. |

The guide files live with their tab (`os-ui/tabs/<tab>/guide.md`; cross-cutting ones in
`os-ui/core/guides/`).

## Roles and scopes

Four roles, lowest to highest: **creator** (full rights over their own My work, files promotion
requests), **builder** (+ approves software deploys with `decide_deploy`), **domain_admin**
(+ approves every My → Domain promotion in their domain: `approve_promotion`,
`publish_workflow`, `promote_connection`; `decide_approval` is listed from builder up and decides what the approver role allows), **admin** (+ certifies to
Company, policy overrides, cost caps, all user administration).

Scopes: **My → Domain → Company**. Work in My scope needs no approval. Promoting up a scope is
gated: `request_promotion` files the My → Domain request, `request_certification` the
Domain → Company one. Each tool's floor is listed in the [tool reference](tool-reference.md);
the floor is only the first gate, and the governed function re-checks ownership and scope on
every call.

### Knowledge notes and workflows are two artifacts

A **knowledge note** (`pk_…`) is a free-form markdown document: `save_knowledge_note`,
`list_knowledge`, `get_knowledge`. A **workflow** (`wf_…`) documents a business process (steps,
actors, rules, tacit know-how): `author_workflow`, `list_workflows`, `get_workflow`,
`index_workflow`, `publish_workflow`, `retire_workflow`. `search_knowledge` searches both.

The workflow tools used to be called `*_knowledge`. The old names still work for one release (same
governed tool, same floor, a deprecation line in the server log) but are no longer listed:

| Old name | Current tool |
|---|---|
| `author_knowledge` | `author_workflow` |
| `index_knowledge` | `index_workflow` |
| `publish_knowledge` | `publish_workflow` |
| `retire_knowledge` | `retire_workflow` |

### Connections across domains (pending)

Today a connection is visible to the user who owns it and, once promoted, to its domain; tools
on a connection run as the acting user. The "see, not use" rule for connections of *other*
domains (see the catalog entry, cannot call through it) is planned in PR #333 and is not part
of this server yet. This page will be updated when it lands.

## Keeping the docs true

- `tool-reference.md` is generated: `cd os-ui && node --import ./scripts/test-setup.mjs scripts/gen-mcp-reference.ts`.
- `os-ui/core/mcp/surface-matrix.test.ts` fails CI when the reference is stale, when a description,
  guide, prompt or these pages name a tool that does not exist, when a tool has no example or an
  example that does not fit its schema, when a guide pathway does not resolve, or when a role sees
  (or can call) a tool its floor does not allow — on both the internal and the external door.
