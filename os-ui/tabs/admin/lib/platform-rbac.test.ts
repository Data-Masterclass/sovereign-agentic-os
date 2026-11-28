/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * FEATURE:    The Platform toggle's RBAC names exactly the components the UI may toggle.
 * USER STORY: As the owner I want os-ui's write access to platform workloads to be the `/scale`
 *             subresource of the toggleable components and nothing else (2026-11-28), and I want a
 *             component added to — or removed from — the toggle list to fail a test until the chart's
 *             Role says the same, instead of 403-ing on the Platform page or granting a name nobody uses.
 * ARCHITECTURE: Reads the chart's single list (templates/base/os-ui/_os-ui-workload-rbac.tpl
 *             `soa.osUI.toggleDeployments` / `soa.osUI.toggleStatefulSets`, the `resourceNames` of the os-ui
 *             Role's `deployments/scale` / `statefulsets/scale` rules) and compares it with REGISTRY. No helm
 *             needed: scripts/check-os-ui-workload-rbac-chart.mjs checks the rendered Role.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REGISTRY } from '@tabs/admin/lib/platform';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const TPL = readFileSync(join(REPO, 'charts/sovereign-agentic-os/templates/base/os-ui/_os-ui-workload-rbac.tpl'), 'utf8');

/** The JSON list a `define "<name>"` block of the helper renders. */
function chartList(name: string): string[] {
  const m = TPL.match(new RegExp(`define "${name.replace(/\./g, '\\.')}" -}}\\s*(\\[[^\\]]*\\])`));
  assert.ok(m, `the chart defines ${name}`);
  return JSON.parse(m![1]) as string[];
}
const sorted = (xs: string[]) => [...xs].sort();

test('the os-ui Role may scale exactly the toggleable Deployments', () => {
  const want = REGISTRY.filter((c) => c.toggle && c.kind === 'deploy').map((c) => c.workload);
  assert.deepEqual(sorted(chartList('soa.osUI.toggleDeployments')), sorted(want));
});

test('the os-ui Role may scale exactly the toggleable StatefulSets', () => {
  const want = REGISTRY.filter((c) => c.toggle && c.kind === 'sts').map((c) => c.workload);
  assert.deepEqual(sorted(chartList('soa.osUI.toggleStatefulSets')), sorted(want));
});

test('only Deployments and StatefulSets are toggleable (a DaemonSet or Cluster has no /scale grant)', () => {
  for (const c of REGISTRY.filter((x) => x.toggle)) assert.ok(c.kind === 'deploy' || c.kind === 'sts', `${c.id} is ${c.kind}`);
});

test('the core components are never in the scale lists (os-ui, trino, postgres)', () => {
  const all = [...chartList('soa.osUI.toggleDeployments'), ...chartList('soa.osUI.toggleStatefulSets')];
  for (const core of ['os-ui', 'trino', 'pg']) assert.ok(!all.includes(core), `${core} must not be scalable by os-ui`);
});
