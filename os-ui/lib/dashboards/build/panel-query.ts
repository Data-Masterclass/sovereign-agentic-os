/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { type DelegatedToken, propagate } from '../../data/identity.ts';
import type { Dataset, Measure } from '../../data/index.ts';
import { type Principal } from '../../data/store.ts';
import { exploreMetric } from '../../metrics/build/explore-server.ts';
import type { Granularity } from '../../metrics/explorer.ts';
import { getMetric, listMetrics } from '../../metrics/store.ts';
import { type Panel, normalizePanel, panelMetrics } from '../model.ts';

/**
 * Server boundary for a NATIVE dashboard panel (Tier 1). Since Phase 2 a panel resolves its
 * numbers through the SAME compiled-SQL path the Metrics tab uses ({@link exploreMetric}) —
 * NOT Cube — so a chart's number is BY CONSTRUCTION the same number the explorer + the agent
 * `metrics` tool show for the same member, slice and viewer. Each panel measure is resolved to
 * its governed metric (dataset + measure) via the registry, then served as ONE governed Trino
 * SELECT run UNDER THE VIEWER'S delegated identity (R3): {@link propagate} inside exploreMetric
 * asserts the token is user-delegated and threads the viewer principal to Trino, so per-viewer
 * row/column security applies — two viewers of the SAME shared/certified dashboard see DIFFERENT
 * rows. The honest offline-mock (laptop, no cluster) and the LOUD honesty gate (a real Trino
 * outage → no number, never a fabricated one) come straight from exploreMetric.
 */

export type PanelQueryMode = 'live' | 'offline-mock';

export type PanelQueryResult = {
  rows: Record<string, unknown>[];
  mode: PanelQueryMode;
  /** True when the metric can't be computed yet (a window measure with no time slice, or a
   *  sidecar-lag equivalent) — a soft "syncing…", never a hard error or a blank panel. */
  pending?: boolean;
  /** LOUD degradation notice (Northpeak fix): set when the panel requests members the
   *  governed view does not expose — e.g. a group-by dimension that vanished because the
   *  dataset's domain table is missing/stale and needs re-promotion — OR when the governed
   *  lakehouse is unreachable so no number can be computed. The panel renders this warning
   *  instead of silently collapsing to a single un-grouped bar or a fabricated value. */
  warning?: string;
  /** The members that did not resolve (drives the warning; useful for the dev surface). */
  missingMembers?: string[];
  securityContext: Record<string, unknown>;
  /** The governed SQL the panel ran (for the developer surface + honest transparency). */
  sql: string;
};

/** Resolve a governed metric MEMBER (`View.measure`) to its dataset + measure, RLS-scoped
 *  to the viewer. Registry-derived: the member is matched against the metrics the user can
 *  see (never a member outside their entitlement), then lifted to the full record. Returns
 *  null when no visible metric owns the member. */
export type MemberResolver = (member: string) => { dataset: Dataset; measure: Measure } | null;

/** The store-backed default resolver — pure over the RLS-scoped metric registry. */
export function registryResolver(user: Principal): MemberResolver {
  return (member: string) => {
    const groups = listMetrics(user);
    const all = [...groups.mine, ...groups.domain, ...groups.marketplace];
    const summary = all.find((s) => s.member === member);
    if (!summary) return null;
    try {
      const rec = getMetric(summary.id, user);
      return { dataset: rec.dataset, measure: rec.measure };
    } catch {
      return null;
    }
  };
}

/** The bare column name of a panel dimension MEMBER (`View.col` → `col`). The explorer's
 *  {@link exploreMetric} re-qualifies bare names against the view, so we hand it the leaf. */
function leaf(member: string): string {
  const i = member.indexOf('.');
  return i >= 0 ? member.slice(i + 1) : member;
}

/** The stable dimension/time key of a resolved row — everything except the measure member —
 *  so a multi-measure panel's per-measure results merge onto one row per slice. */
function sliceKey(row: Record<string, unknown>, measureMembers: Set<string>): string {
  const parts: string[] = [];
  for (const k of Object.keys(row).sort()) {
    if (measureMembers.has(k)) continue;
    parts.push(`${k}=${String(row[k])}`);
  }
  return parts.join('|');
}

export type PanelQueryDeps = {
  /** RLS-scoped member → dataset+measure resolver (defaults to the registry resolver). */
  resolve?: MemberResolver;
  /** Injectable explore path (defaults to the governed-SQL {@link exploreMetric}). */
  explore?: typeof exploreMetric;
};

