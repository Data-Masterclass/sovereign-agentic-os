/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       agents
 * FEATURE:    Ticking the grant tree must never delete a grant the narrowed feed cannot show
 * USER STORY: As an author of a system in one domain I can tick a folder in that domain without
 *             silently losing a grant the team already has into another domain.
 * ARCHITECTURE:
 *   - Tests `tabs/agents/lib/grant-apply.ts`, the reconcile lifted OUT of `GrantPickers.tsx`
 *     precisely so this round trip is testable (a test cannot import a `.tsx`).
 *   - The defect this pins: the feed is narrowed to the system's domain, so a foreign folder
 *     holds no feed items; `triState` calls an item-less folder 'none' and `computeSelection`
 *     skips it, so the selection the tree emits does NOT contain that folder — and the old
 *     reconcile read "absent from the selection" as "the user unticked it" and deleted it.
 *     The same applied to an ITEM grant whose id the narrowed feed no longer lists.
 *   - So the reconcile now takes what the feed could SHOW (`listedItemIds`) and what it
 *     deliberately kept out of the tree (`protectedFolders`), and removes only inside that.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyFolderSelection, folderGrantsOf } from '@tabs/agents/lib/grant-apply';
import { parseSystem } from '@tabs/agents/lib/system-schema';
import { setFolderGrant, setArtifactGrant } from '@tabs/agents/lib/simple-edit';

/** The smallest system document the schema accepts. */
function blankSystem() {
  return parseSystem('system:\n  name: Renewals desk\n  domain: autumn\nagents: []\n');
}

const layer = () => 'gold' as const;

/** A system in domain A holding: a legacy FILES folder grant into domain B, an in-domain
 *  folder grant, and an item grant on a dataset that the narrowed feed no longer lists. */
function systemWithLegacyGrants() {
  let sys = blankSystem();
  sys = setFolderGrant(sys, 'files', { path: '/northpeak/invoices PDF', scope: 'personal' }, false);
  sys = setFolderGrant(sys, 'files', { path: '/briefs', scope: 'personal' }, false);
  sys = setArtifactGrant(sys, 'data', 'ds_foreign', false, 'gold');
  sys = setArtifactGrant(sys, 'data', 'ds_local', false, 'gold');
  return sys;
}

test('GRANT-APPLY: a legacy out-of-domain FOLDER grant survives ticking another folder', () => {
  const sys = systemWithLegacyGrants();
  // What the tree emits after the author ticks /briefs: the foreign folder is not in the
  // selection at all, because the narrowed feed gave it no items and no node.
  const next = applyFolderSelection(
    sys,
    'files',
    { folderGrants: [{ path: '/briefs', scope: 'personal' }], itemGrants: [] },
    layer,
    { protectedFolders: [{ path: '/northpeak/invoices PDF', scope: 'personal' }] },
  );
  const paths = folderGrantsOf(next, 'files').map((f) => f.path);
  assert.ok(paths.includes('/northpeak/invoices PDF'), 'the out-of-domain grant is NOT deleted');
  assert.ok(paths.includes('/briefs'), 'the ticked in-domain folder is still granted');
});

test('GRANT-APPLY: an UNPROTECTED folder grant is still removed when de-selected', () => {
  const sys = systemWithLegacyGrants();
  const next = applyFolderSelection(
    sys,
    'files',
    { folderGrants: [{ path: '/northpeak/invoices PDF', scope: 'personal' }], itemGrants: [] },
    layer,
    { protectedFolders: [{ path: '/northpeak/invoices PDF', scope: 'personal' }] },
  );
  const paths = folderGrantsOf(next, 'files').map((f) => f.path);
  assert.ok(!paths.includes('/briefs'), 'de-selecting a folder the tree DID show still removes it');
});

test('GRANT-APPLY: an ITEM grant the narrowed feed no longer lists is not deleted', () => {
  const sys = systemWithLegacyGrants();
  // The feed lists only ds_local now (ds_foreign lives in another domain).
  const next = applyFolderSelection(
    sys,
    'data',
    { folderGrants: [], itemGrants: ['ds_local'] },
    layer,
    { listedItemIds: ['ds_local'] },
  );
  const ids = next.grants.data.filter((g) => !g.folder).map((g) => g.id);
  assert.ok(ids.includes('ds_foreign'), 'an unlisted item grant survives the round trip');
  assert.ok(ids.includes('ds_local'), 'the ticked item stays granted');
});

