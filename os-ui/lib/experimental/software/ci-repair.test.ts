/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Phase C — bounded CI-repair loop. Pins the four invariants:
 *   1. cleanCiLog strips timestamps/docker noise, collapses blanks, caps to the TAIL.
 *   2. repairSeed names the log + the failing commit's files + the fix-ONLY instruction.
 *   3. maybeAutoRepair requests the repair turn EXACTLY ONCE per failed run (2nd → skip).
 *   4. a second failure (the repaired commit itself fails CI) → NO loop + an honest state.
 *   5. opt-out (autoRepairEnabled:false) is honored — no repair turn is requested.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Offline: reject every network call BEFORE importing apps.ts so the in-process app
// cache initialises empty and forgejoApi (log/commit fetch) fails soft to '' / [].
const _realFetch = globalThis.fetch;
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const { createApp, refreshActionsStage, setAutoRepairEnabled, defaultCiRepairState } = await import('./apps.ts');
const { cleanCiLog, repairSeed, maybeAutoRepair, __setDefaultRepairTurn, __clearPendingChecks } =
  await import('./ci-repair.ts');
import type { App } from './apps.ts';
import type { CurrentUser } from '@/lib/core/auth';

const dev: CurrentUser = {
  id: 'pia',
  name: 'Pia',
  domains: ['eng'],
  allDomains: ['eng'],
  activeDomain: 'eng',
  role: 'builder',
};

/** A live-mode app fixture (repair only runs for live apps). createApp yields offline
 *  mode when Forgejo is unreachable — flip mode to 'live' so the bounds logic engages. */
async function liveApp(name: string): Promise<App> {
  const app = await createApp(dev, { name, template: 'nextjs-supabase' });
  app.mode = 'live';
  app.ciRepair = defaultCiRepairState();
  return app;
}

test.after(() => {
  __clearPendingChecks();
  globalThis.fetch = _realFetch;
});

// --------------------------------------------------------------- 1. cleanCiLog --

