/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * FEATURE:    The Trivy scanner adapter — Job + payload Secret, framed result, JSON mapping
 * USER STORY: As a Builder approving a deploy I want the security verdict on the card to come
 *             from a scanner that really ran over the real files AND really resolved the
 *             dependencies, and I want every way that can fail to be visible rather than green.
 * ARCHITECTURE:
 *   Everything here runs WITHOUT a cluster: the k8s client and the pod-log reader are injected
 *   (the `runner.ts` precedent). The fixtures are pinned shapes of a real `trivy fs --format json`
 *   report; the four that matter most are the ones that USED to pass and must not:
 *     • `Results: []` over a `package.json` with no lockfile — Trivy resolved nothing (H1)
 *     • a log with a stray stderr byte in front of the JSON (M1)
 *     • a pod that shares the Job's name but belongs to a previous generation (M2)
 *     • a payload above the DEFAULT cap, with the cap NOT injected (H3)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scanJobName,
  writerScript,
  trivyArgs,
  scanPrelude,
  buildScanJobManifest,
  buildPayloadSecretManifest,
  parseScanLog,
  dbUpdatedAt,
  mapTrivyReport,
  runTrivyScan,
  DEFAULT_MAX_PAYLOAD,
  MAX_FINDINGS,
  SCAN_MOUNT,
  VERSION_DELIM,
  REPORT_DELIM,
  type ScanK8s,
  type ScanK8sText,
} from './scan-trivy.ts';
import type { ScaffoldFile } from '@tabs/software/lib/model';

const NS = 'agentic-os';
const IMAGE = 'aquasec/trivy:0.58.2';
const JOBS = `/apis/batch/v1/namespaces/${NS}/jobs`;
const SECRETS = `/api/v1/namespaces/${NS}/secrets`;
const NAME = 'os-scan-shop-abc123';
const UID = '11111111-2222-3333-4444-555555555555';

/** The tree our own scaffolds actually produce: a manifest, NO lockfile. */
const FILES: ScaffoldFile[] = [
  { path: 'package.json', content: JSON.stringify({ dependencies: { lodash: '4.17.20' } }) },
  { path: 'src/index.ts', content: 'export const ok = 1;\n' },
];
/** A tree with nothing to resolve — no dependency manifest at all. */
const NO_DEPS: ScaffoldFile[] = [{ path: 'README.md', content: '# hi\n' }];
/** A tree Trivy can actually resolve. */
const LOCKED: ScaffoldFile[] = [
  { path: 'package.json', content: '{}' },
  { path: 'package-lock.json', content: '{"lockfileVersion":3}' },
];

const ARGS = trivyArgs({ dbMode: 'mirror', dbRepository: 'ghcr.io/aquasecurity/trivy-db' });

// ------------------------------------------------------------------ fixtures ----

const CLEAN = JSON.stringify({
  SchemaVersion: 2,
  CreatedAt: '2026-11-19T00:00:00Z',
  ArtifactName: '/work',
  ArtifactType: 'filesystem',
  Results: [],
});

/** A report that DID resolve a dependency tree and found a HIGH plus a MEDIUM. */
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

const VERSION_JSON = JSON.stringify({
  Version: '0.58.2',
  VulnerabilityDB: { UpdatedAt: '2026-11-18T12:00:00Z', NextUpdate: '2026-11-19T18:00:00Z' },
});

/** A realistic pod log: Trivy's stderr chatter, then our two framed sections. */
const logFor = (report: string, version = VERSION_JSON, noise = '2026-11-19T00:00:01Z INFO Need to update DB\n') =>
  `${noise}${VERSION_DELIM}\n${version}\n${REPORT_DELIM}\n${report}\n`;

// --------------------------------------------------------------------- naming ---

test('scanJobName is deterministic, RFC1123-safe and bounded', () => {
  assert.equal(scanJobName('shop', 'abc123'), NAME);
  assert.equal(scanJobName('My_Cool App', 'abc123'), 'os-scan-my-cool-app-abc123');
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
  assert.ok(!script.script.includes('whoami'), 'file content must not be inlined literally');
  const b64 = Buffer.from('# hi $(whoami) `id` "quoted"\n').toString('base64');
  assert.ok(script.script.includes(b64), 'content must be carried as base64');
  assert.match(script.script, /base64 -d > '\/work\/README\.md'/);
});

