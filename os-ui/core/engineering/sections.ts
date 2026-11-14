/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       engineering view
 * FEATURE:    The five section builders every adapter composes — dbt, Dagster, LangGraph, git, Langfuse
 * USER STORY: As a maintainer I want each tab's adapter to be a short, honest mapping from its own
 *             record to the tools' artefacts, and I want the tool vocabulary, the commands and the
 *             "say why it is empty" rule to be written ONCE so five adapters cannot drift
 *             (checklist T2, T3, T4, T5, T6, T7).
 * ARCHITECTURE:
 *   - PURE. Every builder takes data the adapter already fetched (repo bytes, Dagster run, URLs)
 *     and returns an `EngineeringSection`. No fetch, no `server-only`, no tab import — so one
 *     fixture per kind is enough to test an adapter.
 *   - Commands are the tools' real CLIs, checked against their own docs: `dbt build --select`,
 *     `dbt test --select`, `mf query --metrics … --group-by …`, `dagster asset materialize --select`,
 *     `git clone` / `git log`. Never a command the OS invented.
 *   - A deep link whose base URL is not configured is `url: null` WITH a reason: the OS not
 *     exposing a console is a fact about the deployment, not a silent failure (checklist T7).
 */
import {
  unavailableSection,
  type EngineeringArtefact,
  type EngineeringCommand,
  type EngineeringLink,
  type EngineeringSection,
} from '@core/engineering/types';
import { graphJson, type EngineeringGraph } from '@core/engineering/graph';
import { TOOL_LABELS } from '@core/engineering/vocabulary';

/** One file as it is stored in the domain repository. */
export type RepoFile = { path: string; content: string };

/** The language the panel renders a repo file in — by extension, nothing cleverer. */
export function languageFor(path: string): 'sql' | 'yaml' | 'json' | 'text' {
  if (path.endsWith('.sql')) return 'sql';
  if (path.endsWith('.yml') || path.endsWith('.yaml')) return 'yaml';
  if (path.endsWith('.json')) return 'json';
  return 'text';
}

/**
 * dbt's own noun for a file in a dbt project, by the path dbt itself gives it meaning by.
 * `models/**.sql` is a model; `sources.yml` declares sources; `models/semantic/*.yml` holds
 * semantic models and metrics; `dbt_project.yml` / `profiles.yml` are the project.
 */
export function dbtNounFor(path: string): string {
  const base = path.split('/').pop() ?? path;
  if (path.endsWith('.sql')) return 'dbt model';
  if (base === 'dbt_project.yml' || base === 'profiles.yml') return 'dbt project';
  if (base === 'sources.yml') return 'dbt source';
  if (path.includes('/semantic/')) return 'dbt semantic model';
  if (base.startsWith('metrics')) return 'dbt metric';
  if (base === 'schema.yml' || base.startsWith('schema')) return 'dbt model properties and dbt tests';
  return 'dbt project file';
}

