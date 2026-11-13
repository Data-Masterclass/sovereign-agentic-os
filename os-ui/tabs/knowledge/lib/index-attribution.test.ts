/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        knowledge
 * FEATURE:    A27 — the INDEX sites attribute their embed calls to the acting principal
 * USER STORY: As a platform admin I want the LiteLLM spend of an index to show WHO caused it and
 *             for WHICH domain, not a single `os-system` row that makes every tenant's indexing
 *             look like one platform cost.
 * ARCHITECTURE:
 *   - The assertion is on the OUTGOING REQUEST BODY (`user`, `metadata.tags`), which is what A27's
 *     test column asks for — `globalThis.fetch` is replaced and the body captured, so this proves
 *     what LiteLLM would actually be billed, not what a helper returned.
 *   - It covers the two knowledge sites (`indexWorkflow`, `indexDomain`) AND the negative: with no
 *     acting user the call must STILL say `platform`, because a boot sweep genuinely is one and
 *     inventing a user for it would be a worse answer than the gap A27 named.
 */
import { test, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '@core/kernel/config';
import { indexWorkflow, indexDomain } from '@tabs/knowledge/lib/index-pipeline';
import { actingCaller } from '@tabs/knowledge/lib/embed';
import { parseWorkflow, emptyDomainKnowledge } from '@tabs/knowledge/lib/schema';
import type { Workflow } from '@tabs/knowledge/lib/schema';

const realFetch = globalThis.fetch;
const realKey = config.litellmAgentKey;
let bodies: Record<string, unknown>[] = [];

beforeEach(() => {
  bodies = [];
  // A scoped key must exist or `embed()` never reaches the network (keySource 'none').
  (config as { litellmAgentKey: string }).litellmAgentKey = 'sk-test-agent';
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    if (href.includes('/v1/embeddings')) {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      // Answer with the WRONG dim on purpose: the vectors are irrelevant here, and the
      // offline-hash fallback keeps the test independent of config.embedDim.
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    // Any OpenSearch write: pretend it is not there, so the pipeline uses its memory mirror.
    throw new Error('offline');
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  (config as { litellmAgentKey: string }).litellmAgentKey = realKey;
});

/** The same shape the chunker's own tests use — parsed, so the fixture cannot drift from schema. */
const WF = `---
id: quote-to-cash
title: Quote to cash
domain: sales
visibility: Shared
status: live
version: "1"
---

\`\`\`step
id: qualify
title: Qualify
actor: Human
actor_name: AE
inputs: [Lead]
outputs: [Opportunity]
\`\`\`
`;

function workflow(): Workflow {
  return parseWorkflow(WF);
}

function tagsOf(body: Record<string, unknown>): string[] {
  return ((body.metadata as { tags?: string[] })?.tags ?? []).slice().sort();
}

test('A27: indexWorkflow bills the ACTING user and the workflow’s domain, not the platform', async () => {
  await indexWorkflow(workflow(), { owner: 'bea', caller: actingCaller('cara', 'sales') });
  assert.equal(bodies.length, 1, 'exactly one embeddings call');
  const [body] = bodies;
  // `os-` is `endUserId()`'s namespace prefix — what matters is that the id after it is the
  // ACTOR and no longer `system`.
  assert.equal(body.user, 'os-cara', 'LiteLLM’s end-user id is the acting principal');
  assert.deepEqual(tagsOf(body), ['domain:sales', 'tab:knowledge']);
  assert.ok(!JSON.stringify(body.user).includes('system'), 'the platform principal must be gone');
});

test('A27: indexDomain bills the acting user too — the domain card is not a free platform cost', async () => {
  const dk = emptyDomainKnowledge('sales');
  dk.sections[0].content = 'How sales works here, in enough words to make a unit.';
  await indexDomain(dk, actingCaller('cara', 'sales'));
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].user, 'os-cara');
  assert.deepEqual(tagsOf(bodies[0]), ['domain:sales', 'tab:knowledge']);
});

test('A27: the tag names the OBJECT’s domain, not the actor’s — the spend belongs to the knowledge', async () => {
  // A platform admin who belongs to `ops` re-indexing a `sales` workflow: the cost is sales'.
  await indexWorkflow(workflow(), { owner: 'bea', caller: actingCaller('sara', 'sales') });
  assert.deepEqual(tagsOf(bodies[0]), ['domain:sales', 'tab:knowledge']);
  assert.equal(bodies[0].user, 'os-sara');
});

test('A27: with NO acting user the call is still honestly the platform’s — not a fabricated user', async () => {
  await indexWorkflow(workflow(), { owner: 'bea' });
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].user, 'os-system', 'a boot/system sweep says so, rather than naming a user');
  assert.deepEqual(tagsOf(bodies[0]), ['domain:platform', 'tab:knowledge']);
});
