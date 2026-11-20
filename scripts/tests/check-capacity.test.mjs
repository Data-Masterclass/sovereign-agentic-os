/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * WP-47 — the capacity gate, the limit trims and the priority classes, against the REAL chart
 * (`helm template`, both profiles). No mocks: every assertion reads rendered manifests.
 *
 *   node --test scripts/tests/check-capacity.test.mjs
 *
 * Needs helm, the subchart .tgz files (`helm dependency build charts/sovereign-agentic-os`) and
 * js-yaml (`npm --prefix os-ui ci`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CHART = join(repo, 'charts', 'sovereign-agentic-os');
const GATE = join(repo, 'scripts', 'check-capacity.mjs');
const FIX = join(repo, 'scripts', 'tests', 'fixtures');
const yaml = createRequire(join(repo, 'os-ui', 'package.json'))('js-yaml');

const gate = (...args) => spawnSync(process.execPath, [GATE, ...args], { encoding: 'utf8', env: { ...process.env, CI: 'true' } });
const render = (...flags) =>
  yaml.loadAll(execFileSync('helm', ['template', 'agentic-os', CHART, '-n', 'agentic-os', ...flags], { encoding: 'utf8', maxBuffer: 64 << 20 })).filter(Boolean);
const STACKIT = ['-f', join(repo, 'values.stackit-managed.yaml')];
const GI = 2 ** 30;
const mem = (v) => {
  const m = /^([0-9.]+)(Ki|Mi|Gi|M|G)?$/.exec(String(v));
  return Number(m[1]) * ({ Ki: 2 ** 10, Mi: 2 ** 20, Gi: GI, M: 1e6, G: 1e9 }[m[2]] ?? 1);
};
const workload = (docs, name) => docs.find((d) => ['Deployment', 'StatefulSet'].includes(d.kind) && d.metadata.name === name);
const container = (w, name) => (w.spec.template.spec.containers ?? []).find((c) => c.name === name) ?? w.spec.template.spec.containers[0];

// ---- the gate --------------------------------------------------------------------------------
test('the gate passes on the real chart, both profiles', () => {
  const r = gate();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /profile default/);
  assert.match(r.stdout, /profile stackit/);
  assert.match(r.stdout, /check-capacity: ok/);
});

test('negative twin: a values fixture that adds 2 CPU cores of requests fails the gate', () => {
  const r = gate('--values', join(FIX, 'capacity-overcommit-cpu.yaml'));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /default: CPU requests \d+m = [\d.]+ % of 1 × allocatable, above the 85 % threshold/);
});

test('negative twin: a values fixture that over-commits memory limits fails the gate', () => {
  const r = gate('--values', join(FIX, 'capacity-overcommit-memory-limits.yaml'));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /memory limits [\d.]+Gi = [\d.]+ % .* above the 85 % threshold/);
});

test('negative twin: a container with no memory request fails the gate (it would be invisible)', () => {
  const r = gate('--values', join(FIX, 'capacity-no-memory-request.yaml'), '--profile', 'default');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /sets no memory request/);
});

test('the gate counts the pods outside the chart and the node count from capacity.yaml', () => {
  const one = JSON.parse(gate('--json', '--profile', 'default').stdout);
  const two = JSON.parse(gate('--json', '--profile', 'default', '--budget', join(FIX, 'capacity-two-nodes.yaml')).stdout);
  const o = one.results.default;
  assert.ok(o.outside.rc > 2, 'pods outside the chart add more than 2 cores of requests');
  // Two nodes: the same chart is a smaller share of twice the allocatable.
  assert.ok(two.results.default.percent.rc < o.percent.rc * 0.6);
  assert.deepEqual(two.failures, []);
});

