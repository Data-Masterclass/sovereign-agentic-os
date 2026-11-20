/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    MCP write tools refuse a value outside the literal-safety allow-lists with a typed error
 * USER STORY: As an agent author I want a column name or sync source that is not an identifier to
 *             come back as `invalid_identifier` naming the field, so the agent can fix exactly that.
 * ARCHITECTURE:
 *   - Real tool registry over the real store (offline OpenSearch stub), the sync-tools.test pattern.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';

globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const { handleRpc } = await import('@core/mcp/server');
type JsonRpcResponse = import('@core/mcp/server').JsonRpcResponse;
type ToolError = import('@core/mcp/server').ToolError;
const { __resetStore } = await import('@tabs/data/lib/store');
const { __setDataProjectGitForTests } = await import('@tabs/data/lib/dbt/commit');
__setDataProjectGitForTests(false);

const ben: CurrentUser = { id: 'ben', name: 'Ben', domains: ['sales'], role: 'builder' };

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await handleRpc(ben, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return (res as JsonRpcResponse).result as Record<string, unknown>;
}
const errorOf = (r: Record<string, unknown>): ToolError => {
  assert.equal(r.isError, true, `expected a typed tool error, got ${JSON.stringify(r).slice(0, 300)}`);
  return (r.structuredContent as { error: ToolError }).error;
};

test('document_dataset: a column name carrying a template is refused as invalid_identifier', async () => {
  __resetStore();
  const created = await call('create_dataset', { name: 'Members' });
  const id = JSON.parse((created.content as { text: string }[])[0].text).id as string;
  const err = errorOf(await call('document_dataset', { datasetId: id, columns: [{ name: "{}}{ log('x') }%}}", description: 'd' }] }));
  assert.equal(err.code, 'invalid_identifier');
  assert.match(err.hint, /columns\[0\]\.name/);
  // A description with braces is fine: it is free text, encoded on the way into dbt.
  const ok = await call('document_dataset', { datasetId: id, description: '{{ x }}', columns: [{ name: 'member_id', description: '{% do x %}' }] });
  assert.notEqual(ok.isError, true);
});