test('a repeated path is written ONCE, keeping the last content', () => {
  const r = writerScript([
    { path: 'a.ts', content: 'first' },
    { path: 'a.ts', content: 'second' },
  ]);
  assert.ok(r.ok);
  if (!r.ok) return;
  const writes = [...r.script.matchAll(/base64 -d > '\/work\/a\.ts'/g)];
  assert.equal(writes.length, 1, 'one path, one write');
  assert.ok(r.script.includes(Buffer.from('second').toString('base64')));
  assert.ok(!r.script.includes(Buffer.from('first').toString('base64')));
});

test('an unsafe path FAILS CLOSED instead of being silently skipped', () => {
  for (const bad of ['/etc/passwd', '../escape.ts', 'a/../../b.ts', "we're-odd.ts", 'x$y.ts']) {
    const r = writerScript([{ path: bad, content: 'x' }]);
    assert.equal(r.ok, false, `${bad} must be refused`);
    if (r.ok) continue;
    assert.equal(r.kind, 'scan-failed');
    assert.match(r.reason, /path/i);
    assert.ok(r.reason.includes(bad), 'the reason must name the offending path');
  }
});

test('the DEFAULT payload cap is a Secret-sized one, and it refuses rather than truncating', () => {
  // NOT injected: this pins the shipped default. It must be far above Linux MAX_ARG_STRLEN
  // (128 KiB) — the limit that made the previous env-var delivery fail with E2BIG on any real
  // app — and below a Kubernetes Secret's ~1 MiB ceiling.
  assert.ok(DEFAULT_MAX_PAYLOAD > 256 * 1024, 'a 128 KiB-class cap is the defect, not the fix');
  assert.ok(DEFAULT_MAX_PAYLOAD < 1024 * 1024, 'a Secret is capped near 1 MiB');

  const under = writerScript([{ path: 'big.bin', content: 'A'.repeat(300 * 1024) }]);
  assert.equal(under.ok, true, 'a 300 KiB file must scan — this is a normal app');

  const over = writerScript([{ path: 'big.bin', content: 'A'.repeat(2 * 1024 * 1024) }]);
  assert.equal(over.ok, false);
  if (over.ok) return;
  assert.match(over.reason, /too large/i);
  assert.match(over.reason, /Secret/, 'the reason names the real ceiling');
});

// ----------------------------------------------------------------- trivy args ---

test('trivyArgs writes to a FILE, and mirror/offline differ as documented', () => {
  assert.deepEqual(ARGS.slice(0, 2), ['fs', '--quiet']);
  assert.ok(ARGS.includes('--format') && ARGS.includes('json'));
  assert.ok(ARGS.includes('--scanners') && ARGS.includes('vuln,secret'));
  // M1: the report goes to a file, never to the merged stdout stream.
  assert.ok(ARGS.includes('--output'), 'the report must not be read off stdout');
  assert.ok(ARGS.some((a) => a.endsWith('.json')));
  assert.ok(ARGS.includes('--db-repository'));
  assert.ok(!ARGS.includes('--skip-db-update'));
  assert.equal(ARGS[ARGS.length - 1], '/work');

  const offline = trivyArgs({ dbMode: 'offline', dbRepository: 'ignored' });
  assert.ok(offline.includes('--skip-db-update'));
  assert.ok(offline.includes('--skip-java-db-update'));
  assert.ok(offline.includes('--offline-scan'));
  assert.ok(!offline.includes('--db-repository'), 'offline must not reach for a registry');
});

test('the prelude runs the mounted writer, then frames version + report', () => {
  const cmd = scanPrelude(ARGS);
  assert.ok(cmd.startsWith('set -e'), 'a failed writer must fail the Job');
  assert.ok(cmd.includes(`sh ${SCAN_MOUNT}/write.sh`), 'the tree comes from the mounted Secret');
  assert.ok(!cmd.includes('OS_SCAN_PAYLOAD'), 'the env-var delivery is gone (MAX_ARG_STRLEN)');
  assert.ok(cmd.includes('trivy version --format json'), 'the DB age is evidence the card shows');
  assert.ok(cmd.indexOf(VERSION_DELIM) < cmd.indexOf(REPORT_DELIM), 'version first, report last');
  assert.ok(cmd.trimEnd().endsWith('cat /tmp/os-scan-report.json'), 'the report is the last thing printed');
});

