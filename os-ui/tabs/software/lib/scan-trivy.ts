/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * FEATURE:    The live security scanner — Trivy, as one Kubernetes Job per deploy request
 * USER STORY: As a Builder approving a software deploy I need the security verdict on the review
 *             card to come from a scanner that really ran over the real committed files, and I
 *             need "the scanner could not run" — or "it ran but could not see the dependencies" —
 *             to be impossible to mistake for "it found nothing".
 * ARCHITECTURE:
 *   Since PR #56 `securityScan` refuses to issue a verdict no engine produced, so on a real
 *   cluster a software deploy cannot be approved until a scanner exists. This is that scanner.
 *
 *   Trivy (Apache-2.0, `aquasec/trivy`) covers the two categories the review card can honestly
 *   claim: dependency vulnerabilities read from the app's manifests/lockfiles, and committed
 *   secrets. It is NOT a SAST engine, and there is no allowlisted one to wire — Semgrep's engine
 *   is LGPL-2.1 and absent from `licenses/allowed-licenses.txt` — so `sast` is always reported in
 *   `notRun` rather than as a zero count that reads like a clean bill of health.
 *
 *   It mirrors `tabs/software/lib/runner.ts`: deterministic names, an INJECTABLE k8s client so
 *   every branch is unit-testable without a cluster, and honest degradation. There is exactly one
 *   way to get `ok: true`: a Job that SUCCEEDED, whose pod we positively identified, whose log
 *   carried our report delimiter, and whose report parsed.
 *
 *   FOUR DESIGN POINTS THAT ARE EACH A FIXED DEFECT (PR #63 review):
 *
 *   1. COVERAGE IS DERIVED FROM EVIDENCE, NOT ASSUMED (H1). Trivy's language analysers resolve
 *      dependencies from LOCKFILES. Our scaffolds emit `package.json` with no lockfile, so Trivy
 *      returns `Results: []` — which, read naively, is a clean `deps 0` over dependencies that
 *      were never resolved, i.e. WEAKER than the baseline it replaced. `mapTrivyReport` therefore
 *      takes the tree: a dependency manifest with no `Class: 'lang-pkgs'` result puts `'deps'` in
 *      `notRun` and makes the result NOT green, with the lockfile named as the cause.
 *      A lockfile's PRESENCE is not evidence either: Trivy reads the lock and never the manifest,
 *      so a `package.json` changed after its lock was generated would be "covered" by the old
 *      dependency set. `lockfile-evidence.ts` compares each npm manifest with the lock that
 *      covers it; a mismatch puts `'deps'` in `notRun` with the remedy (regenerate and commit).
 *      New apps are seeded with a real lockfile (`scaffold-lock.ts`), so this is now the path a
 *      generated app takes to a dependency verdict — and the path by which it loses one.
 *   2. THE TREE TRAVELS IN A SECRET, NOT AN ENV VAR (H3/M4). A container argument/env string is
 *      capped by Linux `MAX_ARG_STRLEN` (128 KiB); a real app tree exceeded it, so the container
 *      failed to start with E2BIG and EVERY scan came back `unavailable` — which would have made
 *      the admin hatch the routine path. The writer script is now a Secret mounted at
 *      {@link SCAN_MOUNT}, owned by the Job (`ownerReferences`) so Kubernetes garbage-collects it,
 *      and deleted explicitly as soon as the result is read. The Job is created FIRST so the
 *      Secret can carry the owner reference at creation: the kubelet retries a missing mount, so
 *      the brief gap costs nothing and we need no `patch` on secrets — and no `get`/`list`, so the
 *      ServiceAccount cannot read any other secret in the namespace.
 *   3. THE RESULT COMES FROM A DELIMITED REPORT, NOT THE MERGED LOG (M1). `trivy` writes the
 *      report to a file; the prelude then echoes {@link REPORT_DELIM} and `cat`s it. One stray
 *      byte on stderr — a DB-download notice, a warning — would otherwise sit in front of the
 *      JSON and void the scan.
 *   4. THE POD IS IDENTIFIED BY THE JOB'S UID, NOT ITS NAME (M2). A `job-name` selector plus
 *      `items[0]` can hand back a PREVIOUS generation's pod while a Background delete is still
 *      finishing — i.e. read a stale verdict for this deploy. The pod must be owned by the exact
 *      Job UID we created, or there is no verdict.
 *
 *   Path safety: content travels as base64 and is decoded in-pod, so nothing in an app's source is
 *   ever interpreted by the shell; a path that is absolute, contains `..`, or carries a character
 *   outside `[A-Za-z0-9._/@-]` FAILS THE SCAN CLOSED rather than being silently skipped, because a
 *   scan of a subset of the tree is not the verdict the card claims.
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { k8s as liveK8s, k8sText as liveK8sText } from '@core/infra/k8s';
import type { ScanCategory, ScanFinding, ScanSeverity, ScaffoldFile } from '@tabs/software/lib/model';
import { npmLockEvidence } from '@tabs/software/lib/lockfile-evidence';

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
  /** Ceiling on the Secret payload. Above it the scan refuses (never truncates). */
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
  /** Categories NO engine actually covered — DERIVED from the tree, never assumed. */
  notRun: ScanCategory[];
  /** `findings` is a capped view of a longer list (`summary` and `passed` still count them all). */
  truncated: boolean;
  /** A blocking finding exists that the cap left OUT of `findings`. The deploy gate reads this. */
  blockingBeyondCap: boolean;
  /** Why a category in `notRun` was not covered, when the answer is actionable. */
  reason?: string;
};

