/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    `generateProject(domain, snapshot)` — the whole dbt project of a domain as a file map
 * USER STORY: As a data engineer I want one deterministic function from OS state to a complete,
 *             parseable dbt project, so regenerating twice gives a byte-identical tree and the git
 *             store commits nothing when nothing changed (checklist D3).
 * ARCHITECTURE:
 *   - Pure composition of the renderers (project, models, sources, schema, schedules). Map keys are
 *     sorted; every file ends with one newline; no timestamps or ids minted here.
 *   - The impure half (`projectSnapshot`, the git commit) lives in `snapshot.ts` / `commit.ts`.
 */
import type { ProjectSnapshot } from '@tabs/data/lib/dbt/snapshot';
import { planModels } from '@tabs/data/lib/dbt/models';
import { renderSources } from '@tabs/data/lib/dbt/sources';
import { renderSchemas } from '@tabs/data/lib/dbt/schema';
import { renderSchedules, renderExternal } from '@tabs/data/lib/dbt/schedules';
import { renderSourceAssets } from '@tabs/data/lib/dbt/source-assets';
import { renderSemantic } from '@tabs/data/lib/dbt/semantic/render';
import { renderDbtProject, renderProfiles, renderMacros, renderGenericTests, renderReadme, renderGitignore } from '@tabs/data/lib/dbt/project';

/** What the generator must be TOLD about the deployment (it reads no env of its own). */
export type GenerateOptions = {
  /** The Trino client auth method `profiles.yml` is written for; `password:` is emitted iff it is
   *  not 'none' (B4-review E-3 — dbt parses the YAML before rendering Jinja, so a guard inside a
   *  comment cannot decide this). Default 'none'. */
  trinoAuthMethod?: string;
};

/** The complete project tree: path → content. Sorted by path. */
export function generateProject(domain: string, snapshot: ProjectSnapshot, opts: GenerateOptions = {}): Map<string, string> {
  const plan = planModels(snapshot);
  const files = new Map<string, string>();
  files.set('dbt_project.yml', renderDbtProject(domain, plan));
  files.set('profiles.yml', renderProfiles(domain, opts.trinoAuthMethod ?? 'none'));
  const semantic = renderSemantic(plan);
  files.set('README.md', renderReadme(domain, plan, semantic));
  files.set('.gitignore', renderGitignore());
  for (const [p, c] of renderMacros()) files.set(p, c);
  for (const [p, c] of renderGenericTests()) files.set(p, c);
  const sources = renderSources(plan.sources);
  if (sources) files.set('models/sources.yml', sources);
  for (const m of plan.models) files.set(m.path, m.sql);
  for (const [p, c] of renderSchemas(plan.models)) files.set(p, c);
  const schedules = renderSchedules(plan.models);
  if (schedules) files.set('os/schedules.yml', schedules);
  const external = renderExternal(plan.externals);
  if (external) files.set('os/external.yml', external);
  const sourceAssets = renderSourceAssets(plan.sourceAssets);
  if (sourceAssets) files.set('os/sources.yml', sourceAssets);
  // The semantic layer: `models/semantic/<model>.yml` (or the owner's personal lane) plus the time
  // spine. Metrics are dbt artefacts in this project, not an OS-private record (D1, M1).
  for (const [p, c] of semantic.files) files.set(p, c);
  return new Map([...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
