/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { CurrentUser } from '@core/kernel/auth';
import { loadBuildSpec } from '@core/tabs-meta/build-spec';
import { RESOURCES } from '@core/mcp/resources';
import { preamble } from '@tabs/agents/lib/build/agentic-graph-server';

/**
 * THE BUILD-SPEC DRIFT GUARD. The canonical spec has ONE source of truth with
 * THREE projections that must never diverge:
 *   (a) the canonical doc the loader reads  `tabs/software/build-spec/software.md`
 *       (it lives with the tab it specifies; the former repo-root duplicate at
 *       docs/build-spec/ was removed — one copy cannot drift from itself)
 *   (b) the MCP resource `sovereign-os://guide/build-spec/software`
 *   (c) the internal team executor's system preamble
 * If any two disagree, Claude (via MCP) and the internal team would build against
 * different rules — this test fails first.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const OS_MIRROR = resolve(HERE, '../../tabs/software/build-spec/software.md');

const anyUser: CurrentUser = { id: 'u', name: 'U', domains: ['sales'], role: 'creator' };


test('loadBuildSpec returns the mirror content (non-empty)', () => {
  const spec = loadBuildSpec();
  assert.ok(spec.length > 0, 'the build spec is non-empty');
  assert.equal(spec, readFileSync(OS_MIRROR, 'utf8').trim());
});

test('the MCP build-spec resource serves exactly loadBuildSpec()', async () => {
  const res = RESOURCES.find((r) => r.uri === 'sovereign-os://guide/build-spec/software');
  assert.ok(res, 'the build-spec resource is registered');
  assert.equal(res!.mimeType, 'text/markdown');
  assert.equal(await res!.read(anyUser), loadBuildSpec());
});

test('the internal team executor preamble injects the same build spec (no drift)', () => {
  assert.ok(preamble().includes(loadBuildSpec()), 'the executor preamble carries the canonical build spec verbatim');
});
