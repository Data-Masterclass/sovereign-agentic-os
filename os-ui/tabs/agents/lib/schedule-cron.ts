/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { config } from '@core/kernel/config';
import { k8s as liveK8s } from '@core/infra/k8s';
import { scheduleEvery } from '@core/reconcile/runtime';
import type { Schedule } from '@tabs/agents/lib/system-schema';
// isValidCron lives in a PURE module (no k8s) so client bundles can use it; we
// re-export it here for the server callers + tests that import it from this module.
export { isValidCron } from '@tabs/agents/lib/cron-util';
import { isValidCron } from '@tabs/agents/lib/cron-util';

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
            // The POD label is what the NetworkPolicies select on: `component: agent-schedule` is
            // excluded from the blanket in-namespace and API-server egress and gets only os-ui:3000
            // + DNS (`network/egress-policies.yaml`, policy 6). Without it this curl pod matched the
            // blanket allows — the whole in-namespace plane — unlike the chart's own schedule pods.
            metadata: {
              labels: {
                'app.kubernetes.io/managed-by': 'os-ui',
                'app.kubernetes.io/component': 'agent-schedule',
              },
            },
            spec: {
              restartPolicy: 'Never',
              // A curl to os-ui authenticates with the service bearer; it needs no API-server token.
              automountServiceAccountToken: false,
              securityContext: { runAsNonRoot: true, runAsUser: 1000, seccompProfile: { type: 'RuntimeDefault' } },
              containers: [
                {
                  name: 'trigger',
                  image: opts.image,
                  securityContext: {
                    allowPrivilegeEscalation: false,
                    capabilities: { drop: ['ALL'] },
                    readOnlyRootFilesystem: true,
                  },
                  resources: { requests: { cpu: '25m', memory: '32Mi' }, limits: { cpu: '200m', memory: '64Mi' } },
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
      // Replace in place — carry the resourceVersion so the PUT is accepted. A 409 means another
      // writer (a second os-ui pod's boot resync during a rolling update, or a concurrent save)
      // replaced it between our GET and PUT: re-read once and apply the same spec again.
      let current = existing;
      let put = { status: 0 } as { status: number };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const meta = (current.body.metadata ?? {}) as Record<string, unknown>;
        (manifest.metadata as Record<string, unknown>).resourceVersion = meta.resourceVersion;
        put = await o.k8s('PUT', object, manifest);
        if (put.status !== 409) break;
        current = await o.k8s('GET', object);
        if (current.status !== 200) break;
      }
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

// ------------------------------------------------------------------- boot resync --

/** One stored system as the resync sees it. */
export type ScheduledSystemRow = { id: string; schedule: Schedule; archived: boolean };

export type CronResyncResult = {
  /** True when every desired CronJob was applied and every orphan removed. */
  ok: boolean;
  reason?: string;
  /** Stored, unarchived systems with a valid cron schedule. */
  desired: number;
  applied: number;
  deleted: number;
  failed: number;
};

/** The label selector of the CronJobs THIS module creates (never the chart's own schedules). */
export const OS_SCHEDULE_SELECTOR = 'app.kubernetes.io/managed-by=os-ui,app.kubernetes.io/component=agent-schedule';

/**
 * Bring every os-ui schedule CronJob to the CURRENT spec, and remove the ones nothing wants.
 *
 * `reconcileScheduleCron` runs only on a save, an archive or a delete, so a CronJob written by an
 * older os-ui keeps its old spec (2026-11-26: the missing `os-ui` Secret) until somebody re-saves
 * the schedule. This pass, run at boot, re-applies the current manifest to every stored cron
 * schedule (GET + PUT with the resourceVersion, idempotent; a concurrent writer is a 409 that is
 * re-read once) and deletes os-ui's own schedule CronJobs (`OS_SCHEDULE_SELECTOR`) whose system is
 * gone, archived or no longer on a cron schedule.
 *
 * `systems` returns NULL when the registry did not come from the durable mirror: then NOTHING is
 * touched — a registry that hydrated to empty must never read as "no schedules, delete them all"
 * (the September-2026 failure shape). It is read a second time right before deleting, so a
 * schedule saved while the pass ran is not removed as an orphan.
 */
export async function resyncScheduleCrons(
  systems: () => Promise<ScheduledSystemRow[] | null>,
  options: ReconcileOpts = {},
): Promise<CronResyncResult> {
  const o = resolveOpts(options);
  const wanted = (rows: ScheduledSystemRow[]) =>
    rows.filter((r) => !r.archived && r.schedule.kind === 'cron' && isValidCron(r.schedule.cron));
  const first = await systems();
  if (first === null) return { ok: false, reason: 'the agent registry is not readable yet — nothing changed', desired: 0, applied: 0, deleted: 0, failed: 0 };

  const desired = wanted(first);
  let applied = 0;
  let failed = 0;
  for (const r of desired) {
    const out = await reconcileScheduleCron(r.id, r.schedule, o);
    if (out.ok) applied += 1;
    else failed += 1;
  }

  const listed = await o.k8s('GET', `/apis/batch/v1/namespaces/${o.namespace}/cronjobs?labelSelector=${encodeURIComponent(OS_SCHEDULE_SELECTOR)}`);
  if (listed.status !== 200) {
    return { ok: false, reason: `could not list schedule CronJobs (HTTP ${listed.status}) — no orphan removed`, desired: desired.length, applied, deleted: 0, failed: failed + 1 };
  }
  const items = (listed.body.items ?? []) as { metadata?: { name?: string } }[];
  const desiredNames = new Set(desired.map((r) => cronJobName(r.id)));
  let orphans = items.map((i) => i.metadata?.name ?? '').filter((n) => n && !desiredNames.has(n));
  if (orphans.length > 0) {
    const again = await systems();
    if (again === null) {
      return { ok: false, reason: 'the agent registry became unreadable — no orphan removed', desired: desired.length, applied, deleted: 0, failed };
    }
    const stillWanted = new Set(wanted(again).map((r) => cronJobName(r.id)));
    orphans = orphans.filter((n) => !stillWanted.has(n));
  }
  let deleted = 0;
  for (const name of orphans) {
    const del = await o.k8s('DELETE', `/apis/batch/v1/namespaces/${o.namespace}/cronjobs/${name}`);
    if (del.status === 200 || del.status === 202) deleted += 1;
    else if (del.status !== 404) failed += 1;
  }
  return { ok: failed === 0, desired: desired.length, applied, deleted, failed };
}

/** One log line per pass, with the counts. */
export function resyncLogLine(r: CronResyncResult): string {
  return `[agent-schedules] boot resync: ${r.ok ? 'done' : 'incomplete'} — desired ${r.desired}, applied ${r.applied}, orphans deleted ${r.deleted}, failed ${r.failed}${r.reason ? ` (${r.reason})` : ''}`;
}

/**
 * Run the resync at boot, then again every `retryMs` until one pass is clean (the registry or the
 * API server may not be up yet when os-ui starts), then stop. Safe with several pods: every write
 * is an idempotent PUT of the same spec. `every` is the reconcile runtime (injected for tests).
 */
export function scheduleBootCronResync(
  pass: () => Promise<CronResyncResult>,
  opts: { retryMs?: number; maxPasses?: number; every?: (name: string, ms: number, fn: () => Promise<unknown>) => () => void; log?: (line: string) => void } = {},
): Promise<void> {
  const log = opts.log ?? ((l: string) => console.info(l));
  // A laptop has no API server: every pass is "unreachable". Give up after this many passes
  // (an hour at the default interval) instead of logging forever; the next boot tries again.
  const maxPasses = opts.maxPasses ?? 60;
  let passes = 0;
  let finished = false;
  let stop: (() => void) | undefined;
  const tick = async () => {
    if (finished) return;
    passes += 1;
    const r = await pass();
    log(resyncLogLine(r));
    if (r.ok || passes >= maxPasses) {
      if (!r.ok) log(`[agent-schedules] boot resync: giving up after ${passes} passes — the next os-ui start tries again`);
      finished = true;
      stop?.();
    }
  };
  const every = opts.every ?? scheduleEvery;
  const first = tick().catch((e) => log(`[agent-schedules] boot resync failed: ${(e as Error)?.message ?? String(e)}`));
  // `tick` awaits before it can set `finished`, so `stop` is always assigned by the time it is used.
  stop = every('agent-schedule-cron-resync', opts.retryMs ?? 60_000, tick);
  return first;
}

/** The real wiring: this registry, this cluster. */
export async function resyncScheduleCronsLive(): Promise<CronResyncResult> {
  const { ensureHydrated, listSchedulesForResync } = await import('@tabs/agents/lib/store');
  return resyncScheduleCrons(async () => {
    await ensureHydrated();
    return listSchedulesForResync();
  });
}
