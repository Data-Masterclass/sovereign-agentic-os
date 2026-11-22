/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    Software Factory - PLATFORM_OWNED files are enforced on every write path, not only advertised
 * USER STORY: As the platform owner I want the gate files (policy, gates script), the Dockerfile, the
 *             deploy manifests and the workflows to be changeable by the platform only, whichever door the
 *             author uses (MCP push, the UI editor, the commit tool).
 * ARCHITECTURE: pure rule (platformOwnedViolations) + the three real write paths on a real app tree.
 *             Negative twins: an unchanged owned file passes, a source file passes, a legacy app is untouched.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config as cfg } from '@core/kernel/config';
import type { CurrentUser } from '@core/kernel/auth';
import { createApp, saveAppFile, getAppForUser } from '@tabs/software/lib/apps';
import { commitToApp } from '@tabs/software/lib/server';
import { pushAppFiles } from './push-app-files.ts';
import { platformOwnedViolations, platformOwnedRemovals, isPlatformOwnedPath, readTemplate } from './golden-path.ts';

let reposDir = '';
let prior = '';
before(() => {
  reposDir = mkdtempSync(join(tmpdir(), 'os-repos-po-'));
  prior = cfg.reposDir;
  (cfg as { reposDir: string }).reposDir = reposDir;
});
after(() => {
  (cfg as { reposDir: string }).reposDir = prior;
  rmSync(reposDir, { recursive: true, force: true });
});

const builder: CurrentUser = { id: 'po-ben', name: 'Ben', domains: ['sales'], role: 'builder' };
const tpl = (p: string) => readTemplate('nextjs-web').find((f) => f.path === p)!.content;

test('isPlatformOwnedPath: the gate files and build files are owned; source and the lockfile are not', () => {
  for (const p of ['policy/app-rules.rego', 'policy/extra.rego', 'scripts/factory-gates.mjs', 'Dockerfile', 'next.config.mjs', 'k8s/deployment.yaml', '.github/workflows/ci.yml', 'vendor/x/y.js', '.npmrc']) assert.equal(isPlatformOwnedPath(p), true, p);
  for (const p of ['src/lib/x.ts', 'package.json', 'package-lock.json', 'tests/a.test.ts', 'app.yaml', 'docs/DECISIONS.md', 'policyx/a.ts']) assert.equal(isPlatformOwnedPath(p), false, p);
});

test('platformOwnedViolations: a changed or new owned file is a violation; an identical one is not', () => {
  const prior = [{ path: 'policy/app-rules.rego', content: 'a' }, { path: 'src/a.ts', content: 'x' }];
  assert.equal(platformOwnedViolations(prior, [{ path: 'policy/app-rules.rego', content: 'weakened' }]).length, 1);
  assert.equal(platformOwnedViolations(prior, [{ path: 'policy/new.rego', content: 'package factory' }]).length, 1);
  assert.deepEqual(platformOwnedViolations(prior, [{ path: 'policy/app-rules.rego', content: 'a' }]), []);
  assert.deepEqual(platformOwnedViolations(prior, [{ path: 'src/a.ts', content: 'changed' }]), []);
});

test('MCP push (push_app_files) cannot weaken the policy or the gates script', async () => {
  const app = await createApp(builder, { name: 'Owned Push', template: 'nextjs-web' });
  for (const [path, content] of [['policy/app-rules.rego', 'package factory\ndeny := set()\n'], ['scripts/factory-gates.mjs', '// always green\n'], ['Dockerfile', 'FROM scratch\n']] as const) {
    await assert.rejects(
      pushAppFiles({ appId: app.id, files: [{ path, content }], message: 'weaken' }, builder),
      (e: Error & { status?: number }) => { assert.equal(e.status, 403, path); assert.match(e.message, /platform-owned/i); return true; },
    );
  }
});

test('the commit tool and the UI editor are refused the same way', async () => {
  const app = await createApp(builder, { name: 'Owned Commit', template: 'nextjs-web' });
  await assert.rejects(commitToApp(app.id, builder, [{ path: 'policy/app-rules.rego', content: 'package factory\n' }], 'x'), (e: Error & { status?: number }) => e.status === 403);
  await assert.rejects(
    saveAppFile(app.id, builder, { path: 'scripts/factory-gates.mjs', content: '// green', sha: '' }),
    (e: Error & { status?: number }) => { assert.equal(e.status, 403); return true; },
  );
  const after = await getAppForUser(app.id, builder);
  assert.ok(after);
});

