# Builder Vertical Rework — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ONE builder workflow dependable end to end — create an agent, attach governed resources, run it from UI *and* MCP, hit an approval, resume exactly once, survive a pod restart, and inspect one correlated Langfuse trace — and only then remove the alternate execution paths and adjacent products.

**Architecture:** Strangle, don't rewrite. Keep the shared MCP dispatcher (`handleRpc`), the resource/grant models and the OPA/DLS authority. Introduce (a) one typed execution context that every resource operation receives, (b) Postgres as the transactional system of record for grants/approvals/runs (OpenSearch stays for search + derived indexes), (c) one run-start application service used by UI, MCP and schedules, and (d) one production graph runtime — real LangGraph in `agent-runtime` — behind the existing `AGENT_RUNTIME_URL` API. Every phase is gated by the regression suite in Phase 0, which pins the five reproduced defects *before* any refactor.

**Tech Stack:** Next.js 15 / TypeScript (os-ui, `node --test`), Python 3 `langgraph` (OSS lib) in `images/base/agent-runtime`, Postgres 17 (CNPG), OpenSearch, LiteLLM, Langfuse v3, OPA, Helm chart `charts/sovereign-agentic-os`.

## Global Constraints

- Source of truth: `github.com/Data-Masterclass/sovereign-agentic-os`, branch `main`, baseline revision `33556df3`. Every phase lands as reviewed PRs; production deploys only via a `scripts/deploy-<ver>.sh` with `deploy/pre-upgrade-backup.sh` first.
- **Feature freeze** on adjacent tabs (Strategy, Big Bets, Operating Model, Marketplace, Science, Software factory, Console) until Phase 4 acceptance passes. Bug fixes only.
- Kernel (agreed 2026-10-28): os-ui · OpenSearch · Postgres · Valkey · MinIO · LiteLLM · OPA · agent-runtime (**real LangGraph**) · Langfuse + ClickHouse · egress-proxy/web-fetch. Dagster + Docling stay on for now. Do **not** delete ClickHouse/Valkey/MinIO "because they look extra".
- Tabs in production: `home, agents, dashboards, software, data, metrics, files, knowledge, connections, monitoring, governance, admin, workflows` (13). Sidebar group "Manage" = Business Workflows · Connections · Governance · Monitoring · Components · LLM Gateway · Admin.
- Connectors kept: `onedrive outlook teams gdrive kajabi-api notion-mcp entra gmail` (+ `generic-mcp` as the "any MCP server" adapter, pending Alex's confirmation). All other connector keys are deleted in Phase 5.
- No new persistence through `osMirror.writeThrough` for grants, approvals or run state once Phase 2 lands; until then, failed mirror writes must be *reported*, never acknowledged.
- The model caller must never use `config.litellmMasterKey` on a user/agent run path after Phase 3; the master key is for Build/provisioning only.
- Test command (os-ui): `node --experimental-test-module-mocks --import ./scripts/test-setup.mjs --test <files>`; whole suite `npm test` (591 files, must stay green).
- Commits end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## Scope check — this is five sub-projects

The review spans five subsystems that must each produce working software on their own. This document fully specifies **Phase 0 (the regression gate)** because every later phase is measured against it, and gives each later phase a locked file map, interfaces and acceptance criteria. **Phases 1–5 each get their own bite-sized plan when started** (run `superpowers:brainstorming` → `writing-plans` per phase); do not start a phase without one.

| Phase | Deliverable | Gate to pass |
|---|---|---|
| 0 | Five failing-then-passing regression tests + a CI job that runs them | Tests exist, fail on `33556df3`, are wired into `.github/workflows/ci.yml` |
| 1 | `ExecutionContext` enforced at the agent dispatch boundary | T1 + T2 green; ungranted resource denied even when the human may see it |
| 2 | Postgres control-plane store (grants, approvals, runs, checkpoints) + run-start service | T4 + T5 green; UI and MCP start runs through one function |
| 3 | Real LangGraph runtime in `agent-runtime`; scoped LiteLLM keys on the run path; one trace root | T3 green; `when:false` handoff never visits; interrupts = approvals |
| 4 | Acceptance scenario automated against an installed stack | One dataset + one file folder + one knowledge collection + one MCP server + one API connection, UI *and* MCP, approve → resume once, restart-safe, one trace |
| 5 | Removal: custom walkers, mock fallbacks, duplicate policy/trace code, non-kept connectors, optional products behind Helm flags | `npm test` green; Helm `values.lean.yaml` renders kernel-only |

---

## Phase 0 — Regression gate (fully specified)

Each task adds **one** test that reproduces one reviewed defect, verifies it **fails** on the current code, and is committed failing-but-skipped (`{ todo: true }` → flipped to a hard assertion by the phase that fixes it). Node's test runner reports `todo` tests without failing CI, so the gate can land now.

### Task 0.1: Agent resource narrowing is not enforced (review finding 1)

**Files:**
- Test: `os-ui/lib/agents/build/os-tools.test.ts` (append)
- Reads: `os-ui/lib/agents/build/os-tools.ts:647-735` (`grantedToolExecutor`), `os-ui/lib/agents/system-schema.ts:70` (`ArtifactGrant`)

**Interfaces:**
- Consumes: `grantedToolExecutor(user, sys, systemId, deps: OsToolDeps)`; `OsToolDeps = { enqueue, handleRpc, trace }`; `parseSystem({... grants: { tools, data: [{ id, capability, layer }] } })`.
- Produces: the test names `RESOURCE-NARROWING` used by Phase 1's acceptance.

- [ ] **Step 1: Write the failing test**

```ts
// --- Phase-0 regression gate: agent resource narrowing (review finding 1) ------

function sysWithDataGrant(datasetId: string, layer: 'bronze' | 'silver' | 'gold'): System {
  return parseSystem({
    version: '1',
    system: { name: 'T', domain: 'sales', visibility: 'Personal' },
    runtime: 'langgraph',
    entrypoint: 'a',
    grants: { tools: ['get_dataset'], data: [{ id: datasetId, capability: 'Read', layer }] },
    agents: [{ id: 'a', role: 'agent', agent_md: '', memory_md: '' }],
  });
}

function spyDeps(): OsToolDeps & { calls: { name: string; args: unknown }[] } {
  const calls: { name: string; args: unknown }[] = [];
  return {
    calls,
    enqueue: (() => ({ id: 'q1' })) as unknown as OsToolDeps['enqueue'],
    trace: (async () => {}) as unknown as OsToolDeps['trace'],
    handleRpc: (async (_u, req) => {
      const p = (req as { params: { name: string; arguments: unknown } }).params;
      calls.push({ name: p.name, args: p.arguments });
      return { jsonrpc: '2.0', id: 1, result: { content: [{ text: 'ok' }] } };
    }) as unknown as OsToolDeps['handleRpc'],
  };
}

test('RESOURCE-NARROWING: get_dataset on an UNGRANTED dataset is refused before dispatch', { todo: 'fixed in Phase 1' }, async () => {
  const deps = spyDeps();
  const exec = grantedToolExecutor(CREATOR, sysWithDataGrant('ds-A', 'gold'), 'sys-1', deps);
  const res = await exec('get_dataset', { datasetId: 'ds-B' });
  assert.equal(deps.calls.length, 0, 'ds-B is not in grants.data — must never reach handleRpc');
  assert.equal(res.isError, true);
  assert.match(res.text, /not granted|forbidden/i);
});

test('RESOURCE-NARROWING: an explicit layer below the granted layer is clamped, not forwarded', { todo: 'fixed in Phase 1' }, async () => {
  const deps = spyDeps();
  const exec = grantedToolExecutor(CREATOR, sysWithDataGrant('ds-A', 'gold'), 'sys-1', deps);
  await exec('get_dataset', { datasetId: 'ds-A', layer: 'bronze' });
  assert.equal(deps.calls.length, 1);
  assert.equal((deps.calls[0].args as { layer?: string }).layer, 'gold', 'the grant says gold; bronze must not pass through');
});
```

- [ ] **Step 2: Run the two tests with `todo` removed to prove they fail today**

Run: `cd os-ui && node --experimental-test-module-mocks --import ./scripts/test-setup.mjs --test lib/agents/build/os-tools.test.ts 2>&1 | grep -E "RESOURCE-NARROWING|^ℹ (pass|fail)"`
Expected (with `{ todo }` temporarily deleted): both `not ok` — first with `calls.length` = 1, second with `layer` = `bronze`.

- [ ] **Step 3: Restore `{ todo: 'fixed in Phase 1' }` and run again**

Expected: `ℹ todo 2`, `ℹ fail 0`.

- [ ] **Step 4: Commit**

```bash
git add os-ui/lib/agents/build/os-tools.test.ts
git commit -m "test(gate): pin agent resource-narrowing gap (review finding 1)"
```

### Task 0.2: Run-path model calls use the LiteLLM master key (finding 4)

**Files:**
- Test: `os-ui/lib/assistant/runtime.test.ts` (create if absent; the folder already has `lib/assistant/*.test.ts` siblings)
- Reads: `os-ui/lib/assistant/runtime.ts:156-180` (`liteLlmCaller`)

**Interfaces:**
- Consumes: `liteLlmCaller(): LlmCall`; `config.litellmMasterKey`, `config.litellmUrl` from `@/lib/core/config`.
- Produces: Phase 3 changes the signature to `liteLlmCaller(creds: { apiKey: string; attribution: { userId: string; systemId: string; runId: string } })`; this test is rewritten then.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '@/lib/core/config';
import { liteLlmCaller } from './runtime.ts';

test('MODEL-KEY: a run-path completion must NOT carry the LiteLLM master key', { todo: 'fixed in Phase 3' }, async () => {
  const seen: { auth?: string } = {};
  const orig = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    seen.auth = String((init?.headers as Record<string, string>)?.authorization ?? '');
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hi' } }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    await liteLlmCaller()({ model: 'sovereign-fast', messages: [{ role: 'user', content: 'ping' }] });
  } finally {
    globalThis.fetch = orig;
  }
  assert.ok(seen.auth, 'the caller must send an authorization header');
  assert.notEqual(seen.auth, `Bearer ${config.litellmMasterKey}`, 'run path used the MASTER key — per-agent scoped key limits are bypassed');
});
```

- [ ] **Step 2: Run without `todo` to prove it fails**

Run: `cd os-ui && node --experimental-test-module-mocks --import ./scripts/test-setup.mjs --test lib/assistant/runtime.test.ts`
Expected: `not ok … run path used the MASTER key`.

- [ ] **Step 3: Restore `todo`, rerun → `ℹ todo 1`, `fail 0`.**

- [ ] **Step 4: Commit**

```bash
git add os-ui/lib/assistant/runtime.test.ts
git commit -m "test(gate): pin master-key use on the run path (review finding 4)"
```

### Task 0.3: A failed mirror PUT is acknowledged as saved (finding 2)

**Files:**
- Test: `os-ui/lib/infra/os-mirror.test.ts` (append)
- Reads: `os-ui/lib/infra/os-mirror.ts:231-262` (`sendThrough`, `writeThrough`)

**Interfaces:**
- Consumes: `osMirror(index)` → `{ probe, writeThrough(id, doc), healthy(), __reset() }`; base URL `http://opensearch:9200`.
- Produces: Phase 2 adds `writeThrough(): Promise<{ ok: boolean; status?: number }>` and `lastWriteError()`; this test is tightened then.

