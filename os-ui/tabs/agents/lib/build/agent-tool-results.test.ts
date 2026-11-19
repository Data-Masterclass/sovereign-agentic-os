/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Agent-path tool results — `list_files` scoped to the folder grant and compact
 * USER STORY: As the owner of the invoice system I want the test to be my case: 60 files in my
 *             drive, a `/Invoices` grant, and the agent is shown the 12 invoices — while I, and any
 *             external MCP client, still get the full listing from the same tool.
 * ARCHITECTURE:
 *   - The REAL files store and the REAL MCP door (`handleRpc`), so the listing an agent is shown is
 *     shaped from what the governed tool actually returns. Only `enqueue` and `trace` are stubs.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import { handleRpc } from '@core/mcp/server';
import { estimateTokens } from '@core/infra/context/context-assembler';
import { parseSystem, type System } from '@tabs/agents/lib/system-schema';
import { grantedToolExecutor, type OsToolDeps } from '@tabs/agents/lib/build/os-tools';
import { shapeFileListing, shapeForAgent } from '@tabs/agents/lib/build/agent-tool-results';
import { __resetStore, createFile } from '@tabs/files/lib/store';

const USER: CurrentUser = { id: 'u-owner', name: 'Olive Owner', domains: ['finance'], role: 'admin' };
const PRINCIPAL = { id: USER.id, domains: USER.domains, role: USER.role };

const DEPS: OsToolDeps = {
  enqueue: (() => ({}) as never) as OsToolDeps['enqueue'],
  handleRpc,
  trace: (async () => ({}) as never) as OsToolDeps['trace'],
};

function system(files: unknown[]): System {
  return parseSystem({
    version: '1',
    system: { name: 'Invoice Processing', domain: 'finance', visibility: 'Personal' },
    runtime: 'langgraph',
    entrypoint: 'invoice-reader',
    grants: { tools: ['get_file'], files },
    agents: [{ id: 'invoice-reader', role: 'agent', agent_md: 'Read the invoices.', memory_md: '' }],
  });
}

const INVOICE_TEXT = (i: number) =>
  `INVOICE INV-2026-${1000 + i}\nSupplier: Muster GmbH ${i}\n` +
  Array.from({ length: 12 }, (_, k) => `Line ${k + 1}: Widget ${k} qty ${k + 2} unit 12.50 EUR total ${(k + 2) * 12.5} EUR`).join('\n') +
  '\nNet 975.00 EUR VAT 19% 185.25 EUR Gross 1160.25 EUR';

/** 60 files in the owner's drive: 12 invoices (one in a subfolder) and 48 others in four folders. */
function seedCorpus(): void {
  __resetStore();
  for (let i = 0; i < 60; i += 1) {
    const folder = i < 11 ? '/Invoices' : i === 11 ? '/Invoices/2026' : ['/Contracts', '/Reports/2026', '/HR', '/Marketing'][i % 4];
    createFile(PRINCIPAL, {
      name: `${i < 12 ? 'invoice' : 'doc'}-${String(i).padStart(2, '0')}.pdf`,
      text: INVOICE_TEXT(i),
      folder,
      tags: ['finance', `t${i % 5}`],
    });
  }
}

beforeEach(seedCorpus);

