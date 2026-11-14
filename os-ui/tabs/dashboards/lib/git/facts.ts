/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        dashboards
 * FEATURE:    The dashboard-as-code FACTS, for whoever renders them (stream T's adapter, G's reads)
 * USER STORY: As a data engineer I want the repository path, the governed ids and the live pin of a
 *             dashboard to be one small, pure, correct function — not three copies in three panels
 *             that drift (review H-2/H-3).
 * ARCHITECTURE:
 *   - MERGE-READY BY DESIGN. Stream T has landed its own `tabs/dashboards/lib/engineering.ts`
 *     against the real `core/engineering` types, so at merge THIS stream's `engineering.ts` is
 *     deleted and its dashboard-as-code facts become sections of T's adapter. Everything worth
 *     keeping therefore lives HERE, in a module T can call without inheriting anything of this
 *     stream's own view shape.
 *   - A DIRECTORY NAME IS NOT AN IDENTITY (the H-3 trap). `placeDashboards` slugs a dashboard from
 *     its NAME, so the slug is neither the id nor stable across a rename, and two dashboards that
 *     slug alike are disambiguated by id suffix. A caller that guessed `dashboards/<id>/` would be
 *     wrong for essentially every dashboard. {@link pathsForDashboard} resolves the slug through
 *     the committed `dashboards/index.yml`, which exists precisely to be that mapping, and falls
 *     back to recomputing the placement when the index cannot be read.
 *   - PURE. Every input is injected: the index bytes, the dashboard record, the pin. No store, no
 *     git, no clock — so T's adapter, G's resolver and a test all get the same answers.
 */
import { load } from 'js-yaml';
import { DASHBOARDS_PREFIX, placeDashboards } from '@tabs/dashboards/lib/git/generate';
import { projectSnapshot, snapshotDashboard, type SnapshotDashboard, type StoredDashboard } from '@tabs/dashboards/lib/git/snapshot';
import type { LifecyclePin } from '@tabs/dashboards/lib/lifecycle-port';

/** One row of the committed `dashboards/index.yml`. */
export type IndexEntry = {
  slug: string;
  id: string;
  /** Repo-relative directory, e.g. `dashboards/sales-overview`. */
  path: string;
  name?: string;
  tier?: string;
  view?: string;
  live?: string;
};

/**
 * Parse `dashboards/index.yml`. Returns `[]` for anything unreadable — this is a convenience
 * lookup over a generated file, so a malformed index degrades to "recompute the placement" rather
 * than to an error. (The authoritative validator for hand-edited input is `lib/git/parse.ts`,
 * which refuses loudly; `index.yml` is generated and is never input.)
 */
export function parseDashboardIndex(text: string | undefined | null): IndexEntry[] {
  if (!text) return [];
  let doc: unknown;
  try {
    doc = load(text);
  } catch {
    return [];
  }
  if (!doc || typeof doc !== 'object') return [];
  const rows = (doc as Record<string, unknown>).dashboards;
  if (!Array.isArray(rows)) return [];
  const out: IndexEntry[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.slug !== 'string' || typeof r.id !== 'string' || typeof r.path !== 'string') continue;
    out.push({
      slug: r.slug,
      id: r.id,
      path: r.path,
      ...(typeof r.name === 'string' ? { name: r.name } : {}),
      ...(typeof r.tier === 'string' ? { tier: r.tier } : {}),
      ...(typeof r.view === 'string' ? { view: r.view } : {}),
      ...(typeof r.live === 'string' ? { live: r.live } : {}),
    });
  }
  return out;
}

/** The index row for one dashboard id, or `null`. The id is the identity; the slug is not. */
export function indexEntryFor(index: IndexEntry[], id: string): IndexEntry | null {
  return index.find((e) => e.id === id) ?? null;
}

/** The repo-relative directory of one dashboard, recomputed from its record. */
export function directoryFor(rec: StoredDashboard): string | null {
  if (!rec.domain) return null;
  const snapshot: SnapshotDashboard = snapshotDashboard(rec);
  const [placed] = placeDashboards(projectSnapshot(rec.domain, [snapshot]));
  return placed?.dir ?? null;
}

export type PathsInput = {
  /** The dashboard's stored record (for the fallback placement). */
  record?: StoredDashboard | null;
  /** The committed `dashboards/index.yml` bytes, when they can be read. Preferred. */
  indexYaml?: string | null;
};

