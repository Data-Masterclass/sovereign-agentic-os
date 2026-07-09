/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { config } from '../core/config.ts';
import { k8s as liveK8s } from '../infra/k8s.ts';
import type { Schedule } from './system-schema.ts';

/**
 * The MISSING trigger behind a saved cron schedule. `store.setSchedule` only
 * persists the record; on its own a cron schedule never fires because nothing ever
 * calls the (already-working) `/api/agents/scheduled-run` receiver. This module
 * closes that gap: when an owner/admin saves a `cron` schedule we provision a REAL
 * `batch/v1` CronJob in the platform namespace that curls the receiver with the
 * shared runtime bearer; when they clear it (manual/event) we delete the CronJob.
 *
 * Reconciliation is idempotent — the CronJob name is DETERMINISTIC per system, so a
 * re-save UPDATES the one object rather than piling up duplicates. The k8s client is
 * injectable so this is unit-testable without a cluster; the live default is the
 * pod's scoped in-cluster client (lib/k8s.ts). When the API server is unreachable we
 * report it HONESTLY (never claim the CronJob exists) so the UI can tell the truth.
 */

export type CronK8s = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<{ status: number; body: Record<string, unknown> }>;

export type ReconcileOpts = {
  /** Injected k8s client (defaults to the live in-cluster client). */
  k8s?: CronK8s;
  namespace?: string;
  /** The scheduled-run receiver the CronJob curls. */
  targetUrl?: string;
  /** The curl image the trigger container runs. */
  image?: string;
  /** Secret + key the runtime bearer is read from (kept OUT of the manifest body). */
  tokenSecret?: string;
  tokenSecretKey?: string;
};

export type CronAction = 'created' | 'updated' | 'deleted' | 'noop';
export type CronOutcome = {
  /** Did the DESIRED cluster state get applied (or already hold)? */
  ok: boolean;
  /** True only when a real cluster confirmed the effect. */
  live: boolean;
  action: CronAction;
  detail: string;
  name: string;
};

/** Deterministic, RFC1123-safe CronJob name for a system (one per system). */
export function cronJobName(systemId: string): string {
  const slug = systemId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `agent-schedule-${slug || 'system'}`.slice(0, 52).replace(/-+$/g, '');
}

/** A cron expression is minimally valid when it has exactly 5 non-empty fields. */
export function isValidCron(cron: string | undefined): cron is string {
  if (!cron || typeof cron !== 'string') return false;
  const fields = cron.trim().split(/\s+/);
  return fields.length === 5 && fields.every((f) => f.length > 0);
}

/** Build the CronJob manifest that triggers one scheduled run of `systemId`. */
export function buildCronJobManifest(
  systemId: string,
  cron: string,
  opts: Required<Pick<ReconcileOpts, 'namespace' | 'targetUrl' | 'image' | 'tokenSecret' | 'tokenSecretKey'>>,
): Record<string, unknown> {
  const name = cronJobName(systemId);
  const payload = JSON.stringify({ systemId });
  return {
    apiVersion: 'batch/v1',
    kind: 'CronJob',
    metadata: {
      name,
      namespace: opts.namespace,
      labels: {
        'app.kubernetes.io/managed-by': 'os-ui',
        'app.kubernetes.io/component': 'agent-schedule',
        'soa.agent-system': cronJobName(systemId).replace(/^agent-schedule-/, ''),
      },
    },
    spec: {
      schedule: cron,
      concurrencyPolicy: 'Forbid',
      startingDeadlineSeconds: 120,
      successfulJobsHistoryLimit: 1,
      failedJobsHistoryLimit: 3,
      jobTemplate: {
        spec: {
          backoffLimit: 1,
          activeDeadlineSeconds: 900,
          template: {
            spec: {
              restartPolicy: 'Never',
              containers: [
                {
                  name: 'trigger',
                  image: opts.image,
                  // The bearer is injected from a Secret at RUN time — it is never
                  // embedded in the CronJob spec (defense in depth). systemId +
                  // target ride as env values, so the shell never interpolates them.
                  env: [
                    {
                      name: 'RUNTIME_TOKEN',
                      valueFrom: { secretKeyRef: { name: opts.tokenSecret, key: opts.tokenSecretKey } },
                    },
                    { name: 'TARGET_URL', value: opts.targetUrl },
                    { name: 'PAYLOAD', value: payload },
                  ],
                  command: [
                    '/bin/sh',
                    '-c',
                    'curl --fail --silent --show-error --max-time 60 -X POST ' +
                      '-H "Authorization: Bearer $RUNTIME_TOKEN" ' +
                      '-H "Content-Type: application/json" ' +
                      '-d "$PAYLOAD" "$TARGET_URL"',
                  ],
                },
              ],
            },
          },
        },
      },
    },
  };
}

