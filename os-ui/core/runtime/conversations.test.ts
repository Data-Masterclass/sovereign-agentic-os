/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Home chat history — conversations stored per user, private by default
 * USER STORY: As a user I want my conversations kept for me and only me: listed, reopened and
 *             continued later, and invisible to every other user, on every door.
 * ARCHITECTURE: the real in-process store plus a stubbed OpenSearch mirror for the restart test;
 *             the MCP door is the real `handleRpc`.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import {
  __resetConversations,
  __simulateRestart,
  deleteConversation,
  ensureHydrated,
  getConversation,
  listConversations,
  saveTurn,
} from '@core/runtime/conversations';
import { handleRpc } from '@core/mcp/server';

beforeEach(() => __resetConversations());

const A: CurrentUser = { id: 'u-a', name: 'Ada', domains: ['sales'], role: 'creator' };
const B: CurrentUser = { id: 'u-b', name: 'Ben', domains: ['sales'], role: 'creator' };
const turn = (q: string, a: string) => ({ user: q, assistant: { content: a, steps: [{ name: 'whoami', isError: false }], pending: [] } });

test('a turn creates a conversation titled from the first question; later turns append', () => {
  assert.equal(saveTurn(A.id, 'conv-aaaaaaaa', turn('What data do I have?', 'Three data products.')).ok, true);
  assert.equal(saveTurn(A.id, 'conv-aaaaaaaa', turn('And files?', 'Two files.')).ok, true);
  const c = getConversation(A.id, 'conv-aaaaaaaa');
  assert.equal(c?.title, 'What data do I have?');
  assert.deepEqual(c?.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(listConversations(A.id).length, 1);
});

test('USER B cannot list, read, continue or delete user A\'s conversation (store)', () => {
  saveTurn(A.id, 'conv-aaaaaaaa', turn('secret plan', 'ok'));
  assert.deepEqual(listConversations(B.id), [], 'not listed');
  assert.equal(getConversation(B.id, 'conv-aaaaaaaa'), null, 'not readable');
  const cont = saveTurn(B.id, 'conv-aaaaaaaa', turn('hijack', 'x'));
  assert.deepEqual(cont, { ok: false, code: 'not_found' }, 'not continuable (same answer as "does not exist")');
  assert.equal(deleteConversation(B.id, 'conv-aaaaaaaa'), false, 'not deletable');
  const still = getConversation(A.id, 'conv-aaaaaaaa');
  assert.equal(still?.messages.length, 2, 'A\'s conversation is untouched');
});

test('NEGATIVE TWIN: the owner can list, read, continue and delete their own', () => {
  saveTurn(A.id, 'conv-aaaaaaaa', turn('q', 'a'));
  assert.equal(listConversations(A.id).length, 1);
  assert.ok(getConversation(A.id, 'conv-aaaaaaaa'));
  assert.equal(saveTurn(A.id, 'conv-aaaaaaaa', turn('q2', 'a2')).ok, true);
  assert.equal(deleteConversation(A.id, 'conv-aaaaaaaa'), true);
  assert.equal(getConversation(A.id, 'conv-aaaaaaaa'), null);
});

test('USER B cannot list or read user A\'s conversation through the MCP door either', async () => {
  saveTurn(A.id, 'conv-aaaaaaaa', turn('secret plan', 'ok'));
  const call = (user: CurrentUser, name: string, args: Record<string, unknown>) =>
    handleRpc(user, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const text = (r: Awaited<ReturnType<typeof call>>) => JSON.stringify(r?.result ?? r?.error);

  const bList = await call(B, 'list_conversations', {});
  assert.doesNotMatch(text(bList), /conv-aaaaaaaa|secret plan/);
  const bGet = await call(B, 'get_conversation', { id: 'conv-aaaaaaaa' });
  assert.doesNotMatch(text(bGet), /secret plan/);
  assert.equal((bGet?.result as { isError?: boolean } | undefined)?.isError, true, 'a typed not_found');
  assert.match(text(bGet), /not_found/);

  const aList = await call(A, 'list_conversations', {});
  assert.match(text(aList), /conv-aaaaaaaa/, 'twin: A sees their own');
  const aGet = await call(A, 'get_conversation', { id: 'conv-aaaaaaaa' });
  assert.match(text(aGet), /secret plan/);
});

test('history survives a restart through the mirror, and a pending write\'s arguments are never stored', async () => {
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
    __resetConversations();
    saveTurn(A.id, 'conv-aaaaaaaa', {
      user: 'make a connection',
      assistant: { content: 'Needs your OK.', steps: [], pending: [{ confirmationId: 'cfm_1', tool: 'configure_connection', args: { password: 'hunter2' } }] },
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(stored.size, 1);
    assert.doesNotMatch(JSON.stringify([...stored.values()]), /hunter2/, 'no arguments reach the mirror');
    __simulateRestart();
    assert.equal(getConversation(A.id, 'conv-aaaaaaaa'), null);
    await ensureHydrated();
    const back = getConversation(A.id, 'conv-aaaaaaaa');
    assert.equal(back?.messages.length, 2, 'the conversation came back');
    assert.equal(getConversation(B.id, 'conv-aaaaaaaa'), null, 'and is still only A\'s');
  } finally {
    globalThis.fetch = realFetch;
  }
});
