/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSystem } from './system-schema.ts';
import { compile } from './langgraph-compile.ts';
import { applyInstruction } from './assistant.ts';

const BASE = `
system: { name: Desk, domain: sales, visibility: Personal }
entrypoint: supervisor
grants: { tools: [search_knowledge, upload_file] }
agents:
  - { id: supervisor, role: router, agent_md: "# Sup", memory_md: "", members: [writer] }
  - { id: writer, role: writes, agent_md: "# Writer", memory_md: "", tools: [upload_file] }
edges:
  - { from: supervisor, to: writer, type: supervise }
`;

test('"add a research sub-agent that hands off to the writer" mutates the one source', () => {
  const before = parseSystem(BASE);
  const { system, summary } = applyInstruction(before, 'add a research sub-agent that hands off to the writer');

  // A new agent was added under the supervisor...
  const researcher = system.agents.find((a) => /research/i.test(a.id));
  assert.ok(researcher, 'a researcher agent exists');
  assert.ok(system.agents.find((a) => a.id === 'supervisor')!.members!.includes(researcher!.id));
  // ...with a handoff edge to the writer.
  assert.ok(
    system.edges.some((e) => e.from === researcher!.id && e.to === 'writer' && e.type === 'handoff'),
  );
  // It still compiles (identical to the manual path).
  assert.doesNotThrow(() => compile(system));
  assert.match(summary, /research/i);
});

test('the helper never grants a tool the system lacks (narrow-only safe)', () => {
  const before = parseSystem(BASE);
  const { system } = applyInstruction(before, 'add a researcher sub-agent that hands off to the writer');
  const researcher = system.agents.find((a) => /research/i.test(a.id))!;
  // Its tools must be ⊆ system grants, so compile stays clean.
  for (const t of researcher.tools ?? []) assert.ok(before.grants.tools.includes(t));
  assert.doesNotThrow(() => compile(system));
});

test('a handoff is only reported as wired when the target agent actually exists', () => {
  // Finding #5 — applyInstruction must not claim a handoff was wired when the
  // target does not exist (no edge was added).
  const before = parseSystem(BASE);
  const { system, summary } = applyInstruction(before, 'add a research sub-agent that hands off to the ghost');
  const researcher = system.agents.find((a) => /research/i.test(a.id))!;
  // No edge to a non-existent 'ghost' was added...
  assert.ok(!system.edges.some((e) => e.from === researcher.id && e.to === 'ghost'));
  // ...and the summary must NOT falsely claim it hands off to 'ghost'.
  assert.doesNotMatch(summary, /hands off to 'ghost'/);
  // A real target is still wired and reported.
  const ok = applyInstruction(before, 'add a research sub-agent that hands off to the writer');
  const r2 = ok.system.agents.find((a) => /research/i.test(a.id))!;
  assert.ok(ok.system.edges.some((e) => e.from === r2.id && e.to === 'writer' && e.type === 'handoff'));
  assert.match(ok.summary, /hands off to 'writer'/);
});

test('an unrecognised instruction is reported, not silently ignored', () => {
  const before = parseSystem(BASE);
  assert.throws(() => applyInstruction(before, 'make me a sandwich'), /could not turn that into a system edit/i);
});