/** The dbt section: the bytes in the repo, the repo paths, and the three commands. */
export function dbtSection(input: {
  /** The OS's word for this object, used once, in parentheses. */
  osNoun: string;
  /** The dbt node (model) name the commands select, or null when there is none yet. */
  node: string | null;
  files: RepoFile[];
  /** Metric names for `mf query`, when this object is (or has) dbt metrics. */
  metrics?: string[];
  /** Why there are no files — required when `files` is empty. */
  unavailable?: string;
  caveats?: string[];
}): EngineeringSection {
  const title = input.node
    ? `dbt model \`${input.node}\` (${input.osNoun})`
    : `dbt project files (${input.osNoun})`;
  if (input.files.length === 0) {
    const section = unavailableSection('dbt', TOOL_LABELS.dbt, title, input.unavailable ?? 'no dbt files for this object in the domain repository yet');
    if (input.caveats?.length) section.caveats = input.caveats;
    return section;
  }
  const artefacts: EngineeringArtefact[] = input.files.map((f) => ({
    noun: dbtNounFor(f.path),
    name: f.path.split('/').pop() ?? f.path,
    repoPath: f.path,
    language: languageFor(f.path),
    body: f.content,
  }));
  const commands: EngineeringCommand[] = [];
  if (input.node) {
    commands.push(
      { tool: 'dbt', command: `dbt build --select ${input.node}`, description: 'run this model and the tests attached to it' },
      { tool: 'dbt', command: `dbt test --select ${input.node}`, description: 'run only its tests' },
    );
  } else {
    commands.push({ tool: 'dbt', command: 'dbt build', description: 'run the whole project' });
  }
  for (const m of input.metrics ?? []) {
    commands.push({
      tool: 'dbt',
      command: `mf query --metrics ${m} --group-by metric_time__month`,
      description: 'query the dbt metric through MetricFlow, by month',
    });
  }
  const section: EngineeringSection = { tool: 'dbt', label: TOOL_LABELS.dbt, title, artefacts, links: [], commands };
  if (input.caveats?.length) section.caveats = input.caveats;
  return section;
}

/** What the OS knows about the Dagster side of an object. */
export type DagsterFacts = {
  /** Asset keys as Dagster prints them: `["ops","orders"]`. */
  assetKeys: string[][];
  jobName: string | null;
  scheduleName: string | null;
  lastRun: { runId: string; status: string; startedAt: string | null } | null;
  /** Why there is no last run (never materialised, Dagster unreachable) — when `lastRun` is null. */
  lastRunNote?: string;
  /**
   * Dagster's OWN console URL for this deployment, or null when there is nothing to open — either
   * the deployment exposes no console or the caller's role may not open the tool. When it is null
   * the link says which of the two it is (`noLinkReason`).
   */
  uiBaseUrl: string | null;
  /** Why there is no link — required when `uiBaseUrl` is null. */
  noLinkReason?: string;
};

const assetKeyPath = (key: string[]) => key.join('/');

/** The Dagster section: asset keys, job, schedule, last run, the deep link and the command. */
export function dagsterSection(input: { osNoun: string; facts: DagsterFacts; unavailable?: string; caveats?: string[] }): EngineeringSection {
  const { facts } = input;
  const title = `Dagster asset${facts.assetKeys.length === 1 ? '' : 's'} (${input.osNoun})`;
  if (facts.assetKeys.length === 0) {
    const s = unavailableSection('dagster', TOOL_LABELS.dagster, 'Dagster asset (' + input.osNoun + ')', input.unavailable ?? 'the OS defines no Dagster asset for this object');
    if (input.caveats?.length) s.caveats = input.caveats;
    return s;
  }
  const artefacts: EngineeringArtefact[] = facts.assetKeys.map((key) => ({
    noun: 'Dagster asset',
    name: JSON.stringify(key),
    body: assetKeyPath(key),
    language: 'text',
    facts: [
      { label: 'asset key', value: JSON.stringify(key) },
      ...(facts.jobName ? [{ label: 'Dagster job', value: facts.jobName }] : []),
      ...(facts.scheduleName ? [{ label: 'Dagster schedule', value: facts.scheduleName }] : []),
    ],
  }));
  if (facts.lastRun) {
    artefacts.push({
      noun: 'Dagster run',
      name: facts.lastRun.runId,
      body: `${facts.lastRun.status}${facts.lastRun.startedAt ? ` since ${facts.lastRun.startedAt}` : ''}`,
      language: 'text',
      facts: [
        { label: 'run id', value: facts.lastRun.runId },
        { label: 'status', value: facts.lastRun.status },
      ],
    });
  } else {
    artefacts.push({
      noun: 'Dagster run',
      name: 'none',
      note: input.unavailable ?? facts.lastRunNote ?? 'no run recorded for this asset yet',
    });
  }
  const links: EngineeringLink[] = [
    facts.uiBaseUrl
      ? {
        label: 'Open in Dagster',
        url: facts.lastRun
          ? `${facts.uiBaseUrl}/runs/${encodeURIComponent(facts.lastRun.runId)}`
          : `${facts.uiBaseUrl}/asset-groups`,
      }
      : {
        label: 'Open in Dagster',
        url: null,
        unresolvedReason: facts.noLinkReason ?? 'there is no Dagster console address to send you to in this deployment',
      },
  ];
  const commands: EngineeringCommand[] = facts.assetKeys.map((key) => ({
    tool: 'dagster',
    command: `dagster asset materialize --select ${assetKeyPath(key)}`,
    description: 'materialise this asset from a checkout of the code location',
  }));
  const section: EngineeringSection = { tool: 'dagster', label: TOOL_LABELS.dagster, title, artefacts, links, commands };
  if (input.caveats?.length) section.caveats = input.caveats;
  return section;
}

