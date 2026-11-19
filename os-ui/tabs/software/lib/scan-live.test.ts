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
 *     scan FAILED    -> `unavailable` with the cause, FULL STOP — not even where
 *                       `OS_OFFLINE_MOCK=allow` (review M6). A wired-and-broken scanner must not
 *                       be laundered into a green `offline-mock` result.
 *     NO cluster     -> delegate to `securityScan(files)`, which already decides between the
 *                       laptop's labelled `offline-mock` and a cluster's `unavailable`. The
 *                       scanner's reason is attached either way.
 *     live verdict   -> the baseline's known-bad dependency list and secret patterns are LAYERED
 *                       ON TOP (review H1): Trivy needs a lockfile, our scaffolds commit none, so
 *                       dropping the baseline would have made the live scanner a regression on
 *                       exactly the trees this product generates.
 *   The design in one line: there is no branch in which a scanner failure produces
 *   `passed: true`, and `OS_OFFLINE_MOCK` only ever decides what a LAPTOP may show.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { securityScan, resolveScan } from './scan.ts';
import { VERSION_DELIM, REPORT_DELIM, type ScanK8s, type ScanK8sText } from './scan-trivy.ts';
import type { ScaffoldFile } from '@tabs/software/lib/model';

const NS = 'agentic-os';
const JOBS = `/apis/batch/v1/namespaces/${NS}/jobs`;
const PODS_PREFIX = `GET /api/v1/namespaces/${NS}/pods?`;

/**
 * A tree Trivy can actually resolve: a manifest AND a lockfile. Without the lockfile an empty
 * `Results` means "nothing was resolved" and the mapper correctly refuses to call it clean (H1),
 * which would make every assertion here about the WRONG thing.
 */
const CLEAN_FILES: ScaffoldFile[] = [
  { path: 'package.json', content: JSON.stringify({ dependencies: { next: '^15.0.0' } }) },
  {
    // Agrees with the manifest above — a stub lock would now read as stale (lockfile-evidence.ts).
    path: 'package-lock.json',
    content: JSON.stringify({
      lockfileVersion: 3,
      packages: { '': { dependencies: { next: '^15.0.0' } }, 'node_modules/next': { version: '15.0.0' } },
    }),
  },
  { path: 'src/index.ts', content: 'export const ok = 1;\n' },
];

