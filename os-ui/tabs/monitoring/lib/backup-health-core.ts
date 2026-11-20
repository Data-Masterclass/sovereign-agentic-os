/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Backup and restore-drill health (WP-56) — pure assessment
 * USER STORY: As a platform admin I want Monitoring to say plainly whether every repository is
 *             being bundled and whether the last restore drill PROVED a restore, and to raise an
 *             alert when either fails — never a green light without evidence.
 * ARCHITECTURE:
 *   - Pure (no IO) so it is unit-testable; `adapters/backup-health.ts` feeds it the sidecar's
 *     status file and the `restore-drill-status` ConfigMap the drill reporter writes.
 *   - INTERIM for WP-05's alerting (not merged): a failed bundle or drill is a RED Monitoring item
 *     and a critical operational alert; the drill Job also exits non-zero and logs one JSON line.
 *   - Evidence rules: no status → not green; a stalled sidecar or ref record → RED (an alert); a
 *     report with no check or an unreadable time → red; an enabled drill with NO report, a report
 *     older than its schedule allows ("overdue") or dated in the future → red (an alert); a feature
 *     that is off says so (amber bundles, unknown drills).
 *   - Every item is `cluster: true` (admin scope) on the pipelines lens.
 */
import type { Alert, Health, HealthItem } from '@tabs/monitoring/lib/types';

export type BundlerRepoStatus = { status: 'ok' | 'error'; at: string; lastOkAt?: string; last?: unknown };
export type BundlerStatus = {
  updatedAt?: string;
  lastRescanAt?: string;
  lastRefsRecordAt?: string;
  refsRecordError?: string | null;
  repos: Record<string, BundlerRepoStatus>;
};
export type DrillCheck = { check: string; status: string; reason?: string };
export type DrillReport = { kind: string; at: string; status: 'pass' | 'fail'; checks: DrillCheck[] };
export type DrillInput = { kind: 'weekly' | 'velero'; enabled: boolean; maxAgeDays: number; report: DrillReport | null; readError?: string };
export type BackupInputs = {
  bundlesEnabled: boolean;
  bundler: BundlerStatus | null;
  bundlerReadError?: string;
  rescanSeconds: number;
  refsRecordSeconds: number;
  drills: DrillInput[];
  now: Date;
};

const DRILL_TITLE: Record<DrillInput['kind'], string> = {
  weekly: 'Restore drill (git, Postgres, OpenSearch)',
  velero: 'Velero restore drill (scratch namespace)',
};

function item(id: string, title: string, health: Health, detail: string, ts?: string): HealthItem {
  return { id, lens: 'pipelines', title, health, detail, owner: 'platform', domain: 'platform', cluster: true, ts, links: { systemId: id }, source: 'live' };
}

/** Age in seconds; an absent or unparsable timestamp is infinitely old (never "fresh"). */
const ageSeconds = (iso: string | undefined, now: Date) => {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(t) ? (now.getTime() - t) / 1000 : Number.POSITIVE_INFINITY;
};

function lastMessage(last: unknown): string {
  if (last && typeof last === 'object') {
    const o = last as Record<string, unknown>;
    return String(o.reason ?? o.message ?? JSON.stringify(o)).slice(0, 300);
  }
  return '';
}

