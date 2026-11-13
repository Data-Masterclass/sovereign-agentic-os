/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       mcp
 * FEATURE:    UI/MCP parity for the generic git reads, and their refusals
 * USER STORY: As a maintainer I want proof that `get_history`, `get_version` and `diff_versions`
 *             return EXACTLY what the module the history drawer calls returns — one code path,
 *             not two — and that an object the caller cannot see is `not_found` over MCP too
 *             (checklist G7, G5).
 * ARCHITECTURE:
 *   - Calls the tools' own `call(user, args)` (not the HTTP route — a test may not import one)
 *     and the module side by side against the SAME temp bare repo, and asserts deep equality.
 *   - The kind resolver is registered here the way a tab registers it at boot, so what is under
 *     test is the real registry and the real gate.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CurrentUser } from '@core/kernel/auth';
import { commitTree, commitMessage } from '@core/infra/git-store';
import {
  objectGitInfo,
  getVersion,
  diffVersions,
  registerGitObject,
  __clearGitObjectRegistry,
} from '@core/infra/git-objects';
import { GIT_TOOLS, __setGitToolsReposDirForTests } from '@core/mcp/git-tools';

let reposDir = '';
const shas: Record<string, string> = {};
const amir: CurrentUser = { id: 'amir', name: 'Amir Example', domains: ['sales'], allDomains: ['sales'], activeDomain: 'sales', role: 'creator' };

const tool = (name: string) => {
  const t = GIT_TOOLS.find((x) => x.name === name);
  assert.ok(t, `${name} is not registered`);
  return t!;
};

before(async () => {
  reposDir = mkdtempSync(join(tmpdir(), 'os-git-tools-'));
  __setGitToolsReposDirForTests(reposDir);
  shas.one = (
    await commitTree('sales', new Map([['agents/support/system.yaml', 'name: Support\nversion: 1\n']]), {
      reposDir,
      author: { name: 'Amir Example', email: 'amir@example.com' },
      message: commitMessage({ area: 'agents', domain: 'sales', action: 'create system', object: 'support', objectId: 'sys_1 (Support)', surface: 'ui:agents', requestId: 'r1' }),
      timestamp: 1_700_000_000,
    })
  ).sha;
  shas.two = (
    await commitTree('sales', new Map([['agents/support/system.yaml', 'name: Support\nversion: 2\n']]), {
      reposDir,
      author: { name: 'Amir Example', email: 'amir@example.com' },
      message: commitMessage({ area: 'agents', domain: 'sales', action: 'edit system', object: 'support', objectId: 'sys_1 (Support)', surface: 'mcp:commit_agent_files', requestId: 'r2' }),
      timestamp: 1_700_000_100,
    })
  ).sha;
});
after(() => {
  __setGitToolsReposDirForTests(null);
  __clearGitObjectRegistry();
  rmSync(reposDir, { recursive: true, force: true });
});

beforeEach(() => {
  __clearGitObjectRegistry();
  registerGitObject('agent-system', (_user, id) =>
    id === 'sys_1' ? { domain: 'sales', paths: ['agents/support/'], trailerId: 'sys_1', name: 'Support' } : null,
  );
});

test('G7: get_history over MCP is byte-identical to the module the drawer calls', async () => {
  const viaTool = await tool('get_history').call(amir, { kind: 'agent-system', id: 'sys_1' });
  const viaModule = await objectGitInfo(amir, 'agent-system', 'sys_1', { reposDir });
  assert.deepEqual(viaTool, viaModule);
  assert.equal((viaModule as { head: { sha: string } }).head.sha, shas.two);
});

test('G7: get_version over MCP is byte-identical to the module', async () => {
  const viaTool = await tool('get_version').call(amir, { kind: 'agent-system', id: 'sys_1', sha: shas.one });
  const viaModule = await getVersion(amir, 'agent-system', 'sys_1', shas.one, { reposDir });
  assert.deepEqual(viaTool, viaModule);
  assert.equal((viaModule as { files: { content: string }[] }).files[0].content, 'name: Support\nversion: 1\n');
});

test('G7: diff_versions over MCP is byte-identical to the module', async () => {
  const viaTool = await tool('diff_versions').call(amir, { kind: 'agent-system', id: 'sys_1', shaA: shas.one, shaB: shas.two });
  const viaModule = await diffVersions(amir, 'agent-system', 'sys_1', shas.one, shas.two, { reposDir });
  assert.deepEqual(viaTool, viaModule);
  assert.match((viaModule as { patch: string }).patch, /-version: 1\n\+version: 2/);
});

test('every git tool refuses a bad kind, a missing argument and an object it may not see', async () => {
  for (const name of ['get_history', 'get_version', 'diff_versions']) {
    const t = tool(name);
    const badKind = await t.call(amir, { kind: 'not-a-kind', id: 'sys_1', sha: shas.one, shaA: shas.one, shaB: shas.two }).catch((e) => e);
    assert.equal((badKind as { status: number }).status, 400, `${name}: an unknown kind is a bad_request`);
    const noId = await t.call(amir, { kind: 'agent-system', sha: shas.one, shaA: shas.one, shaB: shas.two }).catch((e) => e);
    assert.equal((noId as { status: number }).status, 400, `${name}: a missing id is a bad_request`);
    const hidden = await t.call(amir, { kind: 'agent-system', id: 'sys_hidden', sha: shas.one, shaA: shas.one, shaB: shas.two }).catch((e) => e);
    assert.equal((hidden as { status: number }).status, 404, `${name}: an object the caller cannot see is not_found`);
    assert.equal((hidden as Error).message, "no agent-system 'sys_hidden'");
  }
});

test('a kind no tab has wired answers the OS not_found a client can act on, naming the gap', async () => {
  const e = await tool('get_history').call(amir, { kind: 'dashboard', id: 'dash_1' }).catch((x) => x);
  assert.equal((e as { status: number }).status, 404, 'a client gets the one refusal every object-addressed tool owes');
  assert.match((e as Error).message, /versioning is not wired for 'dashboard'/, 'and the reason still names the gap');
});

test('get_history caps `limit` rather than trusting it', async () => {
  const capped = (await tool('get_history').call(amir, { kind: 'agent-system', id: 'sys_1', limit: 10_000 })) as { history: unknown[] };
  assert.ok(capped.history.length <= 100);
  const ignored = (await tool('get_history').call(amir, { kind: 'agent-system', id: 'sys_1', limit: -5 })) as { history: unknown[] };
  assert.equal(ignored.history.length, 2, 'a nonsense limit falls back to the default, never to "everything"');
});
