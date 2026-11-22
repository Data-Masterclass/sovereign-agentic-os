/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The user-confirmation store — single use, expiry, ownership, hash stability, and
 *             the "Allow for this conversation" allowance.
 * USER STORY: As a user I want the exact action I confirmed to run once, as me, in time — and an
 *             allowance I gave for one tool in one conversation to cover nothing else.
 * ARCHITECTURE: the real in-process store (`server-only` neutralised by the test loader); time is
 *             passed in (`at`), the durable mirror is a stubbed OpenSearch where a test needs it.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIRMATION_TTL_MS,
  SESSION_ALLOWANCE_TTL_MS,
  __resetConfirmations,
  __simulateRestart,
  argsHashOf,
  beginExecute,
  confirmationPort,
  createConfirmation,
  declineConfirmation,
  ensureHydrated,
  expireConfirmations,
  finishExecute,
  getConfirmationForUser,
  grantSessionAllowance,
  listPendingForConversation,
  revokeSessionAllowances,
  sessionAllows,
} from '@core/policy/confirmations';
import { SESSION_ALLOWABLE_TOOLS } from '@core/mcp/tool-classes';
import { userConfirmGate } from '@core/runtime/confirm-gate';

beforeEach(() => __resetConfirmations());

const T0 = Date.parse('2026-11-19T12:00:00.000Z');
const base = { userId: 'rae', conversationId: 'conv-1', surface: 'ask' as const, tool: 'create_dataset', args: { name: 'Orders', domain: 'sales' }, traceId: 'ask-t1' };

test('create: a pending record with a 128-bit id, the full args, their hash and a ten-minute expiry', () => {
  const c = createConfirmation(base, { at: T0 });
  assert.match(c.id, /^cfm_[0-9a-f]{32}$/, '128 random bits, hex');
  assert.equal(c.status, 'pending');
  assert.deepEqual(c.args, base.args);
  assert.equal(c.argsHash, argsHashOf(base.tool, base.args));
  assert.match(c.argsHash, /^[0-9a-f]{64}$/);
  assert.equal(c.createdAt, '2026-11-19T12:00:00.000Z');
  assert.equal(c.expiresAt, '2026-11-19T12:10:00.000Z');
  assert.equal(CONFIRMATION_TTL_MS, 10 * 60 * 1000, 'the owner chose ten minutes');
  assert.equal(c.surface, 'ask');
  assert.equal(c.traceId, 'ask-t1');
  const ids = new Set(Array.from({ length: 200 }, () => createConfirmation(base, { at: T0 }).id));
  assert.equal(ids.size, 200, 'ids do not repeat');
  assert.throws(() => createConfirmation({ ...base, userId: '' }), /needs a userId/);
});

test('the stored args are a private copy: mutating the caller\'s object changes nothing that was confirmed', () => {
  const args = { name: 'Orders', nested: { tier: 'gold' } };
  const c = createConfirmation({ ...base, args }, { at: T0 });
  args.name = 'Payroll';
  args.nested.tier = 'bronze';
  const stored = getConfirmationForUser(c.id, 'rae', { at: T0 })!;
  assert.deepEqual(stored.args, { name: 'Orders', nested: { tier: 'gold' } });
  assert.equal(beginExecute(c.id, 'rae', { at: T0 }).ok, true);
});

test('hash stability: key order and string whitespace never change the hash; a real difference always does', () => {
  const h = argsHashOf('create_dataset', { name: 'Orders', domain: 'sales', cols: [{ a: 1, b: 2 }] });
  assert.equal(argsHashOf('create_dataset', { domain: 'sales', cols: [{ b: 2, a: 1 }], name: 'Orders' }), h, 'key order');
  assert.equal(argsHashOf('create_dataset', { name: '  Orders ', domain: 'sales', cols: [{ a: 1, b: 2 }] }), h, 'surrounding whitespace');
  assert.equal(argsHashOf('create_dataset', { name: 'Orders', domain: 'sales', cols: [{ a: 1, b: 2 }] }), h, 'deterministic');
  assert.notEqual(argsHashOf('create_dataset', { name: 'Payroll', domain: 'sales', cols: [{ a: 1, b: 2 }] }), h, 'a different value');
  assert.notEqual(argsHashOf('retire_dataset', { name: 'Orders', domain: 'sales', cols: [{ a: 1, b: 2 }] }), h, 'a different tool');
  assert.notEqual(argsHashOf('create_dataset', { name: 'Orders', domain: 'sales', cols: [{ b: 2 }, { a: 1 }] }), h, 'array shape is significant');
});