- [ ] **Step 1: Write the failing test**

```ts
test('MIRROR-DURABILITY: a 503 on PUT must surface — not leave healthy=true with the write lost', { todo: 'fixed in Phase 2' }, async () => {
  const m = osMirror('os-gate-test');
  m.__reset();
  const orig = globalThis.fetch;
  const log: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); const method = init?.method ?? 'GET';
    log.push(`${method} ${url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]}`);
    if (url.includes('/_count')) return new Response(JSON.stringify({ count: 0 }), { status: 200 });
    if (method === 'PUT' && url.includes('/_doc/')) return new Response('{"error":"unavailable"}', { status: 503 });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    assert.equal(await m.probe(), true, 'probe succeeds → mirror believed healthy');
    m.writeThrough('doc-1', { hello: 'world' });
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    globalThis.fetch = orig;
  }
  assert.ok(log.some((l) => l.startsWith('PUT /os-gate-test/_doc/doc-1')), 'the PUT was attempted');
  // The defect: after a failed PUT the mirror still reports healthy and nothing is queued/reported.
  assert.equal(m.healthy(), false, 'a failed write must flip health (or be queued + reported) — never silently succeed');
});
```

- [ ] **Step 2: Run without `todo` → `not ok` (`healthy()` is `true`).**
- [ ] **Step 3: Restore `todo`, rerun → `todo 1`, `fail 0`.**
- [ ] **Step 4: Commit** — `git commit -m "test(gate): pin silent mirror write loss (review finding 2)"`

