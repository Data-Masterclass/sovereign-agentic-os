/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    OPA decision metadata tests — caching and honest absence of `policy_rev`
 * USER STORY: As a maintainer I want proof that `GET /v1/config` is called at most once per TTL,
 *             success or failure, and that a missing revision is skipped, never invented.
 * ARCHITECTURE:
 *   - A stubbed global `fetch` counts calls and scripts the OPA Config API answer.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { __resetPolicyRevCache, decisionMeta, opaPolicyRev } from '@core/infra/opa-decision';

const realFetch = globalThis.fetch;
let calls = 0;
function stubFetch(respond: () => Response | Promise<Response>): void {
  globalThis.fetch = (async () => {
    calls++;
    return respond();
  }) as typeof fetch;
}

beforeEach(() => {
  calls = 0;
  __resetPolicyRevCache();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('a successful GET /v1/config is cached: one call for many decisions', async () => {
  stubFetch(() => Response.json({ result: { labels: { policy_rev: 'rev-1' } } }));
  assert.equal(await opaPolicyRev(), 'rev-1');
  assert.equal(await opaPolicyRev(), 'rev-1');
  assert.deepEqual(await decisionMeta({ decision_id: 'd1' }), { decisionId: 'd1', policyRev: 'rev-1' });
  assert.equal(calls, 1);
});

test('a failed read skips policyRev and is not retried on every decision', async () => {
  stubFetch(() => {
    throw new Error('connection refused');
  });
  assert.deepEqual(await decisionMeta({ decision_id: 'd1' }), { decisionId: 'd1' });
  assert.deepEqual(await decisionMeta({ decision_id: 'd2' }), { decisionId: 'd2' });
  assert.equal(calls, 1);
});

test('a non-200 or a config without the label skips policyRev (never invented)', async () => {
  stubFetch(() => new Response('nope', { status: 500 }));
  assert.equal(await opaPolicyRev(), undefined);
  __resetPolicyRevCache();
  stubFetch(() => Response.json({ result: { labels: { id: 'x' } } }));
  assert.equal(await opaPolicyRev(), undefined);
});

test('no decision_id in the response: no metadata and no config call', async () => {
  stubFetch(() => Response.json({}));
  assert.deepEqual(await decisionMeta({ result: true }), {});
  assert.equal(calls, 0);
});
