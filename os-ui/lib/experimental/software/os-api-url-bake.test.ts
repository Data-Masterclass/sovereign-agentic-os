/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Tests for baking the OS public URL into a seeded app CI workflow (identity
 * delegation / SSO). Without the `--build-arg OS_API_URL=...` the built image's
 * VITE_OS_API is empty, so the deployed app's os.whoami() hits its OWN origin
 * (nginx index.html) and crashed with a JSON parse error on '<'.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Stub fetch before importing apps.ts (module-load pings OpenSearch); offline mode.
const _realFetch = globalThis.fetch;
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;
const { bakeOsApiUrlIntoWorkflow } = await import('./apps.ts');
globalThis.fetch = _realFetch;

import { ciWorkflowFile, viteOsFiles } from './scaffolds/vite-os.ts';

const OS_URL = 'https://agentic.datamasterclass.com';

test('bakes --build-arg OS_API_URL into a docker build line', () => {
  const wf = ciWorkflowFile('ops-hub').content;
  assert.ok(/docker build /.test(wf), 'the seeded workflow really has a docker build');
  const out = bakeOsApiUrlIntoWorkflow(wf, OS_URL);
  assert.match(out, /docker build --build-arg OS_API_URL='https:\/\/agentic\.datamasterclass\.com'/);
  // The build context (./src) and tags are preserved after the injected arg.
  assert.match(out, /--build-arg OS_API_URL='[^']+' -t /);
});

test('is idempotent — a second bake does not double the build arg', () => {
  const wf = ciWorkflowFile('ops-hub').content;
  const once = bakeOsApiUrlIntoWorkflow(wf, OS_URL);
  const twice = bakeOsApiUrlIntoWorkflow(once, OS_URL);
  assert.equal(once, twice);
  assert.equal((twice.match(/OS_API_URL=/g) ?? []).length, 1);
});

test('an empty OS URL leaves the workflow UNCHANGED (local dev — app derives at runtime)', () => {
  const wf = ciWorkflowFile('ops-hub').content;
  assert.equal(bakeOsApiUrlIntoWorkflow(wf, ''), wf);
  assert.equal(bakeOsApiUrlIntoWorkflow(wf, '   '), wf);
});

test('a trailing slash on the OS URL is trimmed before baking', () => {
  const wf = ciWorkflowFile('ops-hub').content;
  const out = bakeOsApiUrlIntoWorkflow(wf, 'https://agentic.datamasterclass.com/');
  assert.match(out, /OS_API_URL='https:\/\/agentic\.datamasterclass\.com'/);
  assert.doesNotMatch(out, /datamasterclass\.com\/'/);
});

test('a value containing a single quote is refused (shell-injection guard)', () => {
  const wf = ciWorkflowFile('ops-hub').content;
  assert.equal(bakeOsApiUrlIntoWorkflow(wf, "https://x'.com"), wf, 'unchanged — not injected');
});

test('the Dockerfile declares ARG OS_API_URL so the build arg is honoured', () => {
  const dockerfile = viteOsFiles('Ops Hub', 'ops-hub').find((f) => f.path === 'Dockerfile');
  assert.ok(dockerfile);
  assert.match(dockerfile!.content, /ARG OS_API_URL/);
  assert.match(dockerfile!.content, /ENV VITE_OS_API=\$OS_API_URL/);
});
