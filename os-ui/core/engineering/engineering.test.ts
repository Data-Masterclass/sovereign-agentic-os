/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       engineering view
 * FEATURE:    The shared half of the engineering view — sections, the vocabulary rule, the honesty
 *             invariants, the registry and the graph layout
 * USER STORY: As a reviewer I want the rules that make this surface trustworthy — the tools' own
 *             nouns (T2), "a section that cannot be filled says why" and "a link that cannot
 *             resolve says why" (T7) — asserted once, over the real builders the five adapters
 *             use, so no adapter can break them quietly.
 * ARCHITECTURE:
 *   - Pure: no git, no Dagster, no React, no tab import (CORE-INDEPENDENCE).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dagsterSection,
  dbtNounFor,
  dbtSection,
  gitSection,
  langfuseSection,
  langgraphSection,
  languageFor,
  LANGFUSE_REDACTIONS,
} from '@core/engineering/sections';
import { ENGINEERING_KINDS, ENGINEERING_TOOLS, sealView, unresolvedLink, type EngineeringView } from '@core/engineering/types';
import { hasOsNoun, hasToolNoun, labelViolations, TOOL_LABELS, vocabularyViolations } from '@core/engineering/vocabulary';
import { graphJson, type EngineeringGraph } from '@core/engineering/graph';
import { agentColumns, layoutGraph } from '@core/ui/engineering/graph-layout';
import { emptyText, orderedSections, PANEL_TITLE, tabCaption, unresolvedText } from '@core/ui/engineering/panel';
import {
  engineeringAdapter,
  registeredEngineeringKinds,
  registerEngineeringAdapter,
  __unregisterEngineeringAdapterForTests,
} from '@core/engineering/registry';

const GRAPH: EngineeringGraph = {
  entrypoint: 'plan_lead',
  nodes: [
    { id: 'START', phase: 'start', agent: null },
    { id: 'plan_lead', phase: 'plan', agent: 'lead' },
    { id: 'act_lead', phase: 'act', agent: 'lead' },
    { id: 'tools_lead', phase: 'tools', agent: 'lead' },
    { id: 'route_lead', phase: 'route', agent: 'lead' },
    { id: 'END', phase: 'end', agent: null },
  ],
  edges: [
    { from: 'START', to: 'plan_lead', kind: 'direct', when: null },
    { from: 'act_lead', to: 'tools_lead', kind: 'conditional', when: 'a tool call is pending' },
    { from: 'route_lead', to: 'END', kind: 'command', when: null },
  ],
  channels: [{ name: 'draft', declaration: 'string' }],
  interrupts: [{ node: 'tools_lead', reason: 'an approval parks the thread here' }],
  checkpointer: 'MemorySaver (@langchain/langgraph)',
  threadIdSemantics: 'the LangGraph `thread_id` IS the OS run id',
  resumeSemantics: 'resume re-enters at the last checkpoint',
};

const view = (sections: EngineeringView['sections']): EngineeringView => ({
  kind: 'dataset',
  id: 'ds_1',
  name: 'Orders',
  domain: 'ops',
  sections,
});

// ---- the vocabulary rule (T2) ---------------------------------------------------

test('T2: every section a builder produces names the tool\'s own noun, and the OS noun at most once', () => {
  const v = view([
    dbtSection({ osNoun: 'data product', node: 'gold_orders', files: [{ path: 'models/gold/gold_orders.sql', content: 'select 1' }] }),
    dagsterSection({
      osNoun: 'data product',
      facts: { assetKeys: [['ops', 'gold_orders']], jobName: 'ops__all', scheduleName: 'ops__ds_1', lastRun: { runId: 'r1', status: 'SUCCESS', startedAt: null }, uiBaseUrl: '/tools/dagster' },
    }),
    langgraphSection({ osNoun: 'agent system', graph: GRAPH }),
    gitSection({ osNoun: 'data product', repo: 'ops', cloneUrl: 'https://os/git/ops.git', head: 'abc123', files: [{ path: 'models/gold/gold_orders.sql' }] }),
    langfuseSection({ osNoun: 'agent system', enabled: true, traces: [{ runId: 'run_1', url: 'https://lf/trace/run_1' }], redactions: LANGFUSE_REDACTIONS }),
  ]);
  assert.deepEqual(vocabularyViolations(v), []);
});