test('SINGLE USE: exactly one beginExecute succeeds; every later one finds the record no longer pending', () => {
  const c = createConfirmation(base, { at: T0 });
  const first = beginExecute(c.id, 'rae', { at: T0 + 1000 });
  assert.equal(first.ok, true);
  assert.ok(first.ok && first.confirmation.status === 'executing');
  assert.ok(first.ok && first.confirmation.args.name === 'Orders', 'the caller runs the STORED args');
  assert.deepEqual(beginExecute(c.id, 'rae', { at: T0 + 1001 }), { ok: false, code: 'not_pending', status: 'executing' });

  assert.equal(finishExecute(c.id, 'executed', 'created ds_ab12cd')?.status, 'executed');
  assert.equal(finishExecute(c.id, 'failed'), null, 'only an executing record can be finished');
  assert.deepEqual(beginExecute(c.id, 'rae', { at: T0 + 2000 }), { ok: false, code: 'not_pending', status: 'executed' });
  assert.equal(declineConfirmation(c.id, 'rae', { at: T0 + 2000 }), null, 'an executed confirmation cannot be declined');
  assert.equal(getConfirmationForUser(c.id, 'rae', { at: T0 + 2000 })?.outcome, 'created ds_ab12cd');

  const failed = createConfirmation(base, { at: T0 });
  assert.equal(beginExecute(failed.id, 'rae', { at: T0 }).ok, true);
  assert.equal(finishExecute(failed.id, 'failed', 'role floor')?.status, 'failed');
  assert.equal(beginExecute(failed.id, 'rae', { at: T0 }).ok, false, 'a failed execution is not retried on the same confirmation');
  assert.equal(finishExecute('cfm_nope', 'executed'), null);
});

test('EXPIRY: usable up to the last millisecond, expired at ten minutes, and expired is final', () => {
  const c = createConfirmation(base, { at: T0 });
  assert.equal(getConfirmationForUser(c.id, 'rae', { at: T0 + CONFIRMATION_TTL_MS - 1 })?.status, 'pending');
  assert.deepEqual(beginExecute(c.id, 'rae', { at: T0 + CONFIRMATION_TTL_MS }), { ok: false, code: 'expired', status: 'expired' });
  assert.equal(getConfirmationForUser(c.id, 'rae', { at: T0 })?.status, 'expired', 'an earlier clock does not revive it');
  assert.equal(declineConfirmation(c.id, 'rae', { at: T0 }), null);

  const a = createConfirmation(base, { at: T0 });
  const b = createConfirmation(base, { at: T0 + 5 * 60 * 1000 });
  const done = createConfirmation(base, { at: T0 });
  beginExecute(done.id, 'rae', { at: T0 });
  assert.equal(expireConfirmations({ at: T0 + CONFIRMATION_TTL_MS }), 1, 'only the overdue PENDING one');
  assert.equal(getConfirmationForUser(a.id, 'rae', { at: T0 })?.status, 'expired');
  assert.equal(getConfirmationForUser(b.id, 'rae', { at: T0 + CONFIRMATION_TTL_MS })?.status, 'pending');
  assert.equal(getConfirmationForUser(done.id, 'rae', { at: T0 + CONFIRMATION_TTL_MS * 9 })?.status, 'executing', 'expiry never touches a record that left pending');
  assert.equal(createConfirmation(base, { at: T0, ttlMs: 1000 }).expiresAt, '2026-11-19T12:00:01.000Z');
});

test('WRONG USER behaves exactly as NOT FOUND — for reading, confirming and declining', () => {
  const c = createConfirmation(base, { at: T0 });
  assert.equal(getConfirmationForUser(c.id, 'mallory', { at: T0 }), null);
  assert.deepEqual(beginExecute(c.id, 'mallory', { at: T0 }), { ok: false, code: 'not_found' });
  assert.deepEqual(beginExecute('cfm_00000000000000000000000000000000', 'mallory', { at: T0 }), { ok: false, code: 'not_found' }, 'indistinguishable from a missing id');
  assert.equal(declineConfirmation(c.id, 'mallory', { at: T0 }), null);
  assert.equal(getConfirmationForUser(c.id, 'rae', { at: T0 })?.status, 'pending', 'the attempts changed nothing');
  // A different conversation of the SAME user is not a place to confirm it from either.
  assert.deepEqual(beginExecute(c.id, 'rae', { at: T0, conversationId: 'conv-2' }), { ok: false, code: 'not_found' });
  assert.equal(beginExecute(c.id, 'rae', { at: T0, conversationId: 'conv-1' }).ok, true);
});

