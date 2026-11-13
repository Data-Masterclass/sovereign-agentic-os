/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The receive gate, driven by a FAKE RECEIVE — a real bare repo, a synthetic push
 * USER STORY: As the owner I want proof, offline, that a push is accepted exactly when the UI
 *             would accept the same change: path ownership, the OS-owned files, the shared
 *             validators, no history rewrites, and a push and an OS commit that cannot interleave
 *             (checklist E3 · E4 · E5 · E6 · E7 · E8).
 * ARCHITECTURE:
 *   - The fake receive is the real thing minus the network: `synthesize` writes a commit into a
 *     temp-dir bare repo WITHOUT moving the ref — exactly the state `pre-receive` sees — then the
 *     endpoint's own functions are called, then the ref is moved, then `post-receive` runs.
 *   - The object kind registered here is a SPY, not a tab: a core test may not import a tab
 *     (check-structure rule 3), and the two real kinds are covered by their own tab tests.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as git from 'isomorphic-git';
import { commitTree, listTree, log, MAIN, openOrInit, repoPath } from '@core/infra/git-store';
import {
  __clearRepoKinds,
  __openLeases,
  abortReceive,
  beginReceive,
  completeReceive,
  decidePath,
  DEFAULT_LOCK_TIMEOUT_MS,
  ensureReceiveHooks,
  looksSecretShaped,
  MANAGED_BY_OS,
  personalAgentLane,
  personalDataLane,
  receiveHookScript,
  reconcileFromGit,
  registerRepoKind,
  registeredRepoKinds,
  type ChangedFile,
  type IngestReport,
  type Pusher,
} from '@core/infra/git-receive';
import { mintToken } from '@core/auth/access-tokens';

let reposDir = '';
before(async () => {
  reposDir = mkdtempSync(join(tmpdir(), 'os-receive-'));
  await openOrInit('sales', { reposDir });
  await commitTree('sales', baseTree(), {
    reposDir,
    author: { name: 'Sovereign OS', email: 'os@sovereign.local' },
    message: 'data(sales): generate project — via boot:reconcile',
    timestamp: 1_700_000_000,
  });
});
after(() => rmSync(reposDir, { recursive: true, force: true }));

function baseTree(): Map<string, string> {
  return new Map([
    ['dbt_project.yml', 'name: sales\n'],
    ['models/gold/gold_orders.sql', 'select 1\n'],
    ['models/gold/schema.yml', 'version: 2\nmodels:\n  - name: gold_orders\n'],
    ['os/schedules.yml', 'version: 1\nschedules: []\n'],
  ]);
}

const builder: Pusher = { id: 'alex', name: 'Alex', role: 'builder', domains: ['sales'] };
const creator: Pusher = { id: 'nadia', name: 'Nadia', role: 'creator', domains: ['sales'] };

/** The spy kind. `validate` refuses any file whose content says `BROKEN`. */
let seen: { domain: string; files: ChangedFile[]; pusher: Pusher; sha: string }[] = [];
function registerSpy(): void {
  registerRepoKind({
    kind: 'spy',
    matches: (p) => p.endsWith('.sql') || p.endsWith('.yml') || p.endsWith('.yaml'),
    validate: ({ content }) => (content.includes('BROKEN') ? 'the spy validator refuses this file' : null),
    ingest: async (input): Promise<IngestReport> => {
      seen.push(input);
      return { kind: 'spy', created: 0, updated: input.files.length, skipped: 0, notes: [] };
    },
  });
}

beforeEach(() => {
  __clearRepoKinds();
  seen = [];
  registerSpy();
});

/**
 * Write a commit into the bare repo and return its sha WITHOUT moving `main` — the state the
 * pre-receive hook sees (git has the objects; the ref still points at the old head).
 */
async function synthesize(domain: string, changes: Map<string, string | null>): Promise<{ oldSha: string; newSha: string }> {
  const gitdir = repoPath(domain, { reposDir });
  const oldSha = await git.resolveRef({ fs, gitdir, ref: MAIN });
  const files = new Map<string, string>();
  for (const e of await listTree(domain, oldSha, { reposDir })) {
    const { blob } = await git.readBlob({ fs, gitdir, oid: e.oid });
    files.set(e.path, Buffer.from(blob).toString('utf8'));
  }
  for (const [p, content] of changes) {
    if (content === null) files.delete(p);
    else files.set(p, content);
  }
  const tree = await writeDir(gitdir, files, '');
  const newSha = await git.writeCommit({
    fs,
    gitdir,
    commit: {
      tree,
      parent: [oldSha],
      message: 'engineer: a push from VS Code\n',
      author: { name: 'Alex', email: 'alex@datamasterclass.com', timestamp: 1_700_000_100, timezoneOffset: 0 },
      committer: { name: 'Alex', email: 'alex@datamasterclass.com', timestamp: 1_700_000_100, timezoneOffset: 0 },
    },
  });
  return { oldSha, newSha };
}

