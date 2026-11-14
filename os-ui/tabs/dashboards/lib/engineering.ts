/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        dashboards
 * FEATURE:    The Dashboards tab's engineering view — the dashboard-as-code file and the dbt metrics behind it
 * USER STORY: As an engineer I open "Under the hood" on a dashboard and read the dashboard-as-code
 *             file as committed, its repo path, and the dbt metrics each panel queries with the
 *             `mf query` command for them (checklist T1, T3, T6).
 * ARCHITECTURE:
 *   - `getDashboard` first (the tab's own gate), then a pure mapping. The dashboard-as-code file
 *     is stream D's artefact, landing tonight under the reserved `dashboards/` subtree; this
 *     adapter reads whatever is committed there for this id and, when nothing is, says which file
 *     is missing rather than rendering an empty tab (checklist T7).
 *   - Types are used structurally so this tab imports no other tab (TAB-ISOLATION).
 *   - NIGHT-2 MERGE (T x D). D's own `lib/engineering.ts` wrapper was marked for deletion by its
 *     author and is gone; this is T's adapter, with D's facts ported in through the pure
 *     `lib/git/facts.ts` that D left behind for exactly this:
 *       * SLUG != ID. The directory is slugged from the dashboard's NAME, so `dashboards/<id>.yml`
 *         is wrong for essentially every dashboard. Paths come from `pathsForDashboard(id, …)`,
 *         which prefers the committed `dashboards/index.yml` and recomputes the placement
 *         otherwise, and the file is `<dir>/dashboard.yaml` (D's `yamlPathForDashboard`).
 *       * `governedRefs` / `unresolvedMembers` give the dbt section the real metric ids each panel
 *         resolves, and name the members no metric owns rather than dropping them.
 *       * `gitCommands` gives git's own commands for this file, and `pinSummary` the live pin.
 */
import 'server-only';
import { getDashboard } from '@tabs/dashboards/lib/store';
import { panelMetrics } from '@tabs/dashboards/lib/model';
import { DASHBOARDS_PREFIX } from '@tabs/dashboards/lib/git/generate';
import { snapshotDashboard, type StoredDashboard } from '@tabs/dashboards/lib/git/snapshot';
import { dashboardLifecycle } from '@tabs/dashboards/lib/lifecycle-port';
import {
  gitCommands,
  governedRefs,
  pathsForDashboard,
  pinSummary,
  unresolvedMembers,
  yamlPathForDashboard,
  type PathsInput,
} from '@tabs/dashboards/lib/git/facts';
import { readRepoFiles, repoPaths } from '@core/engineering/repo';
import { dagsterSection, dbtSection, gitSection, langfuseSection, LANGFUSE_REDACTIONS } from '@core/engineering/sections';
import { sealView, type EngineeringPrincipal, type EngineeringView } from '@core/engineering/types';

const OS_NOUN = 'dashboard';
/** The subtree stream D reserves for dashboard-as-code. Equal to D's `DASHBOARDS_PREFIX`. */
export const DASHBOARD_DIR = DASHBOARDS_PREFIX;
/** The shared, regenerated index that maps every dashboard id to its slugged directory. */
export const DASHBOARD_INDEX = `${DASHBOARDS_PREFIX}index.yml`;

/**
 * The committed paths that belong to one dashboard id, INTERSECTED with what the repository
 * actually tracks.
 *
 * NIGHT-2 MERGE: this used to guess `dashboards/<id>.yml`. The directory is slugged from the
 * dashboard's NAME (slug != id — D's review finding H-3), so the real location comes from D's
 * `pathsForDashboard`, which reads the committed index first and falls back to recomputing the
 * placement from the record. `null` from it means "cannot be located", which is returned as an
 * empty list and surfaced as a reason — never a guessed path that would make `git log` empty.
 */
export function dashboardPaths(tracked: string[], id: string, input: PathsInput): string[] {
  const located = pathsForDashboard(id, input);
  if (!located) return [];
  const dir = located[0];
  return tracked.filter((p) => p.startsWith(dir)).sort();
}

/** The engineering view of one dashboard. */
export async function dashboardEngineeringView(principal: EngineeringPrincipal, id: string): Promise<EngineeringView> {
  const d = getDashboard(id, principal);
  const domain = d.domain;
  // Members-only repository, as everywhere: a dashboard shared to the marketplace is visible to a
  // non-member, its domain's committed file is not.
  const member = principal.domains.includes(domain);
  const metrics = [...new Set(d.spec.charts.flatMap((c) => panelMetrics(c)))].sort();

  const listed = await repoPaths(domain);
  // The committed index is read FIRST (when the caller is a member and it exists), because it is
  // the authoritative id -> slugged-directory mapping; the stored record is only the fallback.
  const indexRead =
    member && listed.paths.includes(DASHBOARD_INDEX) ? await readRepoFiles(domain, (p) => p === DASHBOARD_INDEX) : null;
  const indexYaml = indexRead?.files.find((f) => f.path === DASHBOARD_INDEX)?.content ?? null;
  const pathsInput: PathsInput = { record: d as unknown as StoredDashboard, indexYaml };
  const yamlPath = member ? yamlPathForDashboard(d.id, pathsInput) : null;
  const mine = member ? dashboardPaths(listed.paths, d.id, pathsInput) : [];
  const read = mine.length ? await readRepoFiles(domain, (p) => mine.includes(p)) : null;
  const files = read?.files ?? [];
  // D's facts, over the same snapshot shape the commit path writes.
  const snap = snapshotDashboard(d as unknown as StoredDashboard);
  const refs = governedRefs(snap);
  const unresolved = unresolvedMembers(snap);
  // The pin is NOT on the stored record — it is read through D's lifecycle port, which is what
  // stream V installs a reader into. Unwired, `dashboardLifecycle` answers null and `pinSummary`
  // renders the honest "nothing is pinned live, and here is why".
  const pin = pinSummary(await dashboardLifecycle(d.id));

  const git = gitSection({
    osNoun: OS_NOUN,
    repo: domain,
    cloneUrl: null,
    head: listed.head,
    files: mine.map((p) => ({ path: p })),
    tracked: new Set(listed.paths),
    unavailable:
      (!member ? `the git repository of '${domain}' is members-only, and you are not a member of it` : undefined) ??
      listed.reason ??
      (yamlPath
        ? `no dashboard-as-code file for this dashboard is committed in '${domain}' yet — the writer lands it at \`${yamlPath}\``
        : `this dashboard cannot be located in '${domain}': neither \`${DASHBOARD_INDEX}\` nor its stored record resolves a directory for it, so there is no path to read`),
    // D's live pin, as a caveat rather than an artefact: a pin is not a file in this tree, and a
    // section with nothing committed must stay empty-with-a-reason (T7).
    caveats: [`Live pinned commit: ${pin.value}.${pin.note ? ` ${pin.note}` : ''}`],
  });
  if (files.length) {
    git.artefacts.unshift(
      ...files.map((f) => ({ noun: 'git file', name: f.path.split('/').pop() ?? f.path, repoPath: f.path, language: 'yaml' as const, body: f.content })),
    );
  }
  // D's git commands, in git's own vocabulary, against the REAL path (and `<os>` rather than a
  // guessed host when the deployment publishes no clone URL).
  if (yamlPath) {
    git.commands.push(
      ...gitCommands(domain, yamlPath).map((c) => ({ tool: 'git' as const, command: c.command, description: c.label })),
    );
  }

  const dbt = dbtSection({
    osNoun: OS_NOUN,
    node: null,
    files: [],
    metrics,
    unavailable:
      metrics.length === 0
        ? 'no panel on this dashboard queries a dbt metric yet'
        : `this dashboard queries ${metrics.length} metric(s) — ${metrics.join(', ')} — and the dbt \`metrics:\` YAML for each is on that KPI's own panel, not duplicated here`,
    caveats: [
      'A panel query runs as the signed-in user through the governed query path on Trino; the dbt metric definition is the contract, and the SQL that runs is shown on the Trino section once it ships.',
      // D's facts: the governed ids this dashboard really resolves, and the members nothing owns.
      refs.length
        ? `Governed references: ${refs.map((r) => `${r.label} \`${r.member}\` -> ${r.ref ?? 'nothing governed owns this member'}`).join('; ')}.`
        : 'This dashboard resolves no governed reference yet — it has no panels.',
      ...(unresolved.length
        ? [
          `No dbt metric owns ${unresolved.map((m) => `\`${m}\``).join(', ')}, so ${unresolved.length === 1 ? 'that panel' : 'those panels'} will warn until the metric exists. The member is kept rather than dropped, because the panel still asks for it.`,
        ]
        : []),
      // D's two standing caveats about what a dashboard is NOT.
      'A dashboard is NOT a Superset artefact and is not importable by Superset. The OS format is its own, with stable OS ids instead of UUID cross-references; the line, area and bar charts are drawn by Apache Superset\u2019s own ECharts transformers, vendored as source and attributed, which is a different thing from running Superset.',
      'Layout, a native filter bar, tabs, a dashboard-level time range and a pivot table are NOT built yet. A dashboard with no grid positions renders in panel order, and the file writes no `layout` block rather than inventing one.',
    ],
  });
  const dagster = dagsterSection({
    osNoun: OS_NOUN,
    facts: { assetKeys: [], jobName: null, scheduleName: null, lastRun: null, uiBaseUrl: null },
    unavailable: 'a dashboard is read on demand; Dagster materialises the dbt models underneath it, each on its own data product panel',
  });
  const langfuse = langfuseSection({
    osNoun: OS_NOUN,
    traces: [],
    enabled: false,
    unavailable: 'a dashboard read is a Trino query, not a model call — a Langfuse trace exists only when an agent built or answered about it',
    redactions: LANGFUSE_REDACTIONS,
  });

  return sealView({
    kind: 'dashboard',
    id: d.id,
    name: d.spec.name,
    domain,
    sections: [dbt, dagster, git, langfuse],
    export: mine.length
      ? {
        tool: 'git',
        label: 'git file — the dashboard-as-code YAML',
        href: `/api/data/projects/${encodeURIComponent(domain)}/blob?path=${encodeURIComponent(mine[0])}`,
        commands: [`git clone <os>/git/${domain}.git`, `cat ${mine[0]}`],
      }
      : {
        tool: 'git',
        label: 'git file — the dashboard-as-code YAML',
        href: null,
        unresolvedReason: member
          ? yamlPath
            ? `nothing is committed at \`${yamlPath}\` yet, so there is no file to export`
            : `this dashboard cannot be located in '${domain}' — neither \`${DASHBOARD_INDEX}\` nor its stored record resolves a directory for it`
          : `the git repository of '${domain}' is members-only, and you are not a member of it`,
        commands: [`git clone <os>/git/${domain}.git`],
      },
  }, new Set(listed.paths));
}
