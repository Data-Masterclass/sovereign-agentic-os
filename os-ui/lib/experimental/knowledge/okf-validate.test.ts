/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateBundle, relativeMdLinks, resolvePath } from './okf-validate.ts';
import type { OkfBundle } from './okf-model.ts';

function bundle(files: { path: string; content: string }[]): OkfBundle {
  return { files };
}

test('validateBundle: a conformant bundle passes (type present, reserved files ok)', () => {
  const b = bundle([
    { path: 'index.md', content: '# Subdirectories\n\n* [Concepts](concepts/index.md)\n' },
    { path: 'concepts/index.md', content: '# Concepts\n\n* [A](a.md)\n' },
    { path: 'concepts/a.md', content: '---\ntype: term\ntitle: A\n---\n\nBody.\n' },
    { path: 'log.md', content: '---\ntype: Log\n---\n\n# History\n' },
  ]);
  const r = validateBundle(b);
  assert.equal(r.ok, true);
  assert.equal(r.errors.length, 0);
});

test('validateBundle: MUST-ACCEPT unknown types, unknown fields, broken links, missing index', () => {
  const b = bundle([
    { path: 'a.md', content: '---\ntype: TotallyMadeUpType\nweird_field: 99\n---\n\nSee [x](missing.md).\n' },
  ]);
  const r = validateBundle(b);
  assert.equal(r.ok, true, 'unknown type + unknown field + broken link + missing index are all accepted');
  // Broken link + missing index are NOTES, not errors.
  assert.ok(r.notes.some((n) => /link target not found/.test(n.message)));
  assert.ok(r.notes.some((n) => /no index\.md/.test(n.message)));
});

test('validateBundle: REJECTS unparseable frontmatter (rule 1)', () => {
  const r = validateBundle(bundle([{ path: 'a.md', content: '---\n: : not: valid: yaml:\n---\n' }]));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /unparseable YAML/.test(e.message)));
});

test('validateBundle: REJECTS missing frontmatter and missing/empty type (rules 1 & 2)', () => {
  const noFm = validateBundle(bundle([{ path: 'a.md', content: 'just prose, no frontmatter' }]));
  assert.equal(noFm.ok, false);
  const noType = validateBundle(bundle([{ path: 'a.md', content: '---\ntitle: no type here\n---\n' }]));
  assert.equal(noType.ok, false);
  assert.ok(noType.errors.some((e) => /required key|non-empty `type`/.test(e.message)));
});

test('validateBundle: REJECTS a malformed reserved file (rule 3)', () => {
  const r = validateBundle(bundle([
    { path: 'log.md', content: '---\n: : broken yaml :\n---\n' },
    { path: 'a.md', content: '---\ntype: term\n---\n' },
  ]));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.path === 'log.md'));
});

test('validateBundle: reserved index.md WITHOUT frontmatter is fine (plain listing)', () => {
  const r = validateBundle(bundle([
    { path: 'index.md', content: '# Subdirectories\n\n* [x](x/index.md)\n' },
    { path: 'a.md', content: '---\ntype: term\n---\n' },
  ]));
  assert.equal(r.ok, true);
});

test('relativeMdLinks / resolvePath: intra-bundle links only; traversal escapes rejected', () => {
  const md = 'See [a](../metrics/rev.md) and [ext](https://x.com/y) and [anchor](#top).';
  assert.deepEqual(relativeMdLinks(md), ['../metrics/rev.md']);
  assert.equal(resolvePath('policies/p.md', '../metrics/rev.md'), 'metrics/rev.md');
  assert.equal(resolvePath('a.md', '../../etc/passwd'), null); // escapes bundle root
  assert.equal(resolvePath('dir/a.md', '/root.md'), 'root.md'); // bundle-absolute
});
