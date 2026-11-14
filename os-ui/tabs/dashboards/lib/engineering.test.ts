/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        dashboards
 * FEATURE:    The engineering-view adapter contract for stream T (D25, D26)
 * USER STORY: As a data engineer I want the Under-the-hood panel to show the real artefacts in the
 *             tools' own words, with the command I would run and the export that lets me leave.
 * ARCHITECTURE: Pure, MCP-serialisable, and the VOCABULARY rule is a test, not an intention.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineeringView, type DashboardEngineeringInput } from '@tabs/dashboards/lib/engineering';
import { projectSnapshot, snapshotDashboard, type StoredDashboard } from '@tabs/dashboards/lib/git/snapshot';
import { placeDashboards } from '@tabs/dashboards/lib/git/generate';
import { dashboardLifecycle, livePin, lifecycleWired, setLifecycleReader } from '@tabs/dashboards/lib/lifecycle-port';

const stored: StoredDashboard = {
  id: 'dash_1',
  owner: 'alex@datamasterclass.com',
  tier: 'domain',
  domain: 'analytics',
  spec: {
    name: 'Sales Overview',
    view: 'Orders',
    charts: [
      { name: 'Total revenue', vizType: 'big_number', metrics: ['Orders.revenue'] },
      { name: 'Orphan', vizType: 'bar', metrics: ['Orders.unknown'] },
    ],
  },
};

function input(extra: Partial<DashboardEngineeringInput> = {}): DashboardEngineeringInput {
  const dashboard = snapshotDashboard(stored, {
    memberRef: (m) => (m === 'Orders.revenue' ? 'metric:met_rev' : null),
    viewRef: () => 'dataset:ds_orders_gold',
  });
  const [placed] = placeDashboards(projectSnapshot('analytics', [dashboard]));
  return { dashboard, domain: 'analytics', dir: placed.dir, ...extra };
}

test('the adapter refuses the wrong kind or the wrong id, loudly', () => {
  assert.throws(() => engineeringView('metric', 'dash_1', input()), /handles kind 'dashboard'/);
  assert.throws(() => engineeringView('dashboard', 'other', input()), /asked for dashboard 'other'/);
});

test('the view is JSON-serialisable, so the panel and the MCP render the identical structure', () => {
  const view = engineeringView('dashboard', 'dash_1', input({ yaml: 'kind: Dashboard\n', headSha: 'a'.repeat(40) }));
  assert.deepEqual(JSON.parse(JSON.stringify(view)), view);
});

test('T2 — every tool tab is named with the TOOL’s own noun, never an OS invention', () => {
  const view = engineeringView('dashboard', 'dash_1', input());
  assert.deepEqual(view.tools.map((t) => t.tool), ['git', 'Trino', 'dbt']);
  const labels = view.tools.flatMap((t) => t.facts.map((f) => f.label));
  // Each label either names a tool noun or is a plain repository/query noun. An OS-invented noun
  // like "Artifact" or "Governed Object" fails this.
  for (const label of labels) {
    assert.ok(
      /git|commit|Repository|Path|Subtree|Trino|dbt|view|SQL/i.test(label),
      `“${label}” uses no tool vocabulary — the engineering view must speak the tools' own language`,
    );
  }
  // The bridge to the OS term is allowed ONCE, in parentheses.
  assert.ok(labels.some((l) => l === 'dbt metric (KPI)'));
});

test('the git tab names the real repository, path and subtree, and gives the commands', () => {
  const view = engineeringView('dashboard', 'dash_1', input({ headSha: 'b'.repeat(40), gitBaseUrl: 'https://os.example.com' }));
  const git = view.tools.find((t) => t.tool === 'git')!;
  assert.deepEqual(
    git.facts.map((f) => [f.label, f.value]),
    [
      ['Repository', 'analytics.git'],
      ['Path', 'dashboards/sales-overview/dashboard.yaml'],
      ['Head commit', 'b'.repeat(40)],
      ['Subtree', 'dashboards/'],
    ],
  );
  assert.ok(git.commands!.some((c) => c.command === 'git clone https://os.example.com/git/analytics.git'));
  assert.ok(git.commands!.some((c) => c.command.includes('git log --stat -- dashboards/sales-overview/dashboard.yaml')));
});

