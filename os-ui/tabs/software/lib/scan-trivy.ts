/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * FEATURE:    The live security scanner — Trivy, as one Kubernetes Job per deploy request
 * USER STORY: As a Builder approving a software deploy I need the security verdict on the review
 *             card to come from a scanner that really ran over the real committed files, and I
 *             need "the scanner could not run" to be impossible to mistake for "it found nothing".
 * ARCHITECTURE:
 *   Since PR #56 `securityScan` refuses to issue a verdict no engine produced, so on a real
 *   cluster a software deploy cannot be approved until a scanner exists. This is that scanner.
 *
 *   Trivy (Apache-2.0, `aquasec/trivy`) covers the two categories the review card can honestly
 *   claim: dependency vulnerabilities read from the app's manifests/lockfiles, and committed
 *   secrets. It is NOT a SAST engine, and there is no allowlisted one to wire — Semgrep's engine
 *   is LGPL-2.1 and absent from `licenses/allowed-licenses.txt` — so `sast` is reported in
 *   `notRun` rather than as a zero count that reads like a clean bill of health.
 *
 *   It deliberately mirrors `tabs/software/lib/runner.ts`: deterministic names, an INJECTABLE
 *   k8s client so every branch is unit-testable without a cluster, and honest degradation — an
 *   unreachable API server, a failed Job, a timeout, an unreadable log or a malformed report all
 *   return `{ ok: false, reason }`, which the caller turns into `mode: 'unavailable'`. There is
 *   exactly one way to get `ok: true`: a Job that SUCCEEDED and whose stdout parsed as a Trivy
 *   report.
 *
 *   HOW THE FILES GET IN. The app tree is rendered to a generated `sh` writer script — one
 *   `mkdir -p` plus one `printf … | base64 -d > path` per file — base64-encoded into ONE
 *   container env var and run by the container's prelude. No ConfigMap, and therefore no
 *   namespace-wide `configmaps` write in the os-ui ServiceAccount's Role for what is a transient
 *   payload. Content travels as base64, so no shell metacharacter in an app's source can escape
 *   the writer; a path that is absolute, contains `..`, or carries a character outside
 *   `[A-Za-z0-9._/-]` FAILS THE SCAN CLOSED rather than being silently skipped, because a scan
 *   of a subset of the tree is not the scan the card claims.
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { k8s as liveK8s, k8sText as liveK8sText } from '@core/infra/k8s';
import type { ScanCategory, ScanFinding, ScanSeverity, ScaffoldFile } from '@tabs/software/lib/model';

export type ScanK8s = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<{ status: number; body: Record<string, unknown> }>;

export type ScanK8sText = (path: string) => Promise<{ status: number; text: string }>;

export type ScannerDbMode = 'mirror' | 'offline';

