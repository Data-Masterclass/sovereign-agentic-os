<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# `sos` CLI — Roadmap (Phase 1+)

Phase 0 (shipped in this directory) is a thin, governed MCP client:
`login` (PKCE loopback), `whoami`, `datasets list/get`, `query`. Profiles + keychain +
refresh rotation. Below is the path forward, drawn from
`docs/research/developer-mode-cli.md`.

## Phase 1 — Typed REST for high-volume verbs + distribution
- **`/api/v1` stable read contract.** Per the MCP-vs-CLI tradeoff (MCP is token-heavy
  and string-typed — 4–32× more tokens for deterministic tasks), back **deterministic
  bulk verbs** (large query-result streaming, `runs tail`, repo listing) with a small,
  explicitly-versioned governed REST surface reusing the *same* `queryRun(sql, principal)`
  / governed lib functions — so OPA + RLS at the Trino/Cube layer are inherited
  unchanged. Keep MCP for identity + governed mutations. No new governance either way.
- **Device-code fallback (RFC 8628)** for headless/SSH logins where a browser loopback
  isn't reachable. The AS already does PKCE + loopback; device flow is incremental.
- **Tighten the CLI token TTL** to a short access token + silent refresh (refresh
  rotation already implemented here), rather than the 180-day MCP token.
- **Distribution via GoReleaser** — one `git tag` → signed binaries + checksums +
  auto-updated **self-hosted Homebrew tap** (`brew install <instance>/tap/sos`),
  Scoop, `.deb`/`.rpm`, and a container image. Sovereignty-first channels:
  `curl -fsSL https://<instance>/install.sh | sh` and a **Forgejo-hosted tap** so no
  github.com sits in the trust path (EU-sovereign posture).

## Phase 2 — Devcontainer + per-user git
- Ship `devcontainer.json` + a Feature that pre-installs `sos`, wires the OS MCP
  endpoint, and pre-clones the user's governed repos — "OS context on your own machine."
- **`sos clone` / `pull` / `push`** through **server-minted, short-lived, domain-scoped
  Forgejo tokens** (retiring the shared service account for human flows), handed to a
  `sos git` credential helper that refreshes on demand rather than storing a long-lived
  secret.

## Phase 3 — Git-push-through-policy apply pipeline
- `sos push` proposes a change; a Forgejo Actions job runs **OPA/Conftest validation →
  governed apply into the registry → Cube regenerate**, gated by the existing
  promotion ladder. **Registry stays authoritative for compute** (Terraform-style
  plan → policy → apply); git remains a downstream mirror/proposal — no two sources of
  truth.

## Phase 4 — Typed SDK + VS Code extension
- Generate `@sovereign-os/sdk` (npm) + `sovereign-os` (PyPI) from the `/api/v1`
  contract, so scripting/CI gets a typed client and the CLI's deterministic verbs are
  compile-time robust.
- A Databricks-style **VS Code extension** (browse governed datasets/metrics, run
  governed queries, view runs, one-click deploy) over the same CLI/REST/MCP surface.

## Invariants across all phases
- **Front door, not back door.** Every verb hits the same governed lib function the UI
  calls — OPA + row/doc security + audit unchanged.
- **Tokens are secrets** — keychain / `0600`, PKCE-or-device-minted, identity-only,
  never logged or committed. Refresh rotation on every use.
