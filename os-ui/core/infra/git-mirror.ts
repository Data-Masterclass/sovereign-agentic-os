/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Push-mirror for a domain repo — the ONE push path, for data and agent commits alike
 * USER STORY: As a platform admin I want the domain repository the OS writes (dbt project AND
 *             agent systems) pushed to our GitHub / Forgejo remote after every commit, with the
 *             token held as a Secret reference the OS never shows, and a failed push REPORTED on
 *             Platform → Components & Health and retried on the next commit — never blocking a
 *             save (checklist X2).
 * ARCHITECTURE:
 *   - ONE CONFIG, NOT TWO. The record (`{url, tokenSecretRef}`) is B1's: the same in-process map
 *     (`Symbol.for('soa.data.project-mirrors')`) and the same durable index
 *     (`config.dataProjectMirrorsIndex`) that `tabs/data/lib/dbt/mirror.ts` writes from the
 *     admin-only route. This module adds NO setter and NO second validation: it reads that record,
 *     pushes through `core/infra/git-store.ts` `push` (which resolves the token from its Secret
 *     reference at call time, uses it once and scrubs it from any error) and records the outcome
 *     back onto the SAME record. Part D's agents half lives in @core because a tab may not import
 *     another tab; collapsing the data half onto this module is a follow-up (deviation D-5).
 *   - Status is therefore written by whichever side committed, and read by ONE health row — so an
 *     admin sees the true last outcome regardless of which generator caused the push.
 *   - Fire-and-forget: `pushMirrorAfterCommit` reports and never throws into a write.
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { osMirror } from '@core/infra/os-mirror';
import { push, type MirrorConfig, type GitStoreOptions, type PushDeps } from '@core/infra/git-store';

export type MirrorStatus = { lastSha?: string; lastPushedAt?: string; lastError?: string; lastErrorAt?: string };

/** B1's record shape (`tabs/data/lib/dbt/mirror.ts` `ProjectMirror`) — structurally identical. */
export type ProjectMirror = MirrorConfig & {
  domain: string;
  updatedAt: string;
  updatedBy: string;
  status: MirrorStatus;
};

type State = { byDomain: Map<string, ProjectMirror>; hydration: Promise<void> | null };
/** THE SAME key the data tab's mirror store uses — one map, one config, two readers. */
const KEY = Symbol.for('soa.data.project-mirrors');
function state(): State {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  if (!g[KEY]) g[KEY] = { byDomain: new Map(), hydration: null };
  return g[KEY]!;
}

const durable = osMirror({ index: config.dataProjectMirrorsIndex });

/** Load the configured mirrors once (idempotent; a failed hydration is retried, never cached). */
export async function ensureMirrorsHydrated(): Promise<void> {
  const s = state();
  if (!s.hydration) {
    s.hydration = (async () => {
      const docs = await durable.hydrate(500);
      if (docs === null) {
        s.hydration = null;
        return;
      }
      for (const doc of docs as ProjectMirror[]) {
        if (doc && doc.domain && !s.byDomain.has(doc.domain)) s.byDomain.set(doc.domain, doc);
      }
    })();
  }
  return s.hydration;
}

/** The mirror configured for `domain`, or null. */
export function getMirror(domain: string): ProjectMirror | null {
  return state().byDomain.get(domain) ?? null;
}

/** Every configured mirror, sorted by domain (admin read; the URL never carries credentials). */
export function listMirrors(): ProjectMirror[] {
  return [...state().byDomain.values()].sort((a, b) => a.domain.localeCompare(b.domain));
}

export type PushOutcome = { ok: boolean; error?: string };

/** `GitStoreOptions` plus the test seams the git store's `push` itself takes. */
export type MirrorPushOptions = PushDeps & {
  pushFn?: typeof push;
  /** Injected egress check (tests). Defaults to the admin allowlist in `core/infra/secrets`. */
  egressCheck?: (url: string) => { allowed: boolean; host: string } | Promise<{ allowed: boolean; host: string }>;
};

/** The refusal message when the mirror host is no longer allowed to receive egress, else null. */
async function assertEgressAllowed(url: string, opts: MirrorPushOptions): Promise<string | null> {
  try {
    const check = opts.egressCheck ?? (await import('@core/infra/secrets')).isEgressAllowed;
    const verdict = await check(url);
    if (verdict.allowed) return null;
    return `mirror host '${verdict.host}' is not on the egress allowlist — push refused`;
  } catch (e) {
    // The allowlist itself could not be read. Fail CLOSED: pushing a whole domain repository to a
    // host whose standing we cannot establish is the one outcome worse than not pushing.
    return `egress allowlist unavailable (${e instanceof Error ? e.message : String(e)}) — push refused`;
  }
}

/** Push `main` to the configured mirror and record the outcome. Null when none is configured. */
export async function pushMirror(domain: string, opts: MirrorPushOptions = {}): Promise<PushOutcome | null> {
  const rec = state().byDomain.get(domain);
  if (!rec) return null;
  // Part D review L-4: the admin route checked egress when the mirror was CONFIGURED; the
  // allowlist is editable, so it is re-checked HERE, at the moment the OS would actually send a
  // domain's whole repository to that host. A host taken off the allowlist stops being pushed to
  // on the next commit, and the refusal is recorded on the record like any other failure —
  // never a silent success and never an attempt.
  const egress = await assertEgressAllowed(rec.url, opts);
  if (egress) {
    const at = new Date().toISOString();
    rec.status = { ...rec.status, lastError: egress, lastErrorAt: at };
    durable.writeThrough(domain, rec);
    return { ok: false, error: egress };
  }
  const res = await (opts.pushFn ?? push)(domain, { url: rec.url, tokenSecretRef: rec.tokenSecretRef }, opts);
  const at = new Date().toISOString();
  rec.status = res.ok
    ? { ...rec.status, lastSha: res.sha, lastPushedAt: at, lastError: undefined, lastErrorAt: undefined }
    : { ...rec.status, lastError: res.error, lastErrorAt: at };
  durable.writeThrough(domain, rec);
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

/**
 * Fire-and-forget push after a CHANGED commit: reports, never blocks and never throws. A failure
 * stays on the record, surfaces as the `git-mirror` row on Platform → Components & Health, and is
 * retried by the next commit's push — there is no separate retry loop to get stuck.
 */
export async function pushMirrorAfterCommit(domain: string, sha: string, opts: MirrorPushOptions = {}): Promise<void> {
  try {
    await ensureMirrorsHydrated();
    const res = await pushMirror(domain, opts);
    if (res && !res.ok) console.warn(`[git-mirror] push for ${domain} @ ${sha.slice(0, 7)} failed: ${res.error}`);
  } catch (e) {
    console.warn(`[git-mirror] push for ${domain} errored: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** What the health row needs: one row per configured mirror, newest outcome first in the detail. */
export type MirrorSignal = { domain: string; url: string; lastSha?: string; lastPushedAt?: string; lastError?: string; lastErrorAt?: string };

export function mirrorSignals(): MirrorSignal[] {
  return listMirrors().map((m) => ({ domain: m.domain, url: m.url, ...m.status }));
}

/** Test hook: forget every configured mirror (shared with the data tab's own reset). */
export function __resetMirrors(): void {
  state().byDomain.clear();
  state().hydration = null;
  durable.__reset();
}

/** Test seam: install a mirror record without the admin route (never used in production code). */
export function __setMirrorForTests(rec: ProjectMirror): void {
  state().byDomain.set(rec.domain, rec);
}
