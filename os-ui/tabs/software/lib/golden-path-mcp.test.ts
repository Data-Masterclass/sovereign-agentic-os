/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    Software Factory - the MCP doors an external coding tool (Claude Code) uses
 * USER STORY: As an engineer working from Claude Code I want to fetch the template and its rules, run
 *             the OS's gates on my pushed code, and only then ask for a deploy.
 * ARCHITECTURE: Drives `callPlatformMcp` as real principals: the template door, the gates door (sandbox
 *             injected), the refusal for a non-factory app, and the role gate on running tests.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config as cfg } from '@core/kernel/config';
import type { CurrentUser } from '@core/kernel/auth';
import { callPlatformMcp, PLATFORM_MCP_TOOLS } from './platform-mcp.ts';
import { createApp } from '@tabs/software/lib/apps';
import { runAppTests } from './review.ts';
import { REQUIRED_GATES, type GatesOutcome } from './gates.ts';

let reposDir = '';
let prior = '';
before(() => {
  reposDir = mkdtempSync(join(tmpdir(), 'os-repos-t-'));
  prior = cfg.reposDir;
  (cfg as { reposDir: string }).reposDir = reposDir;
});
after(() => {
  (cfg as { reposDir: string }).reposDir = prior;
  rmSync(reposDir, { recursive: true, force: true });
});

const alice: CurrentUser = { id: 'alice', name: 'Alice', domains: ['sales'], role: 'creator' };
const mallory: CurrentUser = { id: 'mallory', name: 'Mallory', domains: ['hr'], role: 'creator' };
const pass: GatesOutcome = { ok: true, report: { schema: 'os-gates/v1', template: 'nextjs-web', ok: true, gates: REQUIRED_GATES.map((id) => ({ id, status: 'pass', detail: '' })) } };

test('both factory tools are registered: the template read is read-only, the gates run is a governed action', () => {
  assert.equal(PLATFORM_MCP_TOOLS.find((t) => t.name === 'get_app_template')?.write, false);
  assert.equal(PLATFORM_MCP_TOOLS.find((t) => t.name === 'verify_app_gates')?.write, true);
});

test('get_app_template lists templates, then returns rules, policy, platform-owned paths and files', async () => {
  const list = (await callPlatformMcp(alice, 'get_app_template', {})) as { templates: { key: string }[] };
  assert.deepEqual(list.templates.map((t) => t.key), ['nextjs-web']);
  const t = (await callPlatformMcp(alice, 'get_app_template', { template: 'nextjs-web' })) as {
    rules: { agents: string; claude: string; policy: string };
    platformOwned: string[];
    requiredGates: string[];
    files: { path: string }[];
  };
  assert.match(t.rules.agents, /Identity and authorization/);
  assert.ok(t.rules.claude.startsWith('@AGENTS.md'));
  assert.match(t.rules.policy, /package factory/);
  assert.ok(t.platformOwned.includes('Dockerfile') && t.platformOwned.includes('k8s/'));
  assert.ok(t.requiredGates.includes('tests') && t.requiredGates.some((g) => /scan/.test(g)));
  assert.ok(t.files.some((f) => f.path === 'AGENTS.md') && !t.files.some((f) => f.path.startsWith('vendor/')));
});

test('get_app_template refuses an unknown template with 404', async () => {
  await assert.rejects(callPlatformMcp(alice, 'get_app_template', { template: 'nextjs-supabase' }), (e: Error & { status?: number }) => e.status === 404);
});

test('runAppTests returns the per-gate verdict for the owner, on the committed tree', async () => {
  const app = await createApp(alice, { name: 'Tests Desk', template: 'nextjs-web' });
  const r = await runAppTests(app.id, alice, { gates: async () => pass });
  assert.equal(r.verdict.passed, true);
  assert.equal(r.template, 'nextjs-web');
});

test('runAppTests reports a failing gate and is invisible to another domain (not_found)', async () => {
  const app = await createApp(alice, { name: 'Tests Desk 2', template: 'nextjs-web' });
  const failing: GatesOutcome = { ok: true, report: { ...(pass as { report: never }).report, gates: [{ id: 'tests', status: 'fail', detail: '2 failed' }] } as never };
  const r = await runAppTests(app.id, alice, { gates: async () => failing });
  assert.equal(r.verdict.passed, false);
  assert.ok(r.verdict.blocking.some((b) => b.id === 'tests'));
  await assert.rejects(runAppTests(app.id, mallory, { gates: async () => pass }), (e: Error & { status?: number }) => e.status === 404);
});

test('runAppTests refuses an app the OS serves itself, which has no container to gate (409)', async () => {
  const app = await createApp(alice, { name: 'Plain Desk', template: 'nextjs-supabase', kind: 'spec' } as never);
  await assert.rejects(runAppTests(app.id, alice, { gates: async () => pass }), (e: Error & { status?: number }) => e.status === 409);
});

test('GIT-NATIVE: create_software with the template writes it into apps/<slug>/ as a commit by the creator', async () => {
  const { readAppTreeState } = await import('./git-commit.ts');
  const app = (await callPlatformMcp(alice, 'create_software', { name: 'Git Desk', template: 'nextjs-web', kind: 'code' })) as { id: string; slug: string; domain: string };
  const state = await readAppTreeState(app);
  assert.equal(state.kind, 'tree', 'the scaffold is in git right after create, not only in the cache');
  if (state.kind !== 'tree') return;
  assert.match(state.sha, /^[0-9a-f]{40}$/);
  const paths = state.files.map((f) => f.path);
  for (const p of ['AGENTS.md', 'CLAUDE.md', 'README.md', 'package.json', 'Dockerfile', 'k8s/deployment.yaml', 'src/lib/os/index.ts']) assert.ok(paths.includes(p), `missing ${p}`);
});