/**
 * Why there is no verdict. `kind` separates the two cases the caller must treat differently:
 *   `no-cluster`  — there is no Kubernetes API at all (a laptop). The teaching flow is intact
 *                   and `securityScan`'s own `OS_OFFLINE_MOCK` decision still applies.
 *   `scan-failed` — a cluster answered and the SCAN failed (refused, failed Job, deadline,
 *                   unreadable, unparseable, oversized, unsafe path). This must NEVER degrade to
 *                   a green `offline-mock` result, whatever `OS_OFFLINE_MOCK` says (M6).
 */
export type TrivyFailure = { ok: false; kind: 'no-cluster' | 'scan-failed'; reason: string };

export type TrivyOutcome = (TrivyReport & { engine: string }) | TrivyFailure;

/** The workspace the Job scans — a tmpfs the writer fills and trivy reads. */
const WORK = '/work';
/** Where the Secret carrying the writer script is mounted (read-only). */
export const SCAN_MOUNT = '/scan';
const WRITER_KEY = 'write.sh';
const REPORT_PATH = '/tmp/os-scan-report.json';
const VERSION_PATH = '/tmp/os-scan-version.json';

/** Framing in the pod log, so one stray stderr byte cannot void the scan (M1). */
export const VERSION_DELIM = '<<<OS-SCAN-VERSION>>>';
export const REPORT_DELIM = '<<<OS-SCAN-REPORT>>>';

/**
 * `[A-Za-z0-9._/@-]` only: everything else is refused rather than quoted.
 *
 * `@` is admitted because an npm scope is a directory name: the vendored OS packages live under
 * `vendor/@sovereign-os/…`, and without it every tree carrying them — every locked seed, and any
 * app that ran "refresh vendored SDK" — failed the scan CLOSED on its first vendored file. It is
 * inert where a path is used: inside a single-quoted `sh` word, where only `'` could end the
 * quote, and `'` is not in the set.
 */
const SAFE_PATH = /^[A-Za-z0-9._/@-]+$/;

/**
 * Default ceiling on the Secret payload (bytes of the base64-encoded writer script).
 *
 * A Kubernetes Secret is capped at ~1 MiB by etcd, so this sits below it with room for the
 * object's own metadata. It is NOT the 128 KiB that `MAX_ARG_STRLEN` would have forced — that
 * limit is precisely why the payload no longer travels in an env var (H3).
 */
export const DEFAULT_MAX_PAYLOAD = 900 * 1024;

/** Hard cap on findings carried onto a review card — a card nobody can read is not evidence. */
export const MAX_FINDINGS = 200;

/** Ceiling on the pod log we will read. A truncated log fails to PARSE, so it can never pass. */
const LOG_LIMIT_BYTES = 8 * 1024 * 1024;

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
 * Repeated paths collapse to the LAST occurrence, so the script never writes the same file twice.
 */