/** The LangGraph section: the compiled graph as JSON, plus the thread/checkpointer semantics. */
export function langgraphSection(input: { osNoun: string; graph: EngineeringGraph | null; unavailable?: string; caveats?: string[] }): EngineeringSection {
  const title = `LangGraph graph (${input.osNoun})`;
  if (!input.graph) {
    const s = unavailableSection('langgraph', TOOL_LABELS.langgraph, title, input.unavailable ?? 'this object does not compile to a LangGraph graph');
    if (input.caveats?.length) s.caveats = input.caveats;
    return s;
  }
  const g = input.graph;
  const artefacts: EngineeringArtefact[] = [
    {
      noun: 'LangGraph graph',
      name: 'compiled graph',
      language: 'json',
      body: graphJson(g),
      facts: [
        { label: 'entry node', value: g.entrypoint },
        { label: 'LangGraph nodes', value: String(g.nodes.length) },
        { label: 'LangGraph edges', value: String(g.edges.length) },
        { label: 'LangGraph checkpointer', value: g.checkpointer },
        { label: 'thread_id', value: g.threadIdSemantics },
        { label: 'resume', value: g.resumeSemantics },
      ],
    },
  ];
  for (const c of g.channels) {
    artefacts.push({ noun: 'LangGraph channel', name: c.name, language: 'text', body: c.declaration });
  }
  for (const i of g.interrupts) {
    artefacts.push({ noun: 'LangGraph interrupt', name: i.node, language: 'text', body: i.reason });
  }
  const section: EngineeringSection = {
    tool: 'langgraph',
    label: TOOL_LABELS.langgraph,
    title,
    artefacts,
    links: [],
    commands: [],
    graph: g,
  };
  if (input.caveats?.length) section.caveats = input.caveats;
  return section;
}

/**
 * The git section: the file list with paths and the head sha, plus `git clone` and `git log`.
 * It carries DATA only — the head badge itself is `core/ui/git/`'s component (stream G), which the
 * detail page mounts and the panel composes; this never draws a second badge (checklist T6).
 */
