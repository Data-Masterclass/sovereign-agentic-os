# How to use this MCP

## What this is

The Sovereign Agentic OS MCP is the **same governed front door as the UI** — every call runs AS the signed-in user, is OPA-policy-checked, row/document-level-security (DLS) filtered, and Langfuse audit-traced. It is not a back door or a privileged bypass: the same rules that govern the UI govern you here.

## Your first three moves

1. **`whoami`** — learn who you are: your user id, role (creator / builder / domain_admin / admin), and the domain(s) you belong to. Your role determines what you can do; read it before anything else.
2. **`list_capabilities`** — see every available tool split into *available* (you can call these now) and *gated* (your role or the tenant config blocks them). No guessing.
3. **Pick a golden path** — call `get_guide('<pathway>')` or read `sovereign-os://guide/path/<pathway>` for the exact tool sequence for what you want to build (`overview` and `governance` live at `sovereign-os://guide/overview` and `sovereign-os://guide/governance`).

A plain **question** ("which datasets do I have?") needs none of this: call the matching read tool (`list_*`, `get_*`, `search_*`, `query_*`, `find`) directly.

## The golden paths

| Pathway | What you build / explore |
|---|---|
| `overview` | OS surfaces and the cross-tab spine |
| `governance` | Roles, tier ladder, promotion gates |
| `data` | Ingested or curated datasets; business layer auto-materializes |
| `knowledge` | Notes: free-form markdown documents (`save_knowledge_note`), searchable |
| `workflows` | Documented business processes: steps, actors, rules, tacit know-how (`author_workflow`) |
| `connections` | Named credentials consumed by reference |
| `agents` | Agent systems grounded in knowledge |
| `software` | Apps and services wired to governed deps |
| `metrics` | Canonical metric definitions backed by gold data |
| `dashboards` | Per-viewer charts bound to governed metrics |
| `files` | Binary and document assets |
| `monitoring` | Cost, usage, and system health |

## Role summary

Your role is set by the platform — you cannot self-elevate.

| Role | What you can do |
|---|---|
| **creator** | Full, unapproved rights over your OWN **My** work (create · edit · run); consume Domain/Company assets; FILE promotion requests (cannot approve or certify) |
| **builder** | Everything a creator can, PLUS approve software deploys (`decide_deploy`). Files promotion requests like anyone — the artifact My → Domain approval itself is a domain admin's |
| **domain_admin** | Everything a builder can, PLUS APPROVE every My → Domain artifact promotion in your domain (`approve_promotion`, `publish_workflow`, `promote_connection`) |
| **admin** | Everything tenant-wide: certify My/Domain → Company, policy overrides, cost caps, and all user administration (invite, edit, deactivate, assign roles, appoint domain admins) |

**My is yours.** In your own My scope there is NO approval — you (and the agents you build, which run AS you) create and write freely. Approval only enters when you promote up a scope: **Domain** needs a domain admin, **Company** needs an admin. You can only change what you originally built. If a tool returns `forbidden`, your role is below a promotion gate — file a request (`request_promotion`) or ask a domain admin.

## Build on what exists

Before creating anything, discover what is already there:

- Read `sovereign-os://my/<datasets|knowledge|workflows|connections|files|metrics|dashboards|agents|software>`
- Or call the matching `list_*` tool (e.g. `list_datasets`, `list_knowledge`)

Reuse existing ids rather than duplicating assets — the OS is built around a single source of truth per concept.

## Tool errors

All errors are typed `{code, reason, hint}`. Follow the `hint` — it tells you the next step:

| `code` | Meaning | What to do |
|---|---|---|
| `forbidden` | Your role is below the tool's floor, or the item is outside your scope | Keep the work in My scope, or file `request_promotion` and hand off to a domain admin |
| `not_found` | The id does not exist **or** you cannot see it (the two are indistinguishable on purpose) | Re-read the id from the matching `list_*` tool |
| `bad_request` | An argument is missing or malformed | Check the tool's `inputSchema` — every tool carries an example |
| `conflict` | The item is not in a state that allows this call (already done, blocked by a dependent, a duplicate name) | Read `reason` and the item's current state before reporting success |
| `sql_error` | `query_data` SQL is not valid Trino SQL | Fix the SQL as the hint says and retry |
| `toolset_not_loaded` | External MCP door only: the tool's toolset is not loaded in this session | Load the toolset the hint names (the hint carries the exact call), then retry |
| `upstream_error` / `ENGINE_UNAVAILABLE` | A component the tool needs is unreachable, or this deployment refuses to fabricate a result | Your arguments are fine — check Platform → Overview & Health, then retry |
