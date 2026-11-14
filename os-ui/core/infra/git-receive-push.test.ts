/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    A REAL `git push` through the real hooks — the test the first version did not have
 * USER STORY: As the owner I want the engineer's door proved end to end by git itself: the real
 *             `receive-pack`, the real quarantine, the real pre-receive and post-receive scripts,
 *             the real endpoint — because the gate-level tests cannot see a quarantined object and
 *             that blind spot is exactly what shipped a door that refused every push (review H-2).
 * ARCHITECTURE:
 *   - A temp-dir bare repo written by the OS's own commit path, `ensureReceiveHooks` to install the
 *     scripts, and a `node:http` server serving `handleReceive` — the SAME function the route is a
 *     shell over. `OS_RECEIVE_URL` and `HTTP_AUTHORIZATION` are set in the environment the `git`
 *     child inherits, which is exactly how they arrive over CGI.
 *   - The push is driven with the real `git` CLI from a real working clone. Every assertion is on
 *     what git itself reports (exit status + `remote:` lines), not on an internal call.
 *   - `child_process` is used ASYNCHRONOUSLY on purpose: the hook calls back into this process, so
 *     a synchronous `execFileSync` would deadlock the event loop that has to serve it.
 *   - Skipped (not silently passed) when `git` or `curl` is not on PATH.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { commitTree, listTree, log, openOrInit } from '@core/infra/git-store';
import {
  ensureReceiveHooks,
  registerRepoKind,
  __clearRepoKinds,
  __resetHookMemo,
  MANAGED_BY_OS,
  type ChangedFile,
  type IngestReport,
} from '@core/infra/git-receive';
import { handleReceive, type ReceiveBody } from '@core/infra/git-receive-server';
import { __resetAccessTokens, createAccessToken } from '@core/auth/access-tokens-store';

const run = promisify(execFile);

// One principal, a member of every domain this file seeds — a non-member is a 404 by design and
// `access-tokens.test.ts` owns that case.
const ALEX = {
  id: 'alex',
  name: 'Alex',
  role: 'builder',
  domains: ['sales', 'greenfield', 'owned', 'noforce', 'invalid', 'notoken', 'destructive'],
};
const lookup = async (id: string) => (id === ALEX.id ? ALEX : null);

let reposDir = '';
let workDir = '';
let server: Server | null = null;
let receiveUrl = '';
let token = '';
let available = true;
let ingested: { domain: string; files: ChangedFile[]; pusher: { id: string }; sha: string }[] = [];

async function have(bin: string): Promise<boolean> {
  try {
    await run(bin, ['--version']);
    return true;
  } catch {
    return false;
  }
}

before(async () => {
  available = (await have('git')) && (await have('curl'));
  if (!available) return;
  reposDir = mkdtempSync(join(tmpdir(), 'os-push-repos-'));
  workDir = mkdtempSync(join(tmpdir(), 'os-push-work-'));
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      void (async () => {
        let body: ReceiveBody = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ReceiveBody;
        } catch {
          body = {};
        }
        const out = await handleReceive(
          body,
          {
            gitAuthorization: (req.headers['x-os-git-authorization'] as string) ?? null,
            authorization: (req.headers.authorization as string) ?? null,
          },
          { lookup, reposDir, serviceBearerToken: '' },
        );
        res.writeHead(out.status, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(out.body);
      })();
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server!.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  receiveUrl = `http://127.0.0.1:${port}/api/git/receive`;
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  if (reposDir) rmSync(reposDir, { recursive: true, force: true });
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  if (!available) return;
  __clearRepoKinds();
  __resetAccessTokens();
  ingested = [];
  token = createAccessToken({ userId: 'alex', name: 'laptop' }).token;
  registerRepoKind({
    kind: 'spy',
    matches: (p) => p.endsWith('.sql') || p.endsWith('.yml'),
    validate: ({ content }) => (content.includes('BROKEN') ? 'the spy validator refuses this file' : null),
    ingest: async (input): Promise<IngestReport> => {
      ingested.push(input);
      return { kind: 'spy', created: 0, updated: input.files.length, skipped: 0, notes: [] };
    },
  });
});

