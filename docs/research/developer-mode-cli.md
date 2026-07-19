# Governed Developer Mode for the Sovereign Agentic OS — `sos` CLI, Homebrew, devcontainer

Date: 2026-07-19, status: advisory (decisions pending)

---

# Governed Developer Mode for the Sovereign Agentic OS — Research & Action Plan

## 1. Current state — what we already have (be honest: we're ~70% there for a *server-hosted* dev mode, ~30% there for a *bring-your-own-desktop* one)

The platform already contains most of the hard governance plumbing. The gap is not governance — it's the **client-side, own-machine surface** engineers actually asked for.

### 1a. MCP — the single biggest asset (already a governed "front door")
- `os-ui/lib/mcp/**` exposes a JSON-RPC 2.0 governed MCP: **~45 write tools** (`create_dataset`, `ingest_dataset`, `transform_silver`, `build_gold_join`, `define_metric`, `create_dashboard`, `create_agent_system`, `run_agent_system`, `commit_agent_files`, `request_promotion`/`approve_promotion`, …) and **~40 read/query tools** (`query_data`, `query_metric`, `list_runs`/`get_run_trace`, `discover_warehouse_tables`, Airflow `trigger_dag`/`get_task_instances`, OpenMetadata lineage). Every tool "delegates to the **exact same governed library function** the UI calls — there is no privileged side-channel" (`os-ui/lib/mcp/README.md`). Role is a floor, not a ceiling; the underlying function re-checks OPA/DLS on every call.
- **OAuth 2.1 is already implemented and this is the key finding** (`os-ui/lib/mcp/oauth.ts`): os-ui is its own Authorization Server + Resource Server, with **PKCE S256 (mandatory), Dynamic Client Registration (RFC 7591), client-id metadata documents, RFC 8414/9728 discovery, refresh-token rotation**, and a **loopback `http://127.0.0.1/callback` redirect already allowlisted for the Claude Code CLI**. The access token is a signed identity envelope that carries *only* userId — **role/domains/OPA/DLS are re-resolved live on every call** (`os-ui/lib/mcp/token.ts`), so a token is never a frozen capability and revocation is immediate.
- **Assessment:** Claude Code / Codex / Claude Desktop already drive the OS as the signed-in user through this. A CLI is a small step from here — the auth server, the governed execution path, and the loopback redirect **already exist**.

