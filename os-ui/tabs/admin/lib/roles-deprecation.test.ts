/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        admin
 * FEATURE:    An old model name keeps working and is logged as deprecated when the OS sends it.
 * USER STORY: As a platform admin I see in the logs which stored setting (an agent pinned to an old alias)
 *             still names an old model, so I can move it before the alias goes away. Nothing breaks meanwhile.
 * ARCHITECTURE:
 *   - The OS itself sends only role names now. A STORED name (an agent definition's pin) is passed through
 *     unchanged — the gateway resolves the alias — and the one door every agent model call goes through
 *     (`gatewayChatModel`) logs the deprecation once per name per process.
 *   - NEGATIVE TWINS: a role name or a catalog model name logs nothing; the same alias logs once, not on
 *     every call. The gateway side (the alias answers like its role) is proven on the real LiteLLM in
 *     `model-roles.e2e.test.ts`.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { gatewayChatModel } from '@core/adapters/litellm/chat-model';

const warn = console.warn;
let lines: string[] = [];
beforeEach(() => { lines = []; console.warn = (l: string) => { lines.push(String(l)); }; });
const call = (model: string) => gatewayChatModel({ model, apiKey: 'k', baseURL: 'http://gw.invalid/v1', writeSystem: false });

test('an agent pinned to an old alias still gets a model object (the gateway maps it) and logs a deprecation ONCE', () => {
  const a = call('sovereign-vision');
  const b = call('sovereign-vision');
  console.warn = warn;
  assert.ok(a.ok && b.ok);
  assert.equal(lines.filter((l) => /sovereign-vision/.test(l)).length, 1);
  assert.match(lines.find((l) => /sovereign-vision/.test(l))!, /deprecated.*sovereign-strong/i);
});

test('NEGATIVE TWIN: a role name or a catalog model name logs nothing', () => {
  call('sovereign-worker'); call('sovereign-strong'); call('sovereign-embedding'); call('stackit-qwen3-vl-235b'); call('kimi-k3.1-pro');
  console.warn = warn;
  // (A role whose catalog model is not loaded in this test logs the sampling note — `model-sampling.ts` — not a deprecation.)
  assert.deepEqual(lines.filter((l) => /deprecat/i.test(l)), []);
});
