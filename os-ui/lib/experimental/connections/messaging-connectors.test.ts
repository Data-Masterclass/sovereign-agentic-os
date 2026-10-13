/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Store-level governance proof for the messaging + calendar connectors
 * (slack / gmail / gcal / outlook / teams). Exercises the SAME governed path the UI
 * + MCP use — createConnection → callConnectionTool — so the five non-negotiables are
 * provable with `node --test`:
 *   • reads auto-allow (decision: allow), writes are HELD (requires_approval),
 *     destructive deletes are DENIED (Blocked),
 *   • an unseeable connection id returns not_found (no existence leak),
 *   • the secret NEVER serializes into the connection record or a tool result.
 * fetch is stubbed offline, so an allowed read runs the real executor and honestly
 * degrades to `{ ok:false, unreachable }` — the DECISION is the gate we assert.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const _realFetch = globalThis.fetch;
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;
const { createConnection, callConnectionTool, getConnectionForUser, __resetConnections } = await import('./store.ts');

const admin = { id: 'a1', name: 'Admin', domains: ['sales'], role: 'admin' as const };
const other = { id: 'o1', name: 'Other', domains: ['ops'], role: 'admin' as const };

const CASES = [
  { template: 'slack' as const, read: 'list_channels', write: 'post_message', del: 'delete_message', token: 'xoxb-secret-value-1234567890' },
  { template: 'gmail' as const, read: 'list_labels', write: 'send_message', del: 'delete_message', token: 'ya29.secret-value-1234567890' },
  { template: 'gcal' as const, read: 'list_calendars', write: 'create_event', del: 'delete_event', token: 'ya29.secret-cal-1234567890' },
  { template: 'outlook' as const, read: 'get_message', write: 'send_mail', del: 'delete_message', token: 'eyJsecret-graph-1234567890' },
  { template: 'teams' as const, read: 'list_teams', write: 'post_channel_message', del: 'delete_channel_message', token: 'eyJsecret-teams-1234567890' },
];

for (const cs of CASES) {
  test(`${cs.template}: reads auto-allow · writes held for approval · deletes Blocked`, async () => {
    __resetConnections();
    const c = await createConnection(admin, { name: cs.template, template: cs.template, endpoint: '', credential: cs.token });

    // Read: the gate allows it (executor runs; offline it honestly degrades, but the DECISION is allow).
    const read = await callConnectionTool(c.id, admin, { tool: cs.read });
    assert.equal(read.decision, 'allow', `${cs.read} should auto-allow (read)`);

    // Write: never auto-runs — held for a human (Write-approval).
    const write = await callConnectionTool(c.id, admin, { tool: cs.write, args: { to: 'x@y.com', subject: 's', text: 't', channel: 'C1', teamId: 'T1', channelId: 'C1', summary: 'm', start: 's', end: 'e' } });
    assert.equal(write.decision, 'requires_approval', `${cs.write} must be held (never auto-send/post)`);

    // Delete: Blocked → denied even for an admin (needs an explicit Admin override to enable).
    const del = await callConnectionTool(c.id, admin, { tool: cs.del });
    assert.equal(del.decision, 'deny', `${cs.del} must be Blocked`);
  });

  test(`${cs.template}: an unseeable connection id returns not_found (no existence leak)`, async () => {
    __resetConnections();
    const c = await createConnection(admin, { name: cs.template, template: cs.template, endpoint: '', credential: cs.token });
    // `other` is in a different domain → the Personal connection is invisible → 404.
    await assert.rejects(() => getConnectionForUser(c.id, other), /not found/i);
    await assert.rejects(() => callConnectionTool(c.id, other, { tool: cs.read }), /not found/i);
  });

  test(`${cs.template}: the raw token NEVER serializes into the record or a tool result`, async () => {
    __resetConnections();
    const c = await createConnection(admin, { name: cs.template, template: cs.template, endpoint: '', credential: cs.token });
    // The record carries only a secretRef + a non-reversible fingerprint — never the value.
    assert.ok(!JSON.stringify(c).includes(cs.token), 'token must not be in the connection record');
    assert.ok(c.secretFingerprint.startsWith('sha256:'), 'record shows only a fingerprint');
    assert.ok(c.secretRef.name && c.secretRef.key, 'record carries a secretRef, not the value');
    const res = await callConnectionTool(c.id, admin, { tool: cs.read });
    assert.ok(!JSON.stringify(res).includes(cs.token), 'token must not appear in a tool result');
  });
}

test('restore global fetch', () => {
  globalThis.fetch = _realFetch;
});
