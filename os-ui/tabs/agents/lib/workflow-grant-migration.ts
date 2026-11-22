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

/** What the schedule remembers between passes, so one broken system is reported once, not every two minutes. */
export type MigrationState = { attempts: number; reported: Set<string> };
export const newMigrationState = (): MigrationState => ({ attempts: 0, reported: new Set() });

/** After this many passes that still fail on the same systems, the schedule stops and says so once. */
export const MAX_FAILED_PASSES = 3;

export type PassOutcome =
  | 'pending' // the registry has not hydrated from the durable mirror: try again
  | 'clean' // read, nothing left to rewrite, nothing failed: done
  | 'failed' // some systems could not be rewritten: try again (quietly), up to MAX_FAILED_PASSES
  | 'gave-up'; // the last allowed pass: reported once, no more retries

/** One pass. */
export async function runWorkflowGrantMigrationPass(
  mode: MigrationMode,
  io: {
    ensureHydrated: () => Promise<void>;
    migrate: (o: { dryRun: boolean }) => ReturnType<typeof import('@tabs/agents/lib/store').migrateStoredWorkflowGrants>;
    log: (line: string) => void;
  },
  state: MigrationState = newMigrationState(),
): Promise<PassOutcome> {
  if (mode === 'off') return 'clean';
  await io.ensureHydrated();
  const report = io.migrate({ dryRun: mode === 'dry-run' });
  if (!report) return 'pending';
  for (const c of report.changed) {
    io.log(`[workflow-grants] ${mode === 'dry-run' ? 'WOULD rewrite' : 'rewrote'} system ${c.id} (${c.domain || 'no domain'}): ${c.findings.join('; ')}`);
  }
  // A system that cannot be rewritten (its definition no longer parses, say) is reported ONCE; it keeps
  // running through the read path, and retrying it every two minutes forever would only fill the log.
  for (const f of report.failed) {
    if (state.reported.has(f.id)) continue;
    state.reported.add(f.id);
    io.log(`[workflow-grants] WARNING could NOT rewrite system ${f.id}: ${f.error} (it keeps running: the read path upgrades it)`);
  }
  io.log(`[workflow-grants] ${mode} pass done — ${report.scanned} system(s), ${report.changed.length} ${mode === 'dry-run' ? 'to rewrite' : 'rewritten'}, ${report.failed.length} failed`);
  if (report.failed.length === 0) return 'clean';
  state.attempts += 1;
  if (state.attempts < MAX_FAILED_PASSES) return 'failed';
  io.log(`[workflow-grants] giving up after ${state.attempts} passes on: ${report.failed.map((f) => f.id).join(', ')} — fix or delete them, then restart os-ui to try again`);
  return 'gave-up';
}

const g = globalThis as unknown as { __osWorkflowGrantMigration?: boolean };

/** At boot of os-ui web. Never throws into boot. */
export function scheduleBootWorkflowGrantMigration(mode: MigrationMode = migrationModeFromEnv(), retryMs = 120_000): void {
  if (g.__osWorkflowGrantMigration || mode === 'off') return;
  g.__osWorkflowGrantMigration = true;
  const state = newMigrationState();
  let stop: (() => void) | undefined;
  let finished = false;
  const tick = async () => {
    if (finished) return;
    const store = await import('@tabs/agents/lib/store');
    const outcome = await runWorkflowGrantMigrationPass(mode, {
      ensureHydrated: store.ensureHydrated,
      migrate: (o) => store.migrateStoredWorkflowGrants(o),
      log: (l) => console.log(l),
    }, state);
    if (outcome === 'clean' || outcome === 'gave-up') {
      finished = true;
      stop?.();
    }
  };
  stop = scheduleEvery('workflow-grant-migration', retryMs, tick);
  void tick().catch((e) => console.error(`[workflow-grants] first attempt failed: ${(e as Error)?.message ?? String(e)}`));
}
