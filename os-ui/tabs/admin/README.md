# Platform · Manage

Tenant administration: domains, users and access, tenant settings, models and providers, backups, and platform health. Labelled **Platform** in the UI.

The authoritative contract is [`manifest.ts`](./manifest.ts) — this file explains it; the manifest is what the checks and the docs generator read. If the two disagree, the manifest is right.

## What this module owns

**Routes**

- `/platform`
- `/components`
- `/mcp`
- `/about`
- `/settings`

**APIs**

- `/api/platform`
- `/api/platform-admin`
- `/api/users`
- `/api/mcp`

**MCP tools**

- `platform`
- `discovery-read`

**Needs deployed**

- `opensearch`
- `postgres`
- `litellm`
- `opa`

## Layout

- `lib/`
- `mcp/`
- `ui/`

- `lib/` tab logic · `ui/` tab-specific components · `mcp/` this tab's MCP handlers

## Rules that apply here

1. **Import only `@core/*` and this module.** A cross-tab need means the shared part belongs in `@core`.
2. **The kernel must not import this module.** `@core` does not know its tabs exist.
3. **Pages live in `os-ui/app/`**, thin, importing from here. Next.js serves routes only from there.
4. Every source file carries a `FEATURE:` / `USER STORY:` / `ARCHITECTURE:` header. `scripts/check-structure.mjs` enforces it as a ratchet.

See [`../../../CLAUDE.md`](../../../CLAUDE.md) for the full structure rules and [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) for the constraints this codebase punishes you for ignoring.
