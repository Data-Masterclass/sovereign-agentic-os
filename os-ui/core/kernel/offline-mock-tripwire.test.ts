/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    THE TRIPWIRE — no file may choose to fabricate without the kernel predicate
 * USER STORY: As a maintainer I want the next fabricating code path to be impossible to add
 *             quietly: the ones that existed each keyed their own gate on `OS_PROFILE`, which the
 *             deploy never set, and nothing in CI noticed for weeks because each looked fine
 *             alone — and the first version of THIS test missed six more, because it grepped for
 *             one spelling of "mock" and the Files pipeline uses another.
 *
 * ARCHITECTURE:
 *   WHAT THIS GUARANTEES, exactly — no more and no less:
 *     1. COVERAGE OF A MARKER SET, not of the concept "fabrication". Every non-test `.ts`/`.tsx`
 *        under `tabs/**`, `core/**` and `app/**` that contains any of {@link MARKERS} is
 *        classified into exactly one of three pinned lists. A file in none of them FAILS BY NAME.
 *     2. DECIDERS import `@core/kernel/offline-mock` **and** call `offlineMockAllowed(` or
 *        `refuseOfflineMock(`. An import alone proves nothing, so both are checked.
 *     3. RECOGNISERS (today: the one MCP error mapper) import the module to RECOGNISE a refusal
 *        and must NOT call the predicate — deciding at an error boundary is deciding too late.
 *     4. LABELS — a type union, a badge, a tool description, a mock IMPLEMENTATION, a
 *        reachability probe, or a function carrying a mode it was handed — must not import the
 *        module at all. A propagator that gates is a second decision point.
 *     5. No decider keys its own gate on `deploymentProfile` / `OS_PROFILE` again.
 *
 *   WHAT IT DOES NOT GUARANTEE: that no fabrication exists under a spelling not in
 *     {@link MARKERS}. That is the lesson of review H2 — `mode: 'mock'`, `mockClient(`,
 *     `mockAdapterFor(` and `mockEmbed` were all invisible to the first version of this test, and
 *     six real fabrication sites in the Files ingest pipeline rode through it. The RE-REVIEW then
 *     found two more under two further spellings: `hashEmbed(` / `'offline-hash'` (the Knowledge
 *     embedder — the identical defect to the Files one, on the corpus agents cite) and
 *     `seedToolResult(` (an app tool answering "Sample record A" when its runner said nothing).
 *     Twice now, the gap has been a NAME rather than a missing gate. So: **a new stand-in must
 *     either reuse a marker in this set or be added to it.** The set is the contract; widening it
 *     is cheap and is how this test stays honest.
 *     Matching is deliberately quote- and space-tolerant for the `mode: mock` family
 *     ({@link MARKER_PATTERNS}), because `mode: "mock"` and `mode:'mock'` are the same fact and a
 *     literal `includes` would have missed either variant.
 *
 *   Follows the repo's grep-the-tree pattern (`core/ui/charts/echarts-surface.test.ts` for the
 *   single ECharts registration, the MODEL-KEY rule for the LiteLLM master key). Reads from disk
 *   rather than importing: a `.tsx` cannot be imported by a test at all, and the point is
 *   coverage of FILES, not of behaviour.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const OS_UI = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/** Every tree that can run on a cluster. `app/**` was missing and hid two ungated spend routes. */
const ROOTS = ['tabs', 'core', 'app'];

/**
 * The spellings a stand-in uses in this codebase. Review H2: grepping only `offline-mock` missed
 * the Files pipeline entirely, which labels its fabrications `mode: 'mock'` and reaches them
 * through `mockClient(` / `mockAdapterFor(` / `mockEmbed`.
 */
const MARKERS = [
  'offline-mock',
  'mockClient(',
  'mockAdapterFor(',
  'mockEmbed',
  // Re-review: the Knowledge embedder's spelling, and the Software seed-row helper.
  'hashEmbed(',
  'offline-hash',
  'seedToolResult(',
];