### Task 0.4: `when: false` handoff still visits its target (finding 3)

**Files:**
- Test: `os-ui/lib/agents/build/agentic-graph.test.ts` (append)
- Reads: `os-ui/lib/agents/build/agentic-graph.ts:271-296` (`nodeOrder`), `os-ui/lib/agents/langgraph-compile.ts:37` (`IRCommand = { from, to, when }`)

**Interfaces:**
- Consumes: `compile(parseSystem(yaml)) → IR`; `nodeOrder(ir, disabled?) → string[]`.
- Produces: Phase 3 replaces `nodeOrder` with the agent-runtime LangGraph path; this test moves to `images/base/agent-runtime/tests/test_handoff_guard.py` with the same scenario.

- [ ] **Step 1: Write the failing test**

```ts
test('HANDOFF-GUARD: a handoff with when:"false" must not visit its target', { todo: 'fixed in Phase 3 (real LangGraph)' }, () => {
  const ir = compile(parseSystem({
    version: '1',
    system: { name: 'T', domain: 'sales', visibility: 'Personal' },
    runtime: 'langgraph',
    entrypoint: 'a',
    grants: { tools: [] },
    agents: [
      { id: 'a', role: 'agent', agent_md: '', memory_md: '' },
      { id: 'b', role: 'agent', agent_md: '', memory_md: '' },
    ],
    edges: [{ from: 'a', to: 'b', type: 'handoff', when: 'false' }],
  }));
  assert.deepEqual(ir.commands, [{ from: 'a', to: 'b', when: 'false' }], 'compiler keeps the guard');
  assert.deepEqual(nodeOrder(ir), ['a'], 'walker ignores the guard today and visits b');
});
```

(If `edges[].type`/`when` field names differ in `system-schema.ts`, use the names `compile()` reads at `langgraph-compile.ts:93-104` — the assertion on `ir.commands` is the contract.)

- [ ] **Step 2: Run without `todo` → `not ok` (`nodeOrder` = `['a','b']`).**
- [ ] **Step 3: Restore `todo`, rerun → `todo 1`, `fail 0`.**
- [ ] **Step 4: Commit** — `git commit -m "test(gate): pin ignored handoff guard (review finding 3)"`

### Task 0.5: A held write loses its arguments (finding 5)

**Files:**
- Test: `os-ui/lib/agents/build/os-tools.test.ts` (append)
- Reads: `os-ui/lib/agents/build/os-tools.ts:699-717` (enqueue call), `os-ui/lib/governance/approvals.ts:74` (`Approval`)

**Interfaces:**
- Consumes: `sysWithPreset(tools, 'read-propose')` fixture (already in the file); `holdDecision`.
- Produces: Phase 2 introduces `PendingAction = { op, target, args, requestedBy, systemId, runId, checkpointId, policy, idempotencyKey }` carried on the approval; the assertion below becomes `assert.deepEqual(item.action.args, args)`.

- [ ] **Step 1: Write the failing test**

```ts
test('HELD-ACTION: a held request_promotion must carry the exact arguments it needs to execute later', { todo: 'fixed in Phase 2' }, async () => {
  const queued: Record<string, unknown>[] = [];
  const deps: OsToolDeps = {
    enqueue: ((item: Record<string, unknown>) => { queued.push(item); return { id: 'q1' }; }) as unknown as OsToolDeps['enqueue'],
    trace: (async () => {}) as unknown as OsToolDeps['trace'],
    handleRpc: (async () => { throw new Error('must not dispatch a held write'); }) as unknown as OsToolDeps['handleRpc'],
  };
  const sys = sysWithPreset(['request_promotion'], 'read-propose');
  const args = { kind: 'dataset', id: 'ds-A', target: 'Domain', reason: 'gate test' };
  const res = await grantedToolExecutor(CREATOR, sys, 'sys-1', deps)('request_promotion', args);
  assert.equal(res.isError, true);
  assert.match(res.text, /held/);
  assert.equal(queued.length, 1, 'exactly one approval queued');
  assert.deepEqual((queued[0] as { action?: { args?: unknown } }).action?.args, args,
    'the queued approval has no arguments — approve → execute → resume is impossible');
});
```

- [ ] **Step 2: Run without `todo` → `not ok` (`action` is `undefined`).**
- [ ] **Step 3: Restore `todo`, rerun → `todo 1`, `fail 0`.**
- [ ] **Step 4: Commit** — `git commit -m "test(gate): pin argument-less held approvals (review finding 5)"`

### Task 0.6: Wire the gate into CI

