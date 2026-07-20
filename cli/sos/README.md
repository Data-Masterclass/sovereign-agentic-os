<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# `sos` — the Sovereign Agentic OS developer CLI (Phase 0)

`sos` is a **thin, governed client** for the Sovereign Agentic OS. Every command runs
**as the logged-in user** through the OS **MCP front door** — the same governed path
the web UI uses. The CLI holds only a short-lived OAuth token; **role, domains, OPA
policy and row/document-level security are re-resolved live on the server for every
call.** There is no privileged side-channel and no way to bypass governance.

Commands: `login`, `whoami`, `datasets list`/`datasets get`, `query`, `push`, and
`install`. `push` is the developer-mode commit-through-policy verb (see
[`docs/developer-mode.md`](../../docs/developer-mode.md)). See
[`ROADMAP.md`](./ROADMAP.md) for what's shipped vs planned.

## Install

Phase 0 builds from source (distribution channels — Homebrew tap, `curl | sh` from
your instance, signed binaries — come in a later phase, see ROADMAP):

```sh
cd cli/sos
go build -o sos .
# optionally: mv sos /usr/local/bin/
```

Requires Go 1.22+.

## Commands

```
sos login <os-url>          Sign in to an OS instance (OAuth 2.1 PKCE loopback)
sos logout                  Remove stored tokens for a profile
sos whoami                  Show your identity, role and domains
sos datasets list           List datasets you can see (MCP list_datasets)
sos datasets get <id>       Show one dataset (MCP get_dataset)
sos query "<nl or sql>"     Run a governed query (MCP query_data)
sos query --metric <id>     Query a metric (MCP query_metric)
sos push --app <id> --dir . Push local app/analytics code through governed commit
sos git setup               Configure git to use sos as the Forgejo credential helper
sos clone <repo>            Clone a governed Forgejo repo (configures the helper)
```

### `sos push` — commit through policy

`sos push` diffs a local working dir of app/analytics source against the app's
current governed tree and submits the changed files through the governed `commit`
MCP tool — **as you**, the same governed change the Software tab UI makes (not a raw
git push). `--dry-run` previews the diff and submits nothing; `--promote` files a
`request_promotion` after the push (a creator files, a builder approves). It reads
the current tree via `read_app_files` and **never deletes** governed files (a
changeset merges over the prior tree). A policy DENY surfaces via the normal typed
error path. Full guide: [`docs/developer-mode.md`](../../docs/developer-mode.md).

```sh
sos push --app app_123 --dir ./my-app --dry-run          # preview only
sos push --app app_123 --dir ./my-app -m "add model"     # submit
sos push --app app_123 --dir ./my-app -m "ship" --promote# submit + request promotion
```

### `sos git` — governed git via a credential helper

`sos git setup` writes a `git config --global credential.<forgejo-host>.helper` entry
pointing at this `sos` binary, so raw `git clone/pull/push` against the governed
Forgejo host authenticate **as you**. When git needs a password, it invokes
`sos git credential get`, which mints a **short-lived, domain-scoped Forgejo token**
server-side (`POST /api/git/token`, authenticated with your existing OS session),
caches it **in memory + a 0600 file keyed by host only while within its TTL**, and
re-mints transparently once expired. `store` is a no-op (a git-supplied token is
never trusted); `erase` clears the host's cache; an unknown host is passed through
untouched. The minted token is never logged and never printed except in the exact
`password=` line git requires; `sos logout` purges the cache. `sos clone <repo>` runs
`setup` implicitly. Model: [`docs/decisions/0006-git-identity-model.md`](../../docs/decisions/0006-git-identity-model.md).

```sh
sos git setup                    # once per machine/profile
sos clone analytics              # clone owner-less shorthand against your Forgejo host
git -C analytics push            # raw git just works — sos supplies the credential
```

Global flags: `--profile <name>` (target a specific instance), `--help`, `--version`.
`datasets list`, `whoami`, `query` accept `--json` where a table is otherwise shown.

```sh
sos login https://os.example.eu
sos whoami
sos datasets list
sos query "orders in the last 30 days by region"
```

## How login / PKCE works

`sos login` performs the **OAuth 2.1 Authorization Code + PKCE (S256) loopback flow**
against the OS authorization server (os-ui is both Authorization Server and Resource
Server on one origin). It reuses the SAME endpoints the UI/MCP clients use — the
`http://127.0.0.1/callback` loopback redirect is already on the server's allowlist:

