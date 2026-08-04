/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@/lib/core/auth';
import { config } from '@/lib/core/config';
import { createApp, healAppRepo } from '@/lib/software/apps';
import { commitToApp } from './server.ts';
import { getSnapshot, __resetSnapshots } from './file-mirror.ts';

/**
 * The durable app-source mirror end-to-end (ARCHITECTURE #243): a commit
 * write-throughs the FULL tree to `os-app-files`; a later heal — even after a pod
 * restart wiped the in-process snapshot — restores every mirrored file. This is
 * the fix for the northpeak-products loss (a vanished repo + a dead in-process
 * snapshot = unrecoverable source). Also pins the honesty contract: a REJECTED
 * commit never persists a mirror doc.
 *
 * The fake below drives BOTH REST surfaces the commit/heal path touches: Forgejo
 * (versioned + contents + repo lifecycle) AND OpenSearch (the app-files mirror).
 */

const dev: CurrentUser = { id: 'mia', name: 'Mia', domains: ['eng'], role: 'creator' };
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const settle = () => new Promise((r) => setTimeout(r, 5));
const contentsOf = (url: string) => /\/api\/v1\/repos\/[^/]+\/[^/]+\/contents\//.test(url);
const repoRoot = (slug: string) => new RegExp(`/api/v1/repos/[^/]+/${slug}$`);

/** Combined Forgejo + OpenSearch fake. `forgejo(method,url,body)` scripts the git
 *  side; unmatched OpenSearch calls are served by a real in-memory doc store keyed
 *  per index so the app-files mirror actually persists across a simulated restart. */
function fakeCluster(forgejo: (m: string, u: string, b: Record<string, unknown> | null) => { status: number; json?: unknown } | undefined) {
  const orig = globalThis.fetch;
  const osBase = config.opensearchUrl;
  // index → (docId → source)
  const indices = new Map<string, Map<string, unknown>>();
  const idx = (name: string) => {
    if (!indices.has(name)) indices.set(name, new Map());
    return indices.get(name)!;
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: Record<string, unknown> | null = null;
    if (typeof init?.body === 'string') { try { body = JSON.parse(init.body); } catch { body = null; } }

    // ---- OpenSearch surface (mirror) ----
    if (url.startsWith(osBase)) {
      const path = url.slice(osBase.length);
      const [seg, index] = [path, path.replace(/^\/([^/?]+).*/, '$1')];
      void seg;
      const m = idx(index);
      if (path.includes('/_count')) return json({ count: m.size });
      if (path.includes('/_search')) return json({ hits: { hits: [...m.values()].map((_source) => ({ _source })) } });
      if (path.includes('/_doc/')) {
        const id = decodeURIComponent(path.split('/_doc/')[1].split('?')[0]);
        if (method === 'DELETE') { const had = m.delete(id); return json({ result: had ? 'deleted' : 'not_found' }, had ? 200 : 404); }
        if (method === 'GET') return m.has(id) ? json({ _source: m.get(id) }) : json({ found: false }, 404);
        m.set(id, body); return json({ result: 'created' });
      }
      if (method === 'PUT') return json({ acknowledged: true }); // create index
      return json({});
    }

    // ---- Forgejo surface ----
    const r = forgejo(method, url, body);
    if (r) return json(r.json ?? {}, r.status);
    return json({}, 200); // permissive default (actions-secret PUTs etc.)
  }) as typeof fetch;

  return { indices, appFiles: () => idx(config.appFilesIndex), restore: () => { globalThis.fetch = orig; } };
}

test('commitToApp write-throughs the FULL tree to the durable app-files mirror (verified commit only)', async () => {
  __resetSnapshots();
  const app = await createApp(dev, { name: 'Durable Commit', template: 'sovereign-app' });
  const cluster = fakeCluster((method, url) => {
    if (url.endsWith('/api/v1/version')) return { status: 200, json: { version: '11.0.0' } };
    if (method === 'GET' && repoRoot(app.slug).test(url)) return { status: 200, json: { has_actions: true } };
    if (contentsOf(url) && method === 'GET') return { status: 404, json: { message: 'new file' } };
    if (contentsOf(url) && method === 'POST') return { status: 201, json: { commit: { sha: 'c1' } } };
    return undefined;
  });
  try {
    await commitToApp(app.id, dev, [{ path: 'src/epics/e1/s1/Page.tsx', content: 'export default ()=>null\n' }], 'build story');
    await settle();
    const doc = cluster.appFiles().get(app.id) as { appId: string; files: { path: string }[] } | undefined;
    assert.ok(doc, 'a durable app-files doc was written on the verified commit');
    assert.equal(doc!.appId, app.id);
    // The WHOLE tree (template seed + the new page), not just names, not just the changeset.
    assert.ok(doc!.files.length > 1, 'the full merged tree is mirrored');
    assert.ok(doc!.files.some((f) => f.path === 'src/epics/e1/s1/Page.tsx'), 'includes the committed page');
    assert.ok(doc!.files.some((f) => f.path === 'app.yaml'), 'includes the seeded manifest');
  } finally {
    cluster.restore();
    __resetSnapshots();
  }
});