async function writeDir(gitdir: string, files: Map<string, string>, prefix: string): Promise<string> {
  const here: { mode: string; path: string; oid: string; type: 'blob' | 'tree' }[] = [];
  const subdirs = new Map<string, Map<string, string>>();
  for (const [p, content] of files) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      const oid = await git.writeBlob({ fs, gitdir, blob: Buffer.from(content, 'utf8') });
      here.push({ mode: '100644', path: rest, oid, type: 'blob' });
    } else {
      const dir = rest.slice(0, slash);
      if (!subdirs.has(dir)) subdirs.set(dir, new Map());
      subdirs.get(dir)!.set(p, content);
    }
  }
  for (const [dir, sub] of subdirs) {
    const oid = await writeDir(gitdir, sub, `${prefix}${dir}/`);
    here.push({ mode: '040000', path: dir, oid, type: 'tree' });
  }
  here.sort((a, b) => (a.path < b.path ? -1 : 1));
  return git.writeTree({ fs, gitdir, tree: here });
}

/** The whole receive, as the two hooks drive it. */
async function fakePush(
  domain: string,
  pusher: Pusher,
  changes: Map<string, string | null>,
  deps: { lockTimeoutMs?: number } = {},
) {
  const { oldSha, newSha } = await synthesize(domain, changes);
  const decision = await beginReceive(
    { domain, pusher, updates: [{ ref: MAIN, oldSha, newSha }] },
    { reposDir, ...deps },
  );
  if (!decision.ok) return { decision, post: null };
  await git.writeRef({ fs, gitdir: repoPath(domain, { reposDir }), ref: MAIN, value: newSha, force: true });
  const post = await completeReceive(domain, { reposDir });
  return { decision, post };
}

// ------------------------------------------------------------------ path ownership (E4) ---

test('os/** is refused for everybody, with the managed-by-the-OS sentence', () => {
  for (const role of ['creator', 'builder', 'domain_admin', 'admin'] as const) {
    const v = decidePath('os/schedules.yml', { ...builder, role });
    assert.equal(v.allowed, false);
    assert.equal(v.allowed === false && v.reason, `'os/schedules.yml' is ${MANAGED_BY_OS}`);
  }
});

