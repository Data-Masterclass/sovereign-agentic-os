# Sovereign Agentic OS — overview

## What this is

The Sovereign Agentic OS is a single governed operating system for your data, knowledge, and software. Every action — whether taken through the UI or through this MCP server at `/api/mcp` — travels the same OPA-policy-checked, row/document-level-security (DLS) filtered, Langfuse audit-traced path. The MCP is not a backdoor; it is the same governed pathway as the UI.

## The ten surfaces

| Tab | What lives here |
|---|---|
| **Data** | Governed datasets: Bronze → Silver → Gold tier ladder |
| **Knowledge** | Canonical steps, rules, and tacit know-how |
| **Connections** | Named credentials consumed by reference, never exposed |
| **Agents** | Agent systems grounded in knowledge, built and run here |
| **Software** | Apps and services wired to governed deps |
| **Metrics** | Canonical metric definitions backed by gold data |
| **Dashboards** | Per-viewer charts bound to governed metrics |
| **Big Bets** | Strategic initiatives referencing real OS components |
| **Files** | Binary and document assets, promotable to shared |
| **Science** | Governed predict door into ML models |

## The tier ladder

Every asset starts **Personal** (visible only to you). A Builder can gate it to **Shared** (visible to domain members). An Admin can certify it to the **Marketplace** (tenant-wide). Promotion always requires documentation first. Moving an asset to a higher tier never widens row-level access — DLS is enforced independently.

```
Personal  →[Builder gate]→  Shared  →[Admin gate]→  Certified / Marketplace
```

## The cross-tab spine

Work flows in a directed graph across tabs:

```
data (Gold) ──→ metrics ──→ dashboards ──→ big bets
knowledge ──────────────────────────────→ agents
connections ──→ software ──[use_as_data]──→ data (Bronze)
```

Build data first to Gold, then define metrics on it, compose dashboards from metrics, and anchor big bets to those dashboards. Ground agents in published knowledge. Wire software to connections; close the loop by exporting app output back into the Bronze data tier.

## Tools, resources, and prompts

- **Tools** — imperative calls that create or read state (e.g. `create_dataset`, `define_metric`). Most writes require a role gate.
- **Resources** — read-only `sovereign-os://` URIs that return structured documents (e.g. `sovereign-os://my/datasets`, `sovereign-os://tenant/connections`). Use these to discover what already exists.
- **Prompts** — slash commands that trigger pre-built guided flows on the server side (e.g. `/new-dataset`, `/promote`).

## How to start a session

Always call `whoami` and `list_capabilities` first. `whoami` tells you your role (creator / builder / admin), tenant, and active domain. `list_capabilities` tells you which tools are enabled for this tenant. Then read the relevant pathway guide before issuing any write calls.

## Discovery before create

Before creating anything, check what already exists. Read `sovereign-os://my/<resource>` or call the appropriate `list_*` tool. Reuse governed assets rather than duplicating them — the OS is designed around a single source of truth per concept.
