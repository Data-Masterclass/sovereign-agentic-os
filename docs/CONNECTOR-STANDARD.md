<!-- SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt) -->

# Connector Design Standard — Sovereign Agentic OS

**Status: normative. This is the quality gate.** Every new connector — federated
warehouse, operational database, SaaS API, hand-built or federated MCP — MUST meet
every bar below before it ships. Paste the relevant sections into any
connector-building agent brief; run the **Definition of Done** checklist against
any PR that adds or changes a connector.

The bar is deliberately high because a connector is the OS's blast radius into
someone else's system. A sloppy connector leaks a credential, runs as the wrong
identity, or fakes a green test — any one of those is a failure, not a nit.

This doc is grounded in the connectors that already exist in
`os-ui/lib/connections/**`. The excerpts below are the canonical examples; a new
connector that looks like them passes, one that doesn't must justify why.

> **House rules (apply throughout):** safe, robust, simple, short. Tell the truth,
> ask when unsure. Surgical changes only — a new connector is one module plus its
> registry entries, never a cross-cutting refactor. `karpathy-guidelines` apply.

---

## 0. The five non-negotiables (read first)

A connector that violates any of these is rejected on sight, regardless of how
polished the rest is:

1. **Runs as the signed-in user.** Every tool executes under the caller's
   delegated identity, OPA-checked, RLS/DLS-filtered, audit-traced. **No
   service-identity fallback, ever.**
2. **Write-only secrets.** Credentials go in through `putSecret` and come back
   only as a `SecretRef` + fingerprint. The raw value NEVER lands in a record, an
   API response, a log line, a Langfuse trace, or git.
3. **Reads vs writes.** Reads are side-effect-free and auto-allowed. Writes
   side-effect the external system and default to **Write-approval** (held for a
   human). Deletes are **Blocked** by default.
4. **Honest failure.** `test_connection` does a real round-trip and returns an
   honest ✗ on failure. A connector NEVER fakes green, NEVER claims a URL it does
   not serve, NEVER invents data.
5. **Egress-allowlisted.** Every external call is checked against the tenant
   egress allowlist before it leaves.

Everything else in this document is how to satisfy these five well.

---

## 1. Architecture — the registry + per-connector module contract

### 1.1 One module per service; one registry entry

The OS models connectors as a **registry of declarative modules**. The warehouse
family is the reference implementation: a giant `switch` over every platform was
refactored into ONE `WarehouseProvider` object per file under `providers/`, all
registered in `registry.ts`, so provider teams work on disjoint files
(`warehouse/provider.ts`):

> *"`trinoCatalogProps(source)` used to be one giant `switch` over every platform
> in a single file… The skeleton refactor splits that switch into a REGISTRY of
> `WarehouseProvider` objects — ONE object per file under `providers/` — so
> provider teams work on disjoint files."*

**PASS:** a new connector is exactly one new module (+ its template row, install
guide, and tests), registered in one place. **FAIL:** logic for the new service
smeared across shared `switch`/`if` blocks that every other connector's team must
now edit.

### 1.2 Typed config; a provider-style interface

A connector is **declarative metadata + pure functions**. The `WarehouseProvider`
type is the model to copy: it answers *how to render config, what credential
fields to collect, what secret material to mount, how to probe, how it maps to
discovery* — all as data, with `catalogProps` a **pure** function (same input →
same output, no I/O, no secrets) that throws `WarehouseError` on bad input.

The non-warehouse family models the same idea as a `ConnectionTemplate`
(`schema.ts`) — `key`, `label`, `type`, `connector` (adapter family), `auth`
(`oauth | service`), `endpointHint`, `secretKey`, and a **safe preset `tools[]`**.

A connection RECORD (`Connection` in `schema.ts`) carries only non-secret data —
endpoint, `principal`, `secretRef`, `secretFingerprint`, `egress` status, the
capability `tools[]`, and per-agent `grants[]`. The interface split is strict:

- **Pure/client-safe module** (types + presets + pure render/validate functions) —
  imported by both client editor and server routes. `schema.ts` is `'use client'`-safe;
  it has **no** `server-only` import and **no** secret access.
- **Server bridge** (`'server-only'`) — resolves the connection under the caller's
  identity, dereferences the vaulted secret HERE, injects it into the outbound
  call, and never returns it. See `airflow.ts`'s `airflowConnFrom` /
  `resolveAirflow`.