test('T2: a label that uses ONLY an OS noun fails, and the bridge may appear once', () => {
  assert.ok(hasOsNoun('data product'));
  assert.ok(!hasToolNoun('dbt', 'the data product definition'));
  assert.deepEqual(labelViolations('dbt', 'title', 'dbt model `x` (data product)'), []);
  assert.equal(labelViolations('dbt', 'title', 'the data product definition').length, 1);
  assert.equal(labelViolations('dbt', 'title', 'dbt model (data product) (KPI)').length, 1);
  // The whole-view checker catches an OS-only section title.
  const bad = view([{ tool: 'dbt', label: 'dbt', title: 'Data product definition', artefacts: [], links: [], commands: [], unavailable: 'x' }]);
  assert.ok(vocabularyViolations(bad).length >= 1);
});

test('T2: the tab label is the tool\'s own name for every tool', () => {
  for (const tool of ENGINEERING_TOOLS) assert.ok(TOOL_LABELS[tool].length > 0, `${tool} has no label`);
  assert.equal(TOOL_LABELS.dbt, 'dbt');
  assert.equal(TOOL_LABELS.langgraph, 'LangGraph');
  assert.equal(PANEL_TITLE, 'Under the hood');
});

// ---- the honesty invariants (T7) ------------------------------------------------

test('T7: a section with no artefact carries a reason, and `sealView` refuses one that does not', () => {
  const s = dbtSection({ osNoun: 'data product', node: null, files: [], unavailable: 'nothing is committed in ops yet' });
  assert.equal(s.artefacts.length, 0);
  assert.match(s.unavailable ?? '', /nothing is committed/);
  assert.equal(emptyText(s), s.unavailable);
  assert.equal(tabCaption(s), 'dbt —');
  assert.throws(
    () => sealView(view([{ tool: 'dbt', label: 'dbt', title: 'dbt model', artefacts: [], links: [], commands: [] }])),
    /is empty and gives no reason/,
  );
});

test('T7: a deep link that cannot resolve says why — and `sealView` refuses one that does not', () => {
  const s = dagsterSection({
    osNoun: 'data product',
    facts: { assetKeys: [['ops', 'gold_orders']], jobName: null, scheduleName: null, lastRun: null, lastRunNote: 'never materialised', uiBaseUrl: null },
  });
  const link = s.links[0];
  assert.equal(link.url, null);
  assert.match(link.unresolvedReason ?? '', /does not expose the Dagster UI/);
  assert.match(unresolvedText(link.unresolvedReason ?? ''), /^This link does not resolve here: /);
  assert.throws(
    () => sealView(view([{ tool: 'dagster', label: 'Dagster', title: 'Dagster asset', artefacts: [{ noun: 'Dagster asset', name: 'x', body: 'x' }], links: [{ label: 'Open in Dagster', url: null }], commands: [] }])),
    /does not resolve and does not say why/,
  );
  assert.equal(unresolvedLink('x', 'because').unresolvedReason, 'because');
});

test('T7: an artefact with no body states why, and a Dagster section with no run says so', () => {
  const s = dagsterSection({
    osNoun: 'data product',
    facts: { assetKeys: [['ops', 'gold_orders']], jobName: 'ops__all', scheduleName: null, lastRun: null, lastRunNote: 'Dagster did not answer', uiBaseUrl: null },
  });
  const run = s.artefacts.find((a) => a.noun === 'Dagster run');
  assert.ok(run);
  assert.equal(run?.body, undefined);
  assert.match(run?.note ?? '', /Dagster did not answer/);
  assert.doesNotThrow(() => sealView(view([s])));
});