test('an unresolved head commit SAYS WHY rather than showing a blank field', () => {
  const view = engineeringView('dashboard', 'dash_1', input());
  const head = view.tools.find((t) => t.tool === 'git')!.facts.find((f) => f.label === 'Head commit')!;
  assert.equal(head.value, 'not resolved');
  assert.match(head.note!, /has not been committed yet|boot reconcile/);
});

test('the Trino tab says the query runs as the VIEWER and that ad-hoc SQL is impossible', () => {
  const view = engineeringView('dashboard', 'dash_1', input({ trinoPrincipal: 'alex@datamasterclass.com' }));
  const trino = view.tools.find((t) => t.tool === 'Trino')!;
  const runsAs = trino.facts.find((f) => f.label === 'Trino query runs as')!;
  assert.equal(runsAs.value, 'alex@datamasterclass.com');
  assert.match(runsAs.note!, /never a service account/);
  const adhoc = trino.facts.find((f) => f.label === 'Ad-hoc SQL')!;
  assert.equal(adhoc.value, 'not possible');
  assert.match(adhoc.note!, /governed metric members only/i);
});

test('the dbt tab lists the governed ids, and names an unresolved member honestly', () => {
  const view = engineeringView('dashboard', 'dash_1', input());
  const dbt = view.tools.find((t) => t.tool === 'dbt')!;
  const values = dbt.facts.map((f) => f.value);
  assert.ok(values.some((v) => v.includes('dataset:ds_orders_gold')));
  assert.ok(values.some((v) => v.includes('metric:met_rev')));
  const unresolved = dbt.facts.find((f) => f.value === 'Orders.unknown')!;
  assert.match(unresolved.note!, /No governed metric id resolves this member/);
  assert.ok(dbt.commands!.some((c) => c.command.startsWith('dbt build --select')));
});

test('D26 — the native exports name the exact command to run them elsewhere', () => {
  const view = engineeringView('dashboard', 'dash_1', input({ gitBaseUrl: 'https://os.example.com' }));
  assert.deepEqual(view.exports.map((e) => e.filename), ['dashboard.yaml', 'analytics.tar']);
  assert.match(view.exports[0].how, /git show HEAD:dashboards\/sales-overview\/dashboard\.yaml/);
  assert.match(view.exports[1].how, /git clone https:\/\/os\.example\.com\/git\/analytics\.git/);
});

test('the caveats state what is NOT true yet, including the Superset relationship', () => {
  const view = engineeringView('dashboard', 'dash_1', input());
  const text = view.caveats.join('\n');
  assert.match(text, /is NOT a Superset artefact/);
  assert.match(text, /vendored as source and attributed/);
  assert.match(text, /Layout, a native filter bar, tabs/);
  assert.match(text, /No lifecycle version is pinned/);
});

test('a pinned dashboard drops the no-lifecycle caveat', () => {
  const base = input();
  const view = engineeringView('dashboard', 'dash_1', { ...base, dashboard: { ...base.dashboard, lifecycle: { live: 'v1' } } });
  assert.ok(!view.caveats.join('\n').includes('No lifecycle version is pinned'));
});

// -------------------------------------------- the lifecycle port (V's contract) ---

test('with no lifecycle reader wired, the port reports nothing — never an invented pin', async () => {
  assert.equal(lifecycleWired(), false);
  assert.equal(await dashboardLifecycle('dash_1'), null);
  assert.equal(await livePin('dash_1'), null);
});