/**
 * Run one panel's governed query as the viewer, resolving numbers through the compiled-SQL
 * metrics path (Phase 2 — Cube is off the dashboards read path). `token` is the viewer's
 * delegated token (R2/R3); `user` scopes the registry resolver to what the viewer may see.
 * A panel with no metrics resolves to an empty result (nothing to chart).
 *
 * HONESTY: a member no visible metric owns is reported as a LOUD missing-member warning (never
 * silently dropped). A slice on a dimension the governed view doesn't expose is dropped BUT
 * reported (exploreMetric's `droppedMembers` → `warning`). A real Trino outage yields no rows +
 * an honest warning (never a fabricated number). A window metric with no time slice is a soft
 * pending. Every measure runs under the SAME viewer identity, so the panel and the Metrics tab
 * can never disagree on the number.
 */
export async function runPanelQuery(
  view: string,
  panel: Panel,
  token: DelegatedToken,
  user: Principal,
  deps: PanelQueryDeps = {},
): Promise<PanelQueryResult> {
  const { cube } = propagate(token); // throws if the token isn't user-delegated (R2/R3)
  const securityContext = cube.securityContext;
  const resolve = deps.resolve ?? registryResolver(user);
  const explore = deps.explore ?? exploreMetric;
  const p = normalizePanel(panel);
  const members = panelMetrics(p);
  void view; // the panel's members already encode the view; kept for the honest signature

  if (members.length === 0) {
    return { rows: [], mode: 'live', securityContext, sql: '' };
  }

  // The slice the panel asks for, shared across every measure (bare leaf names — the explorer
  // re-qualifies them against each measure's view and drops non-members loudly).
  const slice = {
    dimensions: (p.dimensions ?? []).map(leaf),
    timeDimension: p.timeDimension ? leaf(p.timeDimension) : undefined,
    granularity: p.timeGrain as Granularity | undefined,
  };

  const missing: string[] = [];
  const droppedMembers = new Set<string>();
  const dropWarnings: string[] = [];
  const measureMembers = new Set<string>();
  // Accumulate one row per slice key, keyed measure-by-measure so a multi-measure panel merges.
  const byKey = new Map<string, Record<string, unknown>>();
  let mode: PanelQueryMode = 'live';
  let pending = false;
  let unavailableWarning: string | undefined;
  let sql = '';

  for (const member of members) {
    const resolved = resolve(member);
    if (!resolved) {
      missing.push(member);
      continue;
    }
    measureMembers.add(member);
    const result = await explore(resolved.dataset, resolved.measure, token, slice);
    if (result.sql) sql = sql ? `${sql}\n\n${result.sql}` : result.sql;
    if (result.mode === 'offline-mock') mode = 'offline-mock';
    if (result.pending) pending = true;
    if (result.unavailable && result.warning) unavailableWarning = result.warning;
    for (const d of result.droppedMembers ?? []) droppedMembers.add(d);
    if (result.droppedMembers?.length && result.warning) dropWarnings.push(result.warning);
    for (const row of result.rows) {
      const key = sliceKey(row, measureMembers);
      const existing = byKey.get(key) ?? {};
      byKey.set(key, { ...existing, ...row });
    }
  }

  const rows = [...byKey.values()];
  // Honesty precedence: an outage (no number at all) is the loudest; then unresolved members;
  // then a dropped slice dimension. Any of these makes the degradation LOUD, never silent.
  const warning =
    unavailableWarning ??
    (missing.length > 0 ? missingMembersWarning(missing) : undefined) ??
    (droppedMembers.size > 0 ? dropWarnings[0] : undefined);

  const missingMembers = missing.length > 0 ? missing : droppedMembers.size > 0 ? [...droppedMembers] : undefined;

  return {
    rows: unavailableWarning ? [] : rows,
    mode,
    securityContext,
    sql,
    ...(pending ? { pending: true } : {}),
    ...(warning ? { warning } : {}),
    ...(missingMembers ? { missingMembers } : {}),
  };
}

/** The honest degradation notice for members no visible metric owns (Northpeak fix). */
export function missingMembersWarning(missing: string[]): string {
  const dims = missing.map((m) => `“${m}”`).join(', ');
  return (
    `${missing.length === 1 ? 'Member' : 'Members'} ${dims} ${missing.length === 1 ? 'is' : 'are'} not available ` +
    'in the governed model — the metric may be undefined, out of your entitlement, or the ' +
    'dataset’s domain table may be missing/stale and need re-promotion. ' +
    'The chart is NOT silently un-grouped; fix the model to render it as designed.'
  );
}
