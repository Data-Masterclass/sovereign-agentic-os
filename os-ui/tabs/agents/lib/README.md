<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# Agents — architecture & seam guide

The **Agents** tab is where a domain agent is composed, governed and run. An agent
is a **system** (instructions + tools + memory) that only ever acts through the
**governed gateway**: every tool call is authorized (LiteLLM key + OPA) and
Langfuse-traced, and may return `allow` / `deny` / `requires_approval`.

This document describes the shipped code, not internal design notes.

## Module map (`os-ui/lib/agents/`)

| Module | Role | `server-only`? |
|---|---|---|
| `system-schema.ts` | Pure agent-`System` types (instructions, tools, memory) + validate. | no |
| `gateway.ts` | The governed tool gateway: `invokeTool`, `Authorizer`/`Tracer`, `Decision` (`allow`/`deny`/`requires_approval`). | no |
| `assistant.ts` | `applyInstruction` — natural-language edits to an agent system. | no |
| `routing.ts` | Model/route selection for a call (local vs hosted). | no |
| `canvas-edit.ts` / `canvas-layout.ts` | Pure edit + layout for the visual agent canvas. | no |
| `langgraph-compile.ts` | Compiles a `System` to an executable graph. | no |
| `store.ts` | The agent registry (create/list/update, tier + grants); re-exports `Role`. | yes |
| `build/` | Live execution clients (the run plane). | mixed |

Pure modules (no `server-only`) are unit-tested directly with `node --test`.

## Cross-tab seams

| Seam | Direction | Interface | Status |
|---|---|---|---|
| **Knowledge → Agents** | in | `knowledge/context-pack` (attach-as-context) + `knowledge/agent-scaffold` (scaffold from certified workflows). | wired (real) |
| **Connections → Agents** | in | A governed connection is exposed as an agent tool (`connections` registry). | wired (real) |
| **Agents → Governance** | out | A held write-back (`requires_approval`) enqueues an approval (connection write, certify, promote). | wired (real) |
| **Agents → Monitoring** | out | Every gateway call is Langfuse-traced; Monitoring correlates traces/lineage. | wired (real) |
| **Agents → Marketplace** | out | A certified agent lists as an `agent` product via the Marketplace registry. | wired (real) |

The gateway is the invariant: no agent tool runs except through `invokeTool`, so OPA
+ trace + the approval seam apply uniformly regardless of which tab originated the call.
