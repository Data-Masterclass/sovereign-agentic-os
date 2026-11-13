/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Every agent-system writer commits (flag on) and none does (flag off) — checklist X1
 * USER STORY: As a maintainer I want a NEW writer of the agent store to FAIL this test until it is
 *             classified as a definition change (⇒ a commit) or as run bookkeeping (⇒ never a
 *             commit), and proof that each known writer reaches the ONE commit path.
 * ARCHITECTURE:
 *   - Enumerates the store module's function exports: every name must be in exactly one of
 *     READ_ONLY / RUN_ONLY / MUTATORS. `writeThrough`'s second parameter is REQUIRED, so the
 *     compiler already forces the decision; this test pins WHICH decision each writer made and
 *     that it is still true at run time.
 *   - Installs the real commit hook with a spy committer against the real store.
 *   - Also covers the request surface (`ui:<route>` / `mcp:<tool>`), the synthesized-email
 *     trailer, the two-repo cross-domain move, and that a delete/archive REMOVES the directory.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as store from '@tabs/agents/lib/store';
import type { Principal } from '@tabs/agents/lib/store';
import { __resetSystemListeners } from '@tabs/agents/lib/system-events';
import { runWithSurface } from '@core/infra/request-surface';
import { parseTrailers, appendTrailers, authorFor, type CommitTreeOptions } from '@core/infra/git-store';
import { runWithRunId } from '@core/infra/request-surface';
import {
  markRunWorkerProcess,
  isRunWorkerProcess,
  __clearRunWorkerProcess,
  SystemWriteUnavailableError,
} from '@tabs/agents/lib/write-availability';
import { ownerToken, AGENTS_PREFIX } from '@tabs/agents/lib/git/generate';
import {
  installAgentProjectCommitHook,
  awaitAgentProjectCommits,
  __setAgentProjectGitForTests,
  commitAgentSystem,
} from '@tabs/agents/lib/git/commit';

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'creator' };
const bea: Principal = { id: 'bea', domains: ['sales'], role: 'builder' };
const sara: Principal = { id: 'sara', domains: ['sales', 'finance'], role: 'admin' };

/** Exports that only READ (or are test seams). */
const READ_ONLY = new Set([
  'ensureHydrated', '__recordFor', '__resetStore',
  'listSystems', 'getSystemsUsingDataset', 'listAllSystemsInternal', 'agentHealthRows', 'markPendingShares',
  'getSystem', 'getSystemForEdit', 'canRunCheck', 'getSystemForRun', 'listFiles', 'readFile',
  'listSystemVersions', 'systemForScheduler', 'systemsForProject', 'projectDomains',
  // re-exported for callers that mint a run id beside a store read; not a writer.
  'newRunId',
  // Part D review H-1/H-3: probes, not writers. `hydrationState` reports whether the registry
  // really loaded (a boot-time writer must check it); the write-availability guard is re-exported
  // nowhere — it is called from `writeThrough` itself.
  'hydrationState',
]);

/**
 * Writers that deliberately do NOT commit: a RUN's artefacts are the LangGraph checkpoint, the
 * `run_events` rows and the Langfuse trace — none of them belongs in the definition repo, and
 * committing per node would bury every real change under run noise. Each of these is
 * `writeThrough(rec, null)` in the store, with the reason on the line.
 */
const RUN_ONLY: Record<string, () => void> = {
  recoverInterrupted: () => {
    const id = seed();
    store.setActivity(id, { kind: 'running', startedAt: Date.now(), instanceId: 'dead-process' });
    store.recoverInterrupted(store.__recordFor(id)!);
  },
  recordActivity: () => store.recordActivity(seed()),
  setActivity: () => store.setActivity(seed(), { kind: 'running', startedAt: 1 }),
  clearActivity: () => store.clearActivity(seed()),
  startRunCheckpoint: () => store.startRunCheckpoint(seed(), { prompt: 'x', runId: 'run_1', checkpointer: 'memory' }),
  checkpointNode: () => {
    const id = seed();
    store.startRunCheckpoint(id, { prompt: 'x' });
    store.checkpointNode(id, { phase: 'complete', node: 'assistant', status: 'ok' });
  },
  setLastRun: () => void store.setLastRun(seed(), amir, { at: 1, running: false, ok: true, path: ['assistant'], traces: 0, held: 0, steps: [] }),
};

