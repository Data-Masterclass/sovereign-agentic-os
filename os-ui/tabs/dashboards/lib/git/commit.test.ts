/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        dashboards
 * FEATURE:    Every dashboard write is a git commit, authored as the actor (D8, D-R3.1, G1)
 * USER STORY: As a user I want two saves to be two commits in my domain's repository, each naming
 *             me, the action and whether it came from the UI or the MCP — and as a maintainer I
 *             want a new writer that does NOT commit to fail this suite.
 * ARCHITECTURE:
 *   - Drives a REAL bare repository in a temp dir, the pattern `core/infra/git-store-subtree.test.ts`
 *     and `tabs/agents/lib/git/commit.test.ts` established. No cluster, no network, no mirror.
 *   - The mutator ENUMERATION test is the gate that makes "every mutation is a git commit"
 *     non-optional: it lists every exported writer in `lib/store.ts` and fails on one that is not
 *     classified, so adding a writer forces a decision rather than a silent gap.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendTrailers, commitMessage, log, readBlob, listTree } from '@core/infra/git-store';
import { runWithSurface } from '@core/infra/request-surface';
import {
  AREA,
  awaitDashboardCommits,
  commitDashboards,
  dashboardCommitMessage,
  installDashboardCommitHook,
  __setDashboardProjectGitForTests,
} from '@tabs/dashboards/lib/git/commit';
import { DASHBOARDS_PREFIX } from '@tabs/dashboards/lib/git/generate';
import { snapshotDashboard, type SnapshotDashboard, type StoredDashboard } from '@tabs/dashboards/lib/git/snapshot';
import { emitDashboardChange, __resetDashboardListeners } from '@tabs/dashboards/lib/dashboard-events';

const ACTOR = { id: 'alex@datamasterclass.com', name: 'Alexander Borek', email: 'alex@datamasterclass.com' };
/** The ADMIN who performs a cross-domain move (`tabs/admin/lib/domain-move.ts` threads `user.id`). */
const ADMIN = { id: 'sara@datamasterclass.com', name: 'Sara Admin', email: 'sara@datamasterclass.com' };

function stored(id: string, name: string, tier: StoredDashboard['tier'] = 'domain'): StoredDashboard {
  return {
    id,
    owner: ACTOR.id,
    tier,
    domain: 'analytics',
    spec: { name, view: 'Orders', charts: [{ name: 'Total revenue', vizType: 'big_number', metrics: ['Orders.revenue'] }] },
  };
}

function snap(...recs: StoredDashboard[]): SnapshotDashboard[] {
  return recs.map((r) => snapshotDashboard(r, { memberRef: () => 'metric:met_rev' }));
}

function tmpRepos(): string {
  return mkdtempSync(join(tmpdir(), 'os-dash-git-'));
}