function env(withToken = true): NodeJS.ProcessEnv {
  const basic = `Basic ${Buffer.from(`git:${token}`).toString('base64')}`;
  return {
    ...process.env,
    OS_RECEIVE_URL: receiveUrl,
    ...(withToken ? { HTTP_AUTHORIZATION: basic } : { HTTP_AUTHORIZATION: '' }),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  };
}

/** A bare repo with the OS's hooks installed, plus a working clone of it. */
async function seedRepo(domain: string, files: Map<string, string> | null): Promise<string> {
  await openOrInit(domain, { reposDir });
  if (files) {
    await commitTree(domain, files, {
      reposDir,
      author: { name: 'Sovereign OS', email: 'os@sovereign.local' },
      message: `data(${domain}): generate project — via boot:reconcile`,
      timestamp: 1_700_000_000,
    });
  }
  __resetHookMemo();
  ensureReceiveHooks(domain, { reposDir });
  const clone = join(workDir, `${domain}-${Math.random().toString(36).slice(2, 7)}`);
  await run('git', ['clone', join(reposDir, `${domain}.git`), clone], { env: env() });
  await run('git', ['-C', clone, 'config', 'user.email', 'alex@datamasterclass.com'], { env: env() });
  await run('git', ['-C', clone, 'config', 'user.name', 'Alex'], { env: env() });
  return clone;
}

