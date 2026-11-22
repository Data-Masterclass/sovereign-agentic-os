/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    Software Factory - run an app's gates in a restricted Job in a dedicated sandbox namespace
 * USER STORY: As a builder I want the app's tests, type check, lint and policy rules run by the platform on
 *             the committed tree, in a sandbox that cannot reach the platform, judged by the platform's own
 *             rules and by a verdict the app cannot forge, so a green result is evidence and not the author's
 *             say-so.
 * ARCHITECTURE:
 *   - ONE Job per run, in the DEDICATED sandbox namespace (`osUI.software.sandbox.namespace`, default
 *     `<release>-sandbox`: default-deny network, Pod Security restricted, see
 *     templates/base/os-ui/software-sandbox.yaml). Running in the platform namespace is refused outright.
 *   - The tree travels in a Secret owned by the Job (as the scan does). The same payload carries the
 *     PLATFORM's own gate script and policy, written to a separate `/platform` volume and ALSO laid over the
 *     author's `policy/` and `scripts/factory-gates.mjs` in the tree (the author's versions are dropped).
 *   - Pod shape: init `writer` -> native-sidecar `opa` (serves `/platform/policy` only, never the tree) ->
 *     init `toolchain` (`npm ci` of the PLATFORM's pinned tsc/eslint/tsx into `/platform/toolchain`; the gates
 *     run them by absolute path, so an app's lockfile never decides a gate) ->
 *     init `install` (`npm ci --ignore-scripts`, the only step with network, through the egress proxy) ->
 *     one regular container PER GATE (typecheck, lint, tests, build, policy), run in parallel from
 *     `/platform/factory-gates.mjs --gate <id>` over a READ-ONLY tree, so no gate can alter what another
 *     judges.
 *   - THE VERDICT CHANNEL: each gate's verdict is its container's exit code in the pod status (written by the
 *     kubelet, which no code in the pod can forge). Log text is display-only and read only for a gate that
 *     did not pass; nothing the app prints can turn a gate green.
 *   - Limits: a new run for the same app deletes the older Job by label (it reports `superseded`); an
 *     abort signal from the per-app/per-user slot (gates-limits.ts) does the same for the local run.
 *   - Never throws; every failure is `{ ok:false, kind, reason }`, which evaluateGates turns into a block.
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { k8s as liveK8s, k8sText as liveK8sText } from '@core/infra/k8s';
import type { ScaffoldFile } from '@tabs/software/lib/model';
import { buildPayloadSecretManifest, writerScript, DEFAULT_MAX_PAYLOAD, SCAN_MOUNT, type ScanK8s, type ScanK8sText } from '@tabs/software/lib/scan-trivy';
import { reportFromGateExits, REQUIRED_GATES, type GateExit, type GateResult, type GatesOutcome } from '@tabs/software/lib/gates';
import { applyGateOverlay, gateFilesOf, platformToolchainFiles, type GoldenPathKey } from '@tabs/software/lib/golden-path';

const WORK = '/work';
const PLATFORM = '/platform';
const TOOLCHAIN = `${PLATFORM}/toolchain`;
const OPA_ADDR = '127.0.0.1:8181';
const POLL_MS = 2_000;
const LOG_LIMIT_BYTES = 256 * 1024;
const TAIL_LINES = 30;
const DETAIL_CHARS = 1500;
const COMPONENT = 'software-gates';
const LABELS = {
  'app.kubernetes.io/name': COMPONENT,
  'app.kubernetes.io/component': COMPONENT,
  'app.kubernetes.io/managed-by': 'os-ui',
};

export type SandboxOpts = {
  k8s?: ScanK8s;
  k8sText?: ScanK8sText;
  namespace?: string;
  nodeImage?: string;
  opaImage?: string;
  /** Egress proxy URL npm uses; the sandbox network policy allows nothing else out. */
  proxyUrl?: string;
  /** Which template's gate set judges the tree (default `nextjs-web`). */
  template?: GoldenPathKey;
  /** Fires when a newer run for the same app replaced this one. */
  signal?: AbortSignal;
  timeoutMs?: number;
  runId?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const hardened = {
  allowPrivilegeEscalation: false,
  readOnlyRootFilesystem: true,
  capabilities: { drop: ['ALL'] },
  seccompProfile: { type: 'RuntimeDefault' },
};

const labelValue = (slug: string) => slug.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'app';

export function gatesJobName(slug: string, runId: string): string {
  const s = slug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
  return `gates-${s || 'app'}-${runId}`.replace(/-+$/g, '').slice(0, 52);
}

/** The label selector that finds every gates Job of one app (supersede, cleanup). */
export const appGatesSelector = (slug: string) => `app.kubernetes.io/component=${COMPONENT},soa.dev/app=${labelValue(slug)}`;

const GATE_RESOURCES: Record<string, { requests: { cpu: string; memory: string }; limits: { cpu: string; memory: string } }> = {
  typecheck: { requests: { cpu: '100m', memory: '256Mi' }, limits: { cpu: '1', memory: '1Gi' } },
  lint: { requests: { cpu: '100m', memory: '256Mi' }, limits: { cpu: '1', memory: '1Gi' } },
  tests: { requests: { cpu: '100m', memory: '256Mi' }, limits: { cpu: '1', memory: '1Gi' } },
  build: { requests: { cpu: '250m', memory: '512Mi' }, limits: { cpu: '2', memory: '2Gi' } },
  policy: { requests: { cpu: '10m', memory: '64Mi' }, limits: { cpu: '200m', memory: '256Mi' } },
};

export function buildGatesJobManifest(spec: {
  name: string;
  namespace: string;
  slug?: string;
  nodeImage: string;
  opaImage: string;
  timeoutMs: number;
  proxyUrl?: string;
}): Record<string, unknown> {
  const labels = { ...LABELS, 'soa.dev/app': labelValue(spec.slug ?? 'app') };
  const proxyEnv = spec.proxyUrl
    ? ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'npm_config_https_proxy', 'npm_config_proxy'].map((name) => ({ name, value: spec.proxyUrl as string }))
    : [];
  const gateContainer = (id: string) => ({
    name: id,
    image: spec.nodeImage,
    // `build` writes `.next`, so it works on its own COPY of the tree; every other gate reads /work read-only.
    workingDir: id === 'build' ? '/build' : WORK,
    // The PLATFORM's script, one gate per container: the exit code is the verdict.
    command: id === 'build'
      ? ['sh', '-c', `cp -a ${WORK}/. /build/ && exec node ${PLATFORM}/factory-gates.mjs --gate build --root /build --toolchain ${TOOLCHAIN}`]
      : ['node', `${PLATFORM}/factory-gates.mjs`, '--gate', id, '--root', WORK, '--toolchain', TOOLCHAIN],
    env: [
      { name: 'OPA_URL', value: `http://${OPA_ADDR}` },
      { name: 'HOME', value: '/tmp' },
      { name: 'TMPDIR', value: '/tmp' },
      { name: 'NEXT_TELEMETRY_DISABLED', value: '1' },
      { name: 'CI', value: 'true' },
    ],
    securityContext: hardened,
    resources: GATE_RESOURCES[id] ?? GATE_RESOURCES.tests,
    volumeMounts: [
      { name: 'work', mountPath: WORK, readOnly: true },
      { name: 'platform', mountPath: PLATFORM, readOnly: true },
      { name: `tmp-${id}`, mountPath: '/tmp' },
      ...(id === 'build' ? [{ name: 'build', mountPath: '/build' }] : []),
    ],
  });
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: spec.name, namespace: spec.namespace, labels },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: Math.max(60, Math.ceil(spec.timeoutMs / 1000)),
      ttlSecondsAfterFinished: 600,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: 'Never',
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, fsGroup: 10001, seccompProfile: { type: 'RuntimeDefault' } },
          initContainers: [
            {
              name: 'writer',
              image: spec.nodeImage,
              command: ['/bin/sh', '-c', `mkdir -p ${WORK} ${PLATFORM} && sh ${SCAN_MOUNT}/write.sh`],
              securityContext: hardened,
              resources: { requests: { cpu: '10m', memory: '16Mi' }, limits: { cpu: '200m', memory: '128Mi' } },
              volumeMounts: [{ name: 'work', mountPath: WORK }, { name: 'platform', mountPath: PLATFORM }, { name: 'tmp-install', mountPath: '/tmp' }, { name: 'payload', mountPath: SCAN_MOUNT, readOnly: true }],
            },
            {
              // Native sidecar: serves the PLATFORM's policy, never the author's tree; stops when the gates end.
              name: 'opa',
              image: spec.opaImage,
              restartPolicy: 'Always',
              args: ['run', '--server', `--addr=${OPA_ADDR}`, '--log-level=error', `${PLATFORM}/policy`],
              securityContext: hardened,
              resources: { requests: { cpu: '10m', memory: '32Mi' }, limits: { cpu: '500m', memory: '256Mi' } },
              volumeMounts: [{ name: 'platform', mountPath: PLATFORM, readOnly: true }],
            },
            {
              // The PLATFORM's pinned tools (tsc, eslint, tsx) from its own lockfile, installed beside the tree and
              // run by absolute path: an app's package-lock.json never decides a gate. Network, through the proxy.
              name: 'toolchain',
              image: spec.nodeImage,
              workingDir: TOOLCHAIN,
              command: ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--fetch-retries=1'],
              env: [{ name: 'HOME', value: '/tmp' }, { name: 'npm_config_cache', value: '/tmp/npm-cache' }, { name: 'CI', value: 'true' }, ...proxyEnv],
              securityContext: hardened,
              resources: { requests: { cpu: '250m', memory: '512Mi' }, limits: { cpu: '1', memory: '1Gi' } },
              volumeMounts: [{ name: 'platform', mountPath: PLATFORM }, { name: 'tmp-toolchain', mountPath: '/tmp' }],
            },
            {
              // The only step with network: dependencies from the registry, through the egress proxy.
              name: 'install',
              image: spec.nodeImage,
              workingDir: WORK,
              command: ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--fetch-retries=1'],
              env: [{ name: 'HOME', value: '/tmp' }, { name: 'npm_config_cache', value: '/tmp/npm-cache' }, { name: 'CI', value: 'true' }, ...proxyEnv],
              securityContext: hardened,
              resources: { requests: { cpu: '250m', memory: '512Mi' }, limits: { cpu: '1', memory: '1Gi' } },
              volumeMounts: [{ name: 'work', mountPath: WORK }, { name: 'tmp-install', mountPath: '/tmp' }],
            },
          ],
          containers: REQUIRED_GATES.map(gateContainer),
          volumes: [
            { name: 'work', emptyDir: {} },
            { name: 'platform', emptyDir: {} },
            { name: 'tmp-install', emptyDir: {} },
            { name: 'tmp-toolchain', emptyDir: {} },
            { name: 'build', emptyDir: {} },
            ...REQUIRED_GATES.map((id) => ({ name: `tmp-${id}`, emptyDir: {} })),
            { name: 'payload', secret: { secretName: spec.name, defaultMode: 0o400 } },
          ],
        },
      },
    },
  };
}