**Files:**
- Modify: `.github/workflows/ci.yml` (job `test-ui` already runs `npm test`; add a named step)
- Create: `os-ui/scripts/gate.sh`

- [ ] **Step 1: Create the gate script**

```bash
#!/usr/bin/env bash
# Phase-0 regression gate: the five reviewed defects. `todo` while open; a phase
# that fixes one flips its test to a hard assertion. Fails CI only on real failures.
set -euo pipefail
cd "$(dirname "$0")/.."
node --experimental-test-module-mocks --import ./scripts/test-setup.mjs --test \
  lib/agents/build/os-tools.test.ts \
  lib/assistant/runtime.test.ts \
  lib/infra/os-mirror.test.ts \
  lib/agents/build/agentic-graph.test.ts
```

- [ ] **Step 2: Add the CI step** after the existing `npm test` step in `test-ui`:

```yaml
      - name: Builder-vertical regression gate
        working-directory: os-ui
        run: bash scripts/gate.sh
```

- [ ] **Step 3: Run locally** — `bash os-ui/scripts/gate.sh` → `ℹ todo 6`, `ℹ fail 0`.
- [ ] **Step 4: Commit + open PR "Phase 0: builder-vertical regression gate".**

---

## Phase 1 — Execution context at the dispatch boundary (own plan when started)

**Files:** create `os-ui/lib/agents/execution-context.ts`; modify `os-ui/lib/agents/build/os-tools.ts:647-735`, `os-ui/lib/experimental/mcp/data-query-tools.ts:25` (SQL path), `os-ui/lib/mcp/server.ts` (`handleRpc` accepts an optional `ctx`).

**Interface (locked):**
```ts
export type ExecutionContext = {
  actor: CurrentUser;                        // the human — OPA/DLS authority
  agent: { systemId: string; versionId: string } | null;
  runId: string | null;
  allowed: { data: Map<string, DataLayer>; knowledge: Set<string>; connections: Set<string>; files: string[] /* folder paths */ };
  allowedOps: Set<string>;                   // resolved MCP tool names
};
export function resolveTarget(tool: string, args: unknown): { kind: 'data'|'knowledge'|'connection'|'file'|'none'; id?: string; layer?: DataLayer };
export function authorizeAgentCall(ctx: ExecutionContext, tool: string, args: unknown): { ok: true; args: unknown } | { ok: false; code: 'forbidden'; reason: string };
```
**Acceptance:** Task 0.1 tests flipped to hard assertions and green; a human who can see A and B, with an agent granted only A, gets `forbidden` for B via UI *and* MCP run; SQL tool rejects a table outside `allowed.data`.

## Phase 2 — Transactional control plane + one run-start service

**Files:** create `os-ui/lib/control-plane/{db.ts,grants.ts,approvals.ts,runs.ts,outbox.ts}` (Postgres via `pg`, migrations in `os-ui/db/migrations/0001_control_plane.sql`), `os-ui/lib/agents/run-service.ts`; modify `app/api/agents/systems/[id]/run/route.ts:240`, `lib/mcp/agent-write-tools.ts:131` to call `startRun()`; `lib/infra/os-mirror.ts` returns write results and marks unhealthy on failure.

**Interfaces (locked):**
```ts
export type PendingAction = { op: string; target: ReturnType<typeof resolveTarget>; args: unknown; requestedBy: string; systemId: string; runId: string; checkpointId: string; policy: { approverRole: ApproverRole; scope: ApprovalScope }; idempotencyKey: string };
export async function startRun(input: { actor: CurrentUser; systemId: string; entry: 'ui'|'mcp'|'schedule'; messages: Msg[] }): Promise<{ runId: string; status: 'running'|'held' }>;
export async function approveAndResume(approvalId: string, approver: CurrentUser): Promise<{ executed: true; runId: string }>;
```
**Acceptance:** Tasks 0.3 + 0.5 green; a run started from UI and from MCP produces byte-identical `runs` rows except `entry`; kill the os-ui pod mid-run → run resumes once from the checkpoint, no duplicate effect (idempotency key).

## Phase 3 — Real LangGraph runtime, scoped model keys, one trace root

**Files:** `images/base/agent-runtime/{app.py,interpreter.py,requirements.txt}` (add `langgraph`, `langgraph-checkpoint-postgres`), new `graph_builder.py` (IR → `StateGraph`: `add_edge(START, entrypoint)`, `add_conditional_edges` for supervisors, `Command(goto=…)` guarded by `when`, `interrupt()` for `requires_approval`); os-ui `lib/agents/build/live.ts` + `lib/assistant/runtime.ts` (`liteLlmCaller(creds)` with the per-system virtual key from Build; `x-litellm-metadata` user/agent/run); `lib/infra/agent-governed.ts:304` (one `traceId` per run, spans per node/tool/generation).

**Acceptance:** Tasks 0.2 + 0.4 green (0.4 re-homed to `agent-runtime/tests/test_handoff_guard.py`); Build's `langgraph.verify` runs the same `/run` path Run uses; Langfuse shows one trace per run with node → generation → tool observations; the key on the run path is the system's scoped key (`/key/info` alias `sys-<id>`).

## Phase 4 — Acceptance scenario on an installed stack

**Files:** `scripts/e2e/builder-vertical.sh` (kubectl + curl against `agentic.datamasterclass.com` or a kind cluster), `.github/workflows/e2e.yml` (manual dispatch + nightly).

**Scenario (must pass twice: entry=ui, entry=mcp):** builder creates agent → grants one dataset (gold), one Files folder, one knowledge collection, one `generic-mcp` server, one `kajabi-api` connection → runs → grounded answer cites all five → agent calls `request_promotion` → approval appears with `PendingAction.args` → domain_admin approves → run resumes exactly once → `kubectl delete pod -l app=os-ui` during a second run → it resumes → Langfuse has one trace per run → ungranted dataset B visible to the human is denied → revoking the grant mid-run denies the next call → scoped-key budget exhaustion returns a typed `budget_exceeded`.