**PASS:** config is a typed object; pure logic is unit-testable with no cluster and
no secrets. **FAIL:** `any`-typed config bags; secrets read in "pure" code; a
client bundle that imports server-only credential code.

### 1.3 How it plugs into the Connections tab

The Connections tab is a fixed IA the connector inherits for free by being
metadata-driven:

- **4-section IA** consistent with every OS tab: **All / My / Shared / Marketplace**.
- **Supported Connectors** gallery — cards render from the template/provider
  registry; each card links its **Installation Guide** (§6).
- **Wizard** (`ConnectorWizard.tsx`) — ONE shared stepper. Steps and fields are
  **driven by the chosen template's metadata** (auth kind + connector kind +
  provider fields), never hardcoded per platform:

> *"The steps and fields are DRIVEN by the chosen template's metadata … never
> hardcoded per platform, so a new template (om-catalog, airflow, …) that the API
> starts returning flows through automatically."*

- **Grouping-by-type + search** — connectors group by `ConnectionType`
  (`Drive | Database | API | MCP | SaaS`) and are searchable.

**PASS:** the connector appears in the gallery, wizard, and MCP `list_connection_templates`
with zero bespoke UI. **FAIL:** a one-off form or hardcoded wizard branch for the
new service.

---

## 2. Governance (non-negotiable)

**Every connector tool runs AS the signed-in user.** This is the whole product:
the MCP is *"a front door, not a back door: the SAME governed path as the UI."*

### 2.1 Delegated identity, default-deny, audited

Discovery/read tools are thin delegates over the exact governed lib function the UI
calls, under the caller's delegated identity (`discovery-tools.ts`):

> *"Each is a THIN delegate over the SAME governed lib function the UI calls, under
> the caller's delegated identity, so OPA + document/row-level-security … + Langfuse
> audit apply UNCHANGED. No privileged path here: identity comes from the session,
> the role floor is re-checked in `handleRpc`, and the governed fn is always the real
> authority."*

Authorization is **default-deny and fails CLOSED** (`governed.ts`): if OPA is
unreachable the answer is *deny*, marked `policy: 'opa-unreachable'` — an OPA
outage can never silently open authz. (`OPA_FAIL_OPEN=true` exists only for the
offline teaching flow.)

The metric-read path shows the run-as-user discipline for real data
(`query_metric` in `discovery-tools.ts`):

> *"the load runs under YOUR delegated identity — the securityContext is derived
> from the session claims (never a service account), so Cube's RLS is the caller's."*

### 2.2 No service-identity fallback

There is exactly one identity in play: the caller's. A connector may hold a
service **credential** to *reach* the external system (e.g. an Airflow bearer
token), but the **authorization** decision, the RLS/DLS scoping, and the audit
subject are always the signed-in user. Two viewers of the same connection get two
different, correctly-scoped result sets. An unseeable id returns `not_found` — no
existence leak (`getConnectionForUser` → DLS 404).

**FAIL:** any code path that, on a missing user token, "falls back" to a shared
service account to complete the call. That is a security defect, not a convenience.

### 2.3 Reads vs writes (writes held for approval)

The capability model (`schema.ts`) is the contract:

```ts
export type CapabilityMode = 'Off' | 'Read' | 'Write-approval' | 'Write-bounded' | 'Blocked';
// Off:            not exposed at all (default for anything unneeded)
// Read:           read-only; safe, auto-allowed
// Write-approval: side-effecting; each call held for human approval (Governance tab)
// Write-bounded:  allowed only within explicit policy limits (amounts, scope)
// Blocked:        explicitly forbidden (e.g. delete); needs an Admin override
```

The gate is enforced **upstream** in `callConnectionTool` — the actual client
helper (e.g. `triggerDag`) is only reached once the call is allowed. Comment the
helper accordingly, as Airflow does:

> *"NOTE: the GOVERNANCE gate (Write-approval) is enforced UPSTREAM in
> `callConnectionTool` — this function is only reached once a call is allowed."*

Governance ladder for the connection artifact itself: **Personal → Shared**
(Builder/domain-admin gate via `promote_connection`) → **Certified** (Admin).
Personal OAuth connections are connectable by any user; SHARED service-credential
templates require a Builder/Admin to create (`isPersonalConnectable`).

