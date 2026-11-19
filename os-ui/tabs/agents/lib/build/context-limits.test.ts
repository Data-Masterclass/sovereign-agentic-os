/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Context limits are never silent — the pure half (bounds, warnings, grant caps, trimming)
 * USER STORY: As the owner of an agent system I want every place the engine shortens what my agent
 *             sees — a long tool result, a folder grant over its budget, a history trimmed to fit
 *             the model — to leave a marker the MODEL reads and a warning on the RUN I read, so a
 *             cut never turns into a confident "there are only 9 invoices".
 * ARCHITECTURE:
 *   - Pure units of the one truncation helper (`engine/tool-result.ts`), the folder-grant resolver
 *     (`os-tools.ts`) and the history budget (`core/runtime/agentic.ts`). The engine-path and
 *     files-store cases live in `agent-tool-results.test.ts` and `token-footprint.test.ts`.
 *   - Accessed through namespaces so each case fails on its own (not the whole file at import)
 *     when the behaviour is missing — that is how the "failed before the fix" list was taken.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as toolResult from '@tabs/agents/lib/engine/tool-result';
import * as osTools from '@tabs/agents/lib/build/os-tools';
import * as agentic from '@core/runtime/agentic';
import { parseSystem } from '@tabs/agents/lib/system-schema';
import type { LlmMessage } from '@core/runtime/agentic';

/** A person-shaped, scope-grouped listing (`list_datasets`, `list_files`, … all answer like this). */
function grouped(mine: number, domain: number, marketplace: number) {
  const row = (tier: string, i: number) => ({ id: `${tier}-${i}`, name: `${tier} item ${i}`, folder: '/Sales', description: 'd'.repeat(120) });
  return {
    mine: Array.from({ length: mine }, (_, i) => row('mine', i)),
    domain: Array.from({ length: domain }, (_, i) => row('domain', i)),
    marketplace: Array.from({ length: marketplace }, (_, i) => row('market', i)),
    facets: { folders: [{ path: '/Sales', count: mine + domain + marketplace }] },
  };
}

test('a GROUPED result over the bound is cut by rows, per group, with every count in the marker', () => {
  const text = JSON.stringify(grouped(250, 17, 45));
  const out = toolResult.boundToolResult(text, 20_000);
  assert.equal(out.truncated, true);
  assert.ok(out.text.length <= 20_000);
  const [json, marker] = out.text.split('\n[truncated: ');
  const body = JSON.parse(json) as ReturnType<typeof grouped>;
  const kept = body.mine.length + body.domain.length + body.marketplace.length;
  assert.ok(kept > 0 && kept < 312);
  assert.ok(body.facets, 'the rest of the object is kept');
  assert.match(marker ?? '', new RegExp(`^showing ${kept} of 312 rows`));
  assert.match(marker, new RegExp(`mine ${body.mine.length} of 250`));
  assert.match(marker, new RegExp(`domain ${body.domain.length} of 17`));
  assert.match(marker, new RegExp(`marketplace ${body.marketplace.length} of 45`));
});

test('every cut a run made becomes ONE run warning per tool, with the counts', () => {
  const fn = (toolResult as Record<string, unknown>).truncationWarnings as ((runs: unknown[]) => string[]) | undefined;
  assert.equal(typeof fn, 'function', 'truncationWarnings exists');
  const cut = toolResult.boundToolResult(JSON.stringify({ items: Array.from({ length: 500 }, (_, i) => ({ id: `f${i}`, name: 'n'.repeat(80) })) }), 5_000).text;
  const warnings = fn!([{ node: 'reader', result: { steps: [{ tool: 'list_files', result: cut, isError: false }, { tool: 'get_file', result: '{"text":"ok"}', isError: false }] } }]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /reader: list_files .*showing \d+ of 500 rows/);
});

test('a DATA folder grant over its budget: the run is warned with "first N of M"', async () => {
  const sys = parseSystem({
    version: '1',
    system: { name: 'Sales', domain: 'finance', visibility: 'Personal' },
    runtime: 'langgraph',
    entrypoint: 'a',
    grants: { tools: ['query_data'], data: [{ folder: { path: '/Sales', scope: 'personal' }, capability: 'Read' }] },
    agents: [{ id: 'a', role: 'agent', agent_md: 'x', memory_md: '' }],
  });
  const load = async () => Array.from({ length: 80 }, (_, i) => ({ id: `ds-${i}`, folder: '/Sales' }));
  const user = { id: 'u1', name: 'U', domains: ['finance'], role: 'admin' as const };
  const res = await osTools.resolveFolderGrantsWithWarnings(user, sys, 'sys-1', { trace: async () => ({}) as never, load });
  assert.equal(res.system.grants.data.filter((g) => g.id).length, 50, 'the budget still applies');
  assert.ok(res.warnings.some((w) => /first 50 of 80 datasets/.test(w)), `warned: ${JSON.stringify(res.warnings)}`);
});

test('history trimming leaves a marker the model reads and a report the engine can record', () => {
  const fn = (agentic as Record<string, unknown>).budgetMessagesReport as ((m: LlmMessage[], b: number) => { messages: LlmMessage[]; trim: { dropped: number } | null }) | undefined;
  assert.equal(typeof fn, 'function', 'budgetMessagesReport exists');
  const msgs: LlmMessage[] = [{ role: 'system', content: 'You read invoices.' }, { role: 'user', content: 'Read them all.' }];
  for (let i = 0; i < 30; i += 1) {
    msgs.push({ role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'get_file', arguments: `{"fileId":"f${i}"}` } }] });
    msgs.push({ role: 'tool', tool_call_id: `c${i}`, content: `invoice ${i} `.repeat(150) });
  }
  const { messages, trim } = fn!(msgs, 2_000);
  assert.ok(trim && trim.dropped > 0, 'the report counts the dropped messages');
  assert.match(messages[0].content, /earlier messages? (was|were) removed to fit the model's context window/);
  const total = messages.reduce((n, m) => n + Math.ceil((m.content ?? '').length / 4) + 4 + (m.tool_calls ? 40 : 0), 0);
  assert.ok(total <= 2_200, `the trimmed request stays near the budget (${total})`);
  assert.equal(fn!(msgs.slice(0, 2), 2_000).trim, null, 'nothing trimmed → no report');
});

test('"which folders exist" past its 40-name cap says how many more exist', async () => {
  const { shapeFileListing } = await import('@tabs/agents/lib/build/agent-tool-results');
  const mine = Array.from({ length: 50 }, (_, i) => ({ id: `f${i}`, name: `f${i}.pdf`, folder: `/F${String(i).padStart(2, '0')}` }));
  const out = shapeFileListing({ mine, domain: [], marketplace: [] }, { folder: '/Nope' }, { filesFolders: [] }) as { availableFolders: string[]; moreFolders?: number; note: string };
  assert.equal(out.availableFolders.length, 40);
  assert.equal(out.moreFolders, 10);
  assert.match(out.note, /10 more exist/);
});

test('a conversation longer than the turn window tells the model how many turns were omitted', async () => {
  const { cleanTurns } = await import('@core/runtime/turns');
  const turns = Array.from({ length: 25 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i}` }));
  const kept = cleanTurns(turns);
  assert.equal(kept.length, 20);
  assert.match(kept[0].content, /^\[5 earlier turns of this conversation were omitted/);
  assert.match(kept[0].content, /turn 5$/);
  assert.equal(cleanTurns(turns.slice(0, 3))[0].content, 'turn 0', 'nothing omitted, nothing added');
});
