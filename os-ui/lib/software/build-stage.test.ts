/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Phase B — the OS build service's PIPELINE-STAGE TRUTH (apps.ts wiring). Pins:
 *   1. a submitted build → `harbor` stage `pending` + osBuild state recorded.
 *   2. a submit rejected for missing RBAC/namespace → `failing` + the SPECIFIC reason
 *      (and the Forgejo Actions fallback named) — never a silent or fabricated state.
 *   3. an unreachable cluster at submit → `offline` (not `failing`, not `ok`).
 *   4. a SUCCEEDED build pins `app.runImageDigest` to the captured digest ref and
 *      earns `harbor: ok` — the runner now serves digest-pinned.
 *   5. a FAILED build → `failing` with the Actions path named as still available.
 *   6. an unreachable cluster at poll time NEVER clobbers the recorded stage.
 *
 * The `SOFTWARE_BUILD_SERVICE` flag is set BEFORE importing apps.ts (config reads env
 * at import). The flag-OFF wiring is pinned in apps.test.ts (env unset there).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SOFTWARE_BUILD_SERVICE = 'true';

// Offline: reject every network call BEFORE importing apps.ts so the in-process app
// cache initialises empty (no OpenSearch) — the k8s client is INJECTED per test.
const _realFetch = globalThis.fetch;
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const { createApp, submitOsBuild, refreshBuildStage, defaultOsBuildState } = await import('./apps.ts');
import type { App } from './apps.ts';
import type { K8sClient } from './build-service.ts';
import type { CurrentUser } from '@/lib/core/auth';

const dev: CurrentUser = {
  id: 'pia',
  name: 'Pia',
  domains: ['eng'],
  allDomains: ['eng'],
  activeDomain: 'eng',
  role: 'builder',
};

const SHA = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
const DIGEST = 'sha256:' + 'd'.repeat(64);

async function liveApp(name: string): Promise<App> {
  const app = await createApp(dev, { name, template: 'vite-os' });
  app.mode = 'live';
  return app;
}

test.after(() => {
  globalThis.fetch = _realFetch;
});

// ------------------------------------------------------------- submit truth ---

test('submitOsBuild: a landed submission → harbor pending + osBuild recorded', async () => {
  const app = await liveApp('digest one');
  const fake: K8sClient = async () => ({ status: 201, body: {} });
  const res = await submitOsBuild(app, SHA, fake);
  assert.equal(res.submitted, true);
  assert.equal(res.ok, true);
  assert.equal(app.pipeline.harbor, 'pending', 'image-build stage is pending while the Job runs');
  assert.equal(app.osBuild?.sha, SHA);
  assert.equal(app.osBuild?.phase, 'pending');
  assert.match(app.osBuild?.jobName ?? '', /^build-digest-one-a1b2c3d4e5f6$/);
});

test('submitOsBuild: missing RBAC/namespace → harbor failing + the specific reason', async () => {
  const app = await liveApp('digest two');
  const fake: K8sClient = async () => ({ status: 403, body: {} });
  const res = await submitOsBuild(app, SHA, fake);
  assert.equal(res.submitted, true);
  assert.equal(res.ok, false);
  assert.equal(app.pipeline.harbor, 'failing');
  assert.match(res.detail, /RBAC/i, 'names the RBAC gap specifically');
  assert.match(res.detail, /Forgejo Actions path still builds/, 'names the working fallback');
  assert.equal(app.osBuild?.phase, 'failed');
});

test('submitOsBuild: unreachable cluster → harbor offline (not failing, never ok)', async () => {
  const app = await liveApp('digest three');
  const fake: K8sClient = async () => ({ status: 0, body: {} });
  const res = await submitOsBuild(app, SHA, fake);
  assert.equal(res.ok, false);
  assert.equal(app.pipeline.harbor, 'offline');
  assert.match(res.detail, /unreachable/);
});

// --------------------------------------------------------------- poll truth ---

