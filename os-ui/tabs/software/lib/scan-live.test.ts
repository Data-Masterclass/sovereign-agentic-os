/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * FEATURE:    The seam between the live Trivy scan and the deterministic baseline
 * USER STORY: As an operator I want a real scanner to decide the verdict when one can run, the
 *             laptop teaching flow to keep working when no cluster exists, and a deployed
 *             cluster to refuse a verdict rather than invent one — all from one door.
 * ARCHITECTURE:
 *   `securityScan(files, mode)` is unchanged: it is the tripwire-pinned decider from PR #56 and
 *   the producer of the baseline EVIDENCE. `resolveScan` is the new async door beside it:
 *     explicit mode  -> the caller wins (the existing injection point, and what tests use)
 *     scanner off    -> the #56 behaviour verbatim
 *     scanner on     -> Trivy; `mode: 'live'` ONLY on a completed Job
 *     Trivy refused  -> delegate to `securityScan(files)`, which already decides between the
 *                       laptop's labelled `offline-mock` and a cluster's `unavailable`. The
 *                       scanner's REAL cause replaces the generic "no scanner is wired" reason.
 *   The last line is the whole design: there is no branch in which a scanner failure produces
 *   `passed: true`, and `OS_OFFLINE_MOCK` keeps deciding whether a laptop may show the baseline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { securityScan, resolveScan } from './scan.ts';
import type { ScanK8s, ScanK8sText } from './scan-trivy.ts';
import type { ScaffoldFile } from '@tabs/software/lib/model';

const NS = 'agentic-os';
const JOBS = `/apis/batch/v1/namespaces/${NS}/jobs`;
const PODS_PREFIX = `GET /api/v1/namespaces/${NS}/pods?`;

const CLEAN_FILES: ScaffoldFile[] = [
  { path: 'package.json', content: JSON.stringify({ dependencies: { next: '^15.0.0' } }) },
  { path: 'src/index.ts', content: 'export const ok = 1;\n' },
];

const TRIVY_FOUND_A_SECRET = JSON.stringify({
  SchemaVersion: 2,
  Results: [
    {
      Target: 'config.ts',
      Class: 'secret',
      Secrets: [{ RuleID: 'aws-access-key-id', Severity: 'CRITICAL', Title: 'AWS Access Key ID', StartLine: 3 }],
    },
  ],
});

const TRIVY_CLEAN = JSON.stringify({ SchemaVersion: 2, Results: [] });

function k8sFor(jobStatus: Record<string, unknown>, createStatus = 201): ScanK8s {
  return async (method, path) => {
    if (method === 'POST') return { status: createStatus, body: {} };
    if (method === 'DELETE') return { status: 200, body: {} };
    if (`${method} ${path}`.startsWith(PODS_PREFIX)) {
      return { status: 200, body: { items: [{ metadata: { name: 'scan-pod' } }] } };
    }
    if (path.startsWith(`${JOBS}/`)) return { status: 200, body: { status: jobStatus } };
    return { status: 404, body: {} };
  };
}
const logOf = (text: string): ScanK8sText => async () => ({ status: 200, text });

const LIVE_OPTS = {
  namespace: NS,
  image: 'aquasec/trivy:0.58.2',
  dbMode: 'mirror' as const,
  dbRepository: 'ghcr.io/aquasecurity/trivy-db',
  timeoutMs: 5_000,
  runId: 'test0001',
  sleep: async () => {},
};

/** Run `fn` with `NODE_ENV=production` (and OS_OFFLINE_MOCK unset), then restore. */
async function inProduction(fn: () => Promise<void>): Promise<void> {
  const node = process.env.NODE_ENV;
  const flag = process.env.OS_OFFLINE_MOCK;
  (process.env as Record<string, string>).NODE_ENV = 'production';
  delete process.env.OS_OFFLINE_MOCK;
  try {
    await fn();
  } finally {
    if (node === undefined) delete process.env.NODE_ENV;
    else (process.env as Record<string, string>).NODE_ENV = node;
    if (flag === undefined) delete process.env.OS_OFFLINE_MOCK;
    else process.env.OS_OFFLINE_MOCK = flag;
  }
}

