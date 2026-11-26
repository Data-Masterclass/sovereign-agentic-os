/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The per-tab helpers (incl. the Knowledge agent that drafts a workflow) answer in the user's language
 * USER STORY: As a German-speaking domain expert I capture a workflow with the Knowledge agent and get its
 *             questions and its markdown draft in German — while an English user's prompt stays exactly as it was.
 * ARCHITECTURE: the REAL `/api/agent-chat` route and the REAL `runTabAgent` / `tabAgentSystem`; only auth, the
 *             saved language (`getUserLocale`), the model (a spy that records the request) and the plain-path
 *             completion are stand-ins. English must add NOTHING (byte-for-byte), German appends the block once,
 *             and the locale must come from the acting user — not a default.
 */
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import type { LlmCall } from '@core/runtime/agentic';
import type { RpcDispatch } from '@core/runtime/agent-loop';

const expert: CurrentUser = { id: 'u-expert', name: 'Kim', domains: ['sales'], role: 'creator' };

let LOCALE = 'en';
const localeAskedFor: string[] = [];
const seen: string[] = [];
const plainSeen: { role: string; content: string }[][] = [];
const llm: LlmCall = async (req) => {
  seen.push(JSON.stringify(req));
  return { content: 'ok', toolCalls: [] };
};
const dispatch: RpcDispatch = async () => ({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{}' }] } });

const real = await import('@core/runtime/runtime');
const realComplete = await import('@core/runtime/complete');
mock.module('@core/kernel/auth', { namedExports: { currentUser: async () => expert, requireUser: async () => expert } });
mock.module('@core/prefs/locale', {
  namedExports: { getUserLocale: async (id: string) => { localeAskedFor.push(id); return LOCALE; } },
});
mock.module('@core/runtime/runtime', {
  namedExports: {
    ...real,
    runTabAgent: (input: Parameters<typeof real.runTabAgent>[0]) => real.runTabAgent({ ...input, llm, dispatch }),
  },
});
mock.module('@core/runtime/complete', {
  namedExports: {
    ...realComplete,
    assistantComplete: async (messages: { role: string; content: string }[]) => {
      plainSeen.push(messages);
      return { content: 'ok', model: 'test' };
    },
  },
});
const { POST } = await import('../../app/api/agent-chat/route.ts');

beforeEach(() => { LOCALE = 'en'; localeAskedFor.length = 0; seen.length = 0; plainSeen.length = 0; });

const post = (agent: string) =>
  POST(new Request('http://os.test/api/agent-chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent, messages: [{ role: 'user', content: 'Capture our refund workflow' }] }),
  }));

test('tabAgentSystem: English (or no locale) is byte-for-byte the plain system prompt; German appends the block', () => {
  const plain = real.tabAgentSystem('knowledge', 'ctx');
  assert.equal(real.tabAgentSystem('knowledge', 'ctx', 'en'), plain);
  assert.doesNotMatch(plain, /ANSWER LANGUAGE/);
  const de = real.tabAgentSystem('knowledge', 'ctx', 'de');
  assert.ok(de.startsWith(plain + '\n'), 'the German prompt is the English one plus the block');
  assert.match(de, /--- ANSWER LANGUAGE: German ---/);
  assert.equal(de.match(/ANSWER LANGUAGE/g)?.length, 1);
});

test('ROUTE knowledge agent: an English user\'s model request carries no language block', async () => {
  const res = await post('knowledge');
  assert.equal(res.status, 200);
  assert.ok(seen.length > 0, 'the model was called');
  assert.doesNotMatch(seen.join(''), /ANSWER LANGUAGE/);
  assert.deepEqual(localeAskedFor, ['u-expert']);
});

test('ROUTE knowledge agent: a German user\'s language reaches the model call', async () => {
  LOCALE = 'de';
  const res = await post('knowledge');
  assert.equal(res.status, 200);
  assert.match(seen.join(''), /ANSWER LANGUAGE: German/);
  assert.deepEqual(localeAskedFor, ['u-expert'], 'the ACTING user\'s language, read once');
});

test('ROUTE plain helper (no tool surface): English unchanged, Polish appended to the system message', async () => {
  await post('no-such-helper');
  assert.equal(plainSeen.length, 1);
  assert.equal(plainSeen[0][0].role, 'system');
  assert.doesNotMatch(plainSeen[0][0].content, /ANSWER LANGUAGE/);
  const englishSystem = plainSeen[0][0].content;

  LOCALE = 'pl';
  await post('no-such-helper');
  assert.ok(plainSeen[1][0].content.startsWith(`${englishSystem}\n\n--- ANSWER LANGUAGE: Polish ---\n`), 'the English prompt, then the block');
  assert.equal(plainSeen[1].length, plainSeen[0].length, 'no extra message, only the system prompt grows');
});
