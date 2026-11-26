/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Chat attachments land through the tabs' EXISTING services, in the caller's My scope
 * USER STORY: As a user I want a CSV or an Excel sheet I attach to become a real private dataset
 *             with its Bronze ingested, and a markdown file a personal knowledge note — exactly what
 *             the Data and Knowledge tabs would have made — and a failed ingest to leave nothing.
 * ARCHITECTURE:
 *   - Drives the REAL boot wiring (`os-ui/chat-attachment-sinks.ts`) through the real door
 *     (`routeAttachments`) and the real stores. The network is unreachable (`fetch` rejects), so the
 *     data-runner is down and the ingest takes the honestly-labelled offline-mock path the teaching
 *     flow allows outside production — the same path `tabs/data/lib/ingest-columns.test.ts` uses.
 *   - OPA is the only scripted network peer (an allowing verdict), so the door's decision is real.
 *   - Lives in tests/chat/ (run by CI's unit job beside the other chat tests): it needs the root
 *     wiring file and the tab stores, which core/ code may not import.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { xlsx } from '@core/testing/account-fixtures';

const realFetch = globalThis.fetch;
let opaAsks = 0;
globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
  if (String(url).includes('/v1/data/agentic/authz/upload_create')) {
    opaAsks += 1;
    return new Response(JSON.stringify({ result: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  void init;
  throw new Error('offline-stub');
}) as typeof fetch;
(process.env as Record<string, string>).NODE_ENV = 'development';

const { chatAttachmentSinks, registerChatAttachmentSinks } = await import('@/chat-attachment-sinks');
const { routeAttachments, attachmentWiring } = await import('@core/runtime/chat-attachments-server');
type AttachmentUser = import('@core/runtime/chat-attachments-server').AttachmentUser;
const { authorize, uploadCreateDecision } = await import('@core/infra/governed');
const { getDataset, listDatasets, __resetStore: resetData } = await import('@tabs/data/lib/store');
const { listPersonalKnowledge, __resetStore: resetNotes } = await import('@tabs/knowledge/lib/personal-store');
const { listAudit, _resetAudit } = await import('@tabs/admin/lib/audit');
const { makeChatAttachmentSinks } = await import('@/chat-attachment-sinks');
const { bronzeTarget, laneSlug, personalSchema } = await import('@tabs/data/lib/store-fqn');
// Every top-level `await` stays ABOVE the first test()/after(): on Node 22 the runner starts the tests
// already registered while the module is still suspended on a later top-level await, and when those
// finish it runs the root after() hook (restoring the real fetch) BEFORE the tests registered after the
// await. Those then asked the real (unreachable) OPA and were denied — fail closed, as designed.

const cara = { id: 'cara', name: 'Cara', domains: ['sales'], role: 'creator' as const };
const KIND = { data: 'dataset', files: 'file', knowledge: 'knowledge' } as const;

registerChatAttachmentSinks();
const ports = () => ({
  ...attachmentWiring(),
  authorizeCreate: (u: AttachmentUser, d: 'data' | 'files' | 'knowledge') => authorize(`user:${u.id}`, 'upload.create', uploadCreateDecision(u, KIND[d])),
});
const file = (name: string, body: string | Buffer, destination?: string) => ({ name, bytes: Buffer.isBuffer(body) ? body : Buffer.from(body), destination });

beforeEach(() => { resetData(); resetNotes(); _resetAudit(); opaAsks = 0; });
after(() => { globalThis.fetch = realFetch; });

test('xlsx → the first sheet is read and lands through the rows (grid → Bronze) ingest as a private dataset', async () => {
  const book = xlsx({ Orders: [['Region', 'Amount'], ['North', 10], ['South', 20]], Notes: [['x']] });
  const out = await routeAttachments(cara, [file('Q3 orders.xlsx', book)], ports());
  const r = out.results[0];
  assert.equal(r.outcome, 'created', r.message);
  assert.equal(r.item?.type, 'dataset');
  assert.match(r.item!.detail!, /Bronze landed \(offline teaching mock\): 2 rows .*first sheet “Orders” of 2/);
  const d = getDataset(r.item!.id, cara);
  assert.equal(d.name, 'Q3 orders');
  // My scope only: private, owned by the caller, nothing promoted
  assert.equal(d.owner, 'cara');
  assert.equal(d.tier, 'dataset');
  assert.equal(d.visibility, 'private');
  assert.equal(d.versions.bronze.built, true);
  assert.deepEqual(d.columns.map((c) => c.name), ['region', 'amount']);
  assert.equal(opaAsks, 1);
  assert.match(out.reference, new RegExp(`Dataset "Q3 orders" \\(id ${r.item!.id}, Data;`));
});

test('csv → createDatasetService + ingestAndRegisterBronze; a second "sales.csv" gets a unique name, not a 409', async () => {
  const a = await routeAttachments(cara, [file('sales.csv', 'region,amount\nnorth,10\n')], ports());
  const b = await routeAttachments(cara, [file('sales.csv', 'region,amount\nsouth,20\n')], ports());
  assert.equal(a.results[0].outcome, 'created', a.results[0].message);
  assert.equal(b.results[0].outcome, 'created', b.results[0].message);
  assert.equal(getDataset(b.results[0].item!.id, cara).name, 'sales (2)');
  assert.equal(listDatasets(cara).mine.length, 2);
});

test('an unreadable workbook writes nothing at all (read BEFORE the dataset is created)', async () => {
  // A ZIP that claims to be a workbook but has no sheets.
  const { zip } = await import('@core/testing/account-fixtures');
  const broken = zip({ 'xl/workbook.xml': '<workbook><sheets></sheets></workbook>' });
  const out = await routeAttachments(cara, [file('broken.xlsx', broken)], ports());
  assert.equal(out.results[0].outcome, 'failed');
  assert.match(out.results[0].message, /no sheets/);
  assert.equal(listDatasets(cara).mine.length, 0);
  assert.equal(listAudit({ prefix: 'assistant.attachment' })[0].result, 'error');
});

test('an ingest that does not verify takes back the dataset it created: nothing is left behind', async () => {
  // Offline, the teaching mock previews an NDJSON line as one CSV column named `{"x":1}` — a name
  // the registry refuses (a brace), so the ingest returns ok:false after the dataset was created.
  const out = await routeAttachments(cara, [file('events.ndjson', '{"x":1}\n')], ports());
  assert.equal(out.results[0].outcome, 'failed');
  assert.match(out.results[0].message, /could not be ingested: .*Nothing was kept/);
  assert.equal(listDatasets(cara).mine.length, 0);
});

// ---- A failed ingest that HAD landed its Bronze table (the runner wrote + verified it, then
// registration refused). A fake lakehouse stands in for Trino: the fake runner lands the real lane
// table name of the dataset the sink created; the governed DROP and the information_schema check
// act on that same set. Before the fix the sink deleted only the registry record and said
// "Nothing was kept" while the table stayed — exactly what these tests catch.

function lakehouse(opts: { dropFails?: boolean; ingestThrowsAfterLanding?: boolean } = {}) {
  const tables = new Set<string>();
  const drops: { sql: string; principal: string; uid: string }[] = [];
  const landTableOf = (datasetId: string) => bronzeTarget(personalSchema(cara.id), laneSlug(getDataset(datasetId, cara)));
  const deps = {
    ingestFile: async (_u: unknown, datasetId: string) => {
      const table = landTableOf(datasetId);
      tables.add(table); // the runner wrote and verified the physical table …
      if (opts.ingestThrowsAfterLanding) throw new Error('buildVersion failed');
      // … then registration refused it (a column name the registry cannot hold)
      return { ok: false, report: { ok: false, mode: 'live' as const, table, rowCount: 1, columns: [], preview: { columns: [], rows: [] }, detail: '', error: 'column "{x}" cannot be registered' } };
    },
    ingestGrid: async () => { throw new Error('not used'); },
    exec: async (sql: string, identity: { principal: string; uid: string }) => {
      drops.push({ sql, principal: identity.principal, uid: identity.uid });
      if (opts.dropFails) throw new Error('query-tool 503');
      const m = /^drop table if exists (\S+)$/.exec(sql);
      if (m) tables.delete(m[1]);
    },
    tableExists: async (fqn: string) => tables.has(fqn),
  };
  const p = () => ({ ...ports(), sinks: makeChatAttachmentSinks(deps) });
  return { tables, drops, ports: p };
}

test('a failed ingest that landed its Bronze table: the lane table is dropped (governed, as the owner), verified gone, then the record goes', async () => {
  const lh = lakehouse();
  const out = await routeAttachments(cara, [file('orders.csv', 'a,b\n1,2\n')], lh.ports());
  assert.equal(out.results[0].outcome, 'failed');
  assert.match(out.results[0].message, /could not be ingested: column "\{x\}" cannot be registered\. Nothing was kept\./);
  assert.equal(lh.tables.size, 0, 'no orphan Bronze table is left behind');
  assert.equal(lh.drops.length, 1);
  assert.match(lh.drops[0].sql, /^drop table if exists iceberg\.personal_cara\.bronze_/);
  assert.equal(lh.drops[0].principal, 'cara', 'the drop runs as the owner, in their own lane');
  assert.equal(listDatasets(cara).mine.length, 0);
});

test('a throw AFTER the table landed is cleaned up the same way', async () => {
  const lh = lakehouse({ ingestThrowsAfterLanding: true });
  const out = await routeAttachments(cara, [file('orders.csv', 'a,b\n1,2\n')], lh.ports());
  assert.equal(out.results[0].outcome, 'failed');
  assert.match(out.results[0].message, /buildVersion failed\. Nothing was kept/);
  assert.equal(lh.tables.size, 0);
  assert.equal(listDatasets(cara).mine.length, 0);
});

test('when the drop fails, the dataset is KEPT and named, and the message tells the truth (never "Nothing was kept")', async () => {
  const lh = lakehouse({ dropFails: true });
  const out = await routeAttachments(cara, [file('orders.csv', 'a,b\n1,2\n')], lh.ports());
  const r = out.results[0];
  assert.equal(r.outcome, 'failed');
  assert.doesNotMatch(r.message, /Nothing was kept/);
  assert.match(r.message, /is KEPT in your Data because its table iceberg\.personal_cara\.bronze_\S+ could not be removed \(query-tool 503\)/);
  assert.equal(lh.tables.size, 1, 'the table is still there …');
  assert.equal(listDatasets(cara).mine.length, 1, '… and so is the record that names it');
  assert.equal(r.item?.id, listDatasets(cara).mine[0].id);
  assert.match(out.reference, /is KEPT in your Data/);
  assert.equal(listAudit({ prefix: 'assistant.attachment' })[0].result, 'error');
});

test('md → a personal knowledge note (My scope), audited in the platform audit store', async () => {
  const out = await routeAttachments(cara, [file('refund-rule.md', '﻿# Refund rule\n\nWithin 30 days.')], ports());
  const r = out.results[0];
  assert.equal(r.outcome, 'created', r.message);
  assert.equal(r.item?.type, 'knowledge');
  const mine = listPersonalKnowledge(cara).mine;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].title, 'refund-rule');
  assert.equal(mine[0].visibility, 'Personal');
  assert.equal(mine[0].owner, 'cara');
  const rows = listAudit({ prefix: 'assistant.attachment' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor, 'cara');
  assert.equal(rows[0].result, 'ok');
  assert.equal(rows[0].target, `knowledge:${r.item!.id}`);
  assert.equal((rows[0].data as Record<string, unknown>).destination, 'knowledge');
});

test('pdf → the Files upload service: a private file in My scope, original bytes kept', async () => {
  const { getFile, __resetStore: resetFiles } = await import('@tabs/files/lib/store');
  resetFiles();
  const pdf = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >>\nendobj\n');
  const out = await routeAttachments(cara, [file('Board deck.pdf', pdf)], ports());
  const r = out.results[0];
  assert.equal(r.outcome, 'created', r.message);
  assert.equal(r.item?.type, 'file');
  assert.match(r.item!.href, /^\/unstructured\?focus=/);
  const v = getFile(r.item!.id, cara);
  assert.equal(v.asset.name, 'Board deck.pdf');
  assert.equal(v.asset.owner, 'cara');
  assert.equal(v.asset.tier, 'dataset', 'a file is born private (the Data lifecycle’s private tier)');
  assert.equal(v.object?.contentType, 'application/pdf');
  assert.equal(v.bytes, pdf.length);
});

test('the sinks’ size caps are the existing ones: the upload limit for Data and Files, the note cap for Knowledge', async () => {
  const { config } = await import('@core/kernel/config');
  const { KNOWLEDGE_NOTE_MAX_BYTES } = await import('@core/runtime/chat-attachments');
  assert.equal(chatAttachmentSinks.data.maxBytes(), config.uploadMaxBytes);
  assert.equal(chatAttachmentSinks.files.maxBytes(), config.uploadMaxBytes);
  assert.equal(chatAttachmentSinks.knowledge.maxBytes(), KNOWLEDGE_NOTE_MAX_BYTES);
});