export function writerScript(files: ScaffoldFile[], maxPayloadBytes = DEFAULT_MAX_PAYLOAD): WriterScript {
  // Last write wins, insertion order kept — the same file twice in a tree is a caller bug, and
  // writing it twice would make the script's size a function of that bug.
  const unique = new Map<string, string>();
  for (const f of files) {
    const path = f.path.replace(/^\.\//, '');
    if (path.startsWith('/') || path.split('/').includes('..') || !SAFE_PATH.test(path)) {
      return {
        ok: false,
        kind: 'scan-failed',
        reason:
          `The app tree carries a path the scanner refuses to materialise: "${path}". A path ` +
          `must be relative, free of ".." segments and limited to [A-Za-z0-9._/@-]. The scan is ` +
          `refused rather than run over a subset of the tree, because a partial scan is not the ` +
          `verdict the review card claims.`,
      };
    }
    unique.set(path, f.content);
  }

  const lines = ['set -e'];
  for (const [path, content] of unique) {
    const abs = `${WORK}/${path}`;
    const dir = abs.slice(0, abs.lastIndexOf('/'));
    lines.push(`mkdir -p '${dir}'`);
    lines.push(`printf %s '${Buffer.from(content, 'utf8').toString('base64')}' | base64 -d > '${abs}'`);
  }
  const script = `${lines.join('\n')}\n`;
  // What the Secret object will actually carry: base64 of the script.
  const bytes = Buffer.byteLength(Buffer.from(script, 'utf8').toString('base64'), 'utf8');
  if (bytes > maxPayloadBytes) {
    return {
      ok: false,
      kind: 'scan-failed',
      reason:
        `The app tree is too large for one scan payload (${bytes} bytes encoded, ceiling ` +
        `${maxPayloadBytes} — a Kubernetes Secret is capped near 1 MiB). The scan is refused ` +
        `rather than run over a truncated tree.`,
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
  const args = [
    'fs',
    '--quiet',
    '--no-progress',
    '--format',
    'json',
    '--scanners',
    'vuln,secret',
    // The report goes to a FILE, not stdout: the log is a merged stream and one stderr byte in
    // front of the JSON would void an otherwise good scan (M1).
    '--output',
    REPORT_PATH,
  ];
  if (o.dbMode === 'offline') {
    // No registry is contacted at all: the DB must already be inside the image.
    args.push('--skip-db-update', '--skip-java-db-update', '--offline-scan');
  } else {
    args.push('--db-repository', o.dbRepository);
  }
  args.push(WORK);
  return args;
}

// ----------------------------------------------------------------- manifests ----

export function scanPrelude(args: string[]): string {
  return [
    'set -e',
    `mkdir -p ${WORK}`,
    `sh ${SCAN_MOUNT}/${WRITER_KEY}`,
    // Best-effort: the DB's age is evidence an approver needs (M5), but a scanner that cannot
    // print its version is not a scanner that failed.
    `trivy version --format json > ${VERSION_PATH} 2>/dev/null || true`,
    `trivy ${args.join(' ')}`,
    `echo '${VERSION_DELIM}'`,
    `cat ${VERSION_PATH} 2>/dev/null || echo '{}'`,
    `echo '${REPORT_DELIM}'`,
    `cat ${REPORT_PATH}`,
  ].join('; ');
}

export function buildScanJobManifest(spec: {
  name: string;
  namespace: string;
  image: string;
  args: string[];
  timeoutMs: number;
  resources: ScanResources;
}): Record<string, unknown> {
  const deadline = Math.max(30, Math.ceil(spec.timeoutMs / 1000));
  const labels = {
    'app.kubernetes.io/name': 'software-scanner',
    'app.kubernetes.io/component': 'software-scanner',
    'app.kubernetes.io/managed-by': 'os-ui',
  };
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: spec.name, namespace: spec.namespace, labels },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: deadline,
      // Self-reaping: the adapter deletes what it abandons, and this covers the rest (a pod roll
      // between create and poll must not leave litter — or the app's source — in the namespace).
      ttlSecondsAfterFinished: 600,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: 'Never',
          automountServiceAccountToken: false,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 10001,
            runAsGroup: 10001,
            fsGroup: 10001,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          containers: [
            {
              name: 'trivy',
              image: spec.image,
              command: ['/bin/sh', '-c'],
              args: [scanPrelude(spec.args)],
              env: [
                // The root filesystem is read-only, so both the cache and /tmp are emptyDirs.
                { name: 'TRIVY_CACHE_DIR', value: '/tmp/trivy-cache' },
                { name: 'TRIVY_NO_PROGRESS', value: 'true' },
              ],
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
                seccompProfile: { type: 'RuntimeDefault' },
              },
              resources: spec.resources,
              volumeMounts: [
                { name: 'work', mountPath: WORK },
                { name: 'tmp', mountPath: '/tmp' },
                { name: 'payload', mountPath: SCAN_MOUNT, readOnly: true },
              ],
            },
          ],
          volumes: [
            { name: 'work', emptyDir: {} },
            { name: 'tmp', emptyDir: {} },
            // The app's SOURCE. A Secret rather than a ConfigMap or an env var: it is redacted in
            // API audit logs, can be encrypted at rest, and is not part of the Job spec that
            // every `kubectl get job -o yaml` prints (H3/M4).
            { name: 'payload', secret: { secretName: spec.name, defaultMode: 0o400 } },
          ],
        },
      },
    },
  };
}

