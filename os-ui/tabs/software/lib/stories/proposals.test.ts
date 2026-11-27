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
const { decideProposal, listProposals, proposalRev, applyApproved, PROPOSAL_LIMITS } = await import('./proposals.ts');
const { posthocHook, posthocProposals, restoredToBase, storylessShas, unreviewedBlocksGoLive } = await import('./posthoc.ts');
type PosthocGit = import('./posthoc.ts').PosthocGit;
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

/** A fake domain repository: commits (parent, message, this app's tree as path → blob id). */
function fakeGit(commits: Record<string, { parent: string | null; message: string; tree: Record<string, string> }>): PosthocGit {
  const tree = async (_d: string, _s: string, ref: string) => new Map(Object.entries(commits[ref]?.tree ?? {}));
  return {
    appTree: tree,
    parentOf: async (_d, sha) => commits[sha]?.parent ?? null,
    range: async (d, s, fromSha, toSha) => {
      const out: { sha: string; message: string; appPaths: string[] }[] = [];
      let sha: string | null = toSha;
      while (sha && sha !== fromSha) {
        const c = commits[sha];
        if (!c) return { commits: out.reverse(), complete: false };
        const now = await tree(d, s, sha);
        const before = c.parent ? await tree(d, s, c.parent) : new Map<string, string>();
        const paths = [...new Set([...now.keys(), ...before.keys()])].filter((p) => now.get(p) !== before.get(p));
        out.push({ sha, message: c.message, appPaths: paths });
        sha = c.parent;
      }
      return { commits: out.reverse(), complete: sha === fromSha };
    },
  };
}

test('post-hoc: story files and code without an agreed story open two cards; Domain/Company blocked, My never; a revert is judged by git', async () => {
  const app = await seeded();
  const S = 'stories/EP-1-orders/US-1-submit.md';
  const P = 'src/app/page.tsx';
  const [A, B, C, D] = ['a', 'b', 'c', 'd'].map((x) => x.repeat(40));
  const git = fakeGit({
    [A]: { parent: null, message: 'seed', tree: { [P]: 'o1', [S]: 's1' } },
    // [US-1] names a story that exists but is still a DRAFT: not an agreed story, so the code is storyless.
    [B]: { parent: A, message: '[US-1] tweak things', tree: { [P]: 'o2', [S]: 's2' } },
    // "This reverts commit B" in the message, but the page is one character off the pre-push state: NOT a revert.
    [C]: { parent: B, message: `Revert "tweak"\n\nThis reverts commit ${B}.\n\nStory: US-1`, tree: { [P]: 'o3', [S]: 's2' } },
    // The page holds its pre-push blob again: reverted (judged from the trees, whatever the message says).
    [D]: { parent: C, message: 'put the page back\n\nStory: US-1', tree: { [P]: 'o1', [S]: 's2' } },
  });
  const push = async (sha: string, from: string, changed: { path: string; status: 'modified'; content: string }[]) =>
    posthocHook({ app: (await getAppByIdInternal(app.id))!, sha, fromSha: from, pusher: { id: 'dev1', name: 'Dev' } as never, messages: [], changed }, git);
  const notes = await push(B, A, [
    { path: `apps/${app.slug}/${S}`, status: 'modified', content: '---\nid: US-1\n---\n' },
    { path: `apps/${app.slug}/${P}`, status: 'modified', content: 'x' },
  ]);
  assert.equal(notes.length, 2);
  assert.match(notes.join('\n'), /change without a story/);
  const after = (await getAppByIdInternal(app.id))!;
  assert.equal(after.unreviewed!.length, 2);
  const cards = after.proposals!.filter((p) => p.posthoc);
  assert.deepEqual(cards.map((c) => c.classification).sort(), ['code-change', 'refine-story']);
  assert.ok(cards.every((c) => c.commitShas!.join() === B && c.source === 'git' && c.status === 'pending'));
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
  // US-1 becomes agreed (as an approved story card would make it), so later commits that name it are referenced.
  const rec = (await getAppByIdInternal(app.id))!;
  rec.stories!.index.stories[0].state = 'agreed';
  await persistApp(rec);
  const rejected = await decideProposal(app.id, codeCard.id, alice as never, 'reject', { reason: 'revert it' });
  assert.equal(rejected.proposal.needsRevert, true);
  assert.deepEqual((await getAppByIdInternal(app.id))!.unreviewed, [codeCard.id]);
  // A "This reverts commit" message over a one-character-different file clears nothing and opens nothing new.
  assert.deepEqual(await push(C, B, [{ path: `apps/${app.slug}/${P}`, status: 'modified', content: 'y' }]), []);
  assert.deepEqual((await getAppByIdInternal(app.id))!.unreviewed, [codeCard.id], 'a message is not a revert');
  // The tree back at its pre-push blob clears the rejected card.
  const cleared = await push(D, C, [{ path: `apps/${app.slug}/${P}`, status: 'modified', content: 'x' }]);
  assert.match(cleared.join('\n'), /reverted in git/);
  const done = (await getAppByIdInternal(app.id))!;
  assert.deepEqual(done.unreviewed, []);
  assert.equal(unreviewedBlocksGoLive(done, 'domain'), null);
  // A v1 app is not judged.
  const v1 = await createApp(alice as never, { name: 'Classic', template: 'nextjs-web' });
  assert.deepEqual(await posthocHook({ app: (await getAppByIdInternal(v1.id))!, sha: B, fromSha: A, pusher: { id: 'x' } as never, messages: [], changed: [{ path: `apps/${v1.slug}/src/a.ts`, status: 'modified', content: '' }] }, git), []);
});