## Phase 5 — Removal and lean packaging

- Delete `lib/agents/build/agentic-graph.ts` walker + `run-graph.ts` mock walker after parity tests pass; delete production mock fallbacks in `lib/experimental/connections/store.ts:1803`.
- Connector purge to the keep-list; delete `warehouse/` registry.
- Helm: `values.lean.yaml` = kernel only; move Trino/Iceberg/dbt/Dagster/Cube/Superset/OpenMetadata/Forgejo/ArgoCD behind `enabled: false` defaults (already off in prod as of rev 392).
- Docs regenerated from tested contracts; stale integration instructions removed.

---

## Self-review

- **Spec coverage:** findings 1–5 → Tasks 0.1–0.5 + Phases 1–3; finding 6 (UI/MCP lifecycle drift) → Phase 2 `startRun`; finding 7 (trace hierarchy) → Phase 3; finding 8 (generic connectors) → Phase 4 scenario uses `generic-mcp` + one API connection, Phase 5 purge. Review's "freeze adjacent work" → Global Constraints.
- **Placeholders:** Phases 1–5 are deliberately interface-level and each says "own plan when started" — that is the scope split the skill requires, not a TODO.
- **Type consistency:** `ExecutionContext`/`resolveTarget` (Phase 1) are reused by `PendingAction.target` (Phase 2); `liteLlmCaller(creds)` (Phase 3) matches Task 0.2's note.

---

## Phase R — Repository restructure: `core/` · `tabs/<tab>/` · `components/<name>/` (Alex, 2026-10-28)

> Runs **immediately after Phase 0** (the gate must exist before files move) and **before Phases 1–3**, so the vertical work lands in the new layout. Pure moves + deletions: no behaviour change, `npm test` green at every commit, one deploy at the end.

### Target tree

```
sovereign-agentic-os/
├── core/                         # the kernel — everything every tab needs; NO tab-specific code
│   ├── ui/                       # os-ui app shell: layout, sidebar, auth pages, session, theme (from os-ui/app/layout.tsx, os-ui/components/*)
│   ├── auth/                     # users directory (OpenSearch os-users), roles, CurrentUser, middleware   (from os-ui/lib/core/{auth,session,…}, platform-admin/users.ts)
│   ├── policy/                   # OPA client, DLS/RLS, approvals kernel, PendingAction, effects          (from os-ui/lib/governance/*, lib/infra/agent-governed.ts)
│   ├── control-plane/            # Postgres store (Phase 2), osMirror (search/derived), outbox             (from os-ui/lib/infra/os-mirror*.ts; new files in Phase 2)
│   ├── mcp/                      # the ONE dispatcher handleRpc, tool registry, token minting              (from os-ui/lib/mcp/*)
│   ├── runtime/                  # run-start service, LangGraph client, LiteLLM caller, Langfuse tracing  (from os-ui/lib/assistant/*, lib/agents/build/live.ts, agent-governed trace)
│   ├── folders/ prefs/ notifications/ oauth/ app-sdk/                                                     (moved 1:1)
│   ├── deploy/                   # Helm templates WE wrote for kernel services: os-ui, opa, ingress, network, priority classes, backup CronJobs, init Jobs
│   └── tabs.ts manifest.ts       # tab registry + the TabManifest contract (below)
├── tabs/                         # exactly the 13 live tabs; one folder each, same inner layout
│   ├── home/ agents/ dashboards/ software/ data/ metrics/ files/ knowledge/ connections/ monitoring/ governance/ admin/ workflows/
│   │   ├── manifest.ts           # feature key, nav entry, routes, MCP tool bundle, OPA policy files, services required
│   │   ├── pages/                # React pages + tab-local components      (from os-ui/app/(group)/<route>/*)
│   │   ├── api/                  # route handlers                            (from os-ui/app/api/<area>/*)
│   │   ├── lib/                  # domain logic                              (from os-ui/lib/experimental/<area>, lib/agents, lib/monitoring, lib/platform-admin, lib/home)
│   │   ├── mcp/                  # the tab's MCP tool bundle                 (from os-ui/lib/experimental/mcp/*-tools.ts, lib/mcp/*-tools.ts)
│   │   ├── policy/               # the tab's OPA .rego + tests
│   │   ├── deploy/               # Helm templates WE wrote for this tab's services (e.g. tabs/data/deploy = lakehouse init, dbt Job, data-runner)
│   │   ├── guide.md              # the in-app guide (from os-ui/lib/tabs/guides/<tab>.guide.md)
│   │   └── *.test.ts             # tests live next to the code they test
├── components/                   # UPSTREAM OPEN-SOURCE ONLY — one subfolder per component title, nothing we authored except a pin
│   ├── opensearch/ postgres/ valkey/ minio/ litellm/ opa/ langfuse/ clickhouse/ trino/ polaris/ dbt/ dagster/ docling/ egress-proxy/ web-fetch/ agent-runtime(langgraph)/
│   │   ├── UPSTREAM.md           # project, version/digest, licence, upstream URL
│   │   ├── Chart.lock / values.upstream.yaml  OR  Dockerfile that is `FROM <upstream>@sha256:…` with no added code
│   │   └── LICENSE               # upstream licence text
├── charts/sovereign-agentic-os/  # the umbrella chart Helm needs (one tree): templates/{core,tabs/<tab>,components/<name>} are the SAME files as
│   │                             # core/deploy, tabs/*/deploy and components/*/ — assembled by scripts/assemble-chart.sh (copy, verified by CI diff)
├── os-ui/                        # Next.js host only: app/ holds THIN route files re-exporting from tabs/*/pages and tabs/*/api; package.json, next.config, tsconfig paths @core/* @tabs/*
├── scripts/ deploy/ docs/ licenses/
└── (deleted) ee/ experimental/ compose/ seed/ cli/ images/extensions/* — see "Removed" below
```

