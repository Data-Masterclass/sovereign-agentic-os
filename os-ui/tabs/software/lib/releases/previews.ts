/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder (C2) - a preview URL per change in two fixed slots, scaled to zero when idle
 * USER STORY: As an app builder I want the last two changes each on their own URL, so I can compare them, without
 *             paying for previews nobody looks at.
 * ARCHITECTURE: (spec 6.5)
 *   - Two fixed slots per app, `p1` and `p2` (Deployments `appResourceName(domain, slug, 'p1'|'p2')` in `apps-dev`, hosts
 *     `<label>-p1|p2.<domain>.dev.<appsDomain>`), so their TLS certificates are issued once and reused. A new dev release
 *     takes the slot that serves the same sha (a re-deploy), else an empty slot, else the slot holding the OLDER release.
 *   - A slot runs the dev release's sha and digest with the same overlay plus the slot names; it shares the Dev database
 *     and env Secret (migrations are forward-only; the expand/contract rule is in the template), and runs no hooks (the
 *     Dev rollout of that sha just ran them).
 *   - Idle: a slot whose release (or last wake, `start_preview`) is older than PREVIEW_IDLE_MS is scaled to 0 by the
 *     reconciler (reconcile.ts). Scaling is the only thing the reconciler does to a slot; waking scales it back to 1.
 */
import 'server-only';
import type { AppRelease, PreviewSlot } from '@tabs/software/lib/app-builder-contracts';
import { appResourceName } from '@tabs/software/lib/app-builder-contracts';
import type { App } from '@tabs/software/lib/apps';
import { deploymentStatus, scaleDeployment, type RunnerK8s, type RunnerStatus } from '@tabs/software/lib/runner';
import { currentRelease } from '@tabs/software/lib/releases/store';
import { envNamespaceOf, releaseUrl, rolloutRelease, type RolloutDeps, type RolloutResult } from '@tabs/software/lib/releases/rollout';

export const PREVIEW_SLOTS: readonly PreviewSlot[] = ['p1', 'p2'];
export const PREVIEW_IDLE_MS = 8 * 60 * 60 * 1000;

/** Pure: the slot a new dev release of `sha` takes. */
export function chooseSlot(app: Pick<App, 'releases'>, sha: string): PreviewSlot {
  const held = PREVIEW_SLOTS.map((slot) => ({ slot, r: currentRelease(app, 'dev', slot) }));
  const same = held.find((h) => h.r?.sha === sha);
  if (same) return same.slot;
  const empty = held.find((h) => !h.r);
  if (empty) return empty.slot;
  return [...held].sort((x, y) => (x.r as AppRelease).at.localeCompare((y.r as AppRelease).at))[0].slot;
}

/** Put a running dev release into a preview slot (same sha and digest; no hooks). */
export async function fillPreview(app: App, release: AppRelease, deps: RolloutDeps = {}): Promise<RolloutResult> {
  const slot = chooseSlot(app, release.sha);
  return rolloutRelease(app, { env: 'dev', slot, sha: release.sha, digest: release.digest, by: { id: release.by }, reason: 'preview', skipHooks: true }, deps);
}

const wakes = new Map<string, number>();
const wakeKey = (app: Pick<App, 'id'>, slot: PreviewSlot) => `${app.id}/${slot}`;

/** Pure: is this slot idle at `now` (its release and its last wake both older than the idle window)? */
export function slotIdle(release: Pick<AppRelease, 'at'> | null, lastWake: number | undefined, now: number, idleMs = PREVIEW_IDLE_MS): boolean {
  if (!release) return false;
  const since = Math.max(Date.parse(release.at) || 0, lastWake ?? 0);
  return now - since >= idleMs;
}

export type PreviewView = { slot: PreviewSlot; sha: string | null; digest: string | null; releaseId: string | null; url: string | null; at: string | null; status: RunnerStatus | null; idle: boolean };

export type PreviewDeps = { k8s?: RunnerK8s; namespace?: string; now?: () => number; appsDomain?: string };

/** Both slots of an app with what each serves and its real status. */
export async function previewViews(app: App, deps: PreviewDeps = {}): Promise<PreviewView[]> {
  const ns = deps.namespace ?? envNamespaceOf('dev');
  const now = (deps.now ?? Date.now)();
  return Promise.all(
    PREVIEW_SLOTS.map(async (slot) => {
      const r = currentRelease(app, 'dev', slot);
      const status = r ? await deploymentStatus(ns, appResourceName(app.domain, app.slug, slot), deps.k8s) : null;
      return { slot, sha: r?.sha ?? null, digest: r?.digest ?? null, releaseId: r?.id ?? null, url: r ? releaseUrl(app, 'dev', slot, deps.appsDomain) : null, at: r?.at ?? null, status, idle: slotIdle(r, wakes.get(wakeKey(app, slot)), now) };
    }),
  );
}

/** Scale every idle, still-running slot of `app` to zero. Returns the slots it stopped. */
export async function stopIdlePreviews(app: App, deps: PreviewDeps = {}): Promise<PreviewSlot[]> {
  const ns = deps.namespace ?? envNamespaceOf('dev');
  const now = (deps.now ?? Date.now)();
  const stopped: PreviewSlot[] = [];
  for (const slot of PREVIEW_SLOTS) {
    const r = currentRelease(app, 'dev', slot);
    if (!slotIdle(r, wakes.get(wakeKey(app, slot)), now)) continue;
    const name = appResourceName(app.domain, app.slug, slot);
    const st = await deploymentStatus(ns, name, deps.k8s);
    if (st.phase === 'stopped' || st.phase === 'absent' || st.phase === 'offline') continue;
    const res = await scaleDeployment(ns, name, 0, deps.k8s);
    if (res.ok) stopped.push(slot);
  }
  return stopped;
}

/** `start_preview`: wake both slots that hold a release (scale to 1) and restart their idle clock. */
export async function wakePreviews(app: App, deps: PreviewDeps = {}): Promise<PreviewSlot[]> {
  const ns = deps.namespace ?? envNamespaceOf('dev');
  const woke: PreviewSlot[] = [];
  for (const slot of PREVIEW_SLOTS) {
    if (!currentRelease(app, 'dev', slot)) continue;
    wakes.set(wakeKey(app, slot), (deps.now ?? Date.now)());
    const name = appResourceName(app.domain, app.slug, slot);
    const st = await deploymentStatus(ns, name, deps.k8s);
    if (st.phase === 'stopped' && (await scaleDeployment(ns, name, 1, deps.k8s)).ok) woke.push(slot);
  }
  return woke;
}

/** Tests only. */
export function __resetPreviewWakes(): void {
  wakes.clear();
}
