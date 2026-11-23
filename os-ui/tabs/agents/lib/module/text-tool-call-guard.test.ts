/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    The module engine's text-tool-call guard: one corrective retry, then a typed failure of the agent visit
 * USER STORY: As the owner I never see a tool call the model wrote as text presented as my agent's answer — on the
 *             module engine (`AGENT_GRAPH_MODULE`) as on the v1 engine.
 * ARCHITECTURE: the REAL middleware (`textToolCallGuard`, `os-agent.ts`) with a scripted model handler; the run driver's
 *             typed-failure mapping (`callLimitError`, `module/run.ts`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AIMessage } from 'langchain';
import { textToolCallGuard } from '@tabs/agents/lib/module/os-agent';
import { callLimitError } from '@tabs/agents/lib/module/run';
import { TextToolCallError, TEXT_TOOL_CALL_PROMPT } from '@core/runtime/text-tool-call';

const TEXT_CALL = '<tool_call>\n{"name": "delegate_to_worker", "arguments": {}}\n</tool_call>';
type Req = { messages: unknown[] };
const wrap = textToolCallGuard().wrapModelCall as unknown as (req: Req, h: (r: Req) => Promise<AIMessage>) => Promise<AIMessage>;

function scripted(replies: AIMessage[]) {
  const seen: Req[] = [];
  let i = 0;
  return { seen, handler: async (r: Req) => { seen.push(r); return replies[Math.min(i++, replies.length - 1)]; } };
}

test('a proper reply passes straight through (one model call)', async () => {
  const s = scripted([new AIMessage('the answer')]);
  const out = await wrap({ messages: [] }, s.handler);
  assert.equal(out.content, 'the answer');
  assert.equal(s.seen.length, 1);
});

test('a textual tool call is retried ONCE with the corrective note, and the proper retry is used', async () => {
  const s = scripted([new AIMessage(TEXT_CALL), new AIMessage('the answer')]);
  const out = await wrap({ messages: ['m1'] }, s.handler);
  assert.equal(out.content, 'the answer');
  assert.equal(s.seen.length, 2);
  const note = s.seen[1].messages.at(-1) as { content: string };
  assert.equal(note.content, TEXT_TOOL_CALL_PROMPT);
  assert.equal((s.seen[1].messages.at(-2) as { content: string }).content, TEXT_CALL, 'after the model\'s own bad reply');
});

test('twice: the typed TextToolCallError is thrown, and the run driver maps it to the failure code text_tool_call', async () => {
  const s = scripted([new AIMessage(TEXT_CALL), new AIMessage(TEXT_CALL)]);
  await assert.rejects(wrap({ messages: [] }, s.handler), (e: unknown) => e instanceof TextToolCallError);
  assert.equal(callLimitError(new TextToolCallError('x'))?.code, 'text_tool_call');
});

test('twin: a docs answer that SHOWS the markup in a code block is an answer, not a call (one model call)', async () => {
  const s = scripted([new AIMessage('Qwen writes:\n```xml\n' + TEXT_CALL + '\n```\nThe OS reads tool_calls instead.')]);
  await wrap({ messages: [] }, s.handler);
  assert.equal(s.seen.length, 1);
});

test('twin: a reply WITH a native tool call is never second-guessed, whatever its text says', async () => {
  const s = scripted([new AIMessage({ content: TEXT_CALL, tool_calls: [{ id: 'c1', name: 'search_knowledge', args: {} }] })]);
  const out = await wrap({ messages: [] }, s.handler);
  assert.equal(out.tool_calls?.length, 1);
  assert.equal(s.seen.length, 1);
});
