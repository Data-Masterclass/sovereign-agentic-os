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
