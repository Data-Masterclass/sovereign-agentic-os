/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       kernel
 * FEATURE:    The one-time "everything that already exists is Live" migration
 * USER STORY: As an existing user I want the day this ships to look exactly like the day before:
 *             every dashboard I open, every schedule that runs, unchanged. A lifecycle that
 *             silently un-lives the whole tenant on deploy would be a worse outage than the
 *             problem it solves.
 * ARCHITECTURE:
 *   - A BOOT-TIME WRITER, so it obeys the September-2026 rule absolutely: it does nothing unless
 *     `pinsHydrationState() === 'hydrated'` — a source ANSWERED — and nothing if the migration
 *     has already run. An un-hydrated boot logs and retries on the next boot; it never commits a
 *     pin file rendered from a store that might only LOOK empty.
 *   - It enumerates through each kind's registered adapter (`existing()`), so a kind whose tab
 *     did not register is skipped and reported, never guessed at.
 *   - Idempotent twice over: the pure `migrateExistingToLive` keeps an existing pin rather than
 *     re-pinning it, and `applyMigratedIndex` latches the migration durably so a restart neither
 *     re-runs it nor resurrects something a user has since retired.
 */

import { migrateExistingToLive, type LifecycleIndex, type LifecycleKind } from '@core/kernel/object-lifecycle';
import { lifecycleAdapterFor, registeredLifecycleKinds } from '@core/kernel/lifecycle-adapters';
import {
  lifecycleIndex,
  applyMigratedIndex,
  pinsHydrationState,
  pinsMigrated,
  type PinWriteDeps,
} from '@core/infra/lifecycle-pins';

export type MigrationOutcome =
  | { ran: false; reason: 'already-migrated' | 'not-hydrated' | 'no-adapters' }
  | { ran: true; pinned: number; domains: string[]; perKind: Record<string, number>; skipped: string[] };

/**
 * Run the migration once. Safe to call on every boot: it decides for itself whether to act.
 * `deps.commit: false` runs the durable half only (what a unit test wants).
 */
export async function migrateEverythingLive(
  by: { id: string; name?: string | null; email?: string | null } = { id: 'migration', name: 'Sovereign OS' },
  deps: PinWriteDeps = {},
): Promise<MigrationOutcome> {
  // Hydrate FIRST: pinsHydrationState() is 'cold' until the index has been read once.
  await lifecycleIndex();
  if (pinsMigrated()) return { ran: false, reason: 'already-migrated' };
  if (pinsHydrationState() !== 'hydrated') return { ran: false, reason: 'not-hydrated' };

  const kinds = registeredLifecycleKinds();
  if (kinds.length === 0) return { ran: false, reason: 'no-adapters' };

  const existing: { kind: LifecycleKind; id: string; head: string; domain: string }[] = [];
  const perKind: Record<string, number> = {};
  const skipped: string[] = [];
  for (const kind of kinds) {
    const adapter = lifecycleAdapterFor(kind);
    if (!adapter?.existing) {
      skipped.push(`${kind}: its adapter cannot enumerate existing objects`);
      continue;
    }
    try {
      const rows = await adapter.existing();
      for (const r of rows) {
        if (!r?.id || !r.domain) {
          // A row with no domain could not be written into any clone's pin file, so it is
          // reported rather than pinned into nowhere (review M-1).
          skipped.push(`${kind}:${r?.id ?? '?'}: no domain, so no clone could read its pin`);
          continue;
        }
        existing.push({ kind, id: r.id, head: r.head, domain: r.domain });
      }
      perKind[kind] = rows.length;
    } catch (e) {
      skipped.push(`${kind}: ${(e as Error).message}`);
    }
  }

  const current = await lifecycleIndex();
  const next: LifecycleIndex = migrateExistingToLive(existing, new Date().toISOString(), by.id, current);
  const applied = await applyMigratedIndex(next, by, deps);
  return { ran: true, pinned: applied.pinned, domains: applied.domains, perKind, skipped };
}
