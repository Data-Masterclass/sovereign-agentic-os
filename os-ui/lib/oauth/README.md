<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# OAuth

Manages **OAuth 2.1 / PKCE flows** for personal Drive connections — Google Drive and
OneDrive. This module is the plumbing underneath `lib/connections`: it builds the
authorization URL, handles the callback, exchanges codes for tokens, and keeps
access/refresh token pairs alive. Secrets never leave — tokens are stored as
`secretRef` entries, not raw values. Scopes are read-only by design.

## Golden path

1. **Start** — `buildAuthorizationUrl(provider, state, codeChallenge)` assembles the
   provider's authorization endpoint URL from `OAUTH_PROVIDERS`.
2. **PKCE** — `pkce.ts` generates the `code_verifier` / `code_challenge` pair before
   the redirect; the verifier is stored in the session and never sent to the provider.
3. **CSRF** — `signState` / `verifyState` in `state.ts` protect the round-trip; the
   signed state parameter is validated on callback before any token exchange begins.
4. **Exchange** — `handleRedirect` in `redirect.ts` exchanges the authorization code
   for an access + refresh token via `client.ts`.
5. **Store** — `storeTokenSet` in `token-set.ts` persists the pair under a
   `secretRef` in the connections store; the raw values are discarded.
6. **Refresh** — `refreshAccessToken` in `token-set.ts` silently renews before
   expiry; `drive-status.ts` probes reachability without exposing the token.
7. **Revoke** — `revokeToken` in `connection-token.ts` cleans up on connection
   delete or rotation.

## Public API

- **`providers.ts`** — `OAUTH_PROVIDERS`: auth/token URLs + minimal read-only scopes
  for `google` and `microsoft`. Pure + client-safe (contains no secrets).
- **`pkce.ts`** — `generatePkce()`: returns `{ verifier, challenge, method }`.
- **`state.ts`** — `signState(payload)`, `verifyState(raw)`: CSRF-safe round-trip.
- **`redirect.ts`** — `buildAuthorizationUrl`, `handleRedirect`: redirect lifecycle.
- **`token-set.ts`** — `storeTokenSet`, `loadTokenSet`, `refreshAccessToken`: token
  storage and silent renewal (server-only).
- **`connection-token.ts`** — `mintToken`, `refreshToken`, `revokeToken`: the
  Connections-store-integrated lifecycle (server-only).
- **`oauth-apps.ts`** — `getOAuthApp(provider)`: admin-configured `client_id` +
  `redirect_uri` per provider (no `client_secret` in this module).
- **`drive-status.ts`** — `probeDrive(connection)`: reachability probe used by
  `testConnection`; reads a single root-folder listing, returns boolean.
- **`notion-flow.ts`** — Notion OAuth authorization + callback flow.
- **`notion-mcp.ts`** — Notion MCP token binding (mints a Notion session for the MCP
  surface from an existing OAuth token).
- **`client.ts`** — `tokenExchange(url, params)`: low-level POST to token endpoints.

## Invariants & Dependencies

**Invariants**

- **Read-only scopes.** `OAUTH_PROVIDERS` defines the minimal read-only scope list;
  no write scope may be requested via this module.
- **Secrets are references.** Raw access/refresh tokens are held in memory only for
  the exchange duration; persisted values are always `secretRef` objects.
- **PKCE required.** Every authorization code flow must carry a `code_challenge`;
  implicit flows are not supported.
- **CSRF on every round-trip.** The signed `state` parameter is verified before the
  code exchange begins; mismatches abort immediately.

**Dependencies**

- `lib/core` — identity, config, base types.
- `lib/connections` — schema (`Connection`, `secretRef`) + store (token persistence).
- `lib/files` — connector map (determines which connector handles a given provider).
