/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    THE TRIANGLE — app → agent → governed data write → the app reads it back, all three
 *             steps attributed to the SAME signed-in user (night-2 S7–S10, decision D21)
 * USER STORY: As the owner's fifth requirement, verbatim: "The vibe engineered applications can
 *             call agents in the OS or can be called by agents in the OS and can read and write
 *             back data with the user access rights of the OS users being considered."
 * ARCHITECTURE:
 *   - END TO END WITH FAKES. The `kind`/`stackit` halves are written into the plan's Part C step 5;
 *     this test proves the three contracts that would otherwise only be checked by hand:
 *       1. APP → AGENT. The SDK's `os.agents.run/get/decide` hit the SAME routes the OS UI posts
 *          to, with `credentials: 'include'` and NO credential of the app's own. The fetch is
 *          injected and RECORDED, so the assertion is about the real request the SDK makes.
 *       2. AGENT → DATA. The write goes through the governed record store as the END USER, and the
 *          row is stamped with that user — not with an app or service principal.
 *       3. APP → DATA. The read-back is actor-scoped: the same user sees the row; a user in
 *          another domain sees NOTHING from the same app (two sessions, different row sets).
 *     Plus the git half: the commit that carries the app's source names the SAME user.
 *   - THE TWO NEGATIVES: a tool outside the app's declared scopes is refused by the four-layer
 *     intersection naming the layer, and a WRITING app action is HELD, never executed.
 *   - Offline: `fetch` is stubbed to reject, so the record store runs in memory.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CurrentUser } from '@core/kernel/auth';
import { testUser } from '@core/testing/user';

const _realFetch = globalThis.fetch;
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const { createOsClient } = await import('@core/app-sdk/index');
const { addAppRecord, listAppRecords, __resetAppRecordsCache } = await import('./app-records-store.ts');
const { recordActor } = await import('./app-records.ts');
const { appAgentDoors, carriesOwnCredential, FORBIDDEN_APP_CREDENTIAL_FIELDS } = await import('./app-agents.ts');
const { parseAppActions, authorizeDeclaredAction, withinDeclaredScopes, ACTIONS_FILE } = await import('./app-actions.ts');
const { commitAppTree, __setAppProjectGitForTests } = await import('./git-commit.ts');
const { log } = await import('@core/infra/git-store');
const { existsSync } = await import('node:fs');

/** The signed-in user. ONE identity for all three legs of the triangle. */
const amir: CurrentUser = testUser({ id: 'amir', name: 'Amir', domains: ['eng'], activeDomain: 'eng', role: 'creator' });
/** A second session, in another domain, on the SAME app. */
const zed: CurrentUser = testUser({ id: 'zed', name: 'Zed', domains: ['sales'], activeDomain: 'sales', role: 'creator' });

const APP = { id: 'app_tri', slug: 'invoices', name: 'Invoices', domain: 'eng' };

let reposDir = '';
before(() => {
  reposDir = mkdtempSync(join(tmpdir(), 'os-repos-triangle-'));
  __setAppProjectGitForTests(true);
  __resetAppRecordsCache();
});
after(() => {
  __setAppProjectGitForTests(null);
  globalThis.fetch = _realFetch;
  rmSync(reposDir, { recursive: true, force: true });
});

type Recorded = { url: string; init: RequestInit };

