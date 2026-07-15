# How to use this MCP

## What this is

The Sovereign Agentic OS MCP is the **same governed front door as the UI** — every call runs AS the signed-in user, is OPA-policy-checked, row/document-level-security (DLS) filtered, and Langfuse audit-traced. It is not a back door or a privileged bypass: the same rules that govern the UI govern you here.

## Your first three moves

1. **`whoami`** — learn who you are: your user id, role (creator / builder / domain_admin / admin), and the domain(s) you belong to. Your role determines what you can do; read it before anything else.
2. **`list_capabilities`** — see every available tool split into *available* (you can call these now) and *gated* (your role or the tenant config blocks them). No guessing.
3. **Pick a golden path** — call `get_guide('<pathway>')` or read `sovereign-os://guide/path/<pathway>` for the exact tool sequence for what you want to build.

## The golden paths

| Pathway | What you build / explore |
|---|---|
| `overview` | OS surfaces and the cross-tab spine |
| `governance` | Roles, tier ladder, promotion gates |
| `data` | Ingest → Bronze → Silver → Gold datasets |
| `knowledge` | Canonical steps, rules, tacit know-how |
| `connections` | Named credentials consumed by reference |
| `agents` | Agent systems grounded in knowledge |
| `software` | Apps and services wired to governed deps |
| `metrics` | Canonical metric definitions backed by gold data |
| `dashboards` | Per-viewer charts bound to governed metrics |
| `bigbets` | Strategic initiatives tracking real OS components |
| `files` | Binary and document assets |
| `science` | Governed predict door into ML models |
| `strategy` | Pillars and value spine |
| `marketplace` | Browse and install certified shared assets |
| `monitoring` | Cost, usage, and system health |

## Role summary

Your role is set by the platform — you cannot self-elevate.

| Role | What you can do |
|---|---|
| **creator** | Create and run your OWN work; consume shared/certified assets; FILE promotion requests (cannot approve or certify) |
| **builder** | Everything a creator can, PLUS approve Personal → Shared in your domain (`approve_promotion`, `publish_knowledge`, `decide_deploy`, `promote_connection`) |
| **domain_admin** | Everything a builder can, PLUS administer users in your OWN domain(s) (invite, edit, deactivate; roles up to builder only) and all domain-scoped governance approvals |
| **admin** | Everything tenant-wide: certify to the Marketplace, cross-domain big bets, policy overrides, cost caps, and appointing domain admins |

If a tool returns `forbidden`, your role is below the gate — file a request (`request_promotion`) or ask a Builder/Admin.

## Build on what exists

Before creating anything, discover what is already there:

- Read `sovereign-os://my/<datasets|knowledge|connections|files|metrics|dashboards|agents|software|bigbets|science>`
- Or call the matching `list_*` tool (e.g. `list_datasets`, `list_knowledge`)

Reuse existing ids rather than duplicating assets — the OS is built around a single source of truth per concept.

## Tool errors

All errors are typed `{code, reason, hint}`. Follow the `hint` — it tells you the next step (e.g. `forbidden` → ask a Builder; `not_found` → check your role/tier; `conflict` → the asset already exists).
