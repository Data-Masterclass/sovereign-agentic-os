/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       runtime
 * FEATURE:    The named worker helpers: bounded input, fixed output shape, validation, escalation
 * USER STORY: As the owner I want each delegated sub-task to be a small named helper whose answer is
 *             checked against a schema, and redone on the strong model when the check fails.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { LlmCall } from '@core/runtime/agentic';
import { delegate, extractFields, classify, draftSaveAs, formatTable, condense } from '@core/runtime/delegate';
import { _reset as resetSettings, updateSettings } from '@tabs/admin/lib/settings';

const STRONG = 'sovereign-strong';
const WORKER = 'sovereign-worker';
beforeEach(() => { resetSettings(); });

function model(replies: Record<string, string[]>): { llm: LlmCall; calls: { model: string; purpose?: string }[] } {
  const calls: { model: string; purpose?: string }[] = [];
  const idx: Record<string, number> = {};
  const llm: LlmCall = async (req) => {
    calls.push({ model: req.model, purpose: (req as { purpose?: string }).purpose });
    const list = replies[req.model] ?? [];
    const i = idx[req.model] ?? 0; idx[req.model] = i + 1;
    return { content: list[Math.min(i, list.length - 1)] ?? '', toolCalls: [] };
  };
  return { llm, calls };
}

test('extract: a valid worker JSON object is returned, one worker call, not escalated', async () => {
  const { llm, calls } = model({ [WORKER]: ['{"name":"Acme","amount":12}'] });
  const out = await extractFields(llm, { text: 'Acme paid 12', fields: { name: 'string', amount: 'number' } });
  assert.deepEqual(out.value, { name: 'Acme', amount: 12 });
  assert.equal(out.escalated, false);
  assert.deepEqual(calls.map((c) => c.model), [WORKER]);
});

test('extract twin: a wrong type or a missing field fails the schema and is redone on strong', async () => {
  const { llm, calls } = model({ [WORKER]: ['{"name":"Acme","amount":"twelve"}'], [STRONG]: ['{"name":"Acme","amount":12}'] });
  const out = await extractFields(llm, { text: 'Acme paid 12', fields: { name: 'string', amount: 'number' } });
  assert.deepEqual(out.value, { name: 'Acme', amount: 12 });
  assert.equal(out.escalated, true);
  assert.deepEqual(calls.map((c) => c.model), [WORKER, STRONG]);
});

test('classify: only a label from the given list is accepted; anything else escalates', async () => {
  const ok = model({ [WORKER]: ['{"label":"invoice"}'] });
  assert.equal((await classify(ok.llm, { text: 'x', labels: ['invoice', 'contract'] })).value.label, 'invoice');
  const bad = model({ [WORKER]: ['{"label":"memo"}'], [STRONG]: ['{"label":"contract"}'] });
  const r = await classify(bad.llm, { text: 'x', labels: ['invoice', 'contract'] });
  assert.equal(r.value.label, 'contract');
  assert.equal(r.escalated, true);
});

test('draft_save_as: the draft must carry every required argument of the tool; a draft that misses one escalates', async () => {
  const schema = { type: 'object' as const, properties: { name: { type: 'string' }, sql: { type: 'string' } }, required: ['name', 'sql'] };
  const ok = model({ [WORKER]: ['{"name":"Revenue","sql":"select 1"}'] });
  assert.equal((await draftSaveAs(ok.llm, { answer: 'a', toolSchema: schema })).escalated, false);
  const bad = model({ [WORKER]: ['{"name":"Revenue"}'], [STRONG]: ['{"name":"Revenue","sql":"select 1"}'] });
  const r = await draftSaveAs(bad.llm, { answer: 'a', toolSchema: schema });
  assert.equal(r.escalated, true);
  assert.deepEqual(r.value, { name: 'Revenue', sql: 'select 1' });
});

test('format_table: columns and rows must be rectangular and drawn from the input', async () => {
  const ok = model({ [WORKER]: ['{"columns":["a","b"],"rows":[["1","2"]]}'] });
  assert.equal((await formatTable(ok.llm, { text: 'a=1 b=2' })).escalated, false);
  const ragged = model({ [WORKER]: ['{"columns":["a","b"],"rows":[["1"]]}'], [STRONG]: ['{"columns":["a","b"],"rows":[["1","2"]]}'] });
  assert.equal((await formatTable(ragged.llm, { text: 'a=1 b=2' })).escalated, true);
});

test('condense: input beyond the bound is cut before it reaches the worker (bounded input)', async () => {
  let sent = 0;
  const llm: LlmCall = async (req) => { sent = req.messages.map((m) => m.content.length).reduce((a, b) => a + b, 0); return { content: '{"summary":"s","keyFigures":[]}', toolCalls: [] }; };
  await condense(llm, { text: 'x'.repeat(500_000) });
  assert.ok(sent < 120_000, `sent ${sent} chars`);
});

test('escalation is logged: the helper reports escalated:true and writes one warning line', async () => {
  const lines: string[] = [];
  const orig = console.warn; console.warn = (...a: unknown[]) => { lines.push(a.join(' ')); };
  try {
    const { llm } = model({ [WORKER]: ['nope'], [STRONG]: ['{"label":"invoice"}'] });
    await classify(llm, { text: 'x', labels: ['invoice'] });
  } finally { console.warn = orig; }
  assert.equal(lines.filter((l) => /escalat/i.test(l) && /classify/.test(l)).length, 1);
});

test('escalation twin: with standard-first escalation switched OFF by the admin the helper goes straight to strong', async () => {
  updateSettings({ standardFirstEscalation: false } as never);
  const { llm, calls } = model({ [STRONG]: ['{"label":"invoice"}'] });
  await classify(llm, { text: 'x', labels: ['invoice'] });
  assert.deepEqual(calls.map((c) => c.model), [STRONG]);
});

test('a failing strong answer is returned as an honest failure, not as a value', async () => {
  const { llm } = model({ [WORKER]: ['nope'], [STRONG]: ['still nope'] });
  await assert.rejects(() => classify(llm, { text: 'x', labels: ['a'] }), /did not pass its schema/i);
});

test('delegate rejects an unknown task (the door is a closed list)', async () => {
  const { llm } = model({});
  await assert.rejects(() => delegate(llm, { task: 'plan' as never, input: 'x' }), /not a delegable task/i);
});
