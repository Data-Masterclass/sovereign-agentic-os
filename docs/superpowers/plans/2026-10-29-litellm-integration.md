<!-- SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Borek Data Ventures UG -->

# LiteLLM Integration — First Strong Version

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make LiteLLM the single control plane for everything that happens *in front of a model* — models, keys, budgets, rate limits, guardrails — administered in LiteLLM's own UI embedded in the OS with no second login, while the OS stays authoritative for identity, grants and governed retrieval, and every model call stops using the master key.

**Architecture:** Three mechanisms with no overlapping ownership. **Embed**: LiteLLM's UI served same-origin through the existing authenticated tool-proxy. **Read-mirror**: the OS polls LiteLLM's admin API and makes what an admin configured there visible and usable in the OS (models, budgets, spend, health, guardrails, external MCP servers and vector stores). **Write-reconcile**: the OS pushes only what LiteLLM cannot know — domains as teams, users as customers, agents as keys — idempotently, through the admin API so it all appears in LiteLLM's UI. Drift is reported, never silently overwritten.

**Tech Stack:** LiteLLM 1.90.0 (497 endpoints, verified against the live instance), Next.js 15 / TypeScript, the existing `core/infra/tool-proxy.ts`, OpenSearch (unchanged as the governed index), Presidio (self-hosted) for PII.

## Global Constraints

- **Keys are admin-managed. No per-user keys.** Attribution uses the request-level `user` field plus `/customer/*` objects — decided by the owner.
- **LiteLLM's UI is the editor** for gateway-owned concepts. The OS mirrors them read-only and deep-links. Do not rebuild model/key/budget editors in the OS.
- **All OS→LiteLLM writes go through the admin API** (`/team/*`, `/customer/*`, `/key/*`), never the config file and never LiteLLM's Postgres — API writes land in the DB its UI reads, so everything the OS creates is visible and editable there.
- **Idempotent by stable id:** `org_id=tenant-<id>`, `team_id=domain-<name>`, `user_id=os-<id>`, `key_alias=sys-<id>` / `svc-<domain>`.
- **Governed Knowledge and Files retrieval stays on OpenSearch** with `dlsFilter` push-down. LiteLLM's `/v1/vector_stores/*` are pass-through with no typed contract, so per-document filtering would depend on an unverifiable provider feature. External corpora only.
- **Our own MCP tools stay on our dispatcher** (identity-scoped, row-level, auditable, approvable). Third-party MCP servers may live in LiteLLM.
- **PII default is Presidio, self-hosted.** Cloud scanners (Lakera, Pangea, GraySwan, Azure, Bedrock) send content off-site and are an explicit per-tenant opt-in, labelled as such in the UI next to the residency setting.
- `fail_open` and `guardrail_timeout` are per-guardrail, admin-visible choices — never a hidden default.
- Every `/api/platform-admin/*` route re-checks the gate with `adminCtx()`. Hiding UI is never the boundary.
- Tests: `node --experimental-test-module-mocks --import ./scripts/test-setup.mjs --test <files>`; suite must stay green (4,699+ / 0 fail).

---

## Phase 1 — Embed the LiteLLM UI, no second login

### Task 1.1: Prove the UI can be framed at all

**Why first:** `core/infra/tool-proxy.ts` documents a hard failure mode — a tool whose SPA loads root-absolute assets (`/_next/*`, `/static/*`, `/api/*`) collides with os-ui's own Next.js routes and renders a blank iframe. LiteLLM's admin UI *is* a Next.js app, so it is the textbook case. Settle this before building anything on top.

**Files:** none yet — this is a spike with a written outcome.

- [ ] **Step 1: observe what the UI actually requests**

```bash
kubectl -n agentic-os run llmui --rm -i --restart=Never --image=curlimages/curl:8.11.1 -- \
  sh -c 'curl -sL http://agentic-os-litellm:4000/ui/ | grep -oE "(src|href)=\"[^\"]+\"" | sort -u | head -30'
```
Expected: a list of asset paths. Root-absolute (`/_next/...`) ⇒ collision; prefixed (`/ui/_next/...`) ⇒ framing works.

