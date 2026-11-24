<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# Connections Phase 5: tool connections through the LiteLLM MCP gateway

**Status:** design for review, 24 Nov 2026. No code yet. It implements the owner's decisions of
23 Nov.
**Depends on:** PR #334 (durable, encrypted connection-secret store), PR #333 (Company scope),
and `LITELLM_SALT_KEY` being set (`docs/ops/litellm-salt-key.md`).
**Supersedes:** "Phase 5" in `docs/superpowers/plans/2026-10-29-litellm-integration.md:214-216`.

## Summary

Tool connections (Notion, Slack, GitHub, Atlassian, Gmail and others) move from hand-written
connectors that call vendor APIs with one stored credential to **MCP servers registered in
LiteLLM's MCP gateway**.

Each connection has an **auth mode**:

- **per-user** (the default wherever the kind supports it): every person uses their own account;
- **shared**: one credential for everyone. It needs an explicit tick and a warning, and the
  approver depends on scope (domain_admin for Domain, admin for Company). The tick is confirmed
  again on every scope widening.

**Credentials live encrypted in LiteLLM**, keyed by a LiteLLM user that the OS creates for each
person. The OS holds a per-person LiteLLM key that can only call MCP. People never sign in to
LiteLLM. They connect their accounts in the OS, and the OS runs OAuth itself. Scheduled runs use
one service user per domain, never a person's login. Approvals execute with the requester's
credential. Every call records who acted, in which mode and whose credential was used.

Some things stay in the OS: the warehouse/Trino federation, dlt/Dagster data syncs and Drive
indexing. These are data paths, not agent tools. The licence of the LiteLLM image is an open
decision (section 9).

## 1. Current state (evidence)

| What | Where | Today |
|---|---|---|
| Connection record | `os-ui/tabs/connections/lib/schema.ts:186-236` | **one** `secretRef` per connection (line 195), one `owner`, one `principal`. `auth: 'oauth' \| 'service'` (line 113) only labels the credential. It does not decide whose credential a call uses |
| Visibility | `tabs/connections/lib/store.ts:500-512` | `Personal` (My), `Shared` (Domain), `Certified` (Company), strict domain isolation. PR #333 makes Company visible in all domains |
| Templates | `schema.ts:377`, `schema.ts:1111` | 26 user-facing templates: Drive, OneDrive, Notion MCP, generic API/MCP, Airflow, GitHub, Supabase, Atlassian, Slack, Gmail, GCal, Outlook, Teams, Entra, Purview, AI Foundry, SageMaker, GCP identity/directory, Snowflake governance, Salesforce, Kajabi, SAP OData, OData v4, Workday RaaS |
| Hand-written clients | `tabs/connections/lib/{slack,github,gmail,gcal,outlook,teams,atlassian,salesforce,notion,…}.ts` | one REST client per vendor, each with a `*-client.test.ts` |
| Tool execution | `store.ts:1833` `callConnectionTool` | authz from the compiled capability profile (`authorizeConnectionCall`), then `runAllow(c, …)` with **the connection's single credential** |
| Approvals | `store.ts:2120-2152` `approveOnce` | the **approver** resumes the call, which runs with the connection's credential (`runAllow(c, …)`). The requester's identity is not used |
| OAuth today | `store.ts:2790-2860`, `app/api/connections/oauth/[provider]/{authorize,callback}/route.ts`, `core/auth/{pkce,state,token-set,providers}.ts` | the OS runs OAuth itself, but **only the owner** may complete it (`store.ts:2794`) and only for Drive. Tokens go to `c.secretRef` |
| Notion hosted MCP | `core/auth/notion-mcp.ts`, `core/auth/notion-flow.ts`, `tabs/connections/lib/external-mcp-source.ts:1-17` | already per-user OAuth against `mcp.notion.com` with dynamic client registration, a real MCP client (`tools/list`, `tools/call`). This is the pattern Phase 5 generalises |
| Secret store | `os-ui/core/infra/secrets.ts` (283 lines) | an in-process Map. PR #334 replaces it with Kubernetes Secrets sealed with AES-256-GCM |
| LiteLLM MCP | `charts/sovereign-agentic-os/values.yaml:930-935` | one bundled server, `sovereign_query` (query-tool). Mirrored by `os-ui/tabs/admin/lib/mcp-registry.ts:78,287` |
| LiteLLM keys | `docs/components/litellm.md:505-530` | one key per agent system (`os-<systemId>`), stored encrypted in `agent_system_keys` (Postgres `agent_runs`) under `AGENT_KEY_ENCRYPTION_KEY`. **No per-person keys** |
| Salt key | `values.yaml:622-633`, `docs/ops/litellm-salt-key.md` | `litellmSaltKey` exists but is empty. Unset, LiteLLM encrypts DB credentials **with the master key** |
| Image | `values.yaml:710-712` | `ghcr.io/berriai/litellm-database:1.109.1@sha256:932c…` |
| Network | `templates/base/network/litellm-ingress-policy.yaml`, `values.yaml:604-612` | LiteLLM ingress only from os-ui, os-ui-worker, the key-init Job. Egress through the proxy with `noProxy` for in-cluster names |

