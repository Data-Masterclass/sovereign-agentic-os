/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_WRITE_TOOLS } from './write-tools.ts';
import { WRITE_TOOL_TABS, WRITE_TOOL_NAMES } from './write-tool-meta.ts';

test('WRITE_TOOL_TABS matches ALL_WRITE_TOOLS exactly (names and tabs)', () => {
  const actual = Object.fromEntries(ALL_WRITE_TOOLS.map((t) => [t.name, t.tab]));
  assert.deepEqual(WRITE_TOOL_TABS, actual);
  assert.equal(WRITE_TOOL_NAMES.size, ALL_WRITE_TOOLS.length, 'duplicate write tool names');
});
