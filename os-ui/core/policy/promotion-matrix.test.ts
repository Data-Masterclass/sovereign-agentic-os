/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       policy
 * FEATURE:    The cross-kind promotion matrix — My → Domain → Company for EVERY artefact kind
 * USER STORY: As the owner I asked "check also promotion of all other artifacts" after a file
 *             promotion answered "0 requested · 1 failed". I want one test that walks every kind
 *             through the real dispatcher as a creator, a builder, a domain admin and an admin, so
 *             that no kind can ever again offer a request it cannot approve, swallow the reason it
 *             refused, or let the wrong rank decide.
 * ARCHITECTURE:
 *   - Imports `@core/*` ONLY. `check-structure.mjs` counts CORE-INDEPENDENCE per import
 *     statement and the baseline is exactly 200, so a cross-kind test that reached into
 *     `@tabs/*` would fail the ratchet. Everything is therefore driven through the ONE
 *     dispatcher (`handleRpc`, `tools/call`) exactly as an MCP client drives it — which is also
 *     the stronger test: the governed path, not a tab's internals.
 *   - `node --test` gives each test FILE its own process, so there is no store to reset; the
 *     shared approvals queue is reset per test (`__resetApprovals`) and every artefact is
 *     created with a fresh id.
 *   - The two axes are asserted SEPARATELY. Audience is read back from each kind's own getter;
 *     the lifecycle axis is `livePin(kind, id)` (core/infra/lifecycle-pins) and must stay
 *     undefined across a promotion — a promotion may never go-live anything.
 *   - What this file canNOT see: a `.tsx` cannot be imported (Node strips types, not JSX), so
 *     the four UI surfaces that used to lose the outcome are pinned by SOURCE TRIPWIRES — the
 *     component is read as text and the required branch asserted by pattern. A tripwire proves
 *     the branch exists, never that it renders.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { CurrentUser } from '@core/kernel/auth';
import { handleRpc, type JsonRpcResponse, type ToolError } from '@core/mcp/server';
import { __resetApprovals, enqueue, getApproval, listApprovals, type Approval } from '@core/policy/approvals';
import { livePin } from '@core/infra/lifecycle-pins';

// --------------------------------------------------------------- principals ---
/** The owner of almost everything below: a creator, who may only PROPOSE. */
const cara: CurrentUser = { id: 'cara', name: 'Cara', domains: ['sales'], role: 'creator' };
/** A domain builder: can build + file, and is NOT the rung-1 approver. */
const ben: CurrentUser = { id: 'ben', name: 'Ben', domains: ['sales'], role: 'builder' };
/** The rung-1 (My→Domain) approver. */
const dana: CurrentUser = { id: 'dana', name: 'Dana', domains: ['sales'], role: 'domain_admin' };
/** The rung-2 (→Company) certifier. */
const ada: CurrentUser = { id: 'ada', name: 'Ada', domains: ['sales'], role: 'admin' };
/** A creator in ANOTHER domain — must see nothing of sales. */
const dan: CurrentUser = { id: 'dan', name: 'Dan', domains: ['ops'], role: 'creator' };
/** A BUILDER in another domain: past `decide_approval`'s role floor, so his refusal proves the
 *  SCOPE check rather than the rank check — that is where an existence leak would show. */
const bob: CurrentUser = { id: 'bob', name: 'Bob', domains: ['ops'], role: 'builder' };