**Rules (enforced by `scripts/check-structure.mjs`, run in CI):**
1. `components/<name>/` may contain only upstream material (`Dockerfile` whose only instruction is `FROM …@sha256`, upstream chart pin, `UPSTREAM.md`, `LICENSE`). Any `COPY`, `RUN`, script or template we wrote → fails CI; it belongs in `core/deploy` or `tabs/<tab>/deploy`.
2. `tabs/<a>/**` may import `@core/*` and its own folder only — never `@tabs/<b>/*`. Cross-tab needs go through `core/` (a shared type, an MCP tool call, or an event).
3. `core/**` never imports `@tabs/*`.
4. `os-ui/app/**` files are ≤ 5 lines: `export { default } from '@tabs/data/pages/datasets'` / `export { GET, POST } from '@tabs/data/api/datasets'`.
5. Every `.ts/.tsx/.py/.rego` under `core/` and `tabs/` starts with the header block below; the checker fails on a missing or empty section.

**Header block (every remaining source file):**
```ts
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * TAB:        data                      (or: core/<area>)
 * FEATURE:    Dataset promotion My → Domain → Company
 * USER STORY: As a creator I promote a dataset version I own to my Domain so teammates and agents can read it;
 *             as a domain_admin I approve or reject that promotion from Governance.
 * ARCHITECTURE:
 *   - Pure functions over the dataset record (no I/O) — called by tabs/data/api/promote and by the MCP tool `request_promotion`.
 *   - Persistence via @core/control-plane (Postgres); search mirror via @core/control-plane/os-mirror.
 *   - Authorisation: @core/policy decidePromotion() → OPA; never bypassed here.
 *   - Emits approval PendingAction (see @core/policy/pending-action.ts) when the target scope is Domain/Company.
 */
```

