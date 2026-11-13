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
 */
import 'server-only';
import { getDashboard } from '@tabs/dashboards/lib/store';
import { panelMetrics } from '@tabs/dashboards/lib/model';
import { readRepoFiles, repoPaths } from '@core/engineering/repo';
import { dagsterSection, dbtSection, gitSection, langfuseSection, LANGFUSE_REDACTIONS } from '@core/engineering/sections';
import { sealView, type EngineeringPrincipal, type EngineeringView } from '@core/engineering/types';

const OS_NOUN = 'dashboard';
/** The subtree stream D reserves for dashboard-as-code. */
export const DASHBOARD_DIR = 'dashboards/';

/** The dashboard-as-code paths that belong to one dashboard id. */
export function dashboardPaths(paths: string[], id: string): string[] {
  return paths.filter((p) => p.startsWith(DASHBOARD_DIR) && (p.includes(`/${id}.`) || p === `${DASHBOARD_DIR}${id}.yml` || p === `${DASHBOARD_DIR}${id}.yaml`)).sort();
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
  const mine = member ? dashboardPaths(listed.paths, d.id) : [];
  const read = mine.length ? await readRepoFiles(domain, (p) => mine.includes(p)) : null;
  const files = read?.files ?? [];

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
      `no dashboard-as-code file for this dashboard is committed in '${domain}' yet — the writer lands it at \`${DASHBOARD_DIR}${d.id}.yml\``,
  });
  if (files.length) {
    git.artefacts.unshift(
      ...files.map((f) => ({ noun: 'git file', name: f.path.split('/').pop() ?? f.path, repoPath: f.path, language: 'yaml' as const, body: f.content })),
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
          ? `nothing is committed at \`${DASHBOARD_DIR}${d.id}.yml\` yet, so there is no file to export`
          : `the git repository of '${domain}' is members-only, and you are not a member of it`,
        commands: [`git clone <os>/git/${domain}.git`],
      },
  }, new Set(listed.paths));
}