export type TrivyScanOpts = {
  k8s?: ScanK8s;
  k8sText?: ScanK8sText;
  namespace?: string;
  image?: string;
  dbMode?: ScannerDbMode;
  dbRepository?: string;
  timeoutMs?: number;
  /** Ceiling on the base64 writer payload. Above it the scan refuses (never truncates). */
  maxPayloadBytes?: number;
  resources?: ScanResources;
  /** Injected in tests for a deterministic Job name. */
  runId?: string;
  /** Injected in tests: a monotonic clock and a no-op sleep, so the poll loop is instant. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type ScanResources = {
  requests: { cpu: string; memory: string };
  limits: { cpu: string; memory: string };
};

/** The mapped report: the SAME shape `ScanResult` needs, minus the mode decision. */
export type TrivyReport = {
  ok: true;
  findings: ScanFinding[];
  summary: Record<ScanCategory, number>;
  passed: boolean;
  notRun: ScanCategory[];
};

export type TrivyFailure = { ok: false; reason: string };

export type TrivyOutcome = (TrivyReport & { engine: string }) | TrivyFailure;

/** The workspace the Job scans — a tmpfs the writer fills and trivy reads. */
const WORK = '/work';

/** `[A-Za-z0-9._/-]` only: everything else is refused rather than quoted. */
const SAFE_PATH = /^[A-Za-z0-9._/-]+$/;

/** Default ceiling on the encoded payload (bytes). A pod spec is not a file store. */
const DEFAULT_MAX_PAYLOAD = 768 * 1024;

// ------------------------------------------------------------------- naming -----

function rfc1123(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * `os-scan-<slug>-<runId>`, RFC1123-safe and bounded to 63 characters. The UNIQUE SUFFIX is
 * preserved under truncation — a truncated name that collided with another app's would have two
 * scans fighting over one Job.
 */
export function scanJobName(slug: string, runId: string): string {
  const id = rfc1123(runId) || 'scan';
  const prefix = `os-scan-${rfc1123(slug) || 'app'}`;
  const room = 63 - (id.length + 1);
  return `${prefix.slice(0, Math.max(1, room)).replace(/-+$/g, '')}-${id}`;
}

// ------------------------------------------------------------------ payload -----

export type WriterScript = { ok: true; script: string; bytes: number } | TrivyFailure;

/**
 * The `sh` script that recreates the app tree inside the scanner pod. Content is carried as
 * base64 and decoded in-pod, so nothing in an app's source is ever interpreted by the shell.
 */
export function writerScript(files: ScaffoldFile[], maxPayloadBytes = DEFAULT_MAX_PAYLOAD): WriterScript {
  const lines = ['set -e'];
  for (const f of files) {
    const path = f.path.replace(/^\.\//, '');
    if (path.startsWith('/') || path.split('/').includes('..') || !SAFE_PATH.test(path)) {
      return {
        ok: false,
        reason:
          `The app tree carries a path the scanner refuses to materialise: "${path}". A path ` +
          `must be relative, free of ".." segments and limited to [A-Za-z0-9._/-]. The scan is ` +
          `refused rather than run over a subset of the tree, because a partial scan is not the ` +
          `verdict the review card claims.`,
      };
    }
    const abs = `${WORK}/${path}`;
    const dir = abs.slice(0, abs.lastIndexOf('/'));
    lines.push(`mkdir -p '${dir}'`);
    lines.push(`printf %s '${Buffer.from(f.content, 'utf8').toString('base64')}' | base64 -d > '${abs}'`);
  }
  const script = `${lines.join('\n')}\n`;
  const bytes = Buffer.byteLength(Buffer.from(script, 'utf8').toString('base64'), 'utf8');
  if (bytes > maxPayloadBytes) {
    return {
      ok: false,
      reason:
        `The app tree is too large for the inline scan payload (${bytes} bytes encoded, ceiling ` +
        `${maxPayloadBytes}). The scan is refused rather than run over a truncated tree. Raise ` +
        `the ceiling deliberately, or scan a smaller tree.`,
    };
  }
  return { ok: true, script, bytes };
}

// --------------------------------------------------------------- trivy args -----

/**
 * The pinned invocation. `--scanners vuln,secret` and nothing else: misconfiguration findings are
 * deliberately NOT requested, because `ScanCategory` is `sast | deps | secrets` and folding
 * misconfig into `sast` would claim SAST coverage this scanner does not have.
 */
export function trivyArgs(o: { dbMode: ScannerDbMode; dbRepository: string }): string[] {
  const args = ['fs', '--quiet', '--no-progress', '--format', 'json', '--scanners', 'vuln,secret'];
  if (o.dbMode === 'offline') {
    // No registry is contacted at all: the DB must already be inside the image.
    args.push('--skip-db-update', '--skip-java-db-update', '--offline-scan');
  } else {
    args.push('--db-repository', o.dbRepository);
  }
  args.push(WORK);
  return args;
}

// -------------------------------------------------------------- job manifest ----

export function buildScanJobManifest(spec: {
  name: string;
  namespace: string;
  image: string;
  args: string[];
  payload: string;
  timeoutMs: number;
  resources: ScanResources;
}): Record<string, unknown> {
  const deadline = Math.max(30, Math.ceil(spec.timeoutMs / 1000));
  const labels = {
    'app.kubernetes.io/name': 'software-scanner',
    'app.kubernetes.io/component': 'software-scanner',
    'app.kubernetes.io/managed-by': 'os-ui',
  };
  // One shell line: decode the writer, run it, then exec trivy so the container's exit status IS
  // trivy's. `--exit-code` is NOT passed, so findings leave the Job SUCCEEDED — "the scan ran" and
  // "the scan is clean" are different facts and only the first one is the Job's business.
  const prelude =
    `set -e; mkdir -p ${WORK}; printf %s "$OS_SCAN_PAYLOAD" | base64 -d > /tmp/os-scan-write.sh; ` +
    `sh /tmp/os-scan-write.sh; exec trivy ${spec.args.join(' ')}`;
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: spec.name, namespace: spec.namespace, labels },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: deadline,
      // Self-reaping: the adapter deletes the Job it abandons, and this covers the rest
      // (a pod roll between create and poll must not leave litter in the namespace).
      ttlSecondsAfterFinished: 600,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: 'Never',
          automountServiceAccountToken: false,
          securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, fsGroup: 10001 },
          containers: [
            {
              name: 'trivy',
              image: spec.image,
              command: ['/bin/sh', '-c'],
              args: [prelude],
              env: [
                { name: 'OS_SCAN_PAYLOAD', value: spec.payload },
                // The root filesystem is read-only, so both the cache and /tmp are emptyDirs.
                { name: 'TRIVY_CACHE_DIR', value: '/tmp/trivy-cache' },
                { name: 'TRIVY_NO_PROGRESS', value: 'true' },
              ],
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
              },
              resources: spec.resources,
              volumeMounts: [
                { name: 'work', mountPath: WORK },
                { name: 'tmp', mountPath: '/tmp' },
              ],
            },
          ],
          volumes: [
            { name: 'work', emptyDir: {} },
            { name: 'tmp', emptyDir: {} },
          ],
        },
      },
    },
  };
}

