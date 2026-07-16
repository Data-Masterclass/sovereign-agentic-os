/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSystem } from '../system-schema.ts';
import { runChecks } from './run-checks.ts';
import type { DiagRun } from './run-diagnostics.ts';
import type { JudgeResult } from '../evaluate-judge.ts';
import { buildEvalReport, agentDisplayName } from './eval-report.ts';

const SYS = parseSystem(`
system: { name: Renewals Desk, domain: sales, visibility: Personal, description: "Score campaigns and recommend budget moves." }
safety_preset: read-propose
entrypoint: analyst
schedule: { kind: cron, cron: "0 9 * * 1" }
grants:
  tools: [query_data, search_knowledge]
  data:
    - { id: ds_campaigns, capability: Read }
  knowledge:
    - { id: wf_playbook, capability: Write-approval }
agents:
  - { id: analyst, role: Analyzes campaigns, agent_md: "# analyst\\n\\nRead the data and score it.", memory_md: "" }
  - { id: writer, role: Writes the recommendation, agent_md: "# writer\\n\\nWrite it up.", memory_md: "" }
`);

const RUN: DiagRun = {
  ok: true,
  path: ['analyst', 'writer'],
  output: '## Result\nBudget up 10%.',
  mode: 'live',
  nodes: [
    { node: 'analyst', model: 'gpt', tier: 'reasoning', status: 'ok', finalText: 'Scored.', steps: [{ tool: 'query_data' }] },
    { node: 'writer', status: 'ok', finalText: 'Recommend +10%.', steps: [] },
  ],
};

test('agentDisplayName is the role (its Name), else the id', () => {
  assert.equal(agentDisplayName({ id: 'a', role: 'Analyst' }), 'Analyst');
  assert.equal(agentDisplayName({ id: 'a', role: '  ' }), 'a');
  assert.equal(agentDisplayName({ id: 'a' }), 'a');
});

test('buildEvalReport assembles the exact mandated section structure', () => {
  const checks = runChecks(RUN);
  const judge: JudgeResult = {
    overall: 4.3,
    scores: [
      { dimension: 'clarity', score: 5, why: 'Clear.' },
      { dimension: 'grounding', score: 4, why: 'Grounded.' },
      { dimension: 'actionability', score: 4, why: 'Actionable.' },
    ],
  };
  const r = buildEvalReport(SYS, RUN, checks, judge, { ranBy: 'alex', at: 0 });

  // MAIN BODY — checks + judge (on-screen Evaluate content).
  assert.equal(r.checks.rows.length, 3);
  assert.equal(r.checks.allPass, true);
  if (!r.judge) throw new Error('expected a judge section');
  assert.equal(r.judge.overall, 4.3);
  assert.equal(r.judge.rows[0].dimension, 'Clarity');

  // APPENDIX 1 — Results (final output + per-agent, using the role as the name).
  assert.match(r.results.finalOutput, /Budget up 10%/);
  assert.equal(r.results.path, 'analyst → writer → END');
  assert.equal(r.results.agents[0].name, 'Analyzes campaigns', 'per-agent output uses the role');
  assert.equal(r.results.agents[1].name, 'Writes the recommendation', 'per-agent output uses the role');
  assert.equal(r.results.agents.length, 2);

  // APPENDIX 2 — Define settings (purpose, safety, trigger, grants).
  assert.match(r.define.purpose, /Score campaigns/);
  assert.equal(r.define.safety, 'Read + propose');
  assert.match(r.define.trigger, /On schedule/);
  const kinds = r.define.grants.map((g) => g.kind);
  assert.ok(kinds.includes('Data') && kinds.includes('Knowledge'));

  // APPENDIX 3 — Agent descriptions (name/role + instructions).
  assert.equal(r.agentDescriptions.length, 2);
  assert.equal(r.agentDescriptions[0].name, 'Analyzes campaigns');
  assert.equal(r.agentDescriptions[0].role, 'Analyzes campaigns');
  assert.match(r.agentDescriptions[0].instructions, /Read the data/);
});

test('buildEvalReport omits the judge section when the AI judge was not run', () => {
  const r = buildEvalReport(SYS, RUN, runChecks(RUN), null, { ranBy: 'alex', at: 0 });
  assert.equal(r.judge, null, 'no judge section when not run — mirrors the screen');
});