/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder B - diff cards end to end: classify, approve/edit/reject, post-hoc cards from a push, go-live
 *             block, the build directive, and every door's refusals
 * USER STORY: As a business user I want a requirement to become a card that changes git only when someone who can edit
 *             the app approves it, a developer's push without a story to block Domain/Company go-live until reviewed,
 *             and code for a story to wait until the story is agreed and its tests exist.
 * ARCHITECTURE: The real route modules and the real store with a temp repos dir (createApp → real git commits); the
 *             session, the OPA decision and the model are stood in (separate components with their own tests). The MCP
 *             twins go through the W0 dispatch (`appBuilderTools`, `routeToAppBuilder`). Negative twins: flag off,
 *             unauthenticated, another domain, a colleague who cannot edit, OPA deny, stale rev, double decision,
 *             concurrent approvals, oversized body, classifier outage.
 */
import { test, before, after, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config as cfg } from '@core/kernel/config';

type Acting = { id: string; name: string; domains: string[]; allDomains: string[]; activeDomain: null; role: string };
let ACTING: Acting | null = null;
mock.module('@core/kernel/auth', {
  namedExports: {
    requireUser: async () => {
      if (!ACTING) throw Object.assign(new Error('Not authenticated'), { status: 401 });
      return ACTING;
    },
    currentUser: async () => ACTING,
  },
});
let OPA_ALLOWS = true;
mock.module('@core/infra/governed', {
  namedExports: { authorize: async () => ({ allowed: OPA_ALLOWS, policy: OPA_ALLOWS ? 'opa-allow' : 'opa-deny' }) },
});
let REPLY: string | Error = '';
let MODEL_CALLS = 0;
mock.module('@core/runtime/complete', {
  namedExports: {
    assistantComplete: async () => {
      MODEL_CALLS += 1;
      if (REPLY instanceof Error) throw REPLY;
      return { content: REPLY, model: 'stub' };
    },
  },
});

globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;
const { createApp, getAppByIdInternal, persistApp } = await import('../apps.ts');
const { saveEpic, saveStory, readSpec } = await import('./store.ts');
const { decideProposal, listProposals, proposalRev, applyApproved } = await import('./proposals.ts');
const { posthocHook, posthocProposals, unreviewedBlocksGoLive } = await import('./posthoc.ts');
const { appBuilderTools, routeToAppBuilder } = await import('../../mcp/app-builder/index.ts');
const gs = await import('@core/infra/git-store');

let reposDir = '';
let prior = '';
before(() => {
  reposDir = mkdtempSync(join(tmpdir(), 'os-repos-proposals-'));
  prior = cfg.reposDir;
  (cfg as { reposDir: string }).reposDir = reposDir;
});
after(() => {
  (cfg as { reposDir: string }).reposDir = prior;
  rmSync(reposDir, { recursive: true, force: true });
});

const mk = (id: string, domains: string[], role = 'creator'): Acting => ({ id, name: id[0].toUpperCase() + id.slice(1), domains, allDomains: domains, activeDomain: null, role });
const alice = mk('alice', ['sales']);
const bob = mk('bob', ['sales']);
const dana = mk('dana', ['sales'], 'domain_admin');
const mallory = mk('mallory', ['hr']);
beforeEach(() => {
  ACTING = alice;
  OPA_ALLOWS = true;
  MODEL_CALLS = 0;
  process.env.SOFTWARE_APP_BUILDER = 'on';
});
afterEach(() => { delete process.env.SOFTWARE_APP_BUILDER; });

const requirements = () => import(`../../../../app/api/apps/[id]/requirements/route.ts?${Math.random()}`);
const proposalsRoute = () => import(`../../../../app/api/apps/[id]/proposals/route.ts?${Math.random()}`);
const decideRoute = () => import(`../../../../app/api/apps/[id]/proposals/[pid]/route.ts?${Math.random()}`);
const propose = async (id: string, body: unknown) =>
  (await requirements()).POST(new Request(`http://x/api/apps/${id}/requirements`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }), { params: Promise.resolve({ id }) });
