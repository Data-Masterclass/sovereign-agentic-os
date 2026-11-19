/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * FEATURE:    The Trivy scanner adapter — Job manifest, file payload, JSON mapping
 * USER STORY: As a Builder approving a deploy I want the security verdict on the card to come
 *             from a scanner that really ran over the real files, and I want "the scanner could
 *             not run" to be impossible to mistake for "the scanner found nothing".
 * ARCHITECTURE:
 *   Everything here runs WITHOUT a cluster: the k8s client and the pod-log reader are injected
 *   (the `runner.ts` precedent), so the Job manifest, the payload writer and the Trivy-JSON
 *   mapper are all unit-testable. The four JSON fixtures are pinned shapes of a real
 *   `trivy fs --format json` report (clean / vulnerable / secret found / malformed); the
 *   malformed one is the important one, because the failure mode to design against is a parse
 *   error that quietly becomes a clean verdict.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scanJobName,
  writerScript,
  trivyArgs,
  buildScanJobManifest,
  mapTrivyReport,
  runTrivyScan,
  type ScanK8s,
  type ScanK8sText,
} from './scan-trivy.ts';
import type { ScaffoldFile } from '@tabs/software/lib/model';

const NS = 'agentic-os';
const IMAGE = 'aquasec/trivy:0.58.2';
const JOBS = `/apis/batch/v1/namespaces/${NS}/jobs`;
const PODS = `/api/v1/namespaces/${NS}/pods`;

const FILES: ScaffoldFile[] = [
  { path: 'package.json', content: JSON.stringify({ dependencies: { lodash: '4.17.20' } }) },
  { path: 'src/index.ts', content: 'export const ok = 1;\n' },
];

// ------------------------------------------------------------------ fixtures ----

/** A real-shaped clean report: Trivy ran, found nothing. */
const CLEAN = JSON.stringify({
  SchemaVersion: 2,
  CreatedAt: '2026-11-19T00:00:00Z',
  ArtifactName: '/work',
  ArtifactType: 'filesystem',
  Results: [],
});

/** One HIGH npm vulnerability in a lockfile. */
const VULNERABLE = JSON.stringify({
  SchemaVersion: 2,
  ArtifactName: '/work',
  Results: [
    {
      Target: 'package-lock.json',
      Class: 'lang-pkgs',
      Type: 'npm',
      Vulnerabilities: [
        {
          VulnerabilityID: 'CVE-2021-23337',
          PkgName: 'lodash',
          InstalledVersion: '4.17.20',
          FixedVersion: '4.17.21',
          Severity: 'HIGH',
          Title: 'Command injection in lodash',
          PrimaryURL: 'https://avd.aquasec.com/nvd/cve-2021-23337',
        },
        {
          VulnerabilityID: 'CVE-2020-28500',
          PkgName: 'lodash',
          InstalledVersion: '4.17.20',
          FixedVersion: '4.17.21',
          Severity: 'MEDIUM',
          Title: 'Regular expression denial of service',
        },
      ],
    },
  ],
});

/** A committed credential found by Trivy's secret scanner. */
const SECRET = JSON.stringify({
  SchemaVersion: 2,
  ArtifactName: '/work',
  Results: [
    {
      Target: 'config.ts',
      Class: 'secret',
      Secrets: [
        {
          RuleID: 'aws-access-key-id',
          Category: 'AWS',
          Severity: 'CRITICAL',
          Title: 'AWS Access Key ID',
          StartLine: 1,
          EndLine: 1,
          Match: 'const key = "****************"',
        },
      ],
    },
  ],
});

// --------------------------------------------------------------------- naming ---

