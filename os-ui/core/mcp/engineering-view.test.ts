/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       mcp
 * FEATURE:    `get_engineering_view` — the MCP twin, and its parity with the UI panel
 * USER STORY: As an AI client I want the same structure the panel renders, with the same refusals,
 *             and as a reviewer I want proof that the UI route and the MCP tool reach ONE function
 *             rather than two code paths that can drift (checklist T8).
 * ARCHITECTURE:
 *   - The parity assertion is made twice over, deliberately: structurally (the route's source
 *     calls the same exported function the tool calls — read as TEXT, because a test may not
 *     import a `route.ts`) and behaviourally (the dispatcher's result for a real object equals
 *     `engineeringViewFor`'s own return for the same arguments).
 *   - Offline: the object is minted through the dispatcher, exactly as a client would mint it, and
 *     a tenant with no domain repository is the honest empty case every section must explain.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CurrentUser } from '@core/kernel/auth';
import { handleRpc, type JsonRpcResponse, type ToolError } from '@core/mcp/server';
import { engineeringTools, engineeringViewFor } from '@core/mcp/engineering-tools';
import { ENGINEERING_KINDS, type EngineeringView } from '@core/engineering/types';
import { vocabularyViolations } from '@core/engineering/vocabulary';

const admin = { id: 'sara', name: 'Sara', domains: ['ops'], role: 'admin' } as unknown as CurrentUser;

async function rpc(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = (await handleRpc(admin, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })) as JsonRpcResponse;
  assert.ok(!('error' in res && res.error), `${name}: JSON-RPC error ${JSON.stringify((res as { error?: unknown }).error)}`);
  return res.result as Record<string, unknown>;
}

const payload = (result: Record<string, unknown>) => JSON.parse((result.content as { text: string }[])[0].text) as Record<string, unknown>;

test('T8: the tool is advertised with the kind enum, both ids required, and a usable description', () => {
  assert.equal(engineeringTools.length, 1);
  const tool = engineeringTools[0];
  assert.equal(tool.name, 'get_engineering_view');
  assert.ok(tool.description.length > 40);
  assert.deepEqual(tool.inputSchema.required, ['kind', 'id']);
  const kind = (tool.inputSchema.properties as Record<string, { enum?: string[] }>).kind;
  assert.deepEqual(kind.enum, [...ENGINEERING_KINDS]);
});

test('T8: an unknown kind is a typed bad_request naming every kind that exists', async () => {
  const err = (payload(await rpc('get_engineering_view', { kind: 'spaceship', id: 'x' })) as { error: ToolError }).error;
  assert.equal(err.code, 'bad_request');
  for (const k of ENGINEERING_KINDS) assert.ok(err.reason.includes(k), `the refusal does not name '${k}'`);
});

test('T8: an object that does not exist is `not_found` — the owning tab\'s own refusal', async () => {
  const result = await rpc('get_engineering_view', { kind: 'dataset', id: 'ds_absent_engineering' });
  assert.equal(result.isError, true);
  const err = (result.structuredContent as { error: ToolError }).error;
  assert.equal(err.code, 'not_found');
  assert.ok(err.hint.length > 0);
});

test('T8: the MCP result is byte-identical to what the shared function returns (one code path)', async () => {
  const minted = payload(await rpc('create_dataset', { name: 'Engineering view parity' }));
  const id = String(minted.id ?? (minted.dataset as { id?: string } | undefined)?.id ?? '');
  assert.ok(id, `no id in the mint payload: ${JSON.stringify(minted).slice(0, 200)}`);

  const viaMcp = payload(await rpc('get_engineering_view', { kind: 'dataset', id })) as unknown as EngineeringView;
  const direct = (await engineeringViewFor(admin, 'dataset', id)) as EngineeringView;
  assert.deepEqual(viaMcp, JSON.parse(JSON.stringify(direct)));

  // And the structure is the panel's: five tools' sections, the vocabulary rule, a reason per gap.
  assert.deepEqual(vocabularyViolations(viaMcp), []);
  assert.deepEqual(viaMcp.sections.map((s) => s.tool), ['dbt', 'dagster', 'git', 'langfuse']);
  for (const s of viaMcp.sections) {
    if (s.artefacts.length === 0) assert.ok((s.unavailable ?? '').length > 20, `${s.tool}: an empty section must explain itself`);
  }
});

test('T8: the UI route calls the SAME exported function — there is no second code path to drift', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const route = readFileSync(join(here, '..', '..', 'app', 'api', 'engineering', '[kind]', '[id]', 'route.ts'), 'utf8');
  assert.match(route, /engineeringViewFor/, 'the panel route must call the MCP tool\'s own function');
  assert.doesNotMatch(route, /engineeringAdapter\(/, 'the route must not reach into the registry itself');
});
