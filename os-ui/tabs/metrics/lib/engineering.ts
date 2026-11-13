/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        metrics
 * FEATURE:    The Metrics tab's engineering view — the dbt metric as YAML, and `mf query`
 * USER STORY: As an engineer I open "Under the hood" on a KPI and read the dbt `metrics:` entry as
 *             it is committed in the domain's dbt project, with the repo path, and the command
 *             `mf query --metrics <name> --group-by metric_time__month` I would run myself
 *             (checklist T1, T3).
 * ARCHITECTURE:
 *   - `getMetric` first (the tab's own gate — it delegates to `getDataset`, so an invisible
 *     dataset's metric refuses exactly as the dataset does), then a pure mapping.
 *   - The dbt bytes are found by READING the repository and keeping the `models/semantic/*.yml`
 *     files that actually name this measure — not by predicting a path. Stream M is landing the
 *     semantic emitter tonight; until it does, the section says precisely which file is missing
 *     and what will write it (the plan's file contract: `models/semantic/<model>.yml`).
 *   - No `@tabs/data` import (TAB-ISOLATION): the dataset reached through `MetricRecord.dataset`
 *     is used structurally, and no data-tab helper is borrowed.
 */
import 'server-only';
import { getMetric } from '@tabs/metrics/lib/store';
import { readRepoFiles, repoPaths } from '@core/engineering/repo';
import { dagsterSection, dbtSection, gitSection, langfuseSection, LANGFUSE_REDACTIONS } from '@core/engineering/sections';
import { sealView, type EngineeringPrincipal, type EngineeringView } from '@core/engineering/types';

const OS_NOUN = 'KPI';
/** Where the semantic emitter writes a model's `semantic_models:` and `metrics:` blocks. */
export const SEMANTIC_DIR = 'models/semantic/';

/** Does this YAML name the measure as a dbt metric or a measure of a semantic model? */
export function namesMeasure(yaml: string, measure: string): boolean {
  return new RegExp(`(^|\\n)\\s*-?\\s*name:\\s*["']?${measure.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?\\s*(\\n|$)`).test(yaml);
}

/** The engineering view of one KPI. */
export async function metricEngineeringView(principal: EngineeringPrincipal, id: string): Promise<EngineeringView> {
  const rec = getMetric(id, principal);
  const domain = rec.dataset.domain;
  const measure = rec.measure.name;

  const listed = await repoPaths(domain);
  const semanticPaths = listed.paths.filter((p) => p.startsWith(SEMANTIC_DIR) && (p.endsWith('.yml') || p.endsWith('.yaml')));
  const read = semanticPaths.length ? await readRepoFiles(domain, (p) => semanticPaths.includes(p)) : null;
  const mine = (read?.files ?? []).filter((f) => namesMeasure(f.content, measure));

  const dbt = dbtSection({
    osNoun: OS_NOUN,
    node: null,
    files: mine,
    metrics: [measure],
    unavailable:
      listed.reason ??
      (semanticPaths.length === 0
        ? `no \`${SEMANTIC_DIR}<model>.yml\` is committed in '${domain}' yet, so this KPI has no dbt \`metrics:\` entry to show — the semantic emitter writes that file when the data product is next committed`
        : `the ${semanticPaths.length} semantic file(s) committed in '${domain}' do not name \`${measure}\`, so this KPI is not yet a dbt metric in the repository`),
    caveats: mine.length
      ? undefined
      : [
        `Until the dbt \`metrics:\` entry exists, the OS answers this KPI by compiling the measure to SQL and running it as you on Trino. The number is governed and consistent, but it is NOT yet MetricFlow serving a dbt metric, and \`mf query --metrics ${measure}\` would not resolve.`,
      ],
  });
  // dbt's own selector for a metric node, and the MetricFlow query, in the tools' own syntax.
  if (mine.length) {
    dbt.commands.unshift({ tool: 'dbt', command: `dbt ls --select metric:${measure}`, description: 'show the dbt metric node and what it depends on' });
  }

  const git = gitSection({
    osNoun: OS_NOUN,
    repo: domain,
    cloneUrl: null,
    head: listed.head,
    files: mine.map((f) => ({ path: f.path })),
    unavailable: listed.reason ?? `no file in '${domain}' carries this KPI's dbt metric definition yet`,
  });

  const dagster = dagsterSection({
    osNoun: OS_NOUN,
    facts: { assetKeys: [], jobName: null, scheduleName: null, lastRun: null, uiBaseUrl: null },
    unavailable:
      'a KPI is not materialised on its own: Dagster materialises the dbt model underneath it, which is on the data product\'s own panel',
  });
  const langfuse = langfuseSection({
    osNoun: OS_NOUN,
    traces: [],
    enabled: false,
    unavailable: 'a KPI query is a Trino query, not a model call — Langfuse traces agent runs, so there is no trace for this object',
    redactions: LANGFUSE_REDACTIONS,
  });

  return sealView({
    kind: 'metric',
    id: rec.id,
    name: rec.measure.label ?? rec.measure.name,
    domain,
    sections: [dbt, dagster, git, langfuse],
    export: {
      label: 'dbt project tarball',
      href: `/api/data/projects/${encodeURIComponent(domain)}/export`,
      commands: [
        `tar -xf ${domain}-<sha>.tar -C ${domain}`,
        `cd ${domain} && dbt parse --profiles-dir .`,
        `mf query --metrics ${measure} --group-by metric_time__month`,
      ],
    },
  });
}