export function assessBundles(i: BackupInputs): HealthItem[] {
  if (!i.bundlesEnabled) {
    return [item('bk-bundles', 'Git bundles to object storage', 'amber', 'Off: no repository is bundled off-cluster (backup.gitBundles.enabled). Only the nightly Velero file copy protects the repositories.')];
  }
  if (!i.bundler) {
    return [item('bk-bundles', 'Git bundles to object storage', 'red', `The git-backup sidecar's status is unreadable${i.bundlerReadError ? `: ${i.bundlerReadError}` : ''}. No evidence that commits reach the bucket.`)];
  }
  const out: HealthItem[] = [];
  const repos = Object.entries(i.bundler.repos ?? {});
  for (const [key, r] of repos) {
    if (r.status === 'error') {
      out.push(item(`bk-bundle-${key}`, `Git bundle failing: ${key}`, 'red', `The last bundle of '${key}' failed: ${lastMessage(r.last)}. Last success: ${r.lastOkAt ?? 'never'}.`, r.at));
    }
  }
  if (ageSeconds(i.bundler.lastRescanAt, i.now) > 3 * i.rescanSeconds) {
    // RED (and so an alert): a stalled sidecar means commits are no longer reaching the bucket.
    out.push(item('bk-bundles-stale', 'Git bundle sidecar stalled', 'red', `The sidecar's last full pass was ${i.bundler.lastRescanAt ?? 'never'}; it should run every ${Math.round(i.rescanSeconds / 60)} min.`, i.bundler.updatedAt));
  }
  if (i.bundler.refsRecordError || ageSeconds(i.bundler.lastRefsRecordAt, i.now) > 2 * i.refsRecordSeconds) {
    out.push(item('bk-refs-record', 'Ref-heads record (tamper evidence) behind', 'red', i.bundler.refsRecordError ? `The last record failed: ${i.bundler.refsRecordError}` : `The last record was ${i.bundler.lastRefsRecordAt ?? 'never'}.`, i.bundler.updatedAt));
  }
  if (out.length === 0) {
    out.push(item('bk-bundles', 'Git bundles to object storage', repos.length ? 'green' : 'amber',
      repos.length ? `${repos.length} repositories bundled; the last pass was ${i.bundler.lastRescanAt}.` : 'The sidecar runs but has bundled no repository yet.', i.bundler.updatedAt));
  }
  return out;
}

/** A report dated further ahead than this is refused (clock skew allowance). */
const CLOCK_SLACK_SECONDS = 3600;

export function assessDrill(d: DrillInput, now: Date): HealthItem {
  const id = `bk-drill-${d.kind}`;
  const title = DRILL_TITLE[d.kind];
  if (!d.enabled) return item(id, title, 'unknown', 'Off (the drill CronJob is disabled): no restore has been proven by this OS.');
  if (d.readError) return item(id, title, 'red', `The drill status is unreadable: ${d.readError}.`);
  // RED (and so an alert): an enabled drill with no report means its Job never reached the
  // reporter (image pull, deadline, node loss) or the status write failed — no restore is proven.
  if (!d.report) return item(id, `${title} missing`, 'red', 'Enabled, but no drill has reported: the drill Job has not reached its reporter, so no restore is proven. Run the drill once by hand after enabling it.');
  const checks = Array.isArray(d.report.checks) ? d.report.checks : [];
  if (checks.length === 0) return item(id, `${title} FAILED`, 'red', `The drill report of ${d.report.at} holds no check: nothing was proven.`, d.report.at);
  const failed = checks.filter((c) => c.status !== 'pass');
  if (d.report.status !== 'pass' || failed.length) {
    return item(id, `${title} FAILED`, 'red', `Drill at ${d.report.at} failed: ${failed.map((c) => `${c.check}: ${c.reason ?? 'failed'}`).join('; ').slice(0, 600)}`, d.report.at);
  }
  if (!Number.isFinite(Date.parse(d.report.at))) {
    return item(id, `${title} FAILED`, 'red', `The drill report's time '${String(d.report.at).slice(0, 40)}' is unreadable.`);
  }
  const age = ageSeconds(d.report.at, now);
  if (age < -CLOCK_SLACK_SECONDS) {
    return item(id, `${title} FAILED`, 'red', `The drill report is dated ${d.report.at}, in the future: its time is wrong, so it proves nothing about now.`, d.report.at);
  }
  // RED (and so an alert): a report older than the schedule allows means the drill stopped running.
  if (age > d.maxAgeDays * 86400) {
    return item(id, `${title} overdue`, 'red', `The last passing drill was ${d.report.at}, more than ${d.maxAgeDays} days ago: the drill has stopped reporting.`, d.report.at);
  }
  return item(id, title, 'green', `Passed at ${d.report.at}: ${checks.map((c) => c.check).join(', ')} restored and checked.`, d.report.at);
}

export function assessBackups(i: BackupInputs): HealthItem[] {
  return [...assessBundles(i), ...i.drills.map((d) => assessDrill(d, i.now))];
}

/** Every RED backup item becomes a critical operational alert (interim for WP-05). */
export function backupAlerts(items: HealthItem[]): Alert[] {
  return items
    .filter((it) => it.id.startsWith('bk-') && it.health === 'red')
    .map((it) => ({ id: `al-${it.id}`, severity: 'critical' as const, title: it.title, detail: it.detail, domain: 'platform', owner: 'platform', cluster: true, disposition: 'notified' as const, links: it.links, source: 'live' as const }));
}