export function gitSection(input: {
  osNoun: string;
  repo: string;
  /** The clone URL an engineer uses, or null when the deployment serves no git endpoint. */
  cloneUrl: string | null;
  head: string | null;
  files: { path: string; bytes?: number }[];
  /** Every path the repository tracks at `main`. `files` is INTERSECTED with it, so a path the
   *  generator has not written yet can never be presented as committed — the rule is structural
   *  here and enforced again by `sealView`. */
  tracked: ReadonlySet<string>;
  unavailable?: string;
  caveats?: string[];
}): EngineeringSection {
  const title = `git repository \`${input.repo}\` (${input.osNoun})`;
  input = { ...input, files: input.files.filter((f) => input.tracked.has(f.path)) };
  if (input.files.length === 0) {
    const s = unavailableSection('git', TOOL_LABELS.git, title, input.unavailable ?? 'nothing is committed for this object yet');
    if (input.caveats?.length) s.caveats = input.caveats;
    return s;
  }
  const artefacts: EngineeringArtefact[] = [
    {
      noun: 'git commit',
      name: input.head ?? 'no head',
      language: 'text',
      ...(input.head ? { body: input.head } : { note: 'the repository has no commit on `main` yet' }),
      facts: [{ label: 'head', value: input.head ?? '(none)' }],
    },
    ...input.files.map((f) => ({
      noun: 'git file',
      name: f.path.split('/').pop() ?? f.path,
      repoPath: f.path,
      language: 'text' as const,
      body: f.path,
      ...(f.bytes === undefined ? {} : { facts: [{ label: 'bytes', value: String(f.bytes) }] }),
    })),
  ];
  const commands: EngineeringCommand[] = input.cloneUrl
    ? [
      { tool: 'git', command: `git clone ${input.cloneUrl}`, description: 'clone the domain repository and read every file, governance metadata included' },
      { tool: 'git', command: `git log --oneline -- ${input.files[0].path}`, description: 'the history of this file' },
    ]
    : [{ tool: 'git', command: `git log --oneline -- ${input.files[0].path}`, description: 'the history of this file, in a checkout of the domain repository' }];
  const links: EngineeringLink[] = input.cloneUrl
    ? []
    : [{ label: 'git clone URL', url: null, unresolvedReason: 'this deployment does not publish an authenticated git endpoint yet, so there is no clone URL to show' }];
  const section: EngineeringSection = { tool: 'git', label: TOOL_LABELS.git, title, artefacts, links, commands };
  if (input.caveats?.length) section.caveats = input.caveats;
  return section;
}

/** The Langfuse section: the trace URL per run or turn, and what is redacted, and why. */
export function langfuseSection(input: {
  osNoun: string;
  /** The traces this object has, newest first: the OS run id IS the Langfuse trace id. */
  traces: { runId: string; url: string | null }[];
  /** True when Langfuse ingestion is configured at all. */
  enabled: boolean;
  /** Why a trace has no URL (console not exposed) — used for every null url. */
  noUrlReason?: string;
  unavailable?: string;
  redactions: string[];
}): EngineeringSection {
  const title = `Langfuse trace (${input.osNoun})`;
  if (!input.enabled) {
    const s = unavailableSection('langfuse', TOOL_LABELS.langfuse, title, input.unavailable ?? 'Langfuse ingestion is not configured in this deployment, so no trace exists to show');
    s.caveats = input.redactions;
    return s;
  }
  if (input.traces.length === 0) {
    const s = unavailableSection('langfuse', TOOL_LABELS.langfuse, title, input.unavailable ?? 'this object has no run yet, so there is no Langfuse trace');
    s.caveats = input.redactions;
    return s;
  }
  const artefacts: EngineeringArtefact[] = input.traces.map((t) => ({
    noun: 'Langfuse trace',
    name: t.runId,
    language: 'text',
    body: t.runId,
    facts: [{ label: 'trace id = OS run id', value: t.runId }],
  }));
  const links: EngineeringLink[] = input.traces.map((t) =>
    t.url
      ? { label: `Open trace ${t.runId}`, url: t.url }
      : {
        label: `Open trace ${t.runId}`,
        url: null,
        unresolvedReason: input.noUrlReason ?? 'this deployment does not expose the Langfuse console, so the trace exists but has no address here',
      },
  );
  return {
    tool: 'langfuse',
    label: TOOL_LABELS.langfuse,
    title,
    artefacts,
    links,
    commands: [],
    caveats: input.redactions,
  };
}

/**
 * What the OS redacts before a span reaches Langfuse, stated on every Langfuse section so the
 * answer is on the surface rather than in a doc nobody opens.
 */
export const LANGFUSE_REDACTIONS: string[] = [
  'Tool arguments and results are recorded; secret values are not — a connection secret, a token or a model key never leaves the OS, and a LiteLLM key is referenced by its alias only.',
  'Every Langfuse read the OS performs is filtered by run, user or scope, so no surface can list another user\'s observations.',
];
