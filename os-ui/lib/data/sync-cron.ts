/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { config } from '../core/config.ts';
import { k8s as liveK8s } from '../infra/k8s.ts';
import { isValidCron } from '../agents/cron-util.ts';

/**
 * The trigger behind a saved DATA-SYNC schedule — a direct clone of the agents
 * schedule reconciler (`lib/agents/schedule-cron.ts`): when an owner saves an
 * ENABLED sync schedule we provision a REAL `batch/v1` CronJob in the platform
 * namespace that curls the dataset's sync route with the shared runtime bearer;
 * disabling/clearing the sync deletes the CronJob. Idempotent (deterministic name
 * per dataset), honest when the API server is unreachable (`live:false` — never
 * claim the CronJob exists), unit-testable via the injected k8s client.
 *
 * Differences from the agents clone (research-verified): explicit `timeZone: UTC`
 * (cursor windows are UTC timestamps — never let node-local zones skew a schedule)
 * and a tight `startingDeadlineSeconds: 60` (a missed slot is SKIPPED, not fired
 * late into the next slot; the next tick re-covers the slice by construction).
 */

export type CronK8s = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<{ status: number; body: Record<string, unknown> }>;

export type SyncCronOpts = {
  k8s?: CronK8s;
  namespace?: string;
  /** Base URL — the CronJob curls `<base>/<datasetId>/sync`. */
  urlBase?: string;
  image?: string;
  tokenSecret?: string;
  tokenSecretKey?: string;
};

export type SyncCronAction = 'created' | 'updated' | 'deleted' | 'noop';
export type SyncCronOutcome = {
  ok: boolean;
  /** True only when a real cluster confirmed the effect. */
  live: boolean;
  action: SyncCronAction;
  detail: string;
  name: string;
};

/** Deterministic, RFC1123-safe CronJob name for a dataset (one per dataset). */
export function syncCronJobName(datasetId: string): string {
  const slug = datasetId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `data-sync-${slug || 'dataset'}`.slice(0, 52).replace(/-+$/g, '');
}

