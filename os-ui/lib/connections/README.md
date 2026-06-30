<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# Connections — architecture & adapter guide

A **Connection** is a governed bridge to a system outside (or inside) the platform:
`credentials + endpoint metadata + a set of governed tools`, never a raw pipe. The
**secret never leaves Secrets Manager** — every use goes through a governed tool
(LiteLLM + OPA), via the egress proxy (allowlist + DLP), Langfuse-traced. We grant
**use**, never the token.

**One connection, used two ways:** the same governed connection is both an **agent
tool** (governed tool calls) and a **data source** (Database/API/SaaS → dlt → Bronze;
Drive → Files). Same creds, same governance; only the usage differs.

This document is self-contained: it describes the shipped code, not any internal
design notes.

## Module map (`os-ui/lib/`)

| Module | Role | `server-only`? |
|---|---|---|
| `connection-model.ts` | Pure types + safe-preset **templates** (the connection record, capability modes, launch-set templates). | no |
| `capability-compiler.ts` | The **capability-profile → OPA compiler** (one rule). | no |
| `connection-adapters.ts` | The **per-connector adapter interface** + the 5 launch adapters. | no |
| `governance.ts` | **Two-mode write-back** (Mode A preview + standing policy; Mode B safety presets). | no |
| `data-handoff.ts` | dlt → Bronze + Drive → Files registries (the second usage). | no |
| `egress-requests.ts` | Builder-request → Admin-approve for new endpoints + outbound log. | no |
| `secrets.ts` | Mock Secrets Manager (ref, never the value) + egress allowlist. | **yes** |
| `agent-governed.ts` | Governed spine: registers compiled bundles, `authorizeConnectionCall` (delegates to the compiler), Langfuse `trace`. | **yes** |
| `connections.ts` | The registry: create / test / capabilities / promote / grant / tool-call / data-usage. | **yes** |

The pure modules (no `server-only`, no secrets) are unit-tested directly with
`node --test` (`*.test.ts`). The server-only modules wire them to the request.

## The connection record (`Connection`)

Key fields (see `connection-model.ts` for the full, commented type):

- `type` (`Drive | Database | API | MCP | SaaS`) and `connector` (`drive | database |
  api | mcp | saas`) — the adapter family.
- `auth` (`oauth | service`) — per-user OAuth (personal, any user) vs service
  credentials (shared, Builder/Admin).
- `secretRef: { name, key }` + `secretFingerprint` — **a reference and a one-way
  fingerprint, never the secret value**.
- `tools: ConnectionTool[]` — the **capability profile**: per-tool
  `mode` (`Off | Read | Write-approval | Write-bounded | Blocked`) + `limits`
  (`dataScope`, `rateLimitPerMin`, `costCapUsd`, `maxAmount`, `argConstraints`).
- `grants: ConnectionGrant[]` — per-agent grants (**restrict-only**).
- `health`, `dataUsage`, `egress`, `visibility` — status surfaces.

A new connection starts from the **safe preset** for its template: reads on, writes
off, deletes Blocked.

## The capability-profile → OPA compiler (`capability-compiler.ts`)

One source (the capability profile) is compiled to **(1)** an OPA **data bundle**
(`OpaConnectionBundle`, JSON, hot-reloaded by OPA) and **(2)** a pure `decide()`
evaluator that mirrors the static **generic Rego** (`GENERIC_REGO`, also shipped at
`charts/sovereign-agentic-os/policies/connections.rego`). Because the offline mirror
(`agent-governed.ts`) and a live OPA evaluate the **same `decide()`**, the two
enforcement points cannot drift. Rules:

| mode | decision |
|---|---|
| `Off` / `Blocked` | deny (Blocked needs an Admin override to enable) |
| `Read` | allow |
| `Write-approval` | requires_approval (held) |
| `Write-bounded` | allow within `maxAmount`, deny outside |

A per-agent grant (`bundle.grants[agent] = [...tools]`) further restricts — a tool
not in the grant is denied even if the profile exposes it. On share/grant you may
**restrict, never broaden**.

## OAuth / secrets flow

