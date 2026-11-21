/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The LangChain gateway model of a native agent module (WP-53) carries the SYSTEM's own key
 * USER STORY: As a platform admin I want a run on the native LangGraph module path to spend on the
 *             agent system's own random key (its budget and limits), read from the encrypted store,
 *             and to stop with "press Build" when there is none — never to fall back to the shared key.
 * ARCHITECTURE:
 *   - Real pieces: `ChatOpenAI` as `gatewayChatModel` builds it, the in-memory key store with a real
 *     AES-GCM seal, `resolveSystemKey`.
 *   - Negative twins: a keyRef with no resolved key is `unauthorized` even with a shared key set;
 *     a system with no stored key throws `SystemKeyUnavailableError`, not a shared-key credential;
 *     `os-run.ts` must pass the resolved key to BOTH model factories (source pin).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from '@core/kernel/config';
import {
  SystemKeyUnavailableError, __setSystemKeyStoreForTests, deploymentKek, memorySystemKeyStore,
  mintSystemKey, sealSystemKey, systemKeyAlias, systemKeyRef,
} from '@core/infra/agent-system-keys';
import { gatewayChatModel, resolveRunModelKey } from '@core/adapters/litellm/chat-model';

const caller = (systemId?: string) => ({
  userId: 'u1', domain: 'sales', ...(systemId ? { systemId, keyRef: systemKeyRef(systemId) } : {}),
});
const CAPS = { models: ['m'], maxBudget: 5, budgetDuration: '7d', rpmLimit: 1, tpmLimit: 1, maxParallelRequests: 1 };
const apiKeyOf = (m: unknown) => (m as { apiKey?: string }).apiKey;

test('a module model call of an agent system carries the resolved own key', async () => {
  const store = memorySystemKeyStore();
  __setSystemKeyStoreForTests(store);
  const key = mintSystemKey();
  await store.put(sealSystemKey({ systemId: 's1', alias: systemKeyAlias('s1'), key, caps: CAPS, createdAt: 1, rotatedAt: null }, deploymentKek()));
  const own = await resolveRunModelKey(caller('s1'));
  assert.equal(own, key);
  const r = gatewayChatModel({ model: 'm', caller: caller('s1'), ownKey: own, writeSystem: false });
  assert.ok(r.ok);
  assert.equal(apiKeyOf(r.value), key);
  assert.notEqual(apiKeyOf(r.value), config.litellmAgentKey);
  __setSystemKeyStoreForTests(null);
});

test('negative twin: no stored key → SystemKeyUnavailableError, never the shared key', async () => {
  __setSystemKeyStoreForTests(memorySystemKeyStore());
  await assert.rejects(resolveRunModelKey(caller('s2')), (e) => e instanceof SystemKeyUnavailableError && e.reason === 'missing');
  __setSystemKeyStoreForTests(null);
});

test('negative twin: a keyRef call with no resolved key is refused even when a shared key is configured', () => {
  const r = gatewayChatModel({ model: 'm', caller: caller('s3'), writeSystem: false });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'unauthorized');
});

test('a call that is not an agent system (no keyRef) needs no stored key', async () => {
  assert.equal(await resolveRunModelKey(caller()), undefined);
});

test('os-run passes the resolved own key to both the agent and the summary model', () => {
  const src = readFileSync(fileURLToPath(new URL('../../../tabs/agents/lib/module/os-run.ts', import.meta.url)), 'utf8');
  assert.match(src, /resolveRunModelKey\(input\.caller\)/);
  const calls = src.match(/requireGatewayChatModel\(\{[^}]*\}/g) ?? [];
  assert.equal(calls.length, 2);
  for (const c of calls) assert.match(c, /ownKey/);
});

// ------------------------------------------------ a key replaced under a running module (rotation / migration) --

/** A gateway that answers 200 for the keys it holds and 401 for any other bearer, recording each bearer. */
function gatewayStub(valid: Set<string>) {
  const bearers: string[] = [];
  const fetchStub = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const bearer = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? '';
    bearers.push(bearer);
    if (!valid.has(bearer)) return new Response(JSON.stringify({ error: { message: 'Authentication Error, Invalid proxy server token passed', code: '401' } }), { status: 401, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ id: 'c1', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { bearers, fetchStub };
}

async function seed(store: ReturnType<typeof memorySystemKeyStore>, systemId: string, key: string) {
  await store.put(sealSystemKey({ systemId, alias: systemKeyAlias(systemId), key, caps: CAPS, createdAt: 1, rotatedAt: 2 }, deploymentKek()));
}

test('ROTATED UNDER A RUN: a 401 on the old key re-reads the store and repeats the call ONCE with the new key; later calls use the new key', async () => {
  const store = memorySystemKeyStore();
  __setSystemKeyStoreForTests(store);
  const oldKey = mintSystemKey();
  const newKey = mintSystemKey();
  await seed(store, 's4', oldKey);
  const own = await resolveRunModelKey(caller('s4'));
  // The rotation happens after the segment resolved its key: the store has the new key, the gateway only knows the new key.
  await seed(store, 's4', newKey);
  const gw = gatewayStub(new Set([newKey]));
  const r = gatewayChatModel({ model: 'm', caller: caller('s4'), ownKey: own, writeSystem: false, fetch: gw.fetchStub, rotationWaitMs: 1 });
  assert.ok(r.ok);
  const first = await r.value.invoke('hi');
  assert.equal(first.content, 'ok');
  assert.deepEqual(gw.bearers, [oldKey, newKey], 'one 401, then one repeat with the new key');
  await r.value.invoke('again');
  assert.deepEqual(gw.bearers.slice(2), [newKey], 'the next call goes straight to the new key');
  __setSystemKeyStoreForTests(null);
});

test('negative twin: a 401 with NO newer key in the store is not retried forever — it fails after one re-read, on no other key', async () => {
  const store = memorySystemKeyStore();
  __setSystemKeyStoreForTests(store);
  const key = mintSystemKey();
  await seed(store, 's5', key);
  const gw = gatewayStub(new Set()); // the gateway knows no key at all
  const r = gatewayChatModel({ model: 'm', caller: caller('s5'), ownKey: key, writeSystem: false, fetch: gw.fetchStub, rotationWaitMs: 1 });
  assert.ok(r.ok);
  await assert.rejects(r.value.invoke('hi'), /401|Authentication/);
  assert.deepEqual(gw.bearers, [key], 'no second call when the store holds the same key');
  assert.ok(!gw.bearers.includes(config.litellmAgentKey), 'never the shared key');
  __setSystemKeyStoreForTests(null);
});