test('scanJobName is deterministic, RFC1123-safe and bounded', () => {
  assert.equal(scanJobName('shop', 'abc123'), 'os-scan-shop-abc123');
  assert.equal(scanJobName('My_Cool App', 'abc123'), 'os-scan-my-cool-app-abc123');
  assert.equal(scanJobName('shop', 'abc123'), scanJobName('shop', 'abc123'));
  const long = scanJobName('x'.repeat(200), 'deadbeef');
  assert.ok(long.length <= 63, `job names must fit 63 chars, got ${long.length}`);
  assert.match(long, /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
  assert.ok(long.endsWith('deadbeef'), 'the unique suffix must survive truncation');
});

// -------------------------------------------------------------------- payload ---

test('writerScript round-trips every file, base64-encoded (no quoting hazard)', () => {
  const script = writerScript([
    { path: 'src/a.ts', content: "const s = 'it\\'s';\n" },
    { path: 'README.md', content: '# hi $(whoami) `id` "quoted"\n' },
  ]);
  assert.ok(script.ok, 'clean paths must be accepted');
  if (!script.ok) return;
  assert.match(script.script, /mkdir -p '\/work\/src'/);
  // The CONTENT never appears literally — only as base64 — so no shell metacharacter in an
  // app's source can escape the writer and run in the scanner pod.
  assert.ok(!script.script.includes('whoami'), 'file content must not be inlined literally');
  assert.ok(!script.script.includes("it\\'s"));
  const b64 = Buffer.from('# hi $(whoami) `id` "quoted"\n').toString('base64');
  assert.ok(script.script.includes(b64), 'content must be carried as base64');
  assert.match(script.script, /base64 -d > '\/work\/README\.md'/);
});

test('an unsafe path FAILS CLOSED instead of being silently skipped', () => {
  for (const bad of ['/etc/passwd', '../escape.ts', 'a/../../b.ts', "we're-odd.ts", 'x$y.ts']) {
    const r = writerScript([{ path: bad, content: 'x' }]);
    assert.equal(r.ok, false, `${bad} must be refused`);
    if (r.ok) continue;
    assert.match(r.reason, /path/i);
    assert.ok(r.reason.includes(bad), 'the reason must name the offending path');
  }
});

test('a tree larger than the payload cap is REFUSED, never truncated', () => {
  const big: ScaffoldFile[] = [{ path: 'big.bin', content: 'A'.repeat(5000) }];
  const r = writerScript(big, 1000);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.reason, /too large/i);
});

// ----------------------------------------------------------------- trivy args ---

test('trivyArgs: mirror mode fetches the DB; offline mode never does', () => {
  const mirror = trivyArgs({ dbMode: 'mirror', dbRepository: 'ghcr.io/aquasecurity/trivy-db' });
  assert.deepEqual(mirror.slice(0, 2), ['fs', '--quiet']);
  assert.ok(mirror.includes('--format') && mirror.includes('json'));
  assert.ok(mirror.includes('--scanners') && mirror.includes('vuln,secret'));
  assert.ok(mirror.includes('--db-repository'));
  assert.ok(mirror.includes('ghcr.io/aquasecurity/trivy-db'));
  assert.ok(!mirror.includes('--skip-db-update'));
  assert.equal(mirror[mirror.length - 1], '/work');

  const offline = trivyArgs({ dbMode: 'offline', dbRepository: 'ignored' });
  assert.ok(offline.includes('--skip-db-update'));
  assert.ok(offline.includes('--skip-java-db-update'));
  assert.ok(offline.includes('--offline-scan'));
  assert.ok(!offline.includes('--db-repository'), 'offline must not reach for a registry');
});

// -------------------------------------------------------------- job manifest ----

test('the Job manifest is hardened, labelled for the NetworkPolicy and self-reaping', () => {
  const m = buildScanJobManifest({
    name: 'os-scan-shop-abc123',
    namespace: NS,
    image: IMAGE,
    args: trivyArgs({ dbMode: 'mirror', dbRepository: 'ghcr.io/aquasecurity/trivy-db' }),
    payload: 'cGF5bG9hZA==',
    timeoutMs: 180_000,
    resources: { requests: { cpu: '100m', memory: '256Mi' }, limits: { cpu: '1', memory: '1Gi' } },
  });
  const spec = m.spec as Record<string, unknown>;
  const tmpl = (spec.template as Record<string, unknown>).spec as Record<string, unknown>;
  const c = (tmpl.containers as Record<string, unknown>[])[0];

  assert.equal((m.metadata as Record<string, unknown>).namespace, NS);
  // The NetworkPolicy in templates/base/os-ui/software-scanner.yaml selects on this label;
  // without it the pod silently inherits the namespace's blanket egress allows.
  const labels = ((spec.template as Record<string, unknown>).metadata as Record<string, unknown>)
    .labels as Record<string, string>;
  assert.equal(labels['app.kubernetes.io/component'], 'software-scanner');

  assert.equal(spec.backoffLimit, 0, 'a retry would just double the wall clock of a failing scan');
  assert.equal(spec.activeDeadlineSeconds, 180);
  assert.ok(typeof spec.ttlSecondsAfterFinished === 'number', 'finished scan Jobs must self-delete');
  assert.equal(tmpl.restartPolicy, 'Never');
  assert.equal(tmpl.automountServiceAccountToken, false, 'the scanner needs no API access of its own');

  const podSec = tmpl.securityContext as Record<string, unknown>;
  assert.equal(podSec.runAsNonRoot, true);
  const sec = c.securityContext as Record<string, unknown>;
  assert.equal(sec.allowPrivilegeEscalation, false);
  assert.equal(sec.readOnlyRootFilesystem, true);
  assert.deepEqual((sec.capabilities as Record<string, unknown>).drop, ['ALL']);

  assert.equal(c.image, IMAGE);
  // The payload travels as ONE env var and is decoded by the prelude — no ConfigMap, so no
  // namespace-wide configmap write in the os-ui ServiceAccount's Role.
  const env = c.env as { name: string; value: string }[];
  assert.equal(env.find((e) => e.name === 'OS_SCAN_PAYLOAD')?.value, 'cGF5bG9hZA==');
  assert.ok(env.some((e) => e.name === 'TRIVY_CACHE_DIR'));
  assert.deepEqual(c.command, ['/bin/sh', '-c']);
  const cmd = (c.args as string[])[0];
  assert.ok(cmd.includes('base64 -d'), 'the prelude decodes the payload');
  assert.ok(cmd.includes('trivy fs --quiet'), 'and then runs the pinned trivy invocation');
});