test('post-hoc rules (pure): EVERY pushed commit needs an agreed story; an unreadable range is storyless; a revert must restore the pre-push blobs', () => {
  const agreed = new Set(['US-1']);
  const range = (complete: boolean, ...cs: [string, string, string[]][]) => ({ complete, commits: cs.map(([sha, message, appPaths]) => ({ sha, message, appPaths })) });
  assert.deepEqual(storylessShas(range(true, ['s1', 'Story: US-1', ['src/a.ts']], ['s2', 'fix', ['src/b.ts']], ['s3', 'docs', ['README.md']]), agreed), ['s2'], 'the head naming a story does not cover an earlier commit');
  assert.deepEqual(storylessShas(range(true, ['s1', '[US-99999] x', ['src/a.ts']]), agreed), ['s1'], 'a well-formed id the app does not have is no reference');
  assert.deepEqual(storylessShas(range(true, ['s1', 'Story: US-1', ['src/a.ts']]), agreed), []);
  assert.deepEqual(storylessShas(range(false, ['s1', 'Story: US-1', ['src/a.ts']]), agreed), ['s1'], 'not every commit could be read');
  assert.deepEqual(storylessShas(range(false, ['s1', 'docs', ['docs/a.md']]), agreed), [], 'docs only is never storyless');
  const cards = posthocProposals({ appId: 'a', sha: 's2', pusher: { id: 'x' }, changed: [{ path: 'src/a.ts', status: 'added', content: '' }], range: range(true, ['s1', 'Story: US-1', ['src/a.ts']]), agreed }, () => 'p', 't');
  assert.deepEqual(cards, [], 'every commit referenced: no card');
  const base = new Map([['src/a.ts', 'o1']]);
  assert.equal(restoredToBase(['src/a.ts'], base, new Map([['src/a.ts', 'o1']])), true);
  assert.equal(restoredToBase(['src/a.ts'], base, new Map([['src/a.ts', 'o9']])), false);
  assert.equal(restoredToBase(['src/new.ts'], base, new Map()), true, 'a file added by the change and removed again');
  assert.equal(restoredToBase([], base, base), false, 'nothing to compare proves nothing');
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

test('review fixes: rev required to approve/edit everywhere; proposing needs edit scope; open cards capped; never superseding another person; stale by spec sha; edits audited', async () => {
  const app = await seeded();
  REPLY = refineReply();
  const card = ((await (await propose(app.id, { text: 'r' })).json()) as { proposal: Card }).proposal;
  // rev is required for approve and edit at the lib and MCP doors too (the route already required it).
  await assert.rejects(decideProposal(app.id, card.id, alice as never, 'approve', {}), (e: Error & { status?: number }) => e.status === 400 && /rev/.test(e.message));
  await assert.rejects(tool('decide_requirement').call(alice as never, { appId: app.id, proposalId: card.id, decision: 'approve' }), (e: Error & { status?: number }) => e.status === 400);
  // An edit is audited (who, which card, which files).
  const w = card.change.writes[0];
  const edited = await decideProposal(app.id, card.id, alice as never, 'edit', { rev: card.rev, change: { writes: [{ path: w.path, content: w.content.replace('refused', 'refused politely') }], deletes: [], summary: 's' } });
  const { search } = await import('@core/policy/audit');
  const hit = search({ action: 'spec.proposal.edit', q: card.id });
  assert.equal(hit.length, 1);
  assert.equal(hit[0].actor, 'alice');
  // Someone edits the same story file after the card was classified: approving would overwrite it → 409 stale.
  await saveStory(app.id, alice as never, { id: 'US-1', epic: 'EP-1', title: 'Submit (renamed)', asA: 'rep', iWant: 'to submit', soThat: 'it ships', criteria: [{ id: 'AC-1', title: 'Valid order', given: ['a rep'], when: ['submit'], then: ['saved'] }] }, { source: 'ui' });
  await assert.rejects(decideProposal(app.id, card.id, alice as never, 'approve', { rev: edited.proposal.rev }), (e: Error & { status?: number; code?: string }) => e.status === 409 && e.code === 'proposal_stale');
  // Another editor's card on the same story does not supersede alice's.
  const rec = (await getAppByIdInternal(app.id))!;
  rec.visibility = 'Shared';
  await persistApp(rec);
  ACTING = dana;
  const danas = ((await (await propose(app.id, { text: 'r2' })).json()) as { proposal: Card; superseded: string[] });
  assert.deepEqual(danas.superseded, []);
  assert.equal((await listProposals(app.id, alice as never)).proposals.find((p) => p.id === card.id)!.status, 'pending');
  // Proposing needs the app's EDIT scope: a colleague who can only see it is refused before the model is called.
  ACTING = bob;
  const calls = MODEL_CALLS;
  assert.equal((await propose(app.id, { text: 'r3' })).status, 403);
  assert.equal(MODEL_CALLS, calls);
  // At most PROPOSAL_LIMITS.pending open cards per app.
  ACTING = alice;
  const full = (await getAppByIdInternal(app.id))!;
  const filler = Array.from({ length: PROPOSAL_LIMITS.pending }, (_, n) => ({ ...card, id: `prop_fill${n}`, requestedBy: `u${n}`, targetId: 'US-1' as const }));
  full.proposals = [...filler, ...(full.proposals ?? [])];
  await persistApp(full);
  const capped = await propose(app.id, { text: 'one more' });
  assert.equal(capped.status, 429);
});

test('the real push range: every commit between the old and the new head, oldest first, with this app’s changed paths', async () => {
  const app = await seeded();
  const { defaultPosthocGit } = await import('./posthoc.ts');
  const log = await gs.log(app.domain, { reposDir, limit: 10 });
  const [head, story, epic] = log;
  const r = await defaultPosthocGit.range(app.domain, app.slug, epic.parents[0], head.sha);
  assert.equal(r.complete, true);
  assert.deepEqual(r.commits.map((c) => c.sha), [epic.sha, story.sha, head.sha].slice(-r.commits.length));
  assert.ok(r.commits.some((c) => c.appPaths.some((p) => p.startsWith('stories/EP-1-'))), 'paths are app-relative');
  const partial = await defaultPosthocGit.range(app.domain, app.slug, 'f'.repeat(40), head.sha);
  assert.equal(partial.complete, false, 'an old head that is not in the history: the range is not complete');
  assert.equal(await defaultPosthocGit.parentOf(app.domain, head.sha), story.sha);
});
