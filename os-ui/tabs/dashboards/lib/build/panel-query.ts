/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { type DelegatedToken, propagate } from '@tabs/data/lib/index';
import type { Dataset, Measure } from '@tabs/data/lib/index';
import { type Principal } from '@tabs/data/lib/store';
import { exploreMetric } from '@tabs/metrics/lib/build/explore-server';
import type { Granularity } from '@tabs/metrics/lib/explorer';
import { getMetric, listMetrics } from '@tabs/metrics/lib/store';
import { type Panel, assertServableFilters, normalizePanel, panelMetrics } from '@tabs/dashboards/lib/model';

/**
 * Server boundary for a NATIVE dashboard panel (Tier 1). A panel resolves its numbers
 * through the SAME compiled-SQL path the Metrics tab uses ({@link exploreMetric}), so a
 * chart's number is BY CONSTRUCTION the same number the explorer + the agent
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
 * metrics path. `token` is the viewer's
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
  const { securityContext } = propagate(token); // throws if the token isn't user-delegated (R2/R3)
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
  //
  // D10/D-R4.1 — NO SILENT UNDER-FILTER. The governed path compiles a panel filter to
  // `column IN (<parameterised values>)`, so `equals`/`in` are servable and nothing else is. This
  // used to be `.filter((f) => f.operator === 'equals')`: a panel authored with `amount >= 1000`
  // rendered the UNFILTERED number with no warning anywhere. It is now a typed `bad_request`
  // (`status: 400`) naming the member and the operator, raised BEFORE any query runs.
  //
  // H-1 — THE TIME GRAIN IS ALLOW-LISTED, NOT CAST. `p.timeGrain` arrives raw from the wire
  // (`app/api/dashboards/panel-query/route.ts` parses the panel out of the request body) and the
  // governed compiler interpolates it into `date_trunc('<grain>', "col")`
  // (`tabs/metrics/lib/explorer.ts`). A bare `as Granularity` cast is erased at runtime, so a
  // panel carrying `month'), (SELECT …` would have closed the quote. `assertServableFilters`
  // checks it against the closed five-member list and REFUSES anything else.
  assertServableFilters(p);
  const slice = {
    dimensions: (p.dimensions ?? []).map(leaf),
    timeDimension: p.timeDimension ? leaf(p.timeDimension) : undefined,
    // Safe by the assertion above, which narrows it to the servable set.
    granularity: p.timeGrain as Granularity | undefined,
    // An empty value list is not a filter at all (`IN ()` is not valid SQL) — it is dropped, which
    // is faithful: the author expressed no restriction.
    //
    // M-9 — WHAT IS AND IS NOT GUARANTEED HERE. The COLUMN is validated by the explorer against
    // the served model (`assertColumn`), so an identifier can never reach the SQL unchecked. The
    // VALUES are quoted by the explorer, not bound as host parameters — Trino's HTTP protocol in
    // this path takes a statement string — and the governed executor additionally REFUSES any
    // statement containing `--` or `/* */`. So a value carrying a SQL comment does not inject; it
    // makes the whole query fail closed at the executor. That is safe but opaque, so the values
    // are checked here and a comment marker becomes a NAMED warning rather than an unexplained
    // query failure further down.
    filters: (p.filters ?? [])
      .filter((f) => (f.values ?? []).length > 0)
      .map((f) => ({ column: leaf(f.member), values: f.values })),
  };
  const commentValues = (p.filters ?? [])
    .flatMap((f) => (f.values ?? []).map((v) => ({ member: f.member, value: String(v) })))
    .filter(({ value }) => value.includes('--') || value.includes('/*') || value.includes('*/'));

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

  // Resolve every member first (pure, cheap) so the full measure-member set is known before we
  // build slice keys — then run the explore calls CONCURRENTLY (P1-6 resilience: one slow
  // measure no longer serializes the whole panel). Unresolved members are recorded loudly.
  type Resolved = { member: string; dataset: Dataset; measure: Measure };
  const resolvedMembers: Resolved[] = [];
  for (const member of members) {
    const r = resolve(member);
    if (!r) { missing.push(member); continue; }
    measureMembers.add(member);
    resolvedMembers.push({ member, dataset: r.dataset, measure: r.measure });
  }

  // Await all explores, THEN fold the results in the ORIGINAL member order so the merge into
  // byKey stays deterministic (same warning/mode/pending/sql accumulation as the old loop).
  const results = await Promise.all(
    resolvedMembers.map((rm) => explore(rm.dataset, rm.measure, token, slice)),
  );
  for (const result of results) {
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
  // Honesty precedence, unchanged in order: an outage (no number at all) is the loudest; then
  // unresolved members; then a dropped slice dimension; then (M-9) a filter value carrying a SQL
  // comment marker, which the governed executor refuses outright — named here so the user sees
  // WHY rather than an unexplained empty panel.
  const warning =
    unavailableWarning ??
    (missing.length > 0 ? missingMembersWarning(missing) : undefined) ??
    (droppedMembers.size > 0 ? dropWarnings[0] : undefined) ??
    (commentValues.length > 0 ? commentValueWarning(commentValues) : undefined);

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
    'dataset’s domain table may be missing/stale. ' +
    'Open the dataset in the Data tab and use “Re-materialize domain table” (Builder+) to serve it. ' +
    'The chart is NOT silently un-grouped; fix the model to render it as designed.'
  );
}

/**
 * M-9: a filter value containing a SQL comment marker (a double dash, or a slash-star pair). The
 * governed executor refuses any statement containing one, so such a panel returns nothing;
 * without this the user would see an empty chart and no reason. Named, not silently stripped —
 * stripping would change the filter the author wrote.
 */
export function commentValueWarning(hits: { member: string; value: string }[]): string {
  const list = hits.map((h) => `\u201c${h.member}\u201d`).join(', ');
  return (
    `Filter ${hits.length === 1 ? 'value' : 'values'} on ${list} ${hits.length === 1 ? 'contains' : 'contain'} a SQL ` +
    'comment marker. The governed query executor refuses any statement containing one, so this ' +
    'panel cannot be served with that value. The value is NOT silently stripped, because that ' +
    'would quietly change the filter you asked for — edit the filter instead.'
  );
}