// ------------------------------------------------------------------ mapping -----

const SEVERITY: Record<string, ScanSeverity> = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
  UNKNOWN: 'info',
};

const BLOCKING = new Set<ScanSeverity>(['high', 'critical']);

type TrivyVuln = {
  VulnerabilityID?: unknown;
  PkgName?: unknown;
  InstalledVersion?: unknown;
  FixedVersion?: unknown;
  Severity?: unknown;
  Title?: unknown;
  Description?: unknown;
  PrimaryURL?: unknown;
};

type TrivySecret = {
  RuleID?: unknown;
  Category?: unknown;
  Title?: unknown;
  StartLine?: unknown;
  Match?: unknown;
};

type TrivyResult = { Target?: unknown; Vulnerabilities?: unknown; Secrets?: unknown };

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' && v.length > 0 ? v : fallback);

/**
 * Map one `trivy fs --format json` report onto the review card's findings.
 *
 * A report is only accepted when it carries `SchemaVersion` — proof Trivy itself wrote it. An
 * empty or absent `Results` on such a report IS a clean verdict (a tree with no dependency
 * manifest has no vulnerable dependency, and the secret scanner read every file). Anything that
 * does not parse, or parses to something that is not a Trivy report, is a FAILURE — the one
 * outcome this whole gate exists to prevent is a parse error becoming a green tick.
 */