/**
 * Markers whose spelling varies in ways a literal `includes` would miss — quote style and the
 * space after the colon. Kept as patterns rather than enumerating every variant as a string, so
 * `mode:"mock"`, `mode: 'mock'` and `mode :  "mock"` are all one fact.
 */
const MARKER_PATTERNS = [/\bmode\s*:\s*['"]mock['"]/];

const PREDICATE_IMPORT = '@core/kernel/offline-mock';

/** The kernel module itself — it DEFINES the predicate, so no list applies to it. */
const THE_MODULE = 'core/kernel/offline-mock.ts';

/**
 * Files that CHOOSE to serve a stand-in. Every one must consult the predicate.
 *
 * Each is a place the OS used to fabricate on the live cluster: a hash-seeded metric number, an
 * in-memory "build", a table never written, a domain-table verifier that answered `true` because
 * it could not check, a security verdict whose engine label was a default parameter, a connector
 * op reporting "128 rows ingested" from a seed, an agent tool answer invented because no live
 * executor was registered, 62% of the envelope invented as spend (with a real alert raised off
 * it), documents that do not exist in the customer's Drive, invented text for a document the
 * parser never read, and hash vectors standing in for embeddings.
 */
const DECIDERS = [
  'tabs/metrics/lib/build/explore-server.ts',
  'tabs/data/lib/ingest.ts',
  'tabs/data/lib/build/server.ts',
  'tabs/data/lib/publish-server.ts',
  'tabs/data/lib/reconcile-server.ts',
  'tabs/agents/lib/build/server.ts',
  'tabs/software/lib/scan.ts',
  'tabs/connections/lib/connection-adapters.ts',
  'tabs/connections/lib/store.ts',
  'tabs/monitoring/lib/spend.ts',
  'tabs/files/lib/connectors-live.ts',
  'tabs/files/lib/embed.ts',
  'tabs/files/lib/ingest/live.ts',
  // Re-review: the identical embedder defect on the Knowledge corpus, and the app tool that
  // answered with two invented rows when its runner said nothing.
  'tabs/knowledge/lib/embed.ts',
  'tabs/software/lib/app-records.ts',
];

/** Files that READ a refusal somebody else produced. They must import, and must not decide. */
const RECOGNISERS = [
  // `structuredError` is the ONE door every tool exception leaves through, so the refusal →
  // ENGINE_UNAVAILABLE mapping belongs there and nowhere else.
  'core/mcp/server.ts',
];

/**
 * Files that merely NAME a marker. None decides, so none may import the module.
 *
 * Two kinds are worth calling out because they look like deciders and are not:
 *  - `tabs/files/lib/connectors.ts` and `tabs/files/lib/ingest/mocks.ts` *define* the stand-ins.
 *    Defining a mock is not choosing to use one; the choosing happens in the three Files
 *    deciders above.
 *  - `tabs/data/lib/build/live-clients.ts` owns the probes (`queryToolReachable`,
 *    `dataRunnerReachable`). They answer "is the engine up", which is a fact about the world, not
 *    a decision about honesty.
 *  - `tabs/monitoring/lib/adapters/*` gate on `config.monitoringDemoFixtures`, a SECOND switch
 *    that is already `NODE_ENV`-keyed off in production (`core/kernel/config.ts`). Recorded in
 *    the plan; deliberately not folded into this predicate, so the Monitoring demo fixtures stay
 *    independently switchable.
 */
const LABELS = [
  // Route prose (the decision lives in the lib the route calls).
  'app/api/data/datasets/[id]/build/route.ts',
  'app/api/metrics/define/route.ts',
  'app/api/metrics/preview/route.ts',
  'app/api/platform-admin/billing/route.ts',
  'app/api/platform-admin/overview/route.ts',
  // Kernel / cross-cutting prose and effect vocabulary.
  'core/infra/agent-governed.ts',
  'core/infra/governed.ts',
  'core/kernel/config.ts',
  'core/mcp/experimental/data-write-tools.ts',
  'core/mcp/monitoring-tools.ts',
  'core/policy/effects.ts',
  'core/policy/roles.ts',
  'core/runtime/chat-artifacts.ts',
  // Tool descriptions.
  'tabs/admin/mcp/discovery-read-tools.ts',
  'tabs/dashboards/mcp/dashboard-write-tools.ts',
  'tabs/metrics/mcp/metric-write-tools.ts',
  // Types, propagators, reachability probes and mock IMPLEMENTATIONS.
  'tabs/agents/lib/build/run-diagnostics.ts',
  'tabs/agents/lib/store.ts',
  'tabs/connections/lib/schema.ts',
  'tabs/connections/ui/shared.ts',
  'tabs/dashboards/lib/build/panel-query.ts',
  'tabs/dashboards/ui/shared.ts',
  'tabs/data/lib/build/live-clients.ts',
  'tabs/files/lib/connectors.ts',
  'tabs/files/lib/ingest/mocks.ts',
  // Definitions and propagators of the Knowledge offline hash. `embed-core.ts` DEFINES
  // `hashEmbed`; `eval-harness.ts` hashes BOTH sides of a comparison over its own fixtures, which
  // is a self-consistent offline scoring harness and stands in for no real read; `index-pipeline`
  // and `retrieve` carry `embedSource`; `librarian-live` and `agentic-graph` READ it as a guard
  // (returning `[]` / keeping deterministic rows), which mitigates the read side and decides
  // nothing about whether to write.
  'core/infra/context/librarian-live.ts',
  'tabs/agents/lib/build/agentic-graph.ts',
  'tabs/knowledge/lib/embed-core.ts',
  'tabs/knowledge/lib/eval-harness.ts',
  'tabs/knowledge/lib/index-pipeline.ts',
  'tabs/knowledge/lib/retrieve.ts',
  // Defines `seedToolResult` + the demo-seed label. Defining a stand-in is not choosing one.
  'tabs/software/lib/tool-exec.ts',
  'tabs/metrics/lib/build/live.ts',
  'tabs/metrics/lib/build/server.ts',
  'tabs/monitoring/lib/adapters/cost.ts',
  'tabs/monitoring/lib/adapters/pipeline-health.ts',
  'tabs/monitoring/lib/adapters/run-trace.ts',
  'tabs/monitoring/lib/agent-diagnosis-core.ts',
  'tabs/monitoring/lib/types.ts',
  'tabs/software/lib/model.ts',
  // review.ts USED to decide: `securityScan(files, opts.scanMode ?? 'offline-mock')`. That
  // default is gone — the engine is decided once, in scan.ts — so it now only carries the mode.
  'tabs/software/lib/review.ts',
  'tabs/software/lib/seeded-evidence.ts',
  // Render-only: a badge over a mode the server already decided.
  'tabs/agents/ui/BuildRunPanel.tsx',
  'tabs/agents/ui/SystemView.tsx',
  'tabs/connections/ui/ConnectionBuilder.tsx',
  'tabs/connections/ui/GovernedConnections.tsx',
  'tabs/dashboards/ui/DashboardGrid.tsx',
  'tabs/data/ui/BronzePanel.tsx',
  'tabs/data/ui/DataBuilder.tsx',
  'tabs/data/ui/GoldJoinPanel.tsx',
  'tabs/data/ui/RefinePanel.tsx',
  'tabs/metrics/ui/ExploreMetric.tsx',
  'tabs/metrics/ui/MetricBuilder.tsx',
  'tabs/metrics/ui/shared.tsx',
  'tabs/monitoring/ui/SpendSection.tsx',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.next') continue;
      walk(p, out);
    } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

/** Every non-test source file under the roots that names a marker, repo-relative. */
function filesNamingAMarker(): string[] {
  const hits: string[] = [];
  for (const root of ROOTS) {
    for (const abs of walk(join(OS_UI, root))) {
      const src = readFileSync(abs, 'utf8');
      const named = MARKERS.some((m) => src.includes(m)) || MARKER_PATTERNS.some((re) => re.test(src));
      if (named) hits.push(relative(OS_UI, abs).split(sep).join('/'));
    }
  }
  return hits.sort();
}

const read = (rel: string) => readFileSync(join(OS_UI, ...rel.split('/')), 'utf8');

/** Drop block + line comments so a rule about CODE is not satisfied or broken by prose. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('TRIPWIRE: every file naming a stand-in marker is classified', () => {
  const classified = new Set([...DECIDERS, ...LABELS, ...RECOGNISERS, THE_MODULE]);
  const unclassified = filesNamingAMarker().filter((f) => !classified.has(f));
  assert.deepEqual(
    unclassified,
    [],
    'These files name a stand-in marker and are in no list. Decide which they are:\n' +
      '  • it CHOOSES to serve a stand-in       -> DECIDERS, and gate it on offlineMockAllowed()\n' +
      '  • it READS a refusal somebody produced -> RECOGNISERS\n' +
      '  • it declares / renders / defines / carries -> LABELS\n' +
      `Unclassified: ${unclassified.join(', ')}`,
  );
});

test('TRIPWIRE: no pinned entry has gone stale', () => {
  const naming = new Set(filesNamingAMarker());
  const stale = [...DECIDERS, ...LABELS, ...RECOGNISERS].filter((f) => !naming.has(f));
  assert.deepEqual(stale, [], `Pinned but no longer naming a marker — remove: ${stale.join(', ')}`);
});

test('TRIPWIRE: every decider imports the ONE kernel predicate', () => {
  const missing = DECIDERS.filter((f) => !read(f).includes(PREDICATE_IMPORT));
  assert.deepEqual(missing, [], `Chooses a stand-in without importing ${PREDICATE_IMPORT}: ${missing.join(', ')}`);
});

test('TRIPWIRE: every decider actually CALLS the predicate (an import alone proves nothing)', () => {
  const ungated = DECIDERS.filter((f) => {
    const src = read(f);
    return !(src.includes('offlineMockAllowed(') || src.includes('refuseOfflineMock('));
  });
  assert.deepEqual(ungated, [], `Imported but never consulted: ${ungated.join(', ')}`);
});

test('TRIPWIRE: every recogniser imports the module but never DECIDES with it', () => {
  for (const f of RECOGNISERS) {
    const src = read(f);
    assert.ok(src.includes(PREDICATE_IMPORT), `${f} must import ${PREDICATE_IMPORT} to recognise a refusal`);
    assert.equal(
      src.includes('offlineMockAllowed(') || src.includes('refuseOfflineMock('),
      false,
      `${f} is an error boundary: deciding there would be deciding after the fabrication`,
    );
  }
});

test('TRIPWIRE: no label consults the predicate — one decision point, not two', () => {
  const gating = LABELS.filter((f) => read(f).includes(PREDICATE_IMPORT));
  assert.deepEqual(
    gating,
    [],
    'A propagator that gates is a SECOND decision point: move it to DECIDERS deliberately, ' +
      `or take the gate out. Offenders: ${gating.join(', ')}`,
  );
});

test('TRIPWIRE: the kernel predicate is keyed on NODE_ENV, never on the profile the deploy omits', () => {
  const src = code(read(THE_MODULE));
  assert.match(src, /process\.env\.NODE_ENV/, 'the default must key on the variable production sets');
  assert.equal(
    /deploymentProfile|OS_PROFILE/.test(src),
    false,
    'OS_PROFILE is set nowhere in charts/, values*.yaml, deploy/ or scripts/ — keying on it is the bug',
  );
});

test('TRIPWIRE: no decider still keys its own gate on the deployment profile', () => {
  const offenders = DECIDERS.filter((f) => /deploymentProfile|OS_PROFILE/.test(code(read(f))));
  assert.deepEqual(
    offenders,
    [],
    'The profile is read from `OS_PROFILE`, which the chart, the values files, deploy/ and ' +
      `scripts/ all leave unset — so a profile-keyed honesty gate is inert on the cluster: ${offenders.join(', ')}`,
  );
});