// -------------------------------------------------------------- job manifest ----

test('the Job manifest is hardened, labelled for the NetworkPolicy and self-reaping', () => {
  const resources = { requests: { cpu: '100m', memory: '256Mi' }, limits: { cpu: '1', memory: '1Gi' } };
  const m = buildScanJobManifest({ name: NAME, namespace: NS, image: IMAGE, args: ARGS, timeoutMs: 180_000, resources });
  const spec = m.spec as Record<string, unknown>;
  const tmpl = (spec.template as Record<string, unknown>).spec as Record<string, unknown>;
  const c = (tmpl.containers as Record<string, unknown>[])[0];

  assert.equal((m.metadata as Record<string, unknown>).namespace, NS);
  const labels = ((spec.template as Record<string, unknown>).metadata as Record<string, unknown>)
    .labels as Record<string, string>;
  assert.equal(labels['app.kubernetes.io/component'], 'software-scanner', 'the NetworkPolicy selector');

  assert.equal(spec.backoffLimit, 0, 'a retry would just double the wall clock of a failing scan');
  assert.equal(spec.activeDeadlineSeconds, 180);
  assert.ok(typeof spec.ttlSecondsAfterFinished === 'number', 'finished scan Jobs must self-delete');
  assert.equal(tmpl.restartPolicy, 'Never');
  assert.equal(tmpl.automountServiceAccountToken, false, 'the scanner needs no API access of its own');

  const podSec = tmpl.securityContext as Record<string, unknown>;
  assert.equal(podSec.runAsNonRoot, true);
  assert.deepEqual(podSec.seccompProfile, { type: 'RuntimeDefault' });
  const sec = c.securityContext as Record<string, unknown>;
  assert.equal(sec.allowPrivilegeEscalation, false);
  assert.equal(sec.readOnlyRootFilesystem, true);
  assert.deepEqual((sec.capabilities as Record<string, unknown>).drop, ['ALL']);
  assert.deepEqual(sec.seccompProfile, { type: 'RuntimeDefault' });

  assert.equal(c.image, IMAGE);
  // The limits actually reach the container — a Job with none can starve the node it scans on.
  assert.deepEqual(c.resources, resources);

  // THE SOURCE TRAVELS IN A MOUNTED SECRET, not an env var (MAX_ARG_STRLEN / audit-log exposure).
  const env = (c.env as { name: string; value: string }[]).map((e) => e.name);
  assert.ok(!env.includes('OS_SCAN_PAYLOAD'), 'no payload in the environment');
  assert.ok(env.includes('TRIVY_CACHE_DIR'));
  const mounts = c.volumeMounts as Record<string, unknown>[];
  const payload = mounts.find((v) => v.name === 'payload');
  assert.ok(payload, 'the payload volume is mounted');
  assert.equal(payload.mountPath, SCAN_MOUNT);
  assert.equal(payload.readOnly, true);
  const vol = (tmpl.volumes as Record<string, unknown>[]).find((v) => v.name === 'payload');
  assert.deepEqual(vol?.secret, { secretName: NAME, defaultMode: 0o400 });
});

test('the payload Secret is OWNED by its Job, so Kubernetes garbage-collects the source', () => {
  const sec = buildPayloadSecretManifest({ name: NAME, namespace: NS, script: 'set -e\n', jobUid: UID });
  assert.equal(sec.kind, 'Secret');
  assert.equal(sec.type, 'Opaque');
  const meta = sec.metadata as Record<string, unknown>;
  assert.equal(meta.name, NAME);
  assert.equal(meta.namespace, NS);
  const owners = meta.ownerReferences as Record<string, unknown>[];
  assert.equal(owners.length, 1);
  assert.equal(owners[0].kind, 'Job');
  assert.equal(owners[0].uid, UID, 'owned by the exact Job generation, not merely its name');
  assert.deepEqual(sec.stringData, { 'write.sh': 'set -e\n' });
});

