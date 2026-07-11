/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAgentMd, serializeAgentMd, setInstructions, instructionsOf } from './agent-md.ts';

const SAMPLES = [
  '# Analyst\n\nYou analyze the material and explain what it means.\n\n## How to work\n1. Retrieve\n2. Explain',
  '# assistant\n\nA helpful assistant.',
  'No heading at all, just instructions.\n\nSecond paragraph.',
  '## Sub-heading first\n\nbody',
  '# Title only',
  '',
  '# Trailing gap\n\n\nbody with extra blank lines\n',
];

test('round-trip is lossless: serialize(parse(x)) === x', () => {
  for (const s of SAMPLES) {
    const parsed = parseAgentMd(s);
    assert.equal(serializeAgentMd(parsed, parsed.body), s, `lossless for: ${JSON.stringify(s)}`);
  }
});

test('the textarea body strips the leading H1 heading', () => {
  assert.equal(
    instructionsOf('# Analyst\n\nYou analyze the material.'),
    'You analyze the material.',
  );
});

test('no leading H1 → the whole text is the body', () => {
  assert.equal(instructionsOf('Just instructions.'), 'Just instructions.');
  assert.equal(instructionsOf('## Sub first\n\nbody'), '## Sub first\n\nbody');
});

test('editing instructions keeps the original heading + gap exactly', () => {
  const before = '# Analyst\n\nOld instructions.';
  const after = setInstructions(before, 'New instructions here.');
  assert.equal(after, '# Analyst\n\nNew instructions here.');
  // And that result still round-trips.
  const p = parseAgentMd(after);
  assert.equal(serializeAgentMd(p, p.body), after);
});

test('editing a heading-less doc replaces the whole body', () => {
  assert.equal(setInstructions('old', 'new'), 'new');
});

test('a body containing its own # lines is preserved (only the LEADING H1 splits)', () => {
  const md = '# Writer\n\nUse markdown like:\n\n# Section\n\ntext';
  const p = parseAgentMd(md);
  assert.equal(p.heading, '# Writer');
  assert.equal(p.body, 'Use markdown like:\n\n# Section\n\ntext');
  assert.equal(serializeAgentMd(p, p.body), md);
});