- [ ] **Step 2: if root-absolute, set LiteLLM's root path**

LiteLLM supports `SERVER_ROOT_PATH`. Add to the chart's litellm env:
```yaml
litellm:
  envVars:
    SERVER_ROOT_PATH: /tools/litellm
```
Re-run step 1 and confirm assets are now prefixed.

- [ ] **Step 3: record the outcome in the Tool entry**

If framing works → `embeddable: true`. If it cannot be made to work → `embeddable: true, consoleUrl: <litellm ingress>` (the Tier-2 pattern already in the registry: the OS renders a status panel and opens the real UI in a tab). **Either way the login requirement is solved by Task 1.2** — framing is only about where the pixels appear.

### Task 1.2: Server-side session so the admin never logs in

**Files:**
- Create: `os-ui/core/infra/tool-sso-litellm.ts`
- Modify: `os-ui/core/infra/tool-proxy.ts` (add the `litellm` registry entry)
- Test: `os-ui/core/infra/tool-sso-litellm.test.ts`

**Interfaces:**
- Consumes: the `Tool` type — `{ key, title, upstream, protocol, frame: 'strip', basePath, minRole, embeddable, sso, note?, consoleUrl? }`; `ToolSso` with `mode: 'none' | 'header' | 'session'`; `rewriteCsp()`.
- Precedent to copy: `core/infra/tool-sso-langfuse.ts` — its registry note reads *"NextAuth SSO — the proxy establishes the session server-side; no second login, password never reaches the browser."*
- Produces: `establishLiteLlmSession(): Promise<{ cookie: string } | null>`, consumed by the proxy route.

- [ ] **Step 1: write the failing test**

```ts
test('LITELLM-SSO: the proxy establishes the session server-side; no credential reaches the browser', async () => {
  const seen: { body?: string; path?: string } = {};
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.path = String(input); seen.body = String(init?.body ?? '');
    return new Response('{}', { status: 200, headers: { 'set-cookie': 'litellm_session=abc; Path=/' } });
  }) as typeof fetch;
  try {
    const s = await establishLiteLlmSession();
    assert.ok(s?.cookie.includes('litellm_session='), 'returns the upstream session cookie');
    assert.ok(!/password|master/i.test(s!.cookie), 'the cookie is not the credential itself');
  } finally { globalThis.fetch = orig; }
});
```

- [ ] **Step 2: run it, confirm it fails** — `… --test core/infra/tool-sso-litellm.test.ts` → "establishLiteLlmSession is not a function".
- [ ] **Step 3: implement** `establishLiteLlmSession()` — POST the configured admin credential to LiteLLM's UI login endpoint server-side, return only the resulting cookie. Never return or log the credential.
- [ ] **Step 4: add the registry entry**

```ts
{
  key: 'litellm', title: 'LLM Gateway', upstream: config.litellmUrl, protocol: 'http',
  frame: 'strip', basePath: '/tools/litellm', minRole: 'admin', embeddable: true,
  sso: { mode: 'session' },
  note: 'LiteLLM admin UI. The proxy signs the admin in server-side — no second login, the credential never reaches the browser. Admin-only: this surface can mint keys and change budgets.',
}
```

- [ ] **Step 5: tests pass; then add the gate test**

```ts
test('LITELLM-GATE: the gateway tool is admin-only', () => {
  const t = resolveTool('litellm')!;
  assert.equal(t.minRole, 'admin');
  for (const r of ['creator', 'builder', 'domain_admin'] as const) assert.equal(roleAllowed(r, t.minRole), false);
  assert.equal(roleAllowed('admin', t.minRole), true);
});
```

- [ ] **Step 6: commit**

