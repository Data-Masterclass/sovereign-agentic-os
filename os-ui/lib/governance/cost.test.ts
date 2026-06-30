/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __resetCost, setCap, listCaps, checkCap, addSpend } from './cost.ts';

beforeEach(() => __resetCost());

test('no cap → action allowed; a cap blocks an over-cap action', () => {
  assert.equal(checkCap({ scope: 'domain', subject: 'sales', amount: 5 }).allowed, true);
  setCap({ scope: 'domain', subject: 'sales', limit: 100, createdBy: 'sara' });
  assert.equal(checkCap({ scope: 'domain', subject: 'sales', amount: 50 }).allowed, true);
  assert.equal(checkCap({ scope: 'domain', subject: 'sales', amount: 150 }).allowed, false);
});

test('spend accumulates toward the cap until an action is blocked', () => {
  setCap({ scope: 'key', subject: 'sk-premium', limit: 10, modelClass: 'premium', createdBy: 'sara' });
  addSpend('key', 'sk-premium', 8, 'premium');
  const within = checkCap({ scope: 'key', subject: 'sk-premium', amount: 1, modelClass: 'premium' });
  assert.equal(within.allowed, true);
  const over = checkCap({ scope: 'key', subject: 'sk-premium', amount: 5, modelClass: 'premium' });
  assert.equal(over.allowed, false);
  assert.match(over.reason, /over cap/);
});

test('caps list is scoped (Builder sees own domain + key/tenant)', () => {
  setCap({ scope: 'domain', subject: 'sales', limit: 100, createdBy: 'sara' });
  setCap({ scope: 'domain', subject: 'finance', limit: 100, createdBy: 'sara' });
  const salesView = listCaps(['sales']);
  assert.ok(salesView.some((c) => c.subject === 'sales'));
  assert.ok(!salesView.some((c) => c.subject === 'finance'));
});
