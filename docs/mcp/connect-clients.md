<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# Connecting an MCP client to the OS

Every user connects their own client; the client then acts as that user. The in-app page
**My MCP access** (`/mcp`; in the account menu under your name for builder and above, and open to every signed-in user at that address) shows your endpoint and your
personal token and generates the snippets below with your values filled in.

Your endpoint is `https://<your-os-host>/api/mcp` (the external door with toolsets; see
[README.md](README.md#endpoints)). For a single tab use `https://<your-os-host>/api/mcp/<tab>`.

There are two ways to authenticate, both described in [oauth.md](oauth.md):

- **Managed authorization (OAuth 2.1)** — the client opens an OS sign-in window. No token to copy.
  Supported for claude.ai / Claude Desktop custom connectors and for Claude Code.
- **Personal bearer token** — `Authorization: Bearer soa_mcp_…`, copied from My MCP access. For
  clients that take a token (ChatGPT, Codex, `mcp-remote`, scripts). Treat it like a password.

## Claude (claude.ai and Claude Desktop)

1. **Settings → Connectors → Add custom connector.**
2. Paste the endpoint URL. Leave the other fields empty.
3. Choose **managed authorization**. An OS sign-in window opens; sign in with your OS account and
   click **Approve**.
4. In a chat, enable the connector in the tools menu. Try: *"Who am I in the Sovereign OS, and
   which datasets can I see?"*

Older Claude Desktop builds without custom connectors can use the config-file fallback through
`mcp-remote` with the bearer token (Settings → Developer → Edit Config, then restart):

```json
{
  "mcpServers": {
    "sovereign-os": {
      "command": "npx",
      "args": ["mcp-remote", "https://<your-os-host>/api/mcp",
        "--header", "Authorization: Bearer <your-token>"]
    }
  }
}
```

## Claude Code

```bash
claude mcp add --transport http sovereign-os https://<your-os-host>/api/mcp \
  --header "Authorization: Bearer <your-token>"
```

Without the `--header`, Claude Code runs the OAuth flow instead (it uses a loopback
`http://localhost:<port>/callback` redirect, which the OS accepts). Check with `/mcp`.

## ChatGPT

1. **Settings → Connectors** (enable *Developer mode* if asked) → **Add custom connector**.
2. Paste the endpoint URL as the MCP server URL.
3. Authentication: **Access token / API key** → paste your personal token.
4. Save, then enable the connector in the composer's tools.

ChatGPT uses the token path: the OS's OAuth redirect allowlist holds Claude's callback and
loopback addresses only.

## Codex (OpenAI CLI / desktop)

```bash
launchctl setenv SOVEREIGN_AGENTIC_OS_TOKEN '<your-token>'   # macOS; keep the single quotes
codex mcp add sovereign-os \
  --url https://<your-os-host>/api/mcp \
  --bearer-token-env-var SOVEREIGN_AGENTIC_OS_TOKEN
codex mcp get sovereign-os   # expect enabled: true, transport: streamable_http
```

Quit and reopen Codex so it reads the variable. Do not use `codex mcp login`; the OS uses the
bearer-token setup.

## Any other client

The server speaks MCP protocol version `2025-06-18` over Streamable HTTP, JSON-RPC 2.0 (single
requests and batches). A minimal session:

```bash
H='Authorization: Bearer <your-token>'
curl -si https://<your-os-host>/api/mcp -H "$H" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'          # note the Mcp-Session-Id header
curl -s https://<your-os-host>/api/mcp -H "$H" -H 'Mcp-Session-Id: <id>' -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"whoami","arguments":{}}}'
```

## After connecting

- Ask questions directly; the model calls the read tools (`list_*`, `get_*`, `query_data`,
  `query_metric`, `search_knowledge`, `find`).
- To build, the model calls `whoami`, reads `get_guide('<pathway>')`, and loads the toolset it
  needs with `load_toolset` (for example `{"name":"data"}` before `create_dataset`).
- If a tool you expect is missing, your client fetched its tool list before the tool existed or
  before the toolset was loaded: reconnect, or call `load_toolset`. `list_capabilities` always
  lists every tool with its floor and toolset.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| HTTP 401 | Missing or invalid bearer, a deactivated account, or an account that has not finished first-run setup. Mint a fresh token in My MCP access, or sign in again. |
| HTTP 404 `Unknown MCP session` | The server no longer knows your `Mcp-Session-Id` (for example after a restart). Reconnect; the client re-initializes. |
| `toolset_not_loaded` | Call `load_toolset` with the toolset named in the hint, then retry. |
| `forbidden` naming a role | The tool's floor is above your role. Keep the work in My scope or file `request_promotion`. |
| A tool is in `list_capabilities` but not callable | The client's tool list is older than the server's. Reconnect the MCP server. |