```bash
git add os-ui/core/infra/tool-sso-litellm.ts os-ui/core/infra/tool-sso-litellm.test.ts os-ui/core/infra/tool-proxy.ts
git commit -m "gateway: embed the LiteLLM admin UI through the tool-proxy with server-side SSO"
```

### Task 1.3: Point the admin menu at it

**Files:** modify `os-ui/tabs/admin/lib/sections.ts` (the single source of truth both the strip and the tile grid render).

- [ ] **Step 1:** change the `gateway` section's `href` from `/llm-gateway` to `/tools/litellm`, keep `group: 'Models & cost'`, raise `minRole` to `'admin'`, and reword `sub` to "Models, keys, budgets, guardrails — in LiteLLM".
- [ ] **Step 2:** `node --experimental-test-module-mocks --import ./scripts/test-setup.mjs --test core/kernel/tabs.test.ts core/security-route-guards.test.ts` → 0 fail.
- [ ] **Step 3:** delete the old read-only page `os-ui/app/(govern)/llm-gateway/page.tsx` **only after** Phase 2 lands its replacement panel; until then leave it reachable.
- [ ] **Step 4: commit.**

**Phase 1 acceptance:** an admin opens Admin → LLM Gateway, lands in LiteLLM's UI inside the OS chrome, is already authenticated, and can create a model, a team, a budget and a guardrail. A builder gets 403. No credential appears in any browser payload.

---

## Phase 2 — Read-mirror ✅ DONE (2026-10-29)

**Landed as specified**, with the locked `GatewayMirror` interface unchanged. Deviations worth recording:

* `buildMirror(sources, known, now)` was split out as a **pure** function and `readMirror()` kept as a thin IO shell. The rules (drift, health, provider inference, attribution) are therefore unit-tested with no network and no clock — 28 new tests, all green.
* `buildMirror` takes `now` as an argument rather than calling `Date.now()`, so `fetchedAt` is assertable.
* Degradation keys off the **model** read specifically, not "all reads failed". A mirror with no models is not a gateway with no models; it is a gateway we could not reach. On a degraded read the last good mirror is returned with its ORIGINAL `fetchedAt` so the panel can date what it shows.
* `/budget/list` and `/health/services` are wired in the client but not yet surfaced: team rows already carry the budget the panels need, so reading budgets separately would have shown the same number twice.
* Spend attribution relies on LiteLLM request tags (`domain:`, `agent:`, `tab:`). Nothing tags requests yet, so those dimensions are honestly empty and the panel says "no tagged requests yet" instead of implying zero. **Tagging is a Phase 3 prerequisite** — without it the per-domain envelope cannot be real.
* Four panels share ONE endpoint and one component (`GatewayPanel`, variants `overview | budgets | spend | health`), so four surfaces cost one round trip to LiteLLM.
* The agent model picker was **refactored onto** the shared client rather than rebuilt: it already read `/model/info` live, so the acceptance criterion held; the duplicate fetch/timeout/Bearer logic is gone.
* Removed with the old page: `/api/gateway/usage`, `tabs/monitoring/lib/gateway-usage.ts` and its test — the page was their only caller. `/api/gateway` stays; the Components page uses it.

**Not done, deliberately:** no writes to LiteLLM. Phase 2 is read-only.

### Original scope



**Files:** `os-ui/core/infra/litellm-admin.ts` (typed read client), `os-ui/tabs/admin/lib/gateway-mirror.ts` (cache + drift), `os-ui/app/api/platform-admin/gateway/route.ts`, panels on `/platform`, `/platform/domains`, `/platform/billing`, `/platform/components`.

