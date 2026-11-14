/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    `system.yaml` pushed by an engineer → the agent system in the registry, and THE COIN
 * USER STORY: As the owner I want proof that a `git push` of `system.yaml` leaves the OS in exactly
 *             the state the builder's Save would have left it in — the same bytes in the repo and
 *             the same commit, differing only in `OS-Surface` (checklist E5, E8, E9, X8's agent half).
 * ARCHITECTURE:
 *   - The real store + the real commit hook with a spy committer (the pattern
 *     `tabs/agents/lib/git/commit.test.ts` established), so "the same state" is compared on the
 *     bytes a commit would carry, not on an internal field.
 *   - `agents/index.yml` is read from a REAL temp-dir bare repo, because resolving a directory to a
 *     frozen system id is the one thing this ingest must not guess.
 */
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '@tabs/agents/lib/store';
import type { Principal } from '@tabs/agents/lib/store';
import { __resetSystemListeners } from '@tabs/agents/lib/system-events';
import { runWithSurface } from '@core/infra/request-surface';
import { commitTree, openOrInit, parseTrailers, type CommitTreeOptions } from '@core/infra/git-store';
import { personalAgentLane, registeredRepoKinds, __clearRepoKinds, type ChangedFile, type Pusher } from '@core/infra/git-receive';
import { parseSystem, serializeSystem } from '@tabs/agents/lib/system-schema';
import { ownerToken } from '@tabs/agents/lib/git/generate';
import { installAgentProjectCommitHook, awaitAgentProjectCommits, __setAgentProjectGitForTests } from '@tabs/agents/lib/git/commit';
import {
  AGENT_SYSTEM_KIND,
  ingestAgentSystems,
  matchesAgentSystem,
  registerAgentSystemIngest,
  systemIdsByDir,
  validateSystemYaml,
} from '@tabs/agents/lib/git/ingest';

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'creator' };
const pusher: Pusher = { id: 'amir', name: 'Amir', email: 'amir@acme.com', role: 'creator', domains: ['sales'] };

type Calls = { domain: string; prefix: string; files: Map<string, string>; message: string; opts: CommitTreeOptions }[];
let calls: Calls = [];
let uninstall: (() => void) | null = null;
let reposDir = '';

before(async () => {
  reposDir = mkdtempSync(join(tmpdir(), 'os-agents-ingest-'));
  await openOrInit('sales', { reposDir });
});
after(() => rmSync(reposDir, { recursive: true, force: true }));

beforeEach(() => {
  store.__resetStore();
  __resetSystemListeners();
  __clearRepoKinds();
  calls = [];
  uninstall = installAgentProjectCommitHook({
    committer: async (domain, prefix, files, opts) => {
      calls.push({ domain, prefix, files, message: opts.message, opts });
      return { sha: 'f'.repeat(40), changed: true };
    },
  });
});
afterEach(() => {
  uninstall?.();
  uninstall = null;
  __setAgentProjectGitForTests(null);
});

/** Put an `agents/index.yml` into the real repo mapping `dir` → `systemId`. */
async function writeIndex(entries: { dir: string; id: string }[]): Promise<string> {
  const lines = ['version: 1', 'domain: sales', 'systems:'];
  for (const e of entries) {
    lines.push(`  - slug: ${e.dir.split('/').pop()}`);
    lines.push(`    id: ${e.id}`);
    lines.push(`    path: ${e.dir}`);
  }
  const r = await commitTree('sales', new Map([['agents/index.yml', `${lines.join('\n')}\n`]]), {
    reposDir,
    author: { name: 'Sovereign OS', email: 'os@sovereign.local' },
    message: 'agents(sales): index — via boot:reconcile',
  });
  return r.sha;
}

function changed(path: string, content: string): ChangedFile {
  return { path, status: 'modified', content };
}

// ----------------------------------------------------------------------- the contract ---

test('the kind matches only system.yaml, in the domain lane and the personal lane', () => {
  assert.equal(matchesAgentSystem('agents/triage/system.yaml'), true);
  assert.equal(matchesAgentSystem('agents/personal/abc123/triage/system.yaml'), true);
  assert.equal(matchesAgentSystem('agents/triage/AGENT.md'), false);
  assert.equal(matchesAgentSystem('agents/index.yml'), false);
  assert.equal(matchesAgentSystem('models/gold/schema.yml'), false);
});

test('registerAgentSystemIngest publishes exactly one kind to the gate', () => {
  registerAgentSystemIngest();
  assert.deepEqual(registeredRepoKinds().map((k) => k.kind), [AGENT_SYSTEM_KIND]);
});