test('refreshBuildStage: no build submitted yet → an honest "none yet" note, stage untouched', async () => {
  const app = await liveApp('digest four');
  app.osBuild = defaultOsBuildState();
  const before = app.pipeline.harbor;
  const out = await refreshBuildStage(app);
  assert.ok(out);
  assert.equal(out.status, before);
  assert.match(out.note ?? '', /no in-cluster build has been submitted/);
});

test('refreshBuildStage: a SUCCEEDED build pins runImageDigest + earns harbor ok', async () => {
  const app = await liveApp('digest five');
  const submit: K8sClient = async () => ({ status: 201, body: {} });
  await submitOsBuild(app, SHA, submit);
  const poll: K8sClient = async (method, path) => {
    if (path.includes('/jobs/')) return { status: 200, body: { status: { succeeded: 1 } } };
    if (path.includes('/pods?')) {
      return {
        status: 200,
        body: { items: [{ status: { containerStatuses: [{ name: 'kaniko', state: { terminated: { message: DIGEST } } }] } }] },
      };
    }
    // The digest-pin redeploy runs against the LIVE k8s (unreachable here) — that path
    // reports honestly and does not affect the pin itself.
    return { status: 0, body: {} };
  };
  const out = await refreshBuildStage(app, poll);
  assert.ok(out);
  assert.equal(out.status, 'ok');
  assert.equal(app.pipeline.harbor, 'ok', 'the image-build stage is EARNED from a real succeeded Job');
  assert.match(app.runImageDigest ?? '', new RegExp(`/digest-five@${DIGEST}$`), 'the serving ref is the captured digest');
  assert.equal(app.osBuild?.phase, 'succeeded');
  assert.equal(app.osBuild?.digest, app.runImageDigest);
  assert.match(out.note ?? '', /digest pinned/);
});

test('refreshBuildStage: a FAILED build → harbor failing + Actions named as fallback', async () => {
  const app = await liveApp('digest six');
  await submitOsBuild(app, SHA, async () => ({ status: 201, body: {} }));
  const poll: K8sClient = async (method, path) =>
    path.includes('/jobs/') ? { status: 200, body: { status: { failed: 1 } } } : { status: 200, body: { items: [] } };
  const out = await refreshBuildStage(app, poll);
  assert.ok(out);
  assert.equal(out.status, 'failing');
  assert.equal(app.pipeline.harbor, 'failing');
  assert.match(out.note ?? '', /FAILED/);
  assert.match(out.note ?? '', /Forgejo Actions remains available/);
  assert.equal(app.runImageDigest, undefined, 'a failed build never pins a digest');
});

test('refreshBuildStage: an unreachable cluster at poll time never clobbers the stage', async () => {
  const app = await liveApp('digest seven');
  await submitOsBuild(app, SHA, async () => ({ status: 201, body: {} }));
  assert.equal(app.pipeline.harbor, 'pending');
  const poll: K8sClient = async () => ({ status: 0, body: {} });
  const out = await refreshBuildStage(app, poll);
  assert.ok(out);
  assert.equal(out.status, 'pending', 'the recorded state stands; nothing is fabricated');
  assert.equal(app.pipeline.harbor, 'pending');
  assert.match(out.note ?? '', /unreachable/);
});

test('refreshBuildStage: a running build reports pending with the live phase', async () => {
  const app = await liveApp('digest eight');
  await submitOsBuild(app, SHA, async () => ({ status: 201, body: {} }));
  const poll: K8sClient = async (method, path) =>
    path.includes('/jobs/') ? { status: 200, body: { status: { active: 1 } } } : { status: 200, body: { items: [] } };
  const out = await refreshBuildStage(app, poll);
  assert.ok(out);
  assert.equal(out.status, 'pending');
  assert.match(out.note ?? '', /building a1b2c3d4e5/);
  assert.equal(app.osBuild?.phase, 'running');
});
