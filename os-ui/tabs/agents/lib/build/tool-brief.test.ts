/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Tool-summary tests — first sentence, hard cap, and the whole registry stays one line
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_MCP_TOOLS } from '@core/mcp/server';
import { briefToolSpecs, toolSummary, TOOL_SUMMARY_MAX_CHARS } from '@tabs/agents/lib/build/tool-brief';

test('toolSummary: the first sentence, not the paragraph', () => {
  assert.equal(
    toolSummary('List the files you can see (My · Domain · Company). Path: DISCOVERY for the Files golden path. Governance: read-only, DLS-scoped.'),
    'List the files you can see (My · Domain · Company).',
  );
  assert.equal(toolSummary('Read one thing.'), 'Read one thing.');
  assert.equal(toolSummary('no full stop at all'), 'no full stop at all');
  assert.equal(toolSummary(''), '');
});

test('toolSummary: an abbreviation is not a sentence end, and a multi-line description is one line', () => {
  assert.equal(toolSummary('Slice by a column, e.g. Region or month. Then chart it.'), 'Slice by a column, e.g. Region or month.');
  assert.equal(toolSummary('Line one\ncontinues here. Second sentence.'), 'Line one continues here.');
});

test('toolSummary: a long first sentence is cut at a word boundary under the hard cap, with an ellipsis', () => {
  const long = `Build the gold layer by joining ${'a very long list of things and '.repeat(10)}more.`;
  const s = toolSummary(long);
  assert.ok(s.length <= TOOL_SUMMARY_MAX_CHARS, `${s.length} chars`);
  assert.ok(s.endsWith('…'));
  assert.ok(!/\s…$/.test(s), 'no dangling space before the ellipsis');
});

test('every tool in the registry summarises to one non-empty line within the cap', () => {
  for (const t of ALL_MCP_TOOLS) {
    const s = toolSummary(t.description);
    assert.ok(s.length > 0, `${t.name} has an empty summary`);
    assert.ok(s.length <= TOOL_SUMMARY_MAX_CHARS, `${t.name}: ${s.length} chars`);
    assert.ok(!s.includes('\n'), `${t.name} summary spans lines`);
  }
});

test('briefToolSpecs keeps names and schemas, shortens only the description', () => {
  const spec = { name: 'get_file', description: 'Read ONE file. Governance: read-only through the same entitlement filter.', inputSchema: { type: 'object' as const, properties: { fileId: { type: 'string' } }, required: ['fileId'] } };
  const [brief] = briefToolSpecs([spec]);
  assert.equal(brief.name, 'get_file');
  assert.equal(brief.description, 'Read ONE file.');
  assert.deepEqual(brief.inputSchema, spec.inputSchema);
  assert.match(spec.description, /Governance/, 'the input spec is not mutated');
});
