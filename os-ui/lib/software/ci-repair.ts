/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import { roleModel } from '@/lib/models/roles';
import { runTabAgent, renderAssistantText } from '@/lib/assistant/runtime';
import { diffTrees } from '@/lib/software/build-changeset';
import { getSnapshot } from '@/lib/software/snapshot';
import { trace } from '@/lib/infra/agent-governed';
import {
  getAppByIdInternal,
  fetchRunLogTail,
  fetchCommitFiles,
  latestMainSha,
  writeThroughApp,
  systemUserForApp,
  defaultCiRepairState,
  type App,
} from '@/lib/software/apps';

export type { CiRepairState } from '@/lib/software/apps';

/**
 * PHASE C — bounded CI-repair loop.
 *
 * The compile gate (Phase A) stops compile errors BEFORE a commit lands. What can
 * still turn CI red is Docker/build-env-only failure (a missing asset, a dependency
 * that won't install, a base-image issue) and imported-repo deps the gate honestly
 * skips. Today a red run just sits there — honest, but inert.
 *
 * This module closes that gap with ONE bounded, always-honestly-labelled repair turn:
 * when `refreshActionsStage` records a FAILED run, we fetch the failing run's log tail,
 * the failing commit's changed-file list, and open a single REPAIR build turn (same
 * governed harness as a normal build turn) instructed to fix ONLY what the log names,
 * then commit — the compile gate still applies. Bounds are strict: AT MOST one auto-
 * repair per failed run, and if the repaired commit's CI fails again we do NOT loop —
 * we surface the truth ("auto-repair attempted, CI still failing — needs a human").
 *
 * MODEL TIER: the repair turn runs on the REASONING tier. Justification — repair is
 * diagnosis-from-logs (read an error, map it to a fix), which is reasoning-shaped work,
 * the same tier Test/Review use and the same tier the 0.6.54 build escalation upgrades
 * TO on a repeated failure. The owner approved this bounded spend; every surface labels
 * it "reasoning model" so the cost is never hidden.
 *
 * TRIGGER: there is no cron. Detection runs on the existing refresh path (a user or
 * agent looking at the app calls `refreshActionsStage`) PLUS a best-effort in-process
 * one-shot delayed check ~2.5 min after a build turn's commit (`scheduleRepairCheck`).
 * A pod restart loses the pending timer — acceptable, and said so at the call site.
 */

/** Cap for the cleaned log excerpt handed to the repair turn (chars). Error-dense TAIL. */
const LOG_TAIL_CAP = 4000;

/** How long after a build commit to run the one-shot best-effort CI check. */
export const REPAIR_CHECK_DELAY_MS = 150_000; // ~2.5 min — CI usually finishes by then

// ---------------------------------------------------------------- pure helpers --

/**
 * Clean a raw Forgejo Actions log into a compact, error-dense TAIL fit for a model.
 * PURE + unit-tested. Strips the noise that adds tokens without signal:
 *   • ANSI colour codes
 *   • Forgejo/Actions group markers (`##[group]…`, `##[endgroup]`, `::group::`)
 *   • leading ISO or `[HH:MM:SS]` / `2026-…Z ` timestamps on each line
 *   • docker layer chatter (`#12 …`, `sha256:…`, `---> …`, `Pulling fs layer`,
 *     `Extracting`, `Download complete`, `Waiting`, `Already exists`)
 * then collapses runs of blank lines and keeps the LAST `cap` chars (errors sit at
 * the end of a failed build), snapping to a line boundary so we never cut mid-line.
 */