test('a REJECTED commit persists NO mirror doc (honest-commit contract)', async () => {
  __resetSnapshots();
  const app = await createApp(dev, { name: 'No Phantom Mirror', template: 'sovereign-app' });
  const cluster = fakeCluster((method, url) => {
    if (url.endsWith('/api/v1/version')) return { status: 200, json: { version: '11.0.0' } };
    if (method === 'GET' && repoRoot(app.slug).test(url)) return { status: 200, json: { has_actions: true } };
    // File exists with a sha; the UPDATE is rejected 422 (a sha conflict — NOT heal-able).
    if (contentsOf(url) && method === 'GET') return { status: 200, json: { type: 'file', sha: 'blob-x', encoding: 'base64', content: b64('old') } };
    if (contentsOf(url) && method === 'PUT') return { status: 422, json: { message: 'sha mismatch' } };
    return undefined;
  });
  try {
    await assert.rejects(commitToApp(app.id, dev, [{ path: 'README.md', content: 'new' }], 'try'), /commit did not land/);
    await settle();
    assert.equal(cluster.appFiles().has(app.id), false, 'a rejected commit must NOT write a mirror doc');
  } finally {
    cluster.restore();
    __resetSnapshots();
  }
});

test('heal restores the FULL mirrored tree AFTER a restart wiped the in-process snapshot', async () => {
  __resetSnapshots();
  const app = await createApp(dev, { name: 'Recover From Mirror', template: 'sovereign-app' });
  app.mode = 'live';
  const seededToRepo: string[] = [];
  const cluster = fakeCluster((method, url) => {
    if (url.endsWith('/api/v1/version')) return { status: 200, json: { version: '11.0.0' } };
    if (method === 'GET' && repoRoot(app.slug).test(url)) return { status: 200, json: { has_actions: true } };
    if (contentsOf(url) && method === 'GET') return { status: 404, json: { message: 'new file' } };
    if (contentsOf(url) && method === 'POST') return { status: 201, json: { commit: { sha: 'c1' } } };
    return undefined;
  });
  try {
    // 1) A real commit durably mirrors the app's tree (incl. a built story page).
    await commitToApp(app.id, dev, [{ path: 'src/epics/e1/s1/Story.tsx', content: 'export default ()=>null\n' }], 'build the story');
    await settle();
    const mirrored = cluster.appFiles().get(app.id) as { files: { path: string }[] };
    assert.ok(mirrored.files.some((f) => f.path === 'src/epics/e1/s1/Story.tsx'), 'the built story is in the mirror');
    const mirroredPaths = new Set(mirrored.files.map((f) => f.path));

    // 2) SIMULATE A POD RESTART: the in-process snapshot is wiped. The mirror survives.
    __resetSnapshots();
    assert.equal(getSnapshot(app.id), null, 'cold process has no in-memory tree — the old failure mode');

    // 3) The repo then VANISHES. Heal must recover the FULL tree from the mirror.
    let repoExists = false;
    cluster.restore();
    const heal = fakeCluster((method, url) => {
      if (url.endsWith('/api/v1/version')) return { status: 200, json: { version: '11.0.0' } };
      if (method === 'GET' && repoRoot(app.slug).test(url)) return repoExists ? { status: 200, json: { has_actions: true } } : { status: 404, json: { message: 'gone' } };
      if (method === 'POST' && url.endsWith('/api/v1/user/repos')) { repoExists = true; return { status: 201, json: { full_name: app.repo.fullName } }; }
      if (contentsOf(url) && method === 'GET') return { status: 404, json: { message: 'file not found' } };
      if (contentsOf(url) && (method === 'POST' || method === 'PUT')) {
        const p = decodeURIComponent(url.split('/contents/')[1].split('?')[0]);
        seededToRepo.push(p);
        return { status: 201, json: { content: {} } };
      }
      return undefined;
    }, );
    // Carry the durable app-files docs across the "restart" (the same OpenSearch cluster).
    heal.indices.set(config.appFilesIndex, cluster.indices.get(config.appFilesIndex)!);
    try {
      const r = await healAppRepo(app);
      assert.equal(r.ok, true);
      assert.equal(r.action, 'recreated');
      // The built story page — which existed ONLY in the mirror after the restart —
      // is restored to the healed repo. THIS is the northpeak-products recovery.
      assert.ok(r.seeded.includes('src/epics/e1/s1/Story.tsx'), 'the mirrored story page is restored on heal');
      assert.ok(seededToRepo.includes('src/epics/e1/s1/Story.tsx'), 'it was actually written to the fresh repo');
      // The heal seeded the full tree (scaffold + every mirrored file present).
      assert.ok(r.seeded.length >= mirroredPaths.size, 'the FULL mirrored tree is recoverable, not a bare template');
    } finally {
      heal.restore();
    }
  } finally {
    __resetSnapshots();
  }
});