test('H-5 — the port is ASYNC and maps stream V’s own `{ref, at, by}` pin record', async () => {
  // V's `core/infra/lifecycle-pins.ts` `livePin(kind, id)` returns `Promise<Pin | undefined>` —
  // the pins live in a durable mirror — so a synchronous port could only have read a stale copy.
  const off = setLifecycleReader(async (kind, id) =>
    kind === 'dashboard' && id === 'dash_1'
      ? { ref: '9f2c1ab0c4e5d6f70819a2b3c4d5e6f708192a3b', at: '2026-11-14T02:10:04.118Z', by: 'u_alex', domain: 'analytics' }
      : undefined,
  );
  try {
    assert.equal(lifecycleWired(), true);
    assert.deepEqual(await dashboardLifecycle('dash_1'), {
      live: '9f2c1ab0c4e5d6f70819a2b3c4d5e6f708192a3b',
      liveAt: '2026-11-14T02:10:04.118Z',
      liveBy: 'u_alex',
    });
    assert.equal(await livePin('dash_1'), '9f2c1ab0c4e5d6f70819a2b3c4d5e6f708192a3b');
    // V's record describes exactly ONE thing — the live version — so draft/testing stay ABSENT
    // rather than being invented from it.
    const pin = await dashboardLifecycle('dash_1');
    assert.equal(pin!.draft, undefined);
    assert.equal(pin!.testing, undefined);
    assert.equal(await livePin('dash_other'), null, 'an unpinned dashboard is null, not a guess');
  } finally {
    off();
  }
  assert.equal(lifecycleWired(), false, 'the uninstall restores the previous state');
});

test('H-5 — a reader may also return the already-mapped shape (what a test usually does)', async () => {
  const off = setLifecycleReader(() => ({ draft: 'head', live: 'v1.0.0' }));
  try {
    assert.deepEqual(await dashboardLifecycle('dash_1'), { draft: 'head', live: 'v1.0.0' });
  } finally {
    off();
  }
});

test('H-5 — an empty pin record is “no pin”, not an empty lifecycle block in the file', async () => {
  const off = setLifecycleReader(() => ({}));
  try {
    assert.equal(await dashboardLifecycle('dash_1'), null);
  } finally {
    off();
  }
});

test('a throwing or rejecting lifecycle reader degrades to “no pin”, never breaking the dashboard', async () => {
  for (const reader of [
    () => {
      throw new Error('lifecycle is down');
    },
    async () => {
      throw new Error('the mirror is unreachable');
    },
  ]) {
    const off = setLifecycleReader(reader);
    try {
      assert.equal(await dashboardLifecycle('dash_1'), null);
      assert.equal(await livePin('dash_1'), null);
    } finally {
      off();
    }
  }
});

test('H-5 — `toLifecyclePin` is the one mapping, and it never fabricates', async () => {
  const { toLifecyclePin } = await import('@tabs/dashboards/lib/lifecycle-port');
  assert.equal(toLifecyclePin(null), null);
  assert.equal(toLifecyclePin(undefined), null);
  assert.equal(toLifecyclePin({ ref: '', at: 'x', by: 'y' }), null, 'an empty ref is not a pin');
  assert.deepEqual(toLifecyclePin({ ref: 'abc', at: '', by: '' }), { live: 'abc' }, 'absent at/by are omitted, not guessed');
});

test('H-2/H-3 — the pin reads as a fact with its provenance, or as an honest absence', async () => {
  const { pinSummary } = await import('@tabs/dashboards/lib/git/facts');
  assert.match(pinSummary(null).value, /no version pinned/);
  assert.match(pinSummary(null).note!, /Lifecycle is owned by the OS kernel, not by this tab/);
  const s = pinSummary({ live: 'abc1234', liveAt: '2026-11-14T02:10:04.118Z', liveBy: 'u_alex' });
  assert.equal(s.value, 'abc1234');
  assert.match(s.note!, /at 2026-11-14T02:10:04\.118Z by u_alex/);
});
