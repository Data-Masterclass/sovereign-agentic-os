/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    WP-53 receive gate (contract C5): generated agent code is refused on push; a pushed
 *             prompt is taken into the definition and the module is regenerated from it
 * USER STORY: As an AI engineer I want to edit an agent's prompt in VS Code and push it, and see the
 *             OS take it; and as the owner I want a push that edits graph.mjs, run.mjs or the npm
 *             files refused at the door with a sentence that says where to make the change.
 * ARCHITECTURE:
 *   - `decidePath` (the pure gate) is enumerated for every generated file in both lanes.
 *   - The prompt ingest runs against the REAL store and a real temp-dir repo holding
 *     `agents/index.yml`; the regenerated module is checked with the generator itself.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '@tabs/agents/lib/store';
import type { Principal } from '@tabs/agents/lib/store';
import { __resetSystemListeners } from '@tabs/agents/lib/system-events';
import { commitTree, openOrInit } from '@core/infra/git-store';
import { decidePath, GENERATED_AGENT_CODE, personalAgentLane, type Pusher } from '@core/infra/git-receive';
import { parseSystem } from '@tabs/agents/lib/system-schema';
import { ingestAgentSystems, matchesAgentPrompt } from '@tabs/agents/lib/git/ingest';
import { generateAgentModule } from '@tabs/agents/lib/module/generate';
import { hostModuleInputs } from '@tabs/agents/lib/module/versions';

const builder: Pusher = { id: 'bea', name: 'Bea', email: 'bea@acme.com', role: 'builder', domains: ['sales'] };
const amirP: Pusher = { id: 'amir', name: 'Amir', email: 'amir@acme.com', role: 'creator', domains: ['sales'] };
const amir: Principal = { id: 'amir', domains: ['sales'], role: 'creator' };

let reposDir = '';
before(async () => {
  reposDir = mkdtempSync(join(tmpdir(), 'wp53-receive-'));
  await openOrInit('sales', { reposDir });
});
after(() => rmSync(reposDir, { recursive: true, force: true }));
beforeEach(() => {
  store.__resetStore();
  __resetSystemListeners();
});

test('a push to graph.mjs, run.mjs, package.json or package-lock.json is refused — shared and personal lane alike', () => {
  const lane = personalAgentLane('amir');
  for (const f of ['graph.mjs', 'run.mjs', 'package.json', 'package-lock.json']) {
    for (const [p, who] of [[`agents/revenue-review/${f}`, builder], [`${lane}triage/${f}`, amirP]] as const) {
      const v = decidePath(p, who);
      assert.equal(v.allowed, false, p);
      assert.match((v as { reason: string }).reason, new RegExp(GENERATED_AGENT_CODE.slice(0, 30)));
    }
  }
  // Prompts stay pushable (by the same rules as any other path).
  assert.equal(decidePath('agents/revenue-review/prompts/lead.md', builder).allowed, true);
  assert.equal(decidePath(`${lane}triage/prompts/triage.md`, amirP).allowed, true);
  // Outside agents/ the file names mean nothing special.
  assert.equal(decidePath('apps/shop/package.json', builder).allowed, true);
});

test('a pushed prompt is written into the definition, and the regenerated module carries it', async () => {
  const id = store.createSystem(amir, { name: 'Triage' }).id;
  const before = parseSystem(store.getSystem(id, amir).yaml);
  const agentId = before.agents[0].id;
  const dir = `${personalAgentLane('amir')}triage`;
  const { sha } = await commitTree('sales', new Map([['agents/index.yml', `version: 1\ndomain: sales\nsystems:\n  - slug: triage\n    id: ${id}\n    path: ${dir}\n`]]), {
    reposDir, author: { name: 'Sovereign OS', email: 'os@sovereign.local' }, message: 'index',
  });
  const prompt = `${dir}/prompts/${agentId}.md`;
  const memory = `${dir}/prompts/${agentId}.memory.md`;
  assert.equal(matchesAgentPrompt(prompt), true);
  assert.equal(matchesAgentPrompt(memory), true);
  assert.equal(matchesAgentPrompt(`${dir}/prompts/../graph.md`), false);
  const report = await ingestAgentSystems({
    domain: 'sales',
    sha,
    pusher: amirP,
    files: [
      { path: prompt, status: 'modified', content: '# Triage\nClassify the ticket, then stop.\n' },
      { path: memory, status: 'modified', content: '# Memory\nTickets in German are common.\n' },
    ],
  }, { reposDir });
  assert.equal(report.updated, 2, JSON.stringify(report.notes));
  const after = parseSystem(store.getSystem(id, amir).yaml);
  assert.equal(after.agents[0].agent_md, '# Triage\nClassify the ticket, then stop.');
  assert.equal(after.agents[0].memory_md, '# Memory\nTickets in German are common.');
  // Topology untouched.
  assert.deepEqual(after.agents.map((a) => a.id), before.agents.map((a) => a.id));
  assert.deepEqual(after.edges, before.edges);
  // The module the OS now generates holds the pushed text, so the hash check accepts it.
  const m = generateAgentModule({ id, slug: 'triage', sys: after, ...hostModuleInputs() });
  assert.equal(m.files.get(`prompts/${agentId}.md`), '# Triage\nClassify the ticket, then stop.\n');
  assert.equal(m.files.get(`prompts/${agentId}.memory.md`), '# Memory\nTickets in German are common.\n');

  // A prompt for an agent that is not in the system is skipped with a reason, nothing changes.
  const r2 = await ingestAgentSystems({ domain: 'sales', sha, pusher: amirP, files: [{ path: `${dir}/prompts/ghost.md`, status: 'added', content: 'x' }] }, { reposDir });
  assert.equal(r2.updated, 0);
  assert.match(r2.notes.join(' '), /agent 'ghost' is not in this system/);
});
