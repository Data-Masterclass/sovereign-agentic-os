/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Small UI-only helpers shared across the Monitoring components. Maps the
 * frozen `Health` roll-up onto the existing dark palette (danger / gold / teal /
 * faint) so reds lead and greens recede — no new design system.
 */
import type { Health, LensId, Scope } from '@/lib/monitoring';

/** Dot colour class (defined in app/monitoring.css). */
export function healthDot(h: Health): string {
  return `mon-dot h-${h}`;
}

/** Reuse the existing badge palette: red→err, amber→warn, green→ok, unknown→muted. */
export function healthBadge(h: Health): string {
  const map: Record<Health, string> = {
    red: 'err',
    amber: 'warn',
    green: 'ok',
    unknown: 'muted',
  };
  return `badge ${map[h]}`;
}

/** Order used for "worst first" sorting when we need it client-side. */
export const HEALTH_RANK: Record<Health, number> = {
  red: 0,
  amber: 1,
  unknown: 2,
  green: 3,
};

export const LENS_SHORT: Record<LensId, string> = {
  runs: 'Runs',
  pipelines: 'Pipelines',
  cost: 'Cost',
  system: 'System',
  artifacts: 'Artifacts',
};

/** "Builder · sales, finance" — the viewer scope, shown subtly in a pill. */
export function scopeLabel(scope: Scope): string {
  const level = scope.level.charAt(0).toUpperCase() + scope.level.slice(1);
  const domains = scope.domains.length ? scope.domains.join(', ') : scope.principal;
  return `Scope: ${level} · ${domains}`;
}

/** A run item is drillable into a Langfuse trace. */
export function isRun(lens: LensId, runId?: string): boolean {
  return lens === 'runs' || Boolean(runId);
}

export function moneyPct(spentUsd: number, limitUsd: number): number {
  if (limitUsd <= 0) return 0;
  return Math.round((spentUsd / limitUsd) * 100);
}
