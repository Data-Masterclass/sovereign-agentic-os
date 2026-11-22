/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Monitoring → Files and Knowledge, end to end from the REAL stores and the REAL OpenSearch.
 * USER STORY: As a creator I want the Files and Knowledge panels to list exactly my own files and workflows with
 *             the row counts OpenSearch itself holds, and never another domain's file, workflow or rows.
 * ARCHITECTURE:
 *   - tests/monitoring/up.sh starts the OpenSearch the chart ships (19200). The indexes are created with the
 *     tabs' own mappings (`filesIndexMapping`, `knowledgeIndexMapping`); the files and workflows go in through
 *     the stores' own `createFile` / `createWorkflow`; the readers are `monitoringFilesSource` /
 *     `monitoringKnowledgeSource` — the ones registered at boot — feeding `filesView` / `knowledgeView`.
 *   - Negative twins: a foreign-domain user's file, workflow and OpenSearch rows never reach a creator (an admin
 *     sees them); and an absent index reads "unavailable", never "0 rows".
 *   - Lives beside instrumentation.ts because it needs three tabs (a tab never imports another tab, GLUE-9).
 *   - Run: MON_IT=1 node --experimental-test-module-mocks --import ./scripts/test-setup.mjs --test monitoring-files-knowledge.int.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const on = process.env.MON_IT === '1';
const OS = process.env.MON_OS_URL ?? 'http://127.0.0.1:19200';
const tag = randomUUID().slice(0, 8);
// Set before anything imports the config (it reads the environment once).
process.env.OPENSEARCH_URL = OS;
process.env.FILES_INDEX = `mon-files-${tag}`;
process.env.KNOWLEDGE_INDEX = `mon-know-${tag}`;

const { createFile } = await import('@tabs/files/lib/store');
const { createWorkflow } = await import('@tabs/knowledge/lib/store');
const { filesIndexMapping } = await import('@tabs/files/lib/index-store');
const { knowledgeIndexMapping } = await import('@tabs/knowledge/lib/index-pipeline');
const { monitoringFilesSource, monitoringKnowledgeSource } = await import('./monitoring-sources');
const { registerMonitoringSources } = await import('@tabs/monitoring/lib/panels/sources');
const { filesView } = await import('@tabs/monitoring/lib/panels/files-panel');
const { knowledgeView } = await import('@tabs/monitoring/lib/panels/knowledge-panel');

const principal = (id: string, domains: string[], role: 'creator' | 'admin' = 'creator') => ({ id, name: id, domains, allDomains: domains, activeDomain: null, role }) as never;
const ada = principal(`ada-${tag}`, ['sales']);
const bob = principal(`bob-${tag}`, ['hr']);
const root = principal(`root-${tag}`, ['sales', 'hr'], 'admin');
const sub = (u: { id: string; domains: string[]; role: string }) => ({ id: u.id, domains: u.domains, role: u.role as 'creator' });

async function put(index: string, mapping: unknown, docs: Record<string, unknown>[]): Promise<void> {
  assert.equal((await fetch(`${OS}/${index}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(mapping) })).status, 200);
  const body = docs.flatMap((d, i) => [JSON.stringify({ index: { _index: index, _id: `${index}-${i}` } }), JSON.stringify(d)]).join('\n') + '\n';
  const r = await fetch(`${OS}/_bulk?refresh=true`, { method: 'POST', headers: { 'content-type': 'application/x-ndjson' }, body });
  assert.equal(r.status, 200, await r.text());
}

test('Files and Knowledge from the real stores and OpenSearch: own rows only, the foreign twin never leaks, an absent index is unavailable', { skip: !on }, async () => {
  registerMonitoringSources({
    agentSystems: async () => [], datasets: async () => [], latestTests: async () => new Map(), assetKeys: async () => new Map(),
    files: monitoringFilesSource, knowledge: monitoringKnowledgeSource,
  });
  const mine = createFile(sub(ada as never) as never, { name: `plan-${tag}.md`, text: 'sales plan' });
  const foreign = createFile(sub(bob as never) as never, { name: `salaries-${tag}.md`, text: 'hr secret' });
  const wfMine = createWorkflow(sub(ada as never) as never, { title: `Refunds ${tag}` });
  const wfForeign = createWorkflow(sub(bob as never) as never, { title: `Payroll ${tag}` });

  // Before any index exists: the panels say so (and never "0 rows").
  const early = await filesView(ada);
  assert.equal(early.sources.openSearch.state, 'unavailable');
  assert.match((early.sources.openSearch as { reason: string }).reason, /does not exist/);
  assert.ok(early.files.every((f) => !('openSearchRows' in f)));
  const earlyK = await knowledgeView(ada);
  assert.equal(earlyK.sources.openSearch.state, 'unavailable');
  assert.equal(earlyK.summary, null);

  await put(process.env.FILES_INDEX!, filesIndexMapping(), [
    { file_id: mine.id, domain: 'sales', text: 'a' }, { file_id: mine.id, domain: 'sales', text: 'b' },
    { file_id: foreign.id, domain: 'hr', text: 'secret' },
  ]);
  await put(process.env.KNOWLEDGE_INDEX!, knowledgeIndexMapping(), [
    { workflow_id: wfMine.id, domain: 'sales', ingested_at: '2099-01-01T00:00:00Z', text: 'x' },
    { workflow_id: wfForeign.id, domain: 'hr', ingested_at: '2099-01-01T00:00:00Z', text: 'secret' },
  ]);

  // The creator: only their own file / workflow, with OpenSearch's own row counts.
  const f = await filesView(ada);
  assert.equal(f.sources.openSearch.state, 'live');
  assert.deepEqual(f.files.map((x) => x.id), [mine.id]);
  assert.equal(f.files[0].openSearchRows, 2);
  assert.ok(!JSON.stringify(f).includes(foreign.id) && !JSON.stringify(f).includes(`salaries-${tag}`), 'the foreign file never reaches a creator');
  const k = await knowledgeView(ada);
  assert.equal(k.sources.openSearch.state, 'live');
  assert.deepEqual(k.workflows.map((x) => x.id), [wfMine.id]);
  assert.equal(k.workflows[0].index!.rows, 1);
  assert.ok(!JSON.stringify(k).includes(wfForeign.id) && !JSON.stringify(k).includes('Payroll'), 'the foreign workflow never reaches a creator');
  assert.equal('searchLatency' in k, false, 'index-wide latency is admin-only');

  // Twin: the foreign user sees only theirs; the admin sees both, each with its own rows.
  const fb = await filesView(bob);
  assert.deepEqual(fb.files.map((x) => x.id), [foreign.id]);
  assert.equal(fb.files[0].openSearchRows, 1);
  const fa = await filesView(root);
  assert.deepEqual(Object.fromEntries(fa.files.filter((x) => [mine.id, foreign.id].includes(x.id)).map((x) => [x.id, x.openSearchRows])), { [mine.id]: 2, [foreign.id]: 1 });
  const ka = await knowledgeView(root);
  assert.ok([wfMine.id, wfForeign.id].every((id) => ka.workflows.some((w) => w.id === id)));
  assert.ok(ka.searchLatency || ka.searchLatencyUnavailable, 'an admin gets latency or the reason it is unavailable, never silence');
});
