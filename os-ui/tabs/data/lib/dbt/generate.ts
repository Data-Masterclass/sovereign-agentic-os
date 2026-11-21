/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    `generateProject(domain, snapshot)` — the domain's dbt project and Dagster definitions as a file map
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
import { createHash } from 'node:crypto';
import { DATA_LAYOUT } from '@core/infra/data-layout';
import { renderDagsterDefinitions } from '@tabs/data/lib/dbt/dagster-definitions';
import { renderSemantic } from '@tabs/data/lib/dbt/semantic/render';
import { renderDbtProject, renderProfiles, renderMacros, renderGenericTests, renderReadme, renderGitignore } from '@tabs/data/lib/dbt/project';
import { checkProject, type ProjectIssue } from '@tabs/data/lib/dbt/project-check';
import { yml } from '@tabs/data/lib/dbt/emit';
import { datasetLiteralIssues, freeText, LiteralSafetyError } from '@tabs/data/lib/dbt/literal';

/** What the generator must be TOLD about the deployment (it reads no env of its own). */
export type GenerateOptions = {
  /** The Trino client auth method `profiles.yml` is written for; `password:` is emitted iff it is
   *  not 'none' (B4-review E-3 — dbt parses the YAML before rendering Jinja, so a guard inside a
   *  comment cannot decide this). Default 'none'. */
  trinoAuthMethod?: string;
  /** The structural check run before the tree is returned. Default `checkProject`; injected by
   *  tests to prove the skip path independently of which rules exist today. */
  check?: (files: Map<string, string>) => ProjectIssue[];
  /** WP-52: the dbt `model-paths` entry for the dashboards' saved queries + exposures
   *  (`dashboardsModelPath(layout)`), or absent when dashboards are not native. */
  dashboardsModelPath?: string;
  /** WP-50: the dbt `model-paths` entry for the alerts' saved queries (`alertsModelPath(layout)`),
   *  or absent when alerts are not native. */
  alertsModelPath?: string;
  /** WP-15: write each enabled schedule's standing run-grant id into `os/schedules.yml`. */
  runGrants?: boolean;
};

/** A dataset the generator LEFT OUT of the project because its files would fail `dbt parse`. */
export type SkippedDataset = { dataset: string; reason: string };

/** Where the skip report is committed — the OS reads it back to say why a sync is not scheduled. */
export const SKIPPED_PATH = 'os/skipped.yml';

/**
 * The complete project tree plus the datasets that had to be left out of it.
 *
 * ONE BAD DATASET MUST NOT BREAK THE DOMAIN (live incident 2026-11, track H). repo-sync runs
 * `dbt parse` on every new commit and keeps Dagster on the last commit that parsed, so a single
 * dataset whose files dbt refuses used to stop EVERY scheduled sync and build in its domain,
 * silently. So: render, run `checkProject` (the parse-time rules dbt enforces that generated input
 * can break), drop the datasets the issues are attributed to, and render again — until clean or
 * nothing attributable is left. Dropping a dataset can orphan a `ref()` in a dataset built on it;
 * the next pass catches and drops that one too, so the loop is bounded by the dataset count. The
 * skipped datasets and the reason are committed in `os/skipped.yml`.
 */