test('grant files and the system-identity map are refused the same way', () => {
  for (const p of ['os/grants.yml', 'grants.yaml', 'agents/index.yml']) {
    const v = decidePath(p, { ...builder, role: 'admin' });
    assert.equal(v.allowed, false);
    assert.match(v.allowed === false ? v.reason : '', new RegExp(MANAGED_BY_OS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test("a creator may push their OWN personal lane and nothing shared", () => {
  const own = `${personalDataLane('nadia')}silver_leads.sql`;
  assert.deepEqual(decidePath(own, creator), { allowed: true });
  assert.deepEqual(decidePath(`${personalAgentLane('nadia')}triage/system.yaml`, creator), { allowed: true });
  const shared = decidePath('models/gold/gold_orders.sql', creator);
  assert.equal(shared.allowed, false);
  assert.match(shared.allowed === false ? shared.reason : '', /models\/gold\/gold_orders\.sql/);
  assert.match(shared.allowed === false ? shared.reason : '', /personal lane/);
});

test("nobody may push into somebody ELSE's personal lane, whatever their role", () => {
  const hers = `${personalDataLane('nadia')}silver_leads.sql`;
  for (const role of ['builder', 'domain_admin', 'admin'] as const) {
    const v = decidePath(hers, { ...builder, role });
    assert.equal(v.allowed, false);
    assert.match(v.allowed === false ? v.reason : '', /only its owner may change it/);
  }
});

test('a builder may push shared domain paths, and a traversal is never a path', () => {
  assert.deepEqual(decidePath('models/gold/gold_orders.sql', builder), { allowed: true });
  assert.deepEqual(decidePath('dbt_project.yml', builder), { allowed: true });
  assert.equal(decidePath('../../etc/passwd', builder).allowed, false);
  assert.equal(decidePath('models//x.sql', builder).allowed, false);
});

test('anything credential-shaped is refused by NAME or by CONTENT', () => {
  assert.match(String(looksSecretShaped('models/.env', null)), /credential-shaped/);
  assert.match(String(looksSecretShaped('deploy/secrets.yml', null)), /credential-shaped/);
  assert.match(String(looksSecretShaped('tls/server.pem', null)), /credential-shaped/);
  assert.match(String(looksSecretShaped('models/gold/x.sql', 'api_key = "AKIA0123456789abcd"')), /carries a credential/);
  assert.equal(looksSecretShaped('models/gold/x.sql', 'select 1\n'), null);
});

// ---------------------------------------------------------------- the whole receive ---

test('a valid push lands, and the registry is reconciled FROM THE FILES as the pusher (E3/E8)', async () => {
  const { decision, post } = await fakePush(
    'sales',
    builder,
    new Map([['models/gold/gold_orders.sql', 'select 2 as id\n']]),
  );
  assert.equal(decision.ok, true);
  assert.equal(post?.ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].domain, 'sales');
  assert.equal(seen[0].pusher.id, 'alex');
  assert.deepEqual(
    seen[0].files.map((f) => [f.path, f.status]),
    [['models/gold/gold_orders.sql', 'modified']],
  );
  assert.equal(seen[0].files[0].content, 'select 2 as id\n');
  // The gate released its lock; nothing is left holding the repository.
  assert.equal(__openLeases(), 0);
  // And the new bytes really are the head's bytes.
  const head = (await log('sales', { reposDir }))[0];
  assert.equal(head.sha, seen[0].sha);
});

test('a push that touches os/** is rejected with the file named, and the lock is released', async () => {
  const { decision, post } = await fakePush('sales', builder, new Map([['os/schedules.yml', 'version: 1\nschedules: [evil]\n']]));
  assert.equal(decision.ok, false);
  assert.equal(decision.ok === false && decision.status, 403);
  assert.match(decision.ok === false ? decision.message : '', /'os\/schedules\.yml' is managed by the OS; change it in Governance or over the MCP/);
  assert.equal(post, null);
  assert.equal(__openLeases(), 0);
  assert.equal(seen.length, 0);
});

test('a push the validator refuses is a 422 naming the file and the reason (E5)', async () => {
  const { decision } = await fakePush('sales', builder, new Map([['models/gold/gold_orders.sql', 'BROKEN\n']]));
  assert.equal(decision.ok, false);
  assert.equal(decision.ok === false && decision.status, 422);
  assert.equal(decision.ok === false && decision.message.trim(), 'models/gold/gold_orders.sql: the spy validator refuses this file');
  assert.equal(__openLeases(), 0);
});

test('a validator that THROWS rejects the push rather than crashing the gate', async () => {
  __clearRepoKinds();
  registerRepoKind({
    kind: 'thrower',
    matches: (p) => p.endsWith('.sql'),
    validate: () => {
      throw new Error('parse exploded');
    },
    ingest: async () => ({ kind: 'thrower', created: 0, updated: 0, skipped: 0, notes: [] }),
  });
  const { decision } = await fakePush('sales', builder, new Map([['models/gold/gold_orders.sql', 'select 3\n']]));
  assert.equal(decision.ok === false && decision.status, 422);
  assert.match(decision.ok === false ? decision.message : '', /parse exploded/);
});

test('a non-fast-forward push to main is REFUSED — no history rewrites (E6)', async () => {
  const gitdir = repoPath('sales', { reposDir });
  const head = await git.resolveRef({ fs, gitdir, ref: MAIN });
  const { commit } = await git.readCommit({ fs, gitdir, oid: head });
  const parent = commit.parent[0] ?? head;
  // Claim the head is `head` and the new value is an ANCESTOR of it: a rewind.
  const decision = await beginReceive(
    { domain: 'sales', pusher: builder, updates: [{ ref: MAIN, oldSha: head, newSha: parent }] },
    { reposDir },
  );
  assert.equal(decision.ok, false);
  assert.equal(decision.ok === false && decision.status, 409);
  assert.match(decision.ok === false ? decision.message : '', /not a fast-forward of main/);
  assert.equal(__openLeases(), 0);
});

test('deleting main, and any ref that is not main, are both refused (E6)', async () => {
  const head = await git.resolveRef({ fs, gitdir: repoPath('sales', { reposDir }), ref: MAIN });
  const del = await beginReceive(
    { domain: 'sales', pusher: builder, updates: [{ ref: MAIN, oldSha: head, newSha: '0'.repeat(40) }] },
    { reposDir },
  );
  assert.equal(del.ok === false && del.status, 400);
  assert.match(del.ok === false ? del.message : '', /main cannot be deleted/);

  const branch = await beginReceive(
    { domain: 'sales', pusher: builder, updates: [{ ref: 'refs/heads/proposal/x', oldSha: '0'.repeat(40), newSha: head }] },
    { reposDir },
  );
  assert.equal(branch.ok === false && branch.status, 400);
  assert.match(branch.ok === false ? branch.message : '', /one branch, main/);
  assert.equal(__openLeases(), 0);
});

test('a repository that does not exist is a 404, and a non-member is a 403', async () => {
  const missing = await beginReceive({ domain: 'nowhere', pusher: builder, updates: [] }, { reposDir });
  assert.equal(missing.ok === false && missing.status, 404);
  const foreign = await beginReceive(
    { domain: 'sales', pusher: { ...builder, domains: ['finance'] }, updates: [] },
    { reposDir },
  );
  assert.equal(foreign.ok === false && foreign.status, 403);
});

// -------------------------------------------------------------------- serialisation (E7) ---

test('an OS commit and a push cannot interleave: the gate holds the SAME lock (E7)', async () => {
  const { oldSha, newSha } = await synthesize('sales', new Map([['models/gold/gold_orders.sql', 'select 4 as id\n']]));
  const decision = await beginReceive(
    { domain: 'sales', pusher: builder, updates: [{ ref: MAIN, oldSha, newSha }] },
    { reposDir },
  );
  assert.equal(decision.ok, true);

  // The OS tries to commit WHILE the gate holds the lease. It must not land yet.
  let osDone = false;
  const osCommit = commitTree('sales', new Map([...baseTree(), ['models/gold/os_written.sql', 'select 5\n']]), {
    reposDir,
    author: { name: 'Alex', email: 'alex@datamasterclass.com' },
    message: 'data(sales): add os_written — via ui:data',
  }).then((r) => {
    osDone = true;
    return r;
  });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(osDone, false, 'the OS commit must wait for receive-pack to finish');

  // receive-pack lands the push, then post-receive releases.
  await git.writeRef({ fs, gitdir: repoPath('sales', { reposDir }), ref: MAIN, value: newSha, force: true });
  await completeReceive('sales', { reposDir });
  const result = await osCommit;
  assert.equal(osDone, true);

  // NEITHER write is lost: the OS commit's parent is the PUSHED commit.
  const history = await log('sales', { reposDir, limit: 5 });
  assert.equal(history[0].sha, result.sha);
  assert.equal(history[0].parents[0], newSha);
  const tree = (await listTree('sales', 'main', { reposDir })).map((e) => e.path);
  assert.equal(tree.includes('models/gold/os_written.sql'), true);
});

test('a lock the OS holds too long FAILS the push with a readable message, never a hang (E7)', async () => {
  // Hold the lock from outside, exactly as a long OS commit would.
  const key = repoPath('sales', { reposDir });
  const map = (globalThis as unknown as Record<symbol, Map<string, Promise<unknown>>>)[Symbol.for('soa.git-store.locks')];
  let releaseHeld!: () => void;
  const held = new Promise<void>((r) => {
    releaseHeld = r;
  });
  const prev = map.get(key) ?? Promise.resolve();
  map.set(key, prev.then(() => held));

  const started = Date.now();
  const { oldSha, newSha } = await synthesize('sales', new Map([['models/gold/gold_orders.sql', 'select 6\n']]));
  const decision = await beginReceive(
    { domain: 'sales', pusher: builder, updates: [{ ref: MAIN, oldSha, newSha }] },
    { reposDir, lockTimeoutMs: 40 },
  );
  const waited = Date.now() - started;
  assert.equal(decision.ok, false);
  assert.equal(decision.ok === false && decision.status, 503);
  assert.match(decision.ok === false ? decision.message : '', /did not finish within/);
  assert.match(decision.ok === false ? decision.message : '', /nothing was changed/);
  assert.ok(waited < DEFAULT_LOCK_TIMEOUT_MS, `the wait must be bounded, took ${waited}ms`);
  releaseHeld();
  await new Promise((r) => setTimeout(r, 10));
});

test('abortReceive releases the lock when receive-pack fails after the gate said yes', async () => {
  const { oldSha, newSha } = await synthesize('sales', new Map([['models/gold/gold_orders.sql', 'select 7\n']]));
  const decision = await beginReceive({ domain: 'sales', pusher: builder, updates: [{ ref: MAIN, oldSha, newSha }] }, { reposDir });
  assert.equal(decision.ok, true);
  assert.equal(__openLeases(), 1);
  assert.equal(abortReceive('sales'), true);
  assert.equal(__openLeases(), 0);
  assert.equal(abortReceive('sales'), false);
  // The OS can write again immediately.
  const r = await commitTree('sales', new Map([...baseTree(), ['models/gold/after_abort.sql', 'select 8\n']]), {
    reposDir,
    author: { name: 'Alex', email: 'alex@datamasterclass.com' },
    message: 'data(sales): after abort — via ui:data',
  });
  assert.equal(r.changed, true);
});

test('post-receive with no lease says so honestly instead of pretending to reconcile', async () => {
  const out = await completeReceive('sales', { reposDir });
  assert.equal(out.ok, false);
  assert.match(out.message, /it landed, but the registry was not reconciled/);
});

// --------------------------------------------------------------------- reconcile + hooks ---

test('reconcileFromGit dispatches every registered kind that owns a changed path', async () => {
  const before = await git.resolveRef({ fs, gitdir: repoPath('sales', { reposDir }), ref: MAIN });
  const { newSha } = await synthesize('sales', new Map([['models/gold/gold_orders.sql', 'select 9\n']]));
  await git.writeRef({ fs, gitdir: repoPath('sales', { reposDir }), ref: MAIN, value: newSha, force: true });
  const reports = await reconcileFromGit('sales', before, newSha, builder, { reposDir });
  assert.deepEqual(reports.map((r) => r.kind), ['spy']);
  assert.equal(reports[0].updated, 1);
  assert.equal(registeredRepoKinds().length, 1);
});

test('the hooks are installed executable, receivepack is on, and the script carries no secret', () => {
  ensureReceiveHooks('sales', { reposDir });
  ensureReceiveHooks('sales', { reposDir }); // idempotent
  const gitdir = repoPath('sales', { reposDir });
  for (const phase of ['pre', 'post']) {
    const file = join(gitdir, 'hooks', `${phase}-receive`);
    const mode = statSync(file).mode & 0o777;
    assert.equal(Boolean(mode & 0o100), true, `${phase}-receive must be executable (mode ${mode.toString(8)})`);
    assert.equal(readFileSync(file, 'utf8'), receiveHookScript(phase as 'pre' | 'post'));
  }
  const cfg = readFileSync(join(gitdir, 'config'), 'utf8');
  assert.match(cfg, /receivepack = true/);
  assert.match(cfg, /denyNonFastForwards = true/);

  const script = receiveHookScript('pre');
  // It forwards the pusher's own Authorization header to be resolved SERVER-SIDE…
  assert.match(script, /x-os-git-authorization/);
  assert.match(script, /HTTP_AUTHORIZATION/);
  // …calls exactly ONE endpoint…
  assert.equal(script.match(/\/api\/git\/receive/g)?.length, 1);
  // …and embeds no credential of its own: every secret is read from the environment.
  assert.equal(/sos_[0-9a-f]{12}_/.test(script), false);
  assert.match(script, /\$\{OS_SERVICE_BEARER:\+/);
  // pre-receive refuses; post-receive never fails a push that has already landed.
  assert.match(script, /^exit 1$/m);
  assert.match(receiveHookScript('post'), /^exit 0 {3}# post-receive/m);
});

test('a token pasted into a pushed path or file never comes back in the rejection (E2 no-leak)', async () => {
  const { token } = mintToken();
  const { decision } = await fakePush('sales', builder, new Map([[`os/${token}.yml`, `token: ${token}\n`]]));
  assert.equal(decision.ok, false);
  const message = decision.ok === false ? decision.message : '';
  // Everything after the SECOND `_` is the secret (base64url includes `_`, so `split('_')[2]`
  // would be only a fragment — and a short fragment can occur by chance inside the hex prefix).
  const secret = token.split('_').slice(2).join('_');
  assert.equal(message.includes(secret), false, 'the secret half must never be echoed');
  assert.match(message, /sos_[0-9a-f]{12}_\*\*\*/);
});
