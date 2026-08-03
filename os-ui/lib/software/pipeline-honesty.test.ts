/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@/lib/core/auth';
import { createApp, refreshActionsStage } from '@/lib/software/apps';
import { commitToApp } from './server.ts';

/**
 * Pipeline HONESTY — the two lies that let CI die silently, pinned by tests.
 *
 * 1. THE COMMIT LIE (root cause of "app CI never triggers"): the live backend
 *    PUT the contents API without the current blob `sha`. Forgejo rejects that
 *    at request binding with 422 — and the old code counted 422 as success
 *    ("already exists"), so every post-seed commit to an existing file was a
 *    silent no-op: no commit → no push → NO Actions run, step still "ok".
 *    The fix does the sha dance (GET sha → PUT-with-sha / POST-if-new), skips
 *    identical content, and reports failures as failures.
 *
 * 2. THE STATUS LIE: `pipeline.actions` was set to 'ok' at create time and
 *    never verified. `refreshActionsStage` now earns 'ok' from live Forgejo
 *    (latest main commit has an Actions task), self-heals a disabled repo
 *    Actions unit, and says 'stalled' — with a repair hint — otherwise.
 */

const dev: CurrentUser = { id: 'pia', name: 'Pia', domains: ['eng'], role: 'creator' };

type Call = { method: string; url: string; body: Record<string, unknown> | null };

/** Scriptable fake of the Forgejo REST surface (plus a permissive default for
 *  unrelated fetches — mirror/trace write-throughs must not break the test). */
