/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The upload doors at the HTTP boundary — chat attachments, Files, Data, Knowledge
 * USER STORY: As a platform owner I want every upload door to refuse a create that policy does not
 *             allow with a 403 AND an audit record naming the decision, and the chat attachment
 *             door to refuse a request it cannot size before reading it.
 * ARCHITECTURE:
 *   - Drives the REAL route handlers (`app/api/assistant/attachments`, `app/api/files`,
 *     `app/api/data/datasets`, `app/api/knowledge/personal`) with real Requests. The session is
 *     mocked at the auth seam (`@core/kernel/auth`); OPA is played over `fetch` with a scripted
 *     verdict; the stores and the platform audit store are the real in-memory ones.
 *   - Lives in tests/chat/ (CI's chat step): it imports routes and several tabs' stores.
 */
import { test, beforeEach, after, mock } from 'node:test';
import assert from 'node:assert/strict';

const realFetch = globalThis.fetch;
let verdict: boolean | 'unreachable' = true;
let asks: Record<string, unknown>[] = [];
globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
  const u = String(url instanceof Request ? url.url : url);
  if (u.includes('/v1/data/agentic/authz/upload_create')) {
    asks.push((JSON.parse(init?.body ?? '{}') as { input: Record<string, unknown> }).input);
    if (verdict === 'unreachable') throw new Error('connect ECONNREFUSED');
    return new Response(JSON.stringify({ result: verdict, decision_id: 'dec-9' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.endsWith('/v1/config')) return new Response(JSON.stringify({ result: { labels: { policy_rev: 'rev-3' } } }), { status: 200 });
  throw new Error('offline-stub');
}) as typeof fetch;
(process.env as Record<string, string>).NODE_ENV = 'development';

const USER = { id: 'cara', name: 'Cara', domains: ['sales'], allDomains: ['sales'], activeDomain: null, role: 'creator' };
mock.module('@core/kernel/auth', {
  namedExports: { requireUser: async () => USER, currentUser: async () => USER },
});

const attachments = await import('@/app/api/assistant/attachments/route');
const filesRoute = await import('@/app/api/files/route');
const datasetsRoute = await import('@/app/api/data/datasets/route');
const notesRoute = await import('@/app/api/knowledge/personal/route');
const { registerChatAttachmentSinks } = await import('@/chat-attachment-sinks');
const { listAudit, _resetAudit } = await import('@tabs/admin/lib/audit');
const { listPersonalKnowledge, __resetStore: resetNotes } = await import('@tabs/knowledge/lib/personal-store');
const { listDatasets, __resetStore: resetData } = await import('@tabs/data/lib/store');
const { listFiles, __resetStore: resetFiles } = await import('@tabs/files/lib/store');

registerChatAttachmentSinks();
beforeEach(() => { verdict = true; asks = []; _resetAudit(); resetNotes(); resetData(); resetFiles(); });
after(() => { globalThis.fetch = realFetch; });

const cara = { id: 'cara', domains: ['sales'], role: 'creator' as const };

/** A multipart request with an honest Content-Length (as a browser sends it). */
async function multipart(url: string, form: FormData, opts: { dropLength?: boolean; length?: number } = {}): Promise<Request> {
  const probe = new Request(url, { method: 'POST', body: form });
  const body = Buffer.from(await probe.arrayBuffer());
  const headers: Record<string, string> = { 'content-type': probe.headers.get('content-type')! };
  if (!opts.dropLength) headers['content-length'] = String(opts.length ?? body.length);
  return new Request(url, { method: 'POST', headers, body });
}
const ATT = 'https://os.example.com/api/assistant/attachments';

// ------------------------------------------------------------ attachments --

test('attachments: multipart without a Content-Length is refused (411) before the body is read', async () => {
  const f = new FormData();
  f.append('file', new File(['# hi'], 'n.md'));
  const res = await attachments.POST(await multipart(ATT, f, { dropLength: true }));
  assert.equal(res.status, 411);
  assert.equal(asks.length, 0);
  assert.equal(listPersonalKnowledge(cara).mine.length, 0);
});

test('attachments: a declared size over the cap is refused (413) before the body is read', async () => {
  const f = new FormData();
  f.append('file', new File(['# hi'], 'n.md'));
  const res = await attachments.POST(await multipart(ATT, f, { length: 10 * 1024 * 1024 * 1024 }));
  assert.equal(res.status, 413);
  assert.equal(asks.length, 0);
});

test('attachments: not multipart → 400; bad "destinations" → 400; no file → 400', async () => {
  const json = await attachments.POST(new Request(ATT, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '2' }, body: '{}' }));
  assert.equal(json.status, 400);
  const bad = new FormData();
  bad.append('file', new File(['# hi'], 'n.md'));
  bad.append('destinations', 'not json');
  assert.equal((await attachments.POST(await multipart(ATT, bad))).status, 400);
  const none = new FormData();
  none.append('destinations', '[]');
  assert.equal((await attachments.POST(await multipart(ATT, none))).status, 400);
});

