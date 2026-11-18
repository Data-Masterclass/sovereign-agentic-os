/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    THE TRIPWIRE — no file may choose `offline-mock` without the kernel predicate
 * USER STORY: As a maintainer I want the tenth fabricating code path to be impossible to add
 *             quietly: the nine that existed each keyed their own gate on `OS_PROFILE`, which the
 *             deploy never set, and nothing in CI noticed for weeks because each one looked fine
 *             on its own.
 * ARCHITECTURE:
 *   - Greps every non-test `.ts`/`.tsx` under `tabs/**` and `core/**` for the string
 *     `offline-mock` and partitions the result against two PINNED lists:
 *       DECIDERS — the file CHOOSES to serve a mock. It must import `@core/kernel/offline-mock`
 *                  AND call `offlineMockAllowed(` or `refuseOfflineMock(`.
 *       LABELS   — the file only DECLARES the type, RENDERS the badge, or CARRIES a mode it was
 *                  handed. It must NOT import the module at all: a propagator that gates would be
 *                  a second decision point, which is the thing this test exists to prevent.
 *       RECOGNISERS — the file READS a refusal somebody else produced (today: the one MCP error
 *                  mapper). It must import the module, and must NOT call the predicate: deciding
 *                  at the error boundary would be deciding after the fact.
 *     A file in NEITHER list fails the test BY NAME, so the author has to classify it — and
 *     classifying it a decider immediately fails the import/call assertion until it is gated.
 *   - Follows the repo's established grep-the-tree pattern (`core/ui/charts/echarts-surface.test.ts`
 *     for the single ECharts registration, the MODEL-KEY rule for the LiteLLM master key). A
 *     structural rule a reviewer must remember is a rule that will be forgotten.
 *   - Reads the tree from disk rather than importing it: a `.tsx` cannot be imported by a test at
 *     all (Node strips types, not JSX), and the point is coverage of files, not of behaviour.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const OS_UI = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const ROOTS = ['tabs', 'core'];
const MARKER = 'offline-mock';
const PREDICATE_IMPORT = '@core/kernel/offline-mock';

/** The kernel module itself — it DEFINES the predicate, so neither list applies to it. */
const THE_MODULE = 'core/kernel/offline-mock.ts';

/**
 * Files that CHOOSE to serve an offline mock. Every one must consult the predicate.
 *
 * Each entry is a place the OS used to fabricate on the live cluster: a hash-seeded metric
 * number, an in-memory "build", a table that was never written, a domain-table verifier that
 * returned `true` because it could not check, a security scan whose engine label was a default
 * parameter, a connector op reporting "128 rows ingested" from a seed, and an agent tool answer
 * invented because no live executor was registered.
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
];

/**
 * Files that merely NAME the mode — a type union, a badge, a note in a tool description, a
 * reachability probe, or a function that carries a mode it was handed. None of them decides,
 * so none of them may gate; `tabs/data/lib/build/live-clients.ts` is the interesting case: it
 * OWNS the probes (`queryToolReachable`, `dataRunnerReachable`) but answers only "is the engine
 * up", which is a fact about the world and not a decision about honesty.
 */
const RECOGNISERS = [
  // `structuredError` is the ONE door every tool exception leaves through, so the refusal→
  // ENGINE_UNAVAILABLE mapping belongs there and nowhere else.
  'core/mcp/server.ts',
];

const LABELS = [
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
  // Types, propagators and reachability probes.
  'tabs/agents/lib/build/run-diagnostics.ts',
  'tabs/agents/lib/store.ts',
  'tabs/connections/lib/schema.ts',
  'tabs/dashboards/lib/build/panel-query.ts',
  'tabs/dashboards/ui/shared.ts',
  'tabs/data/lib/build/live-clients.ts',
  'tabs/metrics/lib/build/live.ts',
  'tabs/metrics/lib/build/server.ts',
  'tabs/monitoring/lib/adapters/cost.ts',
  'tabs/monitoring/lib/adapters/pipeline-health.ts',
  'tabs/monitoring/lib/adapters/run-trace.ts',
  'tabs/monitoring/lib/agent-diagnosis-core.ts',
  'tabs/monitoring/lib/spend.ts',
  'tabs/monitoring/lib/types.ts',
  'tabs/software/lib/model.ts',
  // review.ts USED to decide: `securityScan(files, opts.scanMode ?? 'offline-mock')`. That default
  // is gone — the engine is decided once, in scan.ts — so the file now only carries the mode.
  'tabs/software/lib/review.ts',
  'tabs/software/lib/seeded-evidence.ts',
  'tabs/connections/ui/shared.ts',
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

/** Every non-test source file under tabs/ + core/ that names the mock mode, repo-relative. */
function filesNamingTheMock(): string[] {
  const hits: string[] = [];
  for (const root of ROOTS) {
    for (const abs of walk(join(OS_UI, root))) {
      if (readFileSync(abs, 'utf8').includes(MARKER)) {
        hits.push(relative(OS_UI, abs).split(sep).join('/'));
      }
    }
  }
  return hits.sort();
}

const read = (rel: string) => readFileSync(join(OS_UI, ...rel.split('/')), 'utf8');

test('TRIPWIRE: every file naming `offline-mock` is classified as a decider or a label', () => {
  const classified = new Set([...DECIDERS, ...LABELS, ...RECOGNISERS, THE_MODULE]);
  const unclassified = filesNamingTheMock().filter((f) => !classified.has(f));
  assert.deepEqual(
    unclassified,
    [],
    'These files name `offline-mock` and are in neither list. Decide which they are:\n' +
      '  • it CHOOSES to serve a mock  -> add it to DECIDERS and gate it on offlineMockAllowed()\n' +
      '  • it only declares/renders/carries the mode -> add it to LABELS\n' +
      `Unclassified: ${unclassified.join(', ')}`,
  );
});

test('TRIPWIRE: a pinned decider that no longer names the mock has gone stale', () => {
  const naming = new Set(filesNamingTheMock());
  const stale = [...DECIDERS, ...LABELS, ...RECOGNISERS].filter((f) => !naming.has(f));
  assert.deepEqual(stale, [], `Pinned but no longer naming \`offline-mock\` — remove: ${stale.join(', ')}`);
});

test('TRIPWIRE: every decider imports the ONE kernel predicate', () => {
  const missing = DECIDERS.filter((f) => !read(f).includes(PREDICATE_IMPORT));
  assert.deepEqual(
    missing,
    [],
    `These files choose offline-mock without importing ${PREDICATE_IMPORT}: ${missing.join(', ')}`,
  );
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

/** Drop block + line comments so a rule about CODE is not satisfied or broken by prose. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

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