// --------------------------------------------------------------- the log framing --

test('parseScanLog discards stderr noise before the frames', () => {
  const r = parseScanLog(logFor(CLEAN));
  assert.ok(!('ok' in r));
  if ('ok' in r) return;
  assert.equal(JSON.parse(r.report).SchemaVersion, 2);
  assert.equal(dbUpdatedAt(r.version), '2026-11-18T12:00:00Z');
});

test('a log with NO report delimiter is a failure, not an empty clean scan', () => {
  for (const bad of ['', 'INFO: downloading DB\n', `${VERSION_DELIM}\n${VERSION_JSON}\n`]) {
    const r = parseScanLog(bad);
    assert.ok('ok' in r, `${JSON.stringify(bad)} must not yield a report`);
    if (!('ok' in r)) continue;
    assert.equal(r.kind, 'scan-failed');
    assert.match(r.reason, /delimiter/i);
  }
});

test('dbUpdatedAt is honest about a version blob it cannot read', () => {
  assert.equal(dbUpdatedAt(''), null);
  assert.equal(dbUpdatedAt('{}'), null);
  assert.equal(dbUpdatedAt('not json'), null);
});

// ------------------------------------------------------------------- mapping ----

test('FIXTURE clean, over a tree with NOTHING to resolve → passed, sast NOT RUN', () => {
  const r = mapTrivyReport(CLEAN, NO_DEPS);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.findings, []);
  assert.equal(r.passed, true);
  assert.deepEqual(r.notRun, ['sast'], 'sast is never claimed; deps had nothing to resolve');
  assert.equal(r.reason, undefined);
});

test('H1: `Results: []` over a package.json with NO lockfile must NOT pass', () => {
  const r = mapTrivyReport(CLEAN, FILES);
  assert.ok(r.ok);
  if (!r.ok) return;
  // The defect this pins: Trivy's npm analyser reads LOCKFILES. Our scaffolds commit none, so an
  // empty `Results` is "nothing was resolved", not "nothing is wrong" — and the old baseline it
  // replaced would have flagged lodash 4.17.20 from the manifest.
  assert.equal(r.passed, false, 'an unresolved dependency tree is not a clean dependency tree');
  assert.ok(r.notRun.includes('deps'), 'deps must be reported NOT RUN');
  assert.ok(r.notRun.includes('sast'));
  assert.match(r.reason ?? '', /lockfile/i, 'and the reason must name the cause');
  assert.ok((r.reason ?? '').includes('package.json'), 'and the manifest it saw');
  assert.match(r.reason ?? '', /secret scan DID run/i, 'while saying what DID happen');
});

test('H1: a lockfile present but still no lang-pkgs result is also NOT a pass', () => {
  const r = mapTrivyReport(CLEAN, LOCKED);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.passed, false);
  assert.ok(r.notRun.includes('deps'));
  assert.ok((r.reason ?? '').includes('package-lock.json'));
  assert.match(r.reason ?? '', /unsupported/i, 'the other explanation, named');
});

test('H1: a report that DID resolve the tree covers deps', () => {
  const r = mapTrivyReport(VULNERABLE, LOCKED);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.notRun, ['sast'], 'deps WAS covered — a lang-pkgs result proves it');
  assert.equal(r.reason, undefined);
  assert.equal(r.summary.deps, 2);
  assert.equal(r.passed, false, 'HIGH blocks');
  const high = r.findings.find((f) => f.severity === 'high');
  assert.ok(high);
  assert.equal(high.category, 'deps');
  assert.equal(high.path, 'package-lock.json');
  assert.ok(high.title.includes('lodash') && high.title.includes('4.17.20'));
  assert.ok(high.title.includes('CVE-2021-23337'));
  assert.ok(high.detail.includes('4.17.21'), 'the fixed version is the actionable half');
  assert.ok(r.findings.some((f) => f.severity === 'medium'));
});

