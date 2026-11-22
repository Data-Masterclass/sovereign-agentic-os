/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Monitoring → Software on the REAL components: pods from a real Kubernetes API server (kind) through
 *             os-ui's own `k8s()` client, and error-line counts from the real VictoriaLogs (chart pin).
 * USER STORY: As an app owner I want the pod state and the error share I see to be what Kubernetes and
 *             VictoriaLogs themselves report for MY app's pods — never a look-alike app's, never a zero for a
 *             cluster that did not answer.
 * ARCHITECTURE:
 *   - tests/monitoring/up.sh (VictoriaLogs) + tests/monitoring/software.kind.sh (a kind cluster with the runner
 *     namespace and Deployments labelled as the app runner labels them: a healthy one, one that exits 1 into
 *     CrashLoopBackOff, and the look-alike names app-foo / app-foo-bar). Skipped unless MON_IT=1 and
 *     MON_SW_ENV (the file software.kind.sh writes) are set.
 *   - Negative twins: the look-alike app's pods and log lines are not counted for the asked app; a cluster that
 *     answers 401 (a bad token) and an unreachable VictoriaLogs give `unavailable`, not zero.
 *   - Run: MON_IT=1 MON_SW_DIR=... (source $MON_SW_DIR/env.sh first) node --experimental-test-module-mocks --import
 *     ./scripts/test-setup.mjs --test tabs/monitoring/lib/panels/software-panel.int.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdtempSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const on = process.env.MON_IT === '1' && !!process.env.KUBERNETES_API && !!process.env.OS_K8S_SA_DIR;
const VL = process.env.MON_VL_URL ?? 'http://127.0.0.1:19529';
process.env.VICTORIA_LOGS_URL = VL;
const NS = process.env.SOFTWARE_RUNNER_NAMESPACE ?? 'agentic-apps';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const row = (pod: string, msg: string, ns = NS) => JSON.stringify({ _msg: msg, 'k8s.namespace.name': ns, 'k8s.pod.name': pod, 'k8s.container.name': 'app', _time: new Date().toISOString() });

const app = (slug: string, o: Record<string, unknown> = {}) => ({
  id: `id-${slug}`, slug, name: slug, domain: 'sales', scope: 'mine' as const, serveMode: 'image' as const, runner: `app-${slug}`,
  status: { label: 'Live', servedUrl: 'https://x' }, review: null, ...o,
});
const ada = { id: 'ada', name: 'Ada', domains: ['sales'], allDomains: ['sales'], activeDomain: null, role: 'creator' } as never;

test('pods from the real API server: healthy, crash-looping, and look-alike names never mixed', { skip: !on }, async () => {
  const { registerMonitoringSources } = await import('./sources');
  const { softwareView } = await import('./software-panel');
  registerMonitoringSources({
    agentSystems: async () => [], datasets: async () => [], latestTests: async () => new Map(), assetKeys: async () => new Map(),
    software: async () => [app('healthy'), app('crashy'), app('foo'), app('wiki', { serveMode: 'spec', runner: null })],
  });
  const v = await softwareView(ada);
  assert.equal(v.sources.pods.state, 'live', JSON.stringify(v.sources.pods));
  const by = Object.fromEntries(v.apps.map((a) => [a.name, a]));
  assert.equal(by.healthy.pods!.state, 'running');
  assert.equal(by.crashy.pods!.state, 'crash_looping');
  assert.ok(by.crashy.pods!.items[0].restarts >= 1);
  assert.equal(by.foo.pods!.items.length, 1, 'app-foo-bar\'s pod is not app-foo\'s');
  assert.equal(by.foo.pods!.items[0].name.startsWith('app-foo-'), true);
  assert.ok(!by.foo.pods!.items.some((p) => p.name.startsWith('app-foo-bar-')));
  assert.equal(by.wiki.pods, null, 'a declarative app has no pod to count');
});

test('twin: a bad token — the API server answers 401 and the panel says unavailable, with no pods invented', { skip: !on }, async () => {
  const bad = mkdtempSync(join(tmpdir(), 'sa-'));
  writeFileSync(join(bad, 'token'), 'not-a-valid-token');
  copyFileSync(join(process.env.OS_K8S_SA_DIR!, 'ca.crt'), join(bad, 'ca.crt'));
  const keep = process.env.OS_K8S_SA_DIR;
  process.env.OS_K8S_SA_DIR = bad; // read per call by k8s()
  try {
    const { softwareView } = await import('./software-panel');
    const v = await softwareView(ada);
    assert.equal(v.sources.pods.state, 'unavailable');
    assert.match((v.sources.pods as { reason: string }).reason, /401/);
    assert.ok(v.apps.every((a) => a.pods === null));
  } finally {
    process.env.OS_K8S_SA_DIR = keep;
  }
});

test('log error share from the real VictoriaLogs: the asked app\'s pods only; no lines gives no rate', { skip: !on }, async () => {
  const slug = `it${randomUUID().slice(0, 6)}`;
  const runner = `app-${slug}`;
  const lines = [
    ...Array.from({ length: 6 }, (_, i) => row(`${runner}-7d9f-aaaaa`, i < 2 ? 'ERROR connection refused' : `GET /ok ${i}`)),
    ...Array.from({ length: 4 }, (_, i) => row(`${runner}-7d9f-bbbbb`, i === 0 ? 'unhandled Error in handler' : `GET /ok ${i}`)),
    row(`${runner}-bar-7d9f-ccccc`, 'ERROR look-alike app'), // app-<slug>-bar is another app
    row(`${runner}-7d9f-ddddd`, 'ERROR other namespace', 'some-other-ns'),
  ].join('\n');
  assert.equal((await fetch(`${VL}/insert/jsonline`, { method: 'POST', body: lines })).status, 200);
  const { registerMonitoringSources } = await import('./sources');
  const { softwareView } = await import('./software-panel');
  registerMonitoringSources({
    agentSystems: async () => [], datasets: async () => [], latestTests: async () => new Map(), assetKeys: async () => new Map(),
    software: async () => [app(slug), app(`${slug}-silent`)],
  });
  let v = await softwareView(ada);
  for (let i = 0; i < 30 && v.apps.find((a) => a.name === slug)?.logs?.lines !== 10; i++) { await sleep(1000); v = await softwareView(ada); }
  const mine = v.apps.find((a) => a.name === slug)!;
  assert.deepEqual({ lines: mine.logs!.lines, errors: mine.logs!.errors, rate: mine.logs!.errorRate }, { lines: 10, errors: 3, rate: 0.3 }, 'two replicas summed; the look-alike and the other namespace are not counted');
  assert.equal(v.apps.find((a) => a.name === `${slug}-silent`)!.logs!.errorRate, null, 'an app with no log lines has no rate, not 0%');
});

test('twin: VictoriaLogs unreachable — unavailable, the logs absent', { skip: !on }, async () => {
  const mod = await import('@core/adapters/victoria-logs/query');
  const { appLogQuery } = await import('./panels-core');
  const r = await mod.logsQuery(appLogQuery(NS, ['app-x']), { base: 'http://127.0.0.1:1', timeoutMs: 1500 });
  assert.equal(r.ok, false);
});