1. **Personal (OAuth):** any user picks a Drive/Slack template → `createConnection`
   runs the adapter's `auth` op, which **mints a token** (live OAuth exchange when a
   client is injected; a deterministic mock token in kind) and writes it to Secrets
   Manager. The record keeps only the `secretRef`. Silent refresh keeps `health:
   'healthy'`; a hard failure flips to `needs-reconnect` (the UI shows **Reconnect**).
2. **Shared (service creds):** a Builder/Admin supplies a credential; same storage
   contract. The token **never** appears in the record, an API response, a trace, or
   a log line — only the `{name, key}` ref and a `sha256:…` fingerprint do.

## The per-connector adapter interface (`connection-adapters.ts`)

Every connector implements the **same five operations**, each individually verified
with the apply→verify discipline (`runVerified`):

```
auth · test · generateTools · compilePolicy · sync
```

- **`auth`** — establish a credential (OAuth or service); returns the value to store.
- **`test`** — probe reachability / credential validity (never echoes the secret).
- **`generateTools`** — the **tool-generation** step: OpenAPI import (`openApiToTools`)
  for API, list-tools for MCP, or the safe static preset for Drive/Database/SaaS.
- **`compilePolicy`** — delegates to the compiler (so the gate is identical everywhere).
- **`sync`** — the data-source sync (dlt → Bronze / Drive → Files).

All five plug into the **same** record / capability profile / OPA / Secrets Manager /
egress / Langfuse — **so a new connector is just a new adapter** (`adapterFor(kind)`),
nothing else changes.

### Live vs mock (the dual path)

Each adapter op takes optional injected `clients` (`oauth`, `probe`, `schema`,
`sync`). When a live client is present and reachable, the op runs **live**
(`mode: 'live'`); otherwise it falls back to a deterministic **offline mock**
(`mode: 'offline-mock'`). The kind gate exercises the mock path; a real deploy injects
fetch-backed clients so the connector tools are fully functional. This mirrors the
agent-runtime dual pattern (`lib/agents/build/`). The injection seam for the real
clients is the `AdapterClients` interface — implement it server-side and pass it in.

## Two-mode write-back governance (`governance.ts`)

Governance depends on whether a **human is present at run time**:

- **Mode A — in-tab assistants (human present).** A `Write-approval` call **pauses
  inline** with a **full preview** (`buildPreview`: action · args · before/after diff ·
  who · reason). The owner or a domain Builder/Admin approves; **"approve & remember"**
  (`rememberPolicy`) creates an editable **bounded standing policy** so identical calls
  within the bound auto-run (`matchStandingPolicy`) without prompting. No approver →
  notify + checkpoint + resume; timeout → deny.
- **Mode B — autonomous agents (no human).** Each agent has a **safety preset**
  (`read-only → read-propose → read-bounded → full-in-scope`), inheriting the domain
  default and fine-tunable per tool (`effectivePreset`). The capability profile is the
  ceiling (`resolveAutonomous`). **Out-of-policy ⇒ block + log + queue for async
  Governance-inbox review** — never an inline prompt.

Both modes compile from the capability profile + the preset into the same decision;
`Write-bounded` runs within limits without prompting, `Blocked` never runs.

## Roles, sharing & egress

- **Ladder:** Personal (any user) → Shared (Builder/Admin) → Marketplace (Admin).
  Marketplace publishes the **template + capability profile** by default — consumers
  **bring their own credentials**; no secret leaves the owner.
- **Agents** get connections only by **Builder attachment** (`grantToAgent`), never
  the whole domain.
- **Egress is default-deny.** Admins pre-curate an allowlist; for a new endpoint a
  Builder **requests** and an Admin **approves** (`egress-requests.ts`). All outbound
  is logged (`logEgress`).

## Adding a new connector

1. Add a template to `CONNECTION_TEMPLATES` (`connection-model.ts`) with its safe
   preset tools, `connector`, `auth`, and `secretKey`.
2. If it needs bespoke auth/test/tool-gen/sync, add a `ConnectionAdapter` and register
   it in the `ADAPTERS` map (`connection-adapters.ts`). Reuse the shared helpers for
   the common cases. `compilePolicy` is shared — don't reimplement the rule.
3. (Optional) implement the live `AdapterClients` for the new backend.

That's it — the record, capability profile, OPA compile, secrets, egress, governance
and tracing are all inherited.
