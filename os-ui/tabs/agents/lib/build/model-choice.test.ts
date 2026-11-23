/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Build decides `model: auto` with ONE strong-model call, stores it, and falls back to Strong visibly
 * USER STORY: As a builder I press Build and see which model each Auto agent got and why; the choice is kept in the
 *             definition until the next Build decides again.
 * ARCHITECTURE: the REAL decision code (`decideAutoModels`) and the REAL Build step (`resolveAutoModelsForBuild`)
 *             over the real in-memory store; only the model call is scripted (the same `LlmCall` seam production
 *             fills with the gateway caller).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LlmCall, LlmRequest } from '@core/runtime/agentic';
import { parseSystem } from '@tabs/agents/lib/system-schema';
import { decideAutoModels, parseModelChoice, applyModelDecisions } from '@tabs/agents/lib/build/model-choice';
import { resolveAutoModelsForBuild } from '@tabs/agents/lib/build/model-choice-server';
import { __resetStore, createSystem, writeFile, getSystemForEdit } from '@tabs/agents/lib/store';
import { roleModel } from '@core/models/roles';

const YAML = `
system: { name: Desk, domain: sales, visibility: Personal }
entrypoint: lead
grants:
  tools: [search_knowledge, query_data]
agents:
  - { id: lead, role: decides, agent_md: "# Lead", memory_md: "", model: auto, members: [reader] }
  - { id: reader, role: reads, agent_md: "# Reader", memory_md: "", model: auto, tools: [search_knowledge] }
  - { id: writer, role: writes, agent_md: "# Writer", memory_md: "", model: standard }
edges:
  - { from: lead, to: reader, type: supervise }
`;
const ANSWER = JSON.stringify({ agents: [{ id: 'lead', model: 'strong', reason: 'supervises and decides' }, { id: 'reader', model: 'standard', reason: 'only reads knowledge' }] });

function scripted(reply: string | Error) {
  const calls: LlmRequest[] = [];
  const llm: LlmCall = async (req) => { calls.push(req); if (reply instanceof Error) throw reply; return { content: reply, toolCalls: [] }; };
  return { calls, llm };
}

test('ONE call on the strong model decides every Auto agent; an explicit choice is never asked about', async () => {
  const m = scripted(ANSWER);
  const r = await decideAutoModels(parseSystem(YAML), { llm: m.llm, strongModel: roleModel('reasoning') });
  assert.equal(m.calls.length, 1);
  assert.equal(m.calls[0].model, 'sovereign-strong');
  assert.ok(!String(m.calls[0].messages[1].content).includes('## Agent: writer'), 'writer is set to Standard, not Auto');
  assert.deepEqual(r.decisions.map((d) => [d.id, d.tier, d.fallback]), [['lead', 'strong', false], ['reader', 'standard', false]]);
  assert.deepEqual(r.warnings, []);
});

test('no Auto agent → no call at all', async () => {
  const m = scripted(ANSWER);
  const r = await decideAutoModels(parseSystem(YAML.replaceAll('model: auto', 'model: strong')), { llm: m.llm, strongModel: 's' });
  assert.equal(m.calls.length, 0);
  assert.deepEqual(r.decisions, []);
});

test('FALLBACK: the call fails → every Auto agent is Strong, each with a warning', async () => {
  const r = await decideAutoModels(parseSystem(YAML), { llm: scripted(new Error('gateway down')).llm, strongModel: 's' });
  assert.deepEqual(r.decisions.map((d) => [d.id, d.tier, d.fallback]), [['lead', 'strong', true], ['reader', 'strong', true]]);
  assert.equal(r.warnings.length, 2);
  assert.match(r.warnings[0], /gateway down.*runs on Strong/);
});

test('FALLBACK: an unreadable answer, or one that skips an agent, gives Strong for that agent only', async () => {
  const garbage = await decideAutoModels(parseSystem(YAML), { llm: scripted('I think strong').llm, strongModel: 's' });
  assert.ok(garbage.decisions.every((d) => d.tier === 'strong' && d.fallback));
  const partial = await decideAutoModels(parseSystem(YAML), { llm: scripted(JSON.stringify({ agents: [{ id: 'reader', model: 'standard', reason: 'reads' }] })).llm, strongModel: 's' });
  assert.deepEqual(partial.decisions.map((d) => [d.id, d.tier, d.fallback]), [['lead', 'strong', true], ['reader', 'standard', false]]);
  assert.equal(partial.warnings.length, 1);
});