test('FIXTURE secret: a committed credential is CRITICAL and always blocks', () => {
  const r = mapTrivyReport(SECRET, NO_DEPS);
  assert.ok(r.ok);
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
    const r = mapTrivyReport(bad, NO_DEPS);
    assert.equal(r.ok, false, `${JSON.stringify(bad)} must not map to a verdict`);
    if (r.ok) continue;
    assert.equal(r.kind, 'scan-failed');
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
    [{ path: 'requirements.txt', content: 'p==1\n' }],
  );
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.findings[0].severity, 'info');
  assert.equal(r.passed, true);
});

test('a flood of findings is capped, and the card says the verdict covers them all', () => {
  const many = Array.from({ length: MAX_FINDINGS + 25 }, (_, i) => ({
    VulnerabilityID: `CVE-${i}`,
    PkgName: `p${i}`,
    InstalledVersion: '1',
    Severity: 'LOW',
  }));
  const r = mapTrivyReport(
    JSON.stringify({ SchemaVersion: 2, Results: [{ Target: 'package-lock.json', Class: 'lang-pkgs', Vulnerabilities: many }] }),
    LOCKED,
  );
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.findings.length, MAX_FINDINGS + 1, 'the cap plus one line saying so');
  assert.equal(r.summary.deps, MAX_FINDINGS + 25, 'the SUMMARY still counts every one');
  assert.match(r.findings[r.findings.length - 1].title, /further finding/);
});

// ------------------------------------------------------------------ the Job -----

type Responder = (method: string, path: string, body?: unknown) => { status: number; body?: Record<string, unknown> };

function mockK8s(responder: Responder) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const client: ScanK8s = async (method, path, body) => {
    calls.push({ method, path, body });
    const r = responder(method, path, body);
    return { status: r.status, body: r.body ?? {} };
  };
  return { client, calls };
}

/** The happy-path cluster: delete ok, job created with a uid, secret created, pod owned by it. */
function cluster(opts: {
  jobStatus: Record<string, unknown>;
  uid?: string | null;
  podOwnerUid?: string;
  podName?: string;
  jobCreate?: number;
  secretCreate?: number;
}): Responder {
  const uid = opts.uid === null ? undefined : (opts.uid ?? UID);
  return (method, path) => {
    if (method === 'DELETE') return { status: 200 };
    if (method === 'POST' && path === JOBS) {
      return { status: opts.jobCreate ?? 201, body: uid ? { metadata: { name: NAME, uid } } : {} };
    }
    if (method === 'POST' && path === SECRETS) return { status: opts.secretCreate ?? 201 };
    if (method === 'GET' && path.startsWith(`${JOBS}/`)) {
      return { status: 200, body: { metadata: { name: NAME, uid }, status: opts.jobStatus } };
    }
    if (method === 'GET' && path.includes('/pods?')) {
      return {
        status: 200,
        body: {
          items: [
            {
              metadata: {
                name: opts.podName ?? `${NAME}-xyz`,
                ownerReferences: [{ kind: 'Job', name: NAME, uid: opts.podOwnerUid ?? uid ?? 'none' }],
              },
            },
          ],
        },
      };
    }
    return { status: 404 };
  };
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

test('a SUCCEEDED Job yields a live verdict, and names the DB it used', async () => {
  const { client, calls } = mockK8s(cluster({ jobStatus: { succeeded: 1 } }));
  const out = await runTrivyScan('shop', LOCKED, { ...OPTS, k8s: client, k8sText: textOf(logFor(VULNERABLE)) });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.summary.deps, 2);
  assert.equal(out.passed, false);
  // M5: the approver can tell a fresh mirror fetch from a stale baked DB.
  assert.ok(out.engine.includes('mirror'), `engine must name the db mode: ${out.engine}`);
  assert.ok(out.engine.includes('2026-11-18T12:00:00Z'), 'and the DB vintage');

  // The Job is created, then the payload Secret owned by it, then the Secret is dropped once read.
  assert.ok(calls.some((c) => c.method === 'POST' && c.path === JOBS));
  const secret = calls.find((c) => c.method === 'POST' && c.path === SECRETS);
  assert.ok(secret, 'the payload Secret is created');
  const owners = ((secret.body as Record<string, unknown>).metadata as Record<string, unknown>).ownerReferences as Record<string, unknown>[];
  assert.equal(owners[0].uid, UID);
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.path === `${SECRETS}/${NAME}`), 'and deleted after the read');
});

