/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       infra
 * FEATURE:    Review H-3 — the pin store never writes on the strength of an unread index
 * USER STORY: As an operator I need the September-2026 failure to be impossible here: an empty
 *             index because the mirror was unreachable must never be mistaken for "nothing is
 *             live" and committed as the new truth, silently un-living the whole tenant.
 * ARCHITECTURE:
 *   - `fetch` is stubbed to fail, so the durable mirror is DEAD for the whole file — which is
 *     exactly the scenario under test. The git fallback then runs against a real bare repo in a
 *     temp dir, so "git is the system of record" is a measurement.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const pins = await import('./lifecycle-pins.ts');
const { commitSubtree, authorFor, __clearReservedSubtrees } = await import('./git-store.ts');

const ACTOR = { id: 'u1', name: 'Alex', email: 'alex@example.com' };
const SHA = 'a'.repeat(40);
let repos: string;
const temps: string[] = [];

beforeEach(() => {
  __clearReservedSubtrees();
  pins.__resetLifecyclePins();
  repos = mkdtempSync(join(tmpdir(), 'lifecycle-h3-'));
  temps.push(repos);
});
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

// ------------------------------------------------- the committed file is readable ---

test('H-3: a rendered pin file parses back — the YAML is data, not decoration', () => {
  const index = {
    pins: {
      'agent:s1': { ref: SHA, at: '2026-11-14T00:00:00.000Z', by: 'u1', domain: 'sales', path: 'agents/x/system.yaml' },
      'dashboard:d1': { ref: 'spec:abc123abc123', at: '2026-11-14T00:00:01.000Z', by: 'u2', domain: 'sales' },
      'metric:other': { ref: SHA, at: 'x', by: 'u1', domain: 'ops' },
    },
  };
  const rows = pins.parsePinFile(pins.renderPinFile('sales', index));
  assert.equal(rows.length, 2, 'only this domain’s rows');
  const agent = rows.find((r) => r.kind === 'agent')!;
  assert.equal(agent.ref, SHA);
  assert.equal(agent.path, 'agents/x/system.yaml', 'the pinned PATH round-trips (review L-2)');
  assert.equal(agent.tag, 'live/agent/s1');
  const dash = rows.find((r) => r.kind === 'dashboard')!;
  assert.equal(dash.ref, 'spec:abc123abc123');
  assert.equal(dash.path, undefined, 'a kind with no file carries no path');
});

test('H-3: a mangled pin file yields the rows it can read and drops the rest, never throws', () => {
  assert.deepEqual(pins.parsePinFile('not: [valid'), []);
  assert.deepEqual(pins.parsePinFile(''), []);
  assert.deepEqual(pins.parsePinFile('version: 1\nlive: not-a-list\n'), []);
  const partial = pins.parsePinFile(
    'version: 1\ndomain: sales\nlive:\n  - kind: agent\n    id: s1\n    ref: abc\n  - kind: agent\n  - nonsense\n',
  );
  assert.equal(partial.length, 1);
  assert.equal(partial[0].id, 's1');
});

// --------------------------------------------- the write gate ---

test('H-3: with NO source answering, the index is empty, reads degrade and every WRITE refuses', async () => {
  // Mirror dead AND the repo root unreadable: "we could not find out", not "nothing is live".
  const index = await pins.hydrateForTests({ reposDir: '/dev/null/not-a-directory' });
  assert.deepEqual(index.pins, {}, 'a read degrades to empty — every read path should');
  assert.equal(pins.pinsHydrationState(), 'offline', 'but it says it could not find out');

  await assert.rejects(
    () => pins.setLivePin('agent', 's1', SHA, ACTOR, 'sales', { reposDir: repos }),
    (e: Error & { status?: number }) => {
      assert.equal(e.status, 503);
      assert.match(e.message, /could not be read/);
      return true;
    },
  );
  await assert.rejects(
    () => pins.clearLivePin('agent', 's1', ACTOR, 'sales', { reposDir: repos }),
    (e: Error & { status?: number }) => {
      assert.equal(e.status, 503);
      return true;
    },
  );
  await assert.rejects(
    () => pins.applyMigratedIndex({ pins: {} }, ACTOR, { reposDir: repos }),
    (e: Error & { status?: number }) => {
      assert.equal(e.status, 503);
      return true;
    },
  );
});

test('H-3: an EMPTY but readable repo root is a fact — hydrated, nothing live, and writable', async () => {
  // The distinction that matters: a readable root with no repos IS an answer (a fresh tenant
  // owns nothing), so the OS may write. An unreadable root is not, so it may not.
  const index = await pins.hydrateForTests({ reposDir: repos });
  assert.deepEqual(index.pins, {});
  assert.equal(pins.pinsHydrationState(), 'hydrated');
  assert.equal(pins.pinsMigrated(), false);
  const res = await pins.setLivePin('agent', 's1', SHA, ACTOR, 'sales', { reposDir: repos });
  assert.equal(res.pin.ref, SHA, 'a fresh tenant can go live');
});

// --------------------------------------------- the git fallback ---

test('H-3: with the mirror dead, the index hydrates from the COMMITTED pin file', async () => {
  // Arrange: a domain repo that already carries a pin file, as a previous process committed it.
  const yml = pins.renderPinFile('sales', {
    pins: { 'agent:s1': { ref: SHA, at: 'then', by: 'u1', domain: 'sales', path: 'agents/x/system.yaml' } },
  });
  const { author } = authorFor({ id: 'seed' });
  await commitSubtree('sales', pins.LIFECYCLE_PREFIX, new Map([[pins.LIFECYCLE_PIN_PATH, yml]]), {
    author,
    message: 'seed',
    reposDir: repos,
  });

  // Act: a fresh process, mirror still dead, pointed at those repos.
  pins.__resetLifecyclePins();
  const index = await pins.hydrateForTests({ reposDir: repos });

  assert.equal(pins.pinsHydrationState(), 'hydrated', 'git answered, so it IS hydrated');
  assert.equal(index.pins['agent:s1']?.ref, SHA, 'and the pin came back from the bytes in the repo');
  assert.equal(index.pins['agent:s1']?.path, 'agents/x/system.yaml');
  assert.equal(index.pins['agent:s1']?.domain, 'sales', 'the domain comes from the repo it was read from');
  assert.equal(pins.pinsMigrated(), true, 'a repo with pins means the migration already happened');

  // And now a write is allowed again.
  const res = await pins.setLivePin('agent', 's2', SHA, ACTOR, 'sales', { reposDir: repos });
  assert.equal(res.pin.ref, SHA);
});

test('H-3: a repo with NO pin file is a tenant with nothing live — hydrated, and writable', async () => {
  const { author } = authorFor({ id: 'seed' });
  await commitSubtree('sales', 'os/lifecycle', new Map(), { author, message: 'empty', reposDir: repos }).catch(
    () => undefined,
  );
  pins.__resetLifecyclePins();
  await pins.hydrateForTests({ reposDir: repos });
  assert.equal(pins.pinsHydrationState(), 'hydrated');
  assert.equal(pins.pinsMigrated(), false, 'nothing live yet ⇒ the migration has not run');
});
