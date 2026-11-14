/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    `engineeringView('metric', id, input)` — the metric's "Under the hood" data
 * USER STORY: As a data engineer I want to open a metric in the OS and see the real dbt artefact —
 *             the `semantic_models:` + `metrics:` YAML in my repo, the Trino SQL that ran, the
 *             principal it ran as, the commands I would type myself — in dbt's and Trino's own
 *             vocabulary, not an OS re-naming of them (D25, checklist T1/T2).
 * ARCHITECTURE:
 *   - PURE and TOTAL: (ids + the already-resolved facts) → a serialisable view. No store, no fs, no
 *     env, no Trino. Stream T owns the shared panel and the `core/engineering/` registry and wires
 *     the input from the registry it already reads; this stream owns the DATA and its vocabulary.
 *     Keeping it pure is also what makes it identical over MCP (`get_engineering_view`) and in the
 *     UI — one structure, one test, no second code path.
 *   - The types here are LOCAL on purpose. `core/engineering/` does not exist yet (T lands it
 *     tonight), and a tab may not import another tab, so this file imports nothing but its own tab.
 *     When T's registry lands, its `EngineeringView` replaces {@link MetricEngineeringView}
 *     structurally — the field names are chosen to match the plan's description.
 *   - VOCABULARY RULE (T2): every label is the tool's own noun — "dbt metric", "dbt semantic
 *     model", "Trino query" — with the OS term in parentheses once where a reader needs the bridge.
 *   - HONESTY: a fact the caller could not resolve is ABSENT, and the view says so in `notTrueYet`
 *     rather than rendering a confident blank. A deep link that cannot resolve is not emitted.
 */
import type { DbtMetricType } from '@tabs/metrics/lib/model';

/** MERGE NOTE: deleted at merge and imported from `@core/engineering` — stream T owns that type.
 *  One tab of the Under-the-hood panel: a tool, its artefact, the command, the deep link. */
export type EngineeringSection = {
  /** The TOOL's name, as its own users say it. */
  tool: 'dbt' | 'Trino' | 'git' | 'Dagster';
  /** A short label in the tool's vocabulary, e.g. `dbt metric (KPI)`. */
  label: string;
  /** Key/value facts, in the tool's own field names. */
  facts: { name: string; value: string }[];
  /** The literal artefact bytes, when there are any (the YAML in the repo, the SQL that ran). */
  artifact?: { filename: string; language: 'yaml' | 'sql' | 'text'; body: string };
  /** The command an engineer would run to do the same thing outside the OS. */
  command?: string;
  /** A deep link, ONLY when it can actually resolve. */
  link?: { label: string; href: string };
};

/** MERGE NOTE: deleted at merge and imported from `@core/engineering` — stream T owns that type. */
export type MetricEngineeringView = {
  kind: 'metric';
  /** `<datasetId>.<measure>` — the OS id. */
  id: string;
  /** The display name. */
  title: string;
  sections: EngineeringSection[];
  /** What the OS still does its own way, in its own words (the `docs/components/trino.md` pattern). */
  notTrueYet: string[];
};

/** Everything the caller must have resolved already. Absent fields are reported, never faked. */
export type MetricEngineeringInput = {
  /** Display name (the measure's label, else its name). */
  title: string;
  /** The OS member id — frozen across renames. */
  member: string;
  /** The dbt metric type this metric is emitted as. */
  metricType: DbtMetricType;
  /** The dbt metric NAME in the project (may be qualified when a name collided). */
  dbtMetricName: string;
  /** The dbt semantic model it sits on. */
  dbtSemanticModel: string;
  /** The dbt model the semantic model `ref()`s. */
  dbtModel: string;
  /** Repo-relative path of the YAML, e.g. `models/semantic/sales__orders.yml`. */
  yamlPath: string;
  /** The YAML bytes in the repo. Absent ⇒ the file could not be read. */
  yaml?: string;
  /** The domain whose repo holds it. */
  domain: string;
  /** The head commit of that YAML file, when git could be read. */
  headSha?: string;
  /** The exact Trino SQL the last read ran. Absent ⇒ nothing has been read yet. */
  trinoSql?: string;
  /** The Trino principal that SQL ran as — the viewer, never a service identity. */
  trinoPrincipal?: string;
  /** The physical gold table the SQL reads. */
  goldFqn?: string;
  /** The finest time grain the metric can be sliced at; absent ⇒ no time dimension. */
  grain?: 'day';
  /** Set when the OS compiler refuses to serve this metric: the typed code and its reason. */
  refusal?: { code: string; reason: string };
  /** The pinned dbt semantic spec, so the panel states which dialect the YAML is. */
  spec: { dsiVersion: string; dbtCore: string };
};

