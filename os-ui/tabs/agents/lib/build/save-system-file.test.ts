/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Saving system.yaml also says which grants the saver cannot use
 * USER STORY: As a student who pasted a dataset id that is private to another user into
 *             system.yaml, I want the save to land AND tell me I cannot see that dataset.
 * ARCHITECTURE:
 *   - `saveSystemFile` is what PUT `/api/agents/systems/[id]/files` runs (a test cannot import a
 *     `route.ts`); the last test is a source tripwire that the route really delegates to it.
 *   - Real stores, real governed door: the systems and datasets are created as the users would.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const { handleRpc } = await import('@core/mcp/server');
const { createSystem, readFile, listFiles } = await import('@tabs/agents/lib/store');
const { parseSystem, serializeSystem } = await import('@tabs/agents/lib/system-schema');
const { saveSystemFile } = await import('./save-system-file.ts');

const student = { id: 'stud_ssf', name: 'Student', domains: ['autumn'], allDomains: ['autumn'], activeDomain: null, role: 'creator' as const };
const other = { id: 'other_ssf', name: 'Other', domains: ['autumn'], allDomains: ['autumn'], activeDomain: null, role: 'creator' as const };

async function createDataset(user: typeof student, name: string): Promise<string> {
  const res = (await handleRpc(user, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_dataset', arguments: { name } } })) as { result: { content: { text: string }[] } };
  const r = JSON.parse(res.result.content[0].text) as Record<string, unknown>;
  return String((r.dataset as { id?: string } | undefined)?.id ?? r.id ?? r.datasetId);
}

/** The saved yaml with one Read data grant on `id` — what a template, the assistant or a paste writes. */
function withDataGrant(yaml: string, id: string): string {
  const sys = parseSystem(yaml);
  sys.grants.data = [{ id, capability: 'Read' }];
  return serializeSystem(sys);
}

test('PUT system.yaml with a grant on another user’s PRIVATE dataset: saved, and grantWarnings says so without leaking', async () => {
  const theirs = await createDataset(other, 'Confidential pipeline');
  const rec = createSystem(student, { name: 'Student team', domain: 'autumn' });
  const cur = readFile(rec.id, student, 'system.yaml');
  const saved = await saveSystemFile(rec.id, student, { path: 'system.yaml', content: withDataGrant(cur.content, theirs), sha: cur.sha });

  // Still saved (a warning, not a gate).
  assert.ok(readFile(rec.id, student, 'system.yaml').content.includes(theirs), 'the grant was saved');
  assert.equal(saved.grantWarnings?.length, 1, JSON.stringify(saved.grantWarnings));
  const w = saved.grantWarnings![0];
  assert.equal(w.kind, 'data');
  assert.equal(w.id, theirs);
  assert.equal(w.status, 'not-visible');
  assert.match(w.message, /You can't see this dataset — it is private to its owner or not shared with your domain\. Ask the owner to share it to the autumn domain\./);
  // NO LEAK: the response carries nothing about the hidden dataset but its id.
  const wire = JSON.stringify(saved.grantWarnings);
  assert.doesNotMatch(wire, /Confidential pipeline/);
  assert.doesNotMatch(wire, /other_ssf/);
});

test('PUT system.yaml with only grants you can use returns an empty grantWarnings', async () => {
  const mine = await createDataset(student, 'My own orders');
  const rec = createSystem(student, { name: 'Student team 2', domain: 'autumn' });
  const cur = readFile(rec.id, student, 'system.yaml');
  const saved = await saveSystemFile(rec.id, student, { path: 'system.yaml', content: withDataGrant(cur.content, mine), sha: cur.sha });
  assert.deepEqual(saved.grantWarnings, []);
});

test('a non-yaml file save carries no grantWarnings and never runs the check', async () => {
  const rec = createSystem(student, { name: 'Student team 3', domain: 'autumn' });
  const md = listFiles(rec.id, student).files.find((f) => f.endsWith('AGENT.md'));
  assert.ok(md, 'the system has an AGENT.md');
  const cur = readFile(rec.id, student, md!);
  let ran = false;
  const saved = await saveSystemFile(rec.id, student, { path: md!, content: `${cur.content}\nmore`, sha: cur.sha }, { warnings: async () => { ran = true; return []; } });
  assert.equal(ran, false);
  assert.equal((saved as { grantWarnings?: unknown }).grantWarnings, undefined);
});

test('SOURCE TRIPWIRE: the files PUT route delegates to saveSystemFile', () => {
  const src = readFileSync(join(process.cwd(), 'app/api/agents/systems/[id]/files/route.ts'), 'utf8');
  assert.match(src, /await saveSystemFile\(id, user,/);
});
