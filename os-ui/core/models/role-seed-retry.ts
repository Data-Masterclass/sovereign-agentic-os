/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       core / models
 * FEATURE:    The first role mapping is retried with backoff until it exists, and a mapping that stays
 *             missing is a visible health signal — never a log line nobody reads.
 * USER STORY: As an operator on a first boot where LiteLLM is still busy, the roles map themselves a few
 *             seconds later instead of never; if they cannot, Monitoring and Platform → Models tell me
 *             "model roles not mapped" and why, so I can map them by hand.
 * ARCHITECTURE:
 *   - Incident 23 Nov 2026 (release 0.9.32): the one boot attempt timed out reading the catalog, nothing was
 *     retried for minutes, and every call on sovereign-strong / -worker / -embedding failed with
 *     "Invalid model name" until an admin set the roles by hand.
 *   - `seedUntilMapped` calls the seed (`role-seed.ts`, which itself writes nothing when a mapping exists)
 *     until its state is `seeded`, `migrated` or `already-mapped`. Delays: 5 s, 15 s, 30 s, 60 s, 120 s,
 *     then every 300 s — it NEVER gives up. Before each attempt `mapped()` is asked, so an admin's mapping
 *     made meanwhile stops the loop without another gateway read.
 *   - Every failed attempt is logged with its state and error. From `PERSISTENT_AFTER` consecutive failures
 *     the status is `persistent`: `roleSeedAlert` turns it into the Monitoring alert and the Platform →
 *     Models warning (both read `roleSeedStatus()`; one text, two places).
 *   - Injected seed, sleep, clock and log so the loop is unit-tested without timers.
 */

/** What the loop needs from a seed result (`SeedResult` from `role-seed.ts` satisfies it). */
export type SeedAttemptResult = { state: string; error?: string };

export const SEED_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000] as const;
/** Consecutive failed attempts after which a missing mapping is raised as a health signal (~50 s after boot). */
export const PERSISTENT_AFTER = 4;

const DONE = new Set(['seeded', 'migrated', 'already-mapped']);

export type RoleSeedStatus = {
  /** `running`: still trying (not yet persistent) · `persistent`: still trying, raised as a health signal ·
   *  `mapped`: a mapping exists (seeded, migrated, or set by an admin). */
  state: 'running' | 'persistent' | 'mapped';
  attempts: number;
  /** Consecutive failures (0 once mapped). */
  failures: number;
  lastState?: string;
  lastError?: string;
  firstFailureAt?: number;
  lastAttemptAt?: number;
  nextAttemptAt?: number;
};

type Slot = { status?: RoleSeedStatus };
const slot = (): Slot => ((globalThis as unknown as { __osRoleSeedStatus?: Slot }).__osRoleSeedStatus ??= {});
export const roleSeedStatus = (): RoleSeedStatus | null => slot().status ?? null;
/** Tests only. */
export const resetRoleSeedStatus = (): void => { slot().status = undefined; };

export const seedRetryDelay = (failures: number): number =>
  SEED_RETRY_DELAYS_MS[Math.min(Math.max(failures, 1), SEED_RETRY_DELAYS_MS.length) - 1];

export type SeedLoopOpts = {
  seed: () => Promise<SeedAttemptResult>;
  /** True once a mapping exists by other means (an admin's apply): the loop stops. */
  mapped?: () => boolean;
  /** After each attempt (`ok` = a mapping now exists). The scheduler runs a reconcile pass here. */
  afterAttempt?: (attempt: number, ok: boolean) => Promise<unknown> | unknown;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (level: 'info' | 'warn' | 'error', line: string) => void;
};

const defaultLog: NonNullable<SeedLoopOpts['log']> = (level, line) => console[level](`[role-reconcile] ${line}`);
const defaultSleep = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); (t as { unref?: () => void }).unref?.(); });

/** Retry the first mapping until a mapping exists. Resolves with the final status; never rejects, never gives up. */
export async function seedUntilMapped(o: SeedLoopOpts): Promise<RoleSeedStatus> {
  const now = o.now ?? Date.now;
  const log = o.log ?? defaultLog;
  const sleep = o.sleep ?? defaultSleep;
  const st: RoleSeedStatus = { state: 'running', attempts: 0, failures: 0 };
  slot().status = st;
  const finish = (lastState: string): RoleSeedStatus => {
    Object.assign(st, { state: 'mapped', failures: 0, lastState, lastError: undefined, nextAttemptAt: undefined });
    return st;
  };
  for (;;) {
    if (o.mapped?.()) {
      if (st.failures > 0) log('info', 'first mapping: a role mapping now exists (set meanwhile); retries stopped');
      return finish('already-mapped');
    }
    st.attempts += 1;
    st.lastAttemptAt = now();
    let r: SeedAttemptResult;
    try {
      r = await o.seed();
    } catch (e) {
      r = { state: 'error', error: (e as Error)?.message ?? String(e) };
    }
    const ok = DONE.has(r.state);
    if (ok) {
      log('info', `first mapping: ${r.state}${st.attempts > 1 ? ` (attempt ${st.attempts})` : ''}`);
      finish(r.state);
    } else {
      st.failures += 1;
      st.firstFailureAt ??= st.lastAttemptAt;
      st.lastState = r.state;
      st.lastError = r.error ?? r.state;
      const delay = seedRetryDelay(st.failures);
      st.nextAttemptAt = now() + delay;
      const becamePersistent = st.state !== 'persistent' && st.failures >= PERSISTENT_AFTER;
      if (st.failures >= PERSISTENT_AFTER) st.state = 'persistent';
      log(becamePersistent ? 'error' : 'warn', `first mapping attempt ${st.attempts} failed (${r.state}): ${st.lastError}; next try in ${Math.round(delay / 1000)} s`);
      if (becamePersistent) log('error', 'MODEL ROLES NOT MAPPED: calls on sovereign-strong / -worker / -embedding fail until the first mapping succeeds or an admin maps the roles in Platform → Models → Roles');
    }
    try {
      await o.afterAttempt?.(st.attempts, ok);
    } catch (e) {
      log('error', `pass after the first mapping attempt failed: ${(e as Error)?.message ?? String(e)}`);
    }
    if (ok) return st;
    await sleep(seedRetryDelay(st.failures));
  }
}

/** The health signal for a mapping that stays missing: null while there is nothing to raise. Used by the
 *  Monitoring alert and the Platform → Models warning. `mappedNow` = a mapping is known to exist right now. */
export function roleSeedAlert(status: RoleSeedStatus | null, mappedNow: boolean): { title: string; detail: string } | null {
  if (!status || status.state !== 'persistent' || mappedNow) return null;
  const since = status.firstFailureAt ? new Date(status.firstFailureAt).toISOString() : 'boot';
  const next = status.nextAttemptAt ? ` The next try is at ${new Date(status.nextAttemptAt).toISOString()}.` : '';
  return {
    title: 'Model roles not mapped',
    detail: `There is no role mapping (os/models.yml), so every call on sovereign-strong, sovereign-worker and sovereign-embedding fails with "Invalid model name". The OS has tried to write the first mapping ${status.attempts} times since ${since} and keeps trying; the last attempt said: ${status.lastError ?? status.lastState ?? 'unknown'}.${next} Map the three roles now in Platform → Models → Roles to fix it at once.`,
  };
}
