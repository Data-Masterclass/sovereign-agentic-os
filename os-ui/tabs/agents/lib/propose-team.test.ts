/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSystem, serializeSystem } from '@tabs/agents/lib/system-schema';
import { compile } from '@tabs/agents/lib/langgraph-compile';
import { proposeTeam, buildContextBlock } from '@tabs/agents/lib/propose-team';

/** An empty starting system (a fresh Agents builder session). */
const EMPTY = `
system: { name: Untitled system, domain: sales, visibility: Personal }
entrypoint: ""
grants: { tools: [] }
agents: []
`;

const FOUR_STEP = JSON.stringify({
  agents: [
    { id: 'pull-campaign-data', role: 'Pulls campaign data', instruction: 'Query the granted campaign dataset for the period.' },
    { id: 'check-margins', role: 'Checks margins after returns', instruction: 'Compute margin after returns per campaign.' },
    { id: 'score-campaigns', role: 'Scores each campaign against rules', instruction: 'Apply the policy rules and score each campaign.' },
    { id: 'recommend-budget', role: 'Recommends budget changes', instruction: 'Recommend budget changes from the scores.' },
  ],
});

test('proposeTeam produces a valid, compile-clean linear team and does NOT persist', async () => {
  const before = parseSystem(EMPTY);
  const { system, summary } = await proposeTeam({
    system: before,
    description: 'pull campaign data, check margins, score, recommend budget',
    context: { data: [{ id: 'ds_1', name: 'campaigns' }], tools: ['query_data', 'search_knowledge'] },
    complete: async () => FOUR_STEP,
  });

  assert.equal(system.agents.length, 4);
  assert.equal(system.entrypoint, system.agents[0].id);
  // Linear handoff chain.
  for (let i = 0; i < system.agents.length - 1; i++) {
    assert.ok(
      system.edges.some((e) => e.from === system.agents[i].id && e.to === system.agents[i + 1].id && e.type === 'handoff'),
      `handoff ${system.agents[i].id} -> ${system.agents[i + 1].id}`,
    );
  }
  // Compile-clean + round-trips through the schema (identical to the manual builder path).
  assert.doesNotThrow(() => parseSystem(serializeSystem(system)));
  assert.doesNotThrow(() => compile(system));
  assert.match(summary, /team/i);
  // The input system is untouched (proposeTeam returns a new System, never mutates input).
  assert.equal(before.agents.length, 0, 'input system not mutated');
});

test('the grounding context is passed to the completer (grounded, not the whole catalog)', async () => {
  const before = parseSystem(EMPTY);
  let seenUser = '';
  await proposeTeam({
    system: before,
    description: 'summarise the weekly report',
    context: {
      description: 'Produce a weekly ops summary',
      data: [{ id: 'ds_9', name: 'weekly_ops' }],
      knowledge: [{ id: 'wf_1', name: 'Ops Playbook' }],
      outputs: [{ kind: 'files', name: 'Weekly Summary' }],
    },
    complete: async (_sys, user) => {
      seenUser = user;
      return FOUR_STEP;
    },
  });
  assert.match(seenUser, /weekly_ops/, 'granted data name is grounded into the prompt');
  assert.match(seenUser, /Ops Playbook/, 'granted knowledge name is grounded');
  assert.match(seenUser, /Weekly Summary/, 'declared output is grounded');
  assert.match(seenUser, /Produce a weekly ops summary/, 'deliverable is grounded');
});

test('tools stay within the role-floor catalog (never above the floor)', async () => {
  const before = parseSystem(EMPTY);
  const floor = ['search_knowledge'];
  const { system } = await proposeTeam({
    system: before,
    description: 'pull data, analyze, report',
    context: { tools: ['query_data', 'search_knowledge'] },
    complete: async () => FOUR_STEP,
    toolCatalog: floor, // explicit floor wins over the context tool pool
  });
  for (const t of system.grants.tools) assert.ok(floor.includes(t), `grant ${t} within floor`);
  for (const a of system.agents) for (const t of a.tools ?? []) assert.ok(floor.includes(t), `${a.id} tool ${t} within floor`);
  assert.doesNotThrow(() => compile(system));
});

test('a <2-agent proposal is rejected (honest, never a fabricated team)', async () => {
  const before = parseSystem(EMPTY);
  await assert.rejects(
    () => proposeTeam({ system: before, description: 'x', context: {}, complete: async () => '{"agents":[]}' }),
    /could not turn that description/i,
  );
});

test('an empty description is rejected', async () => {
  const before = parseSystem(EMPTY);
  await assert.rejects(
    () => proposeTeam({ system: before, description: '   ', context: {}, complete: async () => FOUR_STEP }),
    /description is required/i,
  );
});

test('buildContextBlock notes when no assets are granted', () => {
  const block = buildContextBlock({ description: 'do a thing' });
  assert.match(block, /No governed assets are granted yet/i);
});