test('the validator IS parseSystem — the same function the builder Save calls (E5)', () => {
  const id = store.createSystem(amir, { name: 'Triage' }).id;
  const good = store.getSystem(id, amir);
  assert.equal(validateSystemYaml({ path: 'agents/triage/system.yaml', content: good.yaml }), null);

  const bad = 'version: 1\nsystem:\n  name: [oops\n';
  let viaParseSystem = '';
  try {
    parseSystem(bad);
  } catch (e) {
    viaParseSystem = e instanceof Error ? e.message : String(e);
  }
  assert.notEqual(viaParseSystem, '');
  assert.equal(validateSystemYaml({ path: 'agents/triage/system.yaml', content: bad }), viaParseSystem);
});

test('`agents/personal/<token>/` agrees with the generator — the restated convention has not drifted', () => {
  assert.equal(personalAgentLane('amir'), `agents/personal/${ownerToken('amir')}/`);
  assert.equal(personalAgentLane('amir@acme.com'), `agents/personal/${ownerToken('amir@acme.com')}/`);
});

test('the index maps a directory to a frozen id, and an unreadable index maps nothing', () => {
  const yml = 'version: 1\nsystems:\n  - slug: triage\n    id: sys_1\n    path: agents/triage\n';
  assert.deepEqual([...systemIdsByDir(yml)], [['agents/triage', 'sys_1']]);
  assert.deepEqual([...systemIdsByDir('version: 1\nsystems: []\n')], []);
  assert.deepEqual([...systemIdsByDir(': not yaml : [')], []);
  assert.deepEqual([...systemIdsByDir('')], []);
});

// -------------------------------------------------------------------------- the ingest ---

test('a pushed system.yaml for a KNOWN directory updates that system and versions it (E9)', async () => {
  const id = store.createSystem(amir, { name: 'Triage' }).id;
  const sha = await writeIndex([{ dir: 'agents/triage', id }]);
  const before = store.listSystemVersions(id, amir).length;

  const sys = parseSystem(store.getSystem(id, amir).yaml);
  sys.system.description = 'edited in VS Code';
  const pushed = serializeSystem(sys);

  const report = await ingestAgentSystems(
    { domain: 'sales', files: [changed('agents/triage/system.yaml', pushed)], pusher, sha },
    { reposDir },
  );
  assert.deepEqual({ ...report, notes: report.notes }, { kind: 'agent-system', created: 0, updated: 1, skipped: 0, notes: [] });
  assert.equal(store.getSystem(id, amir).yaml, pushed);
  assert.equal(store.listSystemVersions(id, amir).length, before + 1);
});

test('a pushed system.yaml for an UNKNOWN directory creates the system — Personal, owned by the pusher', async () => {
  const seedId = store.createSystem(amir, { name: 'Seed' }).id;
  const yaml = store.getSystem(seedId, amir).yaml;
  store.__resetStore();
  const sha = await writeIndex([]);

  const report = await ingestAgentSystems(
    { domain: 'sales', files: [changed('agents/new-team/system.yaml', yaml)], pusher, sha },
    { reposDir },
  );
  assert.equal(report.created, 1);
  assert.equal(report.updated, 0);
  const mine = store.listSystems(amir).mine;
  assert.equal(mine.length, 1);
  // A push can never publish to a domain audience: audience is a governed promotion.
  assert.equal(store.__recordFor(mine[0].id)?.visibility, 'Personal');
  assert.equal(store.__recordFor(mine[0].id)?.owner, 'amir');
  assert.equal(store.__recordFor(mine[0].id)?.domain, 'sales');
});

test('REMOVING the file does not delete the system — it is reported, not acted on', async () => {
  const id = store.createSystem(amir, { name: 'Triage' }).id;
  const sha = await writeIndex([{ dir: 'agents/triage', id }]);
  const report = await ingestAgentSystems(
    { domain: 'sales', files: [{ path: 'agents/triage/system.yaml', status: 'deleted', content: null }], pusher, sha },
    { reposDir },
  );
  assert.equal(report.skipped, 1);
  assert.match(report.notes.join(' '), /retire the system in the OS to delete it/);
  assert.equal(store.getSystem(id, amir).id, id);
});

test('a file the STORE refuses (a grant above the pusher\'s role) is SKIPPED with the reason', async () => {
  const id = store.createSystem(amir, { name: 'Triage' }).id;
  const sha = await writeIndex([{ dir: 'agents/triage', id }]);
  // A direct-write grant is builder-only, enforced at the store's ONE save chokepoint. A push by
  // a creator must hit exactly that guard — the gate is not a way round a role.
  const sys = parseSystem(store.getSystem(id, amir).yaml);
  sys.grants.data = [{ id: 'ds_1', capability: 'Write-bounded' }];
  const report = await ingestAgentSystems(
    { domain: 'sales', files: [changed('agents/triage/system.yaml', serializeSystem(sys))], pusher, sha },
    { reposDir },
  );
  assert.equal(report.updated, 0);
  assert.equal(report.skipped, 1);
  assert.match(report.notes.join(' '), /agents\/triage\/system\.yaml/);
});