test('attachments: files and their destinations are read in order; the result names what was created', async () => {
  const f = new FormData();
  f.append('file', new File(['# Refunds\n30 days.'], 'refunds.md'));
  f.append('file', new File(['# Also a note'], 'other.md'));
  f.append('destinations', JSON.stringify([null, 'files']));
  const res = await attachments.POST(await multipart(ATT, f));
  assert.equal(res.status, 200);
  const j = (await res.json()) as { results: { outcome: string; destination: string }[]; reference: string };
  assert.deepEqual(j.results.map((r) => [r.outcome, r.destination]), [['created', 'knowledge'], ['created', 'files']]);
  assert.equal(listPersonalKnowledge(cara).mine.length, 1);
  assert.equal(listFiles(cara).mine.length, 1);
  assert.match(j.reference, /Knowledge note "refunds"/);
});

test('attachments: OPA deny and OPA unreachable are audited differently, each naming the policy outcome', async () => {
  const f = () => { const x = new FormData(); x.append('file', new File(['# n'], 'n.md')); return x; };
  verdict = false;
  await attachments.POST(await multipart(ATT, f()));
  verdict = 'unreachable';
  await attachments.POST(await multipart(ATT, f()));
  const rows = listAudit({ prefix: 'assistant.attachment' }).reverse();
  assert.equal(rows.length, 2);
  assert.equal((rows[0].data as Record<string, unknown>).policy, 'opa-deny');
  assert.equal(rows[0].decisionId, 'dec-9');
  assert.equal((rows[1].data as Record<string, unknown>).policy, 'opa-unreachable');
  assert.ok(rows.every((r) => r.result === 'denied'));
  assert.equal(listPersonalKnowledge(cara).mine.length, 0);
});

// ------------------------------------------------- the three guarded doors --

async function expectRefusedAndAudited(res: Response, kind: string, door: string, policy: string) {
  assert.equal(res.status, 403);
  assert.match(((await res.json()) as { error: string }).error, /Nothing was written/);
  const rows = listAudit({ prefix: 'upload.create' });
  assert.equal(rows.length, 1, `${door}: one audit record`);
  assert.equal(rows[0].actor, 'cara');
  assert.equal(rows[0].result, 'denied');
  const data = rows[0].data as Record<string, unknown>;
  assert.equal(data.kind, kind);
  assert.equal(data.door, door);
  assert.equal(data.policy, policy);
}

test('POST /api/files: a denied create is a 403 with an audit record; nothing is stored', async () => {
  verdict = false;
  const f = new FormData();
  f.append('file', new File(['%PDF-1.4 x'], 'r.pdf'));
  const res = await filesRoute.POST(await multipart('https://os.example.com/api/files', f));
  await expectRefusedAndAudited(res, 'file', 'POST /api/files', 'opa-deny');
  assert.equal(listFiles(cara).mine.length, 0);
});

test('POST /api/data/datasets: a create OPA cannot answer for is a 403 with an audit record; nothing is created', async () => {
  verdict = 'unreachable';
  const res = await datasetsRoute.POST(new Request('https://os.example.com/api/data/datasets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Sales' }) }));
  await expectRefusedAndAudited(res, 'dataset', 'POST /api/data/datasets', 'opa-unreachable');
  assert.equal(listDatasets(cara).mine.length, 0);
});

test('POST /api/knowledge/personal: a denied create is a 403 with an audit record; nothing is saved', async () => {
  verdict = false;
  const res = await notesRoute.POST(new Request('https://os.example.com/api/knowledge/personal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'T', md: '# t' }) }));
  await expectRefusedAndAudited(res, 'knowledge', 'POST /api/knowledge/personal', 'opa-deny');
  assert.equal(listPersonalKnowledge(cara).mine.length, 0);
});

test('TWIN: an allowed create on the guarded doors still works and writes no refusal record', async () => {
  const res = await notesRoute.POST(new Request('https://os.example.com/api/knowledge/personal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'T', md: '# t' }) }));
  assert.equal(res.status, 200);
  assert.equal(listAudit({ prefix: 'upload.create' }).length, 0);
  assert.equal(listPersonalKnowledge(cara).mine.length, 1);
});
