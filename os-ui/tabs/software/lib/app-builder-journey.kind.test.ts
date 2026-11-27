/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder (H) - the end-to-end journey on a REAL Kubernetes API server (kind): from a requirement to a
 *             running Prod release and back, through os-ui's own code under the chart's RBAC and admission policies
 * USER STORY: As the owner I want one run that proves the App Builder's whole path works together: create a v2 app,
 *             propose a requirement and agree the story, push code that names the story, see the criteria light up,
 *             get a Dev release and a preview slot without pressing anything, take it live in Prod only with a domain
 *             admin's approval (never my own), and roll Prod back - with the live pin following Prod.
 * ARCHITECTURE:
 *   - Set up by tests/e2e/kind/journeys/app-builder-journey.sh (kind + a local OCI registry the node pulls from + the
 *     chart's App Builder objects rendered with the switch on + the os-ui ServiceAccount token); skipped unless
 *     AB_JOURNEY_KUBECONFIG, AB_JOURNEY_SA_DIR and AB_JOURNEY_BASE_IMAGE are set.
 *   - REAL here: os-ui's store, git (bare repos in a temp dir, a real `git push` into the domain repository, the
 *     receive ingest with its hooks), the classifier's parser, the proposal flow, the story lights, the Tekton record
 *     mapping (`recordFromRun`), auto-dev, every rollout (git tree → registry HEAD with the pull identity → pre-deploy
 *     hooks → closed overlay → dry run → apply, as the os-ui ServiceAccount, through the chart's Roles and admission
 *     policies), the preview slots, the go-live rule table and review cards, the rollback, the live pin tags.
 *   - STOOD IN (each is its own component with its own tests): the model (`assistantComplete` returns a scripted
 *     classifier reply - the spec's mockModel), OPA's decision (`authorize` allows; OPA is not in this cluster), the
 *     go-live rule STORE (empty = the spec defaults; its backend is not in this cluster), and Tekton itself: the
 *     PipelineRun/TaskRun objects a green run with the image tasks would leave are served to the real record reader.
 *     There is NO image build (builds need a dedicated pool and a gated builder digest CI does not have): the harness
 *     builds the template's `run` image with the CI runner's Docker once, and the journey pushes it (and a variant
 *     for the second release) into the app's OWN repository, exactly where a build would push it.
 *   - OPTIONAL (AB_JOURNEY_APPDB=1, CloudNativePG installed by the harness): the app gets a Dev database and the Dev
 *     release runs the template's migrations from the release image before the rollout.
 *   - NOT here: the app sign-in token flow (E). It needs os-ui reachable from the app pod and the consent store;
 *     core/auth/app-login.test.ts and app-token.test.ts prove it in process.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const KCFG = process.env.AB_JOURNEY_KUBECONFIG ?? '';
const SA = process.env.AB_JOURNEY_SA_DIR ?? '';
const BASE_IMAGE = process.env.AB_JOURNEY_BASE_IMAGE ?? '';
const REGISTRY = process.env.AB_JOURNEY_REGISTRY ?? 'localhost:5001';
const APPDB = process.env.AB_JOURNEY_APPDB === '1';
const skip = KCFG && SA && BASE_IMAGE ? false : 'AB_JOURNEY_KUBECONFIG / AB_JOURNEY_SA_DIR / AB_JOURNEY_BASE_IMAGE not set (run tests/e2e/kind/journeys/app-builder-journey.sh)';

const kubectl = (args: string[], input?: string) => execFileSync('kubectl', ['--kubeconfig', KCFG, ...args], { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
const sh = (cmd: string, args: string[], cwd?: string) => execFileSync(cmd, args, { encoding: 'utf8', cwd, stdio: ['ignore', 'pipe', 'pipe'] });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const step = (s: string) => console.log(`\n[journey] ${s}`);

// ---- environment for os-ui's config (read at import), BEFORE anything of os-ui is imported ----
const reposDir = skip ? '' : mkdtempSync(join(tmpdir(), 'ab-journey-repos-'));
if (!skip) {
  Object.assign(process.env, {
    OS_K8S_SA_DIR: SA,
    KUBERNETES_API: readFileSync(join(SA, 'server'), 'utf8').trim(),
    SOFTWARE_APP_BUILDER: 'on',
    SOFTWARE_APP_REGISTRY: REGISTRY,
    SOFTWARE_APP_REGISTRY_PULL: REGISTRY,
    SOFTWARE_APPS_DEV_NAMESPACE: 'apps-dev',
    SOFTWARE_APPS_PROD_NAMESPACE: 'apps-prod',
    OS_APPS_DOMAIN: 'apps.journey.test',
    OS_APPS_INGRESS_CLASS: 'nginx',
    OS_APPS_TLS_ISSUER: 'letsencrypt-prod',
    NAMESPACE: 'agentic-os',
    SOFTWARE_APP_DATABASES_MODE: APPDB ? 'cnpg' : '',
  });
}

/** The scripted classifier reply (mockModel): refine US-1 with a second criterion. */
const REPLY = JSON.stringify({
  classification: 'refine-story',
  targetId: 'US-1',
  rationale: 'It adds a rule to submitting an order.',
  confidence: 0.9,
  story: {
    title: 'Submit an order',
    asA: 'sales rep',
    iWant: 'to submit an order',
    soThat: 'it ships',
    criteria: [
      { id: 'AC-1', title: 'Valid order is accepted', given: ['a rep with a valid order'], when: ['they submit'], then: ['it is saved'] },
      { title: 'Empty order is refused', given: ['a rep with no lines'], when: ['they submit'], then: ['it is refused'] },
    ],
  },
});

type Mods = {
  apps: typeof import('@tabs/software/lib/apps');
  stories: typeof import('@tabs/software/lib/stories/store');
  proposals: typeof import('@tabs/software/lib/stories/proposals');
  lights: typeof import('@tabs/software/lib/stories/lights');
  receive: typeof import('@tabs/software/lib/app-receive');
  checksSync: typeof import('@tabs/software/lib/checks-sync');
  review: typeof import('@tabs/software/lib/review');
  rollout: typeof import('@tabs/software/lib/releases/rollout');
  store: typeof import('@tabs/software/lib/releases/store');
  autoDev: typeof import('@tabs/software/lib/releases/auto-dev');
  view: typeof import('@tabs/software/lib/releases/view');
  c2: typeof import('@tabs/software/mcp/app-builder/c2-tools');
  zot: typeof import('@core/adapters/zot/client');
  contracts: typeof import('@tabs/software/lib/app-builder-contracts');
  rules: typeof import('@core/policy/go-live-rules-store');
  reviewers: typeof import('@core/policy/go-live-reviewers');
  gs: typeof import('@core/infra/git-store');
  db: typeof import('@tabs/software/lib/appdb/database');
  user: typeof import('@core/testing/user');
};
let M: Mods;
const audits: { action: string; reason: string; detail?: Record<string, unknown> }[] = [];

before(async () => {
  if (skip) return;
  const { mock } = await import('node:test');
  // OPA is not in this cluster: its decision is stood in (allow); every other export of the module is the real one.
  const governed = await import('@core/infra/governed');
  mock.module('@core/infra/governed', { namedExports: { ...governed, authorize: async () => ({ allowed: true, policy: 'opa-allow' }) } });
  // The model (spec 15: mockModel): the classifier gets the scripted reply.
  const complete = await import('@core/runtime/complete');
  mock.module('@core/runtime/complete', { namedExports: { ...complete, assistantComplete: async () => ({ content: REPLY, model: 'journey-stub' }) } });
  const { config } = await import('@core/kernel/config');
  (config as { reposDir: string }).reposDir = reposDir;
  M = {
    apps: await import('@tabs/software/lib/apps'),
    stories: await import('@tabs/software/lib/stories/store'),
    proposals: await import('@tabs/software/lib/stories/proposals'),
    lights: await import('@tabs/software/lib/stories/lights'),
    receive: await import('@tabs/software/lib/app-receive'),
    checksSync: await import('@tabs/software/lib/checks-sync'),
    review: await import('@tabs/software/lib/review'),
    rollout: await import('@tabs/software/lib/releases/rollout'),
    store: await import('@tabs/software/lib/releases/store'),
    autoDev: await import('@tabs/software/lib/releases/auto-dev'),
    view: await import('@tabs/software/lib/releases/view'),
    c2: await import('@tabs/software/mcp/app-builder/c2-tools'),
    zot: await import('@core/adapters/zot/client'),
    contracts: await import('@tabs/software/lib/app-builder-contracts'),
    rules: await import('@core/policy/go-live-rules-store'),
    reviewers: await import('@core/policy/go-live-reviewers'),
    gs: await import('@core/infra/git-store'),
    db: await import('@tabs/software/lib/appdb/database'),
    user: await import('@core/testing/user'),
  };
  // The receive hooks and the pre-deploy hooks register themselves on import, as at boot.
  await import('@tabs/software/lib/stories/receive-index');
  await import('@tabs/software/lib/stories/posthoc');
  await import('@tabs/software/lib/deploy-env-block');
  // The go-live rule store's backend is not here: nothing saved = the spec defaults (My none, Domain domain_admin).
  M.rules.__setGoLiveRulesMirror({ probe: async () => true, read: async () => ({ state: 'absent' }), writeConfirmed: async () => ({ ok: true }) });
  // Only the audit sink is replaced (collected, so the journey can read it); git, registry and cluster are live.
  M.rollout.__setRolloutDepsForTests({ audit: (e) => void audits.push(e as never) });
  M.reviewers.registerGoLiveCandidates(async () => [
    { id: 'alice', role: 'creator', domains: ['sales'] },
    { id: 'dana', role: 'domain_admin', domains: ['sales'] },
  ]);
});

after(() => {
  if (skip) return;
  M.rollout.__setRolloutDepsForTests(null);
  M.rules.__setGoLiveRulesMirror(null);
  M.reviewers.registerGoLiveCandidates(null);
  if (process.env.KEEP !== '1') rmSync(reposDir, { recursive: true, force: true });
});

// ------------------------------------------------------------------------------------------- helpers ---

/** Push an image (the base, or a one-label variant of it) into a repository of the registry; returns its digest. */
function pushImage(repository: string, tag: string, variant?: string): string {
  const ref = `${REGISTRY}/${repository}:${tag}`;
  if (variant) execFileSync('docker', ['build', '-q', '-t', ref, '-'], { input: `FROM ${BASE_IMAGE}\nLABEL soa.dev/journey-variant="${variant}"\n`, stdio: ['pipe', 'pipe', 'pipe'] });
  else sh('docker', ['tag', BASE_IMAGE, ref]);
  const out = sh('docker', ['push', ref]);
  const m = /digest: (sha256:[0-9a-f]{64})/.exec(out);
  if (!m) throw new Error(`docker push ${ref} printed no digest:\n${out}`);
  return m[1];
}

/** A clone of the app's domain repository (the developer's laptop). */
function cloneDomain(domain: string): string {
  const bare = M.gs.repoPath(domain, { reposDir });
  const dir = mkdtempSync(join(tmpdir(), 'ab-journey-clone-'));
  sh('git', ['clone', '-q', bare, dir]);
  sh('git', ['config', 'user.name', 'Alice'], dir);
  sh('git', ['config', 'user.email', 'alice@journey.test'], dir);
  return dir;
}

/** Commit `files` (paths inside the app) with `message`, push to main, hand the push to the receive ingest as the git
 *  server does after accepting it (each file first through the receive gate's own validator). */
async function pushToApp(app: { domain: string; slug: string }, files: Record<string, string>, message: string, checks: (sha: string) => void): Promise<string> {
  const dir = cloneDomain(app.domain);
  try {
    const from = sh('git', ['rev-parse', 'HEAD'], dir).trim();
    const changed: { path: string; status: 'added' | 'modified'; content: string }[] = [];
    for (const [rel, content] of Object.entries(files)) {
      const path = `apps/${app.slug}/${rel}`;
      const abs = join(dir, path);
      let existed = false;
      try {
        existed = statSync(abs).isFile();
      } catch {
        existed = false;
      }
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
      changed.push({ path, status: existed ? 'modified' : 'added', content });
      // The app registry's mirror (OpenSearch) is not in this cluster, so the registry stays "cold" and the gate's
      // fail-closed answer for v2-only paths (stories/, migrate/) is "push again in a minute": accepted here as that,
      // and only that. Every other refusal fails the journey.
      const verdict = M.receive.validateAppFile({ path, content });
      assert.ok(verdict === null || /once the OS has loaded its app registry/.test(verdict), `the receive gate refuses ${path}: ${verdict}`);
    }
    sh('git', ['add', '-A'], dir);
    sh('git', ['commit', '-q', '-m', message], dir);
    sh('git', ['push', '-q', 'origin', 'HEAD:main'], dir);
    const sha = sh('git', ['rev-parse', 'HEAD'], dir).trim();
    const report = await M.receive.ingestApps(
      { domain: app.domain, files: changed, pusher: { id: 'alice', name: 'Alice', role: 'creator', domains: ['sales'] }, sha, fromSha: from },
      {
        // The checks run starts (Tekton is stood in below): the record is RUNNING until the run's objects say otherwise.
        checks: async (input) => {
          checks(input.sha);
          return { record: { sha: input.sha, status: 'running', trigger: 'push', engine: 'tekton', runRef: `chk-${input.sha.slice(0, 8)}`, startedAt: new Date().toISOString(), finishedAt: null, checks: [], error: null }, superseded: [] };
        },
      },
    );
    console.log(`[journey] receive notes: ${JSON.stringify(report.notes)}`);
    return sha;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

type Run = { digest: string; criteria: Record<string, { pass: number; fail: number }>; scanImage?: 'True' | 'False' };
const runs = new Map<string, Run>();

/** What Tekton records for a green run with the image tasks: served to os-ui's own record reader (tekton-checks.ts). */
function fakeTekton(slug: string) {
  const runOf = (sha: string) => {
    const r = runs.get(sha)!;
    return {
      metadata: { name: `chk-${sha.slice(0, 8)}`, creationTimestamp: new Date().toISOString(), labels: { 'soa.dev/app': slug, 'soa.dev/sha': sha, 'soa.dev/trigger': 'push' } },
      spec: {},
      status: {
        conditions: [{ type: 'Succeeded', status: 'True', reason: 'Succeeded' }],
        startTime: new Date(Date.now() - 60_000).toISOString(),
        completionTime: new Date().toISOString(),
        results: [{ name: 'digest', value: r.digest }, { name: 'criteria', value: JSON.stringify({ v: 1, results: r.criteria }) }],
      },
    };
  };
  const tr = (sha: string, task: string, steps: string[], ok: 'True' | 'False' = 'True') => ({
    metadata: { name: `chk-${sha.slice(0, 8)}-${task}`, labels: { 'tekton.dev/pipelineTask': task, 'tekton.dev/pipelineRun': `chk-${sha.slice(0, 8)}` } },
    status: { conditions: [{ type: 'Succeeded', status: ok }], steps: steps.map((name) => ({ name, container: `step-${name}`, terminated: { exitCode: 0 } })) },
  });
  const shaOf = (path: string) => /soa\.dev\/sha=([0-9a-f]{40})/.exec(decodeURIComponent(path))?.[1] ?? '';
  const runNameOf = (path: string) => /tekton\.dev\/pipelineRun=(chk-[0-9a-f]{8})/.exec(decodeURIComponent(path))?.[1] ?? '';
  return {
    namespace: 'agentic-build',
    k8s: async (method: string, path: string) => {
      if (method === 'GET' && path.includes('/pipelineruns')) {
        const sha = shaOf(path);
        return { status: 200, body: { items: runs.has(sha) ? [runOf(sha)] : [] } };
      }
      if (method === 'GET' && path.includes('/taskruns')) {
        const sha = [...runs.keys()].find((s) => `chk-${s.slice(0, 8)}` === runNameOf(path));
        if (!sha) return { status: 200, body: { items: [] } };
        return {
          status: 200,
          body: {
            items: [
              tr(sha, 'fetch', ['clone']),
              tr(sha, 'gates', ['toolchain', 'copy', 'facts', 'install', 'typecheck', 'lint', 'tests', 'build', 'policy']),
              tr(sha, 'scan', ['trivy-scan']),
              tr(sha, 'build-image', ['build']),
              tr(sha, 'push-image', ['push']),
              tr(sha, 'scan-image', ['scan'], runs.get(sha)!.scanImage ?? 'True'),
            ],
          },
        };
      }
      return { status: 404, body: {} };
    },
    k8sText: async () => ({ status: 200, text: '' }),
  };
}

async function fresh(id: string) {
  const a = await M.apps.getAppByIdInternal(id);
  assert.ok(a, `app ${id} vanished`);
  return a!;
}

/** Wait until `pred` holds for the stored app (auto-dev runs in the background, as in os-ui). */
async function waitApp(id: string, what: string, pred: (a: Awaited<ReturnType<typeof fresh>>) => boolean | string, ms = 300_000) {
  const until = Date.now() + ms;
  let last: unknown = null;
  while (Date.now() < until) {
    const a = await fresh(id);
    const r = pred(a);
    if (r === true) return a;
    if (typeof r === 'string') throw new Error(`${what}: ${r}`);
    last = a.releases;
    await sleep(2000);
  }
  throw new Error(`${what}: timed out; releases = ${JSON.stringify(last)}`);
}

/** The Deployment is rolled out and runs exactly the digest. */
function waitDeployment(ns: string, name: string, digest: string) {
  try {
    kubectl(['-n', ns, 'rollout', 'status', `deployment/${name}`, '--timeout=300s']);
  } catch (e) {
    const pods = (() => { try { return kubectl(['-n', ns, 'get', 'pods', '-o', 'wide']) + kubectl(['-n', ns, 'describe', 'deployment', name]) + kubectl(['-n', ns, 'get', 'events', '--sort-by=.lastTimestamp']); } catch { return ''; } })();
    throw new Error(`${ns}/${name} did not roll out: ${(e as Error).message}\n${pods}`);
  }
  const image = kubectl(['-n', ns, 'get', 'deployment', name, '-o', 'jsonpath={.spec.template.spec.containers[0].image}']).trim();
  assert.ok(image.endsWith(`@${digest}`), `${ns}/${name} runs ${image}, not ${digest}`);
  return image;
}

/** GET / of the app through its Service (a port-forward, as a developer would). Any HTTP answer below 500 = it serves. */
async function serves(ns: string, svc: string): Promise<number> {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const pf = spawn('kubectl', ['--kubeconfig', KCFG, '-n', ns, 'port-forward', `svc/${svc}`, `${port}:80`], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
        return res.status;
      } catch {
        /* not yet */
      }
    }
    throw new Error(`${ns}/${svc} did not answer on a port-forward`);
  } finally {
    pf.kill();
  }
}

const liveTag = (domain: string, appId: string): string => {
  try {
    return sh('git', ['--git-dir', M.gs.repoPath(domain, { reposDir }), 'rev-parse', `live/app/${appId}^{commit}`]).trim();
  } catch {
    return '';
  }
};

// ------------------------------------------------------------------------------------------- the journey ---

test('App Builder journey: requirement → agreed story → push with a story ref → lights → auto Dev + preview → Domain go-live by a domain admin → Prod → rollback', { skip, timeout: 3_600_000 }, async () => {
  const alice = M.user.testUser({ id: 'alice', name: 'Alice', domains: ['sales'], role: 'creator' });
  const dana = M.user.testUser({ id: 'dana', name: 'Dana', domains: ['sales'], role: 'domain_admin' });

  step('1. create a v2 app (nextjs-web@2), Shared in the domain (Domain scope go-live)');
  let app = await M.apps.createApp(alice, { name: `Journey Orders ${Date.now().toString(36).slice(-4)}`, template: 'nextjs-web', templateVersion: 2 });
  app.visibility = 'Shared';
  await M.apps.persistApp(app);
  const { domain, slug, id } = app;
  const repository = M.zot.imageRepository(domain, slug);
  const devName = M.contracts.appResourceName(domain, slug);
  console.log(`[journey] app ${id} = ${domain}/${slug}, repository ${repository}, objects ${devName}`);

  if (APPDB) {
    step('1b. (optional) the app gets its Dev database (CloudNativePG)');
    const v = await M.db.ensureAppDatabase(await fresh(id), 'dev');
    assert.equal(v.configured, true);
  }

  step('2. an epic and a draft story, then a requirement in chat → a diff card (git does not move)');
  await M.stories.saveEpic(id, alice, { title: 'Orders' }, { source: 'ui' });
  await M.stories.saveStory(id, alice, { epic: 'EP-1', title: 'Submit an order', asA: 'sales rep', iWant: 'to submit an order', soThat: 'it ships', criteria: [{ title: 'Valid order is accepted', given: ['a rep with a valid order'], when: ['they submit'], then: ['it is saved'] }] }, { source: 'ui' });
  const head0 = (await M.gs.log(domain, { reposDir, limit: 1 }))[0].sha;
  const proposed = await M.proposals.proposeRequirement(alice, id, { text: 'An order without lines must be refused', source: 'chat' });
  assert.equal(proposed.proposal.status, 'pending');
  assert.equal(proposed.proposal.targetId, 'US-1');
  assert.equal((await M.gs.log(domain, { reposDir, limit: 1 }))[0].sha, head0, 'proposing changes nothing in git');

  step('3. approve the card → one commit with the story, by Alice; US-1 has AC-1 and AC-2');
  const decided = await M.proposals.decideProposal(id, proposed.proposal.id, alice, 'approve', { rev: proposed.proposal.rev, via: 'ui' });
  assert.equal(decided.proposal.status, 'approved');
  assert.deepEqual(decided.stories, ['US-1']);
  const storyCommit = (await M.gs.log(domain, { reposDir, limit: 1 }))[0];
  assert.equal(storyCommit.sha, decided.commit?.sha);
  assert.equal(storyCommit.trailers['OS-Proposal'], proposed.proposal.id);
  const spec = await M.stories.readSpecOf(await fresh(id));
  const us1 = spec.spec.stories.find((s) => s.id === 'US-1');
  assert.ok(us1, 'US-1 is in git');
  assert.deepEqual(us1!.criteria.map((c) => c.id), ['AC-1', 'AC-2']);

  step('4. a developer pushes code and a test for AC-1 with "Story: US-1"; the record is RUNNING');
  const checksStarted: string[] = [];
  const digest1 = pushImage(repository, 'journey-1');
  const sha1 = await pushToApp(app, {
    'src/app/orders/page.tsx': 'export default function Orders() {\n  return <main>Orders</main>;\n}\n',
    'tests/orders.test.ts': "// US-1/AC-1\nimport { test } from 'node:test';\ntest('US-1/AC-1 valid order is accepted', () => {});\n",
  }, 'Add the order form\n\nStory: US-1', (s) => checksStarted.push(s));
  assert.deepEqual(checksStarted, [sha1], 'the push started exactly one checks run, for the pushed sha');
  app = await fresh(id);
  assert.equal(app.checks?.[0]?.sha, sha1);
  assert.equal(app.checks?.[0]?.status, 'running');
  assert.deepEqual(app.unreviewed ?? [], [], 'a push that names an agreed story makes no post-hoc card');

  step('5. the run finishes green with the image digest and the criteria result → lights partial, auto Dev release + preview');
  runs.set(sha1, { digest: digest1, criteria: { 'US-1/AC-1': { pass: 1, fail: 0 } } });
  await M.checksSync.syncAppChecks(await fresh(id), fakeTekton(slug) as never);
  app = await fresh(id);
  const rec1 = app.checks?.find((r) => r.sha === sha1);
  assert.equal(rec1?.status, 'finished');
  assert.equal(rec1?.digest, digest1);
  assert.deepEqual(rec1?.criteria?.results, { 'US-1/AC-1': { pass: 1, fail: 0 } });
  const lights1 = await M.lights.readStoryLights(id);
  assert.equal(lights1?.stories['US-1']?.light, 'partial', `US-1 light ${JSON.stringify(lights1?.stories['US-1'])}`);
  app = await waitApp(id, 'Dev release 1', (a) => {
    const dev = (a.releases ?? []).find((r) => r.env === 'dev' && !r.slot && r.sha === sha1);
    if (dev?.state === 'failed') return `the Dev release failed (see audits: ${JSON.stringify(audits.slice(-3))})`;
    const slot = (a.releases ?? []).find((r) => r.env === 'dev' && r.slot && r.sha === sha1);
    if (slot?.state === 'failed') return `the preview slot failed (see audits: ${JSON.stringify(audits.slice(-3))})`;
    return dev?.state === 'running' && slot?.state === 'running';
  });
  const dev1 = M.store.currentRelease(app, 'dev')!;
  assert.equal(dev1.digest, digest1);
  assert.equal(dev1.by, 'auto-dev');
  waitDeployment('apps-dev', devName, digest1);
  const slot1 = (app.releases ?? []).find((r) => r.env === 'dev' && r.slot && r.sha === sha1)!;
  waitDeployment('apps-dev', M.contracts.appResourceName(domain, slug, slot1.slot), digest1);
  const ann = JSON.parse(kubectl(['-n', 'apps-dev', 'get', 'deployment', devName, '-o', 'json'])).metadata.annotations as Record<string, string>;
  assert.equal(ann['soa.dev/release'], dev1.id);
  assert.equal(JSON.parse(ann[M.zot.RELEASE_PINS_ANNOTATION])[M.store.releaseTag('dev', dev1.id)], digest1, 'the Deployment records the release tag for the keeper');
  if (APPDB) assert.ok(dev1.migrations.applied.length > 0, `the Dev release ran the template's migrations: ${JSON.stringify(dev1.migrations)}`);
  const status1 = await serves('apps-dev', devName);
  assert.ok(status1 < 500, `the Dev release answers (HTTP ${status1})`);
  assert.equal(liveTag(domain, id), '', 'a Dev release moves no live pin');

  step('6. negative twins: a digest not in THIS app repository (another domain\'s image), an unscanned build');
  const foreign = pushImage(M.zot.imageRepository('hr', slug), 'journey-foreign', 'foreign');
  const refused = await M.rollout.rolloutRelease(await fresh(id), { env: 'dev', sha: sha1, digest: foreign, by: { id: 'alice' }, reason: 'manual' });
  assert.equal(refused.ok, false);
  assert.equal(!refused.ok && refused.code, 'digest', !refused.ok ? refused.reason : '');
  const unscanned = M.autoDev.autoDevDecision(await fresh(id), { ...rec1!, digest: foreign, checks: rec1!.checks.map((c) => (c.id === 'scan-image' ? { ...c, status: 'fail' as const } : c)) });
  assert.equal(unscanned.ok, false);

  step('7. Domain go-live: a review card; Alice cannot approve her own; Dana (domain admin) approves → Prod runs the same digest; the live pin follows');
  const view1 = await M.view.releasesView(await fresh(id), alice, 'dev');
  assert.equal(view1.goLive.ok, true, view1.goLive.reason ?? '');
  assert.equal(view1.goLive.reviewer, 'domain_admin');
  assert.equal(view1.goLive.noReviewer, null, 'a domain admin exists, so there is someone to approve');
  const req1 = await M.review.requestDeploy(id, alice);
  assert.equal(req1.kind, 'review');
  if (req1.kind !== 'review') return;
  await assert.rejects(M.review.decideDeploy(req1.card.id, alice, 'approve'), (e: Error & { status?: number }) => e.status === 403);
  assert.equal(M.store.currentRelease(await fresh(id), 'prod'), null, 'nothing went live on a refused approval');
  const d1 = await M.review.decideDeploy(req1.card.id, dana, 'approve');
  assert.equal(d1.card.decision, 'approved');
  app = await fresh(id);
  const prod1 = M.store.currentRelease(app, 'prod')!;
  assert.equal(prod1.digest, digest1);
  assert.equal(prod1.sha, sha1);
  waitDeployment('apps-prod', devName, digest1);
  assert.ok((await serves('apps-prod', devName)) < 500, 'Prod answers');
  assert.equal(liveTag(domain, id), sha1, 'live/app/<id> names the Prod release commit');

  step('8. the second criterion gets its test (push 2, a new image) → light green, Dev release 2');
  const digest2 = pushImage(repository, 'journey-2', 'release-2');
  assert.notEqual(digest2, digest1);
  const sha2 = await pushToApp(app, { 'tests/orders-empty.test.ts': "import { test } from 'node:test';\ntest('US-1/AC-2 empty order is refused', () => {});\n" }, 'Refuse empty orders\n\nStory: US-1', () => undefined);
  runs.set(sha2, { digest: digest2, criteria: { 'US-1/AC-1': { pass: 1, fail: 0 }, 'US-1/AC-2': { pass: 1, fail: 0 } } });
  await M.checksSync.syncAppChecks(await fresh(id), fakeTekton(slug) as never);
  assert.equal((await M.lights.readStoryLights(id))?.stories['US-1']?.light, 'green');
  app = await waitApp(id, 'Dev release 2', (a) => {
    const dev = (a.releases ?? []).find((r) => r.env === 'dev' && !r.slot && r.sha === sha2);
    if (dev?.state === 'failed') return 'the Dev release failed';
    return dev?.state === 'running' && (a.releases ?? []).some((r) => r.env === 'dev' && r.slot && r.sha === sha2 && r.state === 'running');
  });
  waitDeployment('apps-dev', devName, digest2);

  step('9. go live again (release 2), approved by Dana → Prod runs digest 2, pin on sha 2');
  const req2 = await M.review.requestDeploy(id, alice);
  assert.equal(req2.kind, 'review');
  if (req2.kind !== 'review') return;
  await M.review.decideDeploy(req2.card.id, dana, 'approve');
  assert.equal(M.store.currentRelease(await fresh(id), 'prod')?.digest, digest2);
  waitDeployment('apps-prod', devName, digest2);
  assert.equal(liveTag(domain, id), sha2);

  step('10. roll Prod back (Dana, the go-live right) → the previous digest serves; the pin follows back');
  const rollback = M.c2.c2Tools.find((t) => t.name === 'rollback_app')!;
  await assert.rejects(rollback.call(alice, { appId: id, env: 'prod' }), (e: Error & { status?: number }) => e.status === 403, 'the requester cannot roll Prod back in Domain scope');
  await rollback.call(dana, { appId: id, env: 'prod' });
  app = await fresh(id);
  assert.equal(M.store.currentRelease(app, 'prod')?.digest, digest1);
  waitDeployment('apps-prod', devName, digest1);
  assert.equal(liveTag(domain, id), sha1);

  step('11. a push that changes an agreed criterion → a post-hoc card; the Domain go-live is refused until it is reviewed');
  const dir = cloneDomain(domain);
  let storyFile = '';
  const walk = (d: string) => {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (!storyFile && readFileSync(p, 'utf8').includes('Empty order is refused')) storyFile = p;
    }
  };
  walk(join(dir, 'apps', slug, 'stories'));
  rmSync(dir, { recursive: true, force: true });
  assert.ok(storyFile, 'the agreed story file is in the app tree');
  const rel = storyFile.slice(storyFile.indexOf(`/apps/${slug}/`) + `/apps/${slug}/`.length);
  const bare = M.gs.repoPath(domain, { reposDir });
  const current = sh('git', ['--git-dir', bare, 'show', `main:apps/${slug}/${rel}`]);
  await pushToApp(app, { [rel]: current.replace('Empty order is refused', 'Empty order is refused with a reason') }, 'Tighten the empty-order rule', () => undefined);
  app = await fresh(id);
  assert.ok((app.unreviewed ?? []).length > 0, 'the criterion change is unreviewed');
  await assert.rejects(M.review.requestDeploy(id, alice), (e: Error & { status?: number }) => e.status === 409 && /unreviewed/.test(e.message));

  step('12. the audit trail names every release');
  const running = audits.filter((a) => (a.detail as { kind?: string; outcome?: string } | undefined)?.kind === 'app.release' && (a.detail as { outcome?: string }).outcome === 'running');
  assert.ok(running.length >= 6, `releases audited as running: ${running.length}`);
});