type Calls = { domain: string; prefix: string; files: Map<string, string>; message: string; opts: CommitTreeOptions }[];
let calls: Calls = [];
let uninstall: (() => void) | null = null;

function installSpy(resolveActor?: (id: string) => Promise<{ id: string; name?: string; email?: string }>): void {
  uninstall = installAgentProjectCommitHook({
    resolveActor,
    committer: async (domain, prefix, files, opts) => {
      calls.push({ domain, prefix, files, message: opts.message, opts });
      return { sha: 'f'.repeat(40), changed: true };
    },
  });
}

beforeEach(() => {
  store.__resetStore();
  __resetSystemListeners();
  calls = [];
});
afterEach(() => {
  uninstall?.();
  uninstall = null;
  __setAgentProjectGitForTests(null);
});

/** The smallest live system: a Personal starter owned by amir in `sales`. */
function seed(name = 'Triage'): string {
  const rec = store.createSystem(amir, { name });
  return rec.id;
}
function agentIdOf(id: string): string {
  return store.getSystem(id, amir).system.agents[0].id;
}
function shared(id: string): string {
  store.promoteSystem(id, sara);
  return id;
}
function marketplace(id: string): string {
  shared(id);
  store.promoteSystem(id, sara);
  return id;
}

/** Every writer that MUST commit, with the smallest scenario that makes it write. */
const MUTATORS: Record<string, () => void | Promise<void>> = {
  createSystem: () => void store.createSystem(amir, { name: 'New team' }),
  forkSystem: () => { const id = marketplace(seed()); calls = []; store.forkSystem(id, bea); },
  promoteSystem: () => { const id = seed(); calls = []; store.promoteSystem(id, sara); },
  demoteSystem: () => { const id = shared(seed()); calls = []; store.demoteSystem(id, sara); },
  reassignOwner: () => { seed(); calls = []; store.reassignOwner('amir', 'kenji'); },
  moveSystemsDomain: () => { const id = seed(); calls = []; store.moveSystemsDomain({ id }, 'finance'); },
  writeFile: () => {
    const id = seed();
    const f = store.readFile(id, amir, `agents/${agentIdOf(id)}/AGENT.md`);
    calls = [];
    store.writeFile(id, amir, { path: f.path, content: `${f.content}\nEdited.`, sha: f.sha });
  },
  setRunning: () => { const id = seed(); calls = []; store.setRunning(id, amir, true); },
  setSchedule: () => { const id = seed(); calls = []; store.setSchedule(id, amir, { kind: 'cron', cron: '0 6 * * *' }); },
  toggleAgent: () => { const id = seed(); const a = agentIdOf(id); calls = []; store.toggleAgent(id, amir, a, false); },
  setLastBuild: () => { const id = seed(); calls = []; store.setLastBuild(id, amir, { ok: true, at: 1763020800000, rows: [] }); },
  renameAgentSystem: () => { const id = seed(); calls = []; store.renameAgentSystem(id, amir, 'Triage 2'); },
  moveAgentSystem: () => { const id = seed(); calls = []; store.moveAgentSystem(id, amir, '/teams'); },
  archiveSystem: () => { const id = seed(); calls = []; store.archiveSystem(id, amir); },
  unarchiveSystem: () => { const id = seed(); store.archiveSystem(id, amir); calls = []; store.unarchiveSystem(id, amir); },
  deleteSystem: () => { const id = seed(); calls = []; store.deleteSystem(id, amir); },
  restoreSystemVersion: () => {
    const id = seed();
    const f = store.readFile(id, amir, `agents/${agentIdOf(id)}/AGENT.md`);
    store.writeFile(id, amir, { path: f.path, content: `${f.content}\nEdited.`, sha: f.sha });
    calls = [];
    store.restoreSystemVersion(id, amir, 1);
  },
};