test('DECLINE: pending → declined, once; a declined confirmation can never execute', () => {
  const c = createConfirmation(base, { at: T0 });
  assert.equal(declineConfirmation(c.id, 'rae', { at: T0 + 5 })?.status, 'declined');
  assert.equal(declineConfirmation(c.id, 'rae', { at: T0 + 6 }), null);
  assert.deepEqual(beginExecute(c.id, 'rae', { at: T0 + 7 }), { ok: false, code: 'not_pending', status: 'declined' });
});

test('listPendingForConversation: only that user, that conversation, still pending — oldest first', () => {
  const a = createConfirmation(base, { at: T0 });
  const b = createConfirmation({ ...base, tool: 'upload_file' }, { at: T0 + 1000 });
  createConfirmation({ ...base, conversationId: 'conv-2' }, { at: T0 });
  createConfirmation({ ...base, userId: 'mallory' }, { at: T0 });
  declineConfirmation(createConfirmation(base, { at: T0 }).id, 'rae', { at: T0 });
  assert.deepEqual(listPendingForConversation('rae', 'conv-1', { at: T0 + 2000 }).map((c) => c.id), [a.id, b.id]);
  assert.deepEqual(listPendingForConversation('rae', 'conv-1', { at: T0 + CONFIRMATION_TTL_MS + 500 }).map((c) => c.id), [b.id]);
});

test('ALLOWANCE: only a SESSION_ALLOWABLE tool can be granted, and it covers exactly one user, conversation and tool', () => {
  for (const tool of Object.keys(SESSION_ALLOWABLE_TOOLS)) {
    assert.equal(grantSessionAllowance({ userId: 'rae', conversationId: 'conv-1', tool }, { at: T0 }).ok, true, tool);
  }
  __resetConfirmations();
  for (const tool of ['delete', 'archive', 'retire', 'retire_dataset', 'request_deploy', 'request_promotion', 'promote', 'decide_approval', 'publish_workflow', 'no_such_tool', 'constructor', '']) {
    const r = grantSessionAllowance({ userId: 'rae', conversationId: 'conv-1', tool }, { at: T0 });
    assert.equal(r.ok, false, `${tool} must not be grantable`);
    assert.equal(sessionAllows({ userId: 'rae', conversationId: 'conv-1', tool }, { at: T0 }), false);
  }
  assert.deepEqual(grantSessionAllowance({ userId: 'rae', conversationId: 'conv-1', tool: 'delete' }), { ok: false, code: 'not_allowable' });
  assert.deepEqual(grantSessionAllowance({ userId: '', conversationId: 'conv-1', tool: 'create_dataset' }), { ok: false, code: 'invalid' });

  const g = grantSessionAllowance({ userId: 'rae', conversationId: 'conv-1', tool: 'create_dataset', viaConfirmationId: 'cfm_1' }, { at: T0 });
  assert.ok(g.ok && g.allowance.viaConfirmationId === 'cfm_1');
  const q = (over: Partial<{ userId: string; conversationId: string; tool: string }>, at = T0 + 1) =>
    sessionAllows({ userId: 'rae', conversationId: 'conv-1', tool: 'create_dataset', ...over }, { at });
  assert.equal(q({}), true);
  assert.equal(q({ tool: 'upload_file' }), false, 'another tool');
  assert.equal(q({ conversationId: 'conv-2' }), false, 'another conversation');
  assert.equal(q({ userId: 'mallory' }), false, 'another user');
  assert.equal(q({}, T0 + SESSION_ALLOWANCE_TTL_MS), false, 'it lapses');
  assert.equal(q({}, T0 + 1), false, 'and a lapsed allowance is gone, not dormant');

  grantSessionAllowance({ userId: 'rae', conversationId: 'conv-1', tool: 'create_dataset' }, { at: T0 });
  grantSessionAllowance({ userId: 'rae', conversationId: 'conv-1', tool: 'upload_file' }, { at: T0 });
  assert.equal(revokeSessionAllowances('rae', 'conv-1', 'upload_file'), 1);
  assert.equal(q({}), true);
  assert.equal(revokeSessionAllowances('rae', 'conv-1'), 1);
  assert.equal(q({}), false);
});

