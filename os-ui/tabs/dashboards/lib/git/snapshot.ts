/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        dashboards
 * FEATURE:    The pure, serialisable snapshot a domain's `dashboards/**` subtree is generated from
 * USER STORY: As a maintainer I want the generator to be a pure function of a flat snapshot, so a
 *             golden test can pin the committed bytes without a store, a request or a clock
 *             (D-R3.2).
 * ARCHITECTURE:
 *   - The snapshot is the ONLY place the registry is read. `generate.ts` never touches the store,
 *     so regeneration is byte-stable and `commitSubtree` commits nothing when nothing changed.
 *   - NO PRINCIPAL IDENTIFIERS leave the OS: the owner appears as {@link ownerToken}, a stable
 *     opaque sha256 prefix, exactly as `tabs/agents/lib/git/generate.ts` decided for the same
 *     reason — an OS principal id can BE an e-mail address, and a repository is the most widely
 *     copied artefact the OS produces (mirror, Dagster clone, every domain member's export). The
 *     principal id itself stays in the COMMIT (`OS-Actor`), where a person is meant to be named.
 *   - NO SECRETS and NO QUERIES: a dashboard references governed ids (`metric:<id>` /
 *     `dataset:<id>`) and member names, never SQL, never a connection, never a token (D-R3.3).
 *   - `ref: null` is recorded HONESTLY when a member resolves to no metric the registry knows:
 *     the file says `ref: unresolved` rather than inventing an id, and the README says so.
 *   - Archived dashboards are EXCLUDED: archiving is a reversible soft-hide, and the repo should
 *     show what the domain has, with the archive state carried in the index for the record.
 */
import { createHash } from 'node:crypto';
import type { DashTier } from '@tabs/dashboards/lib/governance';
import { type DashboardSpec, type GridPos, type PanelFilter, type VizType, normalizePanel, panelMetrics } from '@tabs/dashboards/lib/model';

/**
 * The stable, opaque token that stands for an OS principal in the repository: the first 12 hex
 * characters of `sha256(<principal id>)`. Twin of `tabs/agents/lib/git/generate.ts` `ownerToken` —
 * duplicated because the structure rules forbid a tab importing another tab and there is no shared
 * `core` git-identity module yet (recorded as a cross-stream need; the shared home would be
 * `core/infra/git-identity.ts`). The two MUST stay byte-identical, which
 * `lib/git/generate.test.ts` pins with the same fixture value the agents test uses.
 */
export function ownerToken(owner: string): string {
  return createHash('sha256').update(String(owner ?? '')).digest('hex').slice(0, 12);
}

/** A safe single path segment: lowercase, `[a-z0-9-]`, never empty, never `..`. */
export function segment(s: string, fallback: string): string {
  const out = String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return out || fallback;
}

/** One panel, flattened for the file. `id` is minted deterministically by the generator. */
export type SnapshotPanel = {
  id: string;
  name: string;
  viz: VizType;
  /** The governed members this panel charts, each with the id it resolves to (or `null`). */
  metrics: { member: string; ref: string | null }[];
  dimensions: string[];
  timeDimension?: string;
  timeGrain?: string;
  filters: PanelFilter[];
  gridPos?: GridPos;
};

/** One dashboard, flattened for the file. */
export type SnapshotDashboard = {
  id: string;
  name: string;
  /** The governed view the dashboard binds to. */
  view: string;
  /** `dataset:<id>` for the view's dataset when the registry knows it, else `null`. */
  viewRef: string | null;
  /** The owning principal's id — or, when {@link SnapshotDashboard.ownerIsToken} is set, its
   *  already-hashed opaque token (which is what a parsed file carries). */
  owner: string;
  /** True when `owner` is ALREADY the opaque token, so the generator must not hash it twice.
   *  Set by `lib/git/parse.ts`; never set from the registry, which holds the real id. */
  ownerIsToken?: boolean;
  tier: DashTier;
  folder: string;
  archived: boolean;
  description?: string;
  /** Dashboard-level default filters saved WITH the dashboard. */
  filters: PanelFilter[];
  panels: SnapshotPanel[];
  /**
   * The lifecycle pin, when stream V's lifecycle module has one for this dashboard. Read through
   * `lib/lifecycle-port.ts` — this tab never decides lifecycle, it only records the pin so a
   * checkout says which version is the one that is running.
   */
  lifecycle?: { draft?: string; testing?: string; live?: string };
};

/** A whole domain's dashboards, in a deterministic order. */
export type DashboardProjectSnapshot = {
  domain: string;
  dashboards: SnapshotDashboard[];
};

/** What the store hands the snapshot for one dashboard (its stored record, narrowed). */
export type StoredDashboard = {
  id: string;
  spec: DashboardSpec;
  owner: string;
  tier: DashTier;
  domain: string;
  folder?: string;
  archived?: boolean;
};

/**
 * Resolve a governed member (`Orders.revenue`) to its stable OS reference (`metric:<id>`), or
 * `null` when no metric in the registry owns it. Injected, so the snapshot stays pure and the
 * generator never reaches a store.
 */
export type MemberRefResolver = (member: string) => string | null;

/** Resolve a governed view (`Orders`) to `dataset:<id>`, or `null` when unknown. */
export type ViewRefResolver = (view: string) => string | null;

export type SnapshotResolvers = {
  memberRef?: MemberRefResolver;
  viewRef?: ViewRefResolver;
  /** V's lifecycle pin for a dashboard, read through `lib/lifecycle-port.ts`. */
  lifecycle?: (id: string) => { draft?: string; testing?: string; live?: string } | null;
};

/** Deterministic panel id: `p_<slug(name)>`, disambiguated by position when two panels slug alike. */
function panelId(name: string, index: number, taken: Set<string>): string {
  const base = `p_${segment(name, 'panel')}`;
  let id = base;
  if (taken.has(id)) id = `${base}-${index + 1}`;
  taken.add(id);
  return id;
}

/** One stored dashboard, flattened. Pure. */
export function snapshotDashboard(rec: StoredDashboard, resolvers: SnapshotResolvers = {}): SnapshotDashboard {
  const taken = new Set<string>();
  const panels: SnapshotPanel[] = rec.spec.charts.map((raw, i) => {
    const p = normalizePanel(raw);
    return {
      id: panelId(p.name, i, taken),
      name: p.name,
      viz: p.vizType,
      metrics: panelMetrics(p).map((member) => ({ member, ref: resolvers.memberRef?.(member) ?? null })),
      dimensions: [...(p.dimensions ?? [])],
      ...(p.timeDimension ? { timeDimension: p.timeDimension } : {}),
      ...(p.timeGrain ? { timeGrain: String(p.timeGrain) } : {}),
      filters: (p.filters ?? []).map((f) => ({ member: f.member, operator: f.operator, values: [...f.values] })),
      ...(p.gridPos ? { gridPos: { ...p.gridPos } } : {}),
    };
  });
  const lifecycle = resolvers.lifecycle?.(rec.id) ?? null;
  return {
    id: rec.id,
    name: rec.spec.name,
    view: rec.spec.view,
    viewRef: resolvers.viewRef?.(rec.spec.view) ?? null,
    owner: rec.owner,
    tier: rec.tier,
    folder: rec.folder || '/',
    archived: Boolean(rec.archived),
    filters: (rec.spec.filters ?? []).map((f) => ({ member: f.member, operator: f.operator, values: [...f.values] })),
    panels,
    ...(lifecycle ? { lifecycle } : {}),
  };
}

/**
 * A whole domain's snapshot. Dashboards are sorted by id, so placement depends on the SET of
 * dashboards and never on the order they happened to arrive in — a directory must not move
 * because nothing changed.
 */
export function projectSnapshot(domain: string, dashboards: SnapshotDashboard[]): DashboardProjectSnapshot {
  return {
    domain,
    dashboards: [...dashboards].filter((d) => !d.archived).sort((a, b) => a.id.localeCompare(b.id)),
  };
}