test('parseModelChoice ignores unknown agents and invalid models (twin)', () => {
  const m = parseModelChoice('```json\n{"agents":[{"id":"x","model":"standard"},{"id":"reader","model":"huge"},{"id":"lead","model":"Standard","reason":"r"}]}\n```', ['lead', 'reader']);
  assert.deepEqual([...m!.entries()], [['lead', { tier: 'standard', reason: 'r' }]]);
});

test('applyModelDecisions writes only agents still on Auto', () => {
  const sys = applyModelDecisions(parseSystem(YAML), [{ id: 'reader', tier: 'standard', reason: 'reads', fallback: false }, { id: 'writer', tier: 'strong', reason: 'x', fallback: false }]);
  assert.equal(sys.agents.find((a) => a.id === 'reader')!.model_resolved, 'standard');
  assert.equal(sys.agents.find((a) => a.id === 'writer')!.model_resolved, undefined);
});

// ------------------------------------------------------------------ the Build step, persisted in the real store

const owner = { id: 'olga', name: 'Olga', domains: ['sales'], role: 'builder' as const };

function storedSystem() {
  __resetStore();
  const rec = createSystem(owner, { name: 'Desk', domain: 'sales' });
  writeFile(rec.id, owner, { path: 'system.yaml', content: YAML, sha: '' });
  return rec.id;
}

test('PERSISTED: Build stores model_resolved + model_reason in the definition, and reports a models row', async () => {
  const id = storedSystem();
  const out = await resolveAutoModelsForBuild({ systemId: id, user: owner, yaml: getSystemForEdit(id, owner).yaml }, { llm: scripted(ANSWER).llm });
  const stored = parseSystem(getSystemForEdit(id, owner).yaml);
  const reader = stored.agents.find((a) => a.id === 'reader')!;
  assert.deepEqual([reader.model, reader.model_resolved, reader.model_reason], ['auto', 'standard', 'only reads knowledge']);
  assert.equal(out.yaml, getSystemForEdit(id, owner).yaml, 'the Build builds what was stored');
  assert.equal(out.row?.tool, 'models');
  assert.match(out.row!.detail, /reader → Standard \(only reads knowledge\)/);
});

test('PERSISTED: a rebuild decides again (the stored choice changes when the answer does)', async () => {
  const id = storedSystem();
  await resolveAutoModelsForBuild({ systemId: id, user: owner, yaml: getSystemForEdit(id, owner).yaml }, { llm: scripted(ANSWER).llm });
  const flipped = JSON.stringify({ agents: [{ id: 'lead', model: 'strong', reason: 'decides' }, { id: 'reader', model: 'strong', reason: 'now judges sources' }] });
  const m = scripted(flipped);
  await resolveAutoModelsForBuild({ systemId: id, user: owner, yaml: getSystemForEdit(id, owner).yaml }, { llm: m.llm });
  assert.equal(m.calls.length, 1, 'asked again');
  assert.equal(parseSystem(getSystemForEdit(id, owner).yaml).agents.find((a) => a.id === 'reader')!.model_resolved, 'strong');
});

test('PERSISTED FALLBACK: a failed call stores Strong and the models row carries the warning', async () => {
  const id = storedSystem();
  const out = await resolveAutoModelsForBuild({ systemId: id, user: owner, yaml: getSystemForEdit(id, owner).yaml }, { llm: scripted(new Error('timeout')).llm });
  assert.ok(parseSystem(getSystemForEdit(id, owner).yaml).agents.filter((a) => a.model === 'auto').every((a) => a.model_resolved === 'strong'));
  assert.match(out.row!.detail, /Warning: .*timeout/);
});

test('TWIN: a system with no Auto agent is not touched and gets no models row', async () => {
  __resetStore();
  const rec = createSystem(owner, { name: 'Plain', domain: 'sales' });
  writeFile(rec.id, owner, { path: 'system.yaml', content: YAML.replaceAll('model: auto', 'model: strong'), sha: '' });
  const before = getSystemForEdit(rec.id, owner).yaml;
  const m = scripted(ANSWER);
  const out = await resolveAutoModelsForBuild({ systemId: rec.id, user: owner, yaml: before }, { llm: m.llm });
  assert.equal(m.calls.length, 0);
  assert.equal(out.row, null);
  assert.equal(getSystemForEdit(rec.id, owner).yaml, before);
});