test('THE PORT + THE GATE: a write parks into the store; after the allowance it runs; a non-allowable tool still parks', async () => {
  const reached: string[] = [];
  const gate = userConfirmGate(async (name) => { reached.push(name); return { text: 'ok', isError: false }; }, { userId: 'rae', conversationId: 'conv-1', surface: 'tab:data', traceId: 't-9' }, confirmationPort());

  const parked = await gate('create_dataset', { name: 'Orders' });
  assert.ok(parked.parked);
  const rec = getConfirmationForUser(parked.parked!.confirmationId, 'rae');
  assert.equal(rec?.status, 'pending');
  assert.equal(rec?.surface, 'tab:data');
  assert.equal(rec?.traceId, 't-9');
  assert.deepEqual(rec?.args, { name: 'Orders' });
  assert.equal(parked.parked!.expiresAt, rec?.expiresAt);
  assert.deepEqual(reached, []);

  assert.equal(grantSessionAllowance({ userId: 'rae', conversationId: 'conv-1', tool: 'create_dataset' }).ok, true);
  assert.deepEqual(await gate('create_dataset', { name: 'Refunds' }), { text: 'ok', isError: false });
  assert.deepEqual(reached, ['create_dataset']);

  // Even if the user "allowed" it by some other route, a non-allowable tool cannot be granted — so it parks.
  assert.equal(grantSessionAllowance({ userId: 'rae', conversationId: 'conv-1', tool: 'retire_dataset' }).ok, false);
  assert.ok((await gate('retire_dataset', { id: 'ds_1' })).parked);
  assert.deepEqual(reached, ['create_dataset']);
});

test('THE MIRROR never receives the arguments, and a record read back after a restart cannot be executed', async () => {
  const realFetch = globalThis.fetch;
  const stored = new Map<string, Record<string, unknown>>();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (/_search\?size=\d+$/.test(url)) {
      return new Response(JSON.stringify({ hits: { hits: [...stored.values()].map((s) => ({ _source: s })) } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (/\/_doc\//.test(url) && (init?.method === 'PUT' || init?.method === 'POST')) {
      const doc = JSON.parse(String(init.body)) as Record<string, unknown>;
      stored.set(String(doc.id), doc);
      return new Response('{"result":"created"}', { status: 201, headers: { 'content-type': 'application/json' } });
    }
    return new Response(init?.method === 'HEAD' ? null : '{"count":0}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    __resetConfirmations(); // forget any dead-mirror verdict from earlier tests
    const open = createConfirmation({ ...base, tool: 'configure_connection', args: { connId: 'c1', password: 'hunter2' } }, { at: T0 });
    const done = createConfirmation(base, { at: T0 });
    beginExecute(done.id, 'rae', { at: T0 });
    finishExecute(done.id, 'executed', 'ok');
    await new Promise((r) => setTimeout(r, 30)); // the write-through is fire-and-forget
    assert.equal(stored.size, 2, 'both records were written through');
    for (const doc of stored.values()) {
      assert.equal('args' in doc, false, 'the arguments must not reach the mirror');
      assert.doesNotMatch(JSON.stringify(doc), /hunter2/);
      assert.match(String(doc.argsHash), /^[0-9a-f]{64}$/, 'the hash does');
    }

    __simulateRestart();
    assert.equal(getConfirmationForUser(open.id, 'rae', { at: T0 }), null, 'gone from the process after the restart');
    await ensureHydrated();
    const back = getConfirmationForUser(open.id, 'rae', { at: T0 + 1 });
    assert.equal(back?.status, 'expired', 'an open record without its arguments is dead — the user is asked again');
    assert.deepEqual(beginExecute(open.id, 'rae', { at: T0 + 1 }), { ok: false, code: 'expired', status: 'expired' });
    assert.equal(getConfirmationForUser(done.id, 'rae', { at: T0 + 1 })?.status, 'executed', 'a settled record keeps its status');
    assert.equal(beginExecute(done.id, 'rae', { at: T0 + 1 }).ok, false, 'and a restart never makes an executed confirmation usable again');
  } finally {
    globalThis.fetch = realFetch;
  }
});