**Interface (locked):**
```ts
export type GatewayMirror = {
  models: { id: string; group: string; provider: string; healthy: boolean }[];
  teams: { teamId: string; alias: string; maxBudget: number | null; spend: number; models: string[] }[];
  keys: { alias: string; owner: 'agent' | 'service' | 'unknown'; blocked: boolean; spend: number }[];
  guardrails: { name: string; provider: string; failOpen: boolean }[];
  spend: { byDomain: Record<string, number>; byUser: Record<string, number>; byAgent: Record<string, number>; byTab: Record<string, number> };
  unmanaged: { kind: 'team' | 'key'; id: string }[];   // exists in LiteLLM, no OS counterpart
  fetchedAt: number; degraded: boolean;                 // degraded = gateway unreachable, serving cache
};
export async function readMirror(): Promise<GatewayMirror>;
```
Sources: `/model/info`, `/model_group/info`, `/team/list`, `/budget/list`, `/key/list`, `/guardrails/list`, `/spend/logs/v2`, `/global/spend/report`, `/tag/daily/activity`, `/health/services`, `/health/latest`.

**Acceptance:** a model added in LiteLLM's UI appears in the agent model picker with no redeploy; a domain budget set there shows on `/platform/domains`; the billing envelope uses real spend; a blocked key shows the owning agent as blocked in the Agents tab; anything with no OS counterpart is listed as **unmanaged**, never invented.

---

## Phase 3 — Write-reconcile, and the master key leaves the runtime

**Files:** `os-ui/tabs/admin/lib/litellm-reconcile.ts`, `os-ui/core/runtime/runtime.ts` + `complete.ts` (key selection + attribution), `os-ui/app/api/platform-admin/gateway/reconcile/route.ts`.

**Interface (locked):**
```ts
export type ReconcilePlan = { creates: Op[]; updates: Op[]; drift: Op[] };  // drift is REPORTED, never applied
export async function planReconcile(): Promise<ReconcilePlan>;
export async function applyReconcile(plan: ReconcilePlan): Promise<{ applied: number; failed: Op[] }>;
export function callerCredential(ctx: { userId: string; domain: string; systemId?: string }):
  { apiKey: string; user: string; tags: string[] };   // domain service key or the agent's own key — NEVER the master key
```

**Acceptance:** Phase-0 gate test `MODEL-KEY` flips from `todo` to a hard assertion and passes; `/spend/logs/v2?end_user=os-<id>` returns that person's spend; a domain over its `max_budget` gets a typed `budget_exceeded`, surfaced in the UI rather than a raw 400; a LiteLLM rebuilt from empty is fully repopulated by one reconcile run.

---

## Phase 4 — Guardrails, Presidio first

Deploy Presidio in-cluster; register it via `/guardrails/register` with `team_id` per domain; attach to teams and agent keys. Surface `/guardrails/usage/overview` per agent. Call `/guardrails/apply_guardrail` at **ingest** too — file upload before MinIO, knowledge before indexing — so one policy covers both arrival and egress. Route LiteLLM's guardrail submission workflow (`/guardrails/submissions/*`) into the Governance inbox so a domain proposes and an admin approves.

## Phase 5 — External MCP servers and vector stores as grantable resources

Mirror `/public/mcp_hub`, `/mcp-rest/tools/list`, `/vector_store/list` into Connections; make them grantable to an agent; write the grant into the key's `object_permission.{mcp_servers, mcp_tool_permissions, vector_stores}` as defence in depth. Retires most of the per-vendor connector burden.

---

## Risks

| Risk | Mitigation |
|---|---|
| LiteLLM's Next.js UI cannot be framed (root-absolute assets) | Task 1.1 settles it first; `SERVER_ROOT_PATH`, else the Tier-2 open-in-tab pattern already in the registry — SSO works either way |
| The embed grants full gateway admin to anyone reaching the route | `minRole: 'admin'` on the Tool **and** the proxy route re-checks per request, including sub-resources and websockets; add an explicit test |
| `litellmUI.username/password` is a dev default in chart values | move to a Secret before this ships |
| Gateway outage blocks OS paths | mirror serves cache with `degraded: true`; reconcile is async; model calls already fail honestly |
| Two engines drift | one direction per object, drift reported not applied |
