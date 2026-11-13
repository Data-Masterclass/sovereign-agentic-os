/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        data
 * FEATURE:    The quality-rule editor's form logic, tested without the component
 * USER STORY: As a maintainer I want a rule added to the model but forgotten in the editor to fail
 *             a test, not to ship as a dropdown entry with no fields.
 * ARCHITECTURE: pure imports only — a test may not import a `.tsx`, which is exactly why this
 *               logic lives in `dq-rule-form.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DATA_CHECK_RULES } from '@tabs/data/lib/dataset-schema';
import { RULE_LABELS, fieldsFor, addPayload, canSubmit, ruleText, type RuleDraft } from '@tabs/data/lib/dq-rule-form';

const empty: RuleDraft = { column: '', values: '', min: '', max: '', toDataset: '', toColumn: '' };

test('every rule in the model has an editor label — a new rule cannot ship without a field set', () => {
  assert.deepEqual(Object.keys(RULE_LABELS).sort(), [...DATA_CHECK_RULES].sort());
});

test('reference shows its two target fields and nothing else', () => {
  assert.deepEqual(fieldsFor('reference'), ['toDataset', 'toColumn']);
  assert.deepEqual(fieldsFor('accepted_values'), ['values']);
  assert.deepEqual(fieldsFor('range'), ['min', 'max']);
  assert.deepEqual(fieldsFor('not_null'), []);
});

test('reference will not submit half-filled — the server 400 is one the user never needs to see', () => {
  const d = { ...empty, column: 'customer_id' };
  assert.equal(canSubmit('reference', d), false);
  assert.equal(canSubmit('reference', { ...d, toDataset: 'ds_cust01' }), false);
  assert.equal(canSubmit('reference', { ...d, toColumn: 'customer_id' }), false);
  assert.equal(canSubmit('reference', { ...d, toDataset: 'ds_cust01', toColumn: 'customer_id' }), true);
  // Every rule still needs a column, reference included.
  assert.equal(canSubmit('reference', { ...empty, toDataset: 'ds_cust01', toColumn: 'customer_id' }), false);
  // The other rules stay submittable with empty args: their server message is worth showing.
  assert.equal(canSubmit('range', { ...empty, column: 'amount' }), true);
});

test('the add payload carries only this rule’s arguments, trimmed', () => {
  assert.deepEqual(
    addPayload('reference', { ...empty, column: 'customer_id', toDataset: '  ds_cust01 ', toColumn: ' customer_id ' }),
    { toDataset: 'ds_cust01', toColumn: 'customer_id' },
  );
  // A reference draft left over from a previous rule kind must not leak into another rule.
  assert.deepEqual(addPayload('not_null', { ...empty, column: 'x', toDataset: 'ds_x', toColumn: 'y' }), {});
  assert.deepEqual(addPayload('accepted_values', { ...empty, column: 's', values: ' a, b ,,c ' }), { values: ['a', 'b', 'c'] });
});

test('the stored-rule label names both ends of a reference', () => {
  assert.equal(
    ruleText({ rule: 'reference', column: 'customer_id', toDataset: 'ds_cust01', toColumn: 'customer_id' }),
    'reference(customer_id -> ds_cust01.customer_id)',
  );
  assert.equal(ruleText({ rule: 'range', column: 'amount', min: 0 }), 'range(amount, 0, )');
});