const list = async (id: string, qs = '') => (await proposalsRoute()).GET(new Request(`http://x/api/apps/${id}/proposals${qs}`), { params: Promise.resolve({ id }) });
const decide = async (id: string, pid: string, body: unknown) =>
  (await decideRoute()).POST(new Request(`http://x/api/apps/${id}/proposals/${pid}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }), { params: Promise.resolve({ id, pid }) });

/** A v2 app with EP-1 and a DRAFT US-1 (one criterion). */
async function seeded() {
  const app = await createApp(alice as never, { name: `Desk ${Math.random().toString(36).slice(2, 7)}`, template: 'nextjs-web', templateVersion: 2 });
  await saveEpic(app.id, alice as never, { title: 'Orders' }, { source: 'ui' });
  await saveStory(app.id, alice as never, { epic: 'EP-1', title: 'Submit', asA: 'rep', iWant: 'to submit', soThat: 'it ships', criteria: [{ title: 'Valid order', given: ['a rep'], when: ['submit'], then: ['saved'] }] }, { source: 'ui' });
  return app;
}
const refineReply = (extra = 'Empty order refused') =>
  JSON.stringify({
    classification: 'refine-story',
    targetId: 'US-1',
    rationale: 'It adds a rule to submitting.',
    confidence: 0.9,
    story: { title: 'Submit', asA: 'rep', iWant: 'to submit', soThat: 'it ships', criteria: [{ id: 'AC-1', title: 'Valid order', given: ['a rep'], when: ['submit'], then: ['saved'] }, { title: extra, given: ['a rep'], when: ['no lines'], then: ['refused'] }] },
  });
type Card = { id: string; rev: string; status: string; classification: string; targetId: string; change: { writes: { path: string; content: string }[] } };

test('chat: a requirement becomes a pending card; git does not move until it is approved; approve = one commit (OS-Proposal), story agreed', async () => {
  const app = await seeded();
  const head0 = (await gs.log(app.domain, { reposDir, limit: 1 }))[0].sha;
  REPLY = refineReply();
  const r = await propose(app.id, { text: 'An order without lines must be refused' });
  assert.equal(r.status, 200);
  const card = ((await r.json()) as { proposal: Card }).proposal;
  assert.deepEqual([card.status, card.classification, card.targetId], ['pending', 'refine-story', 'US-1']);
  assert.equal((await gs.log(app.domain, { reposDir, limit: 1 }))[0].sha, head0, 'proposing changes nothing in git');
  const listed = (await (await list(app.id)).json()) as { proposals: Card[]; canDecide: boolean; unreviewed: string[]; lights: Record<string, { light: string }> };
  assert.equal(listed.proposals[0].rev, card.rev);
  assert.equal(listed.canDecide, true);
  assert.equal(listed.lights['US-1'].light, 'untested');
  const ok = await decide(app.id, card.id, { decision: 'approve', rev: card.rev });
  assert.equal(ok.status, 200);
  const out = (await ok.json()) as { proposal: Card; commit: { sha: string; changed: boolean }; stories: string[] };
  assert.equal(out.proposal.status, 'approved');
  assert.deepEqual(out.stories, ['US-1']);
  const head = (await gs.log(app.domain, { reposDir, limit: 1 }))[0];
  assert.equal(head.sha, out.commit.sha);
  assert.equal(head.trailers['OS-Proposal'], card.id);
  assert.equal(head.trailers['OS-Source'], 'chat');
  assert.match(head.subject, /\[US-1\]/, 'the commit names its story');
  assert.equal(head.author.name, 'Alice');
  const { spec } = await readSpec(app.id, alice as never);
  assert.deepEqual(spec.stories.map((s) => [s.id, s.state, s.criteria.map((c) => c.id).join()]), [['US-1', 'agreed', 'AC-1,AC-2']]);
  // A decided card cannot be decided again.
  const again = await decide(app.id, card.id, { decision: 'reject', rev: out.proposal.rev ?? card.rev, reason: 'x' });
  assert.equal(again.status, 409);
});

test('edit with rev keeps it pending with a new rev; the old rev is 409; reject needs a reason', async () => {
  const app = await seeded();
  REPLY = refineReply();
  const card = ((await (await propose(app.id, { text: 'r' })).json()) as { proposal: Card }).proposal;
  const w = card.change.writes[0];
  const edited = await decide(app.id, card.id, { decision: 'edit', rev: card.rev, change: { writes: [{ path: w.path, content: w.content.replace('refused', 'refused with a message') }], deletes: [], summary: 'edited' } });
  assert.equal(edited.status, 200);
  const e = ((await edited.json()) as { proposal: Card }).proposal;
  assert.equal(e.status, 'pending');
  assert.notEqual(e.rev, card.rev);
  assert.equal((await decide(app.id, card.id, { decision: 'approve', rev: card.rev })).status, 409, 'someone edited it since');
  const broken = await decide(app.id, card.id, { decision: 'edit', rev: e.rev, change: { writes: [{ path: w.path, content: 'not a story' }], deletes: [], summary: 's' } });
  assert.equal(broken.status, 422);
  const outside = await decide(app.id, card.id, { decision: 'edit', rev: e.rev, change: { writes: [{ path: 'src/app/page.tsx', content: 'x' }], deletes: [], summary: 's' } });
  assert.equal(outside.status, 400);
  assert.equal((await decide(app.id, card.id, { decision: 'reject', rev: e.rev })).status, 400);
  const rej = await decide(app.id, card.id, { decision: 'reject', rev: e.rev, reason: 'Not now' });
  assert.equal(((await rej.json()) as { proposal: Card & { reason: string } }).proposal.status, 'rejected');
});

test('a newer card on the same story supersedes the pending one; concurrent approvals: exactly one wins', async () => {
  const app = await seeded();
  REPLY = refineReply('first');
  const first = ((await (await propose(app.id, { text: 'a' })).json()) as { proposal: Card }).proposal;
  REPLY = refineReply('second');
  const second = ((await (await propose(app.id, { text: 'b' })).json()) as { proposal: Card; superseded: string[] });
  assert.deepEqual(second.superseded, [first.id]);
  const all = (await listProposals(app.id, alice as never)).proposals;
  assert.equal(all.find((p) => p.id === first.id)!.status, 'superseded');
  const [a, b] = await Promise.all([
    decide(app.id, second.proposal.id, { decision: 'approve', rev: second.proposal.rev }),
    decide(app.id, second.proposal.id, { decision: 'approve', rev: second.proposal.rev }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
});

test('approval re-numbers a new story whose id was taken meanwhile (ids stay server-assigned)', () => {
  const base = {
    files: [{ path: 'stories/EP-1-o/_epic.md', content: 'e' }, { path: 'stories/EP-1-o/US-2-other.md', content: 's' }],
    spec: { epics: [{ id: 'EP-1', path: 'stories/EP-1-o/_epic.md' }], stories: [{ id: 'US-2', path: 'stories/EP-1-o/US-2-other.md' }] },
  };
  const story = '---\nid: US-2\nepic: EP-1\ntitle: Cancel\nstate: draft\n---\nAs a **rep** I want **to cancel** so that **stock frees up**.\n\n## Acceptance criteria\n\n### AC-1 Cancel\n- Given an order\n- When cancelled\n- Then it is gone\n';
  const out = applyApproved(base, { writes: [{ path: 'stories/EP-1-o/US-2-cancel.md', content: story }], deletes: [], summary: '' }, { epics: [], stories: [] });
  assert.deepEqual(out.stories, ['US-3']);
  const f = out.files.find((x) => x.path.startsWith('stories/EP-1-o/US-3'))!;
  assert.match(f.content, /id: US-3/);
  assert.match(f.content, /state: agreed/);
});

test('post-hoc: a push of a story file and storyless code opens two cards, blocks Domain/Company (never My); approve/revert clears', async () => {
  const app = await seeded();
  const rec = (await getAppByIdInternal(app.id))!;
  const sha = 'f'.repeat(40);
  const storyPath = `apps/${app.slug}/stories/EP-1-orders/US-1-submit.md`;
  const notes = await posthocHook({
    app: rec,
    sha,
    pusher: { id: 'dev1', name: 'Dev' } as never,
    messages: ['tweak things'],
    changed: [
      { path: storyPath, status: 'modified', content: '---\nid: US-1\n---\n' },
      { path: `apps/${app.slug}/src/app/page.tsx`, status: 'modified', content: 'x' },
    ],
  });
  assert.equal(notes.length, 2);
  assert.match(notes.join('\n'), /change without a story/);
  const after = (await getAppByIdInternal(app.id))!;
  assert.equal(after.unreviewed!.length, 2);
  const cards = after.proposals!.filter((p) => p.posthoc);
  assert.deepEqual(cards.map((c) => c.classification).sort(), ['code-change', 'refine-story']);
  assert.ok(cards.every((c) => c.commitShas![0] === sha && c.source === 'git' && c.status === 'pending'));
  assert.match(unreviewedBlocksGoLive(after, 'domain')!, /unreviewed changes/);
  assert.match(unreviewedBlocksGoLive(after, 'company')!, /the company/);
  assert.equal(unreviewedBlocksGoLive(after, 'my'), null, 'My scope is never blocked');
  // Approving the story card commits nothing (it is already in git) and clears it.
  const head0 = (await gs.log(app.domain, { reposDir, limit: 1 }))[0].sha;
  const storyCard = cards.find((c) => c.classification === 'refine-story')!;
  const codeCard = cards.find((c) => c.classification === 'code-change')!;
  const approved = await decideProposal(app.id, storyCard.id, alice as never, 'approve', { rev: proposalRev(storyCard) });
  assert.equal(approved.commit, undefined);
  assert.equal((await gs.log(app.domain, { reposDir, limit: 1 }))[0].sha, head0);
  // Rejecting the code card keeps the app unreviewed until the revert lands.
  const rejected = await decideProposal(app.id, codeCard.id, alice as never, 'reject', { reason: 'revert it' });
  assert.equal(rejected.proposal.needsRevert, true);
  assert.deepEqual((await getAppByIdInternal(app.id))!.unreviewed, [codeCard.id]);
  await posthocHook({ app: (await getAppByIdInternal(app.id))!, sha: 'e'.repeat(40), pusher: { id: 'dev1' } as never, messages: [`Revert "tweak"\n\nThis reverts commit ${sha}.\n\nStory: US-1`], changed: [{ path: `apps/${app.slug}/src/app/page.tsx`, status: 'modified', content: 'y' }] });
  const cleared = (await getAppByIdInternal(app.id))!;
  assert.deepEqual(cleared.unreviewed, []);
  assert.equal(unreviewedBlocksGoLive(cleared, 'domain'), null);
  // A push WITH a story reference opens nothing; a v1 app is not judged.
  assert.deepEqual(posthocProposals({ appId: app.id, sha, pusher: { id: 'x' } as never, messages: ['Story: US-1'], changed: [{ path: 'src/a.ts', status: 'added', content: '' }] }, () => 'p', 't'), []);
  const v1 = await createApp(alice as never, { name: 'Classic', template: 'nextjs-web' });
  assert.deepEqual(await posthocHook({ app: (await getAppByIdInternal(v1.id))!, sha, pusher: { id: 'x' } as never, messages: [], changed: [{ path: `apps/${v1.slug}/src/a.ts`, status: 'added', content: '' }] }), []);
});

test('NEGATIVE doors: flag off 403 app_builder_disabled before the session; 401; another domain 404; non-editor 403; OPA deny 403; 413; 503', async () => {
  const app = await seeded();
  REPLY = refineReply();
  const card = ((await (await propose(app.id, { text: 'r' })).json()) as { proposal: Card }).proposal;
  delete process.env.SOFTWARE_APP_BUILDER;
  ACTING = null;
  for (const res of [await propose(app.id, { text: 'x' }), await list(app.id), await decide(app.id, card.id, { decision: 'approve', rev: card.rev })]) {
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { code: string }).code, 'app_builder_disabled');
  }
  process.env.SOFTWARE_APP_BUILDER = 'on';
  assert.equal((await propose(app.id, { text: 'x' })).status, 401);
  ACTING = mallory;
  assert.equal((await list(app.id)).status, 404);
  assert.equal((await decide(app.id, card.id, { decision: 'approve', rev: card.rev })).status, 404);
  const rec = (await getAppByIdInternal(app.id))!;
  rec.visibility = 'Shared';
  await persistApp(rec);
  ACTING = bob;
  assert.equal(((await (await list(app.id)).json()) as { canDecide: boolean }).canDecide, false);
  assert.equal((await decide(app.id, card.id, { decision: 'approve', rev: card.rev })).status, 403, 'seeing is not editing');
  ACTING = dana;
  OPA_ALLOWS = false;
  assert.equal((await decide(app.id, card.id, { decision: 'approve', rev: card.rev })).status, 403);
  OPA_ALLOWS = true;
  ACTING = alice;
  assert.equal((await propose(app.id, { text: 'x'.repeat(17 * 1024) })).status, 413);
  assert.equal((await propose(app.id, { text: '' })).status, 400);
  assert.equal((await decide(app.id, card.id, { decision: 'approve' })).status, 400, 'rev is required');
  assert.equal((await decide(app.id, card.id, { decision: 'merge', rev: card.rev })).status, 400);
  REPLY = new Error('gateway down');
  const down = await propose(app.id, { text: 'x' });
  assert.equal(down.status, 503);
  assert.equal(((await down.json()) as { code: string }).code, 'classifier_unavailable');
  REPLY = 'no json at all';
  assert.equal(((await (await propose(app.id, { text: 'x' })).json()) as { code: string }).code, 'classifier_invalid_output');
  // An in-domain domain admin of a Shared app may approve (anyone who can edit the app).
  ACTING = dana;
  assert.equal((await decide(app.id, card.id, { decision: 'approve', rev: card.rev })).status, 200);
});

// ------------------------------------------------------------------- MCP twins ---
const tool = (name: string) => appBuilderTools.find((t) => t.name === name)!;

test('MCP: propose → build_software refuses the draft → decide → build directive with tests first → push needs story and tests → verify', async () => {
  const app = await seeded();
  await assert.rejects(routeToAppBuilder('build_software', alice as never, { appId: app.id, target: { storyId: 'US-1', epicId: 'EP-1' } }), (e: Error & { status?: number }) => e.status === 409 && /draft/.test(e.message));
  REPLY = refineReply();
  const p = (await tool('propose_requirement').call(alice as never, { appId: app.id, text: 'refuse empty orders' })) as { proposal: Card };
  await assert.rejects(routeToAppBuilder('build_software', alice as never, { appId: app.id, story: 'US-1' }), (e: Error & { status?: number }) => e.status === 409);
  const d = (await tool('decide_requirement').call(alice as never, { appId: app.id, proposalId: p.proposal.id, decision: 'approve', rev: p.proposal.rev })) as { proposal: Card };
  assert.equal(d.proposal.status, 'approved');
  assert.equal((await gs.log(app.domain, { reposDir, limit: 1 }))[0].trailers['OS-Source'], 'mcp');
  const b = (await routeToAppBuilder('build_software', alice as never, { appId: app.id, story: 'US-1' }))!.result as { stories: { criteria: { ref: string }[] }[]; testsFirst: { path: string; content: string }[]; taggingRule: string };
  assert.deepEqual(b.stories[0].criteria.map((c) => c.ref), ['US-1/AC-1', 'US-1/AC-2']);
  assert.deepEqual(b.testsFirst.map((f) => f.path), ['tests/criteria/US-1.test.ts']);
  assert.match(b.taggingRule, /\[US-3\/AC-2\]/);
  // push_app_files on a v2 app: code needs a story, and that story's tests first.
  await assert.rejects(routeToAppBuilder('push_app_files', alice as never, { appId: app.id, files: [{ path: 'src/lib/x.ts', content: 'export const x = 1;\n' }] }), (e: Error & { status?: number }) => e.status === 409 && /name the story/.test(e.message));
  await assert.rejects(routeToAppBuilder('push_app_files', alice as never, { appId: app.id, story: 'US-1', files: [{ path: 'src/lib/x.ts', content: 'export const x = 1;\n' }] }), (e: Error & { status?: number }) => e.status === 409 && /test first/.test(e.message));
  const v = (await routeToAppBuilder('verify_software', alice as never, { appId: app.id }))!.result as { stories: Record<string, { light: string; status: string }>; untested: string[] };
  assert.deepEqual(v.stories['US-1'], { ...v.stories['US-1'], light: 'untested', status: 'agreed' });
  assert.deepEqual(v.untested, ['US-1/AC-1', 'US-1/AC-2']);
  const l = (await tool('list_requirement_proposals').call(alice as never, { appId: app.id, status: 'approved' })) as { proposals: Card[] };
  assert.deepEqual(l.proposals.map((x) => x.id), [p.proposal.id]);
  await assert.rejects(tool('propose_requirement').call(mallory as never, { appId: app.id, text: 'x' }), (e: Error & { status?: number }) => e.status === 404);
  delete process.env.SOFTWARE_APP_BUILDER;
  for (const name of ['propose_requirement', 'decide_requirement', 'list_requirement_proposals']) {
    await assert.rejects(tool(name).call(alice as never, { appId: app.id }), (e: Error & { code?: string }) => e.code === 'app_builder_disabled', name);
  }
  assert.equal(await routeToAppBuilder('build_software', alice as never, { appId: app.id }), null, 'flag off: today’s path');
});