test('cleanCiLog strips timestamps, group markers and docker layer noise', () => {
  const raw = [
    '##[group]Set up job',
    '2026-08-03T10:15:01.123Z Preparing build',
    '##[endgroup]',
    '#12 [builder 3/8] RUN npm ci',
    'sha256:abc123 pulling',
    '---> a1b2c3d4',
    'Pulling fs layer',
    'Already exists',
    '[10:15:42] npm ERR! missing asset ./public/logo.svg',
    'npm ERR! code ENOENT',
    '',
    '',
    '',
    'Error: build failed with exit code 1',
  ].join('\n');
  const out = cleanCiLog(raw);
  assert.doesNotMatch(out, /##\[group\]|##\[endgroup\]/, 'group markers stripped');
  assert.doesNotMatch(out, /2026-08-03T10:15:01/, 'ISO timestamp stripped');
  assert.doesNotMatch(out, /^#12 /m, 'docker step line stripped');
  assert.doesNotMatch(out, /sha256:|Pulling fs layer|Already exists|--->/, 'docker chatter stripped');
  assert.doesNotMatch(out, /\n\n\n/, 'runs of blank lines collapsed');
  assert.match(out, /npm ERR! missing asset \.\/public\/logo\.svg/, 'the real error survives');
  assert.match(out, /Error: build failed/, 'the tail error survives');
  // The bracketed clock prefix on the error line is stripped, content kept.
  assert.doesNotMatch(out, /\[10:15:42\]/, 'bracketed clock timestamp stripped');
});

test('cleanCiLog keeps the error-dense TAIL and caps length', () => {
  const filler = Array.from({ length: 500 }, (_, i) => `info line ${i} doing routine work`).join('\n');
  const raw = `${filler}\nFATAL: dependency left-pad@9.9.9 not found in registry`;
  const out = cleanCiLog(raw, 500);
  assert.ok(out.length <= 600, `capped near the requested size (was ${out.length})`);
  assert.match(out, /FATAL: dependency left-pad/, 'the tail (the error) is what survives');
  assert.match(out, /log truncated/, 'truncation is labelled honestly');
});

test('cleanCiLog on empty input is empty', () => {
  assert.equal(cleanCiLog(''), '');
});

// --------------------------------------------------------------- 2. repairSeed --

test('repairSeed names the log, the changed files, and a fix-ONLY instruction', () => {
  const seed = repairSeed({
    log: 'npm ERR! ENOENT ./public/logo.svg',
    changedFiles: ['src/App.tsx', 'public/index.html'],
    sha: 'deadbeefcafe0000',
  });
  assert.match(seed, /AUTO-REPAIR/);
  assert.match(seed, /fix ONLY/i, 'the fix-only bound is stated');
  assert.match(seed, /deadbeefca/, 'the failing commit sha (short) is shown');
  assert.match(seed, /src\/App\.tsx/, 'a changed file is listed');
  assert.match(seed, /public\/index\.html/, 'all changed files are listed');
  assert.match(seed, /npm ERR! ENOENT/, 'the CI log excerpt is embedded');
  assert.match(seed, /compile gate still applies/i, 'the gate is still in force');
  assert.match(seed, /repair\(ci\):/, 'the commit-message prefix is instructed');
});

test('repairSeed degrades honestly when the log and file list are empty', () => {
  const seed = repairSeed({ log: '', changedFiles: [], sha: 'abc' });
  assert.match(seed, /could not be retrieved/, 'says the log was unavailable');
  assert.match(seed, /changed no tracked files|list was unavailable/, 'says the file list was unavailable');
});

// -------------------------------------------------- 3 + 4 + 5. bounds (loop) ----

test('maybeAutoRepair requests the repair turn EXACTLY ONCE per failed run', async () => {
  const app = await liveApp('Once Only');
  let turns = 0;
  const runRepairTurn = async () => {
    turns += 1;
    return { committed: true, text: 'fixed', headSha: 'repairsha01' };
  };
  const first = await maybeAutoRepair(app, { id: 'run-1', headSha: 'failsha01' }, { runRepairTurn });
  assert.equal(first.action, 'repaired');
  assert.equal(turns, 1, 'one repair turn on the first failure');

  // A second detection of the SAME failed run must NOT open another repair turn.
  const second = await maybeAutoRepair(app, { id: 'run-1', headSha: 'failsha01' }, { runRepairTurn });
  assert.equal(second.action, 'skipped');
  assert.equal(turns, 1, 'no second repair turn for the same run — at most once');
});

test('a second failure (the repaired commit fails CI) does NOT loop — honest terminal state', async () => {
  const app = await liveApp('No Loop');
  let turns = 0;
  const runRepairTurn = async () => {
    turns += 1;
    // The repair commit produces head "repairsha02".
    return { committed: true, text: 'attempted fix', headSha: 'repairsha02' };
  };
  await maybeAutoRepair(app, { id: 'run-A', headSha: 'origfail01' }, { runRepairTurn });
  assert.equal(turns, 1);

  // Now CI fails AGAIN — this time on the very commit our repair produced. The loop
  // must stop: no second turn, and the state must say so honestly.
  const fresh = app.ciRepair!;
  assert.equal(fresh.repairCommitSha, 'repairsha02', 'the repair commit sha is recorded for the no-loop guard');
  const again = await maybeAutoRepair(app, { id: 'run-B', headSha: 'repairsha02' }, { runRepairTurn });
  assert.equal(again.action, 'no-loop');
  assert.equal(turns, 1, 'no second repair turn — the repaired commit still failing is surfaced, not re-repaired');
  assert.equal(app.ciRepair!.outcome, 'attempted-still-failing', 'the terminal state is honestly labelled');
});

test('setAutoRepairEnabled toggles the app-level opt-out (default ON)', async () => {
  const app = await liveApp('Toggle');
  assert.equal(app.ciRepair!.autoRepairEnabled, true, 'default is ON');
  const off = await setAutoRepairEnabled(app.id, dev, false);
  assert.equal(off.ciRepair!.autoRepairEnabled, false, 'the owner can turn it off');
  const on = await setAutoRepairEnabled(app.id, dev, true);
  assert.equal(on.ciRepair!.autoRepairEnabled, true, 'and back on');
});

test('opt-out (autoRepairEnabled:false) is honored — no repair turn requested', async () => {
  const app = await liveApp('Opted Out');
  app.ciRepair = { ...defaultCiRepairState(), autoRepairEnabled: false };
  let turns = 0;
  const runRepairTurn = async () => {
    turns += 1;
    return { committed: true, text: 'x', headSha: 's' };
  };
  const r = await maybeAutoRepair(app, { id: 'run-x', headSha: 'sha-x' }, { runRepairTurn });
  assert.equal(r.action, 'skipped');
  assert.match(r.reason, /turned off/);
  assert.equal(turns, 0, 'no repair turn when the owner opted out');
});

test('a repair turn that finds no safe fix records skipped, not repaired', async () => {
  const app = await liveApp('No Fix Found');
  const runRepairTurn = async () => ({ committed: false, text: 'no clear cause', headSha: null });
  const r = await maybeAutoRepair(app, { id: 'run-nf', headSha: 'sha-nf' }, { runRepairTurn });
  assert.equal(r.action, 'skipped');
  assert.equal(app.ciRepair!.outcome, 'skipped', 'an uncommitted repair is not claimed as repaired');
  assert.equal(app.ciRepair!.repairedRunId, 'run-nf', 'the run is still marked attempted (at-most-once holds)');
});

// ------------------------------------------ detection wiring (refreshActionsStage) --

/** A scriptable fake of the Forgejo REST surface (mirrors pipeline-honesty.test.ts). */
function fakeForgejo(route: (method: string, url: string) => { status: number; json?: unknown } | undefined) {
  const calls: { method: string; url: string }[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, url });
    const r = route(method, url) ?? { status: 200, json: {} };
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

test('DETECTION: a failing run in refreshActionsStage requests the repair turn exactly once', async () => {
  const app = await liveApp('Detect Once');
  const repoPath = `/repos/${app.repo.fullName}`;
  let turns = 0;
  let seenRunId = '';
  const restoreTurn = __setDefaultRepairTurn(async () => {
    turns += 1;
    return { committed: false, text: 'looked', headSha: null };
  });
  const fake = fakeForgejo((method, url) => {
    if (method === 'GET' && url.endsWith(repoPath)) return { status: 200, json: { has_actions: true } };
    if (method === 'GET' && url.includes(`${repoPath}/commits`)) return { status: 200, json: [{ sha: 'failhead77' }] };
    if (method === 'GET' && url.includes(`${repoPath}/actions/tasks`)) {
      return { status: 200, json: { total_count: 1, workflow_runs: [{ id: 909, head_sha: 'failhead77', status: 'failure' }] } };
    }
    if (method === 'GET' && url.includes(`${repoPath}/actions/runs/909/jobs`)) {
      seenRunId = '909';
      return { status: 200, json: { jobs: [] } };
    }
    if (method === 'PUT' && url.includes('/actions/secrets/REGISTRY_PASS')) return { status: 204 };
    return undefined;
  });
  try {
    const r = await refreshActionsStage(app, { force: true });
    assert.equal(r.status, 'failing', 'the failed run is honestly reported failing');
    assert.match(r.note ?? '', /auto-repair/i, 'the status note surfaces the auto-repair');
    assert.match(r.note ?? '', /reasoning model/i, 'the model tier is honestly labelled on the surface');
    // triggerAutoRepair is fire-and-forget (dynamic import + promise) — let it settle.
    for (let i = 0; i < 10; i += 1) await new Promise((res) => setTimeout(res, 5));
    assert.equal(turns, 1, 'exactly one repair turn requested on detection');
    assert.equal(seenRunId, '909', 'the failing run id (909) drove the log fetch');

    // A second refresh of the SAME failed run must NOT open another repair turn.
    const r2 = await refreshActionsStage(app, { force: true });
    assert.equal(r2.status, 'failing');
    for (let i = 0; i < 10; i += 1) await new Promise((res) => setTimeout(res, 5));
    assert.equal(turns, 1, 'the same failed run is not repaired twice');
  } finally {
    restoreTurn();
    fake.restore();
  }
});

test('DETECTION: an opted-out app surfaces "turned off" and requests NO repair turn', async () => {
  const app = await liveApp('Detect Opted Out');
  app.ciRepair = { ...defaultCiRepairState(), autoRepairEnabled: false };
  const repoPath = `/repos/${app.repo.fullName}`;
  let turns = 0;
  const restoreTurn = __setDefaultRepairTurn(async () => {
    turns += 1;
    return { committed: false, text: 'x', headSha: null };
  });
  const fake = fakeForgejo((method, url) => {
    if (method === 'GET' && url.endsWith(repoPath)) return { status: 200, json: { has_actions: true } };
    if (method === 'GET' && url.includes(`${repoPath}/commits`)) return { status: 200, json: [{ sha: 'offhead11' }] };
    if (method === 'GET' && url.includes(`${repoPath}/actions/tasks`)) {
      return { status: 200, json: { total_count: 1, workflow_runs: [{ id: 5, head_sha: 'offhead11', status: 'failure' }] } };
    }
    if (method === 'PUT' && url.includes('/actions/secrets/REGISTRY_PASS')) return { status: 204 };
    return undefined;
  });
  try {
    const r = await refreshActionsStage(app, { force: true });
    assert.equal(r.status, 'failing');
    assert.match(r.note ?? '', /turned off/i, 'the surface says auto-repair is off');
    for (let i = 0; i < 6; i += 1) await new Promise((res) => setTimeout(res, 5));
    assert.equal(turns, 0, 'no repair turn when opted out, even via detection');
  } finally {
    restoreTurn();
    fake.restore();
  }
});