/** `printf` lines that write the platform's gate files under /platform (same encoding as the tree). */
function platformLines(key: GoldenPathKey): string {
  const lines: string[] = [];
  for (const f of gateFilesOf(key)) {
    const dest = f.path === 'scripts/factory-gates.mjs' ? `${PLATFORM}/factory-gates.mjs` : `${PLATFORM}/${f.path}`;
    lines.push(`mkdir -p '${dest.slice(0, dest.lastIndexOf('/'))}'`);
    lines.push(`printf %s '${Buffer.from(f.content, 'utf8').toString('base64')}' | base64 -d > '${dest}'`);
  }
  // The pinned toolchain's manifest, lockfile and eslint config; the `toolchain` init container runs `npm ci` on them.
  for (const f of platformToolchainFiles()) {
    const dest = `${TOOLCHAIN}/${f.path}`;
    lines.push(`mkdir -p '${TOOLCHAIN}'`);
    lines.push(`printf %s '${Buffer.from(f.content, 'utf8').toString('base64')}' | base64 -d > '${dest}'`);
  }
  return `${lines.join('\n')}\n`;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const rec = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const uidOf = (b: Record<string, unknown>) => str(rec(b.metadata).uid);

function fail(kind: 'no-cluster' | 'sandbox-failed' | 'superseded', reason: string): GatesOutcome {
  return { ok: false, kind, reason };
}
const noCluster = () => fail('no-cluster', 'the Kubernetes API server is unreachable from the OS, so no sandbox could be started');
const superseded = () => fail('superseded', 'a newer gates run for this app replaced this one; use the newer result');

type ContainerStatus = { name?: string; state?: { terminated?: { exitCode?: number; reason?: string }; waiting?: { reason?: string }; running?: unknown } };
function exitOf(statuses: ContainerStatus[], name: string): { exitCode: number | null; note?: string } {
  const s = statuses.find((c) => c.name === name);
  if (!s) return { exitCode: null, note: 'no such step in the pod status' };
  const t = s.state?.terminated;
  if (t && typeof t.exitCode === 'number') return { exitCode: t.exitCode, note: t.reason };
  return { exitCode: null, note: s.state?.waiting?.reason ?? (s.state?.running ? 'still running' : 'not started') };
}

/** Run the app's gates over `files` in one Job. Never throws. */
export async function runGatesSandbox(slug: string, files: ScaffoldFile[], opts: SandboxOpts = {}): Promise<GatesOutcome> {
  const k8s = opts.k8s ?? (liveK8s as ScanK8s);
  const k8sText = opts.k8sText ?? (liveK8sText as ScanK8sText);
  const ns = (opts.namespace ?? config.softwareSandboxNamespace).trim();
  const timeoutMs = opts.timeoutMs ?? config.softwareSandboxTimeoutMs;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const runId = opts.runId ?? Math.random().toString(36).slice(2, 10);
  const template: GoldenPathKey = opts.template ?? 'nextjs-web';

  if (!ns || ns === config.platformNamespace) {
    return fail(
      'sandbox-failed',
      `the gates run only in a dedicated sandbox namespace (osUI.software.sandbox.namespace, set by the chart); ${ns ? `'${ns}' is the platform namespace` : 'none is configured'}, and untrusted tests are never run beside os-ui and its databases`,
    );
  }
  const nodeImage = opts.nodeImage ?? config.softwareSandboxNodeImage;
  const opaImage = opts.opaImage ?? config.softwareSandboxOpaImage;
  if (!nodeImage || !opaImage) {
    return fail('sandbox-failed', 'the gates sandbox images are not configured (SOFTWARE_SANDBOX_NODE_IMAGE / SOFTWARE_SANDBOX_OPA_IMAGE are set by the chart)');
  }
  const proxyUrl = opts.proxyUrl ?? config.softwareSandboxProxy;

  // The tree with the platform's gate files laid over the author's, plus the platform copies under /platform.
  const writer = writerScript(applyGateOverlay(files, template), DEFAULT_MAX_PAYLOAD);
  if (!writer.ok) return fail('sandbox-failed', writer.reason);
  const script = `${writer.script}${platformLines(template)}`;

  const name = gatesJobName(slug, runId);
  const jobs = `/apis/batch/v1/namespaces/${ns}/jobs`;
  const secrets = `/api/v1/namespaces/${ns}/secrets`;
  const object = `${jobs}/${name}`;

  // SUPERSEDE: every older gates Job of this app goes (their Secrets follow through the owner reference).
  const cleared = await k8s('DELETE', `${jobs}?labelSelector=${encodeURIComponent(appGatesSelector(slug))}&propagationPolicy=Background`);
  if (cleared.status === 0) return noCluster();
  const created = await k8s('POST', jobs, buildGatesJobManifest({ name, namespace: ns, slug, nodeImage, opaImage, timeoutMs, proxyUrl }));
  if (created.status === 0) return noCluster();
  if (created.status !== 201 && created.status !== 200) {
    return fail('sandbox-failed', `Kubernetes refused to create the sandbox Job (HTTP ${created.status}); the os-ui ServiceAccount needs create on batch/jobs in ${ns}`);
  }
  const jobUid = uidOf(created.body);
  if (!jobUid) return fail('sandbox-failed', 'the sandbox Job was created but Kubernetes returned no UID, so its pod cannot be trusted');

  const secret = buildPayloadSecretManifest({ name, namespace: ns, script, jobUid });
  (secret.metadata as Record<string, unknown>).labels = { ...LABELS };
  const payload = await k8s('POST', secrets, secret);
  if (payload.status !== 201 && payload.status !== 200) {
    void k8s('DELETE', `${object}?propagationPolicy=Background`);
    return payload.status === 0 ? noCluster() : fail('sandbox-failed', `Kubernetes refused to create the payload Secret (HTTP ${payload.status})`);
  }
  const dropPayload = () => void k8s('DELETE', `${secrets}/${name}`);
  const dropAll = () => { void k8s('DELETE', `${object}?propagationPolicy=Background`); dropPayload(); };

  const started = now();
  for (;;) {
    if (opts.signal?.aborted) { dropAll(); return superseded(); }
    const got = await k8s('GET', `${object}?t=${now()}`);
    if (got.status === 0) { dropPayload(); return noCluster(); }
    if (got.status === 404) return superseded();
    const status = rec(got.body.status);
    if ((typeof status.succeeded === 'number' && status.succeeded >= 1) || (typeof status.failed === 'number' && status.failed >= 1)) break;
    if (now() - started >= timeoutMs) {
      dropAll();
      return fail('sandbox-failed', `the sandbox did not finish within ${Math.round(timeoutMs / 1000)}s`);
    }
    await sleep(POLL_MS);
  }

  // The verdict: the exit code of each step, from the pod status.
  const pods = await k8s('GET', `/api/v1/namespaces/${ns}/pods?labelSelector=${encodeURIComponent(`controller-uid=${jobUid}`)}`);
  const items = Array.isArray(pods.body.items) ? (pods.body.items as Record<string, unknown>[]) : [];
  const mine = items.find((p) => (rec(p.metadata).ownerReferences as Record<string, unknown>[] | undefined)?.some((r) => str(r.uid) === jobUid));
  const podName = str(rec(mine?.metadata).name);
  if (!podName) {
    dropPayload();
    return fail('sandbox-failed', `no pod owned by the sandbox Job (uid ${jobUid}) was found, so its result is unreadable`);
  }
  const podStatus = rec(mine?.status);
  const main = (podStatus.containerStatuses as ContainerStatus[] | undefined) ?? [];
  const init = (podStatus.initContainerStatuses as ContainerStatus[] | undefined) ?? [];

  // Output is display-only, read for a step that did not pass, and never parsed for a verdict.
  const tail = async (container: string): Promise<string> => {
    const log = await k8sText(`/api/v1/namespaces/${ns}/pods/${podName}/log?container=${container}&tailLines=${TAIL_LINES}&limitBytes=${LOG_LIMIT_BYTES}`);
    return log.status === 200 ? `(output of the app's step, untrusted) ${log.text.trim()}`.slice(-DETAIL_CHARS) : '';
  };
  const extra: GateResult[] = [];
  const toolchain = exitOf(init, 'toolchain');
  if (toolchain.exitCode !== 0) {
    extra.push({
      id: 'toolchain',
      status: toolchain.exitCode === null ? 'unavailable' : 'fail',
      detail: `the platform's pinned toolchain ${toolchain.exitCode === null ? `did not install (${toolchain.note})` : `failed to install (exit ${toolchain.exitCode})`}; no gate can be judged without it. ${toolchain.exitCode !== null ? await tail('toolchain') : ''}`.trim().slice(0, DETAIL_CHARS),
    });
  }
  const install = exitOf(init, 'install');
  if (install.exitCode !== 0 && toolchain.exitCode === 0) {
    extra.push({
      id: 'install',
      status: install.exitCode === null ? 'unavailable' : 'fail',
      detail: `npm ci ${install.exitCode === null ? `did not complete (${install.note})` : `failed (exit ${install.exitCode})`}; the gates cannot run without the dependencies. ${install.exitCode !== null ? await tail('install') : ''}`.trim().slice(0, DETAIL_CHARS),
    });
  }
  const exits: GateExit[] = [];
  for (const id of REQUIRED_GATES) {
    const e = exitOf(main, id);
    exits.push({ id, exitCode: e.exitCode, note: e.note, tail: e.exitCode !== null && e.exitCode !== 0 ? await tail(id) : undefined });
  }
  dropPayload();
  return { ok: true, report: reportFromGateExits(template, exits, extra) };
}
