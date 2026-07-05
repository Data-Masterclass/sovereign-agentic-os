<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# ADR 0005 — MCP is the front door, never a back door

**Status:** Accepted (invariant live for all shipped tools; parity-matrix CI test planned) · **Source:** `os-ui/lib/mcp/server.ts`, `write-tools.ts`, `discovery-tools.ts`, mcp-v2 design/plan

## Context

The OS exposes itself to external AI clients (Claude, ChatGPT) and to its own
Agent-tab systems as MCP servers. The moment any tool takes a privileged
shortcut — its own SQL, its own store access, an identity from the request
body — governance forks into "the UI rules" and "the agent rules", and the
audit story is dead.

## Decision

**Everything doable headlessly must run through the exact same governed door
as the UI.** Concretely: every tool's `call()` delegates to the same `lib`
function the UI route calls, under the caller's session identity (`CurrentUser`
— never trusted from the request body). `minRole` floors are a conservative
visibility gate; the lib re-gates authoritatively (OPA, DLS/RLS, role rank).
Internal Agent-tab systems run their tool calls through this same per-user
governed toolset — an agent can never do more than its owner. Failures return
typed `{ code, reason, hint }` so a model can self-correct.

## Consequences

- One enforcement seam: a policy fix lands once and covers UI, external MCP
  clients, and internal agents; Langfuse audit is uniform.
- New capability = new lib function first, thin MCP tool second — tools that
  would wrap a stub are deferred, not shipped as placebos (e.g.
  `trigger_retrain` is deliberately unshipped until the Dagster adapter lands).
- Planned enforcement: a checked-in parity matrix (UI capability → tool or
  documented exclusion) failing CI on drift; the six MCP v2 surfaces
  (Strategy/Marketplace/Governance/Monitoring/Platform-Admin/Science-lifecycle)
  are designed but **not built yet**.
