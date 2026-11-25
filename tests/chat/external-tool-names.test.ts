/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    External tool names round-trip exactly from the remote server, through the model, back to the server
 * USER STORY: As a user I want the chat to call my Notion's `notion-fetch`, not a non-existent `notion` — every
 *             remote tool name must reach the model whole and come back whole, and an unknown name must tell the
 *             model the right names at once instead of burning the turn on retries.
 * ARCHITECTURE: the REAL `runOsAssistant` (compact loader, confirm gate, external wrapper) and the REAL reply parser
 *   (`parseLlmMessage`, the one the live gateway caller and the streamed path use). The model is a script that
 *   answers with an OpenAI-shaped `tool_calls` message naming exactly the tool it was offered; the source records
 *   which remote tool it was asked for. OPA's answer is a stand-in. Every real Notion MCP tool name is covered.
 */
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import type { LlmCall } from '@core/runtime/agentic';
import { __resetConfirmations } from '@core/policy/confirmations';

const realOpa = await import('@core/adapters/opa/client');
mock.module('@core/adapters/opa/client', {
  namedExports: {
    ...realOpa,
    opaDecide: async (path: string, input: Record<string, unknown>, ...rest: unknown[]) => {
      if (path !== 'os/external_mcp/decision') return (realOpa.opaDecide as (...a: unknown[]) => unknown)(path, input, ...rest);
      const i = input as { read_only: boolean; confirmed: boolean };
      return { ok: true, value: { defined: true, value: { effect: i.read_only || i.confirmed ? 'allow' : 'requires_approval', reason: 'test' } } };
    },
  },
});
const ext = await import('@core/runtime/external-mcp');
const { runOsAssistant } = await import('@core/runtime/agent-loop');
const { parseLlmMessage, cleanToolName, parseHarmonyToolCall } = await import('@core/runtime/runtime');

const nora: CurrentUser = { id: 'nora', name: 'Nora', domains: ['sales'], allDomains: ['sales'], activeDomain: null, role: 'creator' };

/** The tool names Notion's hosted MCP server advertises (developers.notion.com/guides/mcp/tools-faqs). */
const NOTION_TOOLS = [
  'notion-search', 'notion-fetch', 'notion-create-pages', 'notion-update-page', 'notion-move-pages', 'notion-duplicate-page',
  'notion-create-database', 'notion-update-data-source', 'notion-query-data-sources', 'notion-create-comment', 'notion-get-comments',
  'notion-get-users', 'notion-get-self', 'notion-get-teams', 'notion-query-meeting-notes', 'notion-get-file-download-urls',
  'notion-create-view', 'notion-update-view', 'notion-get-tool-access',
];
const READS = new Set(['notion-search', 'notion-fetch', 'notion-query-data-sources', 'notion-get-comments', 'notion-get-users', 'notion-get-self', 'notion-get-teams', 'notion-query-meeting-notes', 'notion-get-file-download-urls', 'notion-get-tool-access']);
const CONN = 'conn_iyqhudhk4yt';

const sourceCalls: string[] = [];
const source: import('@core/runtime/external-mcp').ExternalMcpSource = {
  listConnections: async () => [{ id: CONN, provider: 'notion', name: 'My Notion', owner: 'nora', domain: 'sales', visibility: 'Personal', auth: 'oauth', archived: false }],
  listTools: async () => NOTION_TOOLS.map((name) => ({ name, description: `Notion ${name}`, readOnly: READS.has(name), inputSchema: { type: 'object', properties: {} } as never })),
  call: async (_u, _c, tool) => { sourceCalls.push(tool); return { text: '{"ok":true}', isError: false }; },
};

beforeEach(() => { __resetConfirmations(); sourceCalls.length = 0; ext.registerExternalMcpSource(source); });