/**
 * The Secret carrying the writer script, OWNED by the Job so Kubernetes garbage-collects it even
 * if this process dies between the two creates. The adapter also deletes it explicitly as soon as
 * the result is read, so the app's source lives for the length of one scan and no longer.
 */
export function buildPayloadSecretManifest(spec: {
  name: string;
  namespace: string;
  script: string;
  jobUid: string;
}): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    type: 'Opaque',
    metadata: {
      name: spec.name,
      namespace: spec.namespace,
      labels: {
        'app.kubernetes.io/name': 'software-scanner',
        'app.kubernetes.io/component': 'software-scanner',
        'app.kubernetes.io/managed-by': 'os-ui',
      },
      ownerReferences: [
        {
          apiVersion: 'batch/v1',
          kind: 'Job',
          name: spec.name,
          uid: spec.jobUid,
          controller: false,
          blockOwnerDeletion: false,
        },
      ],
    },
    stringData: { [WRITER_KEY]: spec.script },
  };
}

// ------------------------------------------------------------------- the log ----

/** The two framed sections of a scan pod's log. */
export type ScanLog = { report: string; version: string };

/**
 * Split the pod log on our delimiters. Everything before {@link VERSION_DELIM} is noise (Trivy's
 * stderr, a DB-download notice, a kubelet line) and is DISCARDED rather than parsed.
 */
export function parseScanLog(text: string): ScanLog | TrivyFailure {
  const r = text.lastIndexOf(REPORT_DELIM);
  if (r < 0) {
    return {
      ok: false,
      kind: 'scan-failed',
      reason:
        'The scan pod produced no report section: its log carries no report delimiter, so the ' +
        'scanner did not reach the point of writing one. No verdict is issued.',
    };
  }
  const v = text.lastIndexOf(VERSION_DELIM);
  return {
    report: text.slice(r + REPORT_DELIM.length).trim(),
    version: v >= 0 && v < r ? text.slice(v + VERSION_DELIM.length, r).trim() : '',
  };
}

/** Trivy's `version --format json` carries the vulnerability DB's age — evidence, not trivia. */
export function dbUpdatedAt(versionJson: string): string | null {
  try {
    const v = JSON.parse(versionJson) as { VulnerabilityDB?: { UpdatedAt?: unknown } };
    const at = v?.VulnerabilityDB?.UpdatedAt;
    return typeof at === 'string' && at.length > 0 ? at : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- dep evidence --

/** Files whose presence means "this app HAS dependencies that a scanner should resolve". */
const DEP_MANIFESTS: RegExp[] = [
  /(^|\/)package\.json$/,
  /(^|\/)requirements[^/]*\.txt$/,
  /(^|\/)pyproject\.toml$/,
  /(^|\/)Pipfile$/,
  /(^|\/)go\.mod$/,
  /(^|\/)Cargo\.toml$/,
  /(^|\/)Gemfile$/,
  /(^|\/)pom\.xml$/,
  /(^|\/)build\.gradle(\.kts)?$/,
  /(^|\/)composer\.json$/,
];

/** Files Trivy's language analysers actually READ to resolve a dependency tree. */
const DEP_LOCKS: RegExp[] = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)npm-shrinkwrap\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)poetry\.lock$/,
  /(^|\/)Pipfile\.lock$/,
  /(^|\/)go\.sum$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)Gemfile\.lock$/,
  /(^|\/)composer\.lock$/,
];

const matches = (files: ScaffoldFile[], res: RegExp[]): string[] =>
  files.filter((f) => res.some((re) => re.test(f.path))).map((f) => f.path);

// ------------------------------------------------------------------- mapping ----

const SEVERITY: Record<string, ScanSeverity> = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
  UNKNOWN: 'info',
};

const BLOCKING = new Set<ScanSeverity>(['high', 'critical']);

/** Severity order for the card's "most severe first" cap. */
const SEVERITY_RANK: Record<ScanSeverity, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };

/** The repo's gate rule in one place: a secret, or a high/critical finding, blocks a deploy. */
const isBlocking = (f: ScanFinding): boolean => f.category === 'secrets' || BLOCKING.has(f.severity);

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

