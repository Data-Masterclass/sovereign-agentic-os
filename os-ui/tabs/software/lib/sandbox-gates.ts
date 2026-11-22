/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    Software Factory - run an app's own gates in a restricted Kubernetes Job
 * USER STORY: As a builder I want the app's tests, type check, lint and policy rules run by the
 *             platform on the committed tree, in a sandbox that cannot reach the platform, so that a
 *             green result is evidence and not the author's say-so.
 * ARCHITECTURE:
 *   - Same shape as the Trivy scan (scan-trivy.ts): one Job per run, the tree carried in a Secret owned
 *     by the Job, the result read from the pod log's framed section, never a verdict on failure.
 *   - The Job is one pod: an `writer` init container materialises the tree, an OPA container runs as a
 *     NATIVE SIDECAR (an init container with restartPolicy Always) serving the app's own
 *     `policy/` on 127.0.0.1:8181, and the `gates` container runs `npm ci --ignore-scripts` then the
 *     app's `scripts/factory-gates.mjs`, which asks OPA for `data.factory.deny` over the REST API
 *     (https://www.openpolicyagent.org/docs/rest-api). Upstream tools used as documented, nothing re-coded.
 *   - Restricted: no ServiceAccount token, non-root, read-only root filesystem, dropped capabilities,
 *     CPU/memory limits and an active deadline. The pod needs egress to the npm registry only; that
 *     NetworkPolicy belongs to the namespace the operator chooses (osUI.software.sandbox).
 *   - Never throws; every failure is `{ ok:false, kind, reason }`, which evaluateGates turns into a block.
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { k8s as liveK8s, k8sText as liveK8sText } from '@core/infra/k8s';
import type { ScaffoldFile } from '@tabs/software/lib/model';
import { buildPayloadSecretManifest, writerScript, DEFAULT_MAX_PAYLOAD, SCAN_MOUNT, type ScanK8s, type ScanK8sText } from '@tabs/software/lib/scan-trivy';
import { parseGatesLog, type GatesOutcome } from '@tabs/software/lib/gates';

const WORK = '/work';
const OPA_ADDR = '127.0.0.1:8181';
const POLL_MS = 2_000;
const LOG_LIMIT_BYTES = 4 * 1024 * 1024;
const LABELS = {
  'app.kubernetes.io/name': 'software-gates',
  'app.kubernetes.io/component': 'software-gates',
  'app.kubernetes.io/managed-by': 'os-ui',
};

export type SandboxOpts = {
  k8s?: ScanK8s;
  k8sText?: ScanK8sText;
  namespace?: string;
  nodeImage?: string;
  opaImage?: string;
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

export function gatesJobName(slug: string, runId: string): string {
  const s = slug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
  return `gates-${s || 'app'}-${runId}`.replace(/-+$/g, '').slice(0, 52);
}

export function buildGatesJobManifest(spec: {
  name: string;
  namespace: string;
  nodeImage: string;
  opaImage: string;
  timeoutMs: number;
}): Record<string, unknown> {
  const mounts = [
    { name: 'work', mountPath: WORK },
    { name: 'tmp', mountPath: '/tmp' },
  ];
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: spec.name, namespace: spec.namespace, labels: LABELS },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: Math.max(60, Math.ceil(spec.timeoutMs / 1000)),
      ttlSecondsAfterFinished: 600,
      template: {
        metadata: { labels: LABELS },
        spec: {
          restartPolicy: 'Never',
          automountServiceAccountToken: false,
          securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, fsGroup: 10001, seccompProfile: { type: 'RuntimeDefault' } },
          initContainers: [
            {
              name: 'writer',
              image: spec.nodeImage,
              command: ['/bin/sh', '-c', `mkdir -p ${WORK} && sh ${SCAN_MOUNT}/write.sh`],
              securityContext: hardened,
              resources: { requests: { cpu: '10m', memory: '16Mi' }, limits: { cpu: '200m', memory: '128Mi' } },
              volumeMounts: [...mounts, { name: 'payload', mountPath: SCAN_MOUNT, readOnly: true }],
            },
            {
              // Native sidecar: starts after `writer`, before `gates`, stops when `gates` ends.
              name: 'opa',
              image: spec.opaImage,
              restartPolicy: 'Always',
              args: ['run', '--server', `--addr=${OPA_ADDR}`, '--log-level=error', `${WORK}/policy`],
              securityContext: hardened,
              resources: { requests: { cpu: '10m', memory: '32Mi' }, limits: { cpu: '500m', memory: '256Mi' } },
              volumeMounts: [{ name: 'work', mountPath: WORK, readOnly: true }],
            },
          ],
          containers: [
            {
              name: 'gates',
              image: spec.nodeImage,
              workingDir: WORK,
              command: ['/bin/sh', '-c'],
              // `npm ci` failing must still produce a framed report (a gate that cannot run is
              // `unavailable`, not a missing log), so the frame is written by the script on success
              // and by this shell on an install failure.
              args: [
                `npm ci --ignore-scripts --no-audit --no-fund --fetch-retries=1 || { echo '${'<<<OS-GATES-REPORT>>>'}'; echo '{"schema":"os-gates/v1","template":"unknown","ok":false,"gates":[{"id":"install","status":"fail","detail":"npm ci failed"}]}'; exit 0; }; node scripts/factory-gates.mjs; exit 0`,
              ],
              env: [
                { name: 'OPA_URL', value: `http://${OPA_ADDR}` },
                { name: 'HOME', value: '/tmp' },
                { name: 'npm_config_cache', value: '/tmp/npm-cache' },
                { name: 'NEXT_TELEMETRY_DISABLED', value: '1' },
                { name: 'CI', value: 'true' },
              ],
              securityContext: hardened,
              resources: { requests: { cpu: '250m', memory: '512Mi' }, limits: { cpu: '2', memory: '2Gi' } },
              volumeMounts: mounts,
            },
          ],
          volumes: [
            { name: 'work', emptyDir: {} },
            { name: 'tmp', emptyDir: {} },
            { name: 'payload', secret: { secretName: spec.name, defaultMode: 0o400 } },
          ],
        },
      },
    },
  };
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const uidOf = (b: Record<string, unknown>) => str(((b.metadata ?? {}) as Record<string, unknown>).uid);

