/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@/lib/core/auth';
import { createApp, saveAppFile } from '@/lib/software/apps';
import { requestDeploy, getReviewCard, __resetReviewCards } from './review.ts';
import { __resetApprovals } from '@/lib/governance/approvals';

/**
 * The deploy-scan SECURITY fixes:
 *   1. LIVE-TREE SCAN — `requestDeploy` scans the app's REAL Forgejo repo tree
 *      when reachable (editor saves + direct git pushes included), labelled
 *      `live`; previously it only ever saw the in-process commit snapshot, so a
 *      pasted AWS key shipped with a clean "scan passed" card.
 *   2. EDITOR SAVES feed the snapshot — offline, a `saveAppFile` secret is now
 *      visible to the scan (it previously bypassed the snapshot entirely).
 *   3. DURABLE CARDS — review cards survive a pod roll via the os-mirror
 *      pattern (`os-software-reviews`), so /software/reviews keeps its scan/diff.
 */

const creator: CurrentUser = { id: 'alice', name: 'Alice', domains: ['sales'], role: 'creator' };
const builder: CurrentUser = { id: 'bob', name: 'Bob', domains: ['sales'], role: 'builder' };

const LEAKED = 'const key = "AKIAIOSFODNN7EXAMPLE";\n';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Stub global fetch: handled URLs answer, everything else is "network down". */
function stubFetch(handler: (url: string, init?: RequestInit) => Response | null): () => void {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const r = handler(String(input), init);
    if (r) return r;
    throw new TypeError('fetch failed (stubbed offline)');
  }) as typeof fetch;
  return () => {
    globalThis.fetch = orig;
  };
}

test('SCAN READS THE LIVE TREE: a secret in the Forgejo repo (never committed via the OS) fails the deploy scan', async () => {
  __resetApprovals();
  __resetReviewCards();
  // The live repo contains a leaked key that NEVER flowed through commitToApp —
  // exactly the editor-save / direct-git-push blind spot.
  const restore = stubFetch((url, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET' && /\/api\/v1\/repos\/[^/]+\/[^/]+\/git\/trees\/main/.test(url)) {
      return json({ tree: [{ path: 'leak.ts', type: 'blob' }, { path: 'README.md', type: 'blob' }] });
    }
    const c = url.match(/\/api\/v1\/repos\/[^/]+\/[^/]+\/contents\/([^?]+)\?ref=main/);
    if (method === 'GET' && c) {
      const path = decodeURIComponent(c[1]);
      const content = path === 'leak.ts' ? LEAKED : '# readme\n';
      return json({ type: 'file', encoding: 'base64', content: Buffer.from(content, 'utf8').toString('base64'), sha: 'abc' });
    }
    return null; // Forgejo create/seed, OpenSearch, Langfuse, k8s… all offline
  });
  try {
    const app = await createApp(creator, { name: 'Live Tree Scan', template: 'nextjs-supabase' });
    const res = await requestDeploy(app.id, creator);
    assert.equal(res.kind, 'review');
    if (res.kind !== 'review') return;
    assert.equal(res.card.scan.mode, 'live', 'scanned the live repo tree, honestly labelled');
    assert.equal(res.card.scan.passed, false, 'the leaked key BLOCKS the deploy');
    assert.ok(
      res.card.scan.findings.some((f) => f.category === 'secrets' && f.path === 'leak.ts'),
      'the finding points at the leaked file from the LIVE tree',
    );
    // The diff reflects what will actually ship (the live tree, not the template).
    assert.ok(res.card.diff.files.some((f) => f.path === 'leak.ts'));
    // ONE approver gate: the Governance item files at builder — the same rank
    // decideDeploy enforces and the UI copy ("Builder-reviewed") promises.
    assert.equal(res.approval.approverRole, 'builder');
  } finally {
    restore();
    __resetApprovals();
    __resetReviewCards();
  }
});