**PASS:** reads `Read`; writes `Write-approval` (or `Write-bounded` with explicit
limits); deletes `Blocked`; the preset ships safe. **FAIL:** a write auto-allowed;
a delete exposed; the gate re-implemented inside the client instead of upstream.

---

## 3. Secrets (non-negotiable)

**THE ONE RULE (`secrets.ts`): the secret never leaves Secrets Manager.** The
connection record holds only a reference; the raw value is written server-side and
NEVER serialized into a record, an API response, a Langfuse trace, or a log line.

### 3.1 The exact flow

**Write (once, server-side):**

```ts
// lib/infra/secrets.ts — returns ONLY a reference
export function putSecret(name: string, key: string, value: string): SecretRef {
  const ref = { name, key };
  vault().set(refKey(ref), value);
  return ref;
}
```

The record then stores `secretRef`, `secretSet`, and a **non-reversible**
`secretFingerprint` (`sha256:` + 12 hex chars) — safe to show/audit, impossible to
reverse. The MCP `create_connection` tool states this to the model in its own
schema: *"stored server-side, fingerprinted, never returned."*

**Read (server-side only, at call time):**

```ts
// Dereference HERE; inject into the outbound call; never return to client or trace.
export function getSecretServerSide(ref: SecretRef): string | null { ... }
```

Airflow's bridge is the template — the secret is fetched at the last moment and
used ONLY to build the auth header:

```ts
export function airflowConnFrom(c: Connection): AirflowConn {
  const secret = getSecretServerSide(c.secretRef) ?? undefined; // never leaves the server
  return { baseUrl: c.endpoint, /* … */ secret, fetchImpl: fetch };
}
// airflowAuthHeaders: "The secret is used ONLY to construct the header; it is
// never returned or logged."
```

### 3.2 Referenced, never inlined (config-render connectors)

For connectors that render engine config (warehouse), the secret is referenced by
an env var the deploy layer wires from a vault secret — the material NEVER appears
in rendered props. Snowflake is canonical:

```ts
// connection-private-key: the PEM is supplied by the deploy layer as an env var,
// sourced from a vault secret. The PEM is NEVER written into these props.
'connection-private-key': '${ENV:SNOWFLAKE_PRIVATE_KEY}',
```

`secretMaterial` declares exactly which vault keys back the connector and which env
vars its config references (`{ secretKeys, envVars }`). Empty arrays are valid and
**meaningful** — Glue authenticates via IRSA and needs no secret material at all.

### 3.3 Egress allowlist checked before every external call

`isEgressAllowed(endpoint)` (`secrets.ts`) must pass before any external call. An
endpoint is external unless it targets an in-cluster/local host; external hosts
must be on the tenant allowlist (`egressProxy.allowlist` + Cilium FQDN policy) or
an Admin-approved egress request. Add the connector's hosts to `DEFAULT_ALLOWLIST`
(and the chart) as part of the PR, exactly as the Drive/OneDrive OAuth endpoints
were added.

### 3.4 Never committed (gitleaks)

No real secret, token, key, or PEM in code, tests, fixtures, or docs. Tests use
obvious fakes (`secret_xxx`). gitleaks runs in CI; a hit blocks the PR.

**PASS:** the only place a raw credential exists is Secrets Manager; everywhere
else it is a `SecretRef` or `${ENV:...}`; the fingerprint is the most anyone sees.
**FAIL:** a secret in a record/response/log/trace/test; a credential inlined into
rendered config; a real token in git; an unallowlisted host reached.

---

## 4. Federate a first-party MCP vs hand-build — the decision

The OS is not in the business of re-implementing every SaaS API. Where a solid
**official/first-party MCP server** exists, **federate/wrap it**; hand-build only
where none exists.

### 4.1 Decision criteria

**FEDERATE (wrap an existing MCP)** when ALL hold:
- A **first-party or reputable** MCP server exists for the service
  (e.g. GitHub, Atlassian/Jira, Notion, Stripe, Microsoft 365, Google Workspace).
- It supports **per-user OAuth** (auth code + PKCE / OAuth 2.1, ideally DCR) so
  each user authorizes their own account — Notion's hosted MCP is the model:
  *"dynamic client registration (DCR) + PKCE, so the connect flow provisions itself."*
