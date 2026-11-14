/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       dashboards
 * FEATURE:    V4 — THE headline test: editing a live dashboard does not change what Run shows
 * USER STORY: As someone whose morning dashboard matters I need an author's save to be invisible
 *             to me until they go live. This is the one test the whole lifecycle stream exists
 *             to make pass.
 * ARCHITECTURE:
 *   - Drives the real dashboards store and the real pin store, with `fetch` stubbed so the
 *     OpenSearch mirror is offline and both are in-process (the laptop path).
 *   - The assertion is byte-level: the Run read's spec is deep-equal to the pre-edit spec and
 *     its ref is unchanged, THEN go_live, THEN it differs. No route is imported (a test cannot),
 *     so the seam under test is `dashboardForSurface`, which is the one function the route calls.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const store = await import('./store.ts');
const { specRef, dashboardForSurface, dashboardLifecycleAdapter } = await import('./lifecycle-adapter.ts');
const pins = await import('@core/infra/lifecycle-pins');
const { registerLifecycleAdapter, __clearLifecycleAdapters } = await import('@core/kernel/lifecycle-adapters');
const SHA40 = 'a'.repeat(40);

/**
 * The metric and dataset kinds, stood in for. Their REAL adapters live in their own tabs (a test
 * here may not import another tab), and what this file must prove is the CHAIN: a dashboard whose
 * dependencies can hold a pin goes live once they do.
 */
function registerDependencyKinds() {
  for (const kind of ['metric', 'dataset'] as const) {
    registerLifecycleAdapter({
      kind,
      resolve: async (_a, id) => ({ kind, id, name: id, domain: 'sales', head: SHA40, tier: 'personal' }),
      canGoLive: async () => ({ ok: true }),
    });
  }
}
const { goLive, retire, previewGoLive } = await import('@core/kernel/go-live');
const { lifecycleWordOf } = await import('@core/kernel/object-lifecycle');

const ACTOR = { id: 'u1', name: 'Alex', role: 'creator' as const, domains: ['sales'] };
const VIEWER = { id: 'u2', name: 'Bo', role: 'creator' as const, domains: ['sales'] };
const BUILDER = { id: 'u3', name: 'Cy', role: 'builder' as const, domains: ['sales'] };

const spec = (name: string, panels: number) => ({
  name,
  view: 'Orders',
  charts: Array.from({ length: panels }, (_, i) => ({
    name: `Panel ${i + 1}`,
    vizType: 'line' as const,
    metrics: ['Orders.revenue'],
  })),
});

let tempRepos = '';
const temps: string[] = [];

beforeEach(async () => {
  store.__resetDashboards();
  pins.__resetLifecyclePins();
  __clearLifecycleAdapters();
  registerLifecycleAdapter(dashboardLifecycleAdapter);
  registerDependencyKinds();

  // The pin WRITE gate (review H-3) refuses unless a source answered; the mirror is stubbed
  // dead here, so the index hydrates from a real (empty) repo root in a temp dir.
  tempRepos = mkdtempSync(join(tmpdir(), 'lifecycle-t-'));
  temps.push(tempRepos);
  await pins.hydrateForTests({ reposDir: tempRepos });
});

// ----------------------------------------------------- V4: the headline test ---

test('V4: editing a live dashboard does NOT change what Run shows until go_live', async () => {
  const rec = store.saveDashboard(ACTOR, 'dash_head', spec('Revenue by region', 2));
  const originalSpec = JSON.parse(JSON.stringify(rec.spec)) as typeof rec.spec;
  const originalRef = specRef(originalSpec);

  // Its only dependency must be live first — the guard is real, not bypassed for the test.
  await pins.setLivePin('metric', 'Orders.revenue', 'x', ACTOR, 'sales', { commit: false });
  await pins.setLivePin('dataset', 'Orders', 'x', ACTOR, 'sales', { commit: false });

  await goLive(ACTOR, 'dashboard', 'dash_head', undefined, { commit: false });

  const beforeEdit = await dashboardForSurface('dash_head', ACTOR, 'run');
  assert.deepEqual(beforeEdit.spec, originalSpec);
  assert.equal(beforeEdit.ref, originalRef);

  // ---- the author edits and saves ----
  store.saveDashboard(ACTOR, 'dash_head', spec('Revenue by region', 5));

  const afterEdit = await dashboardForSurface('dash_head', ACTOR, 'run');
  assert.deepEqual(
    afterEdit.spec,
    originalSpec,
    'RUN IS BYTE-IDENTICAL after the edit — this is the point of the whole stream',
  );
  assert.equal(afterEdit.ref, originalRef, 'and it is still serving the SAME ref');
  assert.equal(afterEdit.spec?.charts.length, 2, 'two panels, not the five the draft now has');

  // Studio, meanwhile, shows the edit immediately — you edit what you are looking at.
  const studio = await dashboardForSurface('dash_head', ACTOR, 'studio');
  assert.equal(studio.spec?.charts.length, 5);
  assert.notEqual(studio.ref, originalRef);
  assert.equal(studio.live, originalRef, 'and Studio says which version is live');

  // ---- the author goes live again ----
  await goLive(ACTOR, 'dashboard', 'dash_head', undefined, { commit: false });

  const afterGoLive = await dashboardForSurface('dash_head', ACTOR, 'run');
  assert.equal(afterGoLive.spec?.charts.length, 5, 'NOW Run changed');
  assert.notEqual(afterGoLive.ref, originalRef);
});

