/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RECORD_TOOLS, envelopeAllowsRecordTool, executeAppTool, recordActor } from './app-records.ts';
import { __resetAppRecordsCache } from './app-records-store.ts';
import type { App } from './apps.ts';

/** A minimal App stub carrying just the deploy envelope the gate reads. */
function appWith(approved: { writeTools: string[] } | null): App {
  return {
    deploy: { approved: approved as App['deploy']['approved'] },
  } as App;
}

/** Same stub, but with the app's own-records write access REVOKED (default flipped off). */
function appRevoked(approved: { writeTools: string[] } | null): App {
  return {
    recordWritesRevoked: true,
    deploy: { approved: approved as App['deploy']['approved'] },
  } as App;
}

/** A minimal App stub with the identity fields the record executor reads. */
function recordApp(slug: string, domain: string): App {
  return { slug, domain, deploy: { approved: null } } as unknown as App;
}

// Reads are always-on — never gated by the envelope.
test('envelope gate: reads (list/get) are always allowed, envelope or not', () => {
  const none = appWith(null);
  assert.deepEqual(envelopeAllowsRecordTool(none, RECORD_TOOLS.list), { ok: true });
  assert.deepEqual(envelopeAllowsRecordTool(none, RECORD_TOOLS.get), { ok: true });
});

// 0.6.97 DEFAULT: the app's OWN record writes are auto-approved out of the box —
// no manual write-approval step, even with NO approved deploy envelope at all.
test('envelope gate: the app\'s own record writes are ALLOWED by default (no envelope needed)', () => {
  assert.deepEqual(envelopeAllowsRecordTool(appWith(null), RECORD_TOOLS.add), { ok: true });
  assert.deepEqual(envelopeAllowsRecordTool(appWith(null), RECORD_TOOLS.export), { ok: true });
});

// REVOCABLE: once revoked, writes fall back to the explicit approved envelope and are
// denied with an HONEST, governance-naming reason when absent from it.
test('envelope gate: REVOKED — a write not in the approved envelope is denied with an honest reason', () => {
  const noEnvelope = envelopeAllowsRecordTool(appRevoked(null), RECORD_TOOLS.add);
  assert.equal(noEnvelope.ok, false);
  if (!noEnvelope.ok) {
    assert.match(noEnvelope.reason, /add_record/);
    assert.match(noEnvelope.reason, /REVOKED|approved deploy envelope/);
    assert.match(noEnvelope.reason, /request_deploy|Builder|un-revoke/);
  }

  // A revoked app with an approved envelope that does NOT list this write still denies it.
  const otherOnly = envelopeAllowsRecordTool(appRevoked({ writeTools: ['export_records'] }), RECORD_TOOLS.add);
  assert.equal(otherOnly.ok, false);
});

// REVOKED but explicitly approved via the envelope → allowed (the legacy gate still works).
test('envelope gate: REVOKED — a write present in the approved envelope is allowed', () => {
  assert.deepEqual(
    envelopeAllowsRecordTool(appRevoked({ writeTools: ['add_record', 'export_records'] }), RECORD_TOOLS.add),
    { ok: true },
  );
  assert.deepEqual(
    envelopeAllowsRecordTool(appRevoked({ writeTools: ['export_records'] }), RECORD_TOOLS.export),
    { ok: true },
  );
});

// ------------------------------------------- record routing → OS-side store --

// Record tools resolve to the durable OS-side store, not demo-seed / live-app,
// and a written record persists across the add → list round-trip.
test('executeAppTool: record tools hit the os-records-store and PERSIST (add → list)', async () => {
  __resetAppRecordsCache();
  const app = recordApp('crm', 'sales');
  const actor = recordActor({ id: 'sara', activeDomain: 'sales', domains: ['sales'] });

  const added = await executeAppTool(app, RECORD_TOOLS.add, { name: 'Acme' }, actor);
  assert.equal(added.source, 'os-records-store');
  const addedItem = added.added as { id: string; name: string };
  assert.equal(addedItem.name, 'Acme');

  const listed = await executeAppTool(app, RECORD_TOOLS.list, {}, actor);
  assert.equal(listed.source, 'os-records-store');
  const items = listed.items as Array<{ id: string; name: string }>;
  assert.equal(items.length, 1);
  assert.equal(items[0].id, addedItem.id);
  assert.equal(items[0].name, 'Acme');

  const got = await executeAppTool(app, RECORD_TOOLS.get, { id: addedItem.id }, actor);
  assert.equal(got.source, 'os-records-store');
  assert.equal((got.item as { id: string }).id, addedItem.id);

  const exported = await executeAppTool(app, RECORD_TOOLS.export, {}, actor);
  assert.equal(exported.source, 'os-records-store');
  assert.equal(exported.rows, 1);
});

// The add stamps the APP's owning domain (not the caller's) — a same-domain peer
// sees it (Domain), an other-domain user does not.
test('executeAppTool: record add stamps the app domain; My + Domain scoping holds', async () => {
  __resetAppRecordsCache();
  const app = recordApp('crm', 'sales');
  const author = recordActor({ id: 'sara', activeDomain: 'sales', domains: ['sales'] });
  await executeAppTool(app, RECORD_TOOLS.add, { name: 'Acme' }, author);

  const peer = recordActor({ id: 'amir', activeDomain: 'sales', domains: ['sales'] });
  const peerList = await executeAppTool(app, RECORD_TOOLS.list, {}, peer);
  assert.equal((peerList.items as unknown[]).length, 1);

  const outsider = recordActor({ id: 'kenji', activeDomain: 'finance', domains: ['finance'] });
  const outList = await executeAppTool(app, RECORD_TOOLS.list, {}, outsider);
  assert.equal((outList.items as unknown[]).length, 0);
});

// A record tool called WITHOUT an actor falls back to the honest demo seed
// (never leaks across scope) — non-record callers stay unaffected.
test('executeAppTool: a record tool without an actor degrades to demo-seed, not the store', async () => {
  __resetAppRecordsCache();
  const app = recordApp('crm', 'sales');
  const res = await executeAppTool(app, RECORD_TOOLS.list, {});
  assert.equal(res.source, 'demo-seed');
});