**TabManifest contract (`core/manifest.ts`):**
```ts
export type TabManifest = {
  key: TabFeature;                       // 'data'
  nav: { label: string; icon: string; href: string; group: 'Entry'|'Context'|'Build'|'Manage'; minRole?: Role };
  routes: string[];                      // page routes this tab owns ('/data', '/data/[id]')
  api: string[];                         // API prefixes ('/api/datasets', '/api/data')
  mcpTools: string[];                    // names registered from tabs/<key>/mcp
  policies: string[];                    // .rego files under tabs/<key>/policy
  services: ServiceName[];               // kernel/components this tab needs ('postgres','minio','trino','dbt')
};
```
Absent service ⇒ the tab is absent from nav and 404s honestly (today's `OS_ENABLED_TABS` behaviour, now derived from `services` + the Helm `enabled` flags instead of a hand-typed list).

### Removed (not needed by the 13 tabs)
- **Tabs/pages:** strategy, big-bets, operating-model, marketplace, science, console, cockpit, tutorials → `app/(plan)`, `app/(build)/science|console`, `lib/experimental/{bigbets,strategy,science,marketplace,superset}`, `lib/tutorials`, `lib/talk` (if only used by cockpit — verify with `grep -r "lib/talk"`).
- **Decision (recommended default): fold `components`, `mcp` (token page), `llm-gateway` (virtual keys), `about` (licences) into `tabs/admin` as sub-pages** — they are admin functions and Alex hit `/components` 8× in a week. Alternative: delete them and lose MCP-token/virtual-key self-service UIs.
- **Runtimes:** `lib/experimental/hermes` (alternate runtime), `lib/agents/build/agentic-graph.ts` + `run-graph.ts` (after Phase 3 parity), `images/extensions/{sample-agent,ml-agent,ml-trainer,mlflow,sandbox-shell,terminal-broker,workbench-broker,code-server-workbench,haystack-retriever,superset,ci-builder}`.
- **Chart extensions:** `science, superset, haystack, mail, terminal, wireguard, workbench, sales-assistant, hermes, cube, openmetadata, metrics(cube), software(forgejo/argocd/ci-runner)`; keep `lakehouse, dbt, docling, backup, connections, agent` (agent = agent-runtime glue → `core/deploy`).
- **Root dirs:** `ee/`, `experimental/`, `compose/`, `seed/` (keep only seeds the 13 tabs use → `tabs/<tab>/seed`), `cli/` (delete unless Steph wants it — verify callers), `tests/` (move per tab).
- **Connectors:** everything except `onedrive outlook teams gdrive kajabi-api notion-mcp entra gmail generic-mcp` (Phase 5 list; do it here since the folder moves anyway).
- **Open question for Alex — Software tab:** it stays (one of the 13) but Forgejo/ArgoCD/ci-runner are switched off since rev 392. Decide: (a) Software = app specs + previews only, no git/CI (delete `lib/git`, Forgejo client) or (b) bring a git backend back later behind `tabs/software/manifest.services`. Default in this plan: (a).

### Migration mechanics (one PR per step, `npm test` + `helm template` green each)
1. `scripts/check-structure.mjs` + `tsconfig` paths (`@core/*`, `@tabs/*`) — empty folders, checker passes trivially.
2. `git mv` kernel code into `core/` (auth, policy, mcp, runtime, infra, folders, prefs, oauth, notifications, app-sdk, app shell); fix imports with `sed` over `@/lib/<old>` → `@core/<new>`; commit.
3. One tab per PR, in usage order: data → agents → files → knowledge → connections → governance → monitoring → admin → dashboards → metrics → software → workflows → home. Each PR: `git mv` pages/api/lib/mcp/policy/guide/tests, thin `app/` re-exports, write `manifest.ts`, add header blocks to every moved file (a subagent per folder; the checker blocks the merge until all headers exist), delete code in that folder that nothing imports (`npx knip` + `ts-prune` report attached to the PR).
4. Deletions PR: removed tabs, runtimes, chart extensions, root dirs, connectors. `helm template` must render identically to rev 392's live manifest minus the removed components (diff attached).
5. `components/` + `scripts/assemble-chart.sh` + CI step that fails if `charts/…/templates` differs from the assembled output.
6. Deploy as `scripts/deploy-<ver>.sh`; verify the 13 tabs, MCP `whoami`/`list_capabilities`, one agent run, dataset list + promotion request.

### Size reality check
Today: 2,344 TS/TSX files in os-ui (798 under `lib/experimental`), 20 chart extension folders, 15 extension images. The deletions above remove roughly half the files before any headers are written; headers are added **as each tab moves** (never as a separate pass), by one subagent per folder with the checker as the gate — budget ~1 PR per tab, 13 tab PRs + 4 infrastructure PRs.

### Phase R addendum — remove everything old (Alex, 2026-10-28: "remove all old charts, scripts and any other old stuff … as lean as possible")

Inventory today → target:

| Area | Today | After Phase R |
|---|---|---|
| `scripts/` | 107 files (69 `deploy-06xx.sh`, 27 `public-sync-*.sh`, 11 misc) | **4**: `os` (local up/down/test, below), `deploy.sh` (one parametrised cloud deploy: `deploy.sh <version>` = backup → build → push → helm upgrade), `check-structure.mjs`, `build-docs.mjs` |
| root `values*.yaml` | 10 (`dbt-git, example, generated, local, mail.private.example, private.example, private, selfcontained, stackit-managed, stackit-selfhosted`) + chart `values.{aks,eks,gke}.yaml` | **3**: `charts/…/values.yaml` (kernel defaults, every optional component `enabled: false`), `values.local.yaml` (kind: 1 replica, small requests, no TLS, mock-model or STACKIT key), `values.stackit.yaml` (prod overrides). `values.private.yaml` stays git-ignored, keys only. |
| root files | `CHANGELOG CI-BUILD-INTEGRATION CI-LAYER4-INTEGRATION CLA compose.yaml GOVERNANCE install.sh kind-config.yaml Makefile sbom.cdx.json SCIENCE-KSERVE-FIX SECURITY THIRD-PARTY-LICENSES TRADEMARKS …` | keep `README.md LICENSE NOTICE THIRD-PARTY-LICENSES.md SECURITY.md CONTRIBUTING.md CLA.md Makefile kind-config.yaml`; delete the rest (`CI-*`, `SCIENCE-KSERVE-FIX`, `compose.yaml`, `install.sh` → folded into `scripts/os`, `sbom.cdx.json` → generated in CI, `GOVERNANCE.md`, `TRADEMARKS.md` → sections in README) |
| `deploy/` | terraform, velero, argocd, cloud, stackit, seeds, migration scripts, `kubeconfig.yaml` | `deploy/stackit/` (terraform **-target only**, velero install + values, `pre-upgrade-backup.sh`) — nothing else. ArgoCD/cloud/seeds/migrations deleted. |
| `docs/` | 33 hand-written files + `code-review-*` + `build-spec` + `components/` | `docs/superpowers/plans/` (this plan) + `docs/site/` (**generated**, Phase D) + `docs/backups.md` + `docs/stackit.md`. Every other doc deleted — the header blocks and manifests are the documentation source. |
| `compose/`, `cli/`, `ee/`, `experimental/`, `tests/policies` | present | deleted (`tests/policies` → `tabs/<tab>/policy/*_test.rego`) |
| `images/` | `base/` (6) + `extensions/` (15) | only `components/*/Dockerfile` (upstream `FROM` pins) + `core/ui/Dockerfile` (os-ui) + `components/agent-runtime/` |
| Chart | base + 20 extensions, 2.8k-line `values.yaml` | `templates/{core,tabs/<tab>,components/<name>}` assembled; `values.yaml` ≤ 400 lines; `helm template -f values.local.yaml` renders kernel + 13 tabs only |

Rule: a file survives Phase R only if (a) a tab manifest or `core/` references it, or (b) it is one of the kept root/deploy files above. `scripts/check-structure.mjs` fails on any file outside `core/ tabs/ components/ charts/ deploy/stackit/ docs/ scripts/ os-ui/{app,public,package.json,next.config.mjs,tsconfig.json}` + the kept root files.

### Phase L — local deployment in one command (kind on Colima, already installed on Alex's Mac)

**Files:** `scripts/os` (bash, ~120 lines), `values.local.yaml` (rewritten), `kind-config.yaml` (kept: ports 8080→ingress), `Makefile` (3 targets: `up`, `down`, `test`), README "Run it locally" (10 lines).

```
./scripts/os up        # 1) kind create cluster --config kind-config.yaml (idempotent)
                       # 2) docker build core/ui → os-ui:local; kind load docker-image
                       # 3) helm upgrade --install agentic-os charts/sovereign-agentic-os -f values.local.yaml \
                       #      --set osUI.image.tag=local --set litellm.upstreamKey="${STACKIT_API_KEY:-}"   (empty ⇒ mock-model)
                       # 4) kubectl wait --for=condition=available deploy --all --timeout=10m
                       # 5) prints: http://localhost:8080  login admin@local / <generated, printed once>  MCP token: <printed>
./scripts/os test      # runs tabs/*/**.test.ts + helm lint + the Phase-4 acceptance scenario against localhost:8080
./scripts/os down      # kind delete cluster
```
**Local profile (`values.local.yaml`):** 1 replica everywhere; OpenSearch single node 1Gi; Postgres 1 instance; MinIO 1 drive; Langfuse + ClickHouse on (they are kernel — but ClickHouse 512Mi); LiteLLM → STACKIT when the key is present, else `mock-model`; Trino/dbt/Dagster/Docling on only because Data/Files manifests require them (Dagster stays per Alex); no cert-manager, no TLS, ingress-nginx from the kind recipe; `osUI.allowOfflineUserSeed=true` with a single generated admin. Target: cold `up` < 12 min on an M-series Mac with 16 GB given to Colima; warm < 3 min. The same chart + `values.stackit.yaml` is production — no second deployment path.

**Acceptance:** fresh clone → `./scripts/os up` → all 13 tabs open, `whoami` over MCP works, one dataset CSV upload + promotion request + approval completes; `./scripts/os test` green; `./scripts/os down` leaves nothing behind.

### Phase D — generated web documentation (Alex, 2026-10-28: "a web documentation page that explains each code folder")

**Files:** `scripts/build-docs.mjs`, output `docs/site/index.html` (single self-contained page, no build dependencies, committed), CI step `node scripts/build-docs.mjs --check` fails when the committed page is stale.

**Source of truth = the code itself:** the script walks `core/`, `tabs/*`, `components/*` and renders, per folder: purpose (from `manifest.ts` or a `FOLDER.md` one-liner), the file list with each file's `FEATURE · USER STORY · ARCHITECTURE` header, the tab's routes/API/MCP tools/policies/services from its manifest, the component's `UPSTREAM.md` (version, digest, licence), and the import graph between `tabs/*` and `core/*` (so a forbidden cross-tab import is visible, not just linted). One page, left-hand folder tree, deep links per file, searchable. Published two ways: committed in the repo (works offline, GitHub renders it) and as a claude.ai artifact after each release. Written **last**, after Phase R + L, because its content is the headers and manifests those phases produce.

---

## Decisions log — 2026-10-28 / 29 (owner: Alex)

Each line is a settled decision; the plan sections above are superseded where they disagree.

1. **13 tabs, fixed.** Home · MCP · About (Entry) · Data · Metrics · Files · Knowledge (Context) · **Workflows** · Agents · Dashboards · Software (Build) · Connections · Governance · Monitoring · Admin (Manage). "Business Workflows" is renamed **Workflows** and is the **first Build tab**. "Policies & Approvals" is **Governance**; the group formerly called Govern is **Manage**.
2. **Marketplace is replaced by the scope ladder.** No import/grant/listing mechanics. Any artifact: My → Domain (domain-admin approval) → **Company (platform-admin approval)**; a Company artifact is readable by everyone in the tenant regardless of domain. Governance holds both approval kinds. The `marketplace` OPA policy is deleted; "Marketplace" survives only as the internal name of the Company scope tier (≈728 references) and is renamed in Phase R.
3. **Dagster stays and becomes the OS-wide sync/pipeline orchestrator** — not optional, enabled locally too. Rationale: the three `curl`-based CronJobs (`data-sync`, `dq`, `metrics-alert`) only POST `/api/data/sync-due`; no retries, no run history, no dependencies, a lost tick when a pod restarts. Dagster replaces them with assets + schedules + sensors across four tabs: Data (SQL/dlt → dbt → quality checks as asset checks), Files (OneDrive/Google Drive folder sync → Docling extraction), Knowledge (re-index/embed after a file sync), Connections (Outlook/Gmail/Kajabi/Teams pulls). Definitions are **generated from the OS registry**, not hand-written; the Dagster UI stays available for runs/retries/backfills. Only the backup CronJobs (`pg-dump`, `opensearch-snapshot`) remain cron — they must not depend on the app being healthy.
4. **Langfuse stays; Arize Phoenix rejected.** Phoenix would drop ClickHouse + Valkey + the Langfuse worker and is OTel-native, but its server is **Elastic License 2.0** — "may not provide the software to third parties as a hosted or managed service". Data Masterclass wants the option to run the Sovereign OS as a managed service, which ELv2 forbids and Langfuse's MIT core permits. Phase 3 still writes tracing **vendor-neutral** (OpenTelemetry spans → a Langfuse exporter) so the choice is reversible without a rewrite.
5. **Connector keep-list** (all others deleted with their clients and tests): `onedrive`, `outlook`, `teams`, `gdrive`, `gmail`, `kajabi-api`, `notion-mcp`, `entra`, **`database`** (generic SQL — the "pull from a SQL DB on a schedule" case), `generic-mcp` (any MCP server). Each is a Dagster source adapter plus an agent tool, nothing more.
6. **Local is the default, STACKIT is the overlay.** `./scripts/os up|test|down` (kind + the host's Docker) is the documented way to run the repo; `install.sh`, `bootstrap-local.sh`, `build-images.sh` and the cloud bootstrap scripts are deleted. kind maps host `:8080` → os-ui NodePort `30080`. Without `STACKIT_API_KEY` the stack serves `mock-model` so a fresh clone works offline. The same chart + `values.stackit-managed.yaml` is production.
7. **`components/<name>/` holds upstream only** — `UPSTREAM.md` with project, licence and the exact pin (image digest or chart version). No Dockerfile that adds layers, no templates, no scripts. 12 components pinned. Licences recorded; **MinIO is AGPL-3.0** (we ship it unmodified, so a managed offering satisfies the source obligation by pointing at upstream), Langfuse core is MIT.
8. **Software tab without git/CI.** Forgejo, ArgoCD and the CI runner are gone for good. An app is a spec + design + generated files + preview + verify + a deploy approval; versions are app-store versions, not commits. If in-OS git returns it comes back behind `tabs/software/manifest.services`.
9. **Agents are LangGraph code, versioned in git** (Phase 3, unchanged in intent, now explicit): `system.yaml` compiles to a real package (`graph.py` with `StateGraph`, conditional edges, `Command(goto)` guards, `interrupt()` for approvals; `tools.py`; `agent.md`; tests) that an engineer can run outside the OS. agent-runtime keeps a bare git repo per tenant; **every Build is a commit and the commit SHA is the version**; runs, approvals and traces reference that SHA; optional push to the customer's own GitHub/GitLab over a token Connection. `/run` accepts only a committed SHA — there is no YAML-from-memory path (this also closes review finding 6). The custom TS and Python walkers are deleted once parity tests pass.
