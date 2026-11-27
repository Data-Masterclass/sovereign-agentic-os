/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The agent-system stage assistant, the team proposer and the run judge answer in the user's language
 * USER STORY: As a German-speaking creator building an agent team I get the stage assistant's advice, the proposed
 *             team's roles and the judge's reasons in German — while an English user's prompt stays exactly as it was.
 * ARCHITECTURE: the REAL `/api/agents/systems/[id]/assistant` and `/evaluate` routes; only auth, the store read, the
 *             grounding resolver, the saved language (`getUserLocale`) and the governed model (a spy that records
 *             the request) are stand-ins. English must add NOTHING (byte-for-byte), another language appends the
 *             block once to the system message, and the locale comes from the acting user.
 */
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';

const creator: CurrentUser = { id: 'u-creator', name: 'Kim', domains: ['sales'], role: 'creator' };

let LOCALE = 'en';
const localeAskedFor: string[] = [];
const seen: { role: string; content: string }[][] = [];
let REPLY = 'ok';

const system = {
  system: { name: 'Pricing team', domain: 'sales', description: 'Recommend prices.' },
  agents: [{ id: 'analyst', role: 'Analyses prices' }],
  grants: { knowledge: [], data: [], files: [], connections: [], metrics: [] },
};

const realComplete = await import('@core/runtime/complete');
mock.module('@core/kernel/auth', { namedExports: { currentUser: async () => creator, requireUser: async () => creator } });
const realLocale = await import('@core/prefs/locale');
mock.module('@core/prefs/locale', {
  namedExports: { ...realLocale, getUserLocale: async (id: string) => { localeAskedFor.push(id); return LOCALE; } },
});
mock.module('@core/runtime/complete', {
  namedExports: {
    ...realComplete,
    assistantComplete: async (messages: { role: string; content: string }[]) => {
      seen.push(messages);
      return { content: REPLY, model: 'test' };
    },
  },
});
const realStore = await import('@tabs/agents/lib/store');
mock.module('@tabs/agents/lib/store', {
  namedExports: { ...realStore, getSystem: () => ({ system, owner: creator.id, lastRun: { output: 'Raise B by 3%.' } }) },
});
mock.module('@tabs/agents/lib/grounding', {
  namedExports: { resolveSystemGrounding: async () => ({ description: 'Recommend prices.' }) },
});
const { POST: ASSIST } = await import('../../../../app/api/agents/systems/[id]/assistant/route.ts');
const { POST: EVALUATE } = await import('../../../../app/api/agents/systems/[id]/evaluate/route.ts');

beforeEach(() => { LOCALE = 'en'; localeAskedFor.length = 0; seen.length = 0; REPLY = 'ok'; });

const ctx = { params: Promise.resolve({ id: 'sys-1' }) };
const json = (url: string, body: unknown) => new Request(url, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const askStage = (stage: string) =>
  ASSIST(json('http://os.test/api/agents/systems/sys-1/assistant', { stage, messages: [{ role: 'user', content: 'Help' }] }), ctx);

test('stage assistant (prose stage): English unchanged; German appends the chat block once', async () => {
  const en = await askStage('run');
  assert.equal(en.status, 200);
  assert.equal(seen.length, 1);
  assert.doesNotMatch(seen[0][0].content, /ANSWER LANGUAGE/);
  const englishSystem = seen[0][0].content;
  assert.deepEqual(localeAskedFor, ['u-creator']);

  LOCALE = 'de';
  await askStage('run');
  assert.ok(seen[1][0].content.startsWith(`${englishSystem}\n\n--- ANSWER LANGUAGE: German ---\n`));
  assert.match(seen[1][0].content, /Always answer the user in German/);
  assert.equal(seen[1].length, seen[0].length, 'only the system prompt grows');
});

test('stage assistant (structured stage): the generated-text block keeps the JSON contract', async () => {
  REPLY = '{"message":"Gut."}';
  LOCALE = 'fr';
  const res = await askStage('define');
  assert.equal(res.status, 200);
  assert.match(seen[0][0].content, /--- ANSWER LANGUAGE: French ---/);
  assert.match(seen[0][0].content, /Keep the JSON structure/);
  assert.equal(seen[0][0].content.match(/ANSWER LANGUAGE/g)?.length, 1);
});

test('team proposer: the proposal prompt carries the user\'s language', async () => {
  REPLY = '{"agents":[]}';
  LOCALE = 'pl';
  await ASSIST(json('http://os.test/api/agents/systems/sys-1/assistant', { stage: 'design', propose: true, description: 'Recommend prices.' }), ctx);
  assert.ok(seen.length >= 1, 'the model was called');
  assert.match(seen[0][0].content, /--- ANSWER LANGUAGE: Polish ---/);
});

test('run judge: English unchanged; Czech reasons are requested', async () => {
  REPLY = '{"clarity":{"score":4,"why":"x"},"grounding":{"score":4,"why":"x"},"actionability":{"score":4,"why":"x"}}';
  const en = await EVALUATE(json('http://os.test/api/agents/systems/sys-1/evaluate', { output: 'Raise B by 3%.' }), ctx);
  assert.equal(en.status, 200);
  assert.doesNotMatch(seen[0].map((m) => m.content).join('\n'), /ANSWER LANGUAGE/);

  LOCALE = 'cs';
  await EVALUATE(json('http://os.test/api/agents/systems/sys-1/evaluate', { output: 'Raise B by 3%.' }), ctx);
  assert.match(seen[1][0].content, /--- ANSWER LANGUAGE: Czech ---/);
  assert.deepEqual(localeAskedFor, ['u-creator', 'u-creator']);
});
