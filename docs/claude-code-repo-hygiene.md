# Claude Code — sessions, clean structure & OSS components (sovereign-agentic-os)

Short operating manual. Sections 2–3 belong verbatim in the repo's `CLAUDE.md`. 2026-10-30.


> **As installed in this repo (2026-11-02).** The rules below are in force; the *vocabulary*
> differs, because the layout was settled in the v2 rework before this doc existed. Read the
> mapping, not the literal folder names:
>
> | This doc | This repo |
> |---|---|
> | `os-ui/modules/<tab>/` | `os-ui/tabs/<tab>/` |
> | `os-ui/shared/` | `os-ui/core/<area>/` |
> | `components/` | `ui/` |
> | `actions.ts` + `mcp.ts` | `mcp/` (the MCP handler is the action) |
> | `scripts/check-structure.sh` | **`scripts/check-structure.mjs`** — already wired into CI and the
>   PostToolUse hook, and it enforces more than this doc asks: tab isolation, kernel independence,
>   components-upstream-only, legacy imports, and a required file header, all as a **ratchet** whose
>   baselines may only shrink |
>
> Agreed and unchanged: routes stay thin wrappers in `app/`; the 13 are a closed set; no cross-module
> imports except through the shared layer; one skeleton for all 13; `components/` is upstream-only.
>
> **The confirmed 13** (read from `os-ui/tabs/`, each with its own `README.md`):
> `admin agents connections dashboards data files governance home knowledge metrics monitoring
> software workflows`. Note `metrics` is the folder, **KPIs** the label — folder names are stable.
>
> Renaming `tabs/`→`modules/` and `core/`→`shared/` for literal conformance would rewrite imports
> across ~1,629 files for zero behaviour change. Not done; raise it as its own decision.
## 1. Sessions — the chat is disposable, the repo is the memory
- `CLAUDE.md` loads at the start of **every** session → anything that must be followed lives there,
  not in chat. Mid-session, type `#` + a note to save it into CLAUDE.md.
- **One session per task.** Start each task by pasting its brief ("Read `docs/design/<x>.md` first…").
  The design docs + `stack-decisions.md` + git history are the project memory.
- **Safe to close/`/clear` when:** work is committed **and** decisions/learnings are recorded in a doc.
  **Not safe:** uncommitted work or reasoning that exists only in chat → first say:
  *"Commit what's done; write open items + current state to the relevant design doc / HANDOFF.md."*
- Long sessions auto-compact and degrade — finish the task, record, clear, start fresh.
  `claude --continue` / `--resume` reopens past sessions if needed.
- **Plan mode** (shift+tab) for anything multi-file; the plan must list *which files go where*.
- **End-of-task ritual:** update CLAUDE.md / the design doc with learnings → commit → `/clear`.

## 2. Folder structure (strict — for CLAUDE.md)
```
charts/        umbrella Helm chart (components consumed as images/subcharts)
components/    one folder per bundled OSS component (integration only — see §3)
images/        our own Docker images (base/ + extensions/)
os-ui/         our own application code
deploy/ docs/ scripts/ seed/ tests/
licenses/ + THIRD-PARTY-LICENSES.md + NOTICE + sbom.cdx.json
```
- Our code goes **only** in `os-ui/`, `images/`, `scripts/`, `tests/`, `charts/` — never the repo root,
  never inside a component's folder, no new top-level folders without asking.
- **One subfolder per tab — the app has exactly 13 tabs, and `os-ui/` mirrors them 1:1.** This is a
  **closed set**: every tab's UI, routes, server actions, and MCP tool handlers live in its own module
  folder; creating a 14th module (or putting tab code anywhere else) requires an explicit decision first.
  ```
  os-ui/
    app/(tabs)/<tab>/page.tsx   # Next.js routes stay in app/ — THIN wrappers only, no logic
    modules/<tab>/              # the tab, self-contained — one per tab, exactly 13
      components/               # tab UI
      actions.ts                # server actions (each with its MCP twin)
      mcp.ts                    # the tab's MCP tool handlers
      lib/                      # tab logic + data access
      types.ts
      README.md                 # the tab's job, golden-path doc link, its MCP tools
    shared/                     # design system, auth, registry client — only when 3+ tabs
                                # use it; promoting to shared/ requires asking first
  ```
  **Identical skeleton in all 13 modules** — no per-tab creativity. **Start flat**; split a file into a
  subfolder only past ~300 lines or ~7 files per module. **No cross-module imports** except via
  `shared/`. `scripts/check-structure.sh` validates module names against the **explicit list of 13** —
  an unknown module fails the check.
- Rules are enforced, not remembered: `scripts/check-structure.sh` fails on files outside allowed
  paths — wired as a **pre-commit/CI check** and a Claude Code **PostToolUse hook** on Write|Edit
  (`.claude/settings.json`), so violations are corrected in-session.
- Surgical changes only (Karpathy); periodic pass: *"List and fix every violation of §2–3. Nothing else."*

## 3. Imported open-source components (for CLAUDE.md)
- **Never copy upstream source into this repo.** Components are consumed as **pinned images +
  subcharts**. No `third_party/` source dumps, no forks in-tree.
- Every bundled component = `components/<name>/` containing: pinned version · values/config · OPA
  policies · init/seed · health checks · **README** (what it is, version, license, upstream link, why
  chosen).
- Adding/upgrading a component also requires, same PR: row in `THIRD-PARTY-LICENSES.md` + license text
  in `licenses/` + regenerated `sbom.cdx.json`.
- **License gate:** Apache-2.0 / MIT / BSD / PostgreSQL only. Verify the LICENSE file at adoption —
  no AGPL/BSL/custom-branding licenses in the bundle. *(Open item: `components/minio/` — MinIO is
  AGPL; verify and replace with SeaweedFS/Garage for the self-contained mode or document the exception.)*
- Must-modify upstream? → `components/<name>/patches/*.patch`, applied at image build; prefer an
  upstream PR.

## 4. One-line principle
**If it must be followed, it lives in a file; if it must never break, it fails a check.**
Chat instructions are suggestions — CLAUDE.md + hooks + CI are law.
