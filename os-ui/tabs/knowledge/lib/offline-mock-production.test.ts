/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    NODE_ENV=production ⇒ the Knowledge index is never filled with hash vectors
 * USER STORY: As a knowledge owner, and as every agent that cites this corpus, I must never get
 *             retrieval ranked by a hash. `hashEmbed` is a HASH of the text, not an embedding:
 *             vectors built from it have no semantic relationship, so a k-NN search over them
 *             returns essentially arbitrary passages — which an agent then quotes as "the
 *             relevant context", with a citation, from the OS's own knowledge base.
 * ARCHITECTURE:
 *   - The identical defect to `tabs/files/lib/embed.ts` (review H2), on a worse corpus. Found in
 *     the re-review because it spells its stand-in `source: 'offline-hash'` and reaches it through
 *     `hashEmbed(`, neither of which was in the tripwire's marker set.
 *   - `librarian-live.ts` returning `[]` for an `offline-hash` batch mitigates the READ side only;
 *     `index-pipeline.ts` propagates `embedSource` and the rows are already written by then. The
 *     fix has to be at the write, which is here.
 *   - Asserts the ABSENCE of a vector, not the presence of a label. A 4xx must still THROW
 *     `GatewayRejectedError` and not be converted into a mock-refusal — that distinction (a
 *     decision about this caller vs. an unreachable dependency) is load-bearing and pre-existing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE_UNAVAILABLE, OFFLINE_MOCK_ENV } from '@core/kernel/offline-mock';
import { embed, embedQuery } from '@tabs/knowledge/lib/embed';

const realFetch = globalThis.fetch;

async function withEnv(nodeEnv: string, flag: string | undefined, body: () => Promise<void>): Promise<void> {
  const prevNode = process.env.NODE_ENV;
  const prevFlag = process.env[OFFLINE_MOCK_ENV];
  (process.env as Record<string, string>).NODE_ENV = nodeEnv;
  if (flag === undefined) delete process.env[OFFLINE_MOCK_ENV];
  else process.env[OFFLINE_MOCK_ENV] = flag;
  try {
    await body();
  } finally {
    if (prevNode === undefined) delete process.env.NODE_ENV;
    else (process.env as Record<string, string>).NODE_ENV = prevNode;
    if (prevFlag === undefined) delete process.env[OFFLINE_MOCK_ENV];
    else process.env[OFFLINE_MOCK_ENV] = prevFlag;
  }
}

const isRefusal = (e: Error & { code?: string; status?: number }) => {
  assert.equal(e.code, ENGINE_UNAVAILABLE);
  assert.equal(e.status, 503);
  return true;
};

test('PRODUCTION: an unreachable embeddings gateway REFUSES — no hash vector is indexed', async () => {
  globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;
  try {
    await withEnv('production', undefined, async () => {
      await assert.rejects(() => embed(['a knowledge passage', 'another']), (e: Error & { code?: string; status?: number }) => {
        isRefusal(e);
        assert.match(e.message, /hash/i, 'says why a hash is not an acceptable stand-in for an embedding');
        return true;
      });
      await assert.rejects(() => embedQuery('a question'), isRefusal);
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('PRODUCTION: a 5xx refuses, and a WRONG-DIMENSION reply refuses too', async () => {
  for (const reply of [
    () => new Response('boom', { status: 503 }),
    // A dim mismatch was already distrusted; it must now refuse rather than hash-fill.
    () => new Response(JSON.stringify({ data: [{ embedding: [1, 2, 3] }] }), { status: 200 }),
  ]) {
    globalThis.fetch = (async () => reply()) as typeof fetch;
    try {
      await withEnv('production', undefined, async () => {
        await assert.rejects(() => embed(['a knowledge passage']), isRefusal);
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  }
});

test('PRODUCTION: a 4xx still throws GatewayRejectedError — NOT converted into a mock refusal', async () => {
  // A decision about THIS caller (key, model allowlist, budget) is not an unreachable dependency,
  // and collapsing the two would hide a fixable misconfiguration behind an outage message.
  globalThis.fetch = (async () => new Response('over budget', { status: 400 })) as typeof fetch;
  try {
    await withEnv('production', undefined, async () => {
      await assert.rejects(
        () => embed(['a knowledge passage']),
        (e: Error & { code?: string }) => {
          assert.notEqual(e.code, ENGINE_UNAVAILABLE);
          assert.match(e.name, /GatewayRejected/);
          return true;
        },
      );
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('PRODUCTION: an EMPTY batch is not a fabrication — no vectors in, no vectors out', async () => {
  await withEnv('production', undefined, async () => {
    const r = await embed([]);
    assert.deepEqual(r.vectors, [], 'nothing was asked for and nothing was invented');
  });
});

test('a laptop keeps the deterministic offline hash at the configured dim', async () => {
  globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;
  try {
    await withEnv('development', undefined, async () => {
      const r = await embed(['a knowledge passage']);
      assert.equal(r.source, 'offline-hash');
      assert.equal(r.vectors.length, 1);
      assert.ok(r.vectors[0].length > 0);
      const q = await embedQuery('a question');
      assert.equal(q.source, 'offline-hash');
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('PRODUCTION + an explicit `allow` is the deliberate opt-in', async () => {
  globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;
  try {
    await withEnv('production', 'allow', async () => {
      const r = await embed(['a knowledge passage']);
      assert.equal(r.source, 'offline-hash');
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});