function write(clone: string, rel: string, content: string): void {
  const full = join(clone, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

type PushOutcome = { ok: boolean; out: string };

async function push(clone: string, args: string[] = [], withToken = true): Promise<PushOutcome> {
  try {
    const r = await run('git', ['-C', clone, 'push', ...args, 'origin', 'HEAD:main'], { env: env(withToken) });
    return { ok: true, out: `${r.stdout}\n${r.stderr}` };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, out: `${err.stdout ?? ''}\n${err.stderr ?? ''}` };
  }
}

const base = () =>
  new Map([
    ['dbt_project.yml', 'name: sales\n'],
    ['models/gold/gold_orders.sql', 'select 1\n'],
    ['models/gold/schema.yml', 'version: 2\nmodels:\n  - name: gold_orders\n'],
    ['os/schedules.yml', 'version: 1\nschedules: []\n'],
  ]);

// ---------------------------------------------------------------------------------------------

test('A REAL PUSH LANDS, and the registry is reconciled from the pushed files (review H-2)', async (t) => {
  if (!available) return t.skip('git or curl is not on PATH');
  const clone = await seedRepo('sales', base());
  write(clone, 'models/gold/gold_orders.sql', 'select 2 as id\n');
  await run('git', ['-C', clone, 'commit', '-am', 'engineer: edit the model'], { env: env() });

  const r = await push(clone);
  assert.equal(r.ok, true, `the push must land — git said:\n${r.out}`);
  assert.match(r.out, /remote: the OS accepted 1 file change\(s\) as alex/);
  assert.match(r.out, /remote: spy: 0 created, 1 updated/);

  // The ref really moved, and the ingest really saw the pushed bytes.
  const tree = await listTree('sales', 'main', { reposDir });
  assert.equal(tree.find((e) => e.path === 'models/gold/gold_orders.sql') !== undefined, true);
  assert.equal(ingested.length, 1);
  assert.deepEqual(ingested[0].files.map((f) => f.path), ['models/gold/gold_orders.sql']);
  assert.equal(ingested[0].files[0].content, 'select 2 as id\n');
  assert.equal(ingested[0].pusher.id, 'alex');
  assert.equal((await log('sales', { reposDir }))[0].sha, ingested[0].sha);
});

test('A REAL FIRST PUSH into an empty repository lands (the --root path, review H-2)', async (t) => {
  if (!available) return t.skip('git or curl is not on PATH');
  const clone = await seedRepo('greenfield', null);
  write(clone, 'models/gold/first.sql', 'select 1\n');
  await run('git', ['-C', clone, 'add', '-A'], { env: env() });
  await run('git', ['-C', clone, 'commit', '-m', 'engineer: the first model'], { env: env() });
  // A clone of an empty repo starts on whatever `init.defaultBranch` is; push HEAD to main.
  const r = await push(clone);
  assert.equal(r.ok, true, `the first push must land — git said:\n${r.out}`);
  assert.match(r.out, /remote: the OS accepted 1 file change\(s\)/);
  assert.deepEqual(ingested[0].files.map((f) => f.path), ['models/gold/first.sql']);
});

test('A REAL PUSH touching os/** is refused, with the managed-by-the-OS sentence on the terminal', async (t) => {
  if (!available) return t.skip('git or curl is not on PATH');
  const clone = await seedRepo('owned', base());
  write(clone, 'os/schedules.yml', 'version: 1\nschedules: [mine]\n');
  await run('git', ['-C', clone, 'commit', '-am', 'engineer: take over the schedule'], { env: env() });

  const r = await push(clone);
  assert.equal(r.ok, false, `the push must be refused — git said:\n${r.out}`);
  assert.match(r.out, new RegExp(MANAGED_BY_OS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(r.out, /os\/schedules\.yml/);
  // Nothing landed and nothing was ingested.
  assert.equal(ingested.length, 0);
  const head = (await log('owned', { reposDir }))[0];
  assert.match(head.subject, /via boot:reconcile/);
});

test('A REAL FORCE PUSH after an amend is refused — no history rewrites (E6)', async (t) => {
  if (!available) return t.skip('git or curl is not on PATH');
  const clone = await seedRepo('noforce', base());
  write(clone, 'models/gold/gold_orders.sql', 'select 3\n');
  await run('git', ['-C', clone, 'commit', '-am', 'engineer: one'], { env: env() });
  assert.equal((await push(clone)).ok, true);
  write(clone, 'models/gold/gold_orders.sql', 'select 4\n');
  await run('git', ['-C', clone, 'commit', '--amend', '-am', 'engineer: rewritten'], { env: env() });

  const r = await push(clone, ['--force']);
  assert.equal(r.ok, false, `a force push must be refused — git said:\n${r.out}`);
  // git's OWN refusal (`receive.denyNonFastForwards`) or the gate's — both are real, both say so.
  assert.match(r.out, /non-fast-forward|not a fast-forward/i);
});

test('A REAL PUSH the validator refuses is refused, naming the file and the reason (E5)', async (t) => {
  if (!available) return t.skip('git or curl is not on PATH');
  const clone = await seedRepo('invalid', base());
  write(clone, 'models/gold/gold_orders.sql', 'BROKEN\n');
  await run('git', ['-C', clone, 'commit', '-am', 'engineer: push something invalid'], { env: env() });

  const r = await push(clone);
  assert.equal(r.ok, false);
  assert.match(r.out, /models\/gold\/gold_orders\.sql: the spy validator refuses this file/);
  assert.equal(ingested.length, 0);
});

test('A REAL PUSH with NO token is refused with the 401 sentence, and never reaches the gate', async (t) => {
  if (!available) return t.skip('git or curl is not on PATH');
  const clone = await seedRepo('notoken', base());
  write(clone, 'models/gold/gold_orders.sql', 'select 9\n');
  await run('git', ['-C', clone, 'commit', '-am', 'engineer: no credentials'], { env: env() });

  const r = await push(clone, [], false);
  assert.equal(r.ok, false);
  assert.match(r.out, /authentication failed/i);
  assert.match(r.out, /Platform/);
  assert.equal(ingested.length, 0);
  // And the token never appears anywhere in what git printed.
  assert.equal(r.out.includes(token.split('_').slice(2).join('_')), false);
});