Verified on dev on 23 Nov (owner's notes, LiteLLM 1.109.1):

- per-user credentials are keyed by LiteLLM `user_id`;
- BYOK seeding works through `POST /v1/mcp/server/{id}/user-credential`, and OAuth seeding
  through `POST /v1/mcp/server/{id}/oauth-user-credential`;
- LiteLLM refreshes OAuth tokens itself;
- `object_permission` is enforced per server and per tool;
- **the MCP protocol endpoint works, but `/mcp-rest/tools/list` returns 500 for BYOK servers.**
  Use the protocol endpoint only.

## 2. Target model

### 2.1 Objects

```
Connection (OS record, governance)                         LiteLLM (execution + credential vault)
├─ id, name, template, scope (My/Domain/Company), owner     MCP server  os-conn-<id>
├─ authMode: 'per-user' | 'shared'                          ├─ url / transport / auth_type
├─ sharedApproval?: {by, role, at, scopeAtApproval}         ├─ per-user creds: (server, user_id) → secret
├─ litellmServerId                                          └─ shared cred (shared mode only)
├─ tools[] capability profile (unchanged)
└─ grants[] to agents (unchanged)                          LiteLLM user  os-u-<uid>   (one per person)
                                                           LiteLLM user  os-svc-<domain> (one per domain)
Per-person MCP key (OS-held, encrypted)                    Key  alias os-mcp-<uid>
                                                           ├─ models: []  (no model access)
                                                           └─ object_permission.mcp_servers / mcp_tool_permissions
```

- The OS record keeps **governance**: scope, owner, capability profile, agent grants, approvals,
  audit.
- LiteLLM keeps **execution and secrets**: it reaches the MCP server and holds the credentials.
- `secretRef` stays only for the connections that stay in the OS (2.6).

### 2.2 Auth mode

| | per-user | shared |
|---|---|---|
| Default | yes, for every kind whose upstream supports per-person auth (OAuth or personal token) | never a default |
| Whose credential | the caller's own (`user_id` = `os-u-<caller>`) | the one stored on the server |
| Who may set it | the creator | creator ticks "everyone uses this account" and sees the warning. The approval is **domain_admin** (Domain scope) or **admin** (Company scope) |
| Scope widening (My→Domain→Company) | no extra step | **re-confirm** the shared tick at every widening, by the role for the new scope. Without it the widening is refused |
| Cross-domain, Company scope | **usable by everyone** with their own credential | **see, not use** outside the owning domain |
| Caller has no credential yet | the tool answers `needs_connect` with a "Connect your account" link. Never a silent fallback to someone else's credential | n/a |

Kinds that only support a service credential (for example Workday ISU, SAP OData basic, OData
OAuth client credentials) can only be `shared`. The UI says why.

### 2.3 Per-person LiteLLM user and key

- **Provisioning:** on the first connection use (lazily), or when an admin enables Phase 5 (bulk).
  The OS calls `/user/new` with `user_id = os-u-<uid>`, no models, no UI role, and `/key/generate`
  with alias `os-mcp-<uid>`, `models: []` and `object_permission` set to the MCP servers that
  person may use (2.4).
- **Storage:** the key value is stored like agent-system keys: AES-256-GCM in Postgres (new table
  `user_mcp_keys`, same database and pattern as `agent_system_keys`), bound to the uid, under the
  existing `AGENT_KEY_ENCRYPTION_KEY` or a sibling key. The key never reaches a browser, a trace or
  git.
- **No LiteLLM login, ever:** the user has no password and no UI role. Credentials are added only
  through the OS (2.5).
- **Deprovisioning:** deactivating a user blocks the key (`/key/block`) and deletes their per-user
  credentials. Deleting the user deletes the LiteLLM user. This hooks into `onDirectoryChange`
  (`core/kernel/events.ts:63`).
- **Domain service users:** `os-svc-<domain>` with its own key `os-mcp-svc-<domain>`. These are
  used only by scheduled runs (2.7).

### 2.4 Authorisation: two layers, neither widens the other

1. **OS (authoritative):** connection visibility (store `visibleToUser`, as changed by #333), the
   capability profile per tool (Off / Read / Write-approval / Write-bounded / Blocked), agent
   grants, and approvals. This is unchanged: `authorizeConnectionCall` runs before any call.
2. **LiteLLM (defence in depth):** the per-person key's `object_permission.mcp_servers` lists
   exactly the connections that person may use. `mcp_tool_permissions` lists only the tools that
   are not `Off`/`Blocked`. A reconciler rewrites it on every grant, scope, profile or membership
   change, plan first, one direction, drift reported (the Phase 3 pattern,
   `litellm.md` "Reconcile: OS → LiteLLM").

### 2.5 Adding a credential (the OS runs every flow)

| Kind | Flow | Seeded with |
|---|---|---|
| OAuth (Notion, Slack, GitHub, Atlassian, Google, Microsoft) | the OS's existing PKCE flow (`core/auth/pkce.ts`, `state.ts`, `providers.ts`), extended to **any visible connection, not only the owner** (lift `store.ts:2794` for per-user mode) | `POST /v1/mcp/server/{id}/oauth-user-credential` with `user_id = os-u-<uid>`, access + refresh token, expiry. LiteLLM refreshes from then on |
| Microsoft / Google, already signed in to the OS with that IdP | **token exchange** where the tenant allows it (Entra on-behalf-of; Google is limited to what its OAuth allows). The person consents to the scopes once | as above |
| Personal API token (BYOK) | OS form, posted server-side only | `POST /v1/mcp/server/{id}/user-credential` |
| Shared | OS form, by the approving role | the server's own credential at `/v1/mcp/server` create/update |

The OS keeps only a **fingerprint and status** per (connection, person): connected, expired or
needs reconnect, and when. It never keeps the secret. "Disconnect" deletes the LiteLLM per-user
credential.

### 2.6 What stays in the OS (not moved to LiteLLM)

| Path | Why |
|---|---|
| Warehouse federation (Glue, Databricks, Snowflake → Trino catalogs, exposures) | data plane, governed by Trino/OPA, not a tool call |
| dlt / Dagster syncs (`dataUsage: 'bronze'`) | batch ingest with run grants (WP-15) |
| Drive / OneDrive indexing (`dataUsage: 'files'`) | Files tab ingest and DLS. The OAuth token stays in the OS secret store (#334) |
| `sovereign_query` | already a bundled LiteLLM MCP server. Unchanged |

A connection can be both: for example Notion as a tool (LiteLLM) and as a Files source (OS). The
two credentials are separate, and the UI shows both.

### 2.7 Scheduled runs and agents

- **Interactive agent run:** MCP calls use the **invoking person's** key, so the person's own
  credential applies in per-user mode.
- **Scheduled agent run:** uses `os-svc-<domain>` for the agent's domain, **never the owner's
  personal login**. A per-user connection therefore needs a domain service credential for
  schedules. The domain_admin connects it once ("schedule account"), it is shown as such, and the
  shared-mode warning applies. Without it, the scheduled call answers `needs_service_credential`.
- **Approvals:** a held write is executed **with the requester's credential**. The approver's key
  is not used. `approveOnce` / `approveAndRemember` (`store.ts:2120-2200`) pass the requester's
  uid through to the call. If the requester's credential is gone or expired, the approval fails
  with "requester must reconnect", never with a fallback.

### 2.8 Call path

```
OS tool call (UI / MCP / agent)
  → OS authz (visibility, profile, grant, approval)            unchanged, store.ts:1833
  → pick key: person (interactive) | os-svc-<domain> (schedule) | requester (approval)
  → MCP protocol call to LiteLLM  /mcp  (tools/call, server = os-conn-<id>)
       LiteLLM: object_permission check → inject (server, user_id) credential → MCP server
  → result + audit
```

The OS uses the MCP protocol endpoint for both `tools/list` and `tools/call`, through the existing
MCP client used for Notion (`core/auth/notion-mcp.ts`), pointed at LiteLLM. It never uses
`/mcp-rest/tools/list` (500 for BYOK servers).

### 2.9 Audit

Every call writes a trace and, for writes and approvals, an `os_governance.audit_events` row
(`core/adapters/postgres/audit.ts`) with:

| Field | Value |
|---|---|
| `actingUser` | uid of the person (or `svc:<domain>` for schedules) |
| `credentialMode` | `per-user` \| `shared` \| `domain-service` |
| `credentialSubject` | whose credential: the uid, `shared:<connection>` or `os-svc-<domain>` |
| `agentSystem`, `runId` | when an agent made the call |
| `approvedBy` | for approved writes; the requester stays `actingUser` |
| `connection`, `tool`, `decision`, `fingerprint` | never the secret |

LiteLLM's spend log carries `user = os-u-<uid>` and tags (`connection:<id>`), which gives a
second, cross-checkable record. LiteLLM `/audit` is Enterprise-only, so the OS log is the system
of record.

### 2.10 Network

- Each MCP server that LiteLLM calls needs egress from LiteLLM:
  - a vendor-hosted server (for example `mcp.notion.com`) goes through the egress proxy plus the
    allowlist (`llmProviders.allowHosts`, or a new `mcpGateway.allowHosts`);
  - an in-cluster server needs a NetworkPolicy that admits LiteLLM, and its name in `NO_PROXY`
    (`values.yaml:604`, `noProxy`).
- The OS re-checks the egress allowlist before registering a server, as `external-mcp-source.ts`
  does today.
- Generic MCP (user-entered URL) is refused for private or cluster addresses (the existing SSRF
  guard in Models & Providers).

## 3. Connector mapping (hand-written → MCP)

Rule: use an **official vendor MCP server** where one exists, with a permissive licence for
anything we run ourselves (`feedback-license-policy-permissive`: no GPL/LGPL/MPL/BSL/SSPL). Keep
the hand-written client only where no official server exists. Verify each row before
implementation; this table is the plan, not a finding.

| Template | Plan | Notes |
|---|---|---|
| notion-mcp | hosted official (`mcp.notion.com`) | already MCP; move the transport to LiteLLM |
| github | official GitHub MCP server (hosted or self-run) | check the licence of the self-hosted image |
| atlassian | official Atlassian remote MCP | per-user OAuth |
| slack | official Slack MCP if available, else keep | verify |
| gmail, gcal, outlook, teams, entra | Microsoft / Google official MCP if available, else keep | token exchange (2.5) |
| supabase | official Supabase MCP | per-user token |
| salesforce | keep for now: `sf_*` actions use the four-layer authz (`store.ts:1854-1856`) | revisit after |
| airflow, kajabi, purview, ai-foundry, sagemaker, gcp-*, snowflake-governance, sap-odata, odata-v4, workday-raas | keep as OS connectors (service credential; shared only) | move only if an official MCP server appears |
| generic-mcp | LiteLLM server from the user's URL | per-user or shared |
| generic-api | stays in the OS | not MCP |
| gdrive, onedrive | stay in the OS | Files ingest |

## 4. Migration of existing connections

Every connection today is single-credential, so it is effectively **shared**.

1. **Inventory** (read-only script): list connections by template, scope, owner and whether a
   credential is set. Output to the owner before any change.
2. **Default mapping:**
   - **My scope:** becomes `per-user`. The owner's existing credential is seeded as the owner's
     per-user credential. Nothing visible changes for the owner.
   - **Domain / Company scope:** stays `shared`, with `sharedApproval` recorded as "migrated,
     unconfirmed". The domain_admin (Domain) or admin (Company) sees a banner to either confirm
     shared or switch to per-user. Until confirmed, behaviour is unchanged.
3. **Register in LiteLLM** per connection (`os-conn-<id>`), only for kinds that are moving (3).
   The credential moves from the OS secret store (#334) into LiteLLM: as the server's credential
   for shared, as a per-user credential for My. After a verified call, the OS copy is deleted.
4. **Dual path behind a flag** `OS_CONNECTIONS_VIA_LITELLM` per template. Off = today's
   hand-written client. One template at a time, Notion first (already MCP).
5. **Rollback:** flag off for that template. The OS secret copy is kept until the template has been
   live for 14 days on prod. After that, rollback means asking people to reconnect.

## 5. Preconditions

- [ ] `LITELLM_SALT_KEY` set on dev and prod (`litellmSaltKey.existingSecret`) **before** the first
  credential is stored. Today the master key would encrypt them, and rotating it would lose
  every credential (`docs/ops/litellm-salt-key.md`).
- [ ] PR #334 merged (credentials survive restarts and are visible to the worker).
- [ ] The image decision (section 9).
- [ ] The OAuth apps (Notion, Atlassian, GitHub, Microsoft, Google) registered with the OS
  callback (`app/api/platform-admin/oauth-apps/route.ts` already manages them).

## 6. Tests

| Level | Test |
|---|---|
| Unit | auth-mode rules: default per-user, shared needs the right role, re-confirm on widening, Company per-user usable cross-domain, Company shared see-not-use; key selection (person / service / requester); audit fields always present; no secret in any trace (existing masking tests extended) |
| Contract (real LiteLLM 1.109.1 in a container, like `scripts/tests/gateway-models`) | create server; seed BYOK and OAuth per-user creds; two users call the same server and each upstream receives its own token (a stub MCP server that echoes the bearer); `object_permission` denies an unlisted server or tool; token refresh by LiteLLM; MCP protocol `tools/list` works for BYOK (pin the `/mcp-rest` 500 as a known-bad) |
| Integration | approval runs with the requester's credential; scheduled run uses `os-svc-<domain>` and fails honestly without it; deactivation blocks the key and deletes credentials |
| E2E (dev) | Notion per-user: two real accounts see different pages; shared Domain connection with the warning; Company per-user from another domain |
| Independent verifier | a reviewer who did not build it checks the two-user isolation on dev |

## 7. Risks

| Risk | Mitigation |
|---|---|
| Salt key not set before credentials are stored | hard precondition; os-ui refuses to seed credentials while LiteLLM reports no salt key (startup check) |
| LiteLLM outage stops all tool calls | honest `gateway_unreachable` errors; data paths (2.6) are unaffected; LiteLLM already has a readiness probe and one replica. Consider two |
| Wrong person's credential used | key selection is one function with tests; LiteLLM keys by `user_id`; the two-user contract test |
| Shared credential spreads silently | widening re-confirm; banner for migrated shared connections; audit `credentialMode` |
| Vendor MCP server changes tools | capability profile maps tool names; unknown tools default to `Off` |
| `/mcp-rest` 500s | never used; contract test pins it |
| LiteLLM API changes on upgrade | contract tests run on every LiteLLM bump (`docs/ops/litellm-upgrade.md`) |
| Proprietary code in the image | section 9 |

## 8. Phased tasks

- [ ] **P0 — preconditions.** Salt key on dev, #334, image decision, OAuth apps.
- [ ] **P1 — identities.** LiteLLM user and MCP-only key per person (lazy) and per domain;
  `user_mcp_keys` table; deprovision on directory change.
- [ ] **P2 — record and UI.** `authMode`, `sharedApproval`, `litellmServerId` on the connection;
  create/edit UI with the shared tick, warning and approval; re-confirm on widening; "Connect your
  account" per connection.
- [ ] **P3 — credential flows.** Generalise OAuth beyond the owner and Drive; seed per-user creds
  into LiteLLM; BYOK form; status and fingerprint; disconnect.
- [ ] **P4 — call path.** MCP protocol client to LiteLLM; key selection; approvals with the
  requester's credential; scheduled runs with the domain service user; audit fields.
- [ ] **P5 — object_permission reconciler.** Plan first, drift reported.
- [ ] **P6 — Notion first.** Flag on for `notion-mcp` on dev, verify, then prod after the owner says
  go.
- [ ] **P7 — template by template.** Per section 3. Each template gets its own flag, tests and
  verifier.
- [ ] **P8 — migration.** Inventory, default mapping, banners, credential move, delete OS copies
  after 14 days.
- [ ] **P9 — clean up.** Remove the hand-written clients that were replaced; update
  `docs/components/litellm.md` and the connections README.

## 9. Open questions for the owner

1. **The LiteLLM image (licence).** `litellm-database:1.109.1` ships the proprietary
   `litellm_enterprise` module, and it is imported on hot paths. Our policy allows permissive
   licences only. Options:
   - **A.** Build our own image from the MIT-licensed LiteLLM source **without** the `enterprise/`
     package, and patch or guard the hot-path imports. We own a small patch on every upgrade, and
     we must prove that nothing we use needs the module.
   - **B.** Use the upstream image and treat the module as present but unused. This is the fastest
     option, but it conflicts with the licence policy as written. It needs a written exception.
   - **C.** Upstream a fix (make the import optional) and pin until it lands. This is the cleanest
     long term, but the timeline is not ours.
   - **D.** Put a separate permissive MCP gateway in front of the MCP servers and keep LiteLLM for
     models only. This brings more components and loses the per-user credential vault we verified.

   Recommendation: A now, C in parallel.
2. **Schedules with per-user connections.** Is a domain "schedule account" (2.7) acceptable, or
   should schedules be refused for per-user connections?
3. **Token exchange.** Do you want Microsoft on-behalf-of exchange in the first version, or start
   with the plain OAuth consent screen for everyone?
4. **Migrated Domain/Company connections.** Keep them `shared` until a domain_admin decides
   (recommended), or switch to `per-user` on a date and ask everyone to connect?
5. **Per-person LiteLLM keys and budgets.** MCP calls cost nothing at the gateway. Do you want a
   request-rate limit per person on the MCP key (recommended: yes, matching agent keys)?