- Its tool surface is **stable and typed**.

Notion (`notion-mcp` template) is the reference federated connector: personal OAuth
2.1 + PKCE, we store only a token reference, and `Verify · list tools` runs a real
MCP `tools/list` to prove it is live.

**HAND-BUILD (a typed client)** when:
- **No** MCP server exists, or the only one is unmaintained/untrusted, OR
- The integration is a **database via Trino** (postgres/mysql/sqlserver/mongodb —
  read-only federated catalogs with pushdown), **object storage**, or a **bespoke
  warehouse** where a governed SQL/JDBC catalog is the right primitive, OR
- We need **tighter capability shaping** (per-tool bounds, cost caps) than the MCP
  exposes.

Airflow is the reference hand-built client: no first-party MCP, so a small typed
REST client (12 tools) with injected `fetch`, v2→v1 fallback, and never-throw
`{ ok:false, reason }` results.

### 4.2 Both paths stay governed

Federation is **not** a bypass. A federated MCP is still a `Connection` with:
- a vaulted **token reference** (never the raw token),
- a **capability preset** with our modes (reads `Read`, writes `Write-approval`,
  delete `Blocked`) — we do NOT blindly expose the upstream's whole surface,
- egress-allowlisted host,
- calls routed through `callConnectionTool` so OPA + audit apply,
- **no token passthrough** — per current MCP guidance, never forward a client token
  to an upstream API unvalidated; the OS mediates every call under the caller's
  identity.

**PASS:** the build/federate choice is stated in the PR with the criteria above,
and either path lands as a governed `Connection`. **FAIL:** hand-rolling a client
for a service with a perfectly good first-party MCP; or federating an MCP and
handing its raw tool surface to agents ungoverned.

---

## 5. Engine/service specifics — respect each service's quirks

Generic connectors silently break on real systems. The warehouse family encodes
the quirks explicitly and a new connector MUST do the equivalent for its service.
The generalized checklist (modeled on `IdentifierRules` / `DiscoveryMode` /
`TypeRule` / `notes`):

| Quirk | Warehouse mechanism | What a new connector must do |
|---|---|---|
| **Auth** | `credentialFields` + `secretMaterial`; RSA key-pair, IRSA, SP, PAT | Use least-privilege, read-only creds; OAuth 2.1 + PKCE where available; short-lived tokens + refresh rotation over static keys |
| **Identifier quoting/casing** | `IdentifierRules { quote, unquotedCase }` | Never fold unquoted user input into a query/path; validate + quote per the service (Snowflake upper-cases unquoted → match case-insensitively) |
| **Discovery** | `DiscoveryMode: 'show' \| 'terse' \| 'none'` | Enumerate the cheap way; if there's no metastore (Fabric/OneLake) **honestly degrade** to known-locations, don't fake `SHOW SCHEMAS` |
| **Type mapping** | `importTypeRules: TypeRule[]` | Cast types with no faithful target **honestly** and surface the lossy note (Snowflake `VARIANT → json`), never coerce silently |
| **Pagination** | (API) | Follow cursors to completion or bound with an explicit limit + `truncated` flag (see `AIRFLOW_LOG_MAX`) |
| **Rate limits** | (API) | Respect `Retry-After` on 429/503; capped exponential backoff **with jitter**; never hammer |
| **Idempotency** | (API writes) | Send an idempotency key on retryable writes so a retry can't double-apply |
| **Cost** | `notes` | State the cost model (Snowflake warehouse auto-resume consumes credits; BigQuery bills bytes-scanned) so callers aren't surprised |
| **Honest limits** | `liveVerificationRequired`, `notes` | List exactly what needs live customer creds to verify — no hand-waving |