test('every store export is classified: read-only, run-only, or a committing mutator', () => {
  const exported = Object.entries(store)
    .filter(([, v]) => typeof v === 'function')
    .map(([k]) => k)
    .sort();
  const unknown = exported.filter((k) => !READ_ONLY.has(k) && !(k in RUN_ONLY) && !(k in MUTATORS));
  assert.deepEqual(unknown, [], 'unclassified store exports — add to READ_ONLY, RUN_ONLY or MUTATORS');
  const stale = [...Object.keys(MUTATORS), ...Object.keys(RUN_ONLY)].filter((k) => !exported.includes(k));
  assert.deepEqual(stale, [], 'a classified name is no longer an export');
});

test('the store has no un-classified write-through, and a delete announces itself', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'store.ts'), 'utf8');
  assert.equal(/writeThrough\(rec\)\s*;/.test(src), false, 'writeThrough must carry a change descriptor or an explicit null');
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('mirror.deleteThrough(')) continue;
    assert.ok(
      lines.slice(i, i + 12).some((l) => l.includes('emitSystemChange(')),
      `a record removed at line ${i + 1} must emit a change so the commit removes its directory`,
    );
  }
});

for (const [name, run] of Object.entries(MUTATORS)) {
  test(`flag ON: ${name} reaches the commit path`, async () => {
    __setAgentProjectGitForTests(true);
    installSpy();
    await run();
    await awaitAgentProjectCommits();
    assert.ok(calls.length >= 1, `${name} produced no commit`);
    for (const c of calls) {
      assert.match(c.message, /^agents\((sales|finance)\): /, c.message);
      assert.equal(c.prefix, 'agents/');
      for (const p of c.files.keys()) assert.ok(p.startsWith('agents/'), `${p} escapes the subtree`);
      const t = parseTrailers(c.message);
      assert.ok(t['OS-Action'] && t['OS-Object'] && t['OS-Surface'] && t['OS-Request-Id'], `trailers: ${c.message}`);
      // `OS-Actor` is an EXTRA trailer the git store appends to the message at commit time, so
      // the spy sees it on `opts.trailers` rather than inside the message it was handed.
      assert.ok(((c.opts.trailers ?? {})['OS-Actor'] ?? '').length > 0, 'OS-Actor trailer');
    }
  });

  test(`flag OFF: ${name} never touches git`, async () => {
    __setAgentProjectGitForTests(false);
    installSpy();
    await run();
    await awaitAgentProjectCommits();
    assert.equal(calls.length, 0, `${name} committed with the flag off`);
  });
}

for (const [name, run] of Object.entries(RUN_ONLY)) {
  test(`run bookkeeping: ${name} produces no commit`, async () => {
    __setAgentProjectGitForTests(true);
    installSpy();
    run();
    await awaitAgentProjectCommits();
    // The seed's own `createSystem` commit is expected; nothing after it.
    assert.deepEqual(
      calls.filter((c) => !/create system/.test(c.message)).map((c) => c.message),
      [],
      `${name} committed a run artefact`,
    );
  });
}

test('the ambient surface and request id land in the message; no surface ⇒ ui:agents', async () => {
  __setAgentProjectGitForTests(true);
  installSpy();
  await runWithSurface('mcp:commit_agent_files', async () => {
    const id = seed('Support triage');
    const f = store.readFile(id, amir, `agents/${agentIdOf(id)}/AGENT.md`);
    store.writeFile(id, amir, { path: f.path, content: `${f.content}\nEdited.`, sha: f.sha });
  }, 'req_abc');
  await awaitAgentProjectCommits();
  const last = calls.at(-1)!;
  assert.match(last.message, /^agents\(sales\): edit agents\/[\w-]+\/AGENT\.md support-triage — via mcp:commit_agent_files\n/);
  const t = parseTrailers(last.message);
  assert.equal(t['OS-Request-Id'], 'req_abc');
  assert.match(t['OS-Object'], /^sys_\w+ \(Support triage\)$/);
  assert.deepEqual(last.opts.author, { name: 'amir', email: 'amir@os.local' });
  assert.deepEqual(last.opts.trailers, { 'OS-Actor': 'amir', 'OS-Author-Email': 'synthesized' });

  calls = [];
  store.setSchedule(store.listSystems(amir).mine[0].id, amir, { kind: 'manual' });
  await awaitAgentProjectCommits();
  assert.equal(parseTrailers(calls.at(-1)!.message)['OS-Surface'], 'ui:agents');
});

