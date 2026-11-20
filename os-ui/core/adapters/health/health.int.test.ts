/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    health() against the real components (design 00 §6; WP-05 CI `health.int.test`).
 * USER STORY: As an operator I want the version on the Platform page to be exactly what the
 *             running component reports, and a stopped component to show "unreachable" — never
 *             a version.
 * ARCHITECTURE:
 *   - tests/observability/health-up.sh starts each component on the image the chart pins and
 *     writes .health-it.json ({ id: { url, expected, container } }); `expected` is the chart's tag.
 *   - Each adapter is called with that URL; its version must equal the chart's tag (VictoriaMetrics
 *     tags carry a leading `v`, which their binaries report too).
 *   - Negative twin: the container is STOPPED and the same adapter must return ok:false
 *     `unreachable`, with no version anywhere in the result. Then it is started again.
 *   - Run: HEALTH_IT=1 node --import ./scripts/test-setup.mjs --test core/adapters/health/health.int.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { ComponentHealth, Fetched } from '../_contract';
import { trinoHealth } from '../trino/health';
import { opensearchHealth } from '../opensearch/health';
import { postgresHealth } from '../postgres/health';
import { opaHealth } from '../opa/health';
import { victoriaMetricsHealth } from '../victoria-metrics/health';
import { victoriaLogsHealth } from '../victoria-logs/health';
import { otelCollectorHealth } from '../otel-collector/health';

const FILE = join(process.cwd(), '..', 'tests', 'observability', '.health-it.json');
const on = process.env.HEALTH_IT === '1';
type Target = { url: string; metricsUrl?: string; expected: string; container: string };
const targets: Record<string, Target> = on && existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {};

const probes: Record<string, (t: Target) => Promise<Fetched<ComponentHealth>>> = {
  trino: (t) => trinoHealth(t.url),
  opensearch: (t) => opensearchHealth((p) => `${t.url}${p}`),
  postgres: (t) => postgresHealth(t.url),
  opa: (t) => opaHealth(t.url),
  'victoria-metrics': (t) => victoriaMetricsHealth(t.url),
  'victoria-logs': (t) => victoriaLogsHealth(t.url),
  'otel-collector': (t) => otelCollectorHealth(t.url, t.metricsUrl),
};
const docker = (...a: string[]) => execFileSync('docker', a, { encoding: 'utf8' });

for (const [id, probe] of Object.entries(probes)) {
  test(`${id}: health() reports the version of the running container (the chart's pin)`, { skip: !on }, async () => {
    const t = targets[id];
    assert.ok(t, `${id} missing from ${FILE} — run tests/observability/health-up.sh`);
    const h = await probe(t);
    assert.ok(h.ok, `${id} not ok: ${JSON.stringify(h)}`);
    assert.equal(h.value.version, t.expected, `${id} reported ${h.value.version}, the chart pins ${t.expected}`);
    assert.equal(h.value.status, 'ready', JSON.stringify(h.value));
  });

  test(`${id}: a stopped container gives unreachable, never a version (negative twin)`, { skip: !on }, async () => {
    const t = targets[id];
    docker('stop', '-t', '2', t.container);
    try {
      const h = await probe(t);
      assert.equal(h.ok, false, `${id} still reported ${JSON.stringify(h)}`);
      if (!h.ok) assert.ok(['unreachable', 'timeout'].includes(h.reason), `${id}: ${h.reason} ${h.detail}`);
      assert.doesNotMatch(JSON.stringify(h), new RegExp(`"version":"${t.expected.replace(/\./g, '\\.')}"`));
    } finally {
      docker('start', t.container);
    }
  });
}