// ------------------------------------------------- the live path, when it works --

test('a COMPLETED Job is the only route to a live verdict', async () => {
  const r = await resolveScan('shop', CLEAN_FILES, undefined, {
    scannerEnabled: true,
    trivy: { ...LIVE_OPTS, k8s: k8sFor({ succeeded: 1 }), k8sText: logOf(TRIVY_CLEAN) },
  });
  assert.equal(r.mode, 'live');
  assert.equal(r.passed, true);
  assert.equal(r.unavailable, undefined);
  assert.ok(r.engine?.startsWith('trivy'), 'the card names the engine that answered');
  assert.deepEqual(r.notRun, ['sast'], 'sast is reported NOT RUN, never as a clean zero');
  assert.deepEqual(r.summary, { sast: 0, deps: 0, secrets: 0 });
});

test('a live scan that FINDS a secret fails the gate with the real finding', async () => {
  const r = await resolveScan('shop', CLEAN_FILES, undefined, {
    scannerEnabled: true,
    trivy: { ...LIVE_OPTS, k8s: k8sFor({ succeeded: 1 }), k8sText: logOf(TRIVY_FOUND_A_SECRET) },
  });
  assert.equal(r.mode, 'live');
  assert.equal(r.passed, false);
  assert.equal(r.unavailable, undefined, 'this is a VERDICT of failure, not an absent verdict');
  assert.equal(r.summary.secrets, 1);
  assert.equal(r.findings[0].severity, 'critical');
});

// -------------------------------------- the live path, when it cannot give a verdict --

test('ON A CLUSTER a failed Job is `unavailable` and names the real cause', async () => {
  await inProduction(async () => {
    const r = await resolveScan('shop', CLEAN_FILES, undefined, {
      scannerEnabled: true,
      trivy: {
        ...LIVE_OPTS,
        k8s: k8sFor({ failed: 1, conditions: [{ type: 'Failed', reason: 'DeadlineExceeded', message: 'job exceeded' }] }),
        k8sText: logOf(TRIVY_CLEAN),
      },
    });
    assert.equal(r.mode, 'unavailable');
    assert.equal(r.passed, false);
    assert.equal(r.unavailable, true);
    assert.ok(r.reason?.includes('DeadlineExceeded'), `the reason must carry the cause: ${r.reason}`);
    assert.ok(!/no live scanner is wired/i.test(r.reason ?? ''), 'a wired-but-failing scanner is a different fact');
  });
});

test('ON A CLUSTER an unreachable API server is `unavailable`, never a pass', async () => {
  await inProduction(async () => {
    const down: ScanK8s = async () => ({ status: 0, body: {} });
    const r = await resolveScan('shop', CLEAN_FILES, undefined, {
      scannerEnabled: true,
      trivy: { ...LIVE_OPTS, k8s: down, k8sText: logOf(TRIVY_CLEAN) },
    });
    assert.equal(r.mode, 'unavailable');
    assert.equal(r.passed, false);
    assert.match(r.reason ?? '', /Kubernetes API/i);
  });
});

test('ON A CLUSTER a scan that timed out is `unavailable` with the timeout as its reason', async () => {
  await inProduction(async () => {
    let t = 0;
    const r = await resolveScan('shop', CLEAN_FILES, undefined, {
      scannerEnabled: true,
      trivy: {
        ...LIVE_OPTS,
        k8s: k8sFor({ active: 1 }),
        k8sText: logOf(TRIVY_CLEAN),
        timeoutMs: 1_000,
        now: () => (t += 400),
      },
    });
    assert.equal(r.mode, 'unavailable');
    assert.match(r.reason ?? '', /timed out/i);
  });
});

test('ON A CLUSTER a disabled scanner is `unavailable` and says the flag is off', async () => {
  await inProduction(async () => {
    const r = await resolveScan('shop', CLEAN_FILES, undefined, { scannerEnabled: false });
    assert.equal(r.mode, 'unavailable');
    assert.equal(r.passed, false);
    assert.match(r.reason ?? '', /osUI\.software\.scanner\.enabled/);
  });
});