function fakeForgejo(route: (method: string, url: string) => { status: number; json?: unknown } | undefined) {
  const calls: Call[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: Record<string, unknown> | null = null;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        body = null;
      }
    }
    calls.push({ method, url, body });
    const r = route(method, url) ?? { status: 200, json: {} };
    return new Response(JSON.stringify(r.json ?? {}), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const contentsOf = (url: string) => /\/api\/v1\/repos\/[^/]+\/[^/]+\/contents\//.test(url);

// ----------------------------------------------------- 1. the commit sha dance

test('commit UPDATE carries the current blob sha (no more silent 422 no-op)', async () => {
  const app = await createApp(dev, { name: 'Sha Dance', template: 'nextjs-supabase' });
  const fake = fakeForgejo((method, url) => {
    if (url.endsWith('/api/v1/version')) return { status: 200, json: { version: '11.0.0' } };
    if (contentsOf(url) && method === 'GET') {
      return { status: 200, json: { type: 'file', sha: 'blob-old', encoding: 'base64', content: b64('old readme') } };
    }
    if (contentsOf(url) && method === 'PUT') return { status: 200, json: { commit: { sha: 'c1' } } };
    return undefined;
  });
  try {
    const { step } = await commitToApp(app.id, dev, [{ path: 'README.md', content: 'new readme' }], 'update readme');
    const put = fake.calls.find((c) => c.method === 'PUT' && contentsOf(c.url));
    assert.ok(put, 'an existing file must be updated via PUT');
    assert.equal(put!.body?.sha, 'blob-old', 'the PUT must carry the current blob sha (Forgejo 422s without it)');
    assert.equal(step.ok, true);
    assert.match(step.detail, /committed 1\/1/);
  } finally {
    fake.restore();
  }
});

test('commit of a NEW file uses POST (create), not a sha-less PUT', async () => {
  const app = await createApp(dev, { name: 'New File', template: 'nextjs-supabase' });
  const fake = fakeForgejo((method, url) => {
    if (url.endsWith('/api/v1/version')) return { status: 200, json: { version: '11.0.0' } };
    if (contentsOf(url) && method === 'GET') return { status: 404, json: { message: 'not found' } };
    if (contentsOf(url) && method === 'POST') return { status: 201, json: { commit: { sha: 'c2' } } };
    return undefined;
  });
  try {
    const { step } = await commitToApp(app.id, dev, [{ path: 'app/fresh.ts', content: 'export {}\n' }], 'add file');
    assert.ok(fake.calls.some((c) => c.method === 'POST' && contentsOf(c.url)), 'new file → POST create');
    assert.ok(!fake.calls.some((c) => c.method === 'PUT' && contentsOf(c.url)), 'no sha-less PUT for a new file');
    assert.equal(step.ok, true);
  } finally {
    fake.restore();
  }
});

test('identical content is SKIPPED and the step says no push → no CI run', async () => {
  const app = await createApp(dev, { name: 'No Change', template: 'nextjs-supabase' });
  const fake = fakeForgejo((method, url) => {
    if (url.endsWith('/api/v1/version')) return { status: 200, json: { version: '11.0.0' } };
    if (contentsOf(url) && method === 'GET') {
      return { status: 200, json: { type: 'file', sha: 'blob-same', encoding: 'base64', content: b64('same') } };
    }
    return undefined;
  });
  try {
    const { step } = await commitToApp(app.id, dev, [{ path: 'README.md', content: 'same' }], 'noop');
    assert.ok(!fake.calls.some((c) => (c.method === 'PUT' || c.method === 'POST') && contentsOf(c.url)), 'no write for unchanged content');
    assert.equal(step.ok, true);
    assert.match(step.detail, /no push, so no CI run/, 'the step must SAY that nothing will build');
  } finally {
    fake.restore();
  }
});

test('a rejected write is reported as a FAILURE — 422 is never success (commitToApp THROWS)', async () => {
  const app = await createApp(dev, { name: 'Honest Fail', template: 'nextjs-supabase' });
  const fake = fakeForgejo((method, url) => {
    if (url.endsWith('/api/v1/version')) return { status: 200, json: { version: '11.0.0' } };
    if (contentsOf(url) && method === 'GET') {
      return { status: 200, json: { type: 'file', sha: 'blob-x', encoding: 'base64', content: b64('old') } };
    }
    if (contentsOf(url) && method === 'PUT') return { status: 422, json: { message: 'rejected' } };
    return undefined;
  });
  try {
    // A backend-rejected commit must NOT masquerade as success: commitToApp now THROWS
    // (502) so the agent loop sees a real tool error and NOTHING phantom-persists — the
    // "story shows built but nothing landed" root fix. The old code returned {step.ok:false}
    // but still snapshotted/persisted, which fed the phantom-built diff.
    await assert.rejects(
      commitToApp(app.id, dev, [{ path: 'README.md', content: 'new' }], 'try'),
      /commit did not land.*FAILED: README\.md/,
    );
  } finally {
    fake.restore();
  }
});

// ------------------------------------------- 2. honest actions stage + heal ---

/** An app forced live (tests run clusterless, so createApp lands offline). */
async function liveApp(name: string) {
  const app = await createApp(dev, { name, template: 'nextjs-supabase' });
  app.mode = 'live';
  return app;
}

const repoUrl = (app: { repo: { fullName: string } }) => `/api/v1/repos/${app.repo.fullName}`;

test('actions unit disabled → auto-healed (PATCH has_actions:true) + honest pending', async () => {
  const app = await liveApp('Heal Unit');
  const fake = fakeForgejo((method, url) => {
    if (method === 'GET' && url.endsWith(repoUrl(app))) return { status: 200, json: { has_actions: false } };
    if (method === 'PATCH' && url.endsWith(repoUrl(app))) return { status: 200, json: { has_actions: true } };
    return undefined;
  });
  try {
    const r = await refreshActionsStage(app, { force: true });
    const patch = fake.calls.find((c) => c.method === 'PATCH' && c.url.endsWith(repoUrl(app)));
    assert.ok(patch, 'a disabled Actions unit must be auto-enabled server-side');
    assert.equal(patch!.body?.has_actions, true);
    assert.equal(r.status, 'pending', 'healed ≠ built: the stage is pending until a push builds');
    assert.match(r.note ?? '', /auto-enabled/);
    assert.equal(app.pipeline.actions, 'pending');
  } finally {
    fake.restore();
  }
});

test('actions unit disabled AND heal rejected → explicit disabled + repair hint', async () => {
  const app = await liveApp('Heal Denied');
  const fake = fakeForgejo((method, url) => {
    if (method === 'GET' && url.endsWith(repoUrl(app))) return { status: 200, json: { has_actions: false } };
    if (method === 'PATCH' && url.endsWith(repoUrl(app))) return { status: 403, json: { message: 'no' } };
    return undefined;
  });
  try {
    const r = await refreshActionsStage(app, { force: true });
    assert.equal(r.status, 'disabled');
    assert.match(r.note ?? '', /Settings → Units/, 'the failure must carry a repair hint');
    assert.equal(app.pipeline.actions, 'disabled');
  } finally {
    fake.restore();
  }
});

test('repo 404 (vanished) → forgejo AND actions downgraded to failing; no green claimed', async () => {
  const app = await liveApp('Vanished Repo');
  // Precondition: a live app starts with forgejo 'ok' (the lie we are fixing).
  app.pipeline.forgejo = 'ok';
  app.pipeline.actions = 'ok';
  const fake = fakeForgejo((method, url) => {
    if (method === 'GET' && url.endsWith(repoUrl(app))) return { status: 404, json: { message: 'not found' } };
    return undefined;
  });
  try {
    const r = await refreshActionsStage(app, { force: true });
    assert.equal(r.status, 'failing', 'a 404 repo cannot be ok');
    assert.match(r.note ?? '', /no longer exists|404|heal/i, 'the note names the missing repo + the fix');
    assert.equal(app.pipeline.forgejo, 'failing', 'the scaffold stage stops claiming ok for a gone repo');
    assert.equal(app.pipeline.actions, 'failing', 'actions is failing too — CI cannot build');
  } finally {
    fake.restore();
  }
});

test('actions ok is EARNED: latest main commit has an Actions task', async () => {
  const app = await liveApp('Earned Ok');
  const fake = fakeForgejo((method, url) => {
    if (method !== 'GET') return undefined;
    if (url.endsWith(repoUrl(app))) return { status: 200, json: { has_actions: true } };
    if (url.includes(`${repoUrl(app)}/commits`)) return { status: 200, json: [{ sha: 'headsha1234' }] };
    if (url.includes(`${repoUrl(app)}/actions/tasks`)) {
      return { status: 200, json: { total_count: 1, workflow_runs: [{ head_sha: 'headsha1234', status: 'success' }] } };
    }
    return undefined;
  });
  try {
    const r = await refreshActionsStage(app, { force: true });
    assert.equal(r.status, 'ok');
    assert.equal(app.pipeline.actions, 'ok');
  } finally {
    fake.restore();
  }
});

test('latest run FAILED → failing (never ok) + REGISTRY_PASS secret re-asserted', async () => {
  const app = await liveApp('Failed Run');
  const fake = fakeForgejo((method, url) => {
    if (method === 'GET' && url.endsWith(repoUrl(app))) return { status: 200, json: { has_actions: true } };
    if (method === 'GET' && url.includes(`${repoUrl(app)}/commits`)) return { status: 200, json: [{ sha: 'headshafail' }] };
    if (method === 'GET' && url.includes(`${repoUrl(app)}/actions/tasks`)) {
      return { status: 200, json: { total_count: 1, workflow_runs: [{ head_sha: 'headshafail', status: 'failure' }] } };
    }
    if (method === 'PUT' && url.includes('/actions/secrets/REGISTRY_PASS')) return { status: 204 };
    return undefined;
  });
  try {
    const r = await refreshActionsStage(app, { force: true });
    assert.equal(r.status, 'failing', 'a failed run must be SAID, not counted as ok');
    assert.match(r.note ?? '', /FAILED/);
    assert.equal(app.pipeline.actions, 'failing');
    const heal = fake.calls.find((c) => c.method === 'PUT' && c.url.includes('/actions/secrets/REGISTRY_PASS'));
    assert.ok(heal, 'a failed run must re-assert the REGISTRY_PASS Actions secret (idempotent heal)');
  } finally {
    fake.restore();
  }
});

test('latest run still RUNNING → pending with an in-progress note, not ok', async () => {
  const app = await liveApp('Running Run');
  const fake = fakeForgejo((method, url) => {
    if (method !== 'GET') return undefined;
    if (url.endsWith(repoUrl(app))) return { status: 200, json: { has_actions: true } };
    if (url.includes(`${repoUrl(app)}/commits`)) return { status: 200, json: [{ sha: 'headsharun1' }] };
    if (url.includes(`${repoUrl(app)}/actions/tasks`)) {
      return { status: 200, json: { total_count: 1, workflow_runs: [{ head_sha: 'headsharun1', status: 'running' }] } };
    }
    return undefined;
  });
  try {
    const r = await refreshActionsStage(app, { force: true });
    assert.equal(r.status, 'pending');
    assert.match(r.note ?? '', /not finished/);
    assert.ok(!fake.calls.some((c) => c.method === 'PUT' && c.url.includes('/actions/secrets/')), 'no secret heal for an in-progress run');
  } finally {
    fake.restore();
  }
});

test('newest run for head wins: an old failure below a fresh success stays ok', async () => {
  const app = await liveApp('Rerun Ok');
  const fake = fakeForgejo((method, url) => {
    if (method !== 'GET') return undefined;
    if (url.endsWith(repoUrl(app))) return { status: 200, json: { has_actions: true } };
    if (url.includes(`${repoUrl(app)}/commits`)) return { status: 200, json: [{ sha: 'headrerun99' }] };
    if (url.includes(`${repoUrl(app)}/actions/tasks`)) {
      // Forgejo lists tasks newest-first: the re-run succeeded, the first try failed.
      return {
        status: 200,
        json: {
          total_count: 2,
          workflow_runs: [
            { head_sha: 'headrerun99', status: 'success' },
            { head_sha: 'headrerun99', status: 'failure' },
          ],
        },
      };
    }
    return undefined;
  });
  try {
    const r = await refreshActionsStage(app, { force: true });
    assert.equal(r.status, 'ok', 'the newest run for the head sha decides');
  } finally {
    fake.restore();
  }
});

test('latest push with NO Actions run → stalled, never ok', async () => {
  const app = await liveApp('Stalled');
  const fake = fakeForgejo((method, url) => {
    if (method !== 'GET') return undefined;
    if (url.endsWith(repoUrl(app))) return { status: 200, json: { has_actions: true } };
    if (url.includes(`${repoUrl(app)}/commits`)) return { status: 200, json: [{ sha: 'headsha9999' }] };
    if (url.includes(`${repoUrl(app)}/actions/tasks`)) return { status: 200, json: { total_count: 0, workflow_runs: [] } };
    return undefined;
  });
  try {
    const r = await refreshActionsStage(app, { force: true });
    assert.equal(r.status, 'stalled');
    assert.match(r.note ?? '', /NO Actions run/, 'stalled must explain itself');
    assert.equal(app.pipeline.actions, 'stalled');
  } finally {
    fake.restore();
  }
});

test('unreachable Forgejo leaves the stage untouched and SAYS so', async () => {
  const app = await liveApp('Unreachable');
  app.pipeline.actions = 'pending';
  // No fetch stub: the clusterless test env has no Forgejo — fetch fails → status 0.
  const r = await refreshActionsStage(app, { force: true });
  assert.equal(r.status, 'pending');
  assert.match(r.note ?? '', /unreachable/);
});

// ---- Cancelled + skipped conclusions (the two missing conclusions) ---

test('latest run CANCELLED → failing (same branch as failure) + REGISTRY_PASS heal', async () => {
  // Per apps.ts:1297 — `failure` and `cancelled` share a branch → 'failing'.
  const app = await liveApp('Cancelled Run');
  const fake = fakeForgejo((method, url) => {
    if (method === 'GET' && url.endsWith(repoUrl(app))) return { status: 200, json: { has_actions: true } };
    if (method === 'GET' && url.includes(`${repoUrl(app)}/commits`)) return { status: 200, json: [{ sha: 'headcancelled' }] };
    if (method === 'GET' && url.includes(`${repoUrl(app)}/actions/tasks`)) {
      return { status: 200, json: { total_count: 1, workflow_runs: [{ head_sha: 'headcancelled', status: 'cancelled' }] } };
    }
    if (method === 'PUT' && url.includes('/actions/secrets/REGISTRY_PASS')) return { status: 204 };
    return undefined;
  });
  try {
    const r = await refreshActionsStage(app, { force: true });
    assert.equal(r.status, 'failing', 'a cancelled run maps to failing (not pending/ok)');
    assert.match(r.note ?? '', /FAILED/, 'the note must say FAILED so the UI shows it honestly');
    assert.equal(app.pipeline.actions, 'failing');
    const heal = fake.calls.find((c) => c.method === 'PUT' && c.url.includes('/actions/secrets/REGISTRY_PASS'));
    assert.ok(heal, 'a cancelled run must also trigger the REGISTRY_PASS heal (same branch as failure)');
  } finally {
    fake.restore();
  }
});

test('latest run SKIPPED → pending (honest in-progress note, not ok)', async () => {
  // Per apps.ts:1314 — any status that is not '' and not 'success' falls into
  // the pending branch. 'skipped' is such a status.
  const app = await liveApp('Skipped Run');
  const fake = fakeForgejo((method, url) => {
    if (method !== 'GET') return undefined;
    if (url.endsWith(repoUrl(app))) return { status: 200, json: { has_actions: true } };
    if (url.includes(`${repoUrl(app)}/commits`)) return { status: 200, json: [{ sha: 'headskipped1' }] };
    if (url.includes(`${repoUrl(app)}/actions/tasks`)) {
      return { status: 200, json: { total_count: 1, workflow_runs: [{ head_sha: 'headskipped1', status: 'skipped' }] } };
    }
    return undefined;
  });
  try {
    const r = await refreshActionsStage(app, { force: true });
    assert.equal(r.status, 'pending', 'a skipped run is not finished — stage must be pending');
    assert.match(r.note ?? '', /not finished/, 'the note must surface the status so the operator knows');
    assert.equal(app.pipeline.actions, 'pending');
    assert.ok(!fake.calls.some((c) => c.method === 'PUT' && c.url.includes('/actions/secrets/')), 'no heal for a skipped run');
  } finally {
    fake.restore();
  }
});

// -------------------------------------------- 3. commit auto-heal (repo vanished)

/**
 * The honest-failure LOOP fix: when the app's Forgejo repo has VANISHED (a
 * repo-level 404), a commit fails honestly ("committed 0/N … the app is
 * unchanged") but nothing re-provisions the repo, so every retry fails the same
 * way. `commitToApp` now distinguishes a repo-level 404 (heal-able) from a
 * per-file 404 / sha conflict (never heal), self-heals the repo ONCE via
 * `healAppRepo`, and RETRIES the commit once.
 */

const versionOk = (url: string) => url.endsWith('/api/v1/version');
const repoRoot = (slug: string) => new RegExp(`/api/v1/repos/[^/]+/${slug}$`);

test('commit into a VANISHED repo → auto-heal + retry lands (repo-404 ≠ file-404)', async () => {
  const app = await createApp(dev, { name: 'Heal Then Commit', template: 'sovereign-app' });
  // Model the repo coming into existence via heal: the repo-create POST flips it on.
  let repoExists = false;
  const fake = fakeForgejo((method, url) => {
    if (versionOk(url)) return { status: 200, json: { version: '11.0.0' } };
    // Repo-existence probe (both the backend's classifier and healAppRepo use it).
    if (method === 'GET' && repoRoot(app.slug).test(url)) {
      return repoExists ? { status: 200, json: { full_name: app.repo.fullName, has_actions: true } } : { status: 404, json: { message: 'not found' } };
    }
    // healAppRepo re-creates the repo (POST /user/repos) — flip existence on.
    if (method === 'POST' && url.endsWith('/api/v1/user/repos')) {
      repoExists = true;
      return { status: 201, json: { full_name: app.repo.fullName } };
    }
    // Content reads/writes: 404 while the repo is gone, succeed once it exists.
    if (contentsOf(url) && method === 'GET') {
      return repoExists ? { status: 404, json: { message: 'file not found' } } : { status: 404, json: { message: 'repo not found' } };
    }
    if (contentsOf(url) && (method === 'POST' || method === 'PUT')) {
      return repoExists ? { status: 201, json: { commit: { sha: 'c-heal' } } } : { status: 404, json: { message: 'repo not found' } };
    }
    return undefined; // actions-secret PUTs etc. default to 200
  });
  try {
    const { app: after, step } = await commitToApp(
      app.id,
      dev,
      [{ path: 'README.md', content: 'healed then committed' }],
      'rebuild story',
    );
    // The repo was re-created exactly once, then the commit succeeded on retry.
    assert.ok(fake.calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/v1/user/repos')), 'heal re-provisioned the vanished repo');
    assert.equal(step.ok, true, 'the retried commit lands');
    assert.match(step.detail, /committed \d+\/\d+/);
    assert.ok(after, 'the app record is returned (commit persisted)');
  } finally {
    fake.restore();
  }
});

test('heal that FAILS names the true state — never a bare per-file FAILED list', async () => {
  const app = await createApp(dev, { name: 'Heal Fails', template: 'sovereign-app' });
  const fake = fakeForgejo((method, url) => {
    if (versionOk(url)) return { status: 200, json: { version: '11.0.0' } };
    if (method === 'GET' && repoRoot(app.slug).test(url)) return { status: 404, json: { message: 'not found' } };
    // Re-provision is DENIED (e.g. quota / perms) — heal cannot recover the repo.
    if (method === 'POST' && url.endsWith('/api/v1/user/repos')) return { status: 403, json: { message: 'forbidden' } };
    if (contentsOf(url)) return { status: 404, json: { message: 'repo not found' } };
    return undefined;
  });
  try {
    await assert.rejects(
      commitToApp(app.id, dev, [{ path: 'README.md', content: 'x' }], 'try'),
      (e: Error) => {
        assert.match(e.message, /repository is missing and could not be re-provisioned/, 'the error names the TRUE state');
        assert.doesNotMatch(e.message, /^commit did not land/, 'not a bare per-file FAILED list');
        return true;
      },
    );
  } finally {
    fake.restore();
  }
});

test('a per-file SHA CONFLICT (422) does NOT trigger heal — repo is fine', async () => {
  const app = await createApp(dev, { name: 'Sha Not Heal', template: 'sovereign-app' });
  const fake = fakeForgejo((method, url) => {
    if (versionOk(url)) return { status: 200, json: { version: '11.0.0' } };
    // The repo EXISTS; the file exists with a sha; the UPDATE is rejected 422.
    if (method === 'GET' && repoRoot(app.slug).test(url)) return { status: 200, json: { has_actions: true } };
    if (contentsOf(url) && method === 'GET') {
      return { status: 200, json: { type: 'file', sha: 'blob-stale', encoding: 'base64', content: b64('old') } };
    }
    if (contentsOf(url) && method === 'PUT') return { status: 422, json: { message: 'sha mismatch' } };
    return undefined;
  });
  try {
    await assert.rejects(
      commitToApp(app.id, dev, [{ path: 'README.md', content: 'new' }], 'try'),
      (e: Error) => {
        assert.match(e.message, /commit did not land/, 'a sha conflict is an honest per-file failure, not a heal');
        assert.match(e.message, /sha conflict/, 'the reason names the sha conflict so the agent can re-read + retry');
        return true;
      },
    );
    // Heal must NOT have fired — no repo re-create for a healthy repo.
    assert.ok(!fake.calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/v1/user/repos')), 'no re-provision for a sha conflict');
  } finally {
    fake.restore();
  }
});

test('empty-snapshot heal still seeds the FULL scaffold incl. the CI workflow', async () => {
  // For an app whose in-process snapshot died with an old pod, healAppRepo has
  // nothing to restore beyond the template — it MUST re-seed the whole scaffold
  // (Dockerfile, app.yaml, AND `.forgejo/workflows/ci.yml`) so the next commit +
  // CI build works from a clean base.
  const { healAppRepo } = await import('@/lib/software/apps');
  const app = await createApp(dev, { name: 'Empty Snap Heal', template: 'sovereign-app' });
  app.mode = 'live'; // clusterless createApp lands offline; heal needs a live repo
  const fake = fakeForgejo((method, url) => {
    if (versionOk(url)) return { status: 200, json: { version: '11.0.0' } };
    if (method === 'GET' && repoRoot(app.slug).test(url)) return { status: 404, json: { message: 'not found' } };
    if (method === 'POST' && url.endsWith('/api/v1/user/repos')) return { status: 201, json: { full_name: app.repo.fullName } };
    // Every seed contents-POST succeeds.
    if (contentsOf(url)) return { status: 201, json: { content: {} } };
    return undefined;
  });
  try {
    const heal = await healAppRepo(app);
    assert.equal(heal.ok, true);
    assert.equal(heal.action, 'recreated');
    assert.ok(heal.seeded.includes('.forgejo/workflows/ci.yml'), 'the CI workflow must be seeded so a later commit can build');
    assert.ok(heal.seeded.length > 1, 'the FULL scaffold is seeded, not a bare README');
  } finally {
    fake.restore();
  }
});
