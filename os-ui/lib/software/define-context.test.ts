/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/** Tests for the Define-context block threaded into Design/Build LLM prompts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defineContextBlock, defineContextNote, specPromptLines, templateLabel } from './define-context.ts';

test('define-context: the block always carries the template (the always-set choice)', () => {
  const block = defineContextBlock({ template: 'sovereign-app' });
  assert.match(block, /## Context from Define/);
  assert.match(block, /Template: Sovereign Application/);
  // Ground instruction is present so the generator knows to use it.
  assert.match(block, /Ground every feature spec and code change/);
});

test('define-context: name/description/purpose appear only when present (nil-safe)', () => {
  const full = defineContextBlock({
    template: 'website',
    name: 'Renewals Tracker',
    description: 'Tracks contract renewals',
    purpose: 'Give the team a live view of upcoming renewals',
  });
  assert.match(full, /App name: Renewals Tracker/);
  assert.match(full, /Description: Tracks contract renewals/);
  assert.match(full, /Purpose: Give the team a live view/);

  // A sparse Define degrades to just the template line — no empty noise.
  const sparse = defineContextBlock({ template: 'empty' });
  assert.equal(sparse.includes('App name:'), false);
  assert.equal(sparse.includes('Description:'), false);
  assert.equal(sparse.includes('Purpose:'), false);
});

test('define-context: unknown / missing template degrades honestly', () => {
  assert.equal(templateLabel(undefined), '(unspecified)');
  assert.equal(templateLabel('mystery'), 'mystery');
  assert.match(defineContextBlock({}), /Template: \(unspecified\)/);
});

test('define-context: specPromptLines renders the three lists, nil-safe', () => {
  assert.deepEqual(specPromptLines(undefined), []);
  assert.deepEqual(specPromptLines({ features: [], nfrs: [], rules: [] }), []);
  assert.deepEqual(
    specPromptLines({ features: ['Send email'], nfrs: ['Fast'], rules: ['Approve writes'] }),
    ['Features to build: Send email', 'Non-functional requirements: Fast', 'Rules: Approve writes'],
  );
});

test('define-context: the build/add-feature payload includes Define context AND the story spec', () => {
  // Mirror how the routes compose the prompt: the Define block + the targeted story's
  // spec lines both land in the payload the LLM sees.
  const app = { template: 'sovereign-app', name: 'Invoices', description: 'AP tool', purpose: 'Track overdue invoices' };
  const spec = { features: ['Send reminder'], nfrs: ['Loads fast'], rules: ['Writes need approval'] };
  const payload = [defineContextBlock(app), ...specPromptLines(spec)].join('\n');
  // Define context present.
  assert.match(payload, /## Context from Define/);
  assert.match(payload, /Template: Sovereign Application/);
  assert.match(payload, /Purpose: Track overdue invoices/);
  assert.match(payload, /Description: AP tool/);
  // Story spec present.
  assert.match(payload, /Features to build: Send reminder/);
  assert.match(payload, /Rules: Writes need approval/);
});

test('define-context: the one-line note carries template + purpose for the UI panel', () => {
  assert.equal(defineContextNote({ template: 'api-service' }), 'APIs only (headless service, no UI)');
  assert.equal(
    defineContextNote({ template: 'api-service', purpose: 'Serve invoice tools' }),
    'APIs only (headless service, no UI) · Serve invoice tools',
  );
});