/** One line, collapsed whitespace — a SQL statement for a shell argument. */
function oneLine(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

/**
 * Wrap a string as a POSIX single-quoted shell word (review L-3).
 *
 * The command is offered for an engineer to COPY, so it has to be correct when pasted. A SQL
 * literal containing an apostrophe — `WHERE region = 'côte d''ivoire'` — ended the quote early and
 * produced a command that either fails or, worse, runs something other than the statement shown.
 * `'…'` with every embedded quote rendered as `'\''` is the only form that needs no escaping rules
 * of its own.
 */
export function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** `{ name, value }` for every defined fact, in declaration order. */
function facts(pairs: [string, string | undefined][]): { name: string; value: string }[] {
  return pairs.filter((p): p is [string, string] => typeof p[1] === 'string' && p[1].length > 0).map(([name, value]) => ({ name, value }));
}

/**
 * The metric's engineering view. `kind` is the discriminator stream T's registry switches on, so
 * the signature reads `engineeringView('metric', id, input)` from the registry's side.
 */
export function engineeringView(kind: 'metric', id: string, input: MetricEngineeringInput): MetricEngineeringView {
  void kind;
  const notTrueYet: string[] = [];
  const sections: EngineeringSection[] = [];

  sections.push({
    tool: 'dbt',
    label: `dbt metric (KPI) — type: ${input.metricType}`,
    facts: facts([
      ['name', input.dbtMetricName],
      ['type', input.metricType],
      ['semantic model', input.dbtSemanticModel],
      ['model', `ref('${input.dbtModel}')`],
      ['file', input.yamlPath],
      ['spec', `dbt-semantic-interfaces ${input.spec.dsiVersion} (dbt-core ${input.spec.dbtCore})`],
      ['time granularity', input.grain],
      ['OS member', input.member],
    ]),
    ...(input.yaml ? { artifact: { filename: input.yamlPath, language: 'yaml' as const, body: input.yaml } } : {}),
    command: `mf query --metrics ${input.dbtMetricName}${input.grain ? ` --group-by metric_time__${input.grain}` : ''}`,
  });
  if (!input.yaml) notTrueYet.push(`The YAML at \`${input.yamlPath}\` could not be read from the repository, so the bytes below are not shown.`);

  sections.push({
    tool: 'Trino',
    label: 'Trino query — run as you, not as a service identity',
    facts: facts([
      ['principal', input.trinoPrincipal],
      ['table', input.goldFqn],
      ['access control', 'Trino → OPA, per viewer (row and column filters)'],
    ]),
    ...(input.trinoSql ? { artifact: { filename: 'metric.sql', language: 'sql' as const, body: input.trinoSql } } : {}),
    ...(input.trinoSql ? { command: `trino --execute ${shellSingleQuote(oneLine(input.trinoSql))}` } : {}),
  });
  if (!input.trinoSql) notTrueYet.push('No SQL is shown because this metric has not been read in this session yet — open it in the explorer and the exact statement appears here.');

  sections.push({
    tool: 'git',
    label: 'git — the file, its history, and who wrote it',
    facts: facts([
      ['repository', `${input.domain}.git`],
      ['path', input.yamlPath],
      ['head', input.headSha],
      ['commit trailer', `OS-Object: metric:${id}`],
    ]),
    command: `git log --follow -p -- ${input.yamlPath}`,
  });
  if (!input.headSha) notTrueYet.push('The head commit is not shown because the repository could not be read.');

  // The honest list, in the OS's own words — the `docs/components/trino.md` pattern.
  notTrueYet.push(
    'MetricFlow does not serve this number. The OS compiles the metric into one Trino SELECT itself, so the per-viewer impersonation is preserved; `mf query` above is what you would run on a clone.',
  );
  if (input.metricType === 'cumulative') {
    notTrueYet.push(
      'The time spine (`models/os/os_time_spine_day.sql`) is generated but the OS compiler does not join to it yet, so a trailing window counts existing buckets: it is served only when the window unit equals the slice grain, and refused otherwise.',
    );
  }
  if (input.refusal) notTrueYet.push(`The OS compiler is currently refusing to serve this metric (${input.refusal.code}): ${input.refusal.reason}`);

  return { kind: 'metric', id, title: input.title, sections, notTrueYet };
}
