<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# Connections

A **Connection** is a governed bridge to a system outside (or inside) the platform:
`credentials + endpoint metadata + a set of governed tools`, never a raw pipe. The
secret **never leaves Secrets Manager** — every use goes through a governed tool
(LiteLLM + OPA), via the egress proxy (allowlist + DLP), Langfuse-traced. We grant
**use**, never the token. One governed connection serves two usages with the same
creds and governance: an **agent tool** (governed tool calls) and a **data source**
(Database/API/SaaS → dlt → Bronze; Drive → Files).

## Golden path

1. **Create** — `createConnection` starts from a template's **safe preset** (reads
   on, writes off, deletes Blocked). OAuth templates mint a token via the adapter
   and store only its `secretRef`; service templates take a supplied credential.
2. **Test** — `testConnection` probes reachability without echoing the secret.
3. **Shape** — `updateCapabilities` sets per-tool mode/limits; the profile compiles
   to the OPA bundle the runtime enforces.
4. **Grant** — `grantToAgent` restricts (never broadens) which tools an agent sees.
5. **Use** — `callConnectionTool` (agent) or `enableDataUsage` (data source).
6. **Promote** — Personal → Shared via `promoteConnection`, and **only** through the
   governance ladder seam (`lib/governance/ladder.ts`), never called directly.

## Public API

Import the tab through `@/lib/connections` (`index.ts`) — never its internal files.
Client components that must avoid the `server-only` store deep-path
`@/lib/connections/schema` and `@/lib/connections/connectors`.

- **`store.ts`** — the governed adapter (`server-only`): create / test / capabilities /
  grant / tool-call / data-usage / promote / lifecycle / versions, plus OAuth + Notion
  MCP token handling. Every write runs authorize → act → trace.
- **`schema.ts`** — pure types + safe-preset **templates** (`Connection`,
  `CapabilityMode`, `ConnectionTemplateKey`, `templateByKey`, `userFacingTemplates`,
  `isExposed`, `CAPABILITY_MODES`, …).
- **`connectors.ts`** — the static connector catalogue (`CONNECTORS`,
  `CONNECTOR_CATEGORIES`) for the picker.
- **`connection-adapters.ts`** — the per-connector adapter interface + the launch
  adapters (`adapterFor`, `auth · test · generateTools · compilePolicy · sync`).
- **`egress-requests.ts`** — Builder-request → Admin-approve for new endpoints +
  the outbound log (`requestEgress`, `decideEgress`, `isHostApproved`, `egressLog`).
- **`connections-physical-delete.ts`** — physical secret purge on DELETE (never on
  archive).

The compiler (`capability-compiler.ts`), governed spine (`agent-governed.ts`),
secrets (`secrets.ts`) and data hand-off (`data-handoff.ts`) live in `lib/` and are
imported down into the store — they are shared infra, not this tab's internals.

## Invariants

- **The secret is a reference, never a value.** Records, API responses, traces and
  logs carry only `{name, key}` + a `sha256:…` fingerprint.
- **Safe by default.** A new connection reads on, writes off, deletes Blocked.
- **Restrict-only on share/grant** — a grant may narrow the exposed tools, never
  broaden them.
- **One decision spine.** The offline mirror and live OPA evaluate the **same**
  `decide()`, so the two enforcement points cannot drift.
- **Promotion goes through the ladder seam only.** `promoteConnection` is called
  from `store.ts` (definition) and `lib/governance/ladder.ts` (seam) — nowhere else
  (enforced by `lib/mcp/mcpv2-p0.test.ts`).