test('AUDIENCE IS NOT PUSHABLE: a pushed visibility or domain that disagrees is REFUSED', async () => {
  const id = store.createSystem(amir, { name: 'Triage' }).id;
  const sha = await writeIndex([{ dir: 'agents/triage', id }]);
  const before = store.getSystem(id, amir).yaml;

  const promoted = parseSystem(before);
  promoted.system.visibility = 'Shared';
  const a = await ingestAgentSystems(
    { domain: 'sales', files: [changed('agents/triage/system.yaml', serializeSystem(promoted))], pusher, sha },
    { reposDir },
  );
  assert.equal(a.updated, 0);
  assert.equal(a.skipped, 1);
  assert.match(a.notes.join(' '), /audience is managed by the OS; use promotion/);

  const moved = parseSystem(before);
  moved.system.domain = 'finance';
  const b = await ingestAgentSystems(
    { domain: 'sales', files: [changed('agents/triage/system.yaml', serializeSystem(moved))], pusher, sha },
    { reposDir },
  );
  assert.equal(b.skipped, 1);
  assert.match(b.notes.join(' '), /audience is managed by the OS; use promotion/);

  // Neither attempt changed anything, and the audience is still what the OS says.
  assert.equal(store.getSystem(id, amir).yaml, before);
  assert.equal(store.__recordFor(id)?.visibility, 'Personal');
  assert.equal(store.__recordFor(id)?.domain, 'sales');
});

// ------------------------------------------------------------------------------ the coin ---

test('THE COIN: the same system.yaml over the MCP and by a push leaves identical files, differing only in OS-Surface', async () => {
  // --- side A: the MCP / UI door -------------------------------------------------------
  const idA = store.createSystem(amir, { name: 'Triage' }).id;
  const sys = parseSystem(store.getSystem(idA, amir).yaml);
  sys.system.description = 'the one change';
  const content = serializeSystem(sys);
  await awaitAgentProjectCommits(); // drain the create's own commit before we count
  calls = [];
  runWithSurface('mcp:commit_agent_files', () => {
    store.writeFile(idA, amir, { path: 'system.yaml', content, sha: '' });
  });
  await awaitAgentProjectCommits();
  assert.equal(calls.length, 1, 'the MCP door must produce exactly one commit');
  const mcp = calls[0];

  // --- side B: the push door -----------------------------------------------------------
  // NB: the store is reset but the LISTENERS are not — resetting them would uninstall the commit
  // hook this test is measuring.
  store.__resetStore();
  const idB = store.createSystem(amir, { name: 'Triage' }).id;
  const sha = await writeIndex([{ dir: 'agents/triage', id: idB }]);
  await awaitAgentProjectCommits();
  calls = [];
  await ingestAgentSystems({ domain: 'sales', files: [changed('agents/triage/system.yaml', content)], pusher, sha }, { reposDir });
  await awaitAgentProjectCommits();
  assert.equal(calls.length, 1, 'the push door must produce exactly one commit');
  const push = calls[0];

  // The FILES are byte-identical (ids differ between the two runs, so compare the file the
  // engineer actually wrote plus the shape of the tree).
  assert.deepEqual([...push.files.keys()].sort(), [...mcp.files.keys()].sort());
  const yamlPath = [...mcp.files.keys()].find((k) => k.endsWith('/system.yaml'))!;
  assert.equal(push.files.get(yamlPath), mcp.files.get(yamlPath));
  assert.equal(mcp.files.get(yamlPath), content);
  assert.equal(push.domain, mcp.domain);
  assert.equal(push.prefix, mcp.prefix);

  // The COMMIT is identical except its surface: same author, same action, same object shape.
  const tM = parseTrailers(mcp.message);
  const tP = parseTrailers(push.message);
  assert.equal(tM['OS-Surface'], 'mcp:commit_agent_files');
  assert.equal(tP['OS-Surface'], 'git:push');
  assert.equal(tP['OS-Action'], tM['OS-Action']);
  assert.deepEqual(
    { ...tP, 'OS-Surface': '', 'OS-Request-Id': '', 'OS-Object': '' },
    { ...tM, 'OS-Surface': '', 'OS-Request-Id': '', 'OS-Object': '' },
  );
  assert.equal(push.opts.author?.email, mcp.opts.author?.email);
  // The WHOLE message, byte for byte, once the surface (twice: subject + trailer), the request id
  // and the system id are normalised. This is the coin: nothing else differs.
  assert.equal(
    push.message.replaceAll('git:push', 'X').replaceAll(tP['OS-Request-Id'], 'R').replaceAll(idB, 'ID'),
    mcp.message.replaceAll('mcp:commit_agent_files', 'X').replaceAll(tM['OS-Request-Id'], 'R').replaceAll(idA, 'ID'),
  );
});
