/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Lens roll-up — worst-of health and attention-first ordering
 * USER STORY: As any user I want red items first, then amber, then unknown, then green, so
 *             that what needs attention is at the top.
 * ARCHITECTURE:
 *   - Pure (no IO), unit-tested; used by `aggregate.ts`.
 *   - `byAttention` is the single ordering (health rank, then most recent); `pickAttention`
 *     keeps red/amber items, capped at 8.
 */
import {
  LENS_LABEL,
  type Health,
  type HealthItem,
  type LensId,
  type LensSummary,
} from '@tabs/monitoring/lib/types';

export const HEALTH_RANK: Record<Health, number> = { red: 0, amber: 1, unknown: 2, green: 3 };

/** Worst-of roll-up across a set of healths. */
export function worst(healths: Health[]): Health {
  if (healths.includes('red')) return 'red';
  if (healths.includes('amber')) return 'amber';
  if (healths.includes('green')) return 'green';
  return 'unknown';
}

/** Worst-first, then most-recent-first. The single ordering used everywhere. */
export function byAttention(a: HealthItem, b: HealthItem): number {
  const d = HEALTH_RANK[a.health] - HEALTH_RANK[b.health];
  if (d !== 0) return d;
  return (Date.parse(b.ts ?? '') || 0) - (Date.parse(a.ts ?? '') || 0);
}

/** Roll a lens's items into a summary (worst-of health + counts + sorted items). */
export function summarize(id: LensId, items: HealthItem[]): LensSummary {
  const counts = { red: 0, amber: 0, green: 0, unknown: 0 };
  for (const it of items) counts[it.health]++;
  return {
    id,
    label: LENS_LABEL[id],
    health: items.length === 0 ? 'unknown' : worst(items.map((i) => i.health)),
    counts,
    items: [...items].sort(byAttention),
  };
}

/** The few things needing attention (red/amber), worst-first, capped. */
export function pickAttention(items: HealthItem[], cap = 8): HealthItem[] {
  return items
    .filter((it) => it.health === 'red' || it.health === 'amber')
    .sort(byAttention)
    .slice(0, cap);
}
