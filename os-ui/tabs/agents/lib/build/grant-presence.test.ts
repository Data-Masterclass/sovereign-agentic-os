/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    A run says when something its agents were granted is gone
 * USER STORY: As the owner of an agent system granted two datasets, one of which a colleague has
 *             since deleted, I want the run report to name the deleted one and only that one.
 * ARCHITECTURE:
 *   - The REAL governed door end to end: datasets are created and deleted with the MCP tools a
 *     user would call (`create_dataset`, `retire_dataset`), and `missingGrantWarnings` asks the
 *     same door with `get_*`. No store is mocked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const { handleRpc } = await import('@core/mcp/server');
const { parseSystem } = await import('@tabs/agents/lib/system-schema');
const { missingGrantWarnings } = await import('./grant-presence.ts');

const amir = { id: 'amir', name: 'Amir', domains: ['sales'], allDomains: ['sales'], activeDomain: null, role: 'builder' as const };

async function tool(name: string, args: Record<string, unknown>) {
  const res = (await handleRpc(amir, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })) as { result: { isError?: boolean; content: { text: string }[] } };
  assert.notEqual(res.result.isError, true, `${name}: ${res.result.content?.[0]?.text}`);
  return JSON.parse(res.result.content[0].text) as Record<string, unknown>;
}

function systemGranted(dataIds: string[], extra = ''): ReturnType<typeof parseSystem> {
  return parseSystem(
    [
      'system: { name: uses_data, domain: sales, visibility: Personal }',
      'entrypoint: a',
      `grants: { data: [${dataIds.map((id) => `{ id: ${id}, capability: Read }`).join(', ')}], knowledge: [], tools: [], connections: []${extra} }`,
      'agents: [{ id: a, role: reads the data }]',
    ].join('\n'),
  );
}

const idOf = (r: Record<string, unknown>) => String((r.dataset as { id?: string } | undefined)?.id ?? r.id ?? r.datasetId);

test('a granted dataset that was deleted is named in the run warnings; the one that exists is not', async () => {
  const kept = idOf(await tool('create_dataset', { name: 'Orders kept' }));
  const doomed = idOf(await tool('create_dataset', { name: 'Orders doomed' }));
  await tool('retire_dataset', { datasetId: doomed, action: 'delete' });

  const warnings = await missingGrantWarnings(amir, systemGranted([kept, doomed]));
  assert.equal(warnings.length, 1, warnings.join('\n'));
  assert.match(warnings[0], new RegExp(`granted the dataset ${doomed}, which was deleted or which you can no longer see`));
  assert.doesNotMatch(warnings[0], new RegExp(kept));
});

test('a folder grant is not probed (it has its own zero-match warning)', async () => {
  const sys = parseSystem(
    [
      'system: { name: uses_folder, domain: sales, visibility: Personal }',
      'entrypoint: a',
      'grants: { data: [{ folder: { path: /, scope: personal }, capability: Read }], knowledge: [], tools: [], connections: [] }',
      'agents: [{ id: a, role: reads }]',
    ].join('\n'),
  );
  let calls = 0;
  const warnings = await missingGrantWarnings(amir, sys, { handleRpc: (async () => { calls++; return null; }) as never });
  assert.deepEqual(warnings, []);
  assert.equal(calls, 0);
});

test('an outage or refusal is not reported as "deleted"', async () => {
  const sys = systemGranted(['ds_whatever1']);
  const refused = async () => ({ jsonrpc: '2.0', id: 1, result: { isError: true, structuredContent: { error: { code: 'unavailable' } }, content: [] } });
  assert.deepEqual(await missingGrantWarnings(amir, sys, { handleRpc: refused as never }), []);
});

test('prepareRun (what every Run, schedule and MCP run goes through) carries the warning to the run report', async () => {
  const { prepareRun } = await import('./run-service.ts');
  const { serializeSystem } = await import('@tabs/agents/lib/system-schema');
  const doomed = idOf(await tool('create_dataset', { name: 'Orders gone soon' }));
  await tool('retire_dataset', { datasetId: doomed, action: 'delete' });
  const yaml = serializeSystem(systemGranted([doomed]));
  const { warnings } = await prepareRun(amir, { yaml, owner: 'amir' } as never, 'sys_probe');
  assert.ok(warnings.some((w) => w.includes(`the dataset ${doomed}, which was deleted`)), warnings.join('\n'));
});