test('GRANT-APPLY: an item the feed DOES list is still removed when unticked', () => {
  const sys = systemWithLegacyGrants();
  const next = applyFolderSelection(
    sys,
    'data',
    { folderGrants: [], itemGrants: [] },
    layer,
    { listedItemIds: ['ds_local', 'ds_foreign'] },
  );
  const ids = next.grants.data.filter((g) => !g.folder).map((g) => g.id);
  assert.deepEqual(ids, [], 'both listed items were unticked, so both are gone');
});

test('GRANT-APPLY: with no feed information nothing is removed (fail safe, not fail destructive)', () => {
  const sys = systemWithLegacyGrants();
  const next = applyFolderSelection(sys, 'data', { folderGrants: [], itemGrants: [] }, layer);
  const ids = next.grants.data.filter((g) => !g.folder).map((g) => g.id);
  assert.deepEqual(ids.sort(), ['ds_foreign', 'ds_local'], 'an unknown universe removes nothing');
});

test('GRANT-APPLY: ticking an item ADDS it, and the write capability of a kept grant survives', () => {
  let sys = blankSystem();
  sys = setArtifactGrant(sys, 'data', 'ds_writer', true, 'gold');
  const next = applyFolderSelection(
    sys,
    'data',
    { folderGrants: [], itemGrants: ['ds_writer', 'ds_new'] },
    layer,
    { listedItemIds: ['ds_writer', 'ds_new'] },
  );
  const writer = next.grants.data.find((g) => g.id === 'ds_writer');
  assert.ok(writer, 'the existing grant is still there');
  assert.equal(writer?.capability, 'Write-bounded', 'and its write capability was NOT downgraded');
  assert.ok(next.grants.data.some((g) => g.id === 'ds_new'), 'the newly ticked item was added');
});

test('GRANT-APPLY: a MARKETPLACE item grant survives the first tick', () => {
  // Marketplace items are granted through the separate "+ Add from marketplace" picker and are
  // never tree-tickable, so they must not count as listed. Passing the WHOLE feed (tree items
  // plus marketplace) as `listedItemIds` deleted every marketplace grant on the first tick.
  let sys = blankSystem();
  sys = setArtifactGrant(sys, 'data', 'ds_certified', false, 'gold');
  sys = setArtifactGrant(sys, 'data', 'ds_local', false, 'gold');
  const treeIds = ['ds_local']; // what the TREE showed — marketplace is not in it
  const next = applyFolderSelection(
    sys,
    'data',
    { folderGrants: [], itemGrants: ['ds_local'] },
    layer,
    { listedItemIds: treeIds },
  );
  const ids = next.grants.data.filter((g) => !g.folder).map((g) => g.id).sort();
  assert.deepEqual(ids, ['ds_certified', 'ds_local'], 'the marketplace grant is still there');
});

test('GRANT-APPLY: the Workflows picker (manageFolders=false) touches no folder grant', () => {
  const sys = systemWithLegacyGrants();
  const next = applyFolderSelection(
    sys,
    'files',
    { folderGrants: [], itemGrants: [] },
    layer,
    { manageFolders: false, listedItemIds: [] },
  );
  assert.equal(folderGrantsOf(next, 'files').length, 2, 'both folder grants untouched');
});

test('GRANT-APPLY-TRIPWIRE: the picker delegates to the lib and passes both protections', () => {
  // Read, never import: a test cannot import a .tsx.
  const src = readFileSync(join(process.cwd(), 'tabs/agents/ui/GrantPickers.tsx'), 'utf8');
  assert.match(src, /from '@tabs\/agents\/lib\/grant-apply'/, 'the picker imports the reconcile');
  assert.ok(!/export function applyFolderSelection/.test(src), 'and no longer defines its own');
  assert.match(src, /protectedFolders/, 'it passes the out-of-domain folders it kept out of the tree');
  assert.match(
    src,
    /listedItemIds:\s*treeItems\.map/,
    'and the TREE\'s ids — not the whole feed, which would make a marketplace grant look unticked',
  );
  // The out-of-domain folder chip must be read-only: this picker cannot show what is inside a
  // folder in another domain, so raising its capability would grant write over contents the
  // author cannot inspect. Removing it stays allowed — that only reduces.
  assert.match(
    src,
    /canEdit=\{canEdit && !isOutside\(g\.folder!\)\}/,
    'the out-of-domain folder chip cannot have its access level raised',
  );
  // An item grant the narrowed feed did not return shows as a bare id; it must say why.
  assert.match(src, /isOutsideItem\(/, 'out-of-domain ITEM grants are badged too');
});
