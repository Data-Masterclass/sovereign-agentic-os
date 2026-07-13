/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildJudgePrompt, parseJudgeReply, judgeRun, dimensionLabel, type JudgeComplete,
} from './evaluate-judge.ts';

test('buildJudgePrompt embeds the description and the output', () => {
  const msgs = buildJudgePrompt({ output: 'DO X NOW', description: 'Recommend budget moves' });
  assert.equal(msgs[0].role, 'system');
  const user = msgs[1].content;
  assert.match(user, /Recommend budget moves/);
  assert.match(user, /DO X NOW/);
  assert.match(user, /clarity/);
  assert.match(user, /grounding/);
  assert.match(user, /actionability/);
});

test('buildJudgePrompt includes tacit knowledge when given', () => {
  const msgs = buildJudgePrompt({ output: 'o', description: 'd', tacitKnowledge: 'must cite the CFO memo' });
  assert.match(msgs[1].content, /TACIT SUCCESS CRITERIA/);
  assert.match(msgs[1].content, /CFO memo/);
});

test('buildJudgePrompt omits the tacit block when absent or blank', () => {
  const msgs = buildJudgePrompt({ output: 'o', description: 'd', tacitKnowledge: '   ' });
  assert.doesNotMatch(msgs[1].content, /TACIT SUCCESS CRITERIA/);
});

test('parseJudgeReply parses clean JSON into three scores + overall', () => {
  const raw = JSON.stringify({
    clarity: { score: 4, why: 'well structured' },
    grounding: { score: 5, why: 'cites sources' },
    actionability: { score: 3, why: 'one clear step' },
  });
  const r = parseJudgeReply(raw);
  assert.equal(r.scores.length, 3);
  assert.equal(r.scores.find((s) => s.dimension === 'clarity')!.score, 4);
  assert.equal(r.scores.find((s) => s.dimension === 'grounding')!.why, 'cites sources');
  assert.equal(r.overall, 4); // (4+5+3)/3 = 4.0
});

test('parseJudgeReply tolerates ```json fences and surrounding prose', () => {
  const raw = 'Here is my verdict:\n```json\n{"clarity":{"score":2,"why":"vague"},"grounding":{"score":2,"why":"unsourced"},"actionability":{"score":1,"why":"none"}}\n```\nThanks.';
  const r = parseJudgeReply(raw);
  assert.equal(r.scores.find((s) => s.dimension === 'clarity')!.score, 2);
  assert.equal(r.overall, 1.7); // (2+2+1)/3 = 1.666 → 1.7
});

test('parseJudgeReply clamps out-of-range and missing scores to 1..5', () => {
  const raw = JSON.stringify({
    clarity: { score: 9, why: 'too high' },
    grounding: { score: 0 },
    actionability: {},
  });
  const r = parseJudgeReply(raw);
  assert.equal(r.scores.find((s) => s.dimension === 'clarity')!.score, 5);
  assert.equal(r.scores.find((s) => s.dimension === 'grounding')!.score, 1);
  assert.equal(r.scores.find((s) => s.dimension === 'actionability')!.score, 1);
  assert.equal(r.scores.find((s) => s.dimension === 'actionability')!.why, '(no reason given)');
});

test('parseJudgeReply throws an honest error on non-JSON', () => {
  assert.throws(() => parseJudgeReply('the model refused'), /did not return JSON/);
});

test('judgeRun wires the injected model and returns parsed scores', async () => {
  const captured: { content: string }[] = [];
  const complete: JudgeComplete = async (messages) => {
    captured.push(...messages);
    return JSON.stringify({
      clarity: { score: 5, why: 'a' }, grounding: { score: 4, why: 'b' }, actionability: { score: 4, why: 'c' },
    });
  };
  const r = await judgeRun({ output: 'ans', description: 'task' }, complete);
  assert.equal(r.overall, 4.3); // (5+4+4)/3 = 4.333 → 4.3
  // The model actually received the prompt with the output embedded.
  assert.ok(captured.some((m) => m.content.includes('ans')));
});

test('dimensionLabel gives human labels', () => {
  assert.equal(dimensionLabel('clarity'), 'Clarity');
  assert.equal(dimensionLabel('grounding'), 'Grounding');
  assert.equal(dimensionLabel('actionability'), 'Actionability');
});
