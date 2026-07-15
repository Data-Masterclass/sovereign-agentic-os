/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __resetAudit, record } from './audit.ts';
import { _resetAudit as _resetPersistent, listAudit } from '../platform-admin/audit.ts';

/**
 * Audit consolidation: Governance no longer keeps a PARALLEL in-memory-only log.
 * Every governance `record()` write-throughs into the persistent Admin audit
 * store (lib/platform-admin/audit.ts → os-audit ring + durable mirror), so the
 * two tabs read ONE durable, restart-surviving trail. The hash-chain integrity
 * over governance events is preserved for the Governance view's verify badge.
 */
beforeEach(() => {
  (globalThis as { fetch: unknown }).fetch = async () => { throw new Error('offline'); };
  __resetAudit();
  _resetPersistent();
});

test('governance record() write-throughs into the persistent Admin store', () => {
  record({ actor: 'bea', action: 'deploy', subject: 'app1', domain: 'sales', reason: 'approved' });
  record({ actor: 'sara', action: 'cost.cap.set', subject: 'domain:finance', domain: 'finance', reason: 'set cap' });

  // The SAME events are now visible through the persistent Admin store — the one
  // Governance/Monitoring both read — so they survive a process restart.
  const persisted = listAudit({ limit: 100 });
  const govActions = persisted.filter((e) => e.action.startsWith('governance.'));
  assert.equal(govActions.length, 2, 'both governance events landed in the persistent store');

  const deploy = govActions.find((e) => e.action === 'governance.deploy');
  assert.ok(deploy, 'deploy event present in persistent store');
  assert.equal(deploy!.actor, 'bea');
  assert.equal(deploy!.target, 'app1');
  // Reason rides in `detail`, with the domain preserved as a parseable prefix.
  assert.equal(deploy!.detail, '[domain:sales] approved');
});

test('governance write-through does not drop the domain/scope', () => {
  record({ actor: 'kenji', action: 'role.change', subject: 'amir', domain: 'legal', reason: 'promoted' });
  const e = listAudit({ prefix: 'governance.' })[0];
  assert.ok(e, 'entry present');
  // The domain rides along so the Governance view can scope a Builder to their domains.
  assert.match(JSON.stringify(e), /legal/);
});
