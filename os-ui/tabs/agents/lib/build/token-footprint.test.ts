/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Token footprint of a trivial run — the 12-invoice task, measured request by request
 * USER STORY: As the owner of the invoice system I was told "it's 12 invoices that are already
 *             text; it should be a walk in the park". This test IS that run: two agents, the same
 *             fifteen tools, a `/Invoices` folder grant in a 60-file drive, twelve ~900-character
 *             invoices — driven through the REAL engine, prompt assembly, tool door and files store
 *             with a scripted model, counting what every request would put on the wire.
 * ARCHITECTURE:
 *   - `runOsTeam` with an injected `LlmCall`: every request the engine would send to the gateway
 *     passes through it, so its `messages` and `tools` are exactly the payload. Tokens are the
 *     repo's own ESTIMATE (`estimateTokens`, characters ÷ 4) — not a tokenizer, and not a bill:
 *     real counts run somewhat higher on JSON, and the model's own output is not included.
 *   - The scripted model does what a competent one does: list the folder, read each file once,
 *     answer. No retries and no wandering, so the total is the FLOOR for this task.
 *   - The assertions are ceilings well above today's numbers, so a regression that re-inflates the
 *     prompt, the tools or the listing fails here. The table is printed on every run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import { handleRpc } from '@core/mcp/server';
import type { LlmCall, LlmRequest } from '@core/runtime/agentic';
import { estimateTokens } from '@core/infra/context/context-assembler';
import { parseSystem, serializeSystem } from '@tabs/agents/lib/system-schema';
import { runOsTeam } from '@tabs/agents/lib/build/agentic-graph-server';
import type { OsToolDeps } from '@tabs/agents/lib/build/os-tools';
import { memoryApprovalPort } from '@tabs/agents/lib/engine/approval-port';
import { __resetStore, createFile } from '@tabs/files/lib/store';

const USER: CurrentUser = { id: 'u-owner', name: 'Olive Owner', domains: ['finance'], role: 'admin' };
const PRINCIPAL = { id: USER.id, domains: USER.domains, role: USER.role };

/** The grants of the system this test is modelled on (its discovery companions are added by the OS). */
const TOOLS = ['get_file', 'query_data', 'search_knowledge', 'create_dataset', 'add_dataset_version', 'document_dataset', 'ingest_dataset', 'transform_silver', 'build_gold_join', 'list_datasets', 'get_dataset'];

function invoiceYaml(): string {
  return serializeSystem(parseSystem({
    version: '1',
    system: { name: 'Invoice Processing Workflow agent', domain: 'finance', visibility: 'Personal' },
    runtime: 'langgraph',
    entrypoint: 'invoice-reader',
    grants: { tools: TOOLS, files: [{ folder: { path: '/Invoices', scope: 'personal' }, capability: 'Read' }] },
    agents: [
      { id: 'invoice-reader', role: 'agent', agent_md: 'Read every invoice in the granted /Invoices folder and extract supplier, invoice number, date, line items and totals.', memory_md: '' },
      { id: 'goods-verifier-recommender', role: 'agent', agent_md: 'Verify the goods received against each invoice the reader extracted and recommend approve or hold per invoice.', memory_md: '' },
    ],
    edges: [{ from: 'invoice-reader', to: 'goods-verifier-recommender', type: 'handoff' }],
  }));
}

/** ~900 characters of already-extracted invoice text. */
const INVOICE_TEXT = (i: number) =>
  `INVOICE INV-2026-${1000 + i}\nSupplier: Muster GmbH ${i}, Hauptstrasse ${i}, 80331 Muenchen\nInvoice date: 2026-10-${10 + i}\nPO: PO-77${i}\n` +
  Array.from({ length: 11 }, (_, k) => `Line ${k + 1}: Widget type ${k} qty ${k + 2} unit 12.50 EUR total ${(k + 2) * 12.5} EUR`).join('\n') +
  '\nNet 975.00 EUR VAT 19% 185.25 EUR Gross 1160.25 EUR. Payment 30 days net.';

function seedDrive(): void {
  __resetStore();
  for (let i = 0; i < 60; i += 1) {
    const folder = i < 12 ? '/Invoices' : ['/Contracts', '/Reports/2026', '/HR', '/Marketing'][i % 4];
    createFile(PRINCIPAL, { name: `${i < 12 ? 'invoice' : 'doc'}-${String(i).padStart(2, '0')}.pdf`, text: INVOICE_TEXT(i), folder, tags: ['finance', `t${i % 5}`] });
  }
}

type Call = { node: string; kind: 'plan' | 'act'; system: number; history: number; tools: number; total: number };

const ROLE = /--- YOUR ROLE IN THE TEAM: (\S+) ---/;

function footprint(req: LlmRequest): Call {
  const system = req.messages.filter((m) => m.role === 'system').reduce((n, m) => n + estimateTokens(m.content), 0);
  const history = req.messages
    .filter((m) => m.role !== 'system')
    .reduce((n, m) => n + estimateTokens(m.content ?? '') + (m.tool_calls ? estimateTokens(JSON.stringify(m.tool_calls)) : 0), 0);
  const tools = req.tools ? estimateTokens(JSON.stringify(req.tools)) : 0;
  const node = ROLE.exec(req.messages[0]?.content ?? '')?.[1] ?? '?';
  return { node, kind: req.tools ? 'act' : 'plan', system, history, tools, total: system + history + tools };
}