Snowflake's provider is the worked example: `identifierRules: { quote: '"',
unquotedCase: 'upper' }`, `discoveryMode: 'terse'`, `importTypeRules` casting
`VARIANT → json` with a note, and `notes` warning about auto-resume credits and
RSA-only auth.

**PASS:** every quirk that applies to the service is encoded as data with an honest
note. **FAIL:** a "generic" connector that assumes ANSI identifiers, unbounded
result sets, no rate limits, and lossless types.

---

## 6. Lifecycle + UX

The lifecycle is **connect → test → use**, and it is honest at every step.

1. **Connect** — via the shared wizard (metadata-driven fields) or a Supported
   Connector card. Personal OAuth completes **server-side**; only a token
   reference is stored (Drive/OneDrive/Notion).
2. **Test** — `test_connection` does a **real round-trip** and returns
   `live | offline` + an honest detail string. Airflow's probe hits the real
   health endpoint; a network error means genuinely unreachable — it is **said**,
   not papered over. **Never fake green.**
3. **Use** — consumed by reference (`use_connection`) from apps/agents; every call
   is governed.

**A REQUIRED Installation Guide per connector** (`install-guides.ts` +
`InstallationGuide.tsx`). Each guide answers three questions honestly —
**Prerequisites** (what the user must already have, incl. their own cloud creds),
**Steps** (numbered path to a working connection), **What the OS does** — plus an
optional `caveat` for experimental/unverified paths. Fabric's guide is the honesty
benchmark: it is explicitly labeled EXPERIMENTAL with the Azure OAuth wiring marked
UNVERIFIED. **No guide → not shippable.**

**PASS:** a real test round-trip; an authored install guide; grouping + search work
because the connector is registry-driven. **FAIL:** a test that returns green
without a round-trip; a missing/marketing-fluff install guide; an "available" card
for something not wired end-to-end (see `USER_FACING_TEMPLATE_KEYS` — a user can
never stand up a non-working mock connection).

---

## 7. Tool design

### 7.1 Naming / verb taxonomy

- **Reads:** `list_*`, `get_*`, `search_*`, `read_*`, `profile_*`. Side-effect-free.
- **Writes:** `create_*`, `update_*`, `trigger_*`, `import_*`, `set_*`, `clear_*`.
- Prefix service-specific tools with the service (`notion_search`, not `search`)
  when federating, to avoid collisions.
- Descriptions state, in order: **what** it does, the **path/step** it belongs to,
  what comes **before/after**, and the **governance** line (read-only, DLS-scoped;
  or write held for approval). Copy the density of `discovery-tools.ts` descriptions.

### 7.2 Approval + limits

- Reads **auto-approved**; writes **approval-gated** (`Write-approval`), or
  `Write-bounded` with explicit `CapabilityLimits` — `dataScope`, `rateLimitPerMin`,
  `costCapUsd`, `maxAmount`, `argConstraints`. The Salesforce preset is the model:
  `update_opportunity_amount` is `Write-bounded` with `maxAmount: 50000`,
  `rateLimitPerMin: 5`, `costCapUsd: 1`.
- **Least-privilege scopes.** Request only the scopes a tool needs; read-only
  wherever the tool only reads (`drive.readonly`, `Files.Read`, a read-only DB role).

### 7.3 Idempotency, pagination, honest failure

- **Idempotency:** retryable writes carry an idempotency key so a retry returns the
  original result rather than double-applying.
- **Pagination/limits:** page to completion or bound with an explicit limit and a
  `truncated` flag; never dump unbounded output into a tool result.
- **Honest failure:** tools **never throw to the caller** — degrade to
  `{ ok: false, reason }` (Airflow's discipline) so errors surface without crashing.
  Fail ✗; **NEVER fake-green**; NEVER invent data; NEVER claim a URL not served.

**PASS:** verbs and modes match the taxonomy; writes are bounded/idempotent; every
tool has an honest failure path. **FAIL:** a read that mutates; a write that
auto-runs; a tool that throws or fabricates on error; unbounded output.

---

## 8. Testing bar

"Done" means **both** of these, and CI is green:

1. **Unit tests over pure logic** — config render, identifier quoting/validation,
   type-cast planning, URL/host derivation, CTAS building, auth-header building.
   Pure functions are tested with **no cluster and no secrets** (every warehouse
   provider has a `*.test.ts`; `import.test.ts` tests CTAS strings; `secrets.test.ts`
   proves the write-only contract; `connections-gate.test.ts` proves the governance
   gate). Include the negative cases: bad identifiers throw `WarehouseError`; a
   deny/`opa-unreachable` blocks; a missing secret yields no auth header.
2. **A live/integration check** — a real `test_connection` round-trip against the
   service (or, where only live customer creds can verify, an explicit
   `liveVerificationRequired` list that says so honestly). The offline/mock path
   must be **labeled** (`mode: 'offline-mock'`), never presented as live.

Coverage of the five non-negotiables is mandatory: a test that a secret never
appears in the serialized record/response; a test that a write is held; a test that
an unseeable id returns `not_found`.

**PASS:** pure logic unit-tested incl. failure cases; a real round-trip test or an
honest live-verification list; offline paths labeled. **FAIL:** no tests; tests that
need live creds to run at all; a mock path that masquerades as live.

---

## 9. Templates a builder copies

### 9.1 Connector-module skeleton (hand-built API/service)

```ts
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt) */

