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

## Shipped — `sos git` credential helper (analytics-monorepo #146, Phase 2 / Option B)

Per-user, server-minted, short-lived, domain-scoped Forgejo tokens for raw git,
realising Phase 2 (Option B) of `docs/research/analytics-monorepo-plan.md` under
`docs/decisions/0006-git-identity-model.md`.

- **`sos git credential <get|store|erase>`** (`internal/cli/git.go` + pure
  `internal/git/`) — a git credential-helper backend. On `get`, it reads git's
  `protocol/host/path` stdin block and, for the Forgejo host, returns
  `username=<forgejo-user>` + `password=<minted-token>` from a **cache-or-mint**
  path: `POST {os-ui}/api/git/token` (authenticated with the same refreshed OS
  session as every other verb) returns a short-TTL token, cached **in memory + a
  0600 on-disk file keyed by host, only while within TTL**, and transparently
  re-minted once expired. `store` is a no-op (a git-supplied token is never
  trusted/cached); `erase` clears the host's cache. An **unknown host is a
  passthrough** — no token is minted for a host we don't own.
- **`sos git setup`** mints once to learn the Forgejo host (from the contract's
  `forgejoBaseUrl`), pins it, and writes `git config --global credential.<host>.helper`
  pointing at this `sos` binary — so raw `git clone/pull/push` against the analytics
  repo "just work" as the real user. **`sos clone <repo>`** runs setup implicitly.
- **Token hygiene:** the minted token is NEVER logged and NEVER printed except in the
  exact credential-helper `password=` line git requires; mint errors surface status
  only, never the response body; the on-disk cache is 0600, TTL-bounded, and
  **`sos logout` purges it** so no minted token outlives the session. Pure core
  (protocol parse, mint→credential mapping, TTL/refresh, cache expiry) is unit-tested
  against a fake mint endpoint incl. a "token never appears in error output" test.
- **Not live-verified** — static gates (`go build`/`vet`/`test`) pass; the real
  `git push` round-trip against live Forgejo with a minted token needs the B1 mint
  route live + Forgejo (flagged live-verify-pending).

## Shipped — Developer mode (`sos push` + devcontainer + distribution)

The developer-experience layer on top of Phase 0, documented in
`docs/developer-mode.md`.

- **`sos push`** (`internal/cli/push.go` + pure `internal/push/`) — takes a local
  working dir of app/analytics source, diffs it against the app's current governed
  tree, and submits the changed files **through the governed `commit` MCP tool** as
  the authenticated user (the SAME `commit` the Software tab UI calls — not a raw
  git push). `--dry-run` previews the diff and submits nothing; `--promote` files a
  governed `request_promotion` after the push (a creator files, a builder approves —
  the CLI can't self-approve). It reads the current tree via `read_app_files`
  (tree list + per-file content). **Never deletes**: a changeset merges over the
  prior tree, so a locally-absent file is left untouched. A policy DENY surfaces via
  the existing `ToolError`/`mapCallError` path — no fake success. Pure diff/validate
  logic (`Diff`, `BuildCommit`, `WalkDir`, `NormalizePath`) is split from I/O and
  unit-tested.
- **Devcontainer** (`.devcontainer/devcontainer.json` + `Dockerfile`) — Go 1.22 with
  `sos` prebuilt on PATH, Node 20 for os-ui, git/jq/helm/kubectl; one-command
  spin-up (`devcontainer up`).
- **Distribution** (`/.goreleaser.yaml` + `packaging/homebrew/sos.rb.template`) — one
  `git tag` → static darwin/linux amd64/arm64 binaries + `checksums.txt` + a
  **self-hosted Homebrew tap** formula. Tap owner/repo/token and the download root
  are env-driven so an EU-sovereign instance points them at its own Forgejo — no
  github.com in the trust path.
- **Not live-verified** — static gates pass (`go build`/`vet`/`test`,
  `goreleaser check`); the first push against a real OS endpoint is the acceptance
  test. `sos push` matches the shipped `commit` / `read_app_files` / `request_promotion`
  tool contracts as of this change.

This realises Phase 3's app-code push-through-policy for the **Software tab** (which
already applies a governed `commit`). The **analytics-monorepo** push-through-policy
(Forgejo Actions → OPA/Conftest → registry apply → Cube regen, per Phase 3 below) is
still future work: today analytics models are authored via guided-op MCP tools
(`transform_silver`/`build_gold_join`), not raw-SQL file pushes.

## Shipped — `sos install` (cloud install wizard)

`sos install` (in `internal/cli/install.go` + `internal/install/`) is the
frictionless installer for GKE/EKS/AKS (and `kind`/`stackit`), realising phase 5
step 4 of `docs/research/cloud-install-gke-eks-aks.md`. It is a **thin
orchestrator** — it shells out to the bootstrap scripts, `kubectl` and `helm`; it
does not reimplement them.

- **Asks 3–5 real inputs**, defaults + validates the rest per cloud: `cloud`
  (gke|eks|aks|stackit|kind), account scope (project/account/subscription),
  `region`, warehouse `bucket` (generated default), `postgres` mode (default
  `cnpg` on cloud), the three LLM tier model ids (defaulted per cloud from the
  report, overridable), and an optional `domain`/`tls`.
- **Flow:** collect → render `install.yaml` (admin answers only, **no secrets**)
  → preflight (`kubectl` reachable, `helm` + cloud CLI present) →
  `deploy/cloud/bootstrap-<cloud>.sh` → `helm upgrade --install -f
  values.<cloud>.yaml -f install.yaml` → health verify (`kubectl wait` pods
  Ready). The per-tier embed+chat smoke test is a `helm test` (needs in-cluster
  network) — flagged as a TODO the offline CLI cannot run.
- `--defaults` (non-interactive/CI), `--dry-run` (emit values + planned commands
  only), `--yes` (skip confirm). Honest, prerequisite-naming errors; fail-fast.
- **Not live-verified** — static gates (`go build`/`vet`/`test`, `shellcheck`)
  pass; the first run on a real cluster is the acceptance test.
- See `deploy/cloud/README.md` for the per-cloud flow + footguns.

## Invariants across all phases
- **Front door, not back door.** Every verb hits the same governed lib function the UI
  calls — OPA + row/doc security + audit unchanged.
- **Tokens are secrets** — keychain / `0600`, PKCE-or-device-minted, identity-only,
  never logged or committed. Refresh rotation on every use.