/**
 * The invoice ids a model can SEE in a `list_files` result. Read from the text, not parsed: before
 * the diet the listing was cut by characters mid-JSON, and what the cut removed the model never saw.
 */
function invoiceIds(listing: string): string[] {
  const ids: string[] = [];
  for (const chunk of listing.split(/"id":\s*"/).slice(1)) {
    const id = chunk.slice(0, chunk.indexOf('"'));
    const folder = /"folder":\s*"([^"]*)"/.exec(chunk)?.[1] ?? '';
    if (id && folder.startsWith('/Invoices')) ids.push(id);
  }
  return ids;
}

/** A competent model: list once, read each invoice once, answer. Records every request. */
function scriptedModel(calls: Call[], sizes: { listing: number; file: number }): LlmCall {
  const acts = new Map<string, number>();
  let ids: string[] = [];
  return async (req) => {
    const fp = footprint(req);
    calls.push(fp);
    if (!req.tools) return { content: '1. List the invoices. 2. Read each one. 3. Summarise.', toolCalls: [] };
    const n = (acts.get(fp.node) ?? 0) + 1;
    acts.set(fp.node, n);
    if (fp.node !== 'invoice-reader') return { content: 'All 12 invoices verified against the goods received: approve 12, hold 0.', toolCalls: [] };
    if (n === 1) return { content: '', toolCalls: [{ id: 'c-list', name: 'list_files', args: {} }] };
    const lastTool = [...req.messages].reverse().find((m) => m.role === 'tool');
    if (n === 2) {
      ids = invoiceIds(lastTool?.content ?? '{}');
      sizes.listing = estimateTokens(lastTool?.content ?? '');
    } else if (n === 3) {
      sizes.file = estimateTokens(lastTool?.content ?? '');
    }
    const id = ids[n - 2];
    if (id) return { content: '', toolCalls: [{ id: `c-get-${n}`, name: 'get_file', args: { fileId: id } }] };
    return { content: 'Extracted 12 invoices: INV-2026-1000 … INV-2026-1011, each Net 975.00 EUR, Gross 1160.25 EUR.', toolCalls: [] };
  };
}

const TOOL_DEPS: OsToolDeps = {
  enqueue: (() => ({}) as never) as OsToolDeps['enqueue'],
  handleRpc,
  trace: (async () => ({}) as never) as OsToolDeps['trace'],
};

test('the 12-invoice task: what each model request costs, and what the whole run costs', async () => {
  seedDrive();
  const calls: Call[] = [];
  const sizes = { listing: 0, file: 0 };
  const res = await runOsTeam({
    runId: `footprint-${Date.now()}`,
    user: USER,
    yaml: invoiceYaml(),
    systemId: 'sys-invoices',
    messages: [{ role: 'user', content: 'Process the invoices in /Invoices: read all of them, verify, and recommend.' }],
    llm: scriptedModel(calls, sizes),
    toolDeps: TOOL_DEPS,
    approvalPort: memoryApprovalPort(),
  });
  assert.deepEqual(res.path, ['invoice-reader', 'goods-verifier-recommender']);
  assert.equal(res.reachedEnd, true);
  const reader = res.runs[0];
  assert.deepEqual(reader.result.steps.map((s) => s.tool), ['list_files', ...Array.from({ length: 12 }, () => 'get_file')], 'listed once, read each of the 12 invoices once');
  assert.ok(reader.result.steps.every((s) => !s.isError));

  const readerActs = calls.filter((c) => c.node === 'invoice-reader' && c.kind === 'act');
  const total = calls.reduce((n, c) => n + c.total, 0);
  const first10 = calls.slice(0, 11).reduce((n, c) => n + c.total, 0); // plan + the 10 ACT requests the incident made
  const row = (label: string, c: Call) => `${label.padEnd(34)} system ${String(c.system).padStart(6)}  tools ${String(c.tools).padStart(6)}  history ${String(c.history).padStart(6)}  = ${String(c.total).padStart(6)}`;
  const table = [
    'ESTIMATED input tokens per request (characters ÷ 4; the model\'s own output is not counted)',
    row('reader PLAN', calls[0]),
    row('reader ACT #1 (before list_files)', readerActs[0]),
    row('reader ACT #2 (after list_files)', readerActs[1]),
    row('reader ACT #10 (8 files read)', readerActs[9]),
    row('reader ACT #14 (all 12 read)', readerActs[13]),
    `list_files result: ${sizes.listing}   one get_file result: ${sizes.file}`,
    `model requests: ${calls.length}   reader ACT average: ${Math.round(readerActs.reduce((n, c) => n + c.total, 0) / readerActs.length)}`,
    `first 11 requests (what the incident sent before its 429): ${first10}`,
    `WHOLE RUN (both agents): ${total}`,
  ].join('\n');
  console.log(`\n${table}\n`);

  // Ceilings (today's numbers are in the table above). Before the diet the same script on `main`
  // measured ~200,000 for a run that could only SEE 9 of the 12 invoices: the listing was cut by
  // characters and the last three were in the part that was cut.
  assert.ok(sizes.listing < 1_200, `list_files result is ${sizes.listing} estimated tokens`);
  assert.ok(sizes.file < 400, `one get_file result is ${sizes.file} estimated tokens`);
  assert.ok(readerActs[0].system < 2_000, `ACT system prompt is ${readerActs[0].system} estimated tokens`);
  assert.ok(readerActs.every((c) => c.total < 12_000), 'no single request above 12,000 estimated tokens');
  assert.ok(total < 150_000, `the whole run is ${total} estimated tokens`);
});