async function personListing(args: Record<string, unknown> = {}) {
  const res = await handleRpc(USER, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_files', arguments: args } });
  const text = ((res?.result ?? {}) as { content?: { text?: string }[] }).content?.[0]?.text ?? '';
  return { text, body: JSON.parse(text) as { mine: unknown[]; domain: unknown[]; marketplace: unknown[]; facets?: unknown; folder?: string } };
}

test('a person (or an external MCP client) still gets the FULL listing: every tier, every field, the facets', async () => {
  const { body } = await personListing();
  assert.equal(body.mine.length, 60);
  assert.ok(body.facets, 'facets are still there for the folder rail');
  assert.ok('deepLink' in (body.mine[0] as object), 'full metadata per file');
  assert.equal(body.folder, undefined, 'no folder narrowing was asked for');
});

test('an agent with a /Invoices folder grant gets the 12 invoices as compact rows — nothing else', async () => {
  const sys = system([{ folder: { path: '/Invoices', scope: 'personal' }, capability: 'Read' }]);
  const exec = grantedToolExecutor(USER, sys, 'sys_invoices', DEPS, { holdAt: 'node' });
  const out = await exec('list_files', {});
  assert.equal(out.isError, false);
  const body = JSON.parse(out.text) as { scope: string; count: number; items: Record<string, unknown>[]; facets?: unknown; mine?: unknown };
  assert.equal(body.count, 12);
  assert.equal(body.items.length, 12);
  assert.ok(body.items.every((f) => String(f.folder).startsWith('/Invoices')), 'only files under the granted folder (subfolders included)');
  assert.equal(body.items.filter((f) => f.folder === '/Invoices/2026').length, 1);
  // A freshly uploaded file has no description yet; one that has is shown it, shortened (below).
  assert.deepEqual(Object.keys(body.items[0]).sort(), ['bytes', 'folder', 'id', 'kind', 'name', 'status']);
  assert.equal(body.facets, undefined);
  assert.equal(body.mine, undefined);
  assert.match(body.scope, /Limited to the folder this system was granted: \/Invoices \(My files\)/);
  assert.ok(!out.text.includes('\n'), 'no pretty-printing');

  const person = await personListing();
  const before = estimateTokens(person.text);
  const after = estimateTokens(out.text);
  assert.ok(after < 1_200, `the agent's listing is ${after} estimated tokens`);
  assert.ok(after * 8 < before, `at least 8× smaller than the full listing (${before} → ${after})`);
});

test('the ids in the agent\'s listing are real: get_file reads one, without the version history', async () => {
  const sys = system([{ folder: { path: '/Invoices', scope: 'personal' }, capability: 'Read' }]);
  const exec = grantedToolExecutor(USER, sys, 'sys_invoices', DEPS, { holdAt: 'node' });
  const listing = JSON.parse((await exec('list_files', {})).text) as { items: { id: string }[] };
  const file = await exec('get_file', { fileId: listing.items[0].id });
  assert.equal(file.isError, false);
  const body = JSON.parse(file.text) as Record<string, unknown>;
  assert.match(String(body.text), /INVOICE INV-2026-/);
  assert.equal(body.history, undefined);
  assert.equal(body.object, undefined);
  assert.ok(estimateTokens(file.text) < 400, `one invoice is ${estimateTokens(file.text)} estimated tokens`);
});

test('`folder` narrows further for an agent, and never reaches outside the grant', async () => {
  const sys = system([{ folder: { path: '/Invoices', scope: 'personal' }, capability: 'Read' }]);
  const exec = grantedToolExecutor(USER, sys, 'sys_invoices', DEPS, { holdAt: 'node' });
  const sub = JSON.parse((await exec('list_files', { folder: '/Invoices/2026' })).text) as { count: number; folder: string };
  assert.equal(sub.count, 1);
  assert.equal(sub.folder, '/Invoices/2026');
  const outside = JSON.parse((await exec('list_files', { folder: '/HR' })).text) as { count: number };
  assert.equal(outside.count, 0, 'a folder outside the grant lists nothing for this system');
});

test('`folder` on the tool itself: a person lists one folder; without it nothing changes', async () => {
  const { body } = await personListing({ folder: 'Invoices' });
  assert.equal(body.mine.length, 12);
  assert.equal(body.folder, '/Invoices');
  assert.ok(body.facets, 'still the full shape');
});

test('a system with NO files folder grant sees what its runner sees, compact and labelled by tier', async () => {
  const exec = grantedToolExecutor(USER, system([]), 'sys_invoices', DEPS, { holdAt: 'node' });
  const body = JSON.parse((await exec('list_files', {})).text) as { scope: string; count: number; items: Record<string, unknown>[] };
  assert.equal(body.count, 60);
  assert.equal(body.items[0].tier, 'my');
  assert.match(body.scope, /no folder grant/);
});

test('a DOMAIN folder grant reads the Domain lane, never the runner\'s private files', () => {
  const listing = {
    mine: [{ id: 'f1', name: 'private.pdf', folder: '/Invoices', kind: 'document', bytes: 1, status: 'searchable' }],
    domain: [{ id: 'f2', name: 'shared.pdf', folder: '/Invoices', kind: 'document', bytes: 1, status: 'searchable' }],
    marketplace: [],
  };
  const out = shapeFileListing(listing, {}, { filesFolders: [{ path: '/Invoices', scope: 'domain' }] }) as { items: { id: string }[] };
  assert.deepEqual(out.items.map((f) => f.id), ['f2']);
});

test('a documented file carries a SHORT description; owner, deep link, version and tags are not shown to the agent', () => {
  const listing = {
    mine: [{ id: 'f1', name: 'a.pdf', owner: 'u1', domain: 'finance', tier: 'private', folder: '/Invoices', kind: 'document', bytes: 9, status: 'searchable', tags: ['x'], version: 'v1', deepLink: 's3://files/u1/a.pdf', description: 'Invoice from Muster GmbH. '.repeat(20) }],
    domain: [],
    marketplace: [],
    facets: { folders: [{ path: '/Invoices', count: 1 }], tags: [] },
  };
  const out = shapeFileListing(listing, {}, { filesFolders: [{ path: '/Invoices', scope: 'personal' }] }) as { items: Record<string, unknown>[] };
  assert.deepEqual(Object.keys(out.items[0]).sort(), ['bytes', 'description', 'folder', 'id', 'kind', 'name', 'status']);
  assert.ok(String(out.items[0].description).length <= 140);
});

test('shapeForAgent: other JSON results lose only their indentation; non-JSON text is untouched', () => {
  const pretty = JSON.stringify({ rows: [{ a: 1 }, { a: 2 }] }, null, 2);
  assert.equal(shapeForAgent('query_data', {}, pretty, { filesFolders: [] }), '{"rows":[{"a":1},{"a":2}]}');
  assert.equal(shapeForAgent('query_data', {}, 'plain words', { filesFolders: [] }), 'plain words');
});
