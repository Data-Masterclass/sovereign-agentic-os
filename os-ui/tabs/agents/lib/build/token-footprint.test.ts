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
 *   - THE BENCHMARK GATE: `INVOICE_RUN_BUDGET` holds the run's two token thresholds (today's
 *     measured value + 10%). A change that re-inflates the prompt, the tools, the history or the
 *     results fails CI here, printing the breakdown by source. The table is printed on every run.
 *   - A second case shrinks the model window (the `MODEL_CONTEXT_WINDOWS` override) to prove the
 *     history is trimmed BEFORE the window — tool definitions included — and that it is told.
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
import { roleModel } from '@core/models/roles';
import { inputBudget } from '@core/models/context-windows';
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

function seedDrive(text: (i: number) => string = INVOICE_TEXT): void {
  __resetStore();
  for (let i = 0; i < 60; i += 1) {
    const folder = i < 12 ? '/Invoices' : ['/Contracts', '/Reports/2026', '/HR', '/Marketing'][i % 4];
    createFile(PRINCIPAL, { name: `${i < 12 ? 'invoice' : 'doc'}-${String(i).padStart(2, '0')}.pdf`, text: text(i), folder, tags: ['finance', `t${i % 5}`] });
  }
}

/** One request's estimated input, split the way the budget is read: who put the tokens there. */
type Call = { node: string; kind: 'plan' | 'act'; system: number; tools: number; history: number; results: number; total: number; trimmed: boolean };

const ROLE = /--- YOUR ROLE IN THE TEAM: (\S+) ---/;