// ---- the dbt section (T3) -------------------------------------------------------

test('T3: the dbt section carries the repo path, the bytes and the three commands', () => {
  const s = dbtSection({
    osNoun: 'data product',
    node: 'gold_orders',
    files: [
      { path: 'models/gold/gold_orders.sql', content: 'select * from {{ ref("silver_orders") }}' },
      { path: 'models/gold/schema.yml', content: 'version: 2\n' },
      { path: 'models/sources.yml', content: 'version: 2\n' },
    ],
    metrics: ['revenue'],
  });
  assert.deepEqual(s.artefacts.map((a) => a.noun), ['dbt model', 'dbt model properties and dbt tests', 'dbt source']);
  assert.equal(s.artefacts[0].repoPath, 'models/gold/gold_orders.sql');
  assert.equal(s.artefacts[0].body, 'select * from {{ ref("silver_orders") }}');
  assert.equal(s.artefacts[0].language, 'sql');
  assert.deepEqual(s.commands.map((c) => c.command), [
    'dbt build --select gold_orders',
    'dbt test --select gold_orders',
    'mf query --metrics revenue --group-by metric_time__month',
  ]);
  assert.equal(languageFor('x.yml'), 'yaml');
  assert.equal(languageFor('x.json'), 'json');
  assert.equal(dbtNounFor('models/semantic/gold_orders.yml'), 'dbt semantic model');
  assert.equal(dbtNounFor('dbt_project.yml'), 'dbt project');
});

// ---- the Dagster section (T4) ---------------------------------------------------

test('T4: the Dagster section carries asset keys, job, schedule, the last run and the command', () => {
  const s = dagsterSection({
    osNoun: 'data product',
    facts: {
      assetKeys: [['ops', 'gold_orders']],
      jobName: 'ops__all',
      scheduleName: 'ops__ds_1',
      lastRun: { runId: 'run-7', status: 'SUCCESS', startedAt: '2026-11-14T00:00:00.000Z' },
      uiBaseUrl: '/tools/dagster',
    },
  });
  const asset = s.artefacts[0];
  assert.equal(asset.name, '["ops","gold_orders"]');
  assert.deepEqual(asset.facts?.map((f) => f.label), ['asset key', 'Dagster job', 'Dagster schedule']);
  assert.equal(s.links[0].url, '/tools/dagster/runs/run-7');
  assert.deepEqual(s.commands.map((c) => c.command), ['dagster asset materialize --select ops/gold_orders']);
  assert.ok(s.artefacts.some((a) => a.noun === 'Dagster run' && a.name === 'run-7'));
});

// ---- the LangGraph section + its diagram (T5) -----------------------------------

test('T5: the LangGraph section carries the compiled graph as JSON, the channels and the interrupts', () => {
  const s = langgraphSection({ osNoun: 'agent system', graph: GRAPH });
  const compiled = s.artefacts[0];
  assert.equal(compiled.language, 'json');
  assert.equal(compiled.body, graphJson(GRAPH));
  const parsed = JSON.parse(compiled.body ?? '{}') as EngineeringGraph;
  assert.deepEqual(parsed.nodes.map((n) => n.id), ['START', 'plan_lead', 'act_lead', 'tools_lead', 'route_lead', 'END']);
  assert.ok(compiled.facts?.some((f) => f.label === 'thread_id'));
  assert.ok(s.artefacts.some((a) => a.noun === 'LangGraph channel' && a.name === 'draft'));
  assert.ok(s.artefacts.some((a) => a.noun === 'LangGraph interrupt' && a.name === 'tools_lead'));
  assert.equal(s.graph, GRAPH);
});

test('T5: the diagram layout is one column per agent and one row per phase, deterministic', () => {
  assert.deepEqual(agentColumns(GRAPH), ['lead']);
  const a = layoutGraph(GRAPH);
  const b = layoutGraph(GRAPH);
  assert.deepEqual(a, b);
  const plan = a.nodes.find((n) => n.id === 'plan_lead');
  const act = a.nodes.find((n) => n.id === 'act_lead');
  assert.ok(plan && act && act.y > plan.y, 'act sits below plan');
  assert.equal(a.edges.length, GRAPH.edges.length);
  assert.ok(a.edges.find((e) => e.source === 'START')?.conditional === false);
});