test('V5: a dashboard with no pin is simply not in Run, and says why — never the draft instead', async () => {
  store.saveDashboard(ACTOR, 'dash_draft', spec('Experiment', 1));
  const read = await dashboardForSurface('dash_draft', ACTOR, 'run');
  assert.equal(read.spec, null, 'Run shows NOTHING for a dashboard nobody took live');
  assert.equal(read.live, null);
  assert.match(String((read as { unavailable?: string }).unavailable), /not live/);

  // Studio shows it, because that is where you work on it.
  const studio = await dashboardForSurface('dash_draft', ACTOR, 'studio');
  assert.equal(studio.spec?.charts.length, 1);
});

test('V3: retire takes it out of Run and deletes nothing', async () => {
  store.saveDashboard(ACTOR, 'dash_r', spec('Revenue', 1));
  await pins.setLivePin('metric', 'Orders.revenue', 'x', ACTOR, 'sales', { commit: false });
  await pins.setLivePin('dataset', 'Orders', 'x', ACTOR, 'sales', { commit: false });
  await goLive(ACTOR, 'dashboard', 'dash_r', undefined, { commit: false });
  assert.ok((await dashboardForSurface('dash_r', ACTOR, 'run')).spec);

  await retire(ACTOR, 'dashboard', 'dash_r', { commit: false });
  assert.equal((await dashboardForSurface('dash_r', ACTOR, 'run')).spec, null);
  // the dashboard itself is untouched
  assert.equal((await dashboardForSurface('dash_r', ACTOR, 'studio')).spec?.name, 'Revenue');
  assert.equal(store.getDashboard('dash_r', ACTOR).spec.charts.length, 1);
});

test('V5: a pin whose version is no longer retained is REPORTED, never substituted', async () => {
  store.saveDashboard(ACTOR, 'dash_gone', spec('Revenue', 1));
  // Pin a ref that no retained version hashes to — a purged history, or a restored older pin.
  await pins.setLivePin('dashboard', 'dash_gone', 'spec:deadbeefcafe', ACTOR, 'sales', { commit: false });
  const read = await dashboardForSurface('dash_gone', ACTOR, 'run');
  assert.equal(read.spec, null, 'it must NOT fall back to the draft');
  assert.equal(read.live, 'spec:deadbeefcafe');
  assert.match(String((read as { unavailable?: string }).unavailable), /no longer retained/);
});

// ----------------------------------------------- the pin resolves by content ---

test('the lifecycle ref is a content digest: same spec ⇒ same ref, any visible change ⇒ a new one', () => {
  const a = spec('Revenue', 2);
  const b = JSON.parse(JSON.stringify(a)) as typeof a;
  assert.equal(specRef(a), specRef(b), 'two identical specs hash the same');
  assert.notEqual(specRef(a), specRef(spec('Revenue', 3)), 'a new panel is a new version');
  assert.notEqual(specRef(a), specRef(spec('Revenue ', 2)), 'even a renamed title is a new version');
  assert.match(specRef(a), /^spec:[0-9a-f]{12}$/);
});

test('going live twice with no edit in between is a no-op pin, not a churn of refs', async () => {
  store.saveDashboard(ACTOR, 'dash_x', spec('Revenue', 1));
  await pins.setLivePin('metric', 'Orders.revenue', 'x', ACTOR, 'sales', { commit: false });
  await pins.setLivePin('dataset', 'Orders', 'x', ACTOR, 'sales', { commit: false });
  const first = await goLive(ACTOR, 'dashboard', 'dash_x', undefined, { commit: false });
  const second = await goLive(ACTOR, 'dashboard', 'dash_x', undefined, { commit: false });
  assert.equal(first.live, second.live);
});

// ----------------------------------------------------- V6: the guard, for real ---