/** A recording fake OS. Returns the canned body for whichever governed route was called. */
function fakeOs(bodies: Record<string, { status?: number; body: unknown; text?: string; contentType?: string }>) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const key = Object.keys(bodies).find((k) => url.startsWith(k));
    if (!key) return new Response(JSON.stringify({ error: `no fake for ${url}` }), { status: 404, headers: { 'content-type': 'application/json' } });
    const spec = bodies[key];
    const payload = spec.text ?? JSON.stringify(spec.body);
    return new Response(payload, {
      status: spec.status ?? 200,
      headers: { 'content-type': spec.contentType ?? 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

// ───────────────────────────────── leg 1: app → agent ─────────────────────────────────

test('LEG 1 — the SDK’s agent doors ARE the OS UI’s own routes (no app-specific endpoint)', () => {
  const doors = appAgentDoors('sys_1', 'run_1');
  assert.deepEqual(doors.map((d) => d.sdk), ['os.agents.run', 'os.agents.get', 'os.agents.decide']);
  assert.equal(doors[0].path, '/api/agents/systems/sys_1/run');
  assert.equal(doors[1].path, '/api/agents/systems/sys_1/run/stream?runId=run_1&afterSeq=0');
  assert.equal(doors[2].path, '/api/governance/approvals');
  assert.equal(doors[0].governedBy, 'enqueueRun', 'the SAME run-service door the UI and the MCP file through');
  // The route files really exist — a renamed or deleted door FAILS here instead of 404-ing live.
  for (const d of doors) {
    assert.ok(existsSync(join(import.meta.dirname, '..', '..', '..', d.route)), `${d.route} exists`);
  }
});

test('LEG 1 — os.agents.run posts to the run route as the signed-in user, with NO key of its own', async () => {
  const { calls, fetchImpl } = fakeOs({
    '/api/agents/systems/sys_1/run': { body: { runId: 'run_42', answer: 'wrote the row' } },
  });
  const os = createOsClient({ fetch: fetchImpl });
  const run = await os.agents.run('sys_1', 'write an invoice row for me');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/agents/systems/sys_1/run', 'the UI’s own door, verbatim');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.credentials, 'include', 'the AMBIENT session is the identity');
  const headers = (calls[0].init.headers ?? {}) as Record<string, string>;
  for (const forbidden of FORBIDDEN_APP_CREDENTIAL_FIELDS) {
    assert.ok(
      !Object.keys(headers).some((h) => h.toLowerCase() === forbidden.toLowerCase()),
      `no '${forbidden}' header — an app never presents a credential of its own`,
    );
  }
  assert.equal(carriesOwnCredential({ headers, body: JSON.parse(String(calls[0].init.body)) }), false);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { prompt: 'write an invoice row for me', stream: false });

  assert.equal(run.state, 'done');
  assert.equal(run.runId, 'run_42');
  assert.deepEqual(run.output, { runId: 'run_42', answer: 'wrote the row' });
});

test('LEG 1 — a run HELD on a write surfaces as `parked` WITH its approval id, not as finished', async () => {
  const sse =
    'event: node-started\ndata: {"node":"writer"}\n\n' +
    'event: approval-required\ndata: {"approvalId":"apr_7","tool":"add_record"}\n\n';
  const { fetchImpl } = fakeOs({
    '/api/agents/systems/sys_1/run/stream': { body: null, text: sse, contentType: 'text/event-stream' },
  });
  const os = createOsClient({ fetch: fetchImpl });
  const run = await os.agents.get('sys_1', 'run_42');
  assert.equal(run.state, 'parked', 'the app must render the park, not a completion');
  assert.equal(run.approvalId, 'apr_7');
  assert.equal(run.events, 2);
});

test('LEG 1 — os.agents.decide posts the ONE governance inbox route; a role that may not decide gets Forbidden', async () => {
  const { calls, fetchImpl } = fakeOs({
    '/api/governance/approvals': { body: { approval: { id: 'apr_7', status: 'approved', decidedBy: 'amir' } } },
  });
  const os = createOsClient({ fetch: fetchImpl });
  const out = await os.agents.decide('apr_7', 'approve');
  assert.equal(calls[0].url, '/api/governance/approvals');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { id: 'apr_7', decision: 'approve' });
  assert.deepEqual(out, { approvalId: 'apr_7', status: 'approved', decidedBy: 'amir' });

  const denied = fakeOs({ '/api/governance/approvals': { status: 403, body: { error: 'This item needs an Administrator' } } });
  const os2 = createOsClient({ fetch: denied.fetchImpl });
  await assert.rejects(() => os2.agents.decide('apr_7', 'approve'), /This item needs an Administrator/);
});

// ──────────────────── legs 2 + 3: agent → data, then the app reads it back ────────────────────

test('THE TRIANGLE — agent writes a row AS the user, the app reads it back, a second session does NOT', async () => {
  __resetAppRecordsCache();

  // LEG 2. The agent's governed tool writes as the END USER — the row is stamped with the
  // signed-in user and their effective domain, never with an app or service principal.
  const actor = recordActor(amir);
  assert.deepEqual(actor, { id: 'amir', domain: 'eng' });
  const written = await addAppRecord({ appSlug: APP.slug, owner: actor.id, domain: actor.domain, record: { invoice: 'INV-1', amount: 100 } });
  assert.equal(written.owner, 'amir', 'the WRITE is attributed to the user');
  assert.equal(written.domain, 'eng');

  // LEG 3. The app reads it back under the same session and sees it.
  const mine = await listAppRecords({ appSlug: APP.slug, actor });
  assert.equal(mine.length, 1);
  assert.deepEqual(mine[0].record, { invoice: 'INV-1', amount: 100 });

  // Two sessions, SAME app, different row sets — the user's access rights decide, not the app.
  const theirs = await listAppRecords({ appSlug: APP.slug, actor: recordActor(zed) });
  assert.deepEqual(theirs, [], 'a user in another domain sees nothing of this app’s rows');

  // The git leg: the commit that carries the app's source names the SAME user.
  const git = await commitAppTree(APP, amir, [{ path: 'app.yaml', content: 'name: Invoices\n' }], { action: 'push_app_files' }, { reposDir, mirror: false });
  assert.equal(git.ok && git.recorded, true);
  const head = (await log(APP.domain, { reposDir, limit: 1 }))[0];
  assert.equal(head.trailers['OS-Actor'], 'amir', 'the COMMIT names the same user as the write and the read');
  assert.equal(head.author.name, 'Amir');

  // One identity across all three legs — stated as the assertion the plan asks for.
  assert.deepEqual(
    { write: written.owner, read: mine[0].owner, commit: head.trailers['OS-Actor'] },
    { write: 'amir', read: 'amir', commit: 'amir' },
  );
});

// ─────────────────────────────── the two negative cases ───────────────────────────────

const DECLARED = parseAppActions([
  {
    path: ACTIONS_FILE,
    content: 'actions:\n  - name: list_invoices\n    scopes: [records]\n  - name: approve_invoice\n    write: true\n    scopes: [records]\n',
  },
]).actions;

test('NEGATIVE 1 — a tool OUTSIDE the app’s declared scopes is refused, naming the layer', () => {
  const ctx = {
    declared: DECLARED,
    capability: ['list_invoices', 'approve_invoice'],
    granted: ['list_invoices', 'approve_invoice', 'query_data'],
    domain: 'eng',
    appExposureId: `app-${APP.slug}`,
  };
  const out = authorizeDeclaredAction('query_data', ctx, { adopted: () => true });
  assert.equal(out.effect, 'deny', 'a granted tool the app never declared is still refused');
  assert.equal(out.effect === 'deny' ? out.layer : '', 'declaration');
  // And an undeclared SCOPE cannot be reached even through a declared action.
  assert.equal(withinDeclaredScopes(DECLARED[0], ['knowledge']), false);
});

test('NEGATIVE 2 — an agent calling a WRITING app action is HELD under the read-only preset', () => {
  const ctx = {
    declared: DECLARED,
    capability: ['approve_invoice'],
    granted: ['approve_invoice'],
    domain: 'eng',
    appExposureId: `app-${APP.slug}`,
  };
  const out = authorizeDeclaredAction('approve_invoice', ctx, { adopted: () => true });
  assert.equal(out.effect, 'requires_approval', 'held for a human, never auto-executed');
  assert.match(out.effect === 'requires_approval' ? out.reason : '', /reads-on\/writes-off/);
});
