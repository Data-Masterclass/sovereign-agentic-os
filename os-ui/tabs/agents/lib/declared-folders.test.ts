/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    A folder chosen while DEFINING an agent system exists from the save on
 * USER STORY: As an author I pick a new folder for my team's results (or grant a folder) and see
 *             it in Knowledge / Files / Data right after Save — before any run — or am told why not.
 * ARCHITECTURE:
 *   - Drives the real store save door (`writeFile` of system.yaml) and Build's safety net
 *     (`ensureSystemFolders`) against the real folder registry; no mocks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __resetStore, createSystem, readFile, writeFile, ensureSystemFolders } from '@tabs/agents/lib/store';
import { parseSystem, serializeSystem } from '@tabs/agents/lib/system-schema';
import { foldersNamedBy } from '@tabs/agents/lib/declared-folders';
import { __resetStore as resetFolders, listFolders } from '@core/folders/index';

const sara = { id: 'sara', domains: ['finance'], role: 'builder' as const };
const carl = { id: 'carl', domains: ['finance'], role: 'creator' as const };
const dina = { id: 'dina', domains: ['finance'], role: 'domain_admin' as const };

function reset() {
  __resetStore();
  resetFolders();
}

/** Save the system's yaml with `edit` applied, as `user` — the one save door every surface uses. */
function save(id: string, user: typeof sara, edit: (s: ReturnType<typeof parseSystem>) => void) {
  const f = readFile(id, user, 'system.yaml');
  const sys = parseSystem(f.content);
  edit(sys);
  return writeFile(id, user, { path: 'system.yaml', content: serializeSystem(sys), sha: f.sha });
}

const paths = (user: typeof sara, tab: 'knowledge' | 'files' | 'data', scope: 'personal' | 'domain') =>
  listFolders(user, tab, scope).map((n) => n.path);

test('a knowledge output in a NEW personal folder is in My knowledge right after Save — before any run', () => {
  reset();
  const sys = createSystem(sara, { name: 'Invoice team', domain: 'finance' });
  assert.deepEqual(paths(sara, 'knowledge', 'personal'), []);
  const saved = save(sys.id, sara, (s) => {
    s.outputs = [{ kind: 'knowledge', name: 'Result', folder: { path: '/results', scope: 'personal' } }];
  });
  assert.deepEqual(paths(sara, 'knowledge', 'personal'), ['/results']);
  assert.deepEqual(saved.folders?.warnings, []);
  assert.equal(listFolders(sara, 'knowledge', 'personal')[0].domain, 'finance');
});

test('a Domain files folder grant is created at Save when the saver may create domain folders', () => {
  reset();
  const sys = createSystem(dina, { name: 'Reports', domain: 'finance' });
  save(sys.id, dina, (s) => {
    s.grants.files = [{ id: '', capability: 'Read', folder: { path: '/Finance/Reports', scope: 'domain' } }];
  });
  assert.deepEqual(paths(dina, 'files', 'domain'), ['/Finance/Reports']);
  // Another member of the domain sees it in Domain files too.
  assert.deepEqual(paths(carl, 'files', 'domain'), ['/Finance/Reports']);
});

test('a creator naming a Domain folder that ALREADY exists gets no warning on save or build', () => {
  reset();
  // A domain admin made the folder (by hand, or by saving their own team).
  const dsys = createSystem(dina, { name: 'Admin team', domain: 'finance' });
  save(dsys.id, dina, (s) => {
    s.grants.files = [{ id: '', capability: 'Read', folder: { path: '/Finance/Out', scope: 'domain' } }];
  });
  const sys = createSystem(carl, { name: 'Carl team', domain: 'finance' });
  const saved = save(sys.id, carl, (s) => {
    s.outputs = [{ kind: 'files', name: 'Report', folder: { path: '/Finance/Out', scope: 'domain' } }];
  });
  assert.deepEqual(saved.folders?.warnings, []);
  assert.deepEqual(ensureSystemFolders(sys.id, carl).warnings, []);
});

test('a Domain folder the saver may NOT create is a warning in the save result — the save stands', () => {
  reset();
  const sys = createSystem(carl, { name: 'Carl team', domain: 'finance' });
  const saved = save(sys.id, carl, (s) => {
    s.outputs = [{ kind: 'files', name: 'Report', folder: { path: '/Finance/Out', scope: 'domain' } }];
  });
  // The save is stored…
  assert.match(readFile(sys.id, carl, 'system.yaml').content, /\/Finance\/Out/);
  // …the runner's own lane (where the engine writes first) exists…
  assert.deepEqual(paths(carl, 'files', 'personal'), ['/Finance/Out']);
  // …and the Domain folder is NOT silently skipped: it is reported.
  assert.deepEqual(paths(carl, 'files', 'domain'), []);
  assert.equal(saved.folders?.warnings.length, 1);
  const w = saved.folders!.warnings[0];
  assert.equal(w.scope, 'domain');
  assert.equal(w.status, 403);
  assert.match(w.message, /Domain files \/Finance\/Out was not created/);
});

test('Build is a safety net: folders missing at build time are created then', () => {
  reset();
  const sys = createSystem(sara, { name: 'Data team', domain: 'finance' });
  save(sys.id, sara, (s) => {
    s.outputs = [{ kind: 'data', name: 'Rows', folder: { path: '/landing', scope: 'personal' } }];
  });
  resetFolders(); // the rows are gone (e.g. saved before this release)
  assert.deepEqual(paths(sara, 'data', 'personal'), []);
  const out = ensureSystemFolders(sys.id, sara);
  assert.deepEqual(out.warnings, []);
  assert.deepEqual(paths(sara, 'data', 'personal'), ['/landing']);
});

test('foldersNamedBy: outputs (a Domain output also names the personal lane) + folder grants, root and duplicates dropped', () => {
  const sys = parseSystem(`system: { name: t, domain: finance, visibility: Personal }
agents: []
outputs:
  - { kind: knowledge, name: A, folder: { path: /results, scope: personal } }
  - { kind: knowledge, name: B, folder: { path: results/, scope: personal } }
  - { kind: data, name: C, folder: { path: /Shared/X, scope: domain } }
  - { kind: files, name: D, folder: { path: /, scope: personal } }
grants:
  knowledge: [{ id: '', capability: Read, folder: { path: /kb, scope: domain } }]
`);
  assert.deepEqual(foldersNamedBy(sys), [
    { kind: 'knowledge', scope: 'personal', path: '/results' },
    { kind: 'data', scope: 'personal', path: '/Shared/X' },
    { kind: 'data', scope: 'domain', path: '/Shared/X' },
    { kind: 'knowledge', scope: 'domain', path: '/kb' },
  ]);
});
