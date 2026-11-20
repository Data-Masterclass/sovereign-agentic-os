/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       admin
 * FEATURE:    Every Platform version comes from the component's own health() (design 00 §8.3
 *             rule 4; WP-05).
 * USER STORY: As a platform admin I want the Version column to be what each component reports,
 *             its image tag only where it has no version endpoint (and labelled so), and the
 *             reason — never a number — when the component cannot be reached.
 * ARCHITECTURE:
 *   - `componentRow` over injected readers: the health table and the pod reader.
 *   - The versions here are random per run, so a row can only show them by having read them.
 *   - The live table is checked too: every registry component with a version endpoint is wired.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { componentRow, componentRows, imageTag, restartsOf, type PodSignal } from '@tabs/admin/lib/component-health';
import { REGISTRY, type ComponentView } from '@tabs/admin/lib/platform';
import { COMPONENT_HEALTH } from '@core/adapters/health';

const view = (id: string, status = 'running'): ComponentView => ({ ...REGISTRY.find((c) => c.id === id)!, ns: 'agentic-os', lport: 0, status });
const pods = (image: string | null, over: Partial<PodSignal> = {}) => async (): Promise<PodSignal> => ({ pods: 1, ready: 1, restarts: 0, lastReason: null, waitingReason: null, image, ...over });
const at = new Date().toISOString();

test('every row version is the one its health() returned (random per run, so it cannot be typed in)', async () => {
  const reported: Record<string, string> = {};
  const health = Object.fromEntries(Object.keys(COMPONENT_HEALTH).map((id) => {
    reported[id] = `${id}-${randomUUID().slice(0, 8)}`;
    return [id, async () => ({ ok: true as const, at, value: { version: reported[id], status: 'ready' as const } })];
  }));
  const cs = REGISTRY.filter((c) => c.id in health).map((c) => view(c.id));
  assert.ok(cs.length >= 8, 'the registry lost components with a health endpoint');
  const rows = await componentRows(cs, { health, pods: pods('example/never-shown:9.9.9'), osVersion: 'x' });
  for (const r of rows) {
    assert.equal(r.version, reported[r.id], r.id);
    assert.equal(r.versionSource, 'component', r.id);
  }
});

test('a component that cannot be reached shows the reason, never a version (not even its image tag)', async () => {
  const r = await componentRow(view('opensearch'), {
    health: { opensearch: async () => ({ ok: false as const, reason: 'unreachable' as const, detail: 'http://opensearch:9200/: ECONNREFUSED', at }) },
    pods: pods('opensearchproject/opensearch:3.7.0'),
    osVersion: 'x',
  });
  assert.equal(r.version, null);
  assert.equal(r.versionSource, 'none');
  assert.match(r.versionNote, /^unreachable: .*ECONNREFUSED/);
  assert.equal(r.health.status, 'unreachable');
});

test('a component without a version endpoint shows its running pod image tag, labelled as such', async () => {
  const r = await componentRow(view('valkey'), { health: {}, pods: pods('valkey/valkey:8.1.4@sha256:' + 'a'.repeat(64)), osVersion: 'x' });
  assert.equal(r.version, '8.1.4');
  assert.equal(r.versionSource, 'image');
  assert.match(r.versionNote, /image tag of the running pod/);
});

test('a stopped component is not probed and shows no version', async () => {
  let probed = false;
  const r = await componentRow(view('trino', 'off'), { health: { trino: async () => { probed = true; return { ok: true as const, at, value: { version: '1', status: 'ready' as const } }; } }, pods: pods(null), osVersion: 'x' });
  assert.equal(probed, false);
  assert.equal(r.version, null);
  assert.match(r.versionNote, /not running \(off\)/);
});

test('restarts are the pods\' real counts and reasons', () => {
  assert.deepEqual(restartsOf({ pods: 1, ready: 1, restarts: 0, lastReason: null, waitingReason: null, image: null }).state, 'healthy');
  const crash = restartsOf({ pods: 1, ready: 0, restarts: 7, lastReason: 'OOMKilled', waitingReason: 'CrashLoopBackOff', image: null });
  assert.equal(crash.state, 'degraded');
  assert.match(crash.note, /7 restart\(s\); last exit: OOMKilled/);
  assert.equal(restartsOf(null).state, 'unknown');
});

test('os-ui shows its running pod\'s image tag, not OS_VERSION or a default (review #1; the verifier\'s fake is the twin)', async () => {
  // The verifier's fake: 0.9.20 runs while the env says 1.0.0. The row must say 0.9.20.
  const r = await componentRow(view('os-ui'), { health: {}, pods: pods('registry.example/sovereign-os/os-ui:0.9.20'), osVersion: '1.0.0' });
  assert.equal(r.version, '0.9.20');
  assert.equal(r.versionSource, 'image');
  assert.notEqual(r.versionSource, 'component');
});

test('os-ui without a readable pod uses OS_VERSION (set by the chart), and without it says unknown', async () => {
  const fromChart = await componentRow(view('os-ui'), { health: {}, pods: async () => null, osVersion: '0.9.20' });
  assert.equal(fromChart.version, '0.9.20');
  assert.match(fromChart.versionNote, /OS_VERSION, set by the chart/);
  const unknown = await componentRow(view('os-ui'), { health: {}, pods: async () => null, osVersion: '' });
  assert.equal(unknown.version, null);
  assert.match(unknown.versionNote, /^unknown/);
});

test('config: an unset OS_VERSION is unknown (empty), never a default version', async () => {
  const { config } = await import('@core/kernel/config');
  if (process.env.OS_VERSION === undefined) assert.equal(config.osVersion, '');
});

test('imageTag reads the tag, not the digest', () => {
  assert.equal(imageTag('ghcr.io/berriai/litellm-database:1.109.1@sha256:932c'), '1.109.1');
  assert.equal(imageTag('localhost:5000/os-ui:dev'), 'dev');
  assert.equal(imageTag('localhost:5000/os-ui'), null);
  assert.equal(imageTag(null), null);
});

test('every live registry component with a known version endpoint is wired to a health() (design 00 §6 table)', () => {
  for (const id of ['trino', 'opensearch', 'opa', 'postgres', 'litellm', 'langfuse', 'dagster', 'docling', 'victoria-metrics', 'victoria-logs', 'otel-collector']) {
    assert.ok(REGISTRY.some((c) => c.id === id), `${id} not in the registry`);
    assert.equal(typeof COMPONENT_HEALTH[id], 'function', `${id} has no health()`);
  }
});
