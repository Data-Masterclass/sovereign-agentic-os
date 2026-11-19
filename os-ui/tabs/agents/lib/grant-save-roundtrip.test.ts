/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       agents
 * FEATURE:    Changing a folder grant in the builder reaches the saved definition — in the right lane
 * USER STORY: As the owner of a system that reads "My files" I move its Files grant to the
 *             Domain folder `/invoices`, where my twelve invoices are, and the next run finds them.
 * ARCHITECTURE:
 *   - Replays the builder's OWN state transition with the functions the components call:
 *     `checkedIdsFor` (what the tree draws ticked) → a tick → `computeFolderSelection` (what the
 *     tree emits) → `applyFolderSelection` (the reconcile) → `serializeSystem` → `parseSystem`.
 *     No component is imported: a test cannot load a `.tsx`, which is why all four are pure.
 *   - THE DEFECT THIS PINS. The ticks were derived by PATH ONLY, so a `/` grant on "My files"
 *     ticked every file under "Domain files" too. A system that could read nothing showed Domain
 *     `/invoices` as granted; there was nothing left to tick, the stored grant stayed
 *     `{ path: '/', scope: personal }`, and the run resolved 0 files. The selection had the mirror
 *     fault: it was reduced over both lanes at once and stamped with the lane that was clicked.
 *   - Also pinned: a grant the tree cannot draw (an empty output folder, a `/` on a kind whose
 *     tree has no "All" row) is not deleted by an unrelated tick; a single file can be granted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFolderSelection } from '@core/kernel/folders';
import { parseSystem, serializeSystem, type System } from '@tabs/agents/lib/system-schema';
import { removeFolderGrant, setFolderGrant } from '@tabs/agents/lib/simple-edit';
import {
  applyFolderSelection, checkedIdsFor, emptyFolderGrants, folderGrantCoverage, folderGrantsOf,
  rootGrantedScopes, treeProtectedFolders, zeroMatchWarning, isOutputFolder,
  type FolderedGrantKind, type TreeItemRef,
} from '@tabs/agents/lib/grant-apply';

/** The reported system, as it was read back from the store. */
const REPORTED = `system:
  name: Invoice desk
  domain: finance
agents:
  - id: reader
    role: Reads invoices
entrypoint: reader
grants:
  data:
    - id: ds_orders
      capability: Read
    - id: ''
      capability: Write-bounded
      folder: { path: /Finance/InvoiceProcessing/Processed, scope: domain }
  knowledge:
    - id: wf_invoice
      capability: Read
    - id: ''
      capability: Write-bounded
      folder: { path: /results, scope: personal }
    - id: ''
      capability: Write-bounded
      folder: { path: /Finance/InvoiceProcessing/Results, scope: domain }
  files:
    - id: ''
      capability: Read
      folder: { path: /, scope: personal }
  tools: [list_files, search_files, get_file]
outputs:
  - { kind: data, name: Processed, folder: { path: /Finance/InvoiceProcessing/Processed, scope: domain } }
  - { kind: knowledge, name: Result, folder: { path: /results, scope: personal } }
  - { kind: knowledge, name: Results, folder: { path: /Finance/InvoiceProcessing/Results, scope: domain } }
`;

const layer = () => 'gold' as const;
const invoices: TreeItemRef[] = Array.from({ length: 12 }, (_, i) => ({ id: `file_inv${i + 1}`, folder: '/invoices', scope: 'domain' as const }));
const contracts: TreeItemRef[] = [{ id: 'file_c1', folder: '/contracts', scope: 'domain' }];

/** One tick in the tree, end to end, exactly as `FolderResourcePicker` wires it. */
function tick(
  sys: System,
  kind: FolderedGrantKind,
  items: TreeItemRef[],
  nodes: { personal: { path: string }[]; domain: { path: string }[] },
  toggle: { ids: string[]; on: boolean; scope: 'personal' | 'domain'; root?: boolean },
): System {
  const rootGrantable = kind === 'files';
  const checked = new Set(checkedIdsFor(sys, kind, items));
  for (const id of toggle.ids) { if (toggle.on) checked.add(id); else checked.delete(id); }
  const held = new Set(rootGrantable ? rootGrantedScopes(sys, kind) : []);
  if (toggle.root && rootGrantable) { if (toggle.on) held.add(toggle.scope); else held.delete(toggle.scope); }
  const sel = computeFolderSelection({ nodes, items, checked, actingScope: toggle.scope, rootScopes: [...held] });
  return applyFolderSelection(sys, kind, sel, layer, {
    listedItemIds: items.map((i) => i.id),
    protectedFolders: treeProtectedFolders(sys, kind, items, { rootGrantable }),
  });
}

const roundTrip = (sys: System): System => parseSystem(serializeSystem(sys));
const filesNodes = { personal: [], domain: [{ path: '/invoices' }, { path: '/contracts' }] };

