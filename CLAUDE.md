# CLAUDE.md — sovereign-agentic-os

Loaded at the start of every session. **If it must be followed, it lives here; if it must never break, it fails a check.** Chat instructions are suggestions; this file, the hooks and CI are law.

Adapted from `claude-code-repo-hygiene.md` §2–3. Where this file differs from that document, **this file is correct** — it describes the repo as it is. The three deliberate differences are listed at the bottom.

---

## Folder structure (strict)

```
charts/        umbrella Helm chart (components consumed as images/subcharts)
components/    one folder per bundled OSS component (integration only — see below)
images/        our own Docker images (base/ + extensions/)
os-ui/         our own application code
deploy/ docs/ scripts/ seed/ tests/
licenses/ + THIRD-PARTY-LICENSES.md + NOTICE + sbom.cdx.json
```

Our code goes **only** in `os-ui/`, `images/`, `scripts/`, `tests/`, `charts/` — never the repo root, never inside a component's folder, and **no new top-level folders without asking**.

### os-ui is a kernel plus thirteen tab modules

```
os-ui/core/<area>/     the kernel: kernel, auth, infra, mcp, models, policy, runtime, ui, …
os-ui/tabs/<tab>/      one per tab — a CLOSED set of 13 (below)
  lib/                 tab logic. Cross-tab imports go through @core, never @tabs/<other>
  ui/                  tab-specific components
  mcp/                 this tab's MCP tool handlers (each UI action has an MCP twin)
  manifest.ts          the tab's routes, APIs, MCP tools, policies
os-ui/app/             the route tree ONLY — thin pages that import from tabs/ and core/
```

**The thirteen tab modules.** A fourteenth, or tab code placed anywhere else, requires an explicit decision first.

```
admin  agents  connections  dashboards  data  files  governance
home   knowledge  metrics  monitoring  software  workflows
```

Note `metrics` is the folder name; its user-facing label is **KPIs**. Folder names are stable, labels are not — never rename a module to chase a label.

### Three rules the kernel/tab split exists to protect

1. **A tab imports only `@core/*` and itself.** Cross-tab need means the shared part belongs in `@core`.
2. **The kernel never imports a tab.** `@core` must not know its tabs exist.
3. **`components/` is upstream-only.** Only `UPSTREAM.md`, `LICENSE` and `README` belong there; our integration code goes in the chart or the owning tab.

### Enforced, not remembered

`node scripts/check-structure.mjs` fails on any new violation of the above, plus a required `FEATURE:` / `USER STORY:` / `ARCHITECTURE:` header on every source file. It is a **ratchet**: existing violations are baselined in `scripts/structure-baseline.json` and the counts may only go down. Pay one down and run `--baseline` to lock it in.

It runs in three places: a **PostToolUse hook** on Write|Edit (`.claude/settings.json`), so violations surface in-session; **CI** (`.github/workflows/ci.yml`); and before any commit you make by hand.

Surgical changes only. Periodic pass: *"List and fix every violation of this file's structure rules. Nothing else."*

---

## Imported open-source components

- **Never copy upstream source into this repo.** Components are consumed as **pinned images + subcharts**. No `third_party/` dumps, no in-tree forks.
- Every bundled component is `components/<name>/` with: pinned version · values/config · OPA policies · init/seed · health checks · **README** (what it is, version, license, upstream link, why chosen).
- Adding or upgrading a component requires, **in the same PR**: a row in `THIRD-PARTY-LICENSES.md`, the license text in `licenses/`, and a regenerated `sbom.cdx.json`.
- **License gate: Apache-2.0 / MIT / BSD / PostgreSQL only.** Verify the LICENSE file at adoption. No AGPL, BSL or custom-branding licenses in the bundle. *(Open item: `components/minio/` — MinIO is AGPL; replace with SeaweedFS/Garage for the self-contained mode, or document the exception.)*
- Must modify upstream? `components/<name>/patches/*.patch`, applied at image build. Prefer an upstream PR.

---

## Sessions — the chat is disposable, the repo is the memory

- **One session per task.** Start by pasting the brief. The design docs, `docs/superpowers/plans/`, and git history are the project memory.
- **Safe to clear when** work is committed **and** decisions are recorded in a doc. **Not safe** when reasoning exists only in chat — first commit, then write open items and current state into the relevant doc.
- Long sessions degrade. Finish the task, record, clear, start fresh.
- **End-of-task ritual:** record learnings in `os-ui/ARCHITECTURE.md` or the relevant `docs/components/*.md` → commit → clear.

## Before you write code here, read this

`os-ui/ARCHITECTURE.md` has a section titled **"Things this codebase will punish you for"**. It covers constraints that cost real debugging time: a Next.js `route.ts` may export only its handlers, a test cannot import a `.tsx` or a route, TypeScript parameter properties are rejected, never restate a path that already exists in the nav, and a fallback must never report success with substituted data.

## Deploy and operational rules

- `./scripts/os up | test | down` for local. `./scripts/deploy.sh <version>` for the cluster — it backs up first and aborts if the backup gate fails.
- **Never plain `tofu apply`** — always `-target=`.
- Velero CRD is `backups.velero.io`, never `backup` (it collides with CloudNativePG's).
- **Never run a tree-wide script while another script is executing from the same checkout.** Rewriting a running bash script makes it resume mid-line; this once deleted a Dockerfile and committed the deletion.
- **Merge with "Rebase and merge", never squash.** A squash creates a commit absent from the branch's ancestry, so the next branch reports conflicts in every touched file. This cost three repair cycles.

---

## Where this file deliberately differs from `claude-code-repo-hygiene.md`

1. **Layout.** The document specifies `os-ui/modules/<tab>/{routes,actions,components,lib}` plus `os-ui/shared/`. The repo uses `os-ui/core/` + `os-ui/tabs/<tab>/{lib,ui,mcp}` + `os-ui/app/`, settled in the v2 rework and enforced by the existing checker. Installing the document verbatim would have described a structure that does not exist.
2. **The checker is `scripts/check-structure.mjs`, not `scripts/check-structure.sh`.** It already existed, is already wired into CI, and enforces more than the document asks: tab isolation, kernel independence, components-upstream-only, legacy imports and file headers, all as a ratchet. A second shell script would duplicate it less well.
3. **The thirteen names are taken from `os-ui/tabs/`** rather than proposed, because that directory already contains exactly thirteen modules.
