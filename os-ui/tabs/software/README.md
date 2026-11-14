# Software · Build

Generated applications: design, build, preview and deploy, each gated by an approval.

The authoritative contract is [`manifest.ts`](./manifest.ts) — this file explains it; the manifest is what the checks and the docs generator read. If the two disagree, the manifest is right.

## What this module owns

**Routes**

- `/software`
- `/apps`

**APIs**

- `/api/software`
- `/api/apps`
- `/api/artifacts`

**MCP tools**

- `software-write`

**Needs deployed**

- `opensearch`
- `minio`
- `litellm`

## Layout

- `build-spec/`
- `lib/`
- `mcp/`
- `ui/`

- `lib/` tab logic · `ui/` tab-specific components · `mcp/` this tab's MCP handlers

- `lib/appspec/` — the declarative AppSpec grammar. TOLERANT PARSE, STRICT OUTPUT: the build normalises bare ids in the assistant's reply into the canonical reference objects (`"metric": "m_1"` → `{ metricId: "m_1" }`, likewise `function`/`source`, plus `{ id }` → `{ <slot>Id }`) and reports each rewrite in the build notes, while `parseAppSpec` stays strict so the stored spec is always canonical.

- `guide.md` — the golden path, shown in-product
- `context.md` — the system prompt context this tab gives an agent

## Where an app's source lives (night-2)

An app's tree is a **subtree of its domain's git repository**: `apps/<slug>/`, written by
`lib/git-commit.ts` through `core/infra/git-store.ts` `commitSubtree`, with a boot-time
`reserveSubtree('apps/')` so the dbt generator's whole-tree commit cannot delete it. Git is the
home of record; the OpenSearch `os-app-files` mirror (`lib/file-mirror.ts`) is a **cache** of the
committed tree. The commit's author is the acting user, the committer is `Sovereign OS`, and the
message carries `OS-Action` / `OS-Object: app:<id> (<name>)` / `OS-Surface` / `OS-Request-Id`
(plus `OS-Actor`, and `OS-Run-Id` when a run caused it).

`push_app_files` is the one documented verb for "code in Claude, push to the OS"
(`lib/push-app-files.ts`); the MCP tool and `POST /api/software/<id>/files` call the **same
service**. The compile gate runs before any write, and an unchanged push makes no commit.

**What the OS does NOT do:** there is no CI runner, no image builder, no container registry and
no GitOps controller. `release_software`, the gate set behind it and the six approval-card fields
are explicitly not built yet — `lib/engineering.ts` says so in the product itself, under
"Under the hood".

## Rules that apply here

1. **Import only `@core/*` and this module.** A cross-tab need means the shared part belongs in `@core`.
2. **The kernel must not import this module.** `@core` does not know its tabs exist.
3. **Pages live in `os-ui/app/`**, thin, importing from here. Next.js serves routes only from there.
4. Every source file carries a `FEATURE:` / `USER STORY:` / `ARCHITECTURE:` header. `scripts/check-structure.mjs` enforces it as a ratchet.

See [`../../../CLAUDE.md`](../../../CLAUDE.md) for the full structure rules and [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) for the constraints this codebase punishes you for ignoring.
