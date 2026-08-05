/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RECORD_TOOLS, envelopeAllowsRecordTool } from './app-records.ts';
import type { App } from './apps.ts';

/** A minimal App stub carrying just the deploy envelope the gate reads. */
function appWith(approved: { writeTools: string[] } | null): App {
  return {
    deploy: { approved: approved as App['deploy']['approved'] },
  } as App;
}

// Reads are always-on — never gated by the envelope.
test('envelope gate: reads (list/get) are always allowed, envelope or not', () => {
  const none = appWith(null);
  assert.deepEqual(envelopeAllowsRecordTool(none, RECORD_TOOLS.list), { ok: true });
  assert.deepEqual(envelopeAllowsRecordTool(none, RECORD_TOOLS.get), { ok: true });
});

// Writes are denied with an HONEST, governance-naming reason when not approved.
test('envelope gate: a write not in the approved envelope is denied with an honest reason', () => {
  const noEnvelope = envelopeAllowsRecordTool(appWith(null), RECORD_TOOLS.add);
  assert.equal(noEnvelope.ok, false);
  if (!noEnvelope.ok) {
    assert.match(noEnvelope.reason, /add_record/);
    assert.match(noEnvelope.reason, /approved deploy envelope/);
    assert.match(noEnvelope.reason, /request_deploy|Builder/);
  }

  // An approved envelope that does NOT list this write still denies it.
  const otherOnly = envelopeAllowsRecordTool(appWith({ writeTools: ['export_records'] }), RECORD_TOOLS.add);
  assert.equal(otherOnly.ok, false);
});

// A write listed in the approved envelope is allowed.
test('envelope gate: a write present in the approved envelope is allowed', () => {
  assert.deepEqual(
    envelopeAllowsRecordTool(appWith({ writeTools: ['add_record', 'export_records'] }), RECORD_TOOLS.add),
    { ok: true },
  );
  assert.deepEqual(
    envelopeAllowsRecordTool(appWith({ writeTools: ['export_records'] }), RECORD_TOOLS.export),
    { ok: true },
  );
});