test('the REAL findings survive a refused verdict — refusing a verdict is not hiding evidence', async () => {
  await inProduction(async () => {
    const leaked: ScaffoldFile[] = [{ path: 'config.ts', content: 'const k = "AKIAIOSFODNN7EXAMPLE";\n' }];
    const down: ScanK8s = async () => ({ status: 0, body: {} });
    const r = await resolveScan('shop', leaked, undefined, {
      scannerEnabled: true,
      trivy: { ...LIVE_OPTS, k8s: down, k8sText: logOf(TRIVY_CLEAN) },
    });
    assert.equal(r.mode, 'unavailable');
    assert.ok(r.findings.some((f) => f.category === 'secrets'), 'the baseline evidence is still returned');
  });
});

// ------------------------------------------------------ the laptop teaching flow --

test('OFF A CLUSTER an unreachable scanner falls back to the labelled baseline, unchanged', async () => {
  // No NODE_ENV=production: `offlineMockAllowed()` is true, which is the laptop/kind flow.
  const down: ScanK8s = async () => ({ status: 0, body: {} });
  const r = await resolveScan('shop', CLEAN_FILES, undefined, {
    scannerEnabled: true,
    trivy: { ...LIVE_OPTS, k8s: down, k8sText: logOf(TRIVY_CLEAN) },
  });
  assert.equal(r.mode, 'offline-mock', 'the teaching flow is byte-identical to before this change');
  assert.equal(r.passed, true);
  assert.equal(r.unavailable, undefined);
  assert.equal(r.engine, undefined, 'the baseline is not an engine and must not claim to be one');
});

test('an EXPLICIT mode from the caller still wins (the pre-existing injection point)', async () => {
  const r = await resolveScan('shop', CLEAN_FILES, 'offline-mock', { scannerEnabled: true });
  assert.equal(r.mode, 'offline-mock');
  const l = await resolveScan('shop', CLEAN_FILES, 'live', { scannerEnabled: true });
  assert.equal(l.mode, 'live');
});

// --------------------------------------------------------------- the #56 tripwire --

test('TRIPWIRE: `securityScan` still has NO mock default, and no path fakes a pass', async () => {
  await inProduction(async () => {
    // (a) the synchronous decider, untouched by this change.
    const base = securityScan(CLEAN_FILES);
    assert.equal(base.mode, 'unavailable');
    assert.equal(base.passed, false);
    assert.equal(base.unavailable, true);

    // (b) every way the live path can fail, over a CLEAN tree — the tempting case, because the
    //     baseline would have said `passed: true` and the whole defect PR #56 fixed was a green
    //     tick from an engine that never ran.
    const down: ScanK8s = async () => ({ status: 0, body: {} });
    const outcomes = [
      await resolveScan('shop', CLEAN_FILES, undefined, { scannerEnabled: false }),
      await resolveScan('shop', CLEAN_FILES, undefined, {
        scannerEnabled: true,
        trivy: { ...LIVE_OPTS, k8s: down, k8sText: logOf(TRIVY_CLEAN) },
      }),
      await resolveScan('shop', CLEAN_FILES, undefined, {
        scannerEnabled: true,
        trivy: { ...LIVE_OPTS, k8s: k8sFor({ failed: 1 }), k8sText: logOf(TRIVY_CLEAN) },
      }),
      await resolveScan('shop', CLEAN_FILES, undefined, {
        scannerEnabled: true,
        trivy: { ...LIVE_OPTS, k8s: k8sFor({ succeeded: 1 }), k8sText: logOf('not a report') },
      }),
    ];
    for (const r of outcomes) {
      assert.equal(r.passed, false, `a scan that did not run must never pass (${r.mode})`);
      assert.equal(r.mode, 'unavailable');
      assert.ok((r.reason ?? '').length > 0, 'and it must always say why');
    }
  });
});
