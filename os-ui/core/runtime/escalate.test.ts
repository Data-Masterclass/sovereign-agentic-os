/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { _reset as resetSettings, updateSettings, __setForTests } from '@tabs/admin/lib/settings';
import { _reset as resetModels } from '@tabs/admin/lib/models';
import { completeWithEscalation } from '@core/runtime/escalate';
import type { AssistantCaller } from '@core/runtime/complete';

const STANDARD = 'sovereign-worker';
const REASONING = 'sovereign-strong';
const WORKER = 'sovereign-worker';

beforeEach(() => {
  resetSettings();
  resetModels();
  __setForTests({ standardFirstEscalation: true }); // the cost-saving mode: worker first
});

/** A caller that records every model it was asked to run and returns a scripted reply. */
function scriptCaller(replies: Record<string, string>): { caller: AssistantCaller; models: string[] } {
  const models: string[] = [];
  const caller: AssistantCaller = async (req) => {
    models.push(req.model);
    if (!(req.model in replies)) throw new Error(`no scripted reply for ${req.model}`);
    return replies[req.model];
  };
  return { caller, models };
}

test('standard-first: a VALID standard answer wins outright — reasoning is never called', async () => {
  const { caller, models } = scriptCaller({ [STANDARD]: 'good', [REASONING]: 'deep' });
  const out = await completeWithEscalation([{ role: 'user', content: 'q' }], {
    caller,
    validate: (c) => c === 'good',
  });
  assert.equal(out.content, 'good');
  assert.equal(out.model, STANDARD); // attribution: the tier that actually answered
  assert.equal(out.escalated, false);
  assert.deepEqual(models, [STANDARD]); // ONE call — no escalation on success
});

test('escalation triggers ONLY on a failed standard validation, then reasoning answers', async () => {
  const { caller, models } = scriptCaller({ [STANDARD]: 'weak', [REASONING]: 'deep' });
  const out = await completeWithEscalation([{ role: 'user', content: 'q' }], {
    caller,
    validate: (c) => c === 'deep', // standard's 'weak' fails → escalate
  });
  assert.equal(out.content, 'deep');
  assert.equal(out.model, REASONING); // attribution follows the escalation
  assert.equal(out.escalated, true);
  assert.deepEqual(models, [STANDARD, REASONING]); // standard first, then ONE escalation
});

test('escalation happens AT MOST once — a failing reasoning answer still stands (honest failure)', async () => {
  const { caller, models } = scriptCaller({ [STANDARD]: 'weak', [REASONING]: 'still-weak' });
  const out = await completeWithEscalation([{ role: 'user', content: 'q' }], {
    caller,
    validate: () => false, // nothing passes → exactly one escalation, then return reasoning
  });
  assert.equal(out.content, 'still-weak');
  assert.equal(out.model, REASONING);
  assert.equal(out.escalated, true);
  assert.deepEqual(models, [STANDARD, REASONING]); // never a third call
});

test('a THROWING standard call falls through to a single reasoning escalation', async () => {
  const models: string[] = [];
  const caller: AssistantCaller = async (req) => {
    models.push(req.model);
    if (req.model === STANDARD) throw new Error('standard unreachable');
    return 'deep';
  };
  const out = await completeWithEscalation([{ role: 'user', content: 'q' }], {
    caller,
    validate: (c) => c === 'deep',
  });
  assert.equal(out.content, 'deep');
  assert.equal(out.model, REASONING);
  assert.equal(out.escalated, true);
  assert.deepEqual(models, [STANDARD, REASONING]);
});

test('a throwing validate predicate counts as a rejection → escalates', async () => {
  const { caller, models } = scriptCaller({ [STANDARD]: 'x', [REASONING]: 'deep' });
  const out = await completeWithEscalation([{ role: 'user', content: 'q' }], {
    caller,
    validate: () => {
      throw new Error('boom');
    },
  });
  assert.equal(out.model, REASONING);
  assert.deepEqual(models, [STANDARD, REASONING]);
});

test('admin toggle OFF pins the surface to reasoning directly — standard is never tried', async () => {
  updateSettings({ standardFirstEscalation: false });
  const { caller, models } = scriptCaller({ [STANDARD]: 'good', [REASONING]: 'deep' });
  const out = await completeWithEscalation([{ role: 'user', content: 'q' }], {
    caller,
    validate: (c) => c === 'good', // would pass on standard, but standard is skipped
  });
  assert.equal(out.content, 'deep');
  assert.equal(out.model, REASONING);
  assert.equal(out.escalated, false);
  assert.deepEqual(models, [REASONING]); // only reasoning ran
});

test('an explicit standardModel option wins over the role: it re-points which model the cheap tier runs', async () => {
  const { caller, models } = scriptCaller({ 'catalog-cheap': 'good', [REASONING]: 'deep' });
  const out = await completeWithEscalation([{ role: 'user', content: 'q' }], {
    caller,
    standardModel: 'catalog-cheap',
    validate: (c) => c === 'good',
  });
  assert.equal(out.model, 'catalog-cheap');
  assert.equal(out.escalated, false);
  assert.deepEqual(models, ['catalog-cheap']);
});

test('NEGATIVE TWIN: the old admin override (settings modelRoles) no longer re-points the cheap tier', async () => {
  __setForTests({ modelRoles: { standard: 'catalog-cheap', reasoning: '', embeddings: '', tools: '' } });
  const { caller, models } = scriptCaller({ [WORKER]: 'good', [REASONING]: 'deep' });
  const out = await completeWithEscalation([{ role: 'user', content: 'q' }], { caller, validate: (c) => c === 'good' });
  assert.equal(out.model, WORKER);
  assert.deepEqual(models, [WORKER]);
});

test('when standard and reasoning are the SAME model, a single call runs (nothing to save)', async () => {
  const { caller, models } = scriptCaller({ [REASONING]: 'deep' });
  const out = await completeWithEscalation([{ role: 'user', content: 'q' }], {
    caller,
    standardModel: REASONING,
    validate: () => false, // even a failing validate can't cause a second identical call
  });
  assert.equal(out.model, REASONING);
  assert.equal(out.escalated, false);
  assert.deepEqual(models, [REASONING]);
});
