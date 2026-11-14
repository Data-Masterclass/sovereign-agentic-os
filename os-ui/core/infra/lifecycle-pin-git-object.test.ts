/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       infra
 * FEATURE:    The `lifecycle-pin` git-object resolver — the reader half of the pin writer
 * USER STORY: As an IT reviewer I want "what is live" to have a history I can read in the drawer
 *             and over the MCP, in the domain whose repo carries it — and a pin in a domain I am
 *             not a member of to answer exactly what a pin that does not exist answers
 *             (checklist G3/G5/G7).
 * ARCHITECTURE:
 *   - `fetch` is stubbed to fail, so the durable mirror is dead and the index hydrates from an
 *     empty-but-readable repo root: a fresh tenant is a FACT, which is what makes the writer
 *     usable in a unit test (the September-2026 rule).
 *   - The pin is set with `commit: false` — this file measures the RESOLVER, not the commit path,
 *     which `lifecycle-pins.test.ts` already exercises against a real bare repo.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const pins = await import('./lifecycle-pins.ts');

const ACTOR = { id: 'u1', name: 'Alex', email: 'alex@example.com' };
const SHA = 'a'.repeat(40);
const MEMBER = { id: 'u1', domains: ['sales'], role: 'creator' };
const OUTSIDER = { id: 'u2', domains: ['ops'], role: 'creator' };
const ADMIN = { id: 'u3', domains: [], role: 'admin' };

const temps: string[] = [];

beforeEach(async () => {
  pins.__resetLifecyclePins();
  // An EMPTY but READABLE repo root: a fresh tenant owns nothing, which is an answer — so the
  // index is `hydrated` and the writer below is allowed to run.
  const repos = mkdtempSync(join(tmpdir(), 'lifecycle-pin-obj-'));
  temps.push(repos);
  await pins.hydrateForTests({ reposDir: repos });
  assert.equal(pins.pinsHydrationState(), 'hydrated');
});
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

async function pinOne(): Promise<void> {
  await pins.setLivePin('agent', 's1', SHA, ACTOR, 'sales', { commit: false }, 'agents/x/system.yaml');
}

test('G3: a live pin resolves to its domain and to the committed pin file, with the pin key as the trailer', async () => {
  await pinOne();
  const loc = await pins.lifecyclePinGitObjectResolver(MEMBER, 'agent:s1');
  assert.ok(loc);
  assert.equal(loc.domain, 'sales');
  assert.deepEqual(loc.paths, [pins.LIFECYCLE_PIN_PATH]);
  assert.equal(loc.paths[0], 'os/lifecycle/pins.yml', 'the file is the one the writer commits, not the flat os/lifecycle.yml');
  assert.equal(loc.trailerId, 'agent:s1', '`setLivePin` stamps `OS-Object: <kind>:<id>`');
});

test('G3: a member of another domain gets the same answer as for a pin that does not exist', async () => {
  await pinOne();
  const outside = await pins.lifecyclePinGitObjectResolver(OUTSIDER, 'agent:s1');
  const absent = await pins.lifecyclePinGitObjectResolver(MEMBER, 'agent:never-pinned');
  assert.equal(outside, null);
  assert.deepEqual(outside, absent, 'a pin must not be probeable for existence from outside its domain');
});

test('G3: an admin sees every domain’s pin', async () => {
  await pinOne();
  const loc = await pins.lifecyclePinGitObjectResolver(ADMIN, 'agent:s1');
  assert.equal(loc?.domain, 'sales');
});

test('G3: a malformed object id is not found — never a guess', async () => {
  await pinOne();
  for (const id of ['', 'agent', 'nonsense:s1', ':s1']) {
    assert.equal(await pins.lifecyclePinGitObjectResolver(MEMBER, id), null, id);
  }
});