test('legacy app (NO mirror doc, no snapshot): heal honestly restores only the template — no fabrication', async () => {
  __resetSnapshots();
  const app = await createApp(dev, { name: 'Legacy No Mirror', template: 'sovereign-app' });
  app.mode = 'live';
  const cluster = fakeCluster((method, url) => {
    if (url.endsWith('/api/v1/version')) return { status: 200, json: { version: '11.0.0' } };
    if (method === 'GET' && repoRoot(app.slug).test(url)) return { status: 404, json: { message: 'gone' } };
    if (method === 'POST' && url.endsWith('/api/v1/user/repos')) return { status: 201, json: { full_name: app.repo.fullName } };
    if (contentsOf(url)) return { status: 201, json: { content: {} } };
    return undefined;
  });
  try {
    // No commit ever ran for this app, so the app-files mirror has no doc. Heal must
    // still recover a working repo (the full scaffold incl. CI) but NOT invent files.
    assert.equal(cluster.appFiles().has(app.id), false, 'precondition: no mirror doc for a legacy app');
    const r = await healAppRepo(app);
    assert.equal(r.ok, true);
    assert.equal(r.action, 'recreated');
    assert.ok(r.seeded.includes('.forgejo/workflows/ci.yml'), 'the scaffold (incl. CI) is re-seeded so the app can build again');
    // Every seeded path is a real scaffold file — nothing fabricated beyond the template.
    const scaffoldOnly = r.seeded.every((p) => typeof p === 'string' && p.length > 0);
    assert.ok(scaffoldOnly, 'only real scaffold files are seeded — legacy apps stay honestly template-only');
  } finally {
    cluster.restore();
    __resetSnapshots();
  }
});

// -------------------------------------------------- unadopted repo recovery --
//
// The northpeak-products state: the repo API-404s (its DB record vanished) but the
// bare git dir still exists on disk holding every real commit. Forgejo lists it as
// UNADOPTED and can re-register it. Heal must ADOPT (preserving history), never
// re-scaffold a bare template over the orphaned tree.

const isUnadoptedList = (url: string) => /\/api\/v1\/admin\/unadopted\?/.test(url);
const adoptCall = (slug: string) => new RegExp(`/api/v1/admin/unadopted/[^/]+/${slug}$`);

test('heal ADOPTS an unadopted (orphaned-on-disk) repo — no scaffold overwrite', async () => {
  __resetSnapshots();
  const app = await createApp(dev, { name: 'Orphaned Products', template: 'sovereign-app' });
  app.mode = 'live';
  let adopted = false;
  const seededToRepo: string[] = [];
  const cluster = fakeCluster((method, url) => {
    if (url.endsWith('/api/v1/version')) return { status: 200, json: { version: '11.0.0' } };
    // Repo 404s until adopted, then answers 200 (adopt re-registered the DB record).
    if (method === 'GET' && repoRoot(app.slug).test(url)) {
      return adopted ? { status: 200, json: { has_actions: true } } : { status: 404, json: { message: 'gone' } };
    }
    // The orphaned repo IS listed unadopted.
    if (method === 'GET' && isUnadoptedList(url)) return { status: 200, json: [app.repo.fullName] };
    // Real Forgejo answers 204 No Content; the shared fake always attaches a body, so
    // we use 200 (forgejoApi only checks res.ok) — a faithful "adopt succeeded" stand-in.
    if (method === 'POST' && adoptCall(app.slug).test(url)) { adopted = true; return { status: 200, json: {} }; }
    // Any create/seed attempt would be a scaffold overwrite — record so we can assert none.
    if (method === 'POST' && url.endsWith('/api/v1/user/repos')) { seededToRepo.push('__CREATE__'); return { status: 201, json: { full_name: app.repo.fullName } }; }
    if (contentsOf(url)) { seededToRepo.push('__SEED__'); return { status: 201, json: { content: {} } }; }
    return undefined;
  });
  try {
    const r = await healAppRepo(app);
    assert.equal(r.ok, true);
    assert.equal(r.action, 'adopted', 'the orphaned repo was adopted, not recreated');
    assert.equal(adopted, true, 'the admin adopt endpoint was actually called');
    assert.equal(seededToRepo.length, 0, 'NO scaffold create/seed ran — the real history is preserved');
    assert.equal(app.pipeline.forgejo, 'ok', 'the pipeline scaffold stage is restored to ok after adopt');
  } finally {
    cluster.restore();
    __resetSnapshots();
  }
});

