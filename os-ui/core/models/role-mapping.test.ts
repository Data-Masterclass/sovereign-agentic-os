/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       core / models
 * FEATURE:    The three role names the OS calls, and their mapping onto catalog models (`os/models.yml`).
 * USER STORY: As a platform admin I map `sovereign-strong`, `sovereign-worker` and
 *             `sovereign-embedding` to real catalog models; a mapping to a model that is not in the
 *             catalog is refused with a typed error, and an old alias keeps working as a deprecated name.
 * ARCHITECTURE:
 *   - Pure: parse / serialize the file, validate against the catalog, and derive what LiteLLM's
 *     `router_settings.model_group_alias` must hold. No IO.
 *   - NEGATIVE TWINS: unknown role, missing or non-string model, a model that is not in the catalog,
 *     a deprecated alias that is itself a real catalog model (the real model wins).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEPRECATED_ALIASES, ROLE_NAMES, ModelMappingError, desiredAliases, diffAliases, noteDeprecatedAlias, parseModelsYml, serializeModelsYml, validateMapping,
} from '@core/models/role-mapping';

const M = { 'sovereign-strong': 'stackit-qwen3-vl-235b', 'sovereign-worker': 'stackit-gpt-oss-20b', 'sovereign-embedding': 'stackit-embed' } as const;

test('exactly three role names', () => {
  assert.deepEqual([...ROLE_NAMES], ['sovereign-strong', 'sovereign-worker', 'sovereign-embedding']);
});

test('the file round-trips and is a plain, diffable YAML document', () => {
  const text = serializeModelsYml({ ...M });
  assert.match(text, /sovereign-strong: stackit-qwen3-vl-235b/);
  assert.deepEqual(parseModelsYml(text), M);
});

test('NEGATIVE TWINS: a file with an unknown role, a missing role or a non-string model is refused (typed)', () => {
  for (const bad of [
    'roles:\n  sovereign-strong: a\n  sovereign-worker: b\n  sovereign-embedding: c\n  sovereign-extra: d\n',
    'roles:\n  sovereign-strong: a\n  sovereign-worker: b\n',
    'roles:\n  sovereign-strong: [a]\n  sovereign-worker: b\n  sovereign-embedding: c\n',
    'not: a mapping\n',
    ': [unclosed',
  ]) {
    assert.throws(() => parseModelsYml(bad), (e: unknown) => e instanceof ModelMappingError && e.code === 'invalid_mapping' && e.status === 422, bad);
  }
});

test('a mapping to a model that is not in the catalog is refused with a typed error naming the role and model', () => {
  assert.doesNotThrow(() => validateMapping({ ...M }, Object.values(M)));
  assert.throws(
    () => validateMapping({ ...M, 'sovereign-strong': 'ghost' }, Object.values(M)),
    (e: unknown) => e instanceof ModelMappingError && e.code === 'unknown_catalog_model' && e.role === 'sovereign-strong' && e.model === 'ghost' && e.status === 422,
  );
});

test('the aliases LiteLLM must hold: the three roles, plus each deprecated name pointing where its role points', () => {
  const a = desiredAliases({ ...M }, new Set(Object.values(M)));
  assert.equal(a['sovereign-strong'], M['sovereign-strong']);
  assert.equal(a['sovereign-worker'], M['sovereign-worker']);
  assert.equal(a['sovereign-embedding'], M['sovereign-embedding']);
  for (const old of ['sovereign-default', 'sovereign-mock']) assert.equal(a[old], M['sovereign-worker'], old);
  for (const old of ['sovereign-reasoning', 'sovereign-reasoning-fast', 'sovereign-premium', 'sovereign-vision']) assert.equal(a[old], M['sovereign-strong'], old);
  assert.equal(a['sovereign-embed'], M['sovereign-embedding']);
  assert.deepEqual(Object.keys(DEPRECATED_ALIASES).sort(), ['sovereign-default', 'sovereign-embed', 'sovereign-mock', 'sovereign-premium', 'sovereign-reasoning', 'sovereign-reasoning-fast', 'sovereign-vision']);
});

test('NEGATIVE TWIN: a deprecated name that is itself a real catalog model is NOT aliased (the real model wins)', () => {
  const a = desiredAliases({ ...M }, new Set([...Object.values(M), 'sovereign-default']));
  assert.equal('sovereign-default' in a, false);
  assert.equal(a['sovereign-mock'], M['sovereign-worker']);
});

test('diffAliases: what is missing and what was changed by someone else; extra aliases of others are not touched', () => {
  const want = { a: '1', b: '2' };
  assert.deepEqual(diffAliases({ a: '1', b: '9', other: 'x' }, want), [{ alias: 'b', have: '9', want: '2' }]);
  assert.deepEqual(diffAliases({ a: '1' }, want), [{ alias: 'b', have: undefined, want: '2' }]);
  assert.deepEqual(diffAliases({ a: '1', b: '2' }, want), []);
});

test('a deprecated alias logs one deprecation line (once per alias), a role name logs none', () => {
  const lines: string[] = [];
  noteDeprecatedAlias('sovereign-default', 'a test', (l) => lines.push(l));
  noteDeprecatedAlias('sovereign-default', 'a test', (l) => lines.push(l));
  noteDeprecatedAlias('sovereign-worker', 'a test', (l) => lines.push(l));
  noteDeprecatedAlias('something-else', 'a test', (l) => lines.push(l));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /deprecated.*sovereign-default.*sovereign-worker/i);
});