test('REPRO: a `/` grant on My files does not tick Domain /invoices — the tree shows what is granted', () => {
  const sys = parseSystem(REPORTED);
  // Before the fix this returned all twelve invoice ids: the builder showed Domain /invoices as
  // already granted while the stored grant was My files — so there was nothing to change.
  assert.deepEqual(checkedIdsFor(sys, 'files', [...invoices, ...contracts]), []);
});

test('REPRO: changing the Files grant to Domain /invoices is saved as { path: /invoices, scope: domain }', () => {
  const items = [...invoices, ...contracts];
  let sys = parseSystem(REPORTED);
  sys = tick(sys, 'files', items, filesNodes, { ids: invoices.map((i) => i.id), on: true, scope: 'domain' });
  const saved = folderGrantsOf(roundTrip(sys), 'files');
  assert.ok(saved.some((f) => f.path === '/invoices' && f.scope === 'domain'), JSON.stringify(saved));
  // The My-files grant matches nothing and cannot be drawn as a tick, so a tick elsewhere does
  // not delete it; the author removes it at its chip (✕), where its 0-files warning is shown.
  assert.deepEqual(emptyFolderGrants(sys, 'files', items), [{ path: '/', scope: 'personal' }]);
  const done = roundTrip(removeFolderGrant(sys, 'files', { path: '/', scope: 'personal' }));
  assert.deepEqual(done.grants.files, [{ id: '', capability: 'Read', folder: { path: '/invoices', scope: 'domain' } }]);
});

test('REPRO: ticking the ONE folder that holds every file grants that folder, not the whole lane', () => {
  // Only the twelve invoices exist. The old reducer collapsed "everything is ticked" to `/`.
  let sys = parseSystem(REPORTED);
  sys = tick(sys, 'files', invoices, { personal: [], domain: [{ path: '/invoices' }] }, { ids: invoices.map((i) => i.id), on: true, scope: 'domain' });
  const domain = folderGrantsOf(roundTrip(sys), 'files').filter((f) => f.scope === 'domain');
  assert.deepEqual(domain, [{ path: '/invoices', scope: 'domain' }]);
});

test('a folder grant is stamped with the lane of the folder, never the lane that was clicked', () => {
  // My files holds 3 root files; Domain holds the invoices. Unticking "All My files" used to turn
  // the fully ticked Domain folder into { /invoices, personal } — a folder that does not exist.
  const mine: TreeItemRef[] = [1, 2, 3].map((n) => ({ id: `file_m${n}`, folder: '/', scope: 'personal' as const }));
  const items = [...mine, ...invoices];
  let sys = parseSystem(REPORTED);
  sys = setFolderGrant(sys, 'files', { path: '/invoices', scope: 'domain' }, false);
  sys = tick(sys, 'files', items, { personal: [], domain: [{ path: '/invoices' }] }, { ids: mine.map((i) => i.id), on: false, scope: 'personal', root: true });
  assert.deepEqual(folderGrantsOf(roundTrip(sys), 'files'), [{ path: '/invoices', scope: 'domain' }]);
});

test('the "All" row grants `/` in its own lane only, and unticking a folder under it narrows it', () => {
  const items = [...invoices, ...contracts];
  let sys = removeFolderGrant(parseSystem(REPORTED), 'files', { path: '/', scope: 'personal' });
  sys = tick(sys, 'files', items, filesNodes, { ids: items.map((i) => i.id), on: true, scope: 'domain', root: true });
  assert.deepEqual(folderGrantsOf(roundTrip(sys), 'files'), [{ path: '/', scope: 'domain' }]);
  sys = tick(sys, 'files', items, filesNodes, { ids: contracts.map((i) => i.id), on: false, scope: 'domain' });
  assert.deepEqual(folderGrantsOf(roundTrip(sys), 'files'), [{ path: '/invoices', scope: 'domain' }]);
});

for (const kind of ['files', 'data', 'knowledge'] as const) {
  for (const scope of ['personal', 'domain'] as const) {
    for (const path of ['/reports', '/Finance/Invoice Processing/2026']) {
      test(`ROUND TRIP ${kind}: ticking ${path} in the ${scope} lane is saved and read back exactly`, () => {
        const other = scope === 'personal' ? 'domain' : 'personal';
        const items: TreeItemRef[] = [
          { id: 'a1', folder: path, scope },
          { id: 'a2', folder: path, scope },
          { id: 'b1', folder: '/elsewhere', scope },
          { id: 'c1', folder: path, scope: other }, // same path, other lane: must stay untouched
        ];
        const nodes = { personal: [{ path }], domain: [{ path }] };
        let sys = parseSystem('system:\n  name: T\n  domain: finance\nagents: []\n');
        sys = tick(sys, kind, items, nodes, { ids: ['a1', 'a2'], on: true, scope });
        const back = roundTrip(sys);
        assert.deepEqual(folderGrantsOf(back, kind), [{ path, scope }]);
        assert.deepEqual(checkedIdsFor(back, kind, items).sort(), ['a1', 'a2']);
      });
    }
    test(`ROUND TRIP ${kind}: a root (/) grant in the ${scope} lane is saved and read back exactly`, () => {
      const items: TreeItemRef[] = [{ id: 'r1', folder: '/', scope }, { id: 'r2', folder: '/x', scope }];
      let sys = parseSystem('system:\n  name: T\n  domain: finance\nagents: []\n');
      sys = setFolderGrant(sys, kind, { path: '/', scope }, false);
      const back = roundTrip(sys);
      assert.deepEqual(folderGrantsOf(back, kind), [{ path: '/', scope }]);
      assert.deepEqual(checkedIdsFor(back, kind, items).sort(), ['r1', 'r2']);
      const other: TreeItemRef[] = items.map((i) => ({ ...i, id: `o_${i.id}`, scope: scope === 'personal' ? 'domain' : 'personal' }));
      assert.deepEqual(checkedIdsFor(back, kind, other), [], 'a root grant ticks nothing in the other lane');
    });
  }
}

