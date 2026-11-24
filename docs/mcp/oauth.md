<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# Authentication for MCP clients

os-ui is both the OAuth 2.1 **authorization server** and the **resource server** for `/api/mcp`,
on one origin, with no external identity provider. Both paths below end in the same bearer
envelope (`soa_mcp_…`, HMAC-signed with `OS_MCP_TOKEN_SECRET`), verified by one function,
`resolveMcpUser` in `os-ui/core/mcp/token.ts`.

**A token is an identity assertion only.** On every call the server re-reads the user's live
account: role, domains (archived domains dropped) and active state. A role change takes effect on
the next call; a deactivated account is refused at once. OPA and row/document-level security then
apply exactly as in the UI.

## Managed authorization (OAuth 2.1)

Used by claude.ai / Claude Desktop custom connectors and Claude Code. Code: `os-ui/core/mcp/oauth.ts`,
routes under `os-ui/app/(entry)/oauth/` and `os-ui/app/(entry)/.well-known/`.

| Endpoint | Purpose |
|---|---|
| `GET /.well-known/oauth-protected-resource` (and `…/api/mcp`) | RFC 9728 resource metadata: `resource` = `<OS_PUBLIC_URL>/api/mcp`, the authorization server, scope `mcp:tools` |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 server metadata |
| `POST /oauth/register` | Dynamic client registration (public clients, `token_endpoint_auth_method: none`) |
| `GET /oauth/authorize` | Sign-in and consent; authorization code flow only |
| `POST /oauth/token` | `authorization_code` and `refresh_token` grants |

Rules the server enforces:

- **PKCE S256 is mandatory**; `response_type` must be `code`.
- **Redirect URIs are allowlisted**: `https://claude.ai/api/mcp/auth_callback`,
  `https://claude.com/api/mcp/auth_callback`, and loopback `http://localhost:<port>/callback` /
  `http://127.0.0.1:<port>/callback` (Claude Code). Anything else is refused and never redirected to.
- **Client identification**: a registered `soa_client_…` id, or a client-id metadata document URL
  on `https://claude.ai` / `https://claude.com` (hosted Claude's default). The redirect and PKCE
  rules apply to both.
- **Authorization codes** live 60 seconds and are single-use.
- **Access tokens** carry `aud` (the MCP resource), `scope` and `exp`; they live 180 days, so a
  connection made once lasts a programme. **Refresh tokens** rotate on use (a reused one is
  `invalid_grant`). Registered clients and refresh tokens survive a pod restart (durable mirror);
  codes deliberately do not.
- `OS_PUBLIC_URL` must be set to the public origin: the issuer and resource are derived from it.

## Personal bearer token

Minted on **My MCP access** (`GET /api/mcp/token`, cookie session). It encodes only the user id
and has no expiry. Clients send it as `Authorization: Bearer <token>`. Use it where a client
cannot run the OAuth flow (ChatGPT, Codex, `mcp-remote`, scripts).

## Revocation — what exists today

- **Deactivating the user** (Platform → Users & Access) refuses every token and OAuth grant of
  that user on the next call.
- **Rotating `OS_MCP_TOKEN_SECRET`** (Secret `os-ui-session`) invalidates every MCP token and
  OAuth access/refresh token of the install; everyone reconnects.
- **Pending:** there is no per-token or per-client revocation yet (one leaked personal token can
  only be cut off by deactivating the user or rotating the install secret). The connect card's
  "revocable any time" wording refers to the two options above.

## Smoke test

`os-ui/scripts/oauth-smoke.sh` walks discovery, registration, authorize and token against a
running install. The unit tests are `os-ui/core/mcp/oauth.test.ts`, `token.test.ts`,
`token-live-user.test.ts` and `auth.test.ts`.