export function mapTrivyReport(text: string): TrivyReport | TrivyFailure {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      reason:
        `The scanner's output did not parse as JSON (${(e as Error).message}). No verdict is ` +
        `issued from unreadable output.`,
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'The scanner produced no Trivy report object; no verdict is issued.' };
  }
  const report = parsed as Record<string, unknown>;
  if (report.SchemaVersion === undefined) {
    return {
      ok: false,
      reason:
        'The scanner output carries no Trivy `SchemaVersion`, so it is not a scan report — no ' +
        'verdict is issued from it.',
    };
  }
  const raw = report.Results;
  if (raw !== undefined && !Array.isArray(raw)) {
    return { ok: false, reason: 'The Trivy report\'s `Results` was not a list; no verdict is issued.' };
  }
  const results = (raw ?? []) as TrivyResult[];

  const findings: ScanFinding[] = [];
  for (const r of results) {
    const target = str(r.Target, 'the app tree');
    if (Array.isArray(r.Vulnerabilities)) {
      for (const v of r.Vulnerabilities as TrivyVuln[]) {
        const pkg = str(v.PkgName, 'a dependency');
        const version = str(v.InstalledVersion, '?');
        const id = str(v.VulnerabilityID, 'an advisory');
        const fixed = str(v.FixedVersion);
        findings.push({
          category: 'deps',
          severity: SEVERITY[str(v.Severity, 'UNKNOWN').toUpperCase()] ?? 'info',
          title: `Vulnerable dependency: ${pkg}@${version} — ${id}`,
          detail:
            `${str(v.Title, str(v.Description, id))}` +
            (fixed ? ` Fixed in ${fixed}.` : ' No fixed version is published yet.') +
            (str(v.PrimaryURL) ? ` ${str(v.PrimaryURL)}` : ''),
          path: target,
        });
      }
    }
    if (Array.isArray(r.Secrets)) {
      for (const s of r.Secrets as TrivySecret[]) {
        const rule = str(s.RuleID, 'a credential pattern');
        const line = typeof s.StartLine === 'number' ? s.StartLine : null;
        findings.push({
          // A committed secret is ALWAYS critical, whatever Trivy graded it: the repo's existing
          // rule (scan.ts) is that a leak blocks regardless of count or severity.
          category: 'secrets',
          severity: 'critical',
          title: `Possible committed secret: ${str(s.Title, rule)}`,
          detail:
            `Rule ${rule}${str(s.Category) ? ` (${str(s.Category)})` : ''}` +
            `${line === null ? '' : ` at line ${line}`}. Secrets must live in External Secrets / ` +
            `Secrets Manager, never in git.`,
          path: target,
        });
      }
    }
  }

  const summary: Record<ScanCategory, number> = { sast: 0, deps: 0, secrets: 0 };
  for (const f of findings) summary[f.category] += 1;
  const passed = !findings.some((f) => f.category === 'secrets' || BLOCKING.has(f.severity));
  // Trivy is not a SAST engine, and no allowlisted one exists (Semgrep is LGPL-2.1). Saying so
  // here is what stops `sast 0` from reading as "we read the code and it is fine".
  return { ok: true, findings, summary, passed, notRun: ['sast'] };
}

// --------------------------------------------------------------- resolve opts ---

function resolved(opts: TrivyScanOpts) {
  return {
    k8s: opts.k8s ?? (liveK8s as ScanK8s),
    k8sText: opts.k8sText ?? (liveK8sText as ScanK8sText),
    namespace: opts.namespace ?? config.softwareScannerNamespace ?? '',
    image: opts.image ?? config.softwareScannerImage,
    dbMode: opts.dbMode ?? (config.softwareScannerDbMode as ScannerDbMode),
    dbRepository: opts.dbRepository ?? config.softwareScannerDbRepository,
    timeoutMs: opts.timeoutMs ?? config.softwareScannerTimeoutMs,
    maxPayloadBytes: opts.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD,
    resources:
      opts.resources ?? {
        requests: { cpu: '100m', memory: '256Mi' },
        limits: { cpu: '1', memory: '1Gi' },
      },
    runId: opts.runId ?? Math.random().toString(36).slice(2, 10),
    now: opts.now ?? (() => Date.now()),
    sleep: opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
  };
}

const POLL_MS = 2_000;

// -------------------------------------------------------------------- the run ---

/**
 * Run ONE Trivy scan over `files` as a Kubernetes Job and return the mapped report.
 *
 * Never throws. Every failure path — unsafe path, oversized payload, unreachable API server,
 * refused create, failed Job, deadline, unreadable log, malformed report — returns
 * `{ ok: false, reason }`, and the caller renders that as `mode: 'unavailable'`. There is no
 * path from a failure to `passed: true`.
 */
