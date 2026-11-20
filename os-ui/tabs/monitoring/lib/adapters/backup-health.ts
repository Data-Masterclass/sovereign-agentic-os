/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Backup and restore-drill health adapter (WP-56)
 * USER STORY: As a platform admin I want Monitoring to read the REAL bundle and drill status.
 * ARCHITECTURE:
 *   - Server-only, read-only. Two sources, both written by the backup jobs themselves:
 *       • the git-backup sidecar's status file on the volume it shares with os-ui
 *         (`GIT_BACKUP_STATUS_FILE`; set by the chart only when bundles are enabled);
 *       • the `restore-drill-status` ConfigMap (`RESTORE_DRILL_STATUS_CONFIGMAP`), keys
 *         `weekly.json` and `velero.json`, patched by the drill reporter.
 *   - Which features are ON comes from the chart (`RESTORE_DRILL_ENABLED`, `VELERO_DRILL_ENABLED`),
 *     so "off" is said as off and "on but silent" is never green. Assessment: backup-health-core.ts.
 */
import 'server-only';
import { readFile } from 'node:fs/promises';
import { k8s } from '@core/infra/k8s';
import { config } from '@core/kernel/config';
import { assessBackups, type BundlerStatus, type DrillInput, type DrillReport } from '@tabs/monitoring/lib/backup-health-core';
import type { HealthItem } from '@tabs/monitoring/lib/types';

const on = (v: string | undefined) => v === 'true';
const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);

async function readBundler(file: string): Promise<{ status: BundlerStatus | null; error?: string }> {
  try {
    return { status: JSON.parse(await readFile(file, 'utf8')) as BundlerStatus };
  } catch (e) {
    return { status: null, error: e instanceof Error ? e.message : String(e) };
  }
}

async function readDrills(name: string): Promise<{ data: Record<string, string>; error?: string }> {
  const { status, body } = await k8s('GET', `/api/v1/namespaces/${config.platformNamespace}/configmaps/${name}`);
  if (status !== 200) return { data: {}, error: `ConfigMap ${name}: HTTP ${status || 'unreachable'}` };
  return { data: ((body as { data?: Record<string, string> }).data ?? {}) };
}

/** A report that does not parse is a read error (red), never "no report yet". */
function parseReport(raw: string | undefined): { report: DrillReport | null; error?: string } {
  if (!raw) return { report: null };
  try {
    return { report: JSON.parse(raw) as DrillReport };
  } catch (e) {
    return { report: null, error: `the stored report is not JSON (${e instanceof Error ? e.message : String(e)})` };
  }
}

export async function collectBackups(now = new Date()): Promise<HealthItem[]> {
  const env = process.env;
  const statusFile = env.GIT_BACKUP_STATUS_FILE;
  const bundler = statusFile ? await readBundler(statusFile) : { status: null };
  const weeklyOn = on(env.RESTORE_DRILL_ENABLED);
  const veleroOn = on(env.VELERO_DRILL_ENABLED);
  const cm = env.RESTORE_DRILL_STATUS_CONFIGMAP;
  const drillsRead = cm && (weeklyOn || veleroOn) ? await readDrills(cm) : { data: {} as Record<string, string> };
  const weekly = parseReport(drillsRead.data['weekly.json']);
  const velero = parseReport(drillsRead.data['velero.json']);
  const drills: DrillInput[] = [
    { kind: 'weekly', enabled: weeklyOn, maxAgeDays: 8, report: weekly.report, readError: weeklyOn ? drillsRead.error ?? weekly.error : undefined },
    { kind: 'velero', enabled: veleroOn, maxAgeDays: 32, report: velero.report, readError: veleroOn ? drillsRead.error ?? velero.error : undefined },
  ];
  return assessBackups({
    bundlesEnabled: Boolean(statusFile),
    bundler: bundler.status,
    bundlerReadError: bundler.error,
    rescanSeconds: num(env.GIT_BACKUP_RESCAN_SECONDS, 600),
    refsRecordSeconds: num(env.GIT_BACKUP_REFS_RECORD_SECONDS, 3600),
    drills,
    now,
  });
}
