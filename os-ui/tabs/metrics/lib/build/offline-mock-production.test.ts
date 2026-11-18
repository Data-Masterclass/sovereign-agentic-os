/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    NODE_ENV=production + the flag unset ⇒ the metric explorer fabricates NOTHING
 * USER STORY: As a user of a deployed OS I must never be shown a number that was invented because
 *             Trino was down — a KPI I cannot distinguish from a measured one is worse than a
 *             blank tile, and on 2026-11-18 the cluster served exactly that.
 * ARCHITECTURE:
 *   - The regression this pins: `metricsMustBeLive()` read `config.deploymentProfile !== 'local'`,
 *     and `OS_PROFILE` is set nowhere in the deploy, so the gate was false on the cluster and
 *     `mockRows()` — a hash-seeded demo value — was served as the answer. The gate now reads
 *     `offlineMockAllowed()`, which defaults to REFUSE under `NODE_ENV=production`.
 *   - Asserts on the ABSENCE of a fabricated datum (`rows: []`), not on the presence of a label:
 *     a label is what failed last time. The same slice is then re-run with the flag at `allow`
 *     to prove the laptop teaching flow is untouched.
 *   - Trino is mocked UNREACHABLE at the module boundary; nothing else is stubbed, so what is
 *     under test is the real `exploreMetric` composition.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { goldSales, viewerToken } from '@tabs/metrics/lib/fixtures';
import { OFFLINE_MOCK_ENV } from '@core/kernel/offline-mock';

mock.module('./live-clients.ts', { namedExports: { liveMetricsReachable: async () => false } });

const { exploreMetric } = await import('./explore-server.ts');

/** Run `body` with NODE_ENV + the switch forced, restoring both however it ends. */
async function withEnv(nodeEnv: string, flag: string | undefined, body: () => Promise<void>): Promise<void> {
  const prevNode = process.env.NODE_ENV;
  const prevFlag = process.env[OFFLINE_MOCK_ENV];
  (process.env as Record<string, string>).NODE_ENV = nodeEnv;
  if (flag === undefined) delete process.env[OFFLINE_MOCK_ENV];
  else process.env[OFFLINE_MOCK_ENV] = flag;
  try {
    await body();
  } finally {
    if (prevNode === undefined) delete process.env.NODE_ENV;
    else (process.env as Record<string, string>).NODE_ENV = prevNode;
    if (prevFlag === undefined) delete process.env[OFFLINE_MOCK_ENV];
    else process.env[OFFLINE_MOCK_ENV] = prevFlag;
  }
}

test('PRODUCTION + flag unset + Trino down ⇒ NO row, NO value, an honest outage', async () => {
  await withEnv('production', undefined, async () => {
    const d = goldSales();
    const r = await exploreMetric(d, d.measures[0], viewerToken(), { dimensions: ['Sales.region'] });
    assert.deepEqual(r.rows, [], 'not one fabricated row');
    assert.equal(r.mode, 'unavailable');
    assert.equal(r.unavailable, true);
    assert.match(r.warning ?? '', /unavailable|unreachable/i, 'the outage says so in words');
    // The old failure in one assertion: a hash-seeded number reaching the caller at all.
    assert.equal(JSON.stringify(r.rows), '[]', 'no hash-seeded value anywhere in the rows');
  });
});

test('PRODUCTION + an operator typo on the switch still refuses (closed allow-list)', async () => {
  for (const typo of ['true', 'yes', 'ALLOW', 'local']) {
    await withEnv('production', typo, async () => {
      const d = goldSales();
      const r = await exploreMetric(d, d.measures[0], viewerToken(), {});
      assert.deepEqual(r.rows, [], `${typo} must not open the door`);
      assert.equal(r.mode, 'unavailable');
    });
  }
});

test('PRODUCTION + an explicit `allow` serves the labelled teaching mock (a deliberate opt-in)', async () => {
  await withEnv('production', 'allow', async () => {
    const d = goldSales();
    const r = await exploreMetric(d, d.measures[0], viewerToken(), {});
    assert.equal(r.mode, 'offline-mock');
    assert.equal(r.rows.length, 1, 'the mock is back, and it is labelled');
  });
});

test('a laptop (NODE_ENV unset) is byte-identical to before — the teaching flow is untouched', async () => {
  await withEnv('development', undefined, async () => {
    const d = goldSales();
    const r = await exploreMetric(d, d.measures[0], viewerToken(), {});
    assert.equal(r.mode, 'offline-mock');
    assert.equal(r.rows.length, 1);
    // The hash-seeded worked example for the DE viewer — the exact value the laptop showed
    // before this change, which is what "byte-identical" has to mean to be worth asserting.
    assert.equal((r.rows[0] as Record<string, unknown>)['Sales.revenue'], 60159);
    // And the per-viewer RLS the mock exists to demonstrate still bites: a different region is
    // a different number, because the mock filters on the delegated security context.
    const fr = await exploreMetric(d, d.measures[0], viewerToken({ id: 'fleur', attributes: { region: 'FR' } }), {});
    assert.notEqual((fr.rows[0] as Record<string, unknown>)['Sales.revenue'], 60159);
  });
});