export async function runTrivyScan(
  slug: string,
  files: ScaffoldFile[],
  opts: TrivyScanOpts = {},
): Promise<TrivyOutcome> {
  const o = resolved(opts);
  const ns = o.namespace || config.platformNamespace;

  // 1. Materialise the tree FIRST: an unsafe path or an oversized tree must refuse before
  //    anything is launched, so a refused scan leaves no pod behind.
  const writer = writerScript(files, o.maxPayloadBytes);
  if (!writer.ok) return writer;

  const name = scanJobName(slug, o.runId);
  const jobs = `/apis/batch/v1/namespaces/${ns}/jobs`;
  const object = `${jobs}/${name}`;
  const args = trivyArgs({ dbMode: o.dbMode, dbRepository: o.dbRepository });
  const manifest = buildScanJobManifest({
    name,
    namespace: ns,
    image: o.image,
    args,
    payload: Buffer.from(writer.script, 'utf8').toString('base64'),
    timeoutMs: o.timeoutMs,
    resources: o.resources,
  });

  // 2. Create it (idempotently: a same-named leftover is deleted first, so a retried scan does
  //    not read a previous run's log).
  const existing = await o.k8s('GET', object);
  if (existing.status === 0) return { ok: false, reason: unreachable() };
  if (existing.status === 200) {
    const del = await o.k8s('DELETE', `${object}?propagationPolicy=Background`);
    if (del.status === 0) return { ok: false, reason: unreachable() };
  }
  const created = await o.k8s('POST', jobs, manifest);
  if (created.status === 0) return { ok: false, reason: unreachable() };
  if (created.status !== 201 && created.status !== 200 && created.status !== 409) {
    return {
      ok: false,
      reason:
        `Kubernetes refused to create the scan Job (HTTP ${created.status}). The os-ui ` +
        `ServiceAccount needs \`create\` on \`batch/jobs\` in ${ns} — see the ` +
        `os-ui-software-scanner Role in the chart.`,
    };
  }

  // 3. Poll to completion within the deadline.
  const started = o.now();
  let phase: 'active' | 'succeeded' | 'failed' = 'active';
  let failure = '';
  for (;;) {
    const got = await o.k8s('GET', `${object}?t=${o.now()}`);
    if (got.status === 0) return { ok: false, reason: unreachable() };
    const status = (got.body.status ?? {}) as Record<string, unknown>;
    if (typeof status.succeeded === 'number' && status.succeeded >= 1) {
      phase = 'succeeded';
      break;
    }
    if (typeof status.failed === 'number' && status.failed >= 1) {
      phase = 'failed';
      const conds = Array.isArray(status.conditions) ? (status.conditions as Record<string, unknown>[]) : [];
      const c = conds.find((x) => x.type === 'Failed') ?? conds[0];
      failure = [str(c?.reason), str(c?.message)].filter(Boolean).join(': ');
      break;
    }
    if (o.now() - started >= o.timeoutMs) {
      // Abandon it, and reap it so the namespace does not accumulate stuck scans.
      void o.k8s('DELETE', `${object}?propagationPolicy=Background`);
      return {
        ok: false,
        reason:
          `The security scan timed out after ${Math.round(o.timeoutMs / 1000)}s (the Job never ` +
          `completed). No verdict is issued; raise osUI.software.scanner.timeoutSeconds, or check ` +
          `whether the scanner pod can reach its vulnerability database.`,
      };
    }
    await o.sleep(POLL_MS);
  }

  if (phase === 'failed') {
    return {
      ok: false,
      reason:
        `The security scan Job failed${failure ? ` — ${failure}` : ''}. A failed scan is NOT a ` +
        `passing scan: no verdict is issued.`,
    };
  }

  // 4. Read the verdict off the pod's stdout.
  const pods = await o.k8s(
    'GET',
    `/api/v1/namespaces/${ns}/pods?labelSelector=job-name%3D${encodeURIComponent(name)}`,
  );
  if (pods.status === 0) return { ok: false, reason: unreachable() };
  const items = Array.isArray(pods.body.items) ? (pods.body.items as Record<string, unknown>[]) : [];
  const podName = str(((items[0]?.metadata ?? {}) as Record<string, unknown>).name);
  if (!podName) {
    return {
      ok: false,
      reason:
        `The scan Job reported success but its pod could not be found, so its output is ` +
        `unreadable. No verdict is issued.`,
    };
  }
  const log = await o.k8sText(`/api/v1/namespaces/${ns}/pods/${podName}/log`);
  if (log.status !== 200 || log.text.trim().length === 0) {
    return {
      ok: false,
      reason:
        `The scan Job completed but its output (pod log) could not be read (HTTP ${log.status}). ` +
        `The os-ui ServiceAccount needs \`get\` on \`pods/log\` in ${ns}. No verdict is issued.`,
    };
  }

  const mapped = mapTrivyReport(log.text);
  if (!mapped.ok) return mapped;
  return { ...mapped, engine: `trivy (${o.image})` };
}

function unreachable(): string {
  return (
    'The Kubernetes API server is unreachable from the OS, so no security scan could be ' +
    'launched. No verdict is issued — a deploy cannot be approved without one.'
  );
}
