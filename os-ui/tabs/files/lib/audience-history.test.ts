/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Every change of who can see a file is versioned and audited
 * USER STORY: As an auditor I want a file's promotion, certify, unshare or domain move to leave a
 *             version naming the change and a `governance.audience.change` audit event, and a
 *             version restore never to re-share or unshare a file behind the approval path.
 * ARCHITECTURE:
 *   - Twin of tabs/data/lib/audience-history.test.ts; the source-scan ratchet for this store lives
 *     there (one ratchet, both stores).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetStore,
  createFile,
  setDocs,
  moveFile,
  requestPromotion,
  applyApprovedFilePromotion,
  transition,
  listFileVersions,
  restoreFileVersion,
  getFile,
  moveFilesDomain,
  type Principal,
} from '@tabs/files/lib/store';
import { __resetLineage } from '@tabs/files/lib/lineage';
import { __resetStore as __resetFolders } from '@core/folders/index';
import { search, __resetAudit } from '@core/policy/audit';

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'creator' };
const bea: Principal = { id: 'bea', domains: ['sales'], role: 'builder' };
const sara: Principal = { id: 'sara', domains: ['sales'], role: 'admin' };

beforeEach(() => { __resetStore(); __resetLineage(); __resetFolders(); __resetAudit(); });

function documented(): string {
  const a = createFile(amir, { name: 'receipts.pdf', text: 'r' });
  setDocs(a.id, amir, { description: 'Goods receipts.', tags: ['ops'] });
  return a.id;
}

const audits = (id: string) => search({ action: 'audience.change' }).filter((e) => e.subject.startsWith(`file:${id} `));

test('file promotion writes a version naming the change and an audit event', () => {
  const id = documented();
  applyApprovedFilePromotion(requestPromotion(id, amir, {}), bea);
  const [a] = audits(id);
  assert.ok(a, 'no audit event');
  assert.equal(a.actor, 'bea');
  assert.match(a.reason, /^promote: tier dataset → asset, visibility private → domain, grants \+domain:sales$/);
  const [v] = listFileVersions(id, bea);
  assert.equal(v.author, 'bea');
  assert.match(v.summary, /^promote: tier dataset → asset, visibility private → domain/);
});

test('file certify and unshare are versioned and audited', () => {
  const id = documented();
  applyApprovedFilePromotion(requestPromotion(id, amir, {}), bea);
  transition(id, sara, 'certify', {});
  assert.ok(audits(id).some((e) => /^certify: tier asset → product/.test(e.reason)));
  assert.match(listFileVersions(id, sara)[0].summary, /^certify: tier asset → product/);
  transition(id, sara, 'decertify', {});
  transition(id, sara, 'unshare', {});
  assert.ok(audits(id).some((e) => /^unshare: tier asset → dataset/.test(e.reason)));
  assert.match(listFileVersions(id, amir)[0].summary, /^unshare: tier asset → dataset/);
});

test('restoring a pre-promotion version keeps the current audience (no silent unshare)', () => {
  const id = documented();
  moveFile(id, amir, '/old'); // a private-era version to restore
  const privateEra = listFileVersions(id, amir)[0].version;
  applyApprovedFilePromotion(requestPromotion(id, amir, {}), bea);
  const before = audits(id).length;
  restoreFileVersion(id, sara, privateEra);
  const f = getFile(id, bea).asset;
  assert.equal(f.tier, 'asset', 'restore must not unshare');
  assert.equal(f.visibility, 'domain');
  assert.ok(f.grants.some((g) => g.grantee.kind === 'domain' && g.grantee.id === 'sales'));
  assert.equal(audits(id).length, before, 'no audience change happened');
});

test('the audience version stores the state BEFORE the change, like every other entry in the log', () => {
  const id = documented();
  applyApprovedFilePromotion(requestPromotion(id, amir, {}), bea);
  const [v] = listFileVersions(id, bea);
  assert.match(v.summary, /^promote: /);
  const state = v.state as { yaml: string };
  assert.match(state.yaml, /tier: dataset/, 'the snapshot is the pre-promotion record');
  assert.doesNotMatch(state.yaml, /tier: asset/);
});

test('a file domain move is audited and versioned as the acting admin', () => {
  const id = documented();
  applyApprovedFilePromotion(requestPromotion(id, amir, {}), bea);
  assert.deepEqual(moveFilesDomain({ id }, 'finance', 'sara'), [id]);
  const a = audits(id).find((e) => e.reason.startsWith('move domain:'));
  assert.ok(a, 'no audit event for the move');
  assert.equal(a.actor, 'sara');
  assert.equal(a.reason, 'move domain: domain sales → finance, grants +domain:finance -domain:sales');
  const v = listFileVersions(id, { id: 'sara', domains: ['finance'], role: 'admin' })[0];
  assert.equal(v.author, 'sara');
  assert.match(v.summary, /^move domain: domain sales → finance/);
});
