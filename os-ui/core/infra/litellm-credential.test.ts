/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Tests for the run-path credential and its attribution.
 *
 * USER STORY: As a security reviewer I want a test that fails if anyone makes
 *             the run path fall back to the master key, because that fallback
 *             would silently remove the model allowlist and the spend cap.
 *
 * ARCHITECTURE:
 *   Pure assertions over `callerCredential` plus the two typed errors. The
 *   companion guarantee — that the live caller actually sends this key — is the
 *   `MODEL-KEY` case in `core/runtime/runtime.test.ts`, which inspects the
 *   outgoing Authorization header.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  callerCredential, runCredentialConfigured, endUserId,
  NoRunCredentialError, BudgetExceededError, isBudgetRejection,
  TAG_RUN, GatewayRejectedError, isClientRejection,
} from './litellm-credential.ts';
import { putSecret, deleteSecret } from '@core/infra/secrets';
import { config } from '@core/kernel/config';

type Cfg = { litellmAgentKey: string; litellmMasterKey: string };

test('RUN-CRED: uses the scoped agent key, never the master key', () => {
  const c = config as unknown as Cfg;
  const cred = callerCredential({ userId: 'u1', domain: 'finance' });
  assert.equal(cred.apiKey, c.litellmAgentKey);
  assert.notEqual(cred.apiKey, c.litellmMasterKey);
  assert.ok(cred.apiKey.length > 0, 'the test harness must provide a scoped key');
});

test('RUN-CRED: an empty scoped key is not configured, and never becomes the master key', () => {
  const c = config as unknown as Cfg;
  const k = c.litellmAgentKey;
  try {
    c.litellmAgentKey = '';
    assert.equal(runCredentialConfigured(), false);
    assert.equal(callerCredential({ userId: 'u1', domain: 'd' }).apiKey, '');
    assert.notEqual(callerCredential({ userId: 'u1', domain: 'd' }).apiKey, c.litellmMasterKey);
  } finally { c.litellmAgentKey = k; }
});

test('RUN-CRED: end-user ids are namespaced so they cannot collide', () => {
  assert.equal(endUserId('u1'), 'os-u1');
  assert.equal(callerCredential({ userId: 'u1', domain: 'd' }).user, 'os-u1');
});

test('RUN-CRED: domain is always tagged; agent and tab only when known', () => {
  assert.deepEqual(callerCredential({ userId: 'u1', domain: 'finance' }).tags, ['domain:finance']);
  assert.deepEqual(
    callerCredential({ userId: 'u1', domain: 'finance', systemId: 'triage', tab: 'agents' }).tags,
    ['domain:finance', 'agent:triage', 'tab:agents'],
  );
});

test('RUN-CRED: the tag vocabulary matches what the gateway mirror buckets', () => {
  // gateway-mirror splits on the FIRST colon and keys off these three prefixes.
  for (const tag of callerCredential({ userId: 'u', domain: 'd', systemId: 's', tab: 't' }).tags) {
    const kind = tag.slice(0, tag.indexOf(':'));
    assert.ok(['domain', 'agent', 'tab'].includes(kind), `mirror cannot bucket "${tag}"`);
  }
});

test('RUN-CRED (A3): a run tags `run:<runId>` and the vocabulary includes the run prefix', () => {
  const cred = callerCredential({ userId: 'u1', domain: 'sales', systemId: 'sys1', runId: 'run_abc' });
  assert.ok(cred.tags.includes(`${TAG_RUN}run_abc`));
  assert.equal(TAG_RUN, 'run:');
  assert.ok(!callerCredential({ userId: 'u1', domain: 'sales' }).tags.some((t) => t.startsWith(TAG_RUN)), 'no run → no run tag');
});

test('RUN-CRED (A3): a per-agent key by REFERENCE wins over the shared key; a dangling reference falls back to the shared key — never the master key', () => {
  const ref = putSecret('agent-litellm-key', 'sys-own', 'sk-os-sys-own');
  const own = callerCredential({ userId: 'u1', domain: 'sales', systemId: 'sys-own', keyRef: ref });
  assert.equal(own.apiKey, 'sk-os-sys-own');
  assert.equal(own.keySource, 'agent-key');
  const dangling = callerCredential({ userId: 'u1', domain: 'sales', systemId: 'sys-other', keyRef: { name: 'agent-litellm-key', key: 'nope' } });
  assert.equal(dangling.apiKey, config.litellmAgentKey);
  assert.equal(dangling.keySource, 'shared-agent-key');
  assert.notEqual(dangling.apiKey, config.litellmMasterKey);
  deleteSecret(ref);
});

test('RUN-CRED (A3): a gateway 4xx is a typed rejection with the right code', () => {
  assert.equal(new GatewayRejectedError(403, 'key not allowed to access model').code, 'forbidden');
  assert.equal(new GatewayRejectedError(401, 'invalid key').code, 'unauthorized');
  assert.equal(new GatewayRejectedError(400, 'Budget has been exceeded! Current cost: 5.1, Max budget: 5').code, 'budget_exceeded');
  assert.equal(new GatewayRejectedError(400, 'invalid request').code, 'bad_request');
  assert.equal(isClientRejection(403), true);
  assert.equal(isClientRejection(503), false);
});

test('RUN-CRED: refusing to run is typed, so the UI can explain it', () => {
  const e = new NoRunCredentialError();
  assert.equal(e.code, 'no_run_credential');
  assert.match(e.message, /master key/);
});

test('RUN-CRED: a budget rejection is recognised from LiteLLM 400 and 429', () => {
  assert.equal(isBudgetRejection(400, 'ExceededBudget: max_budget reached'), true);
  assert.equal(isBudgetRejection(429, 'budget exceeded for key'), true);
  assert.equal(isBudgetRejection(400, 'model does not support tools'), false);
  assert.equal(isBudgetRejection(500, 'max_budget'), false);
  assert.equal(new BudgetExceededError('x').code, 'budget_exceeded');
});