/** Build the CronJob manifest that triggers one scheduled sync of `datasetId`. */
export function buildSyncCronJobManifest(
  datasetId: string,
  cron: string,
  opts: Required<Pick<SyncCronOpts, 'namespace' | 'urlBase' | 'image' | 'tokenSecret' | 'tokenSecretKey'>>,
): Record<string, unknown> {
  const name = syncCronJobName(datasetId);
  return {
    apiVersion: 'batch/v1',
    kind: 'CronJob',
    metadata: {
      name,
      namespace: opts.namespace,
      labels: {
        'app.kubernetes.io/managed-by': 'os-ui',
        'app.kubernetes.io/component': 'data-sync',
        'soa.dataset': name.replace(/^data-sync-/, ''),
      },
    },
    spec: {
      schedule: cron,
      timeZone: 'UTC',
      concurrencyPolicy: 'Forbid',
      startingDeadlineSeconds: 60,
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
                  // The bearer is injected from a Secret at RUN time — never embedded
                  // in the CronJob spec. The URL rides as an env value, so the shell
                  // never interpolates caller input.
                  env: [
                    {
                      name: 'RUNTIME_TOKEN',
                      valueFrom: { secretKeyRef: { name: opts.tokenSecret, key: opts.tokenSecretKey } },
                    },
                    { name: 'TARGET_URL', value: `${opts.urlBase}/${encodeURIComponent(datasetId)}/sync` },
                  ],
                  command: [
                    '/bin/sh',
                    '-c',
                    'curl --fail --silent --show-error --max-time 300 -X POST ' +
                      '-H "Authorization: Bearer $RUNTIME_TOKEN" ' +
                      '-H "Content-Type: application/json" ' +
                      '-d "{}" "$TARGET_URL"',
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

function resolveOpts(opts: SyncCronOpts): { k8s: CronK8s } & Required<Pick<SyncCronOpts, 'namespace' | 'urlBase' | 'image' | 'tokenSecret' | 'tokenSecretKey'>> {
  return {
    k8s: opts.k8s ?? (liveK8s as CronK8s),
    namespace: opts.namespace ?? config.platformNamespace,
    urlBase: opts.urlBase ?? config.dataSyncUrlBase,
    image: opts.image ?? config.scheduleCronImage,
    tokenSecret: opts.tokenSecret ?? config.agentRuntimeTokenSecret,
    tokenSecretKey: opts.tokenSecretKey ?? config.agentRuntimeTokenSecretKey,
  };
}

const UNREACHABLE = 'Kubernetes API unreachable — the sync is saved, but no CronJob was provisioned; it will not fire until connectivity is restored.';

/**
 * Reconcile the CronJob for a dataset's sync.
 *   • enabled + valid cron → upsert the CronJob (create, or replace the existing one).
 *   • disabled / cleared   → delete the CronJob (a 404 is a benign no-op).
 * Never throws; returns an honest {ok, live, detail} exactly like the agents clone.
 */
export async function reconcileSyncCron(
  datasetId: string,
  sync: { enabled: boolean; schedule: { cron: string } } | null,
  options: SyncCronOpts = {},
): Promise<SyncCronOutcome> {
  const o = resolveOpts(options);
  const name = syncCronJobName(datasetId);
  const collection = `/apis/batch/v1/namespaces/${o.namespace}/cronjobs`;
  const object = `${collection}/${name}`;

  const wantCron = Boolean(sync && sync.enabled);
  if (wantCron && !isValidCron(sync!.schedule.cron)) {
    return { ok: false, live: false, action: 'noop', name, detail: 'Invalid cron expression — expected 5 fields (e.g. "0 6 * * *").' };
  }

  if (wantCron) {
    const cron = sync!.schedule.cron;
    const manifest = buildSyncCronJobManifest(datasetId, cron, o);
    const existing = await o.k8s('GET', object);
    if (existing.status === 0) return { ok: false, live: false, action: 'noop', name, detail: UNREACHABLE };

    if (existing.status === 200) {
      const meta = (existing.body.metadata ?? {}) as Record<string, unknown>;
      (manifest.metadata as Record<string, unknown>).resourceVersion = meta.resourceVersion;
      const put = await o.k8s('PUT', object, manifest);
      if (put.status === 200 || put.status === 201) return { ok: true, live: true, action: 'updated', name, detail: `Updated sync CronJob ${name} (${cron}).` };
      return { ok: false, live: false, action: 'noop', name, detail: `Kubernetes rejected the CronJob update (HTTP ${put.status}).` };
    }
    if (existing.status === 404) {
      const post = await o.k8s('POST', collection, manifest);
      if (post.status === 201 || post.status === 200) return { ok: true, live: true, action: 'created', name, detail: `Created sync CronJob ${name} (${cron}).` };
      return { ok: false, live: false, action: 'noop', name, detail: `Kubernetes rejected the CronJob creation (HTTP ${post.status}).` };
    }
    return { ok: false, live: false, action: 'noop', name, detail: `Kubernetes API error reading the CronJob (HTTP ${existing.status}).` };
  }

  // disabled / cleared → ensure no CronJob lingers.
  const del = await o.k8s('DELETE', object);
  if (del.status === 0) return { ok: false, live: false, action: 'noop', name, detail: UNREACHABLE };
  if (del.status === 404) return { ok: true, live: true, action: 'noop', name, detail: 'No sync CronJob to remove.' };
  if (del.status === 200 || del.status === 202) return { ok: true, live: true, action: 'deleted', name, detail: `Deleted sync CronJob ${name}.` };
  return { ok: false, live: false, action: 'noop', name, detail: `Kubernetes rejected the CronJob deletion (HTTP ${del.status}).` };
}

// ------------------------------------------------------- sweep due-matching ----
/**
 * PURE cron matching for the fallback SWEEP (`/api/data/sync-due`): did `cron` fire
 * at any minute in `(from, to]`? Supports the standard 5-field forms (star, star/n,
 * `a`, `a,b`, `a-b`, `a-b/n`); an unparseable field matches NOTHING (fail-closed —
 * the per-dataset CronJob is the primary trigger, the sweep is a fallback).
 * The scan is bounded to 24h of minutes so a bad window can't spin.
 */
export function cronDueInWindow(cron: string, from: Date, to: Date): boolean {
  if (!isValidCron(cron)) return false;
  const fields = cron.trim().split(/\s+/);
  const start = Math.floor(from.getTime() / 60000) + 1;
  const end = Math.min(Math.floor(to.getTime() / 60000), start + 24 * 60);
  for (let m = start; m <= end; m++) {
    if (cronMatchesMinute(fields, new Date(m * 60000))) return true;
  }
  return false;
}

function fieldMatches(field: string, value: number, min: number, max: number): boolean {
  for (const part of field.split(',')) {
    const stepSplit = part.split('/');
    if (stepSplit.length > 2) return false;
    const step = stepSplit.length === 2 ? Number(stepSplit[1]) : 1;
    if (!Number.isInteger(step) || step < 1) return false;
    const range = stepSplit[0];
    let lo: number;
    let hi: number;
    if (range === '*') {
      lo = min; hi = max;
    } else if (/^\d+$/.test(range)) {
      lo = hi = Number(range);
      if (stepSplit.length === 2) hi = max; // `n/step` = from n by step (vixie-cron)
    } else if (/^\d+-\d+$/.test(range)) {
      const [a, b] = range.split('-').map(Number);
      lo = a; hi = b;
    } else {
      return false; // names / unsupported forms — fail-closed
    }
    if (lo < min || hi > max || lo > hi) continue;
    if (value >= lo && value <= hi && (value - lo) % step === 0) return true;
  }
  return false;
}

/** Match a UTC minute against 5 cron fields (minute hour dom month dow). */
export function cronMatchesMinute(fields: string[], at: Date): boolean {
  const [min, hour, dom, mon, dow] = fields;
  const okMin = fieldMatches(min, at.getUTCMinutes(), 0, 59);
  const okHour = fieldMatches(hour, at.getUTCHours(), 0, 23);
  const okMon = fieldMatches(mon, at.getUTCMonth() + 1, 1, 12);
  // Standard cron: when BOTH dom and dow are restricted, either may match.
  const domRestricted = dom !== '*';
  const dowRestricted = dow !== '*';
  const okDom = fieldMatches(dom, at.getUTCDate(), 1, 31);
  const okDow = fieldMatches(dow, at.getUTCDay(), 0, 7) || (dowRestricted && at.getUTCDay() === 0 && fieldMatches(dow, 7, 0, 7));
  const dayOk = domRestricted && dowRestricted ? okDom || okDow : okDom && okDow;
  return okMin && okHour && okMon && dayOk;
}
