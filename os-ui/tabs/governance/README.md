# Governance · Manage

Approvals, policy, audit, role definitions and the egress allowlist. Everything that is policy rather than administration.

The authoritative contract is [`manifest.ts`](./manifest.ts) — this file explains it; the manifest is what the checks and the docs generator read. If the two disagree, the manifest is right.

## What this module owns

**Routes**

- `/governance`

**APIs**

- `/api/governance`
- `/api/policy`

**MCP tools**

- `governance`

**Needs deployed**

- `opa`
- `opensearch`
- `postgres`

## Layout

- `lib/`
- `ui/`

- `lib/` tab logic · `ui/` tab-specific components · `mcp/` this tab's MCP handlers

- `context.md` — the system prompt context this tab gives an agent

## Agent-run approvals (A2)

A held write from a running agent system lands here as an approval that **carries its run**:
`runId`, the system, the agent node, the tool and its arguments, and the runner's identity. The
card shows them with an "Open run ↗" link. Approving or denying **resumes the parked run**: the
approver authorises, the **runner executes** (their role is re-read live; a runner who was
deactivated or lost the role makes the resume refuse, shown on the card as `resume refused`).
A denied call reaches the agent as a typed rejection and the run continues. Parked approvals have
no TTL in v1 (open policy question — see `docs/components/os-ui.md`). The resume itself is wired
by the Agents tab (`tabs/agents/lib/engine/resume-boot.ts`) through `core/policy/approvals.ts`
`onDecided` — this module stays unaware of the engine.

## Rules that apply here

1. **Import only `@core/*` and this module.** A cross-tab need means the shared part belongs in `@core`.
2. **The kernel must not import this module.** `@core` does not know its tabs exist.
3. **Pages live in `os-ui/app/`**, thin, importing from here. Next.js serves routes only from there.
4. Every source file carries a `FEATURE:` / `USER STORY:` / `ARCHITECTURE:` header. `scripts/check-structure.mjs` enforces it as a ratchet.

See [`../../../CLAUDE.md`](../../../CLAUDE.md) for the full structure rules and [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) for the constraints this codebase punishes you for ignoring.