// ---------- (a) schema.ts: template row (pure, client-safe) ----------
{
  key: 'acme',
  label: 'ACME (REST API)',
  type: 'API',            // Drive | Database | API | MCP | SaaS
  connector: 'api',       // adapter family
  auth: 'service',        // 'oauth' (personal) or 'service' (Builder/Admin)
  endpointHint: 'https://api.acme.example.com',
  secretKey: 'acme-token',
  tools: [
    { name: 'acme_list_items', description: 'List items (read).', write: false, mode: 'Read' },
    { name: 'acme_get_item',   description: 'Read one item (read).', write: false, mode: 'Read' },
    { name: 'acme_create_item',description: 'Create an item (write).', write: true,
      mode: 'Write-approval', limits: { dataScope: 'your ACME workspace', rateLimitPerMin: 10 } },
    { name: 'acme_delete_item',description: 'Delete an item (write).', write: true, mode: 'Blocked' },
  ],
}

// ---------- (b) acme.ts: pure client + server bridge ('server-only') ----------
import 'server-only';
import { getSecretServerSide } from '@/lib/infra/secrets';
import { getConnectionForUser } from '@/lib/connections/store';

export type AcmeRead<T> = { ok: true; data: T } | { ok: false; reason: string };

/** Pure client — fetch injected, secret injected as an arg, never logged/returned. */
export function acmeAuthHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = { accept: 'application/json' };
  if (token) h.authorization = `Bearer ${token}`;   // secret used ONLY to build the header
  return h;
}

/** Never throws: honest reason on failure. Respect Retry-After; backoff w/ jitter. */
export async function acmeListItems(base: string, token: string | undefined,
  fetchImpl = fetch): Promise<AcmeRead<unknown[]>> {
  try {
    const res = await fetchImpl(`${base}/items`, { headers: acmeAuthHeaders(token), cache: 'no-store' });
    if (res.status === 429) return { ok: false, reason: `rate-limited; retry after ${res.headers.get('retry-after') ?? '?'}s` };
    if (!res.ok) return { ok: false, reason: `ACME ${res.status}` };
    const j = await res.json();
    return { ok: true, data: Array.isArray(j.items) ? j.items : [] };  // paginate/bound here
  } catch { return { ok: false, reason: 'unreachable' }; }
}