test('NEGATIVE TWIN: re-pushing an owned file unchanged, and editing source, are accepted', async () => {
  const app = await createApp(builder, { name: 'Owned Ok', template: 'nextjs-web' });
  const ok = await pushAppFiles({ appId: app.id, files: [{ path: 'policy/app-rules.rego', content: tpl('policy/app-rules.rego') }, { path: 'src/lib/note.ts', content: '/**\n * FEATURE: f\n * USER STORY: u\n * ARCHITECTURE: a\n */\nexport const n = 1;\n' }], message: 'ok' }, builder);
  assert.ok(ok.appId);
});

test('NEGATIVE TWIN: a legacy (non golden-path) app is not subject to the golden-path ownership list', async () => {
  const app = await createApp(builder, { name: 'Owned Legacy', template: 'nextjs-supabase' });
  const out = await pushAppFiles({ appId: app.id, files: [{ path: 'Dockerfile', content: 'FROM node:22-alpine\n' }], message: 'legacy' }, builder);
  assert.ok(out.appId);
});

// ---------------------------------------------------------------- next.config.* and deletions ---

test('every next.config.* (js, mjs, cjs, ts, mts, cts) at any depth is platform-owned; look-alikes are not', () => {
  for (const ext of ['js', 'mjs', 'cjs', 'ts', 'mts', 'cts']) {
    for (const dir of ['', 'src/', 'apps/web/', 'a/b/c/']) assert.equal(isPlatformOwnedPath(`${dir}next.config.${ext}`), true, `${dir}next.config.${ext}`);
  }
  // NEGATIVE TWINS
  for (const p of ['next.config.md', 'docs/next.config.md', 'src/lib/next-config.ts', 'src/lib/nextconfig.ts', 'next.config.json', 'xnext.config.mjs', 'src/next.configs.ts']) assert.equal(isPlatformOwnedPath(p), false, p);
});

test('MCP push cannot add a second next.config (ts/js) or override it below the root', async () => {
  const app = await createApp(builder, { name: 'Owned Next', template: 'nextjs-web' });
  for (const path of ['next.config.ts', 'next.config.js', 'src/next.config.mjs', 'next.config.mjs']) {
    await assert.rejects(
      pushAppFiles({ appId: app.id, files: [{ path, content: 'export default { output: "export" };\n' }], message: 'x' }, builder),
      (e: Error & { status?: number }) => { assert.equal(e.status, 403, path); assert.match(e.message, /platform-owned/i); return true; },
    );
  }
});

test('NEGATIVE TWIN: re-pushing the platform next.config.mjs unchanged is accepted, and a next.config note in docs/ is the author\'s', async () => {
  const app = await createApp(builder, { name: 'Owned Next Ok', template: 'nextjs-web' });
  const out = await pushAppFiles({ appId: app.id, files: [{ path: 'next.config.mjs', content: tpl('next.config.mjs') }, { path: 'docs/next.config.md', content: '# why\n' }], message: 'ok' }, builder);
  assert.ok(out.appId);
});

test('platformOwnedRemovals: an owned file that is in the tree before and gone after is a violation', () => {
  const before = [{ path: 'Dockerfile', content: 'a' }, { path: 'policy/app-rules.rego', content: 'p' }, { path: 'next.config.ts', content: 'n' }, { path: 'src/a.ts', content: 'x' }];
  assert.deepEqual(platformOwnedRemovals(before, before.filter((f) => f.path !== 'Dockerfile')), ['Dockerfile']);
  assert.deepEqual(platformOwnedRemovals(before, before.filter((f) => !/^(policy|next)/.test(f.path))).sort(), ['next.config.ts', 'policy/app-rules.rego']);
  // NEGATIVE TWINS: removing source is the author's; keeping every owned file is fine; an owned file that never existed is not a removal
  assert.deepEqual(platformOwnedRemovals(before, before.filter((f) => f.path !== 'src/a.ts')), []);
  assert.deepEqual(platformOwnedRemovals(before, before), []);
  assert.deepEqual(platformOwnedRemovals([{ path: 'src/a.ts', content: 'x' }], []), []);
});

test('the commit tool refuses a merged tree that lost an owned file (the choke point every door shares)', async () => {
  const { assertNoPlatformOwnedChange } = await import('./golden-path.ts');
  const prior = [{ path: 'Dockerfile', content: 'FROM x' }, { path: 'src/a.ts', content: 'x' }];
  assert.throws(() => assertNoPlatformOwnedChange(prior, [], [{ path: 'src/a.ts', content: 'x' }]), (e: Error & { status?: number }) => { assert.equal(e.status, 403); assert.match(e.message, /Dockerfile/); return true; });
  assert.doesNotThrow(() => assertNoPlatformOwnedChange(prior, [], prior));
  assert.doesNotThrow(() => assertNoPlatformOwnedChange(prior, [{ path: 'src/b.ts', content: 'y' }], [...prior, { path: 'src/b.ts', content: 'y' }]));
});