1. **Discover** — `GET <os-url>/.well-known/oauth-authorization-server` (RFC 8414)
   returns the `authorization_endpoint`, `token_endpoint`, `registration_endpoint`.
2. **Bind loopback** — the CLI binds an ephemeral `127.0.0.1:<port>` listener, so the
   redirect URI is `http://127.0.0.1:<port>/callback` (allowlisted, port-agnostic).
3. **Register** — Dynamic Client Registration (RFC 7591) `POST /oauth/register` with
   that redirect URI returns a public `client_id` (no client secret; the server is
   `token_endpoint_auth_method: none`). The `client_id` is saved to the profile.
4. **Authorize** — the CLI generates a PKCE verifier + S256 challenge and a random
   `state`, then opens the browser to `/oauth/authorize?...&code_challenge=...&
   code_challenge_method=S256&state=...`. You approve in the browser under your OS
   identity.
5. **Callback** — the server redirects to the loopback listener with `?code=...&state=...`.
   The CLI checks `state` (CSRF) and closes the browser tab with a confirmation page.
6. **Exchange** — `POST /oauth/token` (`grant_type=authorization_code`) with the
   `code_verifier` returns an **access token** (the MCP identity bearer) and a
   **refresh token**.

The access token is an **identity-only** assertion — it carries `userId` only; role
and permissions are resolved live server-side on every `/api/mcp` call, so a token is
never a frozen capability and revocation is immediate.

### Token storage (tokens are secrets)

Tokens are stored in the **OS keychain** via a cross-platform keyring
(macOS Keychain / GNOME libsecret / Windows Credential Manager). If no keyring is
available (e.g. a headless Linux box), the CLI falls back to a **`0600` file** under
`~/.config/sos/tokens/<profile>.json`. Tokens are **never printed and never written to
`config.toml`**. `sos logout` removes them from both backends.

### Refresh-token rotation

When the stored access token is expired (or within a 30s leeway), the CLI silently
calls `POST /oauth/token` (`grant_type=refresh_token`). The server **rotates the
refresh token on every use**; the CLI persists the new token set. If refresh fails,
the CLI tells you to `sos login` again — it never fakes success.

## Profiles (multi-instance, like `aws`)

One CLI can target several OS instances. Config lives in **`~/.config/sos/config.toml`**
(respecting `XDG_CONFIG_HOME`), `0600`:

```toml
default_profile = "prod"

[profiles.prod]
base_url  = "https://os.example.eu"
client_id = "soa_client_…"       # learned via DCR at login; used for refresh

[profiles.staging]
base_url  = "https://staging.os.example.eu"
client_id = "soa_client_…"
```

Select a profile with `--profile`:

```sh
sos login --profile staging https://staging.os.example.eu
sos --profile staging whoami
```

The **first** profile you create becomes the default. Tokens are keyed per profile in
the keychain, so instances never share credentials.

## MCP endpoints used

| Purpose            | Endpoint                                                  |
|--------------------|----------------------------------------------------------|
| Discovery (RFC 8414) | `GET  /.well-known/oauth-authorization-server`         |
| Dynamic Client Reg (RFC 7591) | `POST /oauth/register`                        |
| Authorize (PKCE S256) | `GET  /oauth/authorize`                               |
| Token / refresh    | `POST /oauth/token`                                       |
| Governed tool calls | `POST /api/mcp` (JSON-RPC 2.0, `tools/call`, Bearer)     |

MCP tools invoked: `whoami`, `list_datasets`, `get_dataset`, `query_data`,
`query_metric`, `read_app_files`, `commit`, `request_promotion`. Each maps 1:1 to an
existing governed MCP tool — the CLI adds **zero new server governance**.

## Errors (honest, never a fake success)

- **401** → `not authenticated (401) — run: sos login`
- **Governed deny (403 / `forbidden` tool error)** → the server's typed reason **and
  hint** are printed (e.g. "requires builder; you are creator").
- Tool errors (`not_found`, `bad_request`, `conflict`) surface the server's message
  verbatim.

## Design notes

- **Thin over MCP.** Phase 0 is a JSON-RPC 2.0 client over `/api/mcp`. High-volume
  deterministic verbs move to a typed `/api/v1` REST contract in Phase 1 (see ROADMAP)
  per the research's MCP-vs-CLI tradeoff.
- **No back door.** Every verb hits the same governed library function the UI calls;
  OPA + row/doc security + audit apply unchanged.
- Source: `docs/research/developer-mode-cli.md` (design), `os-ui/lib/mcp/oauth.ts`
  (the AS the CLI targets).
