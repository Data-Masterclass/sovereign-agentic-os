/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Boot-time rewrite of stored agent systems to the workflow/knowledge split
 * USER STORY: As a platform operator I want every stored agent system's `system.yaml` to name its
 *             workflows as workflows after an upgrade — and I want to see what would change first —
 *             without any system stopping.
 * ARCHITECTURE:
 *   - The rule lives in `legacy-workflow-grants.ts` (pure) and is applied on READ by `parseSystem`,
 *     so a system runs correctly with or without this pass. This pass only makes the stored text agree.
 *   - `OS_WORKFLOW_GRANT_MIGRATION`: `apply` (default) rewrites; `dry-run` logs what it would rewrite
 *     and writes nothing; `off` skips. Idempotent: a second pass finds nothing and logs nothing.
 *   - Each rewrite is also a version in the system's history and a commit in the domain repo (the
 *     ordinary definition-change path), which is its audit trail.
 *   - Retried every two minutes until the registry has hydrated from the durable mirror (a migration
 *     must not conclude "nothing to do" from an empty registry), then stops.
 *   - os-ui web only (the run worker cannot commit a definition change).
 */
import 'server-only';
import { scheduleEvery } from '@core/reconcile/runtime';

export type MigrationMode = 'apply' | 'dry-run' | 'off';

export function migrationModeFromEnv(raw: string | undefined = process.env.OS_WORKFLOW_GRANT_MIGRATION): MigrationMode {
  const v = (raw ?? '').trim().toLowerCase();
  return v === 'dry-run' || v === 'off' ? v : 'apply';
}

/** One pass. Returns true when the registry was readable (so the schedule may stop). */
export async function runWorkflowGrantMigrationPass(
  mode: MigrationMode,
  io: {
    ensureHydrated: () => Promise<void>;
    migrate: (o: { dryRun: boolean }) => ReturnType<typeof import('@tabs/agents/lib/store').migrateStoredWorkflowGrants>;
    log: (line: string) => void;
  },
): Promise<boolean> {
  if (mode === 'off') return true;
  await io.ensureHydrated();
  const report = io.migrate({ dryRun: mode === 'dry-run' });
  if (!report) return false;
  for (const c of report.changed) {
    io.log(`[workflow-grants] ${mode === 'dry-run' ? 'WOULD rewrite' : 'rewrote'} system ${c.id} (${c.domain || 'no domain'}): ${c.findings.join('; ')}`);
  }
  for (const f of report.failed) io.log(`[workflow-grants] could NOT rewrite system ${f.id}: ${f.error} (it keeps running: the read path upgrades it)`);
  io.log(`[workflow-grants] ${mode} pass done — ${report.scanned} system(s), ${report.changed.length} ${mode === 'dry-run' ? 'to rewrite' : 'rewritten'}, ${report.failed.length} failed`);
  return report.failed.length === 0;
}

const g = globalThis as unknown as { __osWorkflowGrantMigration?: boolean };

/** At boot of os-ui web. Never throws into boot. */
export function scheduleBootWorkflowGrantMigration(mode: MigrationMode = migrationModeFromEnv(), retryMs = 120_000): void {
  if (g.__osWorkflowGrantMigration || mode === 'off') return;
  g.__osWorkflowGrantMigration = true;
  let stop: (() => void) | undefined;
  let finished = false;
  const tick = async () => {
    if (finished) return;
    const store = await import('@tabs/agents/lib/store');
    const done = await runWorkflowGrantMigrationPass(mode, {
      ensureHydrated: store.ensureHydrated,
      migrate: (o) => store.migrateStoredWorkflowGrants(o),
      log: (l) => console.log(l),
    });
    if (done) {
      finished = true;
      stop?.();
    }
  };
  stop = scheduleEvery('workflow-grant-migration', retryMs, tick);
  void tick().catch((e) => console.error(`[workflow-grants] first attempt failed: ${(e as Error)?.message ?? String(e)}`));
}
