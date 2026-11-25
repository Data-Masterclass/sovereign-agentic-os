/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * upload-create.int.test — the OPA rule `agentic.authz.upload_create` against the REAL OPA container
 * started from the chart (tests/opa/run-chart-opa.py, the chart's pinned image and its rendered
 * policies), reached through the OS's real `authorize()` and the real chat attachment door.
 *
 *  1. The decision table (owner in own domain / another domain / for someone else / shared tier /
 *     admin / unknown kind), asked of real OPA through `uploadCreateDecision` — the one builder every
 *     upload door uses (Files, Data, Knowledge, chat attachments).
 *  2. The door: a markdown attachment becomes a personal note in My scope through the real Knowledge
 *     sink; a user whose domain is not the target is denied and nothing is written.
 *  3. Fail closed: with the OPA container STOPPED, the attachment is denied and nothing is written.
 *
 * Run: OPA_IT_OPEN_URL=http://127.0.0.1:18182 OPA_IT_OPEN_CONTAINER=opa-it-open node \
 *   --experimental-test-module-mocks --import ./scripts/test-setup.mjs --test ../tests/opa/upload-create.int.test.ts
 *   (from os-ui/; the open instance has OPA's API protection off, the policies are the chart's)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const OPA = process.env.OPA_IT_OPEN_URL;
const CONTAINER = process.env.OPA_IT_OPEN_CONTAINER;
if (!OPA || !CONTAINER) throw new Error('upload-create.int.test needs OPA_IT_OPEN_URL and OPA_IT_OPEN_CONTAINER (a real OPA container)');
process.env.OPA_URL = OPA;

const { authorize, uploadCreateDecision } = await import('@core/infra/governed');
const { routeAttachments, attachmentWiring } = await import('@core/runtime/chat-attachments-server');
const { registerChatAttachmentSinks } = await import('@/chat-attachment-sinks');
const { listPersonalKnowledge, __resetStore: resetNotes } = await import('@tabs/knowledge/lib/personal-store');

type U = { id: string; name: string; domains: string[]; role: 'creator' | 'builder' | 'domain_admin' | 'admin' };
const cara: U = { id: 'cara', name: 'Cara', domains: ['sales'], role: 'creator' };
const ada: U = { id: 'ada', name: 'Ada', domains: [], role: 'admin' };
const nobody: U = { id: 'nemo', name: 'Nemo', domains: [], role: 'creator' };
const KIND = { data: 'dataset', files: 'file', knowledge: 'knowledge' } as const;

async function waitForOpa(): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(`${OPA}/health`)).ok) return; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('OPA did not become healthy');
}
before(waitForOpa);
registerChatAttachmentSinks();
const ports = () => ({
  ...attachmentWiring(),
  authorizeCreate: (u: U, d: 'data' | 'files' | 'knowledge') => authorize(`user:${u.id}`, 'upload.create', uploadCreateDecision(u, KIND[d])),
});

test('real OPA: the decision table', async () => {
  const ask = async (input: Record<string, unknown>) =>
    (await authorize('user:x', 'upload.create', { rule: 'upload_create', input })).allowed;
  const base = (kind: string, actor: U, target: Record<string, unknown>) =>
    ({ action: 'upload.create', kind, actor: { id: actor.id, role: actor.role, domains: actor.domains }, target });
  for (const kind of ['file', 'dataset', 'knowledge'] as const) {
    assert.equal((await authorize('user:cara', 'upload.create', uploadCreateDecision(cara, kind))).allowed, true, `owner, own domain, ${kind}`);
  }
  assert.equal((await authorize('user:ada', 'upload.create', uploadCreateDecision(ada, 'file'))).allowed, true, 'admin spans the tenant');
  assert.equal((await authorize('user:nemo', 'upload.create', uploadCreateDecision(nobody, 'file'))).allowed, false, 'a creator in no domain');
  assert.equal(await ask(base('file', cara, { tier: 'personal', owner: 'cara', domain: 'finance' })), false, 'another domain');
  assert.equal(await ask(base('file', cara, { tier: 'personal', owner: 'maya', domain: 'sales' })), false, 'for someone else');
  assert.equal(await ask(base('file', cara, { tier: 'shared', owner: 'cara', domain: 'sales' })), false, 'straight to Domain');
  assert.equal(await ask(base('agent', cara, { tier: 'personal', owner: 'cara', domain: 'sales' })), false, 'unknown kind');
});

test('real OPA, real Knowledge sink: an .md attachment becomes a personal note; a denied user writes nothing', async () => {
  resetNotes();
  const ok = await routeAttachments(cara, [{ name: 'refunds.md', bytes: Buffer.from('# Refunds\nWithin 30 days.') }], ports());
  assert.equal(ok.results[0].outcome, 'created', ok.results[0].message);
  assert.equal(listPersonalKnowledge(cara).mine.length, 1);
  const no = await routeAttachments(nobody, [{ name: 'x.md', bytes: Buffer.from('# x') }], ports());
  assert.equal(no.results[0].outcome, 'denied');
  assert.equal(listPersonalKnowledge(nobody).mine.length, 0);
});

test('real OPA STOPPED: the attachment is denied (fail closed) and nothing is written', async () => {
  resetNotes();
  execFileSync('docker', ['stop', CONTAINER], { stdio: 'ignore' });
  try {
    const out = await routeAttachments(cara, [{ name: 'later.md', bytes: Buffer.from('# later') }], ports());
    assert.equal(out.results[0].outcome, 'denied');
    assert.equal(listPersonalKnowledge(cara).mine.length, 0);
  } finally {
    execFileSync('docker', ['start', CONTAINER], { stdio: 'ignore' });
  }
});

after(() => {
  try { execFileSync('docker', ['start', CONTAINER], { stdio: 'ignore' }); } catch { /* already running */ }
});