test('M5: offline mode says so, and says when the DB age is unknown', async () => {
  const { client } = mockK8s(cluster({ jobStatus: { succeeded: 1 } }));
  const out = await runTrivyScan('shop', LOCKED, {
    ...OPTS,
    dbMode: 'offline',
    k8s: client,
    k8sText: textOf(logFor(CLEAN, '{}')),
  });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.ok(out.engine.includes('offline'), out.engine);
  assert.match(out.engine, /age UNKNOWN/, 'a baked DB of unknown vintage must not look fresh');
});

test('M2: a pod that only SHARES the name is refused — it may be a previous generation', async () => {
  const { client } = mockK8s(cluster({ jobStatus: { succeeded: 1 }, podOwnerUid: 'some-older-job-uid' }));
  const out = await runTrivyScan('shop', LOCKED, { ...OPTS, k8s: client, k8sText: textOf(logFor(CLEAN)) });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.kind, 'scan-failed');
  assert.match(out.reason, /owned by it|previous scan/i);
});

test('M2: the pod query selects on the Job UID, not its name', async () => {
  const { client, calls } = mockK8s(cluster({ jobStatus: { succeeded: 1 } }));
  await runTrivyScan('shop', LOCKED, { ...OPTS, k8s: client, k8sText: textOf(logFor(CLEAN)) });
  const q = calls.find((c) => c.path.includes('/pods?'));
  assert.ok(q);
  assert.ok(q.path.includes(encodeURIComponent(`controller-uid=${UID}`)), q.path);
  assert.ok(!q.path.includes('job-name'), 'a name selector is what let a stale pod through');
});

test('a Job with no UID is refused rather than guessed at', async () => {
  const { client } = mockK8s(cluster({ jobStatus: { succeeded: 1 }, uid: null }));
  const out = await runTrivyScan('shop', LOCKED, { ...OPTS, k8s: client, k8sText: textOf(logFor(CLEAN)) });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.match(out.reason, /UID/);
});

test('M1: a log contaminated with stderr before the JSON still scans', async () => {
  const { client } = mockK8s(cluster({ jobStatus: { succeeded: 1 } }));
  const noisy = logFor(VULNERABLE, VERSION_JSON, '{"not":"the report"}\nWARN: db is stale\n\u0000\n');
  const out = await runTrivyScan('shop', LOCKED, { ...OPTS, k8s: client, k8sText: textOf(noisy) });
  assert.equal(out.ok, true, 'the framing makes stray output harmless');
  if (!out.ok) return;
  assert.equal(out.summary.deps, 2);
});

test('M1: a log whose report section is missing is unavailable, not clean', async () => {
  const { client } = mockK8s(cluster({ jobStatus: { succeeded: 1 } }));
  const out = await runTrivyScan('shop', LOCKED, { ...OPTS, k8s: client, k8sText: textOf('INFO: ran, printed nothing\n') });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.match(out.reason, /delimiter/i);
});

test('a FAILED Job is unavailable with the failure as its reason — never a pass', async () => {
  const { client } = mockK8s(
    cluster({
      jobStatus: { failed: 1, conditions: [{ type: 'Failed', reason: 'BackoffLimitExceeded', message: 'pod failed' }] },
    }),
  );
  const out = await runTrivyScan('shop', LOCKED, { ...OPTS, k8s: client, k8sText: textOf(logFor(CLEAN)) });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.kind, 'scan-failed');
  assert.match(out.reason, /failed/i);
  assert.ok(out.reason.includes('BackoffLimitExceeded') || out.reason.includes('pod failed'));
});

test('a Job that never completes within the deadline is unavailable, and is reaped', async () => {
  let t = 0;
  const { client, calls } = mockK8s(cluster({ jobStatus: { active: 1 } }));
  const out = await runTrivyScan('shop', LOCKED, {
    ...OPTS,
    k8s: client,
    k8sText: textOf(logFor(CLEAN)),
    timeoutMs: 1_000,
    now: () => (t += 400),
  });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.kind, 'scan-failed');
  assert.match(out.reason, /timed out|deadline/i);
  // The abandoned Job AND the app's source are cleaned up, not left for the TTL.
  assert.ok(calls.filter((c) => c.method === 'DELETE' && c.path.startsWith(`${JOBS}/`)).length >= 2);
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.path === `${SECRETS}/${NAME}`));
});