/** Server bridge: resolve under the caller's identity (DLS), deref secret HERE. */
export async function resolveAcme(connId: string, user: CurrentUser) {
  const c = await getConnectionForUser(connId, user);        // DLS 404 (no existence leak)
  if (c.template !== 'acme') { const e = new Error('Not an ACME connection') as any; e.status = 400; throw e; }
  return { base: c.endpoint, token: getSecretServerSide(c.secretRef) ?? undefined };
}
// The Write-approval gate is enforced UPSTREAM in callConnectionTool — a write
// helper is only reached once the call is allowed. Add hosts to the egress allowlist.
```

### 9.2 Installation Guide template (required)

```ts
const ACME: InstallGuide = {
  key: 'acme',
  title: 'ACME (REST API)',
  summary: 'Connect a customer ACME account via its REST API. Reads auto-allow; writes are held for approval.',
  prerequisites: [
    'The ACME **base URL**, reachable from the OS — host on the **egress allowlist**.',
    'An ACME **API token** (read scope where possible). Goes to Secrets Manager; **never** on the record.',
    'Builder/Admin rights (service-credential connector, not personal OAuth).',
  ],
  steps: [
    'On the ACME card, click **Connect**.',
    'Enter the connection **name** and the ACME **base URL**.',
    'Provide the **token** — stored once in Secrets Manager.',
    'Create the connection, then **Test** on its card; tune the per-tool capability profile.',
  ],
  whatTheOsDoes:
    'Registers a governed outbound API connection. Reads auto-allow; writes are held at **Write-approval** until a Builder trusts them. All calls are OPA-checked and audit-traced.',
  caveat: 'ACME reachability + token scope are only confirmed against your live account at Test time.',
};
```

---

## Definition of Done — the reviewer's checklist

Run this against any PR that adds or changes a connector. **Every box must be
checked**; an unchecked box is a blocker, not a nit.

**Governance (non-negotiable)**
- [ ] Every tool runs AS the signed-in user (delegated identity); **no** service-identity fallback.
- [ ] Authorization is default-deny and **fails closed** (OPA-unreachable ⇒ deny).
- [ ] RLS/DLS applies; an unseeable id returns `not_found` (no existence leak).
- [ ] Every call is Langfuse-audit-traced.

**Secrets (non-negotiable)**
- [ ] Credential written via `putSecret`; record holds only `secretRef` + fingerprint.
- [ ] Secret NEVER in a record, response, log, trace, or rendered config (uses `${ENV:...}` where config is rendered).
- [ ] Egress allowlist checked before external calls; hosts added to allowlist + chart.
- [ ] No real secret in code/tests/fixtures/docs; gitleaks clean.

**Reads vs writes**
- [ ] Reads `Read` (auto-allowed); writes `Write-approval` (or `Write-bounded` + explicit limits); deletes `Blocked`.
- [ ] The gate is enforced upstream in `callConnectionTool`, not re-implemented in the client.
- [ ] Least-privilege scopes; retryable writes carry an idempotency key.

**Architecture**
- [ ] One module per service; one registry entry; typed config; pure logic separated from the server bridge.
- [ ] Federate-vs-hand-build decision stated with the §4 criteria (federated MCP has no token passthrough).
- [ ] Appears in gallery + wizard + `list_connection_templates` with no bespoke UI.

**Engine/service specifics**
- [ ] Identifier quoting/casing, discovery mode, type mapping, pagination, rate-limit backoff-with-jitter, and cost all handled — or honestly degraded with a note.
- [ ] `liveVerificationRequired` / caveats list exactly what needs live creds.

**Lifecycle + UX + honesty**
- [ ] `test_connection` does a real round-trip; honest ✗ on failure; **never fakes green**.
- [ ] Tools never throw to the caller — `{ ok:false, reason }`; never invent data or claim an unserved URL.
- [ ] A required Installation Guide (prerequisites / steps / what the OS does / honest caveat) is authored.
- [ ] Not offered as "available" unless wired end-to-end; offline/mock paths are labeled.

**Testing**
- [ ] Unit tests over pure logic incl. failure cases (bad input throws; deny blocks; no-secret ⇒ no auth header).
- [ ] A live/integration `test_connection` check, or an honest live-verification list.
- [ ] Tests that a secret never serializes, a write is held, and an unseeable id returns `not_found`.

---

### Canonical references in-repo
- `os-ui/lib/connections/warehouse/provider.ts` — the per-connector interface (registry model).
- `os-ui/lib/connections/warehouse/providers/snowflake.ts` — engine-specifics done right.
- `os-ui/lib/connections/airflow.ts` — hand-built typed client + server bridge, never-throw.
- `os-ui/lib/connections/schema.ts` — templates + capability presets + `Connection` record.
- `os-ui/lib/infra/secrets.ts` — the write-only secret + egress-allowlist contract.
- `os-ui/lib/infra/governed.ts` — default-deny, fail-closed authorization + audit.
- `os-ui/lib/mcp/discovery-tools.ts` — governed tool registration (create/test/use_connection).
- `os-ui/lib/connections/install-guides.ts` + `components/connections/{ConnectorWizard,InstallationGuide}.tsx` — UX.

### Key external references
- RFC 9700 — *Best Current Practice for OAuth 2.0 Security* (PKCE for all clients, refresh-token rotation, least-privilege + audience-restricted scopes).
- MCP authorization guidance — OAuth 2.1 + PKCE, Resource Indicators, **no token passthrough**, run-as-user across trust boundaries.
- Stripe — *Designing robust and predictable APIs with idempotency* (idempotency keys).
- AWS — capped exponential backoff **with full jitter** for retries; respect `Retry-After` on 429/503.
- Trino connector docs — postgresql / mysql / sqlserver / mongodb read-only federated catalogs + predicate/join pushdown limits.