/** What our scaffolds really emit: a manifest, no lockfile — and a known-bad version in it. */
const SCAFFOLD_FILES: ScaffoldFile[] = [
  { path: 'package.json', content: JSON.stringify({ dependencies: { lodash: '4.17.20' } }) },
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

const TRIVY_CLEAN = JSON.stringify({
  SchemaVersion: 2,
  Results: [{ Target: 'package-lock.json', Class: 'lang-pkgs', Type: 'npm', Vulnerabilities: [] }],
});

const UID = 'job-uid-1';

function k8sFor(jobStatus: Record<string, unknown>, createStatus = 201): ScanK8s {
  return async (method, path) => {
    if (method === 'POST') return { status: createStatus, body: { metadata: { uid: UID } } };
    if (method === 'DELETE') return { status: 200, body: {} };
    if (`${method} ${path}`.startsWith(PODS_PREFIX)) {
      return {
        status: 200,
        body: { items: [{ metadata: { name: 'scan-pod', ownerReferences: [{ uid: UID }] } }] },
      };
    }
    if (path.startsWith(`${JOBS}/`)) {
      return { status: 200, body: { metadata: { uid: UID }, status: jobStatus } };
    }
    return { status: 404, body: {} };
  };
}

/** A pod log in the adapter's framing: noise, the version section, then the report. */
const logOf = (report: string): ScanK8sText => async () => ({
  status: 200,
  text:
    `INFO: scanning\n${VERSION_DELIM}\n${JSON.stringify({ VulnerabilityDB: { UpdatedAt: '2026-11-18T12:00:00Z' } })}\n` +
    `${REPORT_DELIM}\n${report}\n`,
});

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
  assert.ok((r.engine ?? '').includes('mirror'), 'and the card names the DB that answered');
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

test('OFF A CLUSTER (no API at all) the labelled baseline still answers — the teaching flow', async () => {
  // No NODE_ENV=production: `offlineMockAllowed()` is true, which is the laptop/kind flow. This is
  // the ONE failure kind allowed to fall back, because "there is no Kubernetes" is not a broken
  // scanner — and even here the card is told what was attempted.
  const down: ScanK8s = async () => ({ status: 0, body: {} });
  const r = await resolveScan('shop', CLEAN_FILES, undefined, {
    scannerEnabled: true,
    trivy: { ...LIVE_OPTS, k8s: down, k8sText: logOf(TRIVY_CLEAN) },
  });
  assert.equal(r.mode, 'offline-mock', 'the teaching flow still works on a laptop');
  assert.equal(r.passed, true);
  assert.equal(r.unavailable, undefined);
  assert.equal(r.engine, undefined, 'the baseline is not an engine and must not claim to be one');
  assert.match(r.reason ?? '', /Kubernetes API/i, 'but it says what it tried');
});

test('M6: a WIRED scanner that FAILED is `unavailable` even where offline-mock is ALLOWED', async () => {
  // The defect this pins: with OS_OFFLINE_MOCK=allow (a teaching install, or a laptop pointed at a
  // cluster) a broken scanner would have produced a GREEN offline-mock card — laundering a real
  // scan failure into a pass. The failure KIND is what separates it from the test above.
  const cases: [string, ScanK8s, string][] = [
    ['a failed Job', k8sFor({ failed: 1, conditions: [{ type: 'Failed', reason: 'OOMKilled' }] }), 'OOMKilled'],
    ['a refused create', k8sFor({ succeeded: 1 }, 403), 'os-ui-software-scanner Role'],
  ];
  for (const [what, k8s, expect] of cases) {
    const r = await resolveScan('shop', CLEAN_FILES, undefined, {
      scannerEnabled: true,
      trivy: { ...LIVE_OPTS, k8s, k8sText: logOf(TRIVY_CLEAN) },
    });
    assert.equal(r.mode, 'unavailable', `${what} must not become offline-mock`);
    assert.equal(r.passed, false);
    assert.equal(r.unavailable, true);
    assert.ok((r.reason ?? '').includes(expect), `${what}: ${r.reason}`);
  }
});

test('M6: a malformed report is `unavailable` too, with offline-mock allowed', async () => {
  const r = await resolveScan('shop', CLEAN_FILES, undefined, {
    scannerEnabled: true,
    trivy: { ...LIVE_OPTS, k8s: k8sFor({ succeeded: 1 }), k8sText: logOf('not a report') },
  });
  assert.equal(r.mode, 'unavailable');
  assert.equal(r.passed, false);
  assert.ok((r.reason ?? '').length > 0);
});

// ------------------------------------------------- the baseline, layered on top --

test('H1: the baseline known-bad list is LAYERED on a live scan that resolved nothing', async () => {
  // The real scaffold case: `package.json` with lodash 4.17.20, no lockfile. Trivy resolves
  // nothing, so on its own the card would read `deps 0` — WEAKER than the baseline it replaced.
  const r = await resolveScan('shop', SCAFFOLD_FILES, undefined, {
    scannerEnabled: true,
    trivy: {
      ...LIVE_OPTS,
      k8s: k8sFor({ succeeded: 1 }),
      k8sText: logOf(JSON.stringify({ SchemaVersion: 2, Results: [] })),
    },
  });
  assert.equal(r.mode, 'live', 'the engine DID run');
  assert.equal(r.passed, false, 'and the known-bad lodash version still blocks');
  assert.ok(r.notRun?.includes('deps'), 'while saying honestly that deps were not resolved');
  assert.match(r.reason ?? '', /lockfile/i);
  assert.ok(r.summary.deps >= 1, 'the baseline finding is counted, not just mentioned');
  assert.ok(
    r.findings.some((f) => f.category === 'deps' && f.title.includes('lodash')),
    'the finding a reviewer can act on is present',
  );
  assert.match(r.engine ?? '', /offline baseline/, 'and the card says both engines spoke');
});

test('H1: the layered baseline does not duplicate a secret the live engine already found', async () => {
  const leaked: ScaffoldFile[] = [
    { path: 'config.ts', content: 'const k = "AKIAIOSFODNN7EXAMPLE";\n' },
    { path: 'package-lock.json', content: '{"lockfileVersion":3,"packages":{"":{}}}' },
    { path: 'package.json', content: '{}' },
  ];
  const r = await resolveScan('shop', leaked, undefined, {
    scannerEnabled: true,
    trivy: {
      ...LIVE_OPTS,
      k8s: k8sFor({ succeeded: 1 }),
      k8sText: logOf(
        JSON.stringify({
          SchemaVersion: 2,
          Results: [
            { Target: 'package-lock.json', Class: 'lang-pkgs', Vulnerabilities: [] },
            { Target: 'config.ts', Class: 'secret', Secrets: [{ RuleID: 'aws-access-key-id', Title: 'AWS Access Key ID', StartLine: 1 }] },
          ],
        }),
      ),
    },
  });
  assert.equal(r.mode, 'live');
  assert.equal(r.passed, false);
  assert.equal(r.summary.secrets, 1, 'two engines naming one key is one leak, not two');
});

test('a live scan over a clean, RESOLVED tree passes with nothing layered on', async () => {
  const r = await resolveScan('shop', CLEAN_FILES, undefined, {
    scannerEnabled: true,
    trivy: { ...LIVE_OPTS, k8s: k8sFor({ succeeded: 1 }), k8sText: logOf(TRIVY_CLEAN) },
  });
  assert.equal(r.mode, 'live');
  assert.equal(r.passed, true);
  assert.deepEqual(r.notRun, ['sast']);
  assert.ok(!(r.engine ?? '').includes('baseline'), 'nothing was layered, so nothing is claimed');
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
      // And the H1 case: a live scan that resolved NOTHING over a tree that declares deps.
      await resolveScan('shop', SCAFFOLD_FILES, undefined, {
        scannerEnabled: true,
        trivy: {
          ...LIVE_OPTS,
          k8s: k8sFor({ succeeded: 1 }),
          k8sText: logOf(JSON.stringify({ SchemaVersion: 2, Results: [] })),
        },
      }),
    ];
    for (const r of outcomes) {
      assert.equal(r.passed, false, `a scan that did not run must never pass (${r.mode})`);
      assert.ok((r.reason ?? '').length > 0, 'and it must always say why');
    }
    // The first four produced no verdict at all; the last one DID run but could not see the
    // dependencies, which is a live result that is honestly not green.
    for (const r of outcomes.slice(0, 4)) assert.equal(r.mode, 'unavailable');
    assert.equal(outcomes[4].mode, 'live');
    assert.ok(outcomes[4].notRun?.includes('deps'));
  });
});
