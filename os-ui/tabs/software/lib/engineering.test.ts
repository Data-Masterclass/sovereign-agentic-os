/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    `engineeringView('app', id)` — the Software tab's Under-the-hood adapter (D25)
 * USER STORY: As an engineer I want the real git facts, the engineer's own command, and an HONEST
 *             statement of what the OS does not do — in the tools' vocabulary, not the OS's.
 * ARCHITECTURE: Pure unit test over `appEngineeringView` — no repo, no cluster.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appEngineeringView, type AppEngineeringInput } from './engineering.ts';

const base: AppEngineeringInput = {
  id: 'app_1',
  slug: 'invoices',
  name: 'Invoices',
  domain: 'eng',
  serveMode: 'spec',
  files: ['app.yaml', 'src/App.tsx'],
  history: [{ sha: 'a'.repeat(40), subject: 'software(eng): push_app_files invoices — via mcp:push_app_files', author: { name: 'Amir', email: 'amir@os.local' }, timestamp: 1_000 }],
  releases: [{ name: 'app/invoices/v1.0.0', commit: 'a'.repeat(40), timestamp: 900 }],
  mcpPrincipal: 'app-invoices',
  gitEnabled: true,
};

test('the view is MCP-serialisable: structured clone round-trips it unchanged', () => {
  const view = appEngineeringView(base);
  assert.deepEqual(JSON.parse(JSON.stringify(view)), view, 'no functions, no classes, no cycles');
});

test('the git tab shows the REAL repository, path, head and author — with the engineer’s command', () => {
  const git = appEngineeringView(base).tools.find((t) => t.tool === 'git')!;
  const fact = (label: string) => git.facts.find((f) => f.label === label)?.value;
  assert.equal(fact('repository'), '/repos/eng.git');
  assert.equal(fact('tree path'), 'apps/invoices/');
  assert.equal(fact('head commit'), 'a'.repeat(40));
  assert.equal(fact('head author'), 'Amir <amir@os.local>');
  assert.equal(fact('tracked files'), '2');
  assert.ok(git.commands.some((c) => c === 'git --git-dir=/repos/eng.git log --oneline -- apps/invoices/'));
  assert.ok(git.commands.some((c) => c.startsWith('git clone https://<os>/git/eng.git')));
  // A link that cannot resolve is ABSENT with a reason — never a dead URL.
  assert.equal(git.link, null);
  assert.match(String(git.linkUnavailableReason), /clone it instead/);
});

test('releases are annotated tags, in the tool’s own vocabulary', () => {
  const rel = appEngineeringView(base).tools.find((t) => t.tool === 'git (annotated tags)')!;
  assert.deepEqual(rel.facts, [{ label: 'app/invoices/v1.0.0', value: 'a'.repeat(12) }]);
  assert.ok(rel.commands[0].includes("tag --list 'app/invoices/v*'"));
  const none = appEngineeringView({ ...base, releases: [] }).tools.find((t) => t.tool === 'git (annotated tags)')!;
  assert.deepEqual(none.facts, [{ label: 'releases', value: '(none — this app has no release tag yet)' }]);
});

test('the serving tab tells the truth per serve mode, and only links where something is served', () => {
  const spec = appEngineeringView(base).tools.find((t) => t.tool === 'Kubernetes')!;
  assert.deepEqual(spec.link, { url: '/apps/invoices', label: '/apps/invoices' });
  assert.match(spec.summary, /no container, no registry, no pod/);
  assert.equal(spec.facts.find((f) => f.label === 'objects')?.value, '(none — the OS serves this app itself, same-origin)');

  const image = appEngineeringView({ ...base, serveMode: 'image' }).tools.find((t) => t.tool === 'Kubernetes')!;
  assert.equal(image.link, null);
  assert.match(image.summary, /The OS does not build it/);
  assert.ok(image.commands[0].startsWith('kubectl -n agentic-apps get deploy,svc,ing app-invoices'));
});

test('HONESTY: the view says what the OS does NOT do, in its own words', () => {
  const view = appEngineeringView(base);
  assert.ok(view.notTrueYet.some((s) => /does NOT build container images/.test(s)));
  assert.ok(view.notTrueYet.some((s) => /no GitOps controller/.test(s)));
  assert.ok(view.notTrueYet.some((s) => /release_software/.test(s)), 'the missing verb is named');
  assert.ok(!view.notTrueYet.some((s) => /DATA_PROJECT_GIT=false/.test(s)), 'not claimed when git is on');

  const off = appEngineeringView({ ...base, gitEnabled: false, history: [], releases: [] });
  assert.ok(off.notTrueYet.some((s) => /DATA_PROJECT_GIT=false/.test(s)), 'a disabled repo is SAID, not an empty history');
  const git = off.tools.find((t) => t.tool === 'git')!;
  assert.equal(git.facts.find((f) => f.label === 'head commit')?.value, '(the domain repository is disabled)');
});

test('an app with no domain says so instead of inventing a repository', () => {
  const view = appEngineeringView({ ...base, domain: '', history: [], releases: [] });
  const git = view.tools.find((t) => t.tool === 'git')!;
  assert.match(git.summary, /not assigned to a domain/);
  assert.equal(git.facts.find((f) => f.label === 'repository')?.value, '(none — the app has no domain)');
  assert.ok(git.commands.every((c) => c.includes('<domain>')), 'the command is a template, not a lie');
});

test('the native export names what it is and the command to use it elsewhere', () => {
  const view = appEngineeringView(base);
  assert.match(String(view.export?.what), /apps\/invoices\//);
  assert.match(String(view.export?.how), /^git --git-dir=\/repos\/eng\.git archive/);
});
