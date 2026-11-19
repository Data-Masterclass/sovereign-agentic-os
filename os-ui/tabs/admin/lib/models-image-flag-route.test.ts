/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        admin
 * FEATURE:    Route test — GET /api/agents/models carries the "Images: yes/no" flag
 * USER STORY: As a platform admin, the Images tag I see next to a model on Models & Providers is
 *             the allowlist's answer for that exact name — a model that merely sounds
 *             vision-capable still reads "no".
 * ARCHITECTURE:
 *   - Proves the flag is the allowlist's answer for the ALIAS, not the `tier` guess: a live model
 *     whose name contains "vision"/"vl", which the routing heuristics label `tier: 'vision'`, is
 *     still `images: false`; and that an override (valid or broken) is reported as it is applied.
 *   - Auth and the one LiteLLM read are mocked; the route and the capability map are real.
 */
import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

let LIVE: { ok: true; data: unknown[] } | { ok: false } = { ok: false };
mock.module('@core/kernel/auth', {
  namedExports: { requireUser: async () => ({ id: 'u1', name: 'Admin', domains: [], role: 'admin' }) },
});
mock.module('@core/infra/litellm-admin', {
  namedExports: { readModels: async () => LIVE },
});

const { GET } = await import('../../../app/api/agents/models/route.ts');

type Row = { model_name: string; tier: string; images: boolean };
type Body = { models: Row[]; source: string; imageInput: { models: string[]; source: string; warnings: string[] } };
const call = async () => (await (await GET()).json()) as Body;
const flags = (b: Body) => Object.fromEntries(b.models.map((m) => [m.model_name, m.images]));

const original = process.env.MODEL_IMAGE_ALLOWLIST;
afterEach(() => {
  if (original === undefined) delete process.env.MODEL_IMAGE_ALLOWLIST;
  else process.env.MODEL_IMAGE_ALLOWLIST = original;
  LIVE = { ok: false };
});

test('offline catalog: only sovereign-reasoning is flagged, and the list in force is reported', async () => {
  delete process.env.MODEL_IMAGE_ALLOWLIST;
  const body = await call();
  assert.equal(body.source, 'offline');
  assert.deepEqual(flags(body), {
    'sovereign-default': false,
    'sovereign-reasoning': true,
    'sovereign-embed': false,
    'sovereign-mock': false,
  });
  assert.equal(body.imageInput.source, 'default');
  assert.deepEqual(body.imageInput.models, ['sovereign-reasoning', 'sovereign-vision', 'sovereign-premium', 'sovereign-reasoning-fast']);
  assert.deepEqual(body.imageInput.warnings, []);
});

test('live catalog: a model the heuristics call "vision" tier is still Images: no', async () => {
  delete process.env.MODEL_IMAGE_ALLOWLIST;
  LIVE = {
    ok: true,
    data: [
      { model_name: 'sovereign-vision', litellm_params: { model: 'openai/Qwen/Qwen3-VL-235B-A22B-Instruct-FP8' } },
      { model_name: 'sovereign-default', litellm_params: { model: 'openai/gpt-oss-20b' } },
      { model_name: 'acme-vision-vl', litellm_params: { model: 'openai/some-vlm', api_base: 'https://api.example.com/v1' }, model_info: { db_model: true } },
    ],
  };
  const body = await call();
  assert.equal(body.source, 'litellm');
  assert.equal(body.models.find((m) => m.model_name === 'acme-vision-vl')?.tier, 'vision'); // the guess
  assert.deepEqual(flags(body), { 'sovereign-vision': true, 'sovereign-default': false, 'acme-vision-vl': false });
});

test('an admin override replaces the list, and the listing follows it', async () => {
  process.env.MODEL_IMAGE_ALLOWLIST = '["acme-vision-vl"]';
  LIVE = { ok: true, data: [{ model_name: 'sovereign-vision' }, { model_name: 'acme-vision-vl' }] };
  const body = await call();
  assert.deepEqual(flags(body), { 'sovereign-vision': false, 'acme-vision-vl': true });
  assert.deepEqual(body.imageInput, { models: ['acme-vision-vl'], source: 'override', warnings: [] });
});

test('a broken override is reported to the admin and the built-in list stays in force', async () => {
  process.env.MODEL_IMAGE_ALLOWLIST = 'sovereign-default';
  const warn = console.warn;
  console.warn = () => {};
  try {
    const body = await call();
    assert.equal(body.imageInput.source, 'default');
    assert.equal(body.imageInput.warnings.length, 1);
    assert.equal(flags(body)['sovereign-default'], false);
    assert.equal(flags(body)['sovereign-reasoning'], true);
  } finally {
    console.warn = warn;
  }
});