test('a resolved actor is the git author', async () => {
  __setAgentProjectGitForTests(true);
  installSpy(async (id) => ({ id, name: 'Amir Example', email: 'amir@example.com' }));
  seed();
  await awaitAgentProjectCommits();
  assert.deepEqual(calls[0].opts.author, { name: 'Amir Example', email: 'amir@example.com' });
  assert.deepEqual(calls[0].opts.trailers, { 'OS-Actor': 'amir' });
});

test('archive and delete REMOVE the directory, and the reason says which', async () => {
  __setAgentProjectGitForTests(true);
  installSpy();
  const id = seed();
  await awaitAgentProjectCommits();
  const dir = [...calls.at(-1)!.files.keys()].find((p) => p.endsWith('/system.yaml'))!.replace('/system.yaml', '');
  calls = [];
  store.archiveSystem(id, amir);
  await awaitAgentProjectCommits();
  const archived = calls.at(-1)!;
  assert.match(archived.message, /^agents\(sales\): archive system /);
  assert.equal([...archived.files.keys()].some((p) => p.startsWith(`${dir}/`)), false, 'the archived system is gone from the tree');
  store.unarchiveSystem(id, amir);
  await awaitAgentProjectCommits();
  assert.ok([...calls.at(-1)!.files.keys()].some((p) => p === `${dir}/system.yaml`), 'unarchive puts it back');
  calls = [];
  store.deleteSystem(id, amir);
  await awaitAgentProjectCommits();
  assert.match(calls.at(-1)!.message, /^agents\(sales\): delete system sys_\w+ — via ui:agents/);
  assert.deepEqual([...calls.at(-1)!.files.keys()], ['agents/index.yml']);
});

test('a cross-domain move commits BOTH repos — the old one loses it, the new one gains it', async () => {
  __setAgentProjectGitForTests(true);
  installSpy();
  const id = seed();
  await awaitAgentProjectCommits();
  calls = [];
  store.moveSystemsDomain({ id }, 'finance');
  await awaitAgentProjectCommits();
  assert.deepEqual(calls.map((c) => c.domain), ['sales', 'finance']);
  assert.deepEqual([...calls[0].files.keys()], ['agents/index.yml'], 'sales no longer holds it');
  assert.ok([...calls[1].files.keys()].some((p) => p.endsWith('/system.yaml')), 'finance now holds it');
  for (const c of calls) assert.match(c.message, /move domain from sales to finance/);
});

test('commitAgentSystem is a no-op (null) with the flag off and generates the subtree with it on', async () => {
  __setAgentProjectGitForTests(false);
  assert.equal(await commitAgentSystem('sales', { id: 'amir' }, { action: 'x' }), null);
  __setAgentProjectGitForTests(true);
  seed('Support triage');
  let tree: Map<string, string> | null = null;
  const r = await commitAgentSystem('sales', { id: 'amir' }, { action: 'x' }, {
    committer: async (_d, _p, files) => { tree = files; return { sha: 'b'.repeat(40), changed: true }; },
  });
  assert.equal(r?.changed, true);
  const paths = [...tree!.keys()];
  assert.ok(paths.includes('agents/index.yml'));
  assert.ok(paths.some((p) => p === `agents/personal/${ownerToken('amir')}/support-triage/system.yaml`));
  assert.ok(paths.some((p) => p === `agents/personal/${ownerToken('amir')}/support-triage/graph.json`));
  assert.ok(paths.some((p) => p === `agents/personal/${ownerToken('amir')}/support-triage/README.md`));
});

test('no generated file carries a secret value — grants and key references are names only', async () => {
  __setAgentProjectGitForTests(true);
  installSpy();
  const id = seed();
  store.setLastBuild(id, amir, { ok: true, at: 1, rows: [], litellmKeyRef: { name: 'agent-litellm-key', key: id } });
  await awaitAgentProjectCommits();
  for (const c of calls) {
    for (const [p, content] of c.files) {
      assert.equal(/sk-[A-Za-z0-9]/.test(content), false, `${p} looks like it carries a key value`);
      assert.equal(/litellmKeyRef|agent-litellm-key/.test(content), false, `${p} carries a secret reference`);
    }
  }
});

// ---------------------------------- H-2 / H-3 / L-3 (Part D review round 3) ---