export function cleanCiLog(raw: string, cap = LOG_TAIL_CAP): string {
  if (!raw) return '';
  // eslint-disable-next-line no-control-regex -- ANSI escape sequences are control chars by definition.
  const noAnsi = raw.replace(/\[[0-9;]*m/g, '');
  const kept: string[] = [];
  let blanks = 0;
  for (const rawLine of noAnsi.split('\n')) {
    let line = rawLine.replace(/\r$/, '');
    // Drop Actions group markers entirely.
    if (/^\s*(##\[(group|endgroup|section)\]|::(group|endgroup)::)/.test(line)) continue;
    // Strip a leading timestamp: ISO-8601, or bracketed clock, or Forgejo's `2026-… `.
    line = line.replace(/^\s*(?:\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\]?|\[\d{2}:\d{2}:\d{2}(?:\.\d+)?\])\s*/, '');
    // Drop docker layer / pull chatter — high volume, no repair signal.
    if (/^#\d+\s/.test(line)) continue;
    if (/^\s*(--->|sha256:|Pulling fs layer|Extracting|Download complete|Downloading|Waiting|Already exists|Pull complete|Digest:|Status: (Downloaded|Image is up to date))/.test(line)) continue;
    if (line.trim() === '') {
      blanks += 1;
      if (blanks > 1) continue; // collapse runs of blanks
      kept.push('');
      continue;
    }
    blanks = 0;
    kept.push(line);
  }
  let out = kept.join('\n').trim();
  if (out.length > cap) {
    out = out.slice(out.length - cap);
    const nl = out.indexOf('\n');
    if (nl > 0 && nl < 200) out = out.slice(nl + 1); // snap to a clean line start
    out = `…(log truncated — showing the last ${cap} chars)\n${out}`;
  }
  return out;
}

/** Build the REPAIR-turn user message. PURE + unit-tested. Names the log, the failing
 *  commit's changed files, and the fix-ONLY-what-the-log-says instruction. */
export function repairSeed(input: { log: string; changedFiles: string[]; sha: string }): string {
  const files = input.changedFiles.length
    ? input.changedFiles.map((f) => `  - ${f}`).join('\n')
    : '  (the failing commit changed no tracked files, or the list was unavailable)';
  return [
    'AUTO-REPAIR: the last CI build for this app FAILED. Read the CI log excerpt below and',
    'fix ONLY the specific cause it names — a missing asset, a dependency that would not',
    'install, a build-env/Dockerfile issue, or a broken import. Do NOT redesign, refactor,',
    'add features, or touch anything the log does not implicate. Make the smallest change',
    'that turns this build green, then commit it (the compile gate still applies).',
    'When you commit, PREFIX the commit message with "repair(ci): " so the fix is clearly',
    'labelled as an automated CI repair in the app history.',
    'If the log does not clearly name a fixable cause, say so plainly and do NOT commit a guess.',
    '',
    `## Failing commit (${input.sha.slice(0, 10)}) changed these files`,
    files,
    '',
    '## CI log (tail — timestamps and docker layer noise stripped)',
    '```',
    input.log || '(the CI log could not be retrieved — investigate from the changed files above)',
    '```',
  ].join('\n');
}

// -------------------------------------------------------- orchestration (loop) --

/** The server-side repair turn: runs the SAME `software` build harness on the reasoning
 *  tier, scoped to this app, and returns whether it committed + the head sha it produced.
 *  Injectable so the bounds logic is unit-testable without a live LiteLLM/Forgejo. */
export type RunRepairTurn = (args: {
  app: App;
  user: CurrentUser;
  seed: string;
}) => Promise<{ committed: boolean; text: string; headSha: string | null }>;

async function defaultRunRepairTurn(args: { app: App; user: CurrentUser; seed: string }): Promise<{ committed: boolean; text: string; headSha: string | null }> {
  const before = getSnapshot(args.app.id);
  const result = await runTabAgent({
    user: args.user,
    tab: 'software',
    messages: [{ role: 'user', content: args.seed }],
    // Repair runs the build tools (commit path) scoped to THIS app — same as a build turn.
    // A model-supplied appId that MATCHES is accepted; an omitted one is filled in.
    boundArgs: { appId: args.app.id },
    // REASONING tier: repair is diagnosis-from-logs. runTabAgent already PLANS on the
    // reasoning model; a repair is a small targeted fix (not the bulk code-generation
    // the standard tier is for), so we also arm the one-shot escalation to reasoning so
    // any tool-shape retry stays on the reasoning tier — reasoning throughout, honestly.
    escalateActModel: roleModel('reasoning'),
  });
  const text = renderAssistantText(result);
  const changes = diffTrees(before, getSnapshot(args.app.id));
  // The repair commit becomes main's new head — capture it so a re-fail of THIS sha is
  // recognised as "our repair failed CI" (the no-loop guard), not a fresh failure.
  const headSha = changes.length > 0 ? await latestMainSha(args.app) : null;
  return { committed: changes.length > 0, text, headSha };
}

/**
 * Test seam: the repair turn `maybeAutoRepair` uses when no explicit `deps` is passed
 * (i.e. the fire-and-forget path from `refreshActionsStage`). Defaults to the live
 * reasoning-tier turn; a test may swap in a fake to prove the DETECTION wiring calls it
 * exactly once without a live LiteLLM. Never used in production code paths beyond the default.
 */
let defaultTurn: RunRepairTurn = defaultRunRepairTurn;

/** Test-only: override the default repair turn (returns a restore fn). */
export function __setDefaultRepairTurn(fn: RunRepairTurn): () => void {
  const prev = defaultTurn;
  defaultTurn = fn;
  return () => {
    defaultTurn = prev;
  };
}

/**
 * Detect + (at most once) auto-repair a FAILED CI run for an app. Called fire-and-forget
 * from `refreshActionsStage`'s failing branch and from the post-commit delayed check.
 *
 * Bounds (all enforced here, tested):
 *   • opt-out: `ciRepair.autoRepairEnabled === false` ⇒ skip (owner turned it off).
 *   • at-most-once per run: if we already opened a repair for `failedRunId`, skip.
 *   • no loop: if the failing head sha === the sha OUR last repair produced, we do NOT
 *     repair again — the repair itself failed CI; we record the honest terminal state.
 *
 * Best-effort: any error is swallowed (traced) — a repair attempt must never break the
 * status refresh it rides on.
 */
export async function maybeAutoRepair(
  app: App,
  failedRun: { id: string; headSha: string },
  deps?: { runRepairTurn?: RunRepairTurn },
): Promise<{ action: 'repaired' | 'skipped' | 'no-loop' | 'error'; reason: string }> {
  const state = app.ciRepair ?? defaultCiRepairState();
  try {
    if (state.autoRepairEnabled === false) {
      return { action: 'skipped', reason: 'auto-repair is turned off for this app' };
    }
    // NO LOOP: the failing commit IS the one our repair produced → the repair did not
    // fix CI. Record the honest terminal state ONCE; never open a second repair.
    if (state.repairCommitSha && state.repairCommitSha === failedRun.headSha) {
      if (state.outcome !== 'attempted-still-failing') {
        app.ciRepair = { ...state, outcome: 'attempted-still-failing', lastAttemptAt: new Date().toISOString() };
        writeThroughApp(app);
      }
      return { action: 'no-loop', reason: 'auto-repair already attempted; the repaired commit still fails CI — needs a human/build turn' };
    }
    // AT MOST ONCE per failed run.
    if (state.repairedRunId === failedRun.id) {
      return { action: 'skipped', reason: 'this failed run already had its one auto-repair' };
    }

    // Claim this run BEFORE the (slow) turn so a concurrent refresh cannot double-fire.
    app.ciRepair = { ...state, repairedRunId: failedRun.id, lastAttemptAt: new Date().toISOString(), outcome: 'skipped' };
    writeThroughApp(app);

    const [log, changedFiles] = await Promise.all([
      fetchRunLogTail(app, failedRun.id),
      fetchCommitFiles(app, failedRun.headSha),
    ]);
    const seed = repairSeed({ log: cleanCiLog(log), changedFiles, sha: failedRun.headSha });

    const user = systemUserForApp(app);
    const run = deps?.runRepairTurn ?? defaultTurn;
    const outcome = await run({ app, user, seed });

    // Re-read the freshest app state (the turn committed through commitToApp, which
    // mutates the same record) and record what actually happened.
    const fresh = (await getAppByIdInternal(app.id)) ?? app;
    const freshState = fresh.ciRepair ?? app.ciRepair ?? defaultCiRepairState();
    fresh.ciRepair = {
      ...freshState,
      repairedRunId: failedRun.id,
      repairCommitSha: outcome.committed ? (outcome.headSha ?? freshState.repairCommitSha) : freshState.repairCommitSha,
      lastAttemptAt: new Date().toISOString(),
      outcome: outcome.committed ? 'repaired' : 'skipped',
    };
    writeThroughApp(fresh);

    void trace({
      principal: app.mcpPrincipal,
      tool: 'generate',
      input: { action: 'ci_auto_repair', repo: app.repo.fullName, failedRunId: failedRun.id, headSha: failedRun.headSha, tier: 'reasoning' },
      output: { committed: outcome.committed },
      decision: 'allow',
    });

    return outcome.committed
      ? { action: 'repaired', reason: 'auto-repair turn committed a fix (reasoning model); CI will re-run' }
      : { action: 'skipped', reason: 'auto-repair turn did not find a safe fix to commit' };
  } catch (e) {
    void trace({
      principal: app.mcpPrincipal,
      tool: 'generate',
      input: { action: 'ci_auto_repair', repo: app.repo.fullName, failedRunId: failedRun.id },
      output: { error: (e as Error).message },
      decision: 'allow',
    });
    return { action: 'error', reason: (e as Error).message };
  }
}

// --------------------------------------------------- post-commit delayed check --

/** Timers we own so a test/shutdown can flush them; keyed by appId (one pending each). */
const pendingChecks = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Schedule a ONE-SHOT best-effort CI check ~2.5 min after a build turn's commit. There
 * is no cron/queue in this environment, so this is a plain in-process timer: it survives
 * only as long as THIS pod does — a restart loses the pending check and that is acceptable
 * (the next time anyone opens the app, `refreshActionsStage` runs the same detection). We
 * de-dupe per app so rapid commits don't stack timers.
 */
export function scheduleRepairCheck(appId: string): void {
  const existing = pendingChecks.get(appId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingChecks.delete(appId);
    void runScheduledCheck(appId);
  }, REPAIR_CHECK_DELAY_MS);
  // Do not keep the process alive just for this best-effort check.
  if (typeof timer === 'object' && timer && 'unref' in timer) (timer as { unref: () => void }).unref();
  pendingChecks.set(appId, timer);
}

async function runScheduledCheck(appId: string): Promise<void> {
  try {
    const app = await getAppByIdInternal(appId);
    if (!app || app.mode !== 'live') return;
    // Force a status refresh; its failing branch fires `maybeAutoRepair` itself.
    const { refreshActionsStage } = await import('@/lib/software/apps');
    await refreshActionsStage(app, { force: true });
  } catch {
    /* best-effort — a lost check is re-covered by the next on-load refresh */
  }
}

/** Test-only: cancel any pending timers so the suite exits cleanly. */
export function __clearPendingChecks(): void {
  for (const t of pendingChecks.values()) clearTimeout(t);
  pendingChecks.clear();
}