test('the commit subject + trailers are BYTE-IDENTICAL to the kernel’s own commitMessage', () => {
  // `core/infra/git-store.ts` types `area` as 'data' | 'agents' and is owned by two other streams
  // tonight, so this tab composes the same string itself. This test is what keeps the two in step:
  // if the kernel's format changes, it fails here instead of drifting silently.
  const input = {
    domain: 'analytics',
    action: 'create dashboard',
    object: 'sales-overview',
    objectId: 'dash_1 (Sales Overview)',
    surface: 'mcp:create_dashboard',
    requestId: 'req_abc',
  };
  const kernel = commitMessage({ area: 'data', ...input }).replace(/^data\(/, `${AREA}(`);
  assert.equal(dashboardCommitMessage(input), kernel);
  assert.match(dashboardCommitMessage(input), /^dashboards\(analytics\): create dashboard sales-overview — via mcp:create_dashboard\n/);
  assert.match(dashboardCommitMessage(input), /OS-Object: dash_1 \(Sales Overview\)/);
});

test('appendTrailers is the kernel’s, so the trailer block cannot diverge', () => {
  // Composed with the store's own helper rather than string-concatenated here, so a change to the
  // trailer convention reaches dashboards commits without this tab being edited.
  const out = appendTrailers('subject', { 'OS-Action': 'x' });
  assert.ok(out.startsWith('subject'), out);
  assert.ok(out.includes('OS-Action: x'), out);
});

test('the flag off ⇒ no commit at all (and no repository is created)', async () => {
  const reposDir = tmpRepos();
  try {
    __setDashboardProjectGitForTests(false);
    assert.equal(await commitDashboards('analytics', ACTOR, { action: 'create dashboard' }, { reposDir, captured: snap(stored('d1', 'A')) }), null);
    // `log` initialises an empty bare repo on first read, so "no commit" is an EMPTY history —
    // not an error. The point is that nothing was written.
    assert.deepEqual(await log('analytics', { reposDir }), []);
  } finally {
    __setDashboardProjectGitForTests(null);
    rmSync(reposDir, { recursive: true, force: true });
  }
});

test('D8 — two saves are TWO commits, each authored as the actor, with the OS trailers', async () => {
  const reposDir = tmpRepos();
  try {
    __setDashboardProjectGitForTests(true);
    const first = await commitDashboards(
      'analytics',
      ACTOR,
      { action: 'create dashboard', object: 'a', objectId: 'd1 (A)', surface: 'ui:/api/dashboards/build', requestId: 'req_1' },
      { reposDir, captured: snap(stored('d1', 'A')) },
    );
    assert.ok(first?.changed, 'the first save must commit');
    const second = await commitDashboards(
      'analytics',
      ACTOR,
      { action: 'create dashboard', object: 'b', objectId: 'd2 (B)', surface: 'mcp:create_dashboard', requestId: 'req_2' },
      { reposDir, captured: snap(stored('d1', 'A'), stored('d2', 'B')) },
    );
    assert.ok(second?.changed, 'the second save must commit too');
    assert.notEqual(first!.sha, second!.sha);

    const entries = await log('analytics', { reposDir });
    assert.equal(entries.length, 2, 'two writes ⇒ two commits');
    const [newest, oldest] = entries;
    assert.equal(newest.author.email, ACTOR.email);
    assert.match(newest.message, /^dashboards\(analytics\): create dashboard b — via mcp:create_dashboard/);
    assert.match(newest.message, /OS-Object: d2 \(B\)/);
    assert.match(newest.message, /OS-Surface: mcp:create_dashboard/);
    assert.match(newest.message, /OS-Request-Id: req_2/);
    assert.match(newest.message, /OS-Actor: alex@datamasterclass\.com/);
    assert.match(oldest.message, /via ui:\/api\/dashboards\/build/);

    // The committed tree is the generated subtree, and nothing else.
    const tree = await listTree('analytics', undefined, { reposDir });
    assert.deepEqual(
      tree.map((t) => t.path).sort(),
      [
        'dashboards/a/README.md',
        'dashboards/a/dashboard.yaml',
        'dashboards/b/README.md',
        'dashboards/b/dashboard.yaml',
        'dashboards/index.yml',
      ],
    );
    const yaml = await readBlob('analytics', undefined, 'dashboards/b/dashboard.yaml', { reposDir });
    assert.match(yaml, /kind: Dashboard/);
    assert.match(yaml, /ref: metric:met_rev/);
    assert.ok(!yaml.includes(ACTOR.id), 'no principal id in the tree — only in the commit');
  } finally {
    __setDashboardProjectGitForTests(null);
    rmSync(reposDir, { recursive: true, force: true });
  }
});

test('an unchanged state commits NOTHING (byte-stable generation)', async () => {
  const reposDir = tmpRepos();
  try {
    __setDashboardProjectGitForTests(true);
    const captured = snap(stored('d1', 'A'));
    const a = await commitDashboards('analytics', ACTOR, { action: 'create dashboard' }, { reposDir, captured });
    const b = await commitDashboards('analytics', ACTOR, { action: 'edit dashboard' }, { reposDir, captured });
    assert.equal(a?.changed, true);
    assert.equal(b?.changed, false, 'regenerating identical bytes must not commit');
    assert.equal((await log('analytics', { reposDir })).length, 1);
  } finally {
    __setDashboardProjectGitForTests(null);
    rmSync(reposDir, { recursive: true, force: true });
  }
});

test('a synthesized author e-mail is labelled in the commit, never hidden', async () => {
  const reposDir = tmpRepos();
  try {
    __setDashboardProjectGitForTests(true);
    await commitDashboards('analytics', { id: 'u_nobody' }, { action: 'create dashboard' }, { reposDir, captured: snap(stored('d1', 'A')) });
    const [entry] = await log('analytics', { reposDir });
    assert.match(entry.message, /OS-Author-Email: synthesized/);
    assert.match(entry.author.email, /@os\.local$/);
  } finally {
    __setDashboardProjectGitForTests(null);
    rmSync(reposDir, { recursive: true, force: true });
  }
});

test('the hook commits on a store event and takes the surface from the request scope', async () => {
  const reposDir = tmpRepos();
  __resetDashboardListeners();
  try {
    __setDashboardProjectGitForTests(true);
    const capture = () => snap(stored('d1', 'Sales Overview'));
    const off = installDashboardCommitHook({ reposDir, capture, mirror: false });
    runWithSurface('mcp:create_dashboard', () => {
      emitDashboardChange({ domain: 'analytics', dashboardId: 'd1', name: 'Sales Overview', action: 'create dashboard', actorId: ACTOR.id });
    }, 'req_hook');
    await awaitDashboardCommits();
    off();
    const [entry] = await log('analytics', { reposDir });
    assert.match(entry.message, /^dashboards\(analytics\): create dashboard sales-overview — via mcp:create_dashboard/);
    assert.match(entry.message, /OS-Request-Id: req_hook/);
    assert.match(entry.message, /OS-Object: d1 \(Sales Overview\)/);
  } finally {
    __setDashboardProjectGitForTests(null);
    __resetDashboardListeners();
    rmSync(reposDir, { recursive: true, force: true });
  }
});

test('a cross-domain move commits BOTH repositories', async () => {
  const reposDir = tmpRepos();
  __resetDashboardListeners();
  try {
    __setDashboardProjectGitForTests(true);
    // The old domain no longer holds it; the new one does.
    const capture = (domain: string) => (domain === 'analytics' ? [] : snap({ ...stored('d1', 'Sales Overview'), domain: 'finance' }));
    const off = installDashboardCommitHook({
      reposDir,
      capture,
      mirror: false,
      resolveActor: async (id) => (id === ADMIN.id ? ADMIN : { id }),
    });
    // M-8: a move is an ADMIN's act, and both commits must say whose. This used to pass
    // `actorId: 'system'`, which is the one attribution a person's write may never carry — the
    // plumbing threads `user.id` (`tabs/admin/lib/domain-move.ts`) and nothing asserted it.
    emitDashboardChange({
      domain: 'finance',
      previousDomain: 'analytics',
      dashboardId: 'd1',
      name: 'Sales Overview',
      action: 'move dashboard between domains',
      actorId: ADMIN.id,
    });
    await awaitDashboardCommits();
    off();
    const analytics = await log('analytics', { reposDir });
    const finance = await log('finance', { reposDir });
    assert.equal(analytics.length, 1, 'the OLD domain gets a commit (it lost the dashboard)');
    assert.equal(finance.length, 1, 'the NEW domain gets a commit (it gained it)');
    assert.match(finance[0].message, /move dashboard between domains/);
    // THE ACTING ADMIN IS ON BOTH COMMITS — the one the old domain gained and the one it lost.
    for (const [domain, entry] of [['analytics', analytics[0]], ['finance', finance[0]]] as const) {
      assert.equal(entry.author.email, ADMIN.email, `${domain}: authored as the acting admin`);
      assert.match(entry.message, new RegExp(`OS-Actor: ${ADMIN.id.replace('.', '\\.')}`), `${domain}: the trailer names the principal`);
      assert.doesNotMatch(entry.message, /OS-Actor: system/, `${domain}: a person's move is never attributed to the platform`);
      assert.doesNotMatch(entry.author.email, /@os\.local$/, `${domain}: the author is a real identity, not a synthesized one`);
    }
    const tree = await listTree('finance', undefined, { reposDir });
    assert.ok(tree.some((t) => t.path.endsWith('/dashboard.yaml')));
    assert.deepEqual((await listTree('analytics', undefined, { reposDir })).map((t) => t.path), [`${DASHBOARDS_PREFIX}index.yml`]);
  } finally {
    __setDashboardProjectGitForTests(null);
    __resetDashboardListeners();
    rmSync(reposDir, { recursive: true, force: true });
  }
});

test('a throwing listener never fails the write', async () => {
  __resetDashboardListeners();
  const { onDashboardChange } = await import('@tabs/dashboards/lib/dashboard-events');
  const off = onDashboardChange(() => {
    throw new Error('the hook exploded');
  });
  try {
    // The write already happened; losing it to a git hiccup would be worse than a missing commit.
    assert.doesNotThrow(() =>
      emitDashboardChange({ domain: 'analytics', dashboardId: 'd1', name: 'A', action: 'create dashboard', actorId: 'u' }),
    );
  } finally {
    off();
    __resetDashboardListeners();
  }
});

// ----------------------------------------------------- the enumeration gate (G1) ---

/**
 * Every exported writer in `lib/store.ts` is classified here. A new one fails this test until it
 * is either announced (so it commits) or explicitly listed as not-a-content-change with a reason.
 * That is what makes "no artefact kind ships a writer that does not commit" a measurement.
 */
const COMMITTING_WRITERS = [
  'saveDashboard',
  'renameDashboard',
  'transitionDashboard',
  'demoteDashboard',
  'setDashboardArchived',
  'moveDashboard',
  'deleteDashboard',
  'restoreDashboardVersion',
  'moveDashboardsDomain',
];

/** Writers that deliberately do NOT commit, each with the reason it is not a content change. */
const NON_COMMITTING_WRITERS: Record<string, string> = {
  __resetDashboards: 'a test hook, not a user write',
  ensureHydrated: 'a read: hydrates the in-memory registry from the durable mirror',
};

test('G1 — every exported dashboard writer either commits or is classified', async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '..', 'store.ts'), 'utf8');
  // Exported functions that MUTATE: they write through the mirror, push/splice the array, or purge.
  const exported = [...src.matchAll(/^export function (\w+)\(/gm)].map((m) => m[1]);
  const mutators = exported.filter((name) => {
    const body = src.slice(src.indexOf(`export function ${name}(`));
    const end = body.indexOf('\nexport ', 1);
    const fn = end > 0 ? body.slice(0, end) : body;
    // A MUTATOR is one that persists: it writes through the durable mirror, deletes through it,
    // or purges the version log. `.push(` alone is not enough — every list function pushes into a
    // local result array.
    return /writeThrough\(|deleteThrough\(|versions\.purge\(/.test(fn);
  });
  for (const name of mutators) {
    const classified = COMMITTING_WRITERS.includes(name) || name in NON_COMMITTING_WRITERS;
    assert.ok(
      classified,
      `lib/store.ts exports the mutator \`${name}\`, which is neither in COMMITTING_WRITERS nor explained in ` +
        'NON_COMMITTING_WRITERS. Every mutation of a dashboard must be a git commit (D8/G1): call ' +
        '`announce(rec, actorId, "<action>")` after the write, then list it here.',
    );
  }
  // And every writer claimed to commit really does announce.
  for (const name of COMMITTING_WRITERS) {
    const start = src.indexOf(`export function ${name}(`);
    assert.ok(start > 0, `lib/store.ts no longer exports \`${name}\` — update this enumeration`);
    const rest = src.slice(start);
    const end = rest.indexOf('\nexport ', 1);
    const fn = end > 0 ? rest.slice(0, end) : rest;
    assert.match(fn, /announce\(/, `\`${name}\` must announce its write so the commit hook sees it`);
  }
  assert.ok(mutators.length >= COMMITTING_WRITERS.length, 'the mutator scan found fewer writers than expected — did store.ts move?');
});