export function generateProjectReport(
  domain: string,
  snapshot: ProjectSnapshot,
  opts: GenerateOptions = {},
): { files: Map<string, string>; skipped: SkippedDataset[] } {
  const skipped = new Map<string, string>();
  // LITERAL SAFETY first: a dataset with an identifier or cron outside the allow-lists is never
  // rendered at all (`literal.ts`). The store refuses these at write time; this catches a record
  // written before the rules existed, or edited by hand.
  for (const e of snapshot.datasets) {
    const issues = datasetLiteralIssues(e.dataset);
    if (issues.length) skipped.set(e.dataset.id, `refused identifier(s): ${issues.map((i) => i.field).join(', ')}`);
  }
  const keep = (s: ProjectSnapshot): ProjectSnapshot => ({ ...s, datasets: s.datasets.filter((e) => !skipped.has(e.dataset.id)) });
  let files = renderSafely(domain, keep(snapshot), opts, skipped);
  // C3: a dataset the planner refuses (a built layer dbt cannot rebuild) is skipped with its reason.
  // Planned on the literal-safe set only, which `renderSafely` has just rendered without a refusal.
  const refused = planModels(keep(snapshot)).refused;
  if (refused.length) {
    for (const r of refused) skipped.set(r.dataset, r.reason);
    files = renderSafely(domain, keep(snapshot), opts, skipped);
  }
  for (let pass = 0; pass <= snapshot.datasets.length; pass++) {
    const fresh = (opts.check ?? checkProject)(files).filter((i) => i.datasetId && !skipped.has(i.datasetId));
    if (!fresh.length) break;
    for (const i of fresh) if (!skipped.has(i.datasetId!)) skipped.set(i.datasetId!, `${i.reason} (${i.path})`);
    files = renderSafely(domain, keep(snapshot), opts, skipped);
  }
  // The closed-grammar Jinja rule (`checkProject` rule 8) is the last line: a violation the check
  // could not pin on a dataset means the generator itself emitted foreign Jinja — refuse to return
  // a tree at all rather than commit it.
  const foreign = (opts.check ?? checkProject)(files).filter((i) => i.rule === 'jinja-grammar');
  if (foreign.length) {
    throw new LiteralSafetyError('invalid_identifier', foreign[0].path, '', `generated project carries Jinja outside the generator's grammar: ${foreign[0].reason}`);
  }
  // The ids and reasons are free text here: a refused record's id may itself be the refused value.
  const list = [...skipped.entries()].map(([dataset, reason]) => ({ dataset: freeText(dataset), reason: freeText(reason) })).sort((a, b) => a.dataset.localeCompare(b.dataset));
  if (list.length) {
    files.set(SKIPPED_PATH, yml({ version: 1, skipped: list }));
    files = new Map([...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }
  return { files, skipped: list };
}

/** The complete project tree: path → content. Sorted by path. Invalid datasets are left out. */
export function generateProject(domain: string, snapshot: ProjectSnapshot, opts: GenerateOptions = {}): Map<string, string> {
  return generateProjectReport(domain, snapshot, opts).files;
}

/**
 * One render; a dataset whose compiled body is refused by `jinjaFreeSql` (a `LiteralSafetyError`
 * thrown while planning) is recorded as skipped and the render is repeated without it.
 */
function renderSafely(domain: string, snapshot: ProjectSnapshot, opts: GenerateOptions, skipped: Map<string, string>): Map<string, string> {
  let datasets = snapshot.datasets;
  for (;;) {
    try {
      return renderProject(domain, { ...snapshot, datasets }, opts);
    } catch (e) {
      if (!(e instanceof LiteralSafetyError) || !e.datasetId) throw e;
      skipped.set(e.datasetId, e.message);
      datasets = datasets.filter((x) => x.dataset.id !== e.datasetId);
    }
  }
}

/** One render of every dataset in `snapshot`, unchecked. */
function renderProject(domain: string, snapshot: ProjectSnapshot, opts: GenerateOptions): Map<string, string> {
  const plan = planModels(snapshot);
  const files = new Map<string, string>();
  files.set('dbt_project.yml', renderDbtProject(domain, plan, undefined, opts.dashboardsModelPath, opts.alertsModelPath));
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
  const schedules = renderSchedules(plan.models, { domain, runGrants: opts.runGrants });
  if (schedules) files.set('os/schedules.yml', schedules);
  const external = renderExternal(plan.externals);
  if (external) files.set('os/external.yml', external);
  // The Dagster code location (WP-49) and, in the OS layer, the hash the platform checks before it
  // imports the module (artifact contract C5): what Dagster executes is exactly what the OS wrote.
  const definitions = renderDagsterDefinitions(domain, plan);
  if (definitions) {
    files.set(DATA_LAYOUT.dagsterDefinitionsPath, definitions);
    files.set(DATA_LAYOUT.generatedHashesPath, yml({
      version: 1,
      sha256: { [DATA_LAYOUT.dagsterDefinitionsPath]: createHash('sha256').update(definitions).digest('hex') },
      // Which owner each OS-generated model belongs to. `os/**` is unpushable, so no author can add a
      // model here: the run detective (images/extensions/dagster) judges a run against this map.
      owners: Object.fromEntries([...plan.models].sort((a, b) => a.name.localeCompare(b.name)).map((m) => [m.name, m.dataset.owner])),
    }));
  }
  // The semantic layer: `models/semantic/<model>.yml` (or the owner's personal lane) plus the time
  // spine. Metrics are dbt artefacts in this project, not an OS-private record (D1, M1).
  for (const [p, c] of semantic.files) files.set(p, c);
  // OS layer, ALWAYS written (also for a domain with no native definitions): every generated model/test
  // file with its owner (null: shared by several owners). The receive gate refuses a change by anyone but
  // that owner or a domain admin, and fails closed for models/ and tests/ while this file is missing.
  files.set(DATA_LAYOUT.ownedFilesPath, yml({
    version: 1,
    files: Object.fromEntries(
      [...files.keys()]
        .filter((k) => k.startsWith('models/') || k.startsWith('tests/'))
        .sort()
        .map((k) => [k, plan.models.find((m) => m.path === k)?.dataset.owner ?? null]),
    ),
  }));
  return new Map([...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