### 1b. Forgejo git — governed repos exist, but human access is server-side, not desktop-native
- `os-ui/lib/infra/forgejo.ts` is the git boundary (`ensureRepo`/`readFile`/`writeFile`/`listCommits`/`getCommitFiles`). Per-agent-system `os-<id>` repos and Software-tab app repos exist, with **real CI**: push → Forgejo Actions → DinD build → OCI registry → Argo CD redeploy (`docs/components/ci-build.md`).
- **The `analytics` monorepo (#146)** is written **one-directionally from the registry → git** by `os-ui/lib/data/analytics-repo.ts` as **observability artifacts only**: "The RUNTIME governed CTAS in publish-server.ts is NOT changed — these files are observability artefacts." dbt SQL + Cube YAML + exposures are emitted on promotion, diff-only.
- **Auth today is a shared service account** (`config.forgejoUser`/`forgejoPassword` in `os-ui/lib/software/apps.ts` / `server.ts`), plus an SSO header-proxy mode (`X-WEBAUTH-USER` in `os-ui/lib/infra/tool-proxy.ts`). There is **no per-user, desktop-usable git credential path yet** except inside the Workbench design below.

### 1c. Workbench tab (`docs/workbench-tab-design.md`) — a designed "developer mode v0", but **browser-hosted, not own-machine**
- A `builder`-scoped **`code-server` (VS Code in an iframe)** with a persistent per-builder PVC, a **domain-scoped Forgejo token wired into a git credential helper** (`git push` works), python3, and the `dq` governed Trino CLI. Egress restricted to the domain's Forgejo + the governed query-tool.
- **Status: prototype on kind, off by default, NOT deployed.** Crucially, it puts the IDE *in the browser* — it does **not** let engineers use their **own** desktop IDE/terminal/git, which is the explicit ask.

### 1d. Console/Terminal tab (`docs/terminal-tab-design.md`) — a sandboxed *teaching* shell, not dev mode
- Ephemeral per-session pod via a k8s-credentialed broker, HMAC 60s single-use token, drop-all-caps, deny-egress except the governed data endpoint, ships a governed **`dq` Trino CLI**. Role-gated (`terminalAllowedRoles`), off by default. This is a learning surface, not an engineering surface — but it proves the **broker + short-lived-token + governed-egress** pattern, and the `dq` CLI is a governed-query precedent.

### 1e. REST surface & registry authority
- ~40 `/api/*` route groups exist (`/api/query`, `/api/metrics`, `/api/data`, `/api/cube`, `/api/mcp`, …) but they are **UI-shaped JSON routes**, not a documented external contract. `/api/query` runs `queryRun(sql, principal)` with OPA + row-level security enforced at the **Trino** layer; Cube `.cube.yml` is **generated from the metric registry** and hot-reloaded (`/api/cube/models`), with the viewer's `securityContext` on every query.
- **No CLI, no SDK, no published npm package** exists (`os-ui/package.json` is `private`, no `bin`). MCP is the only outward programmatic surface today.

**Authoritative-source verdict (answers RQ2):** the **registry is authoritative for compute** (governed CTAS + registry-generated Cube). **Git is a downstream mirror / audit trail.** Any git-first dev flow must respect this — see §3.

---

## 2. Best-practice findings (2026), per pattern

**Governed local dev — the industry converges on "local edit, remote governed execution + git-push-through-policy":**
- **Databricks**: VS Code extension + **Databricks Connect** run local code but *execute on the governed remote cluster*; **Asset Bundles** are declarative (`databricks.yml`) deployed via the **Databricks CLI**, with a devcontainer story for reproducibility. Local authoring, remote authoritative execution. ([docs.databricks.com/aws/en/dev-tools/vscode-ext](https://docs.databricks.com/aws/en/dev-tools/vscode-ext/))
- **Snowflake**: `snow` CLI + **git integration** (`snow git setup` with OAuth), Workspaces treat SQL/Python as versioned code; recommends **workload-identity federation / OIDC — no long-lived secrets in CI**. ([docs.snowflake.com/.../snowflake-cli/cicd/integrate-ci-cd](https://docs.snowflake.com/en/developer-guide/snowflake-cli/cicd/integrate-ci-cd), [snow git setup](https://docs.snowflake.com/en/developer-guide/snowflake-cli/command-reference/git-commands/setup))
- **dbt**: the dominant 2026 pattern is **hybrid** — `dbt-core` for fast local iteration + **dbt Cloud CLI** authenticating via SSO for governed prod, **git-first** throughout; credentials belong in `~/.dbt/profiles.yml` from env vars, *never committed*. ([getdbt.com core-to-cloud](https://docs.getdbt.com/guides/core-to-cloud-3), [datacoves](https://datacoves.com/post/dbt-core-vs-dbt-cloud))
- **Terraform/Pulumi**: desktop CLI plans against a **remote backend**; **Sentinel/OPA policy runs *between plan and apply*** at advisory/soft/hard-mandatory levels. The apply is governed server-side, not on the desktop. ([developer.hashicorp.com/sentinel/docs/terraform](https://developer.hashicorp.com/sentinel/docs/terraform), [spacelift terraform-policy-as-code](https://spacelift.io/blog/terraform-policy-as-code))
- **GitOps (GitHub/GitLab)**: push → CI **policy gate (OPA/Conftest/Kyverno)** with deny (hard-gate) and warn (soft-gate) rules → merge → deploy. This is the canonical "git-push-through-policy" pattern. ([openpolicyagent.org/docs/cicd](https://www.openpolicyagent.org/docs/cicd), [policyascode.dev](https://policyascode.dev/guides/policy-ci-cd-integration/))
- **Backstage**: developer **portal + Software Templates (Scaffolder)** encode "golden paths — the easy path is also the right path"; notably in 2026 Backstage exposes scaffolder/catalog **as MCP tools** so CLIs/agents can invoke golden paths. ([backstage.io/docs/features/software-templates](https://backstage.io/docs/features/software-templates/), [Red Hat: developer self-service](https://developers.redhat.com/articles/2025/06/25/how-implement-developer-self-service-backstage))
- **devcontainers**: `devcontainer.json` is now an **open spec** supported by VS Code, JetBrains, Zed, Codespaces, and DevPod/Coder — the standard way to ship "the whole env (tools + extensions + MCP) in one file." ([containers.dev/implementors/spec](https://containers.dev/implementors/spec/), [github.com/devcontainers/spec](https://github.com/devcontainers/spec))

**CLI auth (RQ4):** the mature 2026 convergence is **PKCE-first with device-code fallback**; `gh auth login` and `aws sso login` use device flow; **Vercel CLI made device-code the default in Sept 2025**. Short-lived tokens shrink the compromise window "from *until someone notices* to *one hour*"; bind callbacks to `127.0.0.1` only. ([workos.com/blog/pkce-vs-device-flow-cli-auth](https://workos.com/blog/pkce-vs-device-flow-cli-auth), [logto.io/blog/cli-authentication-methods](https://blog.logto.io/cli-authentication-methods)) — **We already implement PKCE S256 + loopback; adding RFC 8628 device flow is incremental.**

**MCP-as-CLI-backend tradeoff (important nuance for RQ2):** MCP is *token-heavy and string-typed* — one benchmark found **4–32× more tokens** for MCP vs an equivalent CLI for the same deterministic task, and "a CLI accepts strings and returns strings… fragility a typed SDK eliminates at compile time." The clean pattern: **MCP for agent/LLM-driven runtime tool selection; a typed CLI/SDK over a stable contract for deterministic, scripted, repeated human execution.** ([buildwithfern.com/post/sdk-vs-cli-vs-mcp](https://buildwithfern.com/post/sdk-vs-cli-vs-mcp-choosing-interface), [buildwithfern.com/post/mcp-vs-cli-api-access](https://buildwithfern.com/post/mcp-vs-cli-api-access)) → **Implication: don't make the CLI a *thin MCP text wrapper* for everything. Use MCP for the login/identity + governed-mutation calls, but back deterministic verbs (query, clone, tail-logs) with a stable typed contract.**

**Distribution (RQ3):** Homebrew taps let you publish without core-review; **GoReleaser** builds all-platform signed binaries + auto-updates a brew tap + Scoop + Snap from one `git tag`; npm suits JS-native audiences. Comparable OSS platform CLIs ship **multiple channels** (brew + curl|sh + binaries + container). ([goreleaser.com/blog/homebrew-gofish](https://goreleaser.com/blog/homebrew-gofish/), [casraf.dev distribute-with-homebrew-taps](https://casraf.dev/2025/01/distribute-open-source-tools-with-homebrew-taps-a-beginners-guide/), [medium: distributing CLI via npm and Homebrew](https://medium.com/@sohail_saifi/distributing-cli-tools-via-npm-and-homebrew-getting-your-tool-into-users-hands-111a3cea4946))

---

## 3. Recommended architecture for Sovereign OS Developer Mode

**Design principle (matches everything above and our own MCP doctrine): local authoring + remote governed execution + git-push-through-policy. The desktop holds only a short-lived token; the server stays authoritative for OPA/DLS/audit and for the registry→compute path.**

### 3.1 A governed CLI — `sos` (thin where it can be, typed where it must be)
- **Login:** `sos login --profile <name> https://<my-os-instance>` runs **PKCE loopback (already supported), add device-flow fallback** (RFC 8628) for headless/SSH. Stores a **short-lived token in the OS keychain** (macOS Keychain / libsecret / Windows Credential Manager) — never a plaintext dotfile. Multi-tenant by design: a **profile per OS instance** (endpoint + token), exactly like `aws` profiles — the CLI is not a single-SaaS client.
- **What it wraps, and how (honest split):**
  - `sos whoami`, `sos query "..."`, `sos metric <id>`, `sos runs tail`, `sos deploy` → these map **1:1 onto existing MCP tools** (`whoami`, `query_data`, `query_metric`, `list_runs`/`get_run_trace`, `request_deploy`). **~80% of the CLI is a thin client over the MCP JSON-RPC we already ship** — zero new server governance.
  - **But** per the MCP-vs-CLI nuance, don't force *deterministic bulk* verbs (large query result streaming, log tailing, repo listing) through the token-heavy MCP text envelope. For those, expose a **small, explicitly-versioned governed REST contract** (`/api/v1/...`) that reuses the *same* `queryRun(sql, principal)` / governed lib functions — so it inherits OPA + RLS at the Trino/Cube layer unchanged. This is a **documentation + stable-surface** task, not new governance.
  - `sos clone` / `sos pull` / `sos push` → fetch the user's **governed git repos** (analytics monorepo, `os-<id>`, software apps) using a **per-user, short-lived, domain-scoped Forgejo token minted server-side** on `sos login` (replacing the shared service account for human flows). This is the one genuinely new credential path.
- **Verdict on "thin client over MCP vs new REST":** **mostly thin-over-MCP for governed mutations + identity; a thin typed REST layer for high-volume deterministic reads.** No back-door either way — both hit the same governed lib functions.

### 3.2 Git-native workflow — respect registry authority (answers the trap in RQ2)
- Engineers clone the software/agent repos and edit in their IDE freely — those repos are **already git-authoritative** (CI builds them). Git-first works cleanly there.
- For the **analytics monorepo**, git is currently a **downstream mirror of the registry**. Do **not** invert this naively. Recommended shape: **git-push → Forgejo Actions → governance validation (OPA/Conftest over the changed dbt/Cube files) → a governed *apply* that updates the registry**, which then regenerates Cube. i.e. the push proposes a change; the **registry remains the compute source of truth**, and the apply step is the seam where a human `request_promotion`/`approve_promotion` gate lives (reuse the existing promotion ladder). This mirrors **Terraform's plan → policy → apply** exactly, and avoids two sources of truth fighting.

### 3.3 IDE integration — devcontainer first, VS Code extension later
- Ship a **`devcontainer.json` + Feature** that pre-installs `sos`, wires the OS **MCP endpoint**, and pre-clones the user's repos — engineers get "OS context, MCP, repos out of the box" on their **own machine** (the gap the browser-based Workbench doesn't fill). Cheap, standards-based, works in VS Code/JetBrains/Zed/Codespaces/DevPod.
- A **VS Code extension** (Databricks-style: browse governed datasets/metrics, run governed queries, view runs, one-click deploy) is the bigger bet — do it after the CLI + REST contract exist, since it's a client of the same surface.

### 3.4 SDK — thin typed TS/Python client over the versioned REST/MCP contract
- Generate a typed client from the `/api/v1` contract for scripting/CI (this is what makes the CLI's deterministic verbs robust and gives platform teams a library). Publish `@sovereign-os/sdk` (npm) + `sovereign-os` (PyPI).

### 3.5 Homebrew — **yes, but not alone.** Full distribution recommendation
- **Build `sos` as a single static binary (Go)** → one artifact per OS/arch, no runtime dependency, trivial cross-compile. Drive releases with **GoReleaser**: one `git tag` produces signed binaries + checksums + auto-updates the brew tap + Scoop (Windows) + `.deb`/`.rpm` + a container image.
- **Channels to ship:**
  1. **Homebrew tap** — `brew install sovereign-os/tap/sos` (the macOS/Linux dev default). Recommended.
  2. **`curl -fsSL https://<instance>/install.sh | sh`** — the sovereignty-friendly path (works air-gapped/EU-only, served from the user's own OS instance, no dependency on github.com).
  3. **Signed standalone binaries** on the Forgejo release page (checksums + cosign) — for locked-down/EU environments.
  4. **Container image** — for CI and devcontainers.
  5. **npm/PyPI** — only for the **SDK**, and optionally an npm shim of the CLI for JS-native teams.
- **Sovereignty note:** because we're EU-sovereign and multi-tenant, the **`curl|sh`-from-your-own-instance** and **self-hosted brew tap on Forgejo** matter more than a public github tap — recommend making the instance itself serve the installer and the tap so no US SaaS is in the trust path.

### 3.6 Governance — front door, not back door (the invariants)
- **Never** let the CLI hit Trino/Cube/Forgejo directly with elevated creds. Every verb goes through the **same governed lib functions** (`queryRun`, publish/promote, MCP tools) so **OPA + row/doc-level security + Langfuse audit apply unchanged** — this is already true for MCP and `/api/query`.
- **Token:** short-lived, PKCE/device-flow-minted, keychain-stored, **identity-only** (role/domains re-resolved live server-side, as today). Consider tightening the 180-day MCP token TTL for the CLI to a shorter access token + silent refresh (the refresh-rotation code already exists).
- **Forgejo per-user tokens:** replace the shared service account for human pushes with **short-lived, domain-scoped, server-minted** tokens (the Workbench design already established the per-domain-scoped-token pattern — reuse it, but hand the token to the desktop git-credential-helper with a short TTL rather than into a browser pod).
- **No desktop secrets** beyond the short-lived token; the CLI writes a git credential helper that calls back to the OS for a fresh Forgejo token rather than storing a long-lived one.

---

## 4. Proposed action plan (phased, low-risk-first)

**Phase 0 — Stabilize the contract (prereq, ~days).** Document and version the governed programmatic surface: mark which existing MCP tools are the CLI's backbone, and cut a minimal **`/api/v1`** stable read contract over the existing `queryRun`/list functions. No new governance. *Decision for user: commit to a stable external contract (vs "MCP only").*

**Phase 1 — Thin MCP-backed CLI + distribution (highest value, lowest risk).**
- `sos` (Go) with `login` (reuse existing **PKCE loopback**; add **device flow**), profiles per instance, keychain storage.
- Verbs that map 1:1 to existing MCP tools: `whoami`, `query`, `metric`, `runs`, `deploy`, `list *`.
- **Ship via GoReleaser → Homebrew tap + `curl|sh` from the instance + signed binaries.**
- *Reuses existing MCP + OAuth end-to-end; near-zero new server code.*

**Phase 2 — Devcontainer + per-user git.**
- `devcontainer.json`/Feature that installs `sos`, wires MCP, pre-clones repos.
- **Server-minted short-lived per-user domain-scoped Forgejo tokens** + a `sos git` credential helper → real `clone/pull/push` from the engineer's own machine. *Decision for user: retire the shared service account for human git; confirm domain-scoping model matches the Workbench design.*

**Phase 3 — Git-push-through-policy apply pipeline (bigger bet).**
- Forgejo Actions job on the analytics monorepo: **OPA/Conftest validate → governed apply into the registry → Cube regenerate**, gated by the existing promotion ladder. *Decision for user: confirm registry-stays-authoritative (recommended) vs making git authoritative for dbt models (would be a deeper re-architecture of `analytics-repo.ts`).*

**Phase 4 — Typed SDK + VS Code extension (biggest bets).**
- Generate `@sovereign-os/sdk` (npm) + PyPI from the `/api/v1` contract.
- Databricks-style VS Code extension over the CLI/REST/MCP surface. *Decision for user: is "own-desktop IDE" (extension + devcontainer) the priority, or finish/deploy the browser **Workbench** (`code-server`) first? They're complementary — recommend own-desktop, since the browser Workbench is already designed and can ship independently for non-engineer builders.*

---

### Decisions that need you
1. **Contract commitment:** are we willing to publish a **stable `/api/v1`** + versioned MCP tool contract (needed for a durable CLI/SDK), or keep MCP as the only surface and accept the token-heavy/string-typed tradeoffs?
2. **Registry vs git authority** for the analytics monorepo — I recommend **registry stays authoritative**, git-push is a *proposal* validated then applied. Confirm.
3. **Retire the shared Forgejo service account** for human flows in favor of short-lived per-user domain-scoped tokens. Confirm the security posture.
4. **Own-desktop vs browser Workbench priority** — recommend own-desktop CLI+devcontainer first; ship the already-designed browser Workbench in parallel for non-coding builders.
5. **Distribution sovereignty:** self-host the Homebrew tap + installer on the instance/Forgejo (no github.com in the trust path)? Recommended for EU-sovereign posture.

**Key files for the build:** `os-ui/lib/mcp/oauth.ts` (PKCE/DCR/device-flow seam), `os-ui/lib/mcp/token.ts` (identity token), `os-ui/lib/mcp/write-tools.ts` + `discovery-tools.ts` (CLI verb backbone), `os-ui/lib/infra/forgejo.ts` + `os-ui/lib/software/apps.ts` (per-user git token seam), `os-ui/lib/data/analytics-repo.ts` (registry→git authority seam), `os-ui/app/api/query/route.ts` (governed query contract), `docs/workbench-tab-design.md` + `docs/terminal-tab-design.md` (broker + short-lived-token + governed-egress patterns to reuse).