// ------------------------------------------------------------------- mapping ----

test('FIXTURE clean: Trivy ran and found nothing → passed, and sast is NOT RUN', () => {
  const r = mapTrivyReport(CLEAN);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.summary, { sast: 0, deps: 0, secrets: 0 });
  assert.equal(r.passed, true);
  // The whole point of `notRun`: `sast 0` must not be readable as "the code is fine".
  assert.deepEqual(r.notRun, ['sast']);
});

test('FIXTURE vulnerable: a HIGH dependency CVE blocks, a MEDIUM one is reported but does not', () => {
  const r = mapTrivyReport(VULNERABLE);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.summary.deps, 2);
  assert.equal(r.passed, false, 'HIGH blocks');
  const high = r.findings.find((f) => f.severity === 'high');
  assert.ok(high, 'the HIGH finding must survive the mapping');
  assert.equal(high.category, 'deps');
  assert.equal(high.path, 'package-lock.json');
  assert.ok(high.title.includes('lodash') && high.title.includes('4.17.20'));
  assert.ok(high.title.includes('CVE-2021-23337'));
  assert.ok(high.detail.includes('4.17.21'), 'the fixed version is the actionable half');
  assert.ok(r.findings.some((f) => f.severity === 'medium'));
  assert.equal(r.summary.secrets, 0);
});

test('FIXTURE secret: a committed credential is CRITICAL and always blocks', () => {
  const r = mapTrivyReport(SECRET);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.summary.secrets, 1);
  assert.equal(r.passed, false);
  const s = r.findings[0];
  assert.equal(s.category, 'secrets');
  assert.equal(s.severity, 'critical');
  assert.equal(s.path, 'config.ts');
  assert.ok(s.title.toLowerCase().includes('aws'));
  assert.ok(s.detail.includes('1'), 'the line number tells the reviewer where to look');
});

test('FIXTURE malformed: a parse failure is NEVER a clean verdict', () => {
  for (const bad of ['', 'not json at all', '{"oops": true}', '[]', 'null', '{"Results": "nope"}']) {
    const r = mapTrivyReport(bad);
    assert.equal(r.ok, false, `${JSON.stringify(bad)} must not map to a verdict`);
    if (r.ok) continue;
    assert.ok(r.reason.length > 0);
  }
});

test('an UNKNOWN severity maps to info and does not block', () => {
  const r = mapTrivyReport(
    JSON.stringify({
      SchemaVersion: 2,
      Results: [
        {
          Target: 'requirements.txt',
          Class: 'lang-pkgs',
          Vulnerabilities: [
            { VulnerabilityID: 'CVE-X', PkgName: 'p', InstalledVersion: '1', Severity: 'UNKNOWN' },
          ],
        },
      ],
    }),
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.findings[0].severity, 'info');
  assert.equal(r.passed, true);
});

// ------------------------------------------------------------------ the Job -----

/** A recording mock k8s client driven by a `METHOD path` table (+ a method fallback). */
function mockK8s(responses: Record<string, { status: number; body?: Record<string, unknown> }>) {
  const calls: { method: string; path: string }[] = [];
  const client: ScanK8s = async (method, path) => {
    calls.push({ method, path });
    for (const key of Object.keys(responses)) {
      if (key === `${method} ${path}`) return { status: responses[key].status, body: responses[key].body ?? {} };
    }
    for (const key of Object.keys(responses)) {
      if (key.endsWith('*') && `${method} ${path}`.startsWith(key.slice(0, -1))) {
        return { status: responses[key].status, body: responses[key].body ?? {} };
      }
    }
    const r = responses[method] ?? { status: 0, body: {} };
    return { status: r.status, body: r.body ?? {} };
  };
  return { client, calls };
}

