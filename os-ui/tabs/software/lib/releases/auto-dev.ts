/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder (C2) - every green build runs in Dev, and in a preview slot
 * USER STORY: As an app builder I push, the checks go green, and a minute later my change runs on the Dev URL and on its
 *             own preview URL, without pressing anything.
 * ARCHITECTURE: (spec 6.3)
 *   - `autoDevDecision` (pure): a check record leads to a Dev release ONLY when ALL hold: switch on; a v2 app; the record
 *     is FINISHED and green by `recordVerdict` (every gate, the tree scan, the image build and push pass); the image scan
 *     (`scan-image`) ran and passed; the record carries a digest from the pipeline's `digest` result (never from a log);
 *     the sha is the app's NEWEST record (an older run finishing late never replaces a newer Dev); and no Dev release of
 *     that sha and digest exists yet (idempotent; a failed one is not retried automatically - a new push or a manual
 *     release does that).
 *   - `autoDeployDev`: the Dev rollout (rollout.ts: hooks, overlay, apply), then the same release into a preview slot.
 *     The release is attributed to the commit's run, recorded as `by: 'auto-dev'`.
 *   - Called by checks-sync when a run's record finishes (and by nothing else); a failure is recorded on the release and
 *     logged, never thrown into the sync.
 */
import 'server-only';
import { appBuilderEnabled } from '@core/kernel/app-builder-flag';
import { templateVersionOf } from '@tabs/software/lib/app-builder-contracts';
import type { App } from '@tabs/software/lib/apps';
import { recordVerdict, type CheckRecord } from '@tabs/software/lib/check-record';
import { releasesOf } from '@tabs/software/lib/releases/store';
import { rolloutRelease, type RolloutDeps, type RolloutResult } from '@tabs/software/lib/releases/rollout';
import { fillPreview } from '@tabs/software/lib/releases/previews';

export const AUTO_DEV_ACTOR = { id: 'auto-dev', name: 'Auto Dev release' } as const;
export const IMAGE_SCAN_CHECK = 'scan-image';

export type AutoDevDecision = { ok: true; digest: string } | { ok: false; reason: string };

export function autoDevDecision(app: Pick<App, 'templateVersion' | 'checks' | 'releases'>, rec: CheckRecord): AutoDevDecision {
  if (!appBuilderEnabled()) return { ok: false, reason: 'the App Builder is not enabled' };
  if (templateVersionOf(app) !== 2) return { ok: false, reason: 'not an App Builder app' };
  const v = recordVerdict(rec, rec.sha);
  if (!v.green) return { ok: false, reason: v.reason };
  const scan = rec.checks.find((c) => c.id === IMAGE_SCAN_CHECK);
  if (!scan || scan.status !== 'pass') return { ok: false, reason: 'the image scan did not run or did not pass' };
  if (!rec.digest || !/^sha256:[0-9a-f]{64}$/.test(rec.digest)) return { ok: false, reason: 'the run produced no image digest' };
  const newest = (app.checks ?? []).find((r) => r.status !== 'superseded');
  if (newest && newest.sha !== rec.sha) return { ok: false, reason: `a newer commit ${newest.sha.slice(0, 12)} exists` };
  if (releasesOf(app, 'dev').some((r) => r.sha === rec.sha && r.digest === rec.digest)) return { ok: false, reason: 'this build is already released to Dev' };
  return { ok: true, digest: rec.digest };
}

export type AutoDevResult = { dev: RolloutResult; preview: RolloutResult | null } | { skipped: string };

export async function autoDeployDev(app: App, rec: CheckRecord, deps: RolloutDeps = {}): Promise<AutoDevResult> {
  const d = autoDevDecision(app, rec);
  if (!d.ok) return { skipped: d.reason };
  const dev = await rolloutRelease(app, { env: 'dev', sha: rec.sha, digest: d.digest, by: AUTO_DEV_ACTOR, reason: 'auto-dev' }, deps);
  if (!dev.ok) {
    console.error(`[os-ui] auto-dev: ${app.domain}/${app.slug}@${rec.sha.slice(0, 12)} not released to Dev (${dev.code}): ${dev.reason.slice(0, 300)}`);
    return { dev, preview: null };
  }
  const preview = await fillPreview(app, dev.release, deps);
  if (!preview.ok) console.error(`[os-ui] auto-dev: preview slot for ${app.domain}/${app.slug}@${rec.sha.slice(0, 12)} failed (${preview.code}): ${preview.reason.slice(0, 300)}`);
  return { dev, preview };
}