function footprint(req: LlmRequest): Call {
  const system = req.messages.filter((m) => m.role === 'system').reduce((n, m) => n + estimateTokens(m.content), 0);
  const results = req.messages.filter((m) => m.role === 'tool').reduce((n, m) => n + estimateTokens(m.content ?? ''), 0);
  const history = req.messages
    .filter((m) => m.role !== 'system' && m.role !== 'tool')
    .reduce((n, m) => n + estimateTokens(m.content ?? '') + (m.tool_calls ? estimateTokens(JSON.stringify(m.tool_calls)) : 0), 0);
  const tools = req.tools ? estimateTokens(JSON.stringify(req.tools)) : 0;
  const node = ROLE.exec(req.messages[0]?.content ?? '')?.[1] ?? '?';
  const trimmed = /to fit the model's context window/.test(req.messages[0]?.content ?? '');
  return { node, kind: req.tools ? 'act' : 'plan', system, tools, history, results, total: system + tools + history + results, trimmed };
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
function scriptedModel(calls: Call[], sizes: { listing: number; file: number; ids: number }): LlmCall {
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
      sizes.ids = ids.length;
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

/**
 * THE TOKEN BUDGET GATE for the 12-invoice run — the ONE place its thresholds live.
 * Measured on 2026-11-19 (origin/main d30ab181): whole run 138,109 estimated input tokens, largest
 * single request 10,594. Each threshold is that value + 10%.
 * LOWERING a threshold is always good — do it whenever a change makes the run cheaper.
 * RAISING one needs a reason written in the pull request that raises it.
 */
export const INVOICE_RUN_BUDGET = {
  /** Every model request of the run, both agents, summed (estimated input tokens). */
  wholeRunMax: 151_920,
  /** The largest single model request of the run (estimated input tokens). */
  perRequestMax: 11_653,
} as const;

const pad = (n: number, w = 6) => String(n).padStart(w);
const row = (label: string, c: Call) =>
  `${label.padEnd(34)} system ${pad(c.system)}  tools ${pad(c.tools)}  history ${pad(c.history)}  results ${pad(c.results)}  = ${pad(c.total)}`;
const sum = (calls: Call[], k: 'system' | 'tools' | 'history' | 'results' | 'total') => calls.reduce((n, c) => n + c[k], 0);

async function runInvoices(calls: Call[], sizes: { listing: number; file: number; ids: number }) {
  return runOsTeam({
    runId: `footprint-${Date.now()}-${Math.random()}`,
    user: USER,
    yaml: invoiceYaml(),
    systemId: 'sys-invoices',
    messages: [{ role: 'user', content: 'Process the invoices in /Invoices: read all of them, verify, and recommend.' }],
    llm: scriptedModel(calls, sizes),
    toolDeps: TOOL_DEPS,
    approvalPort: memoryApprovalPort(),
  });
}

test('BENCHMARK GATE — the 12-invoice run: all 12 invoices seen, within its token budget', async () => {
  seedDrive();
  const calls: Call[] = [];
  const sizes = { listing: 0, file: 0, ids: 0 };
  const res = await runInvoices(calls, sizes);
  assert.deepEqual(res.path, ['invoice-reader', 'goods-verifier-recommender']);
  assert.equal(res.reachedEnd, true);
  const reader = res.runs[0];
  assert.equal(sizes.ids, 12, 'the reader can SEE all 12 invoice ids in its listing');
  assert.deepEqual(reader.result.steps.map((s) => s.tool), ['list_files', ...Array.from({ length: 12 }, () => 'get_file')], 'listed once, read each of the 12 invoices once');
  assert.ok(reader.result.steps.every((s) => !s.isError));

  const readerActs = calls.filter((c) => c.node === 'invoice-reader' && c.kind === 'act');
  const total = sum(calls, 'total');
  const largest = calls.reduce((m, c) => (c.total > m.total ? c : m), calls[0]);
  const table = [
    'ESTIMATED input tokens per request (characters ÷ 4; the model\'s own output is not counted)',
    row('reader PLAN', calls[0]),
    row('reader ACT #1 (before list_files)', readerActs[0]),
    row('reader ACT #2 (after list_files)', readerActs[1]),
    row('reader ACT #14 (all 12 read)', readerActs[13]),
    row(`largest request (${largest.node} ${largest.kind})`, largest),
    `WHOLE RUN by source: system ${sum(calls, 'system')}  tools ${sum(calls, 'tools')}  history ${sum(calls, 'history')}  results ${sum(calls, 'results')}`,
    `list_files result: ${sizes.listing}   one get_file result: ${sizes.file}   model requests: ${calls.length}`,
    `WHOLE RUN (both agents): ${total} (budget ${INVOICE_RUN_BUDGET.wholeRunMax})   largest request: ${largest.total} (budget ${INVOICE_RUN_BUDGET.perRequestMax})`,
  ].join('\n');
  console.log(`\n${table}\n`);

  assert.ok(total <= INVOICE_RUN_BUDGET.wholeRunMax, `the whole run is ${total} estimated tokens, over its budget of ${INVOICE_RUN_BUDGET.wholeRunMax}:\n${table}`);
  assert.ok(largest.total <= INVOICE_RUN_BUDGET.perRequestMax, `one request is ${largest.total} estimated tokens, over its budget of ${INVOICE_RUN_BUDGET.perRequestMax}:\n${table}`);
  assert.ok(sizes.listing < 1_200, `list_files result is ${sizes.listing} estimated tokens`);
  assert.ok(sizes.file < 400, `one get_file result is ${sizes.file} estimated tokens`);
});

test('history that outgrows the model window is trimmed BEFORE the window, the model is told, the run records it', async () => {
  // A small model window (the same admin override production reads), and invoices ~10× the size,
  // so twelve reads cannot all stay in one request.
  const prev = process.env.MODEL_CONTEXT_WINDOWS;
  const small = { contextWindow: 12_000, reservedOutput: 1_000 };
  process.env.MODEL_CONTEXT_WINDOWS = JSON.stringify({ [roleModel('tools')]: small, [roleModel('reasoning')]: small });
  try {
    seedDrive((i) => `${INVOICE_TEXT(i)}\n${'Terms and conditions apply to every delivery line. '.repeat(140)}`);
    const budget = Math.min(inputBudget(roleModel('tools')), inputBudget(roleModel('reasoning')));
    const calls: Call[] = [];
    const sizes = { listing: 0, file: 0, ids: 0 };
    const res = await runInvoices(calls, sizes);
    const over = calls.filter((c) => c.total > budget);
    assert.deepEqual(over.map((c) => `${c.node} ${c.kind} ${c.total}`), [], `every request (messages AND tool definitions) stays within the input budget of ${budget}`);
    assert.ok(calls.some((c) => c.trimmed), 'the model is told that earlier messages were removed');
    assert.ok((res.warnings ?? []).some((w) => /context window/.test(w) && /invoice-reader/.test(w)), `the run records the trim: ${JSON.stringify(res.warnings)}`);
  } finally {
    if (prev === undefined) delete process.env.MODEL_CONTEXT_WINDOWS;
    else process.env.MODEL_CONTEXT_WINDOWS = prev;
  }
});