test('OUTPUT FOLDERS (id: \'\'): an unrelated tick does not delete the Write grant of an empty output folder', () => {
  // The knowledge output /results (My) holds nothing yet, but has a folder row — so it is a tree
  // node with no item, which the tree can never emit. It used to be read as "unticked".
  const items: TreeItemRef[] = [{ id: 'pk_note', folder: '/notes', scope: 'personal' }];
  const nodes = { personal: [{ path: '/results' }, { path: '/notes' }], domain: [] };
  let sys = parseSystem(REPORTED);
  sys = tick(sys, 'knowledge', items, nodes, { ids: ['pk_note'], on: true, scope: 'personal' });
  const back = roundTrip(sys);
  const results = back.grants.knowledge.find((g) => g.folder?.path === '/results');
  assert.equal(results?.capability, 'Write-bounded');
  assert.ok(back.grants.knowledge.some((g) => g.folder?.path === '/Finance/InvoiceProcessing/Results' && g.capability === 'Write-bounded'));
  assert.ok(back.grants.knowledge.some((g) => g.id === 'wf_invoice'), 'the item grant is kept');
  assert.ok(isOutputFolder(back, 'knowledge', { path: '/results', scope: 'personal' }));
});

test('OUTPUT FOLDERS: a `/` Write grant on data survives a tick (the data tree has no "All" row to emit it)', () => {
  const items: TreeItemRef[] = [{ id: 'ds_a', folder: '/', scope: 'personal' }, { id: 'ds_b', folder: '/x', scope: 'personal' }];
  let sys = parseSystem('system:\n  name: T\n  domain: finance\nagents: []\n');
  sys = setFolderGrant(sys, 'data', { path: '/', scope: 'personal' }, true);
  sys = tick(sys, 'data', items, { personal: [{ path: '/x' }], domain: [] }, { ids: ['ds_b'], on: false, scope: 'personal' });
  assert.deepEqual(roundTrip(sys).grants.data.filter((g) => g.folder), [{ id: '', capability: 'Write-bounded', folder: { path: '/', scope: 'personal' } }]);
});

test('a SINGLE file tick is stored (it used to store nothing and come back unticked)', () => {
  const items = [...invoices, ...contracts];
  let sys = removeFolderGrant(parseSystem(REPORTED), 'files', { path: '/', scope: 'personal' });
  sys = tick(sys, 'files', items, filesNodes, { ids: ['file_inv3'], on: true, scope: 'domain' });
  const back = roundTrip(sys);
  assert.deepEqual(back.grants.files, [{ id: 'file_inv3', capability: 'Read' }]);
  assert.deepEqual(checkedIdsFor(back, 'files', items), ['file_inv3']);
});

test('ZERO MATCH (builder): the My-files grant says it contains 0 files and where the files are', () => {
  const items = [...invoices, ...contracts];
  const root = folderGrantCoverage({ path: '/', scope: 'personal' }, items);
  assert.equal(zeroMatchWarning('files', root), 'This grant currently contains 0 files. 13 files are in Domain files.');
  const named = folderGrantCoverage({ path: '/invoices', scope: 'personal' }, items);
  assert.equal(zeroMatchWarning('files', named), 'This grant currently contains 0 files. 12 files are in Domain files /invoices.');
  // A grant matches its path exactly; a folder that differs only in letter case is pointed at.
  const cased = folderGrantCoverage({ path: '/Invoices', scope: 'domain' }, items);
  assert.equal(zeroMatchWarning('files', cased), 'This grant currently contains 0 files. 12 files are in Domain files /invoices.');
  assert.equal(zeroMatchWarning('files', folderGrantCoverage({ path: '/invoices', scope: 'domain' }, items)), null);
  assert.equal(zeroMatchWarning('data', folderGrantCoverage({ path: '/nope', scope: 'domain' }, [])), 'This grant currently contains 0 datasets.');
  assert.equal(
    zeroMatchWarning('knowledge', folderGrantCoverage({ path: '/k', scope: 'domain' }, [{ id: 'pk1', folder: '/k', scope: 'personal' }])),
    'This grant currently contains 0 knowledge items. 1 knowledge item is in My knowledge /k.',
  );
});