test("H-2: instrumentation reserves the literal 'agents/' before anything else — it must equal AGENTS_PREFIX", () => {
  // `instrumentation.ts` cannot import the tab's constant at that point in boot without pulling
  // the Agents graph in early, so it uses the literal. This test is the contract between them:
  // if the prefix ever moves, the boot-time reservation must move with it.
  const boot = readFileSync(join(process.cwd(), 'instrumentation.ts'), 'utf8');
  assert.equal(AGENTS_PREFIX, 'agents/');
  assert.match(boot, /reserveSubtree\('agents\/'\)/, "instrumentation.ts must reserve 'agents/' at the top of register()");
  const reserveAt = boot.indexOf("reserveSubtree('agents/')");
  const hooksAt = boot.indexOf('installDataProjectCommitHook');
  assert.ok(reserveAt > 0 && reserveAt < hooksAt, 'the reservation is taken BEFORE any commit hook or reconcile');
});

test('H-3: a definition change in the RUN WORKER fails closed with a typed error; run bookkeeping does not', async () => {
  __setAgentProjectGitForTests(true);
  const id = seed('Worker refuses');
  markRunWorkerProcess();
  try {
    // Every committable mutator refuses — the chokepoint is `writeThrough(rec, change)` itself,
    // so this holds for the whole list, not for the handful a test happens to name.
    assert.throws(() => store.renameAgentSystem(id, amir, 'Renamed in the worker'), (e: unknown) => {
      assert.ok(e instanceof SystemWriteUnavailableError);
      assert.equal((e as SystemWriteUnavailableError).code, 'run_worker_write_unavailable');
      assert.match((e as Error).message, /not available from the run worker/);
      assert.match((e as Error).message, /ReadWriteOnce/);
      return true;
    });
    assert.throws(() => store.setSchedule(id, amir, { kind: 'cron', cron: '0 6 * * *' }));
    // …and the run's own bookkeeping still works, because it is deliberately not a commit.
    store.setActivity(id, { kind: 'running', startedAt: Date.now(), instanceId: 'worker-1' });
    store.clearActivity(id);
    assert.equal(isRunWorkerProcess(), true);
  } finally {
    __clearRunWorkerProcess();
  }
  // Back in os-ui the same write is fine.
  store.renameAgentSystem(id, amir, 'Renamed in os-ui');
  assert.equal(store.getSystem(id, amir)?.name, 'Renamed in os-ui');
});

test('L-3: a commit made inside a run carries OS-Run-Id; one made by a person carries none', async () => {
  __setAgentProjectGitForTests(true);
  seed('Run attribution');
  const trailersFor = async (fn: () => Promise<void>) => {
    let opts: CommitTreeOptions | null = null;
    const committer = async (_d: string, _p: string, _f: Map<string, string>, o: CommitTreeOptions) => {
      opts = o;
      return { sha: 'c'.repeat(40), changed: true };
    };
    await fn();
    await commitAgentSystem('sales', { id: 'amir' }, { action: 'x' }, { committer });
    return parseTrailers(appendTrailers(opts!.message, opts!.trailers ?? {}));
  };
  const inRun = await runWithRunId('run_abc123', () => trailersFor(async () => {}));
  assert.equal(inRun['OS-Run-Id'], 'run_abc123');
  const byHand = await trailersFor(async () => {});
  assert.equal(byHand['OS-Run-Id'], undefined, 'no run, no trailer — never a fabricated one');
});

test('L-2: an e-mail-shaped principal id does not produce a malformed synthesized address', () => {
  assert.deepEqual(authorFor({ id: 'amir@acme.example', name: 'Amir' }).author, { name: 'Amir', email: 'amir@os.local' });
  assert.equal(authorFor({ id: 'amir@acme.example' }).synthesized, true);
  // A real e-mail is still used verbatim, and an id with no address shape is unchanged.
  assert.deepEqual(authorFor({ id: 'amir', email: 'amir@acme.example' }).author, { name: 'amir', email: 'amir@acme.example' });
  assert.deepEqual(authorFor({ id: 'amir' }).author, { name: 'amir', email: 'amir@os.local' });
  assert.equal(authorFor({ id: '@@@' }).author.email, 'unknown@os.local');
});
