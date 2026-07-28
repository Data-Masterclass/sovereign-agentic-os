/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@/lib/core/auth';
import { handleRpc, ALL_MCP_TOOLS, toolsForTab, type JsonRpcResponse, type ToolError } from './server.ts';
import { MANUAL_TOOLS } from './manual-tools.ts';
import { __resetStore } from '@/lib/knowledge/store';

/**
 * OPERATING MODEL MCP SURFACE — four THIN wrappers over the governed manual store
 * (get / update / list-versions / restore), driven over handleRpc exactly as an
 * AI client would. Asserts:
 *   1. All four tools are registered + exposing the right schema.
 *   2. A `my`-scope write as owner succeeds.
 *   3. A `company`-scope write as a non-admin is refused (forbidden) — the gate
 *      lives inside updateManual → resolveManual, not in the tool itself.
 *   4. The read tool returns sections.
 */

const owner: CurrentUser = { id: 'alice', name: 'Alice', domains: ['sales'], role: 'creator' };
const domainAdmin: CurrentUser = { id: 'dan', name: 'Dan', domains: ['sales'], role: 'domain_admin' };
const platformAdmin: CurrentUser = { id: 'pat', name: 'Pat', domains: ['sales'], role: 'admin' };

async function call(
  user: CurrentUser,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const res = await handleRpc(user, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  assert.ok(res && 'result' in res, `expected a result for ${name}`);
  return (res as JsonRpcResponse).result as Record<string, unknown>;
}

function payload<T = Record<string, unknown>>(r: Record<string, unknown>): T {
  assert.notEqual(r.isError, true, `expected success, got: ${(r.content as { text: string }[])[0]?.text}`);
  return JSON.parse((r.content as { text: string }[])[0].text) as T;
}

function errorOf(r: Record<string, unknown>): ToolError {
  assert.equal(r.isError, true, 'expected a typed tool error');
  return (r.structuredContent as { error: ToolError }).error;
}

const TOOL_NAMES = [
  'get_operating_manual',
  'update_operating_manual',
  'list_operating_manual_versions',
  'restore_operating_manual_version',
] as const;

// ------------------------------------------------------------------ registry --

test('OPERATING MODEL registry: four tools registered, on the operating-manual tab, exampled', () => {
  const byName = new Map(ALL_MCP_TOOLS.map((t) => [t.name, t]));
  const tabNames = new Set(toolsForTab('operating-manual').map((t) => t.name));

  for (const n of TOOL_NAMES) {
    const t = byName.get(n);
    assert.ok(t, `${n} is registered in ALL_MCP_TOOLS`);
    assert.equal(t!.tab, 'operating-manual', `${n} is on the operating-manual tab`);
    assert.equal(t!.minRole, 'creator', `${n} floors at creator`);
    assert.ok(tabNames.has(n), `${n} surfaces on the operating-manual tab view`);
    assert.ok((t!.inputSchema.examples ?? []).length >= 1, `${n} carries a worked example`);
  }
});

test('OPERATING MODEL registry: MANUAL_TOOLS exports exactly four tools', () => {
  assert.equal(MANUAL_TOOLS.length, 4, 'MANUAL_TOOLS has exactly four entries');
  const exportedNames = MANUAL_TOOLS.map((t) => t.name);
  for (const n of TOOL_NAMES) {
    assert.ok(exportedNames.includes(n), `${n} is in MANUAL_TOOLS`);
  }
});

test('OPERATING MODEL schema: update_operating_manual requires scope + sections', () => {
  const t = MANUAL_TOOLS.find((t) => t.name === 'update_operating_manual')!;
  assert.ok(t.inputSchema.required?.includes('scope'), 'scope is required');
  assert.ok(t.inputSchema.required?.includes('sections'), 'sections is required');
  // sections items must carry id + content
  const sectionsSchema = t.inputSchema.properties.sections as {
    items?: { properties?: { id?: unknown; content?: unknown } };
  };
  assert.ok(sectionsSchema?.items?.properties?.id, 'sections item has id');
  assert.ok(sectionsSchema?.items?.properties?.content, 'sections item has content');
});

// ------------------------------------------------------------------ read tool --

test('OPERATING MODEL get_operating_manual: my-scope read as owner returns sections', async () => {
  __resetStore();
  const result = payload<{ sections: { id: string; content: string }[] }>(
    await call(owner, 'get_operating_manual', { scope: 'my' }),
  );
  assert.ok(Array.isArray(result.sections), 'sections is an array');
  assert.ok(result.sections.length > 0, 'at least one section is returned');
  // Canonical 7-section ids
  const ids = result.sections.map((s) => s.id);
  for (const expected of ['general', 'strategy', 'glossary']) {
    assert.ok(ids.includes(expected), `section '${expected}' present`);
  }
});

test('OPERATING MODEL get_operating_manual: company-scope read succeeds for any role (everyone reads)', async () => {
  __resetStore();
  const result = payload<{ sections: { id: string }[] }>(
    await call(owner, 'get_operating_manual', { scope: 'company' }),
  );
  assert.ok(Array.isArray(result.sections), 'company read returns sections for a creator');
});

// ---------------------------------------------------------------- write tool --

test('OPERATING MODEL update_operating_manual: my-scope write as owner succeeds', async () => {
  __resetStore();
  const result = payload<{ sections: { id: string; content: string }[] }>(
    await call(owner, 'update_operating_manual', {
      scope: 'my',
      sections: [{ id: 'strategy', content: 'Ship the Q3 retention playbook.' }],
    }),
  );
  const strategy = result.sections.find((s) => s.id === 'strategy');
  assert.ok(strategy, 'strategy section returned');
  assert.equal(strategy!.content, 'Ship the Q3 retention playbook.');
});

test('OPERATING MODEL update_operating_manual: domain-scope write succeeds for domain_admin', async () => {
  __resetStore();
  const result = payload<{ sections: { id: string; content: string }[] }>(
    await call(domainAdmin, 'update_operating_manual', {
      scope: 'domain',
      domain: 'sales',
      sections: [{ id: 'general', content: 'The Sales domain owns pipeline → close.' }],
    }),
  );
  const general = result.sections.find((s) => s.id === 'general');
  assert.ok(general, 'general section returned');
  assert.equal(general!.content, 'The Sales domain owns pipeline → close.');
});

test('OPERATING MODEL update_operating_manual: company-scope write as non-admin is forbidden', async () => {
  __resetStore();
  // A creator is refused — the gate lives in updateManual → resolveManual.canEdit
  const err = errorOf(
    await call(owner, 'update_operating_manual', {
      scope: 'company',
      sections: [{ id: 'general', content: 'Intruder override.' }],
    }),
  );
  assert.equal(err.code, 'forbidden', 'company write is refused for a non-admin');
});

test('OPERATING MODEL update_operating_manual: domain-scope write as plain creator is forbidden', async () => {
  __resetStore();
  const err = errorOf(
    await call(owner, 'update_operating_manual', {
      scope: 'domain',
      domain: 'sales',
      sections: [{ id: 'general', content: 'Unauthorized.' }],
    }),
  );
  assert.equal(err.code, 'forbidden', 'domain write is refused for a creator (not domain_admin)');
});

test('OPERATING MODEL update_operating_manual: company-scope write as admin succeeds', async () => {
  __resetStore();
  const result = payload<{ sections: { id: string; content: string }[] }>(
    await call(platformAdmin, 'update_operating_manual', {
      scope: 'company',
      sections: [{ id: 'general', content: 'Tenant-wide operating norms.' }],
    }),
  );
  const general = result.sections.find((s) => s.id === 'general');
  assert.ok(general, 'general section returned');
  assert.equal(general!.content, 'Tenant-wide operating norms.');
});

test('OPERATING MODEL update_operating_manual: empty sections array is a bad_request', async () => {
  __resetStore();
  const err = errorOf(
    await call(owner, 'update_operating_manual', {
      scope: 'my',
      sections: [],
    }),
  );
  assert.equal(err.code, 'bad_request', 'empty sections is rejected with bad_request');
});

// --------------------------------------------------- read-back after write --

test('OPERATING MODEL: write then read returns updated content', async () => {
  __resetStore();
  await call(owner, 'update_operating_manual', {
    scope: 'my',
    sections: [{ id: 'data', content: 'All pipelines are documented.' }],
  });
  const readback = payload<{ sections: { id: string; content: string }[] }>(
    await call(owner, 'get_operating_manual', { scope: 'my' }),
  );
  const data = readback.sections.find((s) => s.id === 'data');
  assert.ok(data, 'data section returned');
  assert.equal(data!.content, 'All pipelines are documented.');
});
