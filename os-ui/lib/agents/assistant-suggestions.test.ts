/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAgentAssistantReply,
  AGENT_GRANT_KINDS,
} from './assistant-suggestions.ts';

test('normalize keeps the message and an improvedDescription (trimmed)', () => {
  const r = normalizeAgentAssistantReply({ message: '  do this  ', improvedDescription: '  A crisp goal.  ' });
  assert.equal(r.message, 'do this');
  assert.equal(r.suggestions.improvedDescription, 'A crisp goal.');
});

test('suggestedOutputs: validates kind + name, defaults folder', () => {
  const r = normalizeAgentAssistantReply({
    message: 'm',
    suggestedOutputs: [
      { kind: 'files', name: 'Report', folder: { path: '/out', scope: 'domain' } },
      { kind: 'data', name: 'rows' }, // no folder → root/personal
      { kind: 'bogus', name: 'x' }, // bad kind → dropped
      { kind: 'files', name: '' }, // empty name → dropped
    ],
  });
  const outs = r.suggestions.suggestedOutputs!;
  assert.equal(outs.length, 2);
  assert.deepEqual(outs[0], { kind: 'files', name: 'Report', folder: { path: '/out', scope: 'domain' } });
  assert.deepEqual(outs[1], { kind: 'data', name: 'rows', folder: { path: '/', scope: 'personal' } });
});

test('suggestedGrants: drops unknown kinds, empty ids, bad access', () => {
  const r = normalizeAgentAssistantReply({
    message: 'm',
    suggestedGrants: [
      { kind: 'data', id: 'ds_1', access: 'read-write', reason: 'needs rows' },
      { kind: 'metric', id: 'me_1', access: 'nonsense' }, // bad access → undefined
      { kind: 'bogus', id: 'x' }, // unknown kind → dropped
      { kind: 'files', id: '' }, // empty id → dropped
    ],
  });
  const g = r.suggestions.suggestedGrants!;
  assert.equal(g.length, 2);
  assert.deepEqual(g[0], { kind: 'data', id: 'ds_1', access: 'read-write', reason: 'needs rows' });
  assert.equal(g[1].access, undefined, 'bad access coerced to undefined');
});

test('suggestedGrants: kinds outside the allowed set are dropped', () => {
  const r = normalizeAgentAssistantReply(
    { message: 'm', suggestedGrants: [{ kind: 'data', id: 'ds_1' }, { kind: 'operating-manual', id: 'manual:domain' }
] },
    ['data'], // restrict to data only
  );
  const g = r.suggestions.suggestedGrants!;
  assert.equal(g.length, 1);
  assert.equal(g[0].kind, 'data');
});

test('proposedTeam: slugifies + de-dupes ids, drops empty steps', () => {
  const r = normalizeAgentAssistantReply({
    message: 'm',
    proposedTeam: [
      { id: 'Pull Data!!', role: 'Pulls', instruction: 'do it' },
      { role: '', instruction: '' }, // empty → dropped
      { id: 'pull-data', role: 'Also pulls', instruction: 'again' }, // collides → de-duped
    ],
  });
  const team = r.suggestions.proposedTeam!;
  assert.equal(team.length, 2);
  assert.equal(team[0].id, 'pull-data');
  assert.notEqual(team[1].id, team[0].id);
});

test('suggestedInstructions: requires agentId + instruction, de-dupes by agentId', () => {
  const r = normalizeAgentAssistantReply({
    message: 'm',
    suggestedInstructions: [
      { agentId: 'writer', instruction: 'Write the summary.' },
      { agentId: 'writer', instruction: 'dup' }, // dup agentId → dropped
      { agentId: '', instruction: 'no id' }, // no id → dropped
      { agentId: 'checker', instruction: '' }, // no instruction → dropped
    ],
  });
  const ins = r.suggestions.suggestedInstructions!;
  assert.equal(ins.length, 1);
  assert.deepEqual(ins[0], { agentId: 'writer', instruction: 'Write the summary.' });
});

test('a malformed / non-object reply degrades to an empty suggestion set (no throw)', () => {
  const r = normalizeAgentAssistantReply(null);
  assert.equal(r.message, '');
  assert.deepEqual(r.suggestions, {});
  const r2 = normalizeAgentAssistantReply({ message: 'x', suggestedGrants: 'not an array' });
  assert.deepEqual(r2.suggestions, {});
});

test('AGENT_GRANT_KINDS is the default allow-set', () => {
  assert.ok(AGENT_GRANT_KINDS.includes('data'));
  assert.ok(AGENT_GRANT_KINDS.includes('operating-manual'));
});