const textOf = (text: string): ScanK8sText => async () => ({ status: 200, text });
const OPTS = {
  namespace: NS,
  image: IMAGE,
  dbMode: 'mirror' as const,
  dbRepository: 'ghcr.io/aquasecurity/trivy-db',
  timeoutMs: 5_000,
  runId: 'abc123',
  sleep: async () => {},
};

test('a SUCCEEDED Job yields a live verdict read from the pod log', async () => {
  const { client, calls } = mockK8s({
    [`GET ${JOBS}/os-scan-shop-abc123`]: { status: 404 },
    [`POST ${JOBS}`]: { status: 201 },
    [`GET ${JOBS}/os-scan-shop-abc123?*`]: { status: 200, body: { status: { succeeded: 1 } } },
    [`GET ${PODS}?*`]: { status: 200, body: { items: [{ metadata: { name: 'os-scan-shop-abc123-xyz' } }] } },
    GET: { status: 200, body: { status: { succeeded: 1 } } },
  });
  const out = await runTrivyScan('shop', FILES, { ...OPTS, k8s: client, k8sText: textOf(VULNERABLE) });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.summary.deps, 2);
  assert.equal(out.passed, false);
  assert.ok(out.engine.startsWith('trivy'), 'the card must name the engine that answered');
  assert.ok(calls.some((c) => c.method === 'POST' && c.path === JOBS), 'the Job is actually created');
});

test('a FAILED Job is unavailable with the failure as its reason — never a pass', async () => {
  const { client } = mockK8s({
    [`GET ${JOBS}/os-scan-shop-abc123`]: { status: 404 },
    [`POST ${JOBS}`]: { status: 201 },
    GET: { status: 200, body: { status: { failed: 1, conditions: [{ type: 'Failed', reason: 'BackoffLimitExceeded', message: 'pod failed' }] } } },
  });
  const out = await runTrivyScan('shop', FILES, { ...OPTS, k8s: client, k8sText: textOf(CLEAN) });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.match(out.reason, /failed/i);
  assert.ok(out.reason.includes('BackoffLimitExceeded') || out.reason.includes('pod failed'));
});

test('a Job that never completes within the deadline is unavailable (timeout named)', async () => {
  let t = 0;
  const { client } = mockK8s({
    [`GET ${JOBS}/os-scan-shop-abc123`]: { status: 404 },
    [`POST ${JOBS}`]: { status: 201 },
    GET: { status: 200, body: { status: { active: 1 } } },
  });
  const out = await runTrivyScan('shop', FILES, {
    ...OPTS,
    k8s: client,
    k8sText: textOf(CLEAN),
    timeoutMs: 1_000,
    now: () => (t += 400),
  });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.match(out.reason, /timed out|deadline/i);
});

test('an unreachable API server is unavailable, and says so in those words', async () => {
  const { client } = mockK8s({ GET: { status: 0 }, POST: { status: 0 } });
  const out = await runTrivyScan('shop', FILES, { ...OPTS, k8s: client, k8sText: textOf(CLEAN) });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.match(out.reason, /Kubernetes API/i);
});

test('a Job that succeeds but whose log is unreadable is unavailable, not clean', async () => {
  const { client } = mockK8s({
    [`GET ${JOBS}/os-scan-shop-abc123`]: { status: 404 },
    [`POST ${JOBS}`]: { status: 201 },
    [`GET ${PODS}?*`]: { status: 200, body: { items: [{ metadata: { name: 'p1' } }] } },
    GET: { status: 200, body: { status: { succeeded: 1 } } },
  });
  const out = await runTrivyScan('shop', FILES, {
    ...OPTS,
    k8s: client,
    k8sText: async () => ({ status: 0, text: '' }),
  });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.match(out.reason, /log|output/i);
});

test('an unsafe path refuses BEFORE any Job is created', async () => {
  const { client, calls } = mockK8s({ GET: { status: 404 }, POST: { status: 201 } });
  const out = await runTrivyScan('shop', [{ path: '../../etc/passwd', content: 'x' }], {
    ...OPTS,
    k8s: client,
    k8sText: textOf(CLEAN),
  });
  assert.equal(out.ok, false);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0, 'nothing may be launched');
});