/**
 * The repo paths that make up one dashboard: its own directory, plus the shared
 * `dashboards/index.yml`, which is regenerated on every change and is therefore part of this
 * object's history.
 *
 * SLUG ≠ ID. The index is consulted FIRST, because it is the committed mapping and it is correct
 * even for a dashboard that has since been renamed in the registry but not yet re-committed. The
 * record is the fallback. Returns `null` when neither can locate it — which is the honest answer,
 * not a guessed path that would make `git log` silently empty.
 */
export function pathsForDashboard(id: string, input: PathsInput): string[] | null {
  const fromIndex = indexEntryFor(parseDashboardIndex(input.indexYaml), id);
  const dir = fromIndex?.path ?? (input.record ? directoryFor(input.record) : null);
  if (!dir) return null;
  return [`${dir.replace(/\/+$/, '')}/`, `${DASHBOARDS_PREFIX}index.yml`];
}

/** The `dashboard.yaml` path of one dashboard, or `null` when it cannot be located. */
export function yamlPathForDashboard(id: string, input: PathsInput): string | null {
  const paths = pathsForDashboard(id, input);
  return paths ? `${paths[0]}dashboard.yaml` : null;
}

/** One governed id a dashboard depends on, in the tool's own vocabulary. */
export type GovernedRef = {
  /** `metric:<id>` / `dataset:<id>`, or `null` when nothing governed owns the member. */
  ref: string | null;
  /** The member name, always kept — it is what the panel actually asks for. */
  member: string;
  /** The tool noun for this reference, for a panel label. */
  label: 'dbt metric (KPI)' | 'dbt model (data product)';
};

/**
 * Every governed id the dashboard resolves, deduplicated, the view's dataset first. A member no
 * metric owns is reported with `ref: null` and the member kept — never an invented id, and never
 * dropped, because the panel still charts it and the user still sees a warning about it.
 */
export function governedRefs(d: SnapshotDashboard): GovernedRef[] {
  const out: GovernedRef[] = [];
  const seen = new Set<string>();
  if (d.viewRef) {
    out.push({ ref: d.viewRef, member: d.view, label: 'dbt model (data product)' });
    seen.add(d.viewRef);
  }
  for (const panel of d.panels) {
    for (const m of panel.metrics) {
      const key = `${m.ref ?? 'null'}|${m.member}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ref: m.ref, member: m.member, label: 'dbt metric (KPI)' });
    }
  }
  return out;
}

/** The members no governed metric owns — the honest "this will warn until the metric exists" list. */
export function unresolvedMembers(d: SnapshotDashboard): string[] {
  return governedRefs(d)
    .filter((r) => r.ref === null)
    .map((r) => r.member);
}

/**
 * The engineer's commands for one dashboard, in git's own vocabulary. `gitBaseUrl` absent ⇒ the
 * literal `<os>` placeholder, so a doc or a panel never shows a wrong host as though it were real.
 */
export function gitCommands(domain: string, yamlPath: string, gitBaseUrl?: string): { label: string; command: string }[] {
  const clone = `${gitBaseUrl ?? '<os>'}/git/${domain}.git`;
  return [
    { label: 'Clone the domain repository', command: `git clone ${clone}` },
    { label: 'Read this dashboard’s history', command: `git log --stat -- ${yamlPath}` },
    { label: 'See the last change', command: `git show HEAD -- ${yamlPath}` },
    { label: 'Export this dashboard in its native form', command: `git show HEAD:${yamlPath}` },
  ];
}

/** How a live pin reads on a panel: the ref, when it was pinned and by whom, or the honest absence. */
export function pinSummary(pin: LifecyclePin | null | undefined): { value: string; note?: string } {
  if (!pin || !pin.live) {
    return {
      value: 'no version pinned',
      note:
        'Nothing of this dashboard is pinned live, so there is no "this is the version that is running" ' +
        'answer yet. Lifecycle is owned by the OS kernel, not by this tab; the dashboard still opens and ' +
        'still renders its draft.',
    };
  }
  const who = [pin.liveAt ? `at ${pin.liveAt}` : null, pin.liveBy ? `by ${pin.liveBy}` : null].filter(Boolean).join(' ');
  return { value: pin.live, ...(who ? { note: `Pinned ${who}.` } : {}) };
}