// ---- the git and Langfuse sections (T6) -----------------------------------------

test('T6: the git section lists the files with paths and the head commit, and gives `git clone`', () => {
  const s = gitSection({
    osNoun: 'data product',
    repo: 'ops',
    cloneUrl: 'https://os/git/ops.git',
    head: 'abc1234',
    files: [{ path: 'models/gold/gold_orders.sql', bytes: 42 }],
  });
  assert.equal(s.artefacts[0].noun, 'git commit');
  assert.equal(s.artefacts[0].body, 'abc1234');
  assert.equal(s.artefacts[1].repoPath, 'models/gold/gold_orders.sql');
  assert.equal(s.commands[0].command, 'git clone https://os/git/ops.git');
  // No clone endpoint: the link says why rather than disappearing.
  const noClone = gitSection({ osNoun: 'data product', repo: 'ops', cloneUrl: null, head: 'abc', files: [{ path: 'a.sql' }] });
  assert.equal(noClone.links[0].url, null);
  assert.match(noClone.links[0].unresolvedReason ?? '', /authenticated git endpoint/);
});

test('T6: the Langfuse section gives the trace URL per run and states what is redacted', () => {
  const s = langfuseSection({ osNoun: 'agent system', enabled: true, traces: [{ runId: 'run_9', url: 'https://lf/trace/run_9' }], redactions: LANGFUSE_REDACTIONS });
  assert.equal(s.artefacts[0].facts?.[0].label, 'trace id = OS run id');
  assert.equal(s.links[0].url, 'https://lf/trace/run_9');
  assert.ok((s.caveats ?? []).some((c) => /secret values are not/.test(c)));
  // Ingestion off: a reason, and the redaction note still stands.
  const off = langfuseSection({ osNoun: 'agent system', enabled: false, traces: [], redactions: LANGFUSE_REDACTIONS });
  assert.match(off.unavailable ?? '', /not configured/);
  assert.equal(off.caveats?.length, LANGFUSE_REDACTIONS.length);
  // Console not exposed: the trace exists, the link says why it has no address.
  const noUrl = langfuseSection({ osNoun: 'agent system', enabled: true, traces: [{ runId: 'run_9', url: null }], redactions: LANGFUSE_REDACTIONS });
  assert.match(noUrl.links[0].unresolvedReason ?? '', /does not expose the Langfuse console/);
});

// ---- the registry and the panel ordering ---------------------------------------

test('T1: the registry maps a kind to exactly one adapter, and reports the kinds it has', () => {
  const stub = async () => view([]);
  assert.equal(engineeringAdapter('metric'), null, 'no metric adapter is registered in a pure core test');
  registerEngineeringAdapter('metric', stub);
  assert.equal(engineeringAdapter('metric'), stub);
  registerEngineeringAdapter('metric', async () => view([])); // second registration is a no-op
  assert.equal(engineeringAdapter('metric'), stub);
  assert.deepEqual(registeredEngineeringKinds(), ['metric']);
  __unregisterEngineeringAdapterForTests('metric');
  assert.equal(engineeringAdapter('metric'), null);
  assert.deepEqual([...ENGINEERING_KINDS], ['dataset', 'metric', 'dashboard', 'agent_system', 'app']);
});

test('the panel orders its tabs by the tools\' fixed order, whatever order the adapter emitted', () => {
  const v = view([
    langfuseSection({ osNoun: 'agent system', enabled: false, traces: [], redactions: LANGFUSE_REDACTIONS }),
    dbtSection({ osNoun: 'data product', node: null, files: [], unavailable: 'none' }),
  ]);
  assert.deepEqual(orderedSections(v).map((s) => s.tool), ['dbt', 'langfuse']);
});
