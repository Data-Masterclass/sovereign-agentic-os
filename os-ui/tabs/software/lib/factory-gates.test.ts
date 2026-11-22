/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    Software Factory - quality gates run in a sandbox and block a deploy until they pass
 * USER STORY: As a builder approving a deploy I want proof that the app's tests, type check, lint and
 *             policy rules passed on the exact tree that will ship - and a refusal, not a warning,
 *             when they did not or could not run.
 * ARCHITECTURE: Pure verdict logic (gates.ts), the wiring into requestDeploy (the engine injected; the real one is Tekton), and the app's Rego policy
 *             evaluated by the REAL OPA (docker image or local binary; skipped with a reason if neither
 *             exists). The real-cluster proof is tests/software-factory/e2e.sh.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { config as cfg } from '@core/kernel/config';
import type { CurrentUser } from '@core/kernel/auth';
import { createApp, getAppForUser } from '@tabs/software/lib/apps';
import { requestDeploy, runAppTests, __resetReviewCards } from './review.ts';
import { instantiateGoldenPath } from './golden-path.ts';
import { REQUIRED_GATES, evaluateGates, type GatesOutcome } from './gates.ts';
import { recordFromOutcome } from './check-record.ts';
import type { ChecksRunner } from './tekton-checks.ts';

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

/** A stand-in engine that answers with a finished record; the real engine is Tekton (tests/software-factory/tekton-e2e.sh). */
const engine = (outcome: GatesOutcome, onRun?: () => void): ChecksRunner => async (i) => { onRun?.(); return { record: recordFromOutcome({ sha: i.sha, trigger: i.trigger, engine: 'fake', startedAt: 't0', finishedAt: 't1', outcome }), superseded: [] }; };
const green = (over: Record<string, string> = {}): GatesOutcome => ({
  ok: true,
  report: {
    schema: 'os-gates/v1',
    template: 'nextjs-web',
    ok: true,
    gates: REQUIRED_GATES.map((id) => ({ id, status: (over[id] ?? 'pass') as 'pass', detail: 'x' })),
  },
});

// ------------------------------------------------------------------ verdict ---

test('all required gates passing is a pass', () => {
  assert.deepEqual(evaluateGates(green()).blocking, []);
  assert.equal(evaluateGates(green()).passed, true);
});

test('a failing gate blocks and names itself and its detail', () => {
  const v = evaluateGates(green({ tests: 'fail' }));
  assert.equal(v.passed, false);
  assert.deepEqual(v.blocking.map((b) => b.id), ['tests']);
});

test('an unavailable gate is NOT a pass', () => {
  const v = evaluateGates(green({ policy: 'unavailable' }));
  assert.equal(v.passed, false);
  assert.match(v.blocking[0].detail, /unavailable|did not run/i);
});

test('a report that omits a required gate cannot pass (a script that skips checks is not green)', () => {
  const o = green();
  if (o.ok) o.report.gates = o.report.gates.filter((g) => g.id !== 'lint');
  const v = evaluateGates(o);
  assert.equal(v.passed, false);
  assert.ok(v.blocking.some((b) => b.id === 'lint'));
});

test('a report that says ok:true while a gate failed is still blocked (the verdict is recomputed)', () => {
  const o = green({ typecheck: 'fail' });
  assert.equal(o.ok && o.report.ok, true);
  assert.equal(evaluateGates(o).passed, false);
});

test('a sandbox that could not run is a block with its reason', () => {
  const v = evaluateGates({ ok: false, kind: 'no-cluster', reason: 'no cluster' });
  assert.equal(v.passed, false);
  assert.match(v.blocking[0].detail, /no cluster/);
});

const files = () => instantiateGoldenPath('nextjs-web', { name: 'A', slug: 'a', host: 'a.d.apps.test', registry: 'r/apps', ingressClass: 'nginx' });

// The sandbox itself (Job shape, verdict channel, overlay, namespace, supersede) is tested in
// sandbox-gates-verdict.test.ts; the pod log is no longer parsed for a verdict at all.

// ----------------------------------------------- the deploy request is blocked ---

const creator: CurrentUser = { id: 'alice', name: 'Alice', domains: ['sales'], role: 'creator' };