/** A model that answers with a raw OpenAI `tool_calls` message, parsed by the REAL reply parser. */
function rawModel(offered: string[][], acts: string[][]): LlmCall {
  let a = 0;
  return async (req) => {
    if (!req.tools) return { content: '1. do it', toolCalls: [] };
    offered.push(req.tools.map((t) => t.function.name));
    const names = acts[a++] ?? [];
    return parseLlmMessage(
      names.length
        ? { content: '', tool_calls: names.map((n, i) => ({ id: `t${a}-${i}`, type: 'function', function: { name: n, arguments: '{}' } })) }
        : { content: 'done' },
      names.length ? 'tool_calls' : 'stop',
    );
  };
}
const dispatch = async () => ({ jsonrpc: '2.0' as const, id: 1, result: { content: [{ type: 'text', text: '{"ok":true}' }] } });
const turn = (llm: LlmCall) =>
  runOsAssistant({ user: nora, tab: null, messages: [{ role: 'user', content: 'use my notion' }], llm, dispatch } as Parameters<typeof runOsAssistant>[0]);

test('the parser keeps a hyphenated tool name whole (the bug: it cut at "-", so every notion-* tool became "notion")', () => {
  const wire = ext.wireName('notion', CONN, 'notion-fetch');
  const c = parseLlmMessage({ content: '', tool_calls: [{ id: 'x', type: 'function', function: { name: wire, arguments: '{"id":"p1"}' } }] });
  assert.equal(c.toolCalls[0].name, wire);
  assert.deepEqual(c.toolCalls[0].args, { id: 'p1' });
  // harmony leaks are still cleaned, without cutting the name
  assert.equal(cleanToolName(`${wire}<|channel|>commentary`), wire);
  assert.equal(cleanToolName(`functions.${wire}`), wire);
  assert.equal(parseHarmonyToolCall(`<|channel|>commentary to=functions.${wire}<|message|>{"id":"p1"}<|call|>`)?.name, wire);
  assert.equal(cleanToolName('query_data<|channel|>commentary'), 'query_data');
});

test('EVERY Notion tool reaches the model under its exact name and, called back, reaches Notion as that same tool', async () => {
  const offered: string[][] = [];
  const reads = NOTION_TOOLS.filter((n) => READS.has(n));
  await turn(rawModel(offered, [reads.map((n) => ext.wireName('notion', CONN, n)), []]));
  for (const n of NOTION_TOOLS) {
    const wire = ext.wireName('notion', CONN, n);
    assert.ok(offered[0].includes(wire), `${wire} is offered to the model`);
    assert.deepEqual(ext.parseWire(wire), { provider: 'notion', connectionId: CONN, tool: n }, 'the name parses back exactly');
  }
  assert.deepEqual(sourceCalls.sort(), [...reads].sort(), 'each read reached Notion as the exact remote tool');
  assert.equal(new Set(offered[0]).size, offered[0].length, 'no two offered tools collide');
});

test('a Notion write is offered under its exact name and parks behind the confirm card (callable once confirmed)', async () => {
  const wire = ext.wireName('notion', CONN, 'notion-create-pages');
  const r = await turn(rawModel([], [[wire], []]));
  assert.equal(r.pending?.[0]?.tool, wire);
  assert.deepEqual(sourceCalls, []);
  const confirmed = await ext.withExternalTools(nora, async () => ({ text: '', isError: true }), { confirmed: true })(wire, { pages: [] });
  assert.equal(confirmed.isError, false, confirmed.text);
  assert.deepEqual(sourceCalls, ['notion-create-pages']);
});

test('TWIN: an unknown tool name is refused ONCE with the exact valid names, so the model can correct itself in one step', async () => {
  const r = await ext.withExternalTools(nora, async () => ({ text: '', isError: true }))(ext.wireName('notion', CONN, 'notion'), {});
  assert.equal(r.isError, true);
  const err = JSON.parse(r.text).error as { code: string; hint: string };
  assert.equal(err.code, 'unknown_tool');
  assert.ok(err.hint.includes(ext.wireName('notion', CONN, 'notion-fetch')), err.hint);
  assert.ok(err.hint.includes(ext.wireName('notion', CONN, 'notion-search')), err.hint);
  assert.deepEqual(sourceCalls, []);
});