test('V6: a dashboard whose metric is a draft is REFUSED, naming that metric', async () => {
  store.saveDashboard(ACTOR, 'dash_g', spec('Revenue', 1));
  await assert.rejects(
    () => goLive(ACTOR, 'dashboard', 'dash_g', undefined, { commit: false }),
    (e: Error & { status?: number }) => {
      assert.equal(e.status, 409);
      assert.match(e.message, /Orders\.revenue/, 'the metric member is named');
      return true;
    },
  );
});

test('V6: the dataset behind the view is a dependency too', async () => {
  store.saveDashboard(ACTOR, 'dash_v', spec('Revenue', 1));
  await pins.setLivePin('metric', 'Orders.revenue', 'x', ACTOR, 'sales', { commit: false });
  await assert.rejects(
    () => goLive(ACTOR, 'dashboard', 'dash_v', undefined, { commit: false }),
    (e: Error) => {
      assert.match(e.message, /Orders/);
      return true;
    },
  );
});

// --------------------------------------------- identity is never widened ---

test('a colleague may READ a shared dashboard in Run but may NOT change what it serves', async () => {
  // Owned by a builder, who promotes their OWN dashboard to Domain — the audience axis,
  // through the existing promotion path, which this stream does not touch.
  store.saveDashboard(BUILDER, 'dash_p', spec('Revenue', 1));
  store.transitionDashboard('dash_p', BUILDER, 'promote');
  await pins.setLivePin('metric', 'Orders.revenue', 'x', BUILDER, 'sales', { commit: false });
  await pins.setLivePin('dataset', 'Orders', 'x', BUILDER, 'sales', { commit: false });
  await goLive(BUILDER, 'dashboard', 'dash_p', undefined, { commit: false });

  // A Domain dashboard that is Live: the colleague sees the pinned spec …
  const read = await dashboardForSurface('dash_p', VIEWER, 'run');
  assert.equal(read.spec?.name, 'Revenue');

  // … and still cannot move the pin. Promotion changed the audience, not who operates it.
  await assert.rejects(
    () => goLive(VIEWER, 'dashboard', 'dash_p', undefined, { commit: false }),
    (e: Error & { status?: number }) => {
      assert.equal(e.status, 403, `expected a refusal, got ${e.status}`);
      assert.match(e.message, /may change what Run serves/);
      return true;
    },
  );
});

// --------------------------- review H-1: the chain can actually be taken live ---

test('H-1: a REAL dashboard with one metric panel goes live once its metric and dataset do', async () => {
  store.saveDashboard(ACTOR, 'dash_chain', spec('Revenue by region', 1));

  // It is refused first — the guard is real.
  await assert.rejects(
    () => goLive(ACTOR, 'dashboard', 'dash_chain', undefined, { commit: false }),
    /Orders\.revenue/,
  );

  // Now take the dependencies live THROUGH THE SERVICE — the path a user actually has. Before
  // the pin-only adapters existed this was impossible, which made the refusal permanent.
  const metric = await goLive(ACTOR, 'metric', 'Orders.revenue', undefined, { commit: false });
  assert.equal(metric.live, SHA40);
  await goLive(ACTOR, 'dataset', 'Orders', undefined, { commit: false });

  // And the dashboard follows.
  const dash = await goLive(ACTOR, 'dashboard', 'dash_chain', undefined, { commit: false });
  assert.equal(lifecycleWordOf(dash.lifecycle), 'live');
  assert.deepEqual(dash.warnings, [], 'every dependency was genuinely checked');
  assert.ok((await dashboardForSurface('dash_chain', ACTOR, 'run')).spec, 'and Run serves it');
});

test('H-1: a dependency whose KIND cannot hold a pin is a WARNING, never a permanent refusal', async () => {
  __clearLifecycleAdapters();
  registerLifecycleAdapter(dashboardLifecycleAdapter); // dashboards only: metric/dataset unwired
  store.saveDashboard(ACTOR, 'dash_warn', spec('Revenue', 1));

  const preview = await previewGoLive(ACTOR, 'dashboard', 'dash_warn');
  assert.equal(preview.blocked, null, 'not blocked — a refusal with no way out is worse');
  assert.equal(preview.warnings.length, 2, 'one per unwired dependency (the metric and the view)');
  assert.match(preview.warnings.join(' '), /cannot hold a pin yet/);
  assert.match(preview.confirm.body, /cannot hold a pin yet/, 'and the dialog SAYS so before you confirm');

  const res = await goLive(ACTOR, 'dashboard', 'dash_warn', undefined, { commit: false });
  assert.equal(lifecycleWordOf(res.lifecycle), 'live');
  assert.equal(res.warnings.length, 2, 'the result repeats the unknowns rather than hiding them');
});

after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
