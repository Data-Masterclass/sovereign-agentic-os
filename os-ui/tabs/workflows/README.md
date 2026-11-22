# Workflows · Build

Process documentation. Each workflow records a business process (its steps and the actors who carry
them out) as a document you can file in folders, share and promote. The tab **runs nothing**: it has no
run engine and no schedules. To run work, or to run it on a schedule, build an agent system in the Agents tab.

A workflow is **not** a knowledge note. A workflow (`wf_…`) is process documentation, owned by this tab and
stored in the workflow store; a knowledge note (`pk_…`) is a free-form markdown document, owned by the
Knowledge tab (`save_knowledge_note`). The two have separate MCP tools and separate agent grants.

The authoritative contract is [`manifest.ts`](./manifest.ts) — this file explains it; the manifest is what the checks and the docs generator read. If the two disagree, the manifest is right.

## What this module owns

**Routes**

- `/workflows`

**APIs**

_No APIs of its own._

**MCP tools**

`author_workflow` · `list_workflows` · `get_workflow` · `index_workflow` · `publish_workflow` · `retire_workflow`
(`tabs/workflows/mcp/workflow-write-tools.ts`). The old names `author_knowledge`, `index_knowledge`,
`publish_knowledge` and `retire_knowledge` still work for one release and log a deprecation.

**Needs deployed**

- `opensearch`

## Layout



- `lib/` tab logic · `ui/` tab-specific components · `mcp/` this tab's MCP handlers

## Rules that apply here

1. **Import only `@core/*` and this module.** A cross-tab need means the shared part belongs in `@core`.
2. **The kernel must not import this module.** `@core` does not know its tabs exist.
3. **Pages live in `os-ui/app/`**, thin, importing from here. Next.js serves routes only from there.
4. Every source file carries a `FEATURE:` / `USER STORY:` / `ARCHITECTURE:` header. `scripts/check-structure.mjs` enforces it as a ratchet.

See [`../../../CLAUDE.md`](../../../CLAUDE.md) for the full structure rules and [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) for the constraints this codebase punishes you for ignoring.