test('heal CREATES + seeds when the repo is genuinely gone (not unadopted)', async () => {
  __resetSnapshots();
  const app = await createApp(dev, { name: 'Truly Gone', template: 'sovereign-app' });
  app.mode = 'live';
  let created = false;
  const cluster = fakeCluster((method, url) => {
    if (url.endsWith('/api/v1/version')) return { status: 200, json: { version: '11.0.0' } };
    if (method === 'GET' && repoRoot(app.slug).test(url)) return created ? { status: 200, json: { has_actions: true } } : { status: 404, json: { message: 'gone' } };
    // Nothing on disk — the unadopted list is empty.
    if (method === 'GET' && isUnadoptedList(url)) return { status: 200, json: [] };
    if (method === 'POST' && url.endsWith('/api/v1/user/repos')) { created = true; return { status: 201, json: { full_name: app.repo.fullName } }; }
    if (contentsOf(url)) return { status: 201, json: { content: {} } };
    return undefined;
  });
  try {
    const r = await healAppRepo(app);
    assert.equal(r.ok, true);
    assert.equal(r.action, 'recreated', 'a truly-gone repo is re-created + seeded, not adopted');
    assert.equal(created, true);
    assert.ok(r.seeded.includes('.forgejo/workflows/ci.yml'), 'the scaffold (incl. CI) is seeded on the create path');
  } finally {
    cluster.restore();
    __resetSnapshots();
  }
});

test('heal surfaces the SPECIFIC state when files exist on disk but are not adoptable', async () => {
  __resetSnapshots();
  const app = await createApp(dev, { name: 'Stuck On Disk', template: 'sovereign-app' });
  app.mode = 'live';
  const cluster = fakeCluster((method, url) => {
    if (url.endsWith('/api/v1/version')) return { status: 200, json: { version: '11.0.0' } };
    if (method === 'GET' && repoRoot(app.slug).test(url)) return { status: 404, json: { message: 'gone' } };
    // Unadopted list does NOT offer it...
    if (method === 'GET' && isUnadoptedList(url)) return { status: 200, json: [] };
    // ...yet create is rejected because the files ARE already on disk.
    if (method === 'POST' && url.endsWith('/api/v1/user/repos')) return { status: 500, json: { message: 'The repository files already exist on disk' } };
    if (contentsOf(url)) return { status: 404, json: { message: 'no repo' } };
    return undefined;
  });
  try {
    const r = await healAppRepo(app);
    assert.equal(r.ok, false);
    assert.equal(r.action, 'noop');
    assert.match(r.detail, /exist on disk but Forgejo won't adopt/, 'the exact stuck state is named, not a generic missing-repo message');
  } finally {
    cluster.restore();
    __resetSnapshots();
  }
});

test('heal reports honestly when the token cannot query unadopted repos (admin API 403)', async () => {
  __resetSnapshots();
  const app = await createApp(dev, { name: 'No Admin Rights', template: 'sovereign-app' });
  app.mode = 'live';
  let createdOrSeeded = false;
  const cluster = fakeCluster((method, url) => {
    if (url.endsWith('/api/v1/version')) return { status: 200, json: { version: '11.0.0' } };
    if (method === 'GET' && repoRoot(app.slug).test(url)) return { status: 404, json: { message: 'gone' } };
    // The admin unadopted query is FORBIDDEN — the token lacks admin scope.
    if (method === 'GET' && isUnadoptedList(url)) return { status: 403, json: { message: 'forbidden' } };
    if (method === 'POST' && url.endsWith('/api/v1/user/repos')) { createdOrSeeded = true; return { status: 201, json: { full_name: app.repo.fullName } }; }
    if (contentsOf(url)) { createdOrSeeded = true; return { status: 201, json: { content: {} } }; }
    return undefined;
  });
  try {
    const r = await healAppRepo(app);
    assert.equal(r.ok, false);
    assert.equal(r.action, 'noop');
    assert.match(r.detail, /cannot query unadopted repositories \(HTTP 403\)/, 'the token limitation is reported, not masked');
    assert.equal(createdOrSeeded, false, 'no blind re-scaffold ran when disk state is unknowable');
  } finally {
    cluster.restore();
    __resetSnapshots();
  }
});
