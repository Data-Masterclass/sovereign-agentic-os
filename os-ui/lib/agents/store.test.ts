/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetStore,
  createSystem,
  listSystems,
  getSystem,
  listFiles,
  readFile,
  writeFile,
  forkSystem,
  setSchedule,
  toggleAgent,
  WHITELIST_HINT,
} from './store.ts';

const sara = { id: 'sara', domains: ['sales'], role: 'builder' as const };
const amir = { id: 'amir', domains: ['sales'], role: 'participant' as const };
const kenji = { id: 'kenji', domains: ['finance'], role: 'builder' as const };

test('create → appears under Mine; whitelisted files round-trip read=write', () => {
  __resetStore();
  const sys = createSystem(sara, { name: 'My Desk', domain: 'sales' });
  const groups = listSystems(sara);
  assert.ok(groups.mine.some((s) => s.id === sys.id));

  const files = listFiles(sys.id, sara).files;
  assert.ok(files.includes('system.yaml'));
  assert.ok(files.some((f) => /agents\/.+\/AGENT\.md/.test(f)));

  const f = readFile(sys.id, sara, 'system.yaml');
  const next = f.content + '\n# edited\n';
  const saved = writeFile(sys.id, sara, { path: 'system.yaml', content: next, sha: f.sha });
  assert.notEqual(saved.sha, f.sha);
  assert.equal(readFile(sys.id, sara, 'system.yaml').content, next);
});

test('a stale sha is rejected (optimistic concurrency)', () => {
  __resetStore();
  const sys = createSystem(sara, { name: 'D', domain: 'sales' });
  const f = readFile(sys.id, sara, 'system.yaml');
  writeFile(sys.id, sara, { path: 'system.yaml', content: f.content + '\n#a', sha: f.sha });
  assert.throws(
    () => writeFile(sys.id, sara, { path: 'system.yaml', content: f.content + '\n#b', sha: f.sha }),
    /stale|changed/i,
  );
});

test('a non-whitelisted path is refused', () => {
  __resetStore();
  const sys = createSystem(sara, { name: 'D', domain: 'sales' });
  assert.throws(() => readFile(sys.id, sara, '../etc/passwd'), new RegExp(WHITELIST_HINT));
  assert.throws(
    () => writeFile(sys.id, sara, { path: 'secrets.env', content: 'x', sha: '' }),
    new RegExp(WHITELIST_HINT),
  );
});

test('AGENT.md is a projection of the one source (system.yaml)', () => {
  __resetStore();
  const sys = createSystem(sara, { name: 'D', domain: 'sales' });
  const agentFile = listFiles(sys.id, sara).files.find((f) => f.endsWith('/AGENT.md'))!;
  const f = readFile(sys.id, sara, agentFile);
  writeFile(sys.id, sara, { path: agentFile, content: '# New persona\nBe terse.', sha: f.sha });
  // The edit lands in system.yaml, not a separate file — single source.
  const yaml = readFile(sys.id, sara, 'system.yaml').content;
  assert.match(yaml, /Be terse\./);
});

test('grouping: Shared shows in My domain; Marketplace lists installs', () => {
  __resetStore();
  const shared = createSystem(sara, { name: 'Shared Desk', domain: 'sales', visibility: 'Shared' });
  createSystem(kenji, { name: 'Fin Desk', domain: 'finance' });
  // amir (sales) sees sara's Shared system in "My domain", not "Mine".
  const g = listSystems(amir);
  assert.ok(g.domain.some((s) => s.id === shared.id));
  assert.ok(!g.mine.some((s) => s.id === shared.id));
  // kenji (finance) does NOT see the sales Shared system.
  assert.ok(!listSystems(kenji).domain.some((s) => s.id === shared.id));
});

test('fork-to-own creates an independent copy owned by the installer', () => {
  __resetStore();
  const market = createSystem(sara, { name: 'Research Desk', domain: 'sales', visibility: 'Marketplace' });
  const fork = forkSystem(market.id, amir);
  assert.notEqual(fork.id, market.id);
  assert.equal(fork.owner, 'amir');
  assert.equal(fork.visibility, 'Personal');
  assert.equal(fork.origin, 'forked');
  // Editing the fork does not touch the marketplace original.
  const f = readFile(fork.id, amir, 'system.yaml');
  writeFile(fork.id, amir, { path: 'system.yaml', content: f.content + '\n#mine', sha: f.sha });
  assert.notEqual(readFile(market.id, sara, 'system.yaml').content, readFile(fork.id, amir, 'system.yaml').content);
});

test('schedule persists and an agent toggle is recorded', () => {
  __resetStore();
  const sys = createSystem(sara, { name: 'D', domain: 'sales' });
  setSchedule(sys.id, sara, { kind: 'cron', cron: '0 9 * * 1' });
  assert.equal(getSystem(sys.id, sara).schedule?.cron, '0 9 * * 1');
  const entry = getSystem(sys.id, sara).system.agents[0].id;
  toggleAgent(sys.id, sara, entry, false);
  assert.ok(getSystem(sys.id, sara).disabledAgents.includes(entry));
});
