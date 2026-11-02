# Home · Entry

The entry surface. Golden paths into the rest of the OS.

The authoritative contract is [`manifest.ts`](./manifest.ts) — this file explains it; the manifest is what the checks and the docs generator read. If the two disagree, the manifest is right.

## What this module owns

**Routes**

- `/`

**APIs**

- `/api/home`

**MCP tools**

_No MCP tools yet. Every user-facing action should grow one — the MCP server is a front door to the same governed code, not a back door around it._

**Needs deployed**

- `opensearch`

## Layout

- `lib/`
- `ui/`

- `lib/` tab logic · `ui/` tab-specific components · `mcp/` this tab's MCP handlers

## Rules that apply here

1. **Import only `@core/*` and this module.** A cross-tab need means the shared part belongs in `@core`.
2. **The kernel must not import this module.** `@core` does not know its tabs exist.
3. **Pages live in `os-ui/app/`**, thin, importing from here. Next.js serves routes only from there.
4. Every source file carries a `FEATURE:` / `USER STORY:` / `ARCHITECTURE:` header. `scripts/check-structure.mjs` enforces it as a ratchet.

See [`../../../CLAUDE.md`](../../../CLAUDE.md) for the full structure rules and [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) for the constraints this codebase punishes you for ignoring.