test('requestDeploy on a golden-path app is refused (422) while a gate fails, and opens the review once all pass', async () => {
  __resetReviewCards();
  const app = await createApp(creator, { name: 'Gate Desk', template: 'nextjs-web' });
  await assert.rejects(
    requestDeploy(app.id, creator, { scanMode: 'offline-mock', checks: engine(green({ tests: 'fail' })) }),
    (e: Error & { status?: number }) => { assert.equal(e.status, 422); assert.match(e.message, /tests/); return true; },
  );
  // The red result is now RECORDED against the commit: a repeat deploy request does not re-run the checks
  // (idempotent per sha) and is refused from the record, even if the checks would now pass.
  let ran = 0;
  await assert.rejects(
    requestDeploy(app.id, creator, { scanMode: 'offline-mock', checks: engine(green(), () => { ran += 1; }) }),
    (e: Error & { status?: number }) => { assert.equal(e.status, 422); assert.match(e.message, /not green/); return true; },
  );
  assert.equal(ran, 0, 'a finished record for the sha is read, not re-run');
  // "Run checks" (the button / verify_app_gates) re-runs the head and replaces the record; then deploy accepts that sha.
  const rerun = await runAppTests(app.id, creator, { checks: engine(green()), trigger: 'button' });
  assert.equal(rerun.verdict.passed, true);
  const ok = await requestDeploy(app.id, creator, { scanMode: 'offline-mock', checks: async () => { throw new Error('must not run again'); } });
  assert.equal(ok.kind, 'review');
});

test('requestDeploy with an explicit sha that is not the head is refused (409), and the record is per sha with trigger and time', async () => {
  __resetReviewCards();
  const app = await createApp(creator, { name: 'Sha Desk', template: 'nextjs-web' });
  await assert.rejects(
    requestDeploy(app.id, creator, { scanMode: 'offline-mock', sha: 'f'.repeat(40), checks: engine(green()) }),
    (e: Error & { status?: number }) => { assert.equal(e.status, 409); return true; },
  );
  const r = await runAppTests(app.id, creator, { checks: engine(green({ build: 'fail' })), trigger: 'button' });
  assert.equal(r.verdict.passed, false);
  assert.ok(r.verdict.blocking.some((b) => b.id === 'build'));
  const stored = (await getAppForUser(app.id, creator)).checks ?? [];
  assert.equal(stored.length, 1);
  assert.equal(stored[0].sha, r.commit);
  assert.equal(stored[0].trigger, 'button');
  assert.ok(stored[0].startedAt && stored[0].finishedAt);
  assert.equal(stored[0].checks.find((c) => c.id === 'build')!.status, 'fail');
});

// ------------------------------------------------- the policy, in the real OPA ---

const OPA_IMAGE = process.env.GOLDEN_PATH_OPA_IMAGE ?? 'openpolicyagent/opa:1.22.4';
const dockerOk = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
const opaBin = process.env.OPA_BIN ?? (spawnSync('opa', ['version'], { stdio: 'ignore' }).status === 0 ? 'opa' : '');
const skipOpa = opaBin || dockerOk ? false : 'neither an opa binary nor a docker daemon is available';