test('an unreachable API server is `no-cluster` — the one failure that may fall back', async () => {
  const { client } = mockK8s(() => ({ status: 0 }));
  const out = await runTrivyScan('shop', LOCKED, { ...OPTS, k8s: client, k8sText: textOf(logFor(CLEAN)) });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.kind, 'no-cluster', 'a laptop is not a broken scanner');
  assert.match(out.reason, /Kubernetes API/i);
});

test('a REFUSED create is `scan-failed` and names the Role it needs', async () => {
  for (const [who, resp] of [
    ['job', cluster({ jobStatus: { succeeded: 1 }, jobCreate: 403 })],
    ['secret', cluster({ jobStatus: { succeeded: 1 }, secretCreate: 403 })],
  ] as const) {
    const { client } = mockK8s(resp);
    const out = await runTrivyScan('shop', LOCKED, { ...OPTS, k8s: client, k8sText: textOf(logFor(CLEAN)) });
    assert.equal(out.ok, false, who);
    if (out.ok) continue;
    assert.equal(out.kind, 'scan-failed', '403 means a cluster EXISTS and the grant is missing');
    assert.match(out.reason, /os-ui-software-scanner Role/);
  }
});

test('L-1: a 409 on create is REFUSED — a leftover Job would hand back a stale verdict', async () => {
  // The last door into the M2 hole: 409 means a Job of this name already exists (the DELETE has
  // not finished, or another process owns it), so the UID read back belongs to THAT Job and its
  // pod log is a PREVIOUS scan's result. Accepting 409 and then GETting the UID reintroduced
  // exactly the staleness the uid check exists to prevent.
  for (const [who, resp] of [
    ['job', cluster({ jobStatus: { succeeded: 1 }, jobCreate: 409 })],
    ['secret', cluster({ jobStatus: { succeeded: 1 }, secretCreate: 409 })],
  ] as const) {
    const { client } = mockK8s(resp);
    const out = await runTrivyScan('shop', LOCKED, { ...OPTS, k8s: client, k8sText: textOf(logFor(CLEAN)) });
    assert.equal(out.ok, false, `${who}: a 409 must not be treated as success`);
    if (out.ok) continue;
    assert.equal(out.kind, 'scan-failed');
    assert.match(out.reason, /already exists/i);
    assert.match(out.reason, /previous run/i, 'and the reason says WHY it is refused');
  }
});

test('a Job that succeeds but whose log is unreadable is unavailable, not clean', async () => {
  const { client } = mockK8s(cluster({ jobStatus: { succeeded: 1 } }));
  const out = await runTrivyScan('shop', LOCKED, {
    ...OPTS,
    k8s: client,
    k8sText: async () => ({ status: 403, text: '' }),
  });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.match(out.reason, /pods\/log/);
});

test('the log read is bounded, so one runaway scan cannot exhaust the pod', async () => {
  const { client } = mockK8s(cluster({ jobStatus: { succeeded: 1 } }));
  let asked = '';
  await runTrivyScan('shop', LOCKED, {
    ...OPTS,
    k8s: client,
    k8sText: async (path) => {
      asked = path;
      return { status: 200, text: logFor(CLEAN) };
    },
  });
  assert.match(asked, /limitBytes=\d+/, 'an unbounded log read is a memory bug waiting to happen');
});

test('an unsafe path refuses BEFORE any Job or Secret is created', async () => {
  const { client, calls } = mockK8s(cluster({ jobStatus: { succeeded: 1 } }));
  const out = await runTrivyScan('shop', [{ path: '../../etc/passwd', content: 'x' }], {
    ...OPTS,
    k8s: client,
    k8sText: textOf(logFor(CLEAN)),
  });
  assert.equal(out.ok, false);
  assert.equal(calls.length, 0, 'nothing may be launched, and no source may be written');
});