test('EDITOR SAVE feeds the scan snapshot: a secret saved via saveAppFile fails the offline scan', async () => {
  __resetApprovals();
  __resetReviewCards();
  // Forgejo accepts the editor save (PUT contents) but exposes NO readable tree,
  // so the deploy scan must fall back to the snapshot — which now includes the save.
  const restore = stubFetch((url, init) => {
    if ((init?.method ?? 'GET') === 'PUT' && /\/api\/v1\/repos\/[^/]+\/[^/]+\/contents\//.test(url)) {
      return json({ content: { sha: 'new' }, commit: { html_url: null } });
    }
    return null;
  });
  try {
    const app = await createApp(builder, { name: 'Editor Save Scan', template: 'nextjs-supabase' });
    await saveAppFile(app.id, builder, { path: 'lib/creds.ts', content: LEAKED, sha: '' });
    const res = await requestDeploy(app.id, builder);
    assert.equal(res.kind, 'review');
    if (res.kind !== 'review') return;
    assert.equal(res.card.scan.mode, 'offline-mock', 'no live tree reachable → snapshot, honestly labelled');
    assert.equal(res.card.scan.passed, false, 'the editor-saved secret is seen by the scan');
    assert.ok(res.card.scan.findings.some((f) => f.category === 'secrets' && f.path === 'lib/creds.ts'));
  } finally {
    restore();
    __resetApprovals();
    __resetReviewCards();
  }
});

test('DURABLE CARDS: a review card survives a pod roll (mirror round-trip)', async () => {
  __resetApprovals();
  __resetReviewCards();
  // In-memory fake of the OpenSearch REST surface (fresh cluster, no indices).
  const indices = new Map<string, Map<string, unknown>>();
  const restore = stubFetch((url, init) => {
    const m = url.match(/^https?:\/\/opensearch:9200(\/.*)$/);
    if (!m) return null;
    const method = init?.method ?? 'GET';
    const path = m[1];
    const [, indexName, rest] = path.match(/^\/([^/?]+)(.*)$/) ?? [];
    const idx = indices.get(indexName);
    if (rest?.startsWith('/_count')) return idx ? json({ count: idx.size }) : json({ error: 'index_not_found' }, 404);
    if (rest?.startsWith('/_search')) {
      if (!idx) return json({ error: 'index_not_found' }, 404);
      return json({ hits: { hits: [...idx.values()].map((_source) => ({ _source })) } });
    }
    if (rest?.startsWith('/_doc/')) {
      const id = decodeURIComponent(rest.slice('/_doc/'.length).split('?')[0]);
      if (method === 'GET') return idx?.has(id) ? json({ _source: idx.get(id) }) : json({ found: false }, 404);
      if (method === 'DELETE') { idx?.delete(id); return json({ result: 'deleted' }); }
      if (!idx) return json({ error: 'index_not_found' }, 404);
      idx.set(id, JSON.parse(String(init?.body ?? '{}')));
      return json({ result: 'created' });
    }
    if (method === 'PUT' && (rest === '' || rest.startsWith('?'))) {
      if (indices.has(indexName)) return json({ error: 'resource_already_exists_exception' }, 400);
      indices.set(indexName, new Map());
      return json({ acknowledged: true });
    }
    return json({});
  });
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  };
  try {
    const app = await createApp(creator, { name: 'Durable Card', template: 'nextjs-supabase' });
    const res = await requestDeploy(app.id, creator);
    assert.equal(res.kind, 'review');
    if (res.kind !== 'review') return;
    await settle();
    assert.ok(indices.get('os-software-reviews')?.has(res.card.id), 'the card was mirrored durably');

    // Pod roll: in-process cards gone, cluster kept → the card hydrates back.
    __resetReviewCards();
    const back = await getReviewCard(res.card.id);
    assert.ok(back, 'the card survives the restart');
    assert.equal(back!.decision, 'pending');
    assert.equal(back!.appId, app.id);
    assert.deepEqual(back!.scan.summary, res.card.scan.summary, 'scan detail preserved');
    assert.equal(back!.diff.files.length, res.card.diff.files.length, 'diff preserved');
  } finally {
    restore();
    __resetApprovals();
    __resetReviewCards();
  }
});