type TrivyResult = { Target?: unknown; Class?: unknown; Vulnerabilities?: unknown; Secrets?: unknown };

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' && v.length > 0 ? v : fallback);

/**
 * Map one `trivy fs --format json` report onto the review card's findings.
 *
 * A report is only accepted when it carries `SchemaVersion` — proof Trivy itself wrote it.
 * Anything that does not parse, or parses to something that is not a Trivy report, is a FAILURE:
 * the one outcome this whole gate exists to prevent is a parse error becoming a green tick.
 *
 * `files` is the tree that was scanned, and it is NOT optional in spirit (H1): an empty `Results`
 * means "nothing was found" only if there was something to look at. With a dependency manifest
 * present and no `lang-pkgs` result, Trivy resolved NO dependency tree — almost always a missing
 * lockfile — and `deps` goes into `notRun` with the result marked not-green, because a `deps 0`
 * over unresolved dependencies is weaker than the baseline it replaced.
 */
export function mapTrivyReport(text: string, files: ScaffoldFile[] = []): TrivyReport | TrivyFailure {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      kind: 'scan-failed',
      reason:
        `The scanner's output did not parse as JSON (${(e as Error).message}). No verdict is ` +
        `issued from unreadable output.`,
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      kind: 'scan-failed',
      reason: 'The scanner produced no Trivy report object; no verdict is issued.',
    };
  }
  const report = parsed as Record<string, unknown>;
  if (report.SchemaVersion === undefined) {
    return {
      ok: false,
      kind: 'scan-failed',
      reason:
        'The scanner output carries no Trivy `SchemaVersion`, so it is not a scan report — no ' +
        'verdict is issued from it.',
    };
  }
  const raw = report.Results;
  if (raw !== undefined && !Array.isArray(raw)) {
    return {
      ok: false,
      kind: 'scan-failed',
      reason: "The Trivy report's `Results` was not a list; no verdict is issued.",
    };
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

  // --- COVERAGE, derived from the tree + what the engine actually returned (H1) ---
  // Trivy is not a SAST engine and no allowlisted one exists (Semgrep is LGPL-2.1).
  const notRun: ScanCategory[] = ['sast'];
  let reason: string | undefined;
  const manifests = matches(files, DEP_MANIFESTS);
  const locks = matches(files, DEP_LOCKS);
  const langTargets = new Set(results.filter((r) => str(r.Class) === 'lang-pkgs').map((r) => str(r.Target)));
  const resolvedDeps = langTargets.size > 0;

  // npm: a lockfile's PRESENCE is not evidence — its AGREEMENT with the manifest is. Trivy reads
  // only the lockfile, so a `package.json` edited after its lock was generated still yields a
  // tidy `lang-pkgs` result, over a dependency set the app no longer declares.
  const npm = npmLockEvidence(files);
  const stale = npm.filter((e) => e.state === 'stale' || e.state === 'unreadable');
  // A manifest that asks for dependencies and that NO lockfile covers, while some other lockfile
  // in the tree did resolve: one covered corner must not read as the whole tree.
  const unlocked = npm.filter((e) => e.state === 'unlocked' && e.declared > 0);
  // A consistent lockfile that resolves packages, for which the engine returned no result.
  const unseen = npm.filter(
    (e) => e.state === 'consistent' && e.resolved > 0 && e.lock !== null && !langTargets.has(e.lock),
  );
  // NOTHING TO RESOLVE is the one case where "no `lang-pkgs` result" is the right answer: the
  // manifest declares no dependency and a lockfile that agrees with it resolves no package (Trivy
  // emits no result for an empty lockfile). It needs the lockfile — a bare manifest proves nothing.
  const nothingToResolve = (path: string): boolean =>
    npm.some((e) => e.manifest === path && e.state === 'consistent' && e.declared === 0 && e.resolved === 0);
  const needingEvidence = manifests.filter((m) => !nothingToResolve(m.replace(/^\.\//, '')));

  const SECRETS_RAN = ` The secret scan DID run over every file.`;
  const REGENERATE =
    `Regenerate the lockfile from the current manifest (\`npm install --package-lock-only\`), ` +
    `commit the new package-lock.json and re-request the deploy.`;
  if (stale.length > 0) {
    notRun.push('deps');
    const shown = stale
      .slice(0, 3)
      .map((e) => `${e.manifest} vs ${e.lock ?? 'its lockfile'}: ${e.problems.slice(0, 3).join('; ')}` +
        (e.problems.length > 3 ? `; and ${e.problems.length - 3} more` : ''))
      .join(' | ');
    reason =
      `Dependencies are NOT covered: the lockfile does not match the manifest, so the scanner ` +
      `resolved a dependency tree this app does not declare (${shown}` +
      (stale.length > 3 ? ` | and ${stale.length - 3} more manifest(s)` : '') +
      `). ${REGENERATE} Any dependency finding listed is from the STALE lockfile and is still ` +
      `real for the versions it names.` +
      SECRETS_RAN;
  } else if (needingEvidence.length > 0 && !resolvedDeps) {
    notRun.push('deps');
    reason =
      `Dependencies were NOT scanned: the tree declares them (${needingEvidence.join(', ')}) but the ` +
      `scanner resolved no dependency tree` +
      (locks.length === 0
        ? ` — there is no lockfile (package-lock.json / yarn.lock / poetry.lock / go.sum / …), ` +
          `and Trivy's language analysers read lockfiles, not manifests. Commit a lockfile and ` +
          `re-request the deploy to get a dependency verdict.`
        : ` even though a lockfile is present (${locks.join(', ')}); the ecosystem may be ` +
          `unsupported by this scanner version.`) +
      SECRETS_RAN;
  } else if (unlocked.length > 0 || unseen.length > 0) {
    notRun.push('deps');
    const parts: string[] = [];
    if (unlocked.length > 0) {
      parts.push(
        `${unlocked.map((e) => e.manifest).join(', ')} declare(s) dependencies that no lockfile covers`,
      );
    }
    if (unseen.length > 0) {
      parts.push(
        `the scanner returned no result for ${[...new Set(unseen.map((e) => e.lock))].join(', ')}`,
      );
    }
    reason =
      `Dependencies are only PARTLY covered: ${parts.join('; and ')}. Commit a lockfile next to ` +
      `each manifest (\`npm install --package-lock-only\`) and re-request the deploy.` +
      SECRETS_RAN;
  }

  const summary: Record<ScanCategory, number> = { sast: 0, deps: 0, secrets: 0 };
  for (const f of findings) summary[f.category] += 1;

  // A card nobody can read is not evidence, so the list is capped — but SEVERITY FIRST, so the
  // findings a reviewer must act on are the ones that survive the cap. Before this, 200 LOW
  // findings could push a CRITICAL off the card (re-review L-B).
  const ranked = [...findings].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  const shown = ranked.slice(0, MAX_FINDINGS);
  const hidden = ranked.slice(MAX_FINDINGS);
  const truncated = hidden.length > 0;
  // Belt and braces: with severity-first ordering a blocking finding can only be hidden when
  // MORE than MAX_FINDINGS of them exist. The gate still must not have to assume that.
  const blockingBeyondCap = hidden.some(isBlocking);
  if (truncated) {
    shown.push({
      category: 'deps',
      severity: 'info',
      title: `${hidden.length} further finding(s) not shown`,
      detail:
        `This scan produced ${findings.length} findings; the card lists ${MAX_FINDINGS}, most ` +
        `severe first. The verdict accounts for ALL of them` +
        (blockingBeyondCap ? ', INCLUDING blocking findings that are not listed here' : '') +
        `.`,
    });
  }

  const passed =
    // `deps` uncovered is not a pass: see H1. `sast` uncovered is the accepted, labelled baseline.
    !notRun.includes('deps') && !findings.some(isBlocking);
  return { ok: true, findings: shown, summary, passed, notRun, reason, truncated, blockingBeyondCap };
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
 * Never throws. Every failure path returns `{ ok: false, kind, reason }`, and the caller renders
 * that as `mode: 'unavailable'`. There is no path from a failure to `passed: true`.
 */
export async function runTrivyScan(
  slug: string,
  files: ScaffoldFile[],
  opts: TrivyScanOpts = {},
): Promise<TrivyOutcome> {
  const o = resolved(opts);
  const ns = o.namespace || config.platformNamespace;

  // 1. Materialise the tree FIRST: an unsafe path or an oversized tree must refuse before
  //    anything is launched, so a refused scan leaves no pod and no Secret behind.
  const writer = writerScript(files, o.maxPayloadBytes);
  if (!writer.ok) return writer;

  const name = scanJobName(slug, o.runId);
  const jobs = `/apis/batch/v1/namespaces/${ns}/jobs`;
  const secrets = `/api/v1/namespaces/${ns}/secrets`;
  const object = `${jobs}/${name}`;
  const args = trivyArgs({ dbMode: o.dbMode, dbRepository: o.dbRepository });

  // 2. Clear any leftover of the same name, then create. Deleting first (rather than reading
  //    first) also serves as the reachability probe: `status: 0` is "there is no cluster".
  const cleared = await o.k8s('DELETE', `${object}?propagationPolicy=Background`);
  if (cleared.status === 0) return noCluster();

  const created = await o.k8s(
    'POST',
    jobs,
    buildScanJobManifest({ name, namespace: ns, image: o.image, args, timeoutMs: o.timeoutMs, resources: o.resources }),
  );
  if (created.status === 0) return noCluster();
  if (created.status === 409) {
    // THE LAST DOOR INTO THE M2 HOLE (re-review L-1). A 409 means a Job of this name already
    // exists — the DELETE above has not finished, or another process owns it — so the UID we
    // could read back belongs to THAT Job, and its pod's log is a PREVIOUS scan's verdict. There
    // is no safe way to continue; the next deploy request gets a fresh name.
    return {
      ok: false,
      kind: 'scan-failed',
      reason:
        `A scan Job named ${name} already exists in ${ns} (HTTP 409), so this scan would read a ` +
        `previous run's result. No verdict is issued; re-request the deploy once the old Job has ` +
        `finished terminating.`,
    };
  }
  if (created.status !== 201 && created.status !== 200) {
    return {
      ok: false,
      kind: 'scan-failed',
      reason:
        `Kubernetes refused to create the scan Job (HTTP ${created.status}). The os-ui ` +
        `ServiceAccount needs \`create\` on \`batch/jobs\` in ${ns} — see the ` +
        `os-ui-software-scanner Role in the chart.`,
    };
  }

  // 3. THE JOB'S UID is the identity everything downstream hangs off: the Secret's owner
  //    reference, and the pod we are allowed to believe (M2). Without it there is no verdict.
  //    The fallback GET is only reachable after a 200/201 create (a 409 is refused above), so it
  //    can only ever read back the UID of the Job THIS call created.
  let jobUid = uidOf(created.body);
  if (!jobUid) {
    const got = await o.k8s('GET', object);
    if (got.status === 0) return noCluster();
    jobUid = uidOf(got.body);
  }
  if (!jobUid) {
    return {
      ok: false,
      kind: 'scan-failed',
      reason:
        'The scan Job was created but Kubernetes returned no UID for it, so its pod could not be ' +
        'told apart from a previous generation\'s. No verdict is issued.',
    };
  }

  // 4. The payload, owned by the Job so it is garbage-collected with it. Created AFTER the Job on
  //    purpose: the kubelet retries a missing secret mount, so the ordering costs nothing and the
  //    owner reference can be set at creation — which is why the Role needs no `patch` on
  //    secrets, and no `get`/`list` either.
  const payload = await o.k8s('POST', secrets, buildPayloadSecretManifest({ name, namespace: ns, script: writer.script, jobUid }));
  if (payload.status === 0) return noCluster();
  if (payload.status === 409) {
    // Same reasoning as the Job: a leftover Secret of this name holds a PREVIOUS tree, and the
    // pod would scan that instead of this deploy's source.
    void o.k8s('DELETE', `${object}?propagationPolicy=Background`);
    return {
      ok: false,
      kind: 'scan-failed',
      reason:
        `A scan payload Secret named ${name} already exists in ${ns} (HTTP 409), so this scan ` +
        `would read a previous run's source tree. No verdict is issued; re-request the deploy.`,
    };
  }
  if (payload.status !== 201 && payload.status !== 200) {
    void o.k8s('DELETE', `${object}?propagationPolicy=Background`);
    return {
      ok: false,
      kind: 'scan-failed',
      reason:
        `Kubernetes refused to create the scan payload Secret (HTTP ${payload.status}). The ` +
        `os-ui ServiceAccount needs \`create\` on \`secrets\` in ${ns} — see the ` +
        `os-ui-software-scanner Role in the chart. No scan ran.`,
    };
  }
  const dropPayload = () => {
    void o.k8s('DELETE', `${secrets}/${name}`);
  };

  // 5. Poll to completion within the deadline.
  const started = o.now();
  let failure = '';
  let succeeded = false;
  for (;;) {
    const got = await o.k8s('GET', `${object}?t=${o.now()}`);
    if (got.status === 0) {
      dropPayload();
      return noCluster();
    }
    const status = (got.body.status ?? {}) as Record<string, unknown>;
    if (typeof status.succeeded === 'number' && status.succeeded >= 1) {
      succeeded = true;
      break;
    }
    if (typeof status.failed === 'number' && status.failed >= 1) {
      const conds = Array.isArray(status.conditions) ? (status.conditions as Record<string, unknown>[]) : [];
      const c = conds.find((x) => x.type === 'Failed') ?? conds[0];
      failure = [str(c?.reason), str(c?.message)].filter(Boolean).join(': ');
      break;
    }
    if (o.now() - started >= o.timeoutMs) {
      // Abandon it, and reap both objects so the namespace does not accumulate stuck scans —
      // or the app's source.
      void o.k8s('DELETE', `${object}?propagationPolicy=Background`);
      dropPayload();
      return {
        ok: false,
        kind: 'scan-failed',
        reason:
          `The security scan timed out after ${Math.round(o.timeoutMs / 1000)}s (the Job never ` +
          `completed). No verdict is issued; raise osUI.software.scanner.timeoutSeconds, or check ` +
          `whether the scanner pod can reach its vulnerability database.`,
      };
    }
    await o.sleep(POLL_MS);
  }

  if (!succeeded) {
    dropPayload();
    return {
      ok: false,
      kind: 'scan-failed',
      reason:
        `The security scan Job failed${failure ? ` — ${failure}` : ''}. A failed scan is NOT a ` +
        `passing scan: no verdict is issued.`,
    };
  }

  // 6. Find THE pod this Job created — owned by this exact UID, not merely sharing its name (M2).
  const pods = await o.k8s(
    'GET',
    `/api/v1/namespaces/${ns}/pods?labelSelector=${encodeURIComponent(`controller-uid=${jobUid}`)}`,
  );
  if (pods.status === 0) {
    dropPayload();
    return noCluster();
  }
  const items = Array.isArray(pods.body.items) ? (pods.body.items as Record<string, unknown>[]) : [];
  const mine = items.find((p) => ownedBy(p, jobUid));
  const podName = str(((mine?.metadata ?? {}) as Record<string, unknown>).name);
  if (!podName) {
    dropPayload();
    return {
      ok: false,
      kind: 'scan-failed',
      reason:
        `The scan Job reported success but no pod owned by it (uid ${jobUid}) could be found, so ` +
        `its output is unreadable. No verdict is issued — a pod that merely shares the Job's name ` +
        `may belong to a previous scan.`,
    };
  }

  const log = await o.k8sText(
    `/api/v1/namespaces/${ns}/pods/${podName}/log?limitBytes=${LOG_LIMIT_BYTES}`,
  );
  dropPayload();
  if (log.status !== 200 || log.text.trim().length === 0) {
    return {
      ok: false,
      kind: 'scan-failed',
      reason:
        `The scan Job completed but its output (pod log) could not be read (HTTP ${log.status}). ` +
        `The os-ui ServiceAccount needs \`get\` on \`pods/log\` in ${ns}. No verdict is issued.`,
    };
  }

  // 7. Read the framed report — never the raw merged log (M1).
  const framed = parseScanLog(log.text);
  if ('ok' in framed) return framed;
  const mapped = mapTrivyReport(framed.report, files);
  if (!mapped.ok) return mapped;

  // The engine string is EVIDENCE: which DB mode answered, and how old that DB is. A baked
  // offline DB from last year and a fresh mirror fetch are not the same scan (M5).
  const updated = dbUpdatedAt(framed.version);
  const db =
    o.dbMode === 'offline'
      ? `db: offline/baked${updated ? `, vuln DB updated ${updated}` : ', vuln DB age UNKNOWN'}`
      : `db: mirror ${o.dbRepository}${updated ? `, vuln DB updated ${updated}` : ''}`;
  return { ...mapped, engine: `trivy (${o.image}; ${db})` };
}

function uidOf(body: Record<string, unknown>): string {
  return str(((body.metadata ?? {}) as Record<string, unknown>).uid);
}

function ownedBy(pod: Record<string, unknown>, jobUid: string): boolean {
  const meta = (pod.metadata ?? {}) as Record<string, unknown>;
  const owners = Array.isArray(meta.ownerReferences) ? (meta.ownerReferences as Record<string, unknown>[]) : [];
  return owners.some((r) => str(r.uid) === jobUid);
}

function noCluster(): TrivyFailure {
  return {
    ok: false,
    kind: 'no-cluster',
    reason:
      'The Kubernetes API server is unreachable from the OS, so no security scan could be ' +
      'launched. No verdict is issued — a deploy cannot be approved without one.',
  };
}
