/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */

// Client-side mirrors of the (server) Strategy shapes the API returns — kept
// local so the bundle never imports the server-only adapters. The pillars list
// route returns each pillar as a CARD: the pillar, its RLS-scoped value roll-up
// (masked to the caller), its value history, and recent audit.

import type {
  ArtifactKind,
  ComponentBuildStatus,
  ValueMode,
  ValueMetric,
  Pillar,
} from '@/lib/strategy/model';

export type { ArtifactKind, ComponentBuildStatus, ValueMode, ValueMetric, Pillar };

export type DComponent = {
  id: string;
  name: string;
  kind: ArtifactKind;
  value: number | null;
  entitled: boolean;
  status: ComponentBuildStatus;
  dueDate: string | null;
  artifactId: string | null;
};

export type DBet = {
  id: string;
  name: string;
  domain: string;
  sharePct: number | null;
  value: number | null;
  entitled: boolean;
  goLive: string | null;
  components: DComponent[];
};

export type Rollup = {
  pillarId: string;
  metricTitle: string;
  metricDescription: string;
  mode: ValueMode;
  total: number;
  source: 'cube' | 'seed-offline' | 'manual';
  basis: string;
  bets: DBet[];
  reconciled: boolean;
  visibleTotal: number;
  maskedTotal: number;
};

export type ValuePoint = { month: string; value: number };
export type AuditEvent = { action: string; actor: string; at: string };

export type PillarCard = {
  pillar: Pillar;
  rollup: Rollup;
  history: ValuePoint[];
  audit: AuditEvent[];
  canEdit: boolean;
};

export type ListResp = {
  user: { id: string; name: string; domains: string[]; role: string };
  items: PillarCard[];
  canCreateTenant: boolean;
  canCreateDomain: boolean;
};

// ---- pure helpers --------------------------------------------------------

/** Count a bet's components by build state — Planned / In progress / Ready. */
export function statusCounts(components: DComponent[]): Record<ComponentBuildStatus, number> {
  const c: Record<ComponentBuildStatus, number> = { planned: 0, 'in-progress': 0, ready: 0 };
  for (const k of components) c[k.status] += 1;
  return c;
}

/** Compact human date, e.g. "27 Jun 2026". */
export function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const t = Date.parse(iso.length === 10 ? iso + 'T00:00:00Z' : iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** "2026-06" → "Jun 2026" for chart axis ticks. */
export function fmtMonth(month: string): string {
  const [y, m] = month.split('-');
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const idx = Number(m) - 1;
  return `${names[idx] ?? m} ${y}`;
}

export async function api(url: string, method: string, body?: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data;
}