function denyFor(tree: { path: string; content: string }[]): string[] {
  const dir = mkdtempSync(join(homedir(), '.cache-golden-path-opa-'));
  // mkdtemp is 0700; the OPA image runs as a different uid than the runner, so it must be able to read the mount.
  chmodSync(dir, 0o755);
  try {
    const facts = { files: tree.filter((f) => !f.path.startsWith('vendor/') && /\.(ts|tsx|mjs|js|json|yaml|yml|md|rego)$|Dockerfile|\.env/.test(f.path)) };
    mkdirSync(join(dir, 'policy'), { recursive: true });
    writeFileSync(join(dir, 'policy', 'app-rules.rego'), tree.find((f) => f.path === 'policy/app-rules.rego')!.content);
    writeFileSync(join(dir, 'input.json'), JSON.stringify(facts));
    const args = ['eval', '--format', 'json'];
    const out = opaBin
      ? execFileSync(opaBin, [...args, '-d', join(dir, 'policy'), '-i', join(dir, 'input.json'), 'data.factory.deny'], { encoding: 'utf8' })
      : execFileSync('docker', ['run', '--rm', '-v', `${dir}:/w:ro`, OPA_IMAGE, ...args, '-d', '/w/policy', '-i', '/w/input.json', 'data.factory.deny'], { encoding: 'utf8' });
    return (JSON.parse(out).result?.[0]?.expressions?.[0]?.value ?? []) as string[];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const mutate = (t: { path: string; content: string }[], path: string, fn: (s: string) => string) => t.map((f) => (f.path === path ? { ...f, content: fn(f.content) } : f));
const add = (t: { path: string; content: string }[], path: string, content: string) => [...t, { path, content }];
const DOC = '/**\n * FEATURE: f\n * USER STORY: u\n * ARCHITECTURE: a\n */\n';

test('REAL OPA: the untouched template violates no rule', { skip: skipOpa }, () => {
  assert.deepEqual(denyFor(files()), []);
});

test('REAL OPA: hand-made authorization outside src/lib/os is denied', { skip: skipOpa }, () => {
  const t = add(files(), 'src/lib/guard.ts', `${DOC}export const isAllowed = (user: { role: string }) => user.role === 'admin';\n`);
  assert.ok(denyFor(t).some((m) => /hand-made authorization/.test(m)));
});

test('REAL OPA: a direct datastore client is denied', { skip: skipOpa }, () => {
  const t = add(files(), 'src/lib/db.ts', `${DOC}import { Client } from 'pg';\nexport const c = new Client();\n`);
  assert.ok(denyFor(t).some((m) => /direct datastore/.test(m)));
});

test('REAL OPA: a fetch to an absolute URL is denied', { skip: skipOpa }, () => {
  const t = add(files(), 'src/lib/leak.ts', `${DOC}export const go = () => fetch('https://example.com/x');\n`);
  assert.ok(denyFor(t).some((m) => /absolute URL/.test(m)));
});

test('REAL OPA: a hard-coded secret and a committed .env are denied', { skip: skipOpa }, () => {
  const a = add(files(), 'src/lib/k.ts', `${DOC}export const apiKey = 'abcdef1234567890abcd';\n`);
  assert.ok(denyFor(a).some((m) => /hard-coded secret/.test(m)));
  assert.ok(denyFor(add(files(), '.env', 'X=1\n')).some((m) => /environment files/.test(m)));
});

test('REAL OPA: missing docs, a source file without a doc block, an untested route and an undeclared route are denied', { skip: skipOpa }, () => {
  assert.ok(denyFor(files().filter((f) => f.path !== 'AGENTS.md')).some((m) => /AGENTS\.md is missing/.test(m)));
  assert.ok(denyFor(add(files(), 'src/lib/nodoc.ts', 'export const a = 1;\n')).some((m) => /no doc block/.test(m)));
  const route = add(files(), 'src/app/api/extra/route.ts', `${DOC}export const GET = () => Response.json({});\n`);
  const msgs = denyFor(route);
  assert.ok(msgs.some((m) => /no test imports this route/.test(m)));
  assert.ok(msgs.some((m) => /not declared in openapi\.yaml/.test(m)));
});

// ----------------------------------- a deploy of a sha with no green run is refused ---

test('NEGATIVE requestDeploy while the run is still running is refused with a 409 that says running, and nothing is approved', async () => {
  __resetReviewCards();
  const app = await createApp(creator, { name: 'Running Desk', template: 'nextjs-web' });
  const runningEngine: ChecksRunner = async (i) => ({ record: { sha: i.sha, status: 'running', trigger: i.trigger, engine: 'tekton', runRef: 'chk-x-1', startedAt: 't0', finishedAt: null, checks: [], error: null }, superseded: [] });
  await assert.rejects(
    requestDeploy(app.id, creator, { scanMode: 'offline-mock', checks: runningEngine }),
    (e: Error & { status?: number }) => { assert.equal(e.status, 409); assert.match(e.message, /running/); return true; },
  );
});

test('NEGATIVE requestDeploy with no Tekton engine configured is refused (422) naming the missing engine; the old sandbox is gone', async () => {
  __resetReviewCards();
  const app = await createApp(creator, { name: 'No Engine Deploy', template: 'nextjs-web' });
  await assert.rejects(
    requestDeploy(app.id, creator, { scanMode: 'offline-mock' }),
    (e: Error & { status?: number }) => { assert.equal(e.status, 422); assert.match(e.message, /Tekton/); return true; },
  );
});

// ------------------------------------------ the pipeline file the template ships ---

import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { PLATFORM_OWNED } from './golden-path.ts';

const TEMPLATE = join(import.meta.dirname, '..', '..', '..', '..', 'templates', 'nextjs-web');
type Step = { name: string; image?: string; onError?: string; script?: string };
const pipeline = () => yaml.load(readFileSync(join(TEMPLATE, '.tekton', 'pipeline.yaml'), 'utf8')) as {
  kind: string;
  spec: { tasks: { name: string; runAfter?: string[]; workspaces: { subPath?: string }[]; taskSpec?: { steps: Step[]; sidecars: { name: string; image: string }[] }; taskRef?: { name: string } }[] };
};

test('the template ships its pipeline in git: a Tekton Pipeline whose gate steps are exactly the required gates', () => {
  const p = pipeline();
  assert.equal(p.kind, 'Pipeline');
  const gates = p.spec.tasks.find((t) => t.name === 'gates')!;
  const steps = gates.taskSpec!.steps;
  const gateSteps = steps.filter((s) => s.onError === 'continue').map((s) => s.name);
  assert.deepEqual(gateSteps, [...REQUIRED_GATES], 'one step per gate, in the order a human reads them, none skipped');
  for (const id of REQUIRED_GATES) assert.match(steps.find((s) => s.name === id)!.script ?? '', new RegExp(`scripts/factory-gates\\.mjs --only ${id}\\b`), `${id} runs the repo's own gate script`);
  assert.equal(steps[0].name, 'install');
  assert.equal(steps[steps.length - 1].name, 'verdict', 'the last step turns any failed gate into a failed task');
  assert.equal(gates.taskSpec!.sidecars[0].name, 'opa');
});

test('the pipeline uses Catalog tasks for the clone and the source scan, and only the app\'s own folder reaches the app\'s code', () => {
  const p = pipeline();
  assert.equal(p.spec.tasks.find((t) => t.name === 'fetch')!.taskRef!.name, 'git-clone');
  assert.equal(p.spec.tasks.find((t) => t.name === 'scan')!.taskRef!.name, 'trivy-scanner');
  for (const t of p.spec.tasks.filter((x) => x.name !== 'fetch')) {
    assert.deepEqual(t.runAfter, ['fetch']);
    assert.match(t.workspaces[0].subPath ?? '', /^repo\/apps\/\$\(params\.slug\)$/, `${t.name} must not see .git or a neighbouring app`);
  }
});

test('every image the pipeline runs is pinned by digest', () => {
  const text = readFileSync(join(TEMPLATE, '.tekton', 'pipeline.yaml'), 'utf8');
  const images = [...text.matchAll(/^\s+(?:image:|- \{ name: TRIVY_IMAGE, value:) ?"?([^\s"}]+)/gm)].map((m) => m[1]);
  assert.ok(images.length >= 5);
  for (const i of images) assert.match(i, /@sha256:[a-f0-9]{64}$/, i);
});

test('the pipeline and the gate script are platform-owned: a push cannot edit the checks that judge it', () => {
  assert.ok((PLATFORM_OWNED as readonly string[]).includes('.tekton/'));
});

test('factory-gates.mjs --only runs one gate; an unknown gate is an error, never a pass', () => {
  const run = (...a: string[]) => spawnSync('node', [join(TEMPLATE, 'scripts', 'factory-gates.mjs'), ...a], { cwd: mkdtempSync(join(tmpdir(), 'fg-')), encoding: 'utf8', env: { ...process.env, OPA_URL: '' } });
  const bad = run('--only', 'nonsense');
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown gate: nonsense/);
  const policy = run('--only', 'policy');
  const frame = policy.stdout.slice(policy.stdout.lastIndexOf(GATES_REPORT_DELIM) + GATES_REPORT_DELIM.length);
  const rep = JSON.parse(frame) as { gates: { id: string }[] };
  assert.deepEqual(rep.gates.map((g) => g.id), ['policy']);
});