// ------------------------------------------------------------------ plumbing ---
async function raw(user: CurrentUser, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await handleRpc(user, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.ok(res && 'result' in res, `expected a tools/call result for ${name}`);
  return (res as JsonRpcResponse).result as Record<string, unknown>;
}
function text(r: Record<string, unknown>): string {
  return (r.content as { text: string }[] | undefined)?.[0]?.text ?? '';
}
/** Assert success and parse the tool's JSON payload. */
async function call<T = Record<string, unknown>>(u: CurrentUser, n: string, a: Record<string, unknown> = {}): Promise<T> {
  const r = await raw(u, n, a);
  assert.notEqual(r.isError, true, `expected ${n} to succeed, got: ${text(r)}`);
  return JSON.parse(text(r)) as T;
}
/** Assert a TYPED refusal and return it — this is what "the reason reached the user" means. */
async function refusal(u: CurrentUser, n: string, a: Record<string, unknown> = {}): Promise<ToolError> {
  const r = await raw(u, n, a);
  assert.equal(r.isError, true, `expected ${n} to refuse, got: ${text(r)}`);
  return (r.structuredContent as { error: ToolError }).error;
}

const UI = dirname(dirname(dirname(fileURLToPath(import.meta.url)))); // …/os-ui
const src = (rel: string): string => readFileSync(join(UI, rel), 'utf8');

type Filed = { status?: string; requestId?: string; approvalId?: string; kind?: string; promoted?: boolean };

/** Every kind that walks the ladder, with how to create one and how to read its audience back. */
type KindSpec = {
  /** The `kind` string `request_promotion` takes. */
  kind: string;
  /** The lifecycle kind name, for the pin assertion. */
  lifecycleKind: string;
  /** Create one owned by `owner`; returns its id. */
  create: (owner: CurrentUser, name: string) => Promise<string>;
  /** Who may create this kind at all (connections need a Builder). */
  owner: CurrentUser;
  read: { tool: string; arg: string; field: 'visibility' | 'tier' };
  /** The audience values this kind persists, in ladder order. */
  audience: { my: string; domain: string; company: string };
  approvalKind: Approval['kind'];
};

const LADDER: KindSpec[] = [
  {
    kind: 'knowledge',
    lifecycleKind: 'knowledge',
    owner: cara,
    create: async (o, n) => (await call<{ id: string }>(o, 'author_knowledge', { title: n })).id,
    read: { tool: 'get_knowledge', arg: 'workflowId', field: 'visibility' },
    audience: { my: 'Personal', domain: 'Shared', company: 'Marketplace' },
    approvalKind: 'artifact_promote',
  },
  {
    kind: 'agent_system',
    lifecycleKind: 'agent',
    owner: cara,
    create: async (o, n) => (await call<{ id: string }>(o, 'create_agent_system', { name: n })).id,
    read: { tool: 'get_agent_system', arg: 'systemId', field: 'visibility' },
    audience: { my: 'Personal', domain: 'Shared', company: 'Marketplace' },
    approvalKind: 'artifact_promote',
  },
  {
    kind: 'app',
    lifecycleKind: 'app',
    owner: cara,
    create: async (o, n) => (await call<{ id: string }>(o, 'create_software', { name: n })).id,
    read: { tool: 'get_software', arg: 'appId', field: 'visibility' },
    audience: { my: 'Personal', domain: 'Shared', company: 'Certified' },
    approvalKind: 'artifact_promote',
  },
  {
    kind: 'dashboard',
    lifecycleKind: 'dashboard',
    owner: cara,
    create: async (o, n) =>
      (
        await call<{ id: string }>(o, 'create_dashboard', {
          name: n,
          view: 'Orders',
          charts: [{ name: 'c', vizType: 'table', metric: 'Orders.revenue' }],
        })
      ).id,
    read: { tool: 'get_dashboard', arg: 'dashboardId', field: 'tier' },
    audience: { my: 'personal', domain: 'domain', company: 'marketplace' },
    approvalKind: 'artifact_promote',
  },
  {
    kind: 'file',
    lifecycleKind: 'knowledge', // files have no lifecycle kind of their own; the pin must stay empty regardless
    owner: cara,
    create: async (o, n) =>
      (await call<{ id: string }>(o, 'upload_file', { name: `${n}.md`, text: 'hello', description: 'A documented file.', tags: ['audit'] })).id,
    read: { tool: 'get_file', arg: 'fileId', field: 'tier' },
    audience: { my: 'dataset', domain: 'asset', company: 'product' },
    approvalKind: 'file_promote',
  },
];

// ====================== (b)+(c) THE REFUSAL REACHES THE USER ===================

test('matrix (b,c): the documentation gate that produced "1 failed" answers VERBATIM', async () => {
  __resetApprovals();
  // A file with neither a description nor a tag — the owner's actual case.
  const bare = await call<{ id: string }>(cara, 'upload_file', { name: 'bare.md', text: 'x' });
  const e = await refusal(cara, 'request_promotion', { kind: 'file', id: bare.id });
  assert.equal(e.code, 'bad_request');
  assert.equal(
    e.reason,
    'Cannot promote — add a description, at least one tag first.',
    'the gate reason is the users only instruction — it must survive the transport byte for byte',
  );

  // Half-documented: a description but no tag. The reason must name the MISSING half only.
  const halfA = await call<{ id: string }>(cara, 'upload_file', { name: 'half-a.md', text: 'x', description: 'Has prose.' });
  assert.equal((await refusal(cara, 'request_promotion', { kind: 'file', id: halfA.id })).reason, 'Cannot promote — add at least one tag first.');
  const halfB = await call<{ id: string }>(cara, 'upload_file', { name: 'half-b.md', text: 'x', tags: ['t'] });
  assert.equal((await refusal(cara, 'request_promotion', { kind: 'file', id: halfB.id })).reason, 'Cannot promote — add a description first.');
});

test('matrix (b,c): every kind refuses a NON-owner trigger by name, and never leaks existence', async () => {
  __resetApprovals();
  for (const k of LADDER) {
    const id = await k.create(k.owner, `nonowner-${k.kind}`);
    // ben can SEE nothing personal of cara's, but he is in the domain: the refusal must be
    // about OWNERSHIP, never a silent success.
    const e = await refusal(ben, 'request_promotion', { kind: k.kind, id });
    assert.match(
      e.reason,
      /owner can (request its promotion|promote it directly)|[Nn]ot permitted|not authorized|not found/i,
      `${k.kind}: a non-owner trigger must be refused with a reason, got ${e.reason}`,
    );
    // A creator in another domain must not learn the id exists.
    const foreign = await refusal(dan, 'request_promotion', { kind: k.kind, id });
    assert.match(
      foreign.reason,
      /not found|[Nn]ot permitted|not authorized|owner/i,
      `${k.kind}: a foreign domain is refused, never served`,
    );
  }
});

// ================= (d) THE REQUEST, ITS APPROVER ROLE AND ITS SCOPE ===========

test('matrix (d): a creator OWNER files a rung-1 request with approverRole=domain_admin, scope=domain', async () => {
  for (const k of LADDER) {
    __resetApprovals();
    const id = await k.create(k.owner, `filed-${k.kind}`);
    const filed = await call<Filed>(k.owner, 'request_promotion', { kind: k.kind, id });
    assert.equal(filed.status, 'pending', `${k.kind}: filing returns the canonical pending handle`);
    const a = getApproval(filed.requestId!);
    assert.ok(a, `${k.kind}: the request is really in the queue`);
    assert.equal(a!.kind, k.approvalKind, `${k.kind}: approval kind`);
    assert.equal(a!.approverRole, 'domain_admin', `${k.kind}: My→Domain is a domain_admin rung`);
    assert.equal(a!.scope, 'domain', `${k.kind}: My→Domain is domain-scoped`);
    assert.equal(a!.requestedBy, k.owner.id, `${k.kind}: the requester is recorded`);
    assert.equal(a!.domain, 'sales', `${k.kind}: the request lands in the artefact's domain`);
    // Idempotent: filing again returns the SAME request, never a second one.
    const again = await call<Filed>(k.owner, 'request_promotion', { kind: k.kind, id });
    assert.equal(again.requestId, filed.requestId, `${k.kind}: a second filing is idempotent`);
    assert.equal(listApprovals({ status: 'pending' }).length, 1, `${k.kind}: exactly one pending request`);
  }
});

test('matrix (d): a creator can NEVER approve — not their own request, not anyone else’s', async () => {
  for (const k of LADDER) {
    __resetApprovals();
    const id = await k.create(k.owner, `noapprove-${k.kind}`);
    const filed = await call<Filed>(k.owner, 'request_promotion', { kind: k.kind, id });

    // The requester themself: four-eyes, whatever their rank.
    const own = await refusal(k.owner, 'decide_approval', { requestId: filed.requestId!, decision: 'approve' });
    assert.match(own.reason, /cannot approve your own request|higher role|creator/i, `${k.kind}: the requester may not decide`);

    // A plain builder in the domain: sees it, cannot decide a domain_admin rung.
    const builder = await refusal(ben, 'decide_approval', { requestId: filed.requestId!, decision: 'approve' });
    assert.match(builder.reason, /needs a Domain admin|needs an? .*[Aa]dmin/, `${k.kind}: a builder is not the rung-1 approver (${builder.reason})`);

    // A creator never clears decide_approval's role floor at all.
    assert.equal((await refusal(dan, 'decide_approval', { requestId: filed.requestId!, decision: 'approve' })).code, 'forbidden');
    // A BUILDER in another domain clears the floor and is then refused on SCOPE — as
    // not_found, indistinguishable from "no such id", so the queue cannot be probed.
    const foreign = await refusal(bob, 'decide_approval', { requestId: filed.requestId!, decision: 'approve' });
    assert.equal(foreign.code, 'not_found', `${k.kind}: out-of-scope is not_found (no existence leak)`);

    // Nothing moved.
    assert.equal(getApproval(filed.requestId!)!.status, 'pending', `${k.kind}: a refused decision leaves the request pending`);
  }
});

// ================== (e)+(f) APPROVE FLIPS AUDIENCE, NOT LIFECYCLE =============

test('matrix (e): the domain admin APPROVES and the audience flips to Domain — lifecycle untouched', async () => {
  for (const k of LADDER) {
    __resetApprovals();
    const id = await k.create(k.owner, `approve-${k.kind}`);
    const before = await call<Record<string, unknown>>(k.owner, k.read.tool, { [k.read.arg]: id });
    assert.equal(before[k.read.field], k.audience.my, `${k.kind}: starts in My`);
    const pinBefore = await livePin(k.lifecycleKind, id);

    const filed = await call<Filed>(k.owner, 'request_promotion', { kind: k.kind, id });
    const decided = await call<{ decided: string; effect: { applied: string; ok: boolean } }>(dana, 'decide_approval', {
      requestId: filed.requestId!,
      decision: 'approve',
    });
    assert.equal(decided.decided, 'approved', `${k.kind}: the domain admin can decide`);
    assert.equal(decided.effect.ok, true, `${k.kind}: the effect ran — ${decided.effect.applied}`);

    const after = await call<Record<string, unknown>>(k.owner, k.read.tool, { [k.read.arg]: id });
    assert.equal(after[k.read.field], k.audience.domain, `${k.kind}: the audience is now Domain`);
    assert.equal(getApproval(filed.requestId!)!.status, 'approved', `${k.kind}: the request is closed out`);
    assert.ok(getApproval(filed.requestId!)!.effect?.applied, `${k.kind}: the card records what the approval did`);

    // THE OTHER AXIS. A promotion may never go-live anything.
    assert.deepEqual(await livePin(k.lifecycleKind, id), pinBefore, `${k.kind}: promotion must not write a lifecycle pin`);
  }
});

test('matrix (g): rung 2 — the domain files, only a platform ADMIN certifies to Company', async () => {
  for (const k of LADDER.filter((x) => x.approvalKind === 'artifact_promote')) {
    __resetApprovals();
    const id = await k.create(k.owner, `certify-${k.kind}`);
    const filed = await call<Filed>(k.owner, 'request_promotion', { kind: k.kind, id });
    await call(dana, 'decide_approval', { requestId: filed.requestId!, decision: 'approve' });

    const cert = await call<Filed>(dana, 'request_certification', { kind: k.kind, id });
    const c = getApproval(cert.requestId!)!;
    assert.equal(c.kind, 'promote_certify', `${k.kind}: rung 2 is promote_certify`);
    assert.equal(c.approverRole, 'admin', `${k.kind}: →Company is an admin rung`);
    assert.equal(c.scope, 'tenant', `${k.kind}: →Company is tenant-scoped`);

    // A domain admin cannot certify, and must be told who can.
    const e = await refusal(dana, 'decide_approval', { requestId: cert.requestId!, decision: 'approve' });
    assert.match(e.reason, /platform Admin|your own request/i, `${k.kind}: certification needs a platform admin (${e.reason})`);

    await call(ada, 'decide_approval', { requestId: cert.requestId!, decision: 'approve' });
    const after = await call<Record<string, unknown>>(k.owner, k.read.tool, { [k.read.arg]: id });
    assert.equal(after[k.read.field], k.audience.company, `${k.kind}: the audience is now Company`);
  }
});

// =========== (d) THE DEAD END: AN OWNER WHO ALSO HOLDS THE AUTHORITY ==========

test('matrix (d): an owner who IS the approver is never dead-ended — files, then decides', async () => {
  for (const k of LADDER) {
    __resetApprovals();
    // dana owns it AND holds the rung-1 authority. Blanket four-eyes did not give this
    // artefact a second pair of eyes — it gave it none: nobody else could decide a request
    // only dana could have filed, so the asset could never leave My.
    const id = await k.create(dana, `selfown-${k.kind}`);
    const filed = await call<Filed>(dana, 'request_promotion', { kind: k.kind, id });
    assert.equal(filed.status, 'pending', `${k.kind}: the request is still FILED, not auto-applied`);

    const decided = await call<{ decided: string }>(dana, 'decide_approval', { requestId: filed.requestId!, decision: 'approve' });
    assert.equal(decided.decided, 'approved', `${k.kind}: the owner-approver can clear their own audience request`);
    const after = await call<Record<string, unknown>>(dana, k.read.tool, { [k.read.arg]: id });
    assert.equal(after[k.read.field], k.audience.domain, `${k.kind}: the owner-approver's asset really reached Domain`);
    assert.equal(listApprovals({ status: 'pending' }).length, 0, `${k.kind}: nothing left pending`);
  }
});

test('matrix (d): the self-decide carve-out is for AUDIENCE moves only — rank and scope still bind', async () => {
  __resetApprovals();
  // A creator owner still cannot decide: the rank gate comes first.
  const mine = await call<{ id: string }>(cara, 'author_knowledge', { title: 'carve-rank' });
  const caraFiled = await call<Filed>(cara, 'request_promotion', { kind: 'knowledge', id: mine.id });
  assert.match(
    (await refusal(cara, 'decide_approval', { requestId: caraFiled.requestId!, decision: 'approve' })).reason,
    /higher role|creator|cannot approve your own/i,
    'a creator is below the rung-1 approver rank, carve-out or not',
  );

  // A domain admin still cannot decide a TENANT-scoped item she filed herself (certification
  // needs a platform admin) — the scope gate is untouched.
  await call(dana, 'decide_approval', { requestId: caraFiled.requestId!, decision: 'approve' });
  const cert = await call<Filed>(dana, 'request_certification', { kind: 'knowledge', id: mine.id });
  assert.match(
    (await refusal(dana, 'decide_approval', { requestId: cert.requestId!, decision: 'approve' })).reason,
    /platform Admin/i,
    'a domain admin cannot certify to Company, even her own filing',
  );

  // And a PARKED AGENT RUN is absolute: four-eyes never yields there.
  const held = enqueue({
    kind: 'connection_write',
    title: 'held agent write',
    detail: 'an agent run parked on a write',
    agent: 'agent:sales',
    domain: 'sales',
    requestedBy: dana.id,
    tool: 'crm_update',
    payload: {},
    approverRole: 'domain_admin',
    scope: 'domain',
    runId: 'run_abc',
    threadId: 'run_abc',
    interruptKey: 'run_abc:call_1',
  });
  assert.match(
    (await refusal(dana, 'decide_approval', { requestId: held.id, decision: 'approve' })).reason,
    /cannot approve your own request/i,
    'the runner may never authorise their own run’s escalation',
  );
});

test('tripwire: the dataset and file promote routes offer the owner-approver a one-shot', () => {
  assert.match(src('app/api/files/[id]/promote/route.ts'), /promoteFileOrPropose/, 'the Files promote route must use promote-or-propose');
  assert.match(src('app/api/data/datasets/[id]/promote/route.ts'), /promoteDatasetOrPropose/, 'the Data promote route must use promote-or-propose');
  for (const rel of ['app/api/files/[id]/promote/route.ts', 'app/api/data/datasets/[id]/promote/route.ts']) {
    assert.match(src(rel), /requested: true/, `${rel}: a filed request must answer { requested: true } like every other kind`);
  }
});

test('matrix (d): the one-shot path still enforces the documentation gate', async () => {
  __resetApprovals();
  // dana is the owner AND the approver, but the file is undocumented: the SAME refusal.
  const bare = await call<{ id: string }>(dana, 'upload_file', { name: 'dana-bare.md', text: 'x' });
  const e = await refusal(dana, 'request_promotion', { kind: 'file', id: bare.id });
  assert.equal(e.reason, 'Cannot promote — add a description, at least one tag first.');
  const still = await call<{ tier: string }>(dana, 'get_file', { fileId: bare.id });
  assert.equal(still.tier, 'dataset', 'a refused one-shot leaves the audience untouched');
});

// =============================== DATASETS =====================================

test('matrix: a dataset files a domain_admin rung-1 request, and no creator can apply it', async () => {
  __resetApprovals();
  const ds = await call<{ id: string }>(cara, 'create_dataset', { name: 'Orders A', columns: [{ name: 'a', description: 'A' }] });
  await call(cara, 'add_dataset_version', { datasetId: ds.id, layer: 'bronze' });
  await call(cara, 'add_dataset_version', { datasetId: ds.id, layer: 'silver', body: 'select 1 as a from bronze' });
  await call(cara, 'document_dataset', { datasetId: ds.id, description: 'One row.', columns: [{ name: 'a', description: 'A' }] });

  // A NON-owner cannot file — checked BEFORE anything is filed, because the dedup branch
  // would otherwise hand ben the owner's existing pending handle.
  assert.match(
    (await refusal(ben, 'request_promotion', { kind: 'dataset', id: ds.id })).reason,
    /owner can request its promotion/i,
  );

  const filed = await call<Filed>(cara, 'request_promotion', { kind: 'dataset', id: ds.id });
  const a = getApproval(filed.requestId!)!;
  assert.equal(a.kind, 'dataset_promote');
  assert.equal(a.approverRole, 'domain_admin', 'datasets ride the same rung-1 authority as every other kind');
  assert.equal(a.scope, 'domain');

  // `approve_promotion` is the dataset/file half of the split; a creator is below its floor
  // and must be told so rather than silently achieving nothing.
  assert.match((await refusal(cara, 'approve_promotion', { approvalId: filed.requestId! })).reason, /role|admin|permitted|forbidden/i);
  // And the owner cannot decide their own filing even through the generic queue tool.
  assert.match(
    (await refusal(cara, 'decide_approval', { requestId: filed.requestId!, decision: 'approve' })).reason,
    /cannot approve your own request|higher role|creator/i,
  );
  assert.equal(getApproval(filed.requestId!)!.status, 'pending', 'nothing was decided');

});

test('matrix: a dataset owner who IS the approver files, decides, and the publish runs as her', async () => {
  __resetApprovals();
  // Bronze only: the shareability gate speaks before anything is filed, whoever is asking.
  const bare = await call<{ id: string }>(dana, 'create_dataset', { name: 'Dana Raw', columns: [] });
  await call(dana, 'add_dataset_version', { datasetId: bare.id, layer: 'bronze' });
  assert.equal(
    (await refusal(dana, 'request_promotion', { kind: 'dataset', id: bare.id })).reason,
    'Promote a Silver or Gold version — Bronze raw data is not shareable',
  );

  const ds = await call<{ id: string }>(dana, 'create_dataset', { name: 'Dana Orders', columns: [{ name: 'a', description: 'A' }] });
  await call(dana, 'add_dataset_version', { datasetId: ds.id, layer: 'bronze' });
  await call(dana, 'add_dataset_version', { datasetId: ds.id, layer: 'silver', body: 'select 1 as a from bronze' });
  await call(dana, 'document_dataset', { datasetId: ds.id, description: 'One row.', columns: [{ name: 'a', description: 'A' }] });

  const filed = await call<Filed>(dana, 'request_promotion', { kind: 'dataset', id: ds.id });
  assert.equal(filed.status, 'pending');
  // The physical publish runs on the DECISION, as the deciding identity — here the owner,
  // who also holds the authority. Before the carve-out this request was undecidable.
  const decided = await call<{ decided: string; effect: { applied: string } }>(dana, 'decide_approval', {
    requestId: filed.requestId!,
    decision: 'approve',
  });
  assert.equal(decided.decided, 'approved');
  assert.match(decided.effect.applied, /Published/, `the physical publish ran: ${decided.effect.applied}`);
  const after = await call<{ tier: string }>(dana, 'get_dataset', { datasetId: ds.id });
  assert.equal(after.tier, 'asset', 'the tier flipped only after the publish succeeded');
});

// ================================ METRICS =====================================

test('matrix: a metric has NO independent rung — the refusal names the dataset to promote', async () => {
  __resetApprovals();
  // A legacy queued request of the shape the Metrics tab used to file. Approving it must
  // explain the coupling, not die on "unknown ladder artifactKind".
  const legacy = enqueue({
    kind: 'artifact_promote',
    title: 'Promote "revenue"',
    detail: 'legacy metric promotion request',
    agent: cara.id,
    domain: 'sales',
    requestedBy: cara.id,
    tool: 'metric_promote',
    payload: { artifactKind: 'metric', id: 'ds_x.revenue', name: 'revenue' },
    approverRole: 'domain_admin',
    scope: 'domain',
  });
  const e = await refusal(dana, 'decide_approval', { requestId: legacy.id, decision: 'approve' });
  assert.match(
    e.reason,
    /metric'?s? audience is its dataset'?s? audience/i,
    `the refusal must explain that a metric follows its dataset, got: ${e.reason}`,
  );
  assert.equal(getApproval(legacy.id)!.status, 'pending', 'an un-appliable request is left pending, never silently approved');
});

test('matrix: nothing files a metric promotion request any more', () => {
  for (const rel of ['app/api/metrics/[id]/promote/route.ts', 'tabs/metrics/mcp/metric-write-tools.ts']) {
    const code = src(rel);
    assert.ok(
      !/artifactKind:\s*'metric'/.test(code) || !/enqueue\(/.test(code),
      `${rel}: must not enqueue an artifactKind:'metric' request — nothing can apply it`,
    );
    assert.match(code, /audience is its dataset/, `${rel}: must carry the honest refusal that names the dataset`);
  }
});

// ===================== (c)+(f) THE UI SURFACES — TRIPWIRES ====================

test('tripwire: the agent-system promote button handles the filed-request response', () => {
  const code = src('tabs/agents/ui/SystemView.tsx');
  assert.match(code, /useApprovalNotifier/, 'SystemView must notify when a request is filed');
  assert.match(code, /\brequested\b/, 'SystemView must branch on the route’s { requested: true }');
});

test('tripwire: the software promote button cannot crash on a filed-request response', () => {
  const code = src('tabs/software/ui/SoftwareBuilder.tsx');
  assert.ok(
    !/body\.app\.visibility/.test(code),
    'an unguarded body.app.visibility turns "request filed" into a TypeError the user is shown',
  );
});

test('tripwire: the workflow publish button cannot lose a non-JSON failure, and reads `indexing`', () => {
  const code = src('tabs/knowledge/ui/WorkflowView.tsx');
  const at = code.indexOf('async function publish(');
  assert.ok(at > 0, 'WorkflowView must still have a publish() handler to pin');
  const publish = code.slice(at, at + 2600);
  assert.match(publish, /res\.json\(\)\.catch\(/, 'a bare res.json() drops a 502/HTML body with no message at all');
  assert.match(code, /indexing/, 'a published-but-unindexed workflow is invisible to every agent — say so');
});

test('tripwire: the approvals inbox refreshes after a failed decision, and the 502 carries the cause', () => {
  const route = src('app/api/governance/approvals/route.ts');
  assert.ok(
    !/error:\s*'Effect failed'\s*}/.test(route),
    'the effect’s real message must travel in `error`, not be flattened to the literal "Effect failed"',
  );
  const inbox = src('tabs/governance/ui/ApprovalsInbox.tsx');
  assert.match(inbox, /await load\(\)/, 'the inbox must re-read the queue so effect.applied becomes visible');
});

test('tripwire: the dataset promote button does not silently enable itself on an unknown gate', () => {
  const code = src('tabs/data/ui/DataBuilder.tsx');
  assert.match(code, /gateUnknown|could not read the promotion gate|gate could not be read/i, 'a swallowed gate fetch must be reported, not assumed green');
});
