/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realForgejo } from './live-clients.ts';

/**
 * Regression guard for the Build "Forgejo write system.yaml failed (422)" bug.
 *
 * Root cause: `writeFile` always issued PUT (Forgejo's UpdateFile, which REQUIRES
 * a `sha`), so CREATING a not-yet-existing file — the first Build's system.yaml —
 * 422'd. The fix creates with POST when there is no sha and updates with PUT+sha
 * when the file exists, with a 422→re-read-sha→PUT fallback for the create race.
 *
 * These tests drive the REAL client against an in-memory fake `fetch` that mimics
 * Forgejo's contents-API semantics (POST=create/422-if-exists, PUT=update/requires
 * sha), so the create-vs-update branch is genuinely exercised without a network.
 */

type FileRec = { sha: string; b64: string };

/** Deterministic blob sha for the fake. */
function blobSha(b64: string): string {
  let h = 0;
  for (let i = 0; i < b64.length; i++) h = (Math.imul(31, h) + b64.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** A fake `fetch` implementing just enough of the Forgejo contents API. */
function fakeForgejoFetch(files: Map<string, FileRec>, calls: string[]): typeof fetch {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname; // /api/v1/...
    calls.push(`${method} ${path}`);

    // ensureRepo
    if (method === 'POST' && path === '/api/v1/user/repos') return json(201, {});

    // /api/v1/repos/{owner}/{repo}/contents/{filepath}
    const m = path.match(/^\/api\/v1\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/);
    if (m) {
      const filepath = decodeURIComponent(m[1]);
      const body = init?.body ? (JSON.parse(String(init.body)) as { content?: string; sha?: string }) : {};

      if (method === 'GET') {
        const rec = files.get(filepath);
        if (!rec) return json(404, { message: 'file not found' });
        return json(200, { content: rec.b64, encoding: 'base64', sha: rec.sha });
      }
      if (method === 'POST') {
        // CreateFile — 422 if the file already exists.
        if (files.get(filepath)) return json(422, { message: 'repository file already exists' });
        const rec = { sha: blobSha(body.content ?? ''), b64: body.content ?? '' };
        files.set(filepath, rec);
        return json(201, { content: { sha: rec.sha } });
      }
      if (method === 'PUT') {
        // UpdateFile — sha is REQUIRED and must match; this is the 422 the bug hit.
        const cur = files.get(filepath);
        if (!body.sha) return json(422, { message: 'sha is required' });
        if (!cur || cur.sha !== body.sha) return json(422, { message: 'sha does not match' });
        const rec = { sha: blobSha(body.content ?? ''), b64: body.content ?? '' };
        files.set(filepath, rec);
        return json(200, { content: { sha: rec.sha } });
      }
    }
    return json(404, { message: 'unhandled' });
  }) as unknown as typeof fetch;
}

test('forgejo writeFile CREATEs a new file with POST (no 422) and reads it back', async () => {
  const files = new Map<string, FileRec>();
  const calls: string[] = [];
  const fj = realForgejo(fakeForgejoFetch(files, calls));

  await fj.ensureRepo('os-sys1');
  // First Build: system.yaml does not exist yet → sha undefined → must POST, not PUT.
  const res = await fj.writeFile('os-sys1', 'system.yaml', 'name: Desk\n', undefined);
  assert.ok(res.sha, 'create returned the new blob sha');
  assert.ok(calls.includes('POST /api/v1/repos/gitea_admin/os-sys1/contents/system.yaml'), 'used POST to create');
  assert.ok(!calls.some((c) => c.startsWith('PUT ')), 'did not PUT a brand-new file');

  const back = await fj.readFile('os-sys1', 'system.yaml');
  assert.equal(back?.content, 'name: Desk\n', 'round-trips content');
});

test('forgejo writeFile UPDATEs an existing file with PUT+sha (no 422)', async () => {
  const files = new Map<string, FileRec>();
  const calls: string[] = [];
  const fj = realForgejo(fakeForgejoFetch(files, calls));

  await fj.writeFile('os-sys1', 'system.yaml', 'v1\n', undefined); // create
  const cur = await fj.readFile('os-sys1', 'system.yaml');
  const res = await fj.writeFile('os-sys1', 'system.yaml', 'v2\n', cur?.sha); // update with sha
  assert.ok(res.sha, 'update returned a new sha');
  assert.ok(calls.includes('PUT /api/v1/repos/gitea_admin/os-sys1/contents/system.yaml'), 'used PUT to update');

  const back = await fj.readFile('os-sys1', 'system.yaml');
  assert.equal(back?.content, 'v2\n', 'update took effect');
});

test('forgejo writeFile recovers from a create race (POST 422 → re-read sha → PUT)', async () => {
  const files = new Map<string, FileRec>();
  const calls: string[] = [];
  const fj = realForgejo(fakeForgejoFetch(files, calls));

  // Simulate the file having appeared concurrently (exists) while the caller still
  // believes it is new (sha undefined). POST → 422; the client must recover.
  files.set('system.yaml', { sha: blobSha('cGRl'), b64: 'cGRl' });
  const res = await fj.writeFile('os-sys1', 'system.yaml', 'raced\n', undefined);
  assert.ok(res.sha, 'recovered and returned a sha (no thrown 422)');
  assert.ok(calls.includes('POST /api/v1/repos/gitea_admin/os-sys1/contents/system.yaml'), 'tried POST first');
  assert.ok(calls.includes('PUT /api/v1/repos/gitea_admin/os-sys1/contents/system.yaml'), 'fell back to PUT');
});