function fail(kind: 'no-cluster' | 'sandbox-failed', reason: string): GatesOutcome {
  return { ok: false, kind, reason };
}
const noCluster = () => fail('no-cluster', 'the Kubernetes API server is unreachable from the OS, so no sandbox could be started');

/** Run the app's gates over `files` in one Job. Never throws. */
export async function runGatesSandbox(slug: string, files: ScaffoldFile[], opts: SandboxOpts = {}): Promise<GatesOutcome> {
  const k8s = opts.k8s ?? (liveK8s as ScanK8s);
  const k8sText = opts.k8sText ?? (liveK8sText as ScanK8sText);
  const ns = opts.namespace ?? (config.softwareSandboxNamespace || config.platformNamespace);
  const timeoutMs = opts.timeoutMs ?? config.softwareSandboxTimeoutMs;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const runId = opts.runId ?? Math.random().toString(36).slice(2, 10);

  const writer = writerScript(files, DEFAULT_MAX_PAYLOAD);
  if (!writer.ok) return fail('sandbox-failed', writer.reason);

  const name = gatesJobName(slug, runId);
  const jobs = `/apis/batch/v1/namespaces/${ns}/jobs`;
  const secrets = `/api/v1/namespaces/${ns}/secrets`;
  const object = `${jobs}/${name}`;

  const cleared = await k8s('DELETE', `${object}?propagationPolicy=Background`);
  if (cleared.status === 0) return noCluster();
  const created = await k8s(
    'POST',
    jobs,
    buildGatesJobManifest({ name, namespace: ns, nodeImage: opts.nodeImage ?? config.softwareSandboxNodeImage, opaImage: opts.opaImage ?? config.softwareSandboxOpaImage, timeoutMs }),
  );
  if (created.status === 0) return noCluster();
  if (created.status !== 201 && created.status !== 200) {
    return fail('sandbox-failed', `Kubernetes refused to create the sandbox Job (HTTP ${created.status}); the os-ui ServiceAccount needs create on batch/jobs in ${ns}`);
  }
  const jobUid = uidOf(created.body);
  if (!jobUid) return fail('sandbox-failed', 'the sandbox Job was created but Kubernetes returned no UID, so its pod cannot be trusted');

  const payload = await k8s('POST', secrets, buildPayloadSecretManifest({ name, namespace: ns, script: writer.script, jobUid }));
  if (payload.status !== 201 && payload.status !== 200) {
    void k8s('DELETE', `${object}?propagationPolicy=Background`);
    return payload.status === 0 ? noCluster() : fail('sandbox-failed', `Kubernetes refused to create the payload Secret (HTTP ${payload.status})`);
  }
  const dropPayload = () => void k8s('DELETE', `${secrets}/${name}`);

  const started = now();
  let succeeded = false;
  for (;;) {
    const got = await k8s('GET', `${object}?t=${now()}`);
    if (got.status === 0) {
      dropPayload();
      return noCluster();
    }
    const status = (got.body.status ?? {}) as Record<string, unknown>;
    if (typeof status.succeeded === 'number' && status.succeeded >= 1) {
      succeeded = true;
      break;
    }
    if (typeof status.failed === 'number' && status.failed >= 1) break;
    if (now() - started >= timeoutMs) {
      void k8s('DELETE', `${object}?propagationPolicy=Background`);
      dropPayload();
      return fail('sandbox-failed', `the sandbox did not finish within ${Math.round(timeoutMs / 1000)}s`);
    }
    await sleep(POLL_MS);
  }
  if (!succeeded) {
    dropPayload();
    return fail('sandbox-failed', 'the sandbox Job failed before it could report; a failed sandbox is not a passing one');
  }

  const pods = await k8s('GET', `/api/v1/namespaces/${ns}/pods?labelSelector=${encodeURIComponent(`controller-uid=${jobUid}`)}`);
  const items = Array.isArray(pods.body.items) ? (pods.body.items as Record<string, unknown>[]) : [];
  const mine = items.find((p) => (((p.metadata ?? {}) as Record<string, unknown>).ownerReferences as Record<string, unknown>[] | undefined)?.some((r) => str(r.uid) === jobUid));
  const podName = str(((mine?.metadata ?? {}) as Record<string, unknown>).name);
  if (!podName) {
    dropPayload();
    return fail('sandbox-failed', `no pod owned by the sandbox Job (uid ${jobUid}) was found, so its output is unreadable`);
  }
  const log = await k8sText(`/api/v1/namespaces/${ns}/pods/${podName}/log?container=gates&limitBytes=${LOG_LIMIT_BYTES}`);
  dropPayload();
  if (log.status !== 200 || !log.text.trim()) return fail('sandbox-failed', `the sandbox output could not be read (HTTP ${log.status})`);
  return parseGatesLog(log.text);
}
