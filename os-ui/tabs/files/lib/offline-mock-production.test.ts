/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    NODE_ENV=production ⇒ the Files pipeline invents no document and no vector
 * USER STORY: As a Files/Knowledge owner I must never be able to search, quote or hand an agent a
 *             document that is not in my Drive, or a passage the parser never read — and I must
 *             never get search results ranked by a hash. Review H2: all three happened on a
 *             deployed cluster, and the first tripwire missed them because this pipeline spells
 *             its stand-in `mode: 'mock'`, not `offline-mock`.
 * ARCHITECTURE:
 *   - Three independent fabrication sites, one test file: the connector pull (no token / HTTP
 *     failure / unparseable body), the ingest adapter (parser unreachable) and the embedder
 *     (gateway unreachable or wrong dimension).
 *   - Asserts the ABSENCE of the invented artefact — no `RemoteFile`, no representation, no
 *     vector — not the presence of a label. A label is what failed.
 *   - `fetch` is stubbed per case; nothing else is mocked, so the real modules are under test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE_UNAVAILABLE, OFFLINE_MOCK_ENV } from '@core/kernel/offline-mock';
import { liveClientFor } from '@tabs/files/lib/connectors-live';
import { doclingLive } from '@tabs/files/lib/ingest/live';
import { embedTexts } from '@tabs/files/lib/embed';
import type { ConnectorSource } from '@tabs/files/lib/connectors';

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

const source: ConnectorSource = { scope: 'folder', target: 'folder-1', label: 'Finance' };
const isRefusal = (e: Error & { code?: string; status?: number }) => {
  assert.equal(e.code, ENGINE_UNAVAILABLE);
  assert.equal(e.status, 503);
  return true;
};

// ------------------------------------------------------------------ connectors ---

test('PRODUCTION: a Drive connection with NO token refuses — it does not index a fake drive', async () => {
  await withEnv('production', undefined, async () => {
    for (const provider of ['google-drive', 'onedrive'] as const) {
      await assert.rejects(() => liveClientFor(provider, null).pull(source, null), isRefusal);
    }
  });
});

test('PRODUCTION: a Drive API that answers 500 refuses — the old code substituted the fake drive', async () => {
  globalThis.fetch = (async () => new Response('nope', { status: 500 })) as typeof fetch;
  try {
    await withEnv('production', undefined, async () => {
      for (const provider of ['google-drive', 'onedrive'] as const) {
        await assert.rejects(() => liveClientFor(provider, 'tok').pull(source, null), isRefusal);
      }
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('PRODUCTION: an unparseable Drive body refuses rather than inventing files', async () => {
  globalThis.fetch = (async () => new Response('<html>not json</html>', { status: 200 })) as typeof fetch;
  try {
    await withEnv('production', undefined, async () => {
      for (const provider of ['google-drive', 'onedrive'] as const) {
        await assert.rejects(() => liveClientFor(provider, 'tok').pull(source, null), isRefusal);
      }
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a laptop still gets the fake drive, labelled — the teaching flow is untouched', async () => {
  await withEnv('development', undefined, async () => {
    const client = liveClientFor('google-drive', null);
    assert.equal(client.mode, 'mock');
    const pull = await client.pull(source, null);
    assert.ok(pull.items.length > 0, 'the fake drive still lists its files on a laptop');
  });
});

// ---------------------------------------------------------------- ingest parse ---

test('PRODUCTION: an unreachable parser refuses — NO representation, so nothing is chunked', async () => {
  globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;
  try {
    await withEnv('production', undefined, async () => {
      await assert.rejects(
        () => doclingLive.apply({ fileId: 'f1', name: 'Q3 plan.docx', kind: 'doc', text: 'seed', deepLink: 's3://x' }),
        (e: Error & { code?: string }) => {
          isRefusal(e as Error & { code?: string; status?: number });
          assert.match(e.message, /Q3 plan\.docx/, 'names the file that was NOT parsed');
          return true;
        },
      );
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a laptop keeps the deterministic parse mock', async () => {
  globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;
  try {
    await withEnv('development', undefined, async () => {
      const r = await doclingLive.apply({ fileId: 'f1', name: 'Q3 plan.docx', kind: 'doc', text: 'seed text', deepLink: 's3://x' });
      assert.equal(r.mode, 'mock');
      assert.ok(r.representations.length > 0);
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

// -------------------------------------------------------------------- embedding ---

test('PRODUCTION: an unreachable embeddings gateway refuses — NO hash vector is produced', async () => {
  globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;
  try {
    await withEnv('production', undefined, async () => {
      await assert.rejects(() => embedTexts(['a passage', 'another']), (e: Error & { code?: string; status?: number }) => {
        isRefusal(e);
        assert.match(e.message, /hash vectors/i, 'says why a hash vector is not an acceptable stand-in');
        return true;
      });
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a laptop keeps the deterministic hash vectors at the configured dim', async () => {
  globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;
  try {
    await withEnv('development', undefined, async () => {
      const r = await embedTexts(['a passage']);
      assert.equal(r.mode, 'mock');
      assert.equal(r.vectors.length, 1);
      assert.equal(r.vectors[0].length, r.dim, 'the mock is always at the index’s configured dim');
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});
