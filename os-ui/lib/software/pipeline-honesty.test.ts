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

test('a rejected write is reported as a FAILURE — 422 is never success', async () => {
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
    const { step } = await commitToApp(app.id, dev, [{ path: 'README.md', content: 'new' }], 'try');
    assert.equal(step.ok, false, 'a 422 write must fail the step (the old code counted it as success)');
    assert.match(step.detail, /FAILED: README\.md/);
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