// ---- the limit trims (00 §10.1 decision 1) ---------------------------------------------------
for (const [profile, flags] of [['default', []], ['stackit', STACKIT]]) {
  test(`${profile}: Trino 8 → 6 Gi, heap within Trino's 70–85 % guidance, per-node query memory explicit`, () => {
    const docs = render(...flags);
    const t = workload(docs, 'trino');
    assert.equal(mem(container(t, 'trino').resources.limits.memory), 6 * GI);
    const cfg = docs.find((d) => d.kind === 'ConfigMap' && d.data?.['jvm.config'] && d.data?.['config.properties']?.includes('query.max-memory'));
    assert.ok(cfg, 'the Trino ConfigMap renders');
    const heap = mem(/-Xmx(\S+)/.exec(cfg.data['jvm.config'])[1].replace(/([0-9])([MG])$/, '$1$2i'));
    assert.ok(heap >= 0.7 * 6 * GI && heap <= 0.85 * 6 * GI, `heap ${heap / GI} GiB is 70–85 % of 6 GiB`);
    const perNode = mem(/query\.max-memory-per-node=(\S+)/.exec(cfg.data['config.properties'])[1].replace('GB', 'G').replace('MB', 'M'));
    // Trino: max-memory-per-node + heap headroom (default 30 % of heap) must be below the heap.
    assert.ok(perNode + 0.3 * heap < heap, 'query.max-memory-per-node + headroom fits the heap');
  });

  test(`${profile}: LiteLLM 2 → 1.5 Gi for the proxy AND its migration init container`, () => {
    const l = workload(render(...flags), 'agentic-os-litellm');
    for (const c of [...(l.spec.template.spec.initContainers ?? []), ...l.spec.template.spec.containers]) {
      if (c.resources?.limits?.memory) assert.equal(mem(c.resources.limits.memory), 1.5 * GI, `${c.name} limit`);
    }
  });

  test(`${profile}: Langfuse web 1.5 → 1.25 Gi (Node heap capped below it), worker 1.25 → 1 Gi`, () => {
    const docs = render(...flags);
    const web = container(workload(docs, 'agentic-os-langfuse-web'), 'langfuse-web');
    assert.equal(mem(web.resources.limits.memory), 1.25 * GI);
    const opt = web.env.find((e) => e.name === 'NODE_OPTIONS')?.value ?? '';
    const oldSpace = Number(/--max-old-space-size=(\d+)/.exec(opt)?.[1]);
    assert.ok(oldSpace > 0 && oldSpace * 2 ** 20 <= 0.8 * 1.25 * GI, `old space ${oldSpace} MiB leaves headroom under 1.25 Gi`);
    const worker = container(workload(docs, 'agentic-os-langfuse-worker'), 'langfuse-worker');
    assert.equal(mem(worker.resources.limits.memory), 1 * GI);
  });
}

// ---- priority classes (00 §10.1 decision 2) --------------------------------------------------
test('priority ladder: critical > infra > app > unclassed (0) > observability > user apps', () => {
  const pcs = Object.fromEntries(render().filter((d) => d.kind === 'PriorityClass').map((d) => [d.metadata.name, d]));
  const v = (n) => {
    assert.ok(pcs[n], `PriorityClass ${n} renders`);
    return pcs[n].value;
  };
  assert.ok(v('sovereign-os-critical') > v('sovereign-os-infra'));
  assert.ok(v('sovereign-os-infra') > v('sovereign-os-app'));
  assert.ok(v('sovereign-os-app') > 0);
  assert.ok(v('sovereign-os-observability') < 0, 'below a pod with no class (upstream charts without the knob)');
  assert.ok(v('sovereign-os-user-apps') < v('sovereign-os-observability'), 'user apps are the lowest');
  assert.equal(pcs['sovereign-os-user-apps'].preemptionPolicy, 'Never', 'a user app never evicts anything');
  for (const pc of Object.values(pcs)) assert.equal(pc.globalDefault, false, `${pc.metadata.name} is not a cluster-wide default`);
  // The existing two keep their values: a PriorityClass value is immutable on upgrade.
  assert.equal(v('sovereign-os-infra'), 100000);
  assert.equal(v('sovereign-os-app'), 1000);
});

test('Postgres, OPA and os-ui run in the critical class; the data backends in infra', () => {
  const docs = render('--set', 'osUI.worker.enabled=true');
  const pc = (n) => workload(docs, n)?.spec.template.spec.priorityClassName;
  for (const n of ['pg', 'opa', 'os-ui']) assert.equal(pc(n), 'sovereign-os-critical', n);
  for (const n of ['clickhouse', 'valkey', 'opensearch-master']) assert.equal(pc(n), 'sovereign-os-infra', n);
  assert.equal(pc('os-ui-worker'), 'sovereign-os-app');
});

test('every pod the chart\'s own templates render carries a priority class', () => {
  // Subcharts without a priorityClassName value upstream (Langfuse 1.5.36, LiteLLM 1.90.0,
  // Dagster 1.13.11) are listed by name: they run at 0, above observability and user apps.
  const noUpstreamKnob = /^agentic-os-(langfuse|litellm|dagster)/;
  for (const d of render('--set', 'osUI.worker.enabled=true')) {
    if (!['Deployment', 'StatefulSet', 'DaemonSet'].includes(d.kind) || noUpstreamKnob.test(d.metadata.name)) continue;
    assert.ok(d.spec.template.spec.priorityClassName, `${d.kind}/${d.metadata.name} has a priorityClassName`);
  }
});

test('os-ui tells the app runner to start user apps in the user-apps class', () => {
  const ui = workload(render('--set', 'softwareRunner.enabled=true'), 'os-ui');
  const env = ui.spec.template.spec.containers[0].env.find((e) => e.name === 'SOFTWARE_RUNNER_PRIORITY_CLASS');
  assert.equal(env?.value, 'sovereign-os-user-apps');
  const off = workload(render('--set', 'softwareRunner.enabled=true', '--set', 'priorityClasses.enabled=false'), 'os-ui');
  assert.equal(off.spec.template.spec.containers[0].env.find((e) => e.name === 'SOFTWARE_RUNNER_PRIORITY_CLASS'), undefined,
    'no class name is passed when the chart does not create the classes (the pod would be rejected)');
});