function resolveOpts(opts: ReconcileOpts): { k8s: CronK8s } & Required<Pick<ReconcileOpts, 'namespace' | 'targetUrl' | 'image' | 'tokenSecret' | 'tokenSecretKey'>> {
  return {
    k8s: opts.k8s ?? (liveK8s as CronK8s),
    namespace: opts.namespace ?? config.platformNamespace,
    targetUrl: opts.targetUrl ?? config.scheduledRunUrl,
    image: opts.image ?? config.scheduleCronImage,
    tokenSecret: opts.tokenSecret ?? config.agentRuntimeTokenSecret,
    tokenSecretKey: opts.tokenSecretKey ?? config.agentRuntimeTokenSecretKey,
  };
}

const UNREACHABLE = 'Kubernetes API unreachable — the schedule is saved, but no CronJob was provisioned; it will not fire until connectivity is restored.';

/**
 * Reconcile the CronJob for a system to match its schedule.
 *   • `cron` (valid)   → upsert the CronJob (create, or replace the existing one).
 *   • `manual`/`event` → delete the CronJob (a 404 is a benign no-op).
 * Never throws; returns an honest {ok, live, detail}. `live:false` with `ok:false`
 * means the desired state was NOT applied (unreachable / rejected) — the caller must
 * surface it rather than claim success.
 */
export async function reconcileScheduleCron(
  systemId: string,
  schedule: Schedule,
  options: ReconcileOpts = {},
): Promise<CronOutcome> {
  const o = resolveOpts(options);
  const name = cronJobName(systemId);
  const collection = `/apis/batch/v1/namespaces/${o.namespace}/cronjobs`;
  const object = `${collection}/${name}`;

  const wantCron = schedule.kind === 'cron';
  if (wantCron && !isValidCron(schedule.cron)) {
    return { ok: false, live: false, action: 'noop', name, detail: 'Invalid cron expression — expected 5 fields (e.g. "0 9 * * 1").' };
  }

  if (wantCron) {
    const manifest = buildCronJobManifest(systemId, schedule.cron as string, o);
    const existing = await o.k8s('GET', object);
    if (existing.status === 0) return { ok: false, live: false, action: 'noop', name, detail: UNREACHABLE };

    if (existing.status === 200) {
      // Replace in place — carry the resourceVersion so the PUT is accepted.
      const meta = (existing.body.metadata ?? {}) as Record<string, unknown>;
      (manifest.metadata as Record<string, unknown>).resourceVersion = meta.resourceVersion;
      const put = await o.k8s('PUT', object, manifest);
      if (put.status === 200 || put.status === 201) return { ok: true, live: true, action: 'updated', name, detail: `Updated schedule CronJob ${name} (${schedule.cron}).` };
      return { ok: false, live: false, action: 'noop', name, detail: `Kubernetes rejected the CronJob update (HTTP ${put.status}).` };
    }
    if (existing.status === 404) {
      const post = await o.k8s('POST', collection, manifest);
      if (post.status === 201 || post.status === 200) return { ok: true, live: true, action: 'created', name, detail: `Created schedule CronJob ${name} (${schedule.cron}).` };
      return { ok: false, live: false, action: 'noop', name, detail: `Kubernetes rejected the CronJob creation (HTTP ${post.status}).` };
    }
    return { ok: false, live: false, action: 'noop', name, detail: `Kubernetes API error reading the CronJob (HTTP ${existing.status}).` };
  }

  // manual / event → ensure no CronJob lingers.
  const del = await o.k8s('DELETE', object);
  if (del.status === 0) return { ok: false, live: false, action: 'noop', name, detail: UNREACHABLE };
  if (del.status === 404) return { ok: true, live: true, action: 'noop', name, detail: 'No schedule CronJob to remove.' };
  if (del.status === 200 || del.status === 202) return { ok: true, live: true, action: 'deleted', name, detail: `Deleted schedule CronJob ${name}.` };
  return { ok: false, live: false, action: 'noop', name, detail: `Kubernetes rejected the CronJob deletion (HTTP ${del.status}).` };
}
